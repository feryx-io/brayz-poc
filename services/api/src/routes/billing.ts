import type { FastifyInstance } from 'fastify';
import {
  CheckoutInput,
  PortalInput,
  type BillingPlan,
  type SubscriptionStatus,
} from '@brayz/shared';
import {
  BillingConfigError,
  isPaidAndServiceable,
  PLANS,
  planFromPriceId,
  snapshotFromSubscription,
  verifyStripeSignature,
  type BillingProvider,
  type SubscriptionSnapshot,
} from '@brayz/billing';
import { loadConfig } from '@brayz/config';
import { forTenant, prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import { processWebhook } from '../lib/webhooks.js';
import {
  buildBillingProvider,
  locationBilling,
  periodStart,
  usageForPeriod,
} from '../lib/billing.js';

/**
 * Billing (plan §12.5). Payment happens on Stripe's hosted Checkout and Billing
 * Portal, so Brayz never sees a card and never renders a payment form.
 *
 * The subscription's truth arrives by **webhook**, not on the browser's return
 * from Checkout: a redirect can be lost, replayed, or forged, and a customer
 * whose card actually failed must not land on an active plan because their
 * browser followed a success URL.
 */
export interface BillingRouteOptions {
  /** Inject a processor (tests). `undefined` → build from config; `null` → off. */
  billingProvider?: BillingProvider | null;
  /** Overrides the configured webhook secret (tests). */
  stripeWebhookSecret?: string;
}

export async function billingRoutes(
  app: FastifyInstance,
  opts: BillingRouteOptions = {},
): Promise<void> {
  const cfg = loadConfig();
  const provider =
    opts.billingProvider === undefined ? buildBillingProvider() : opts.billingProvider;
  const webhookSecret = opts.stripeWebhookSecret ?? cfg.STRIPE_WEBHOOK_SECRET;
  const priceIds = {
    starter: cfg.STRIPE_PRICE_STARTER,
    growth: cfg.STRIPE_PRICE_GROWTH,
    pro: cfg.STRIPE_PRICE_PRO,
  };

  // The signature covers the bytes as sent, so this plugin keeps the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  async function ownedLocation(tenantId: string, locationId: string) {
    const db = forTenant(tenantId);
    const loc = await db.location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true },
    });
    if (!loc) throw notFound('Location');
    return loc;
  }

  // ---- Dashboard ----

  app.get('/v1/locations/:locationId/billing', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);

    const billing = await locationBilling(locationId);
    const since = periodStart(billing.currentPeriodEnd);
    const usage = await usageForPeriod(locationId, since);
    const included = billing.plan ? PLANS[billing.plan].includedCalls : null;

    return {
      plan: billing.plan,
      status: billing.status,
      entitlements: billing.entitlements,
      // Where that access comes from — a paid plan, the account's free trial, a
      // lapsed trial, or an account from before trials — and whether Brayz is
      // answering this location's calls at all.
      source: billing.source,
      inService: billing.inService,
      trial: billing.trial,
      currentPeriodEnd: billing.currentPeriodEnd,
      cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
      // Whether the owner can subscribe at all, so the UI offers buttons that work.
      billingAvailable: !!provider,
      hasCustomer: !!billing.stripeCustomerId,
      enforced: cfg.BILLING_ENFORCED,
      plans: Object.values(PLANS),
      usage: { ...usage, includedCalls: included },
    };
  });

  app.post('/v1/locations/:locationId/billing/checkout', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'owner');
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);
    const input = parse(CheckoutInput, request.body);
    if (!provider) throw new HttpError(503, 'Billing is not configured', 'billing_unavailable');

    const billing = await locationBilling(locationId);
    try {
      const session = await provider.createCheckout({
        plan: input.plan,
        locationId,
        tenantId,
        customerId: billing.stripeCustomerId ?? undefined,
        customerEmail: request.auth?.email,
        returnUrl: input.returnUrl,
        // Subscribing mid-trial keeps the days left: billing starts at its end.
        trialEndsAt:
          billing.source === 'trial' && billing.trial?.active ? billing.trial.endsAt : undefined,
      });
      return { url: session.url };
    } catch (err) {
      if (err instanceof BillingConfigError) {
        throw new HttpError(503, err.message, 'billing_unavailable');
      }
      throw err;
    }
  });

  app.post('/v1/locations/:locationId/billing/portal', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'owner');
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);
    const input = parse(PortalInput, request.body);
    if (!provider) throw new HttpError(503, 'Billing is not configured', 'billing_unavailable');

    const billing = await locationBilling(locationId);
    if (!billing.stripeCustomerId) {
      throw new HttpError(409, 'This location has never subscribed', 'no_customer');
    }
    const { url } = await provider.createPortal({
      customerId: billing.stripeCustomerId,
      returnUrl: input.returnUrl,
    });
    return { url };
  });

  // ---- Stripe webhook ----

  app.post('/v1/webhooks/stripe', async (request, reply) => {
    if (!webhookSecret) {
      request.log.warn('stripe webhook received but STRIPE_WEBHOOK_SECRET is unset');
      throw new HttpError(503, 'Webhook receiver is not configured', 'webhook_not_configured');
    }
    const raw = (request as { rawBody?: string }).rawBody ?? '';
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || !verifyStripeSignature(raw, signature, webhookSecret)) {
      throw new HttpError(401, 'Bad webhook signature', 'bad_signature');
    }

    const event = request.body as StripeEvent;
    if (
      typeof event?.id !== 'string' ||
      !event.id ||
      typeof event?.type !== 'string' ||
      !event.type ||
      !Number.isSafeInteger(event.created) ||
      event.created < 0 ||
      Number.isNaN(new Date(event.created * 1000).getTime())
    ) {
      throw new HttpError(400, 'Malformed Stripe event', 'bad_event');
    }

    const delivery = { source: 'stripe', eventId: event.id, eventType: event.type };
    const target = SUBSCRIPTION_EVENTS.has(event.type)
      ? await subscriptionTarget(app, event, priceIds)
      : null;
    if (!target) {
      if (!SUBSCRIPTION_EVENTS.has(event.type)) {
        request.log.debug({ type: event.type }, 'stripe event ignored');
      }
      // Recorded and acknowledged: nothing a retry could change (an event we
      // don't consume, or one naming no location of ours).
      const processed = await processWebhook(delivery, async () => {});
      return reply.status(200).send({ ok: true, ...(!processed ? { duplicate: true } : {}) });
    }
    const processed = await applySubscriptionEvent(app, delivery, target, provider);
    return reply.status(200).send({ ok: true, ...(!processed ? { duplicate: true } : {}) });
  });
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data?: { object?: Record<string, unknown> };
}

const SUBSCRIPTION_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses a location should never be moved onto from a different, live subscription. */
const ENDED: SubscriptionStatus[] = ['canceled'];

/** What a billing event is about, once we know which location it belongs to. */
interface SubscriptionTarget {
  tenantId: string;
  locationId: string;
  customerId: string;
  subscriptionId: string;
  /**
   * What the event itself says about the subscription. Null for checkout,
   * whose session carries no status. Only used when no provider is configured
   * to read the subscription back.
   */
  fromEvent: SubscriptionSnapshot | null;
  createdAt: Date;
}

/**
 * Which location a billing event belongs to, or null — logged — when it names
 * none of ours. Null is acknowledged rather than retried: Stripe retries a
 * failing endpoint for days and then disables it, which would drop every
 * other location's billing events along with this one.
 */
async function subscriptionTarget(
  app: FastifyInstance,
  event: StripeEvent,
  priceIds: Partial<Record<BillingPlan, string>>,
): Promise<SubscriptionTarget | null> {
  const object = event.data?.object ?? {};
  const createdAt = new Date(event.created * 1000);

  if (event.type === 'checkout.session.completed') {
    const meta = (object.metadata ?? {}) as Record<string, string>;
    const customerId = typeof object.customer === 'string' ? object.customer : undefined;
    const subscriptionId =
      typeof object.subscription === 'string' ? object.subscription : undefined;
    if (
      !UUID.test(meta.locationId ?? '') ||
      !UUID.test(meta.tenantId ?? '') ||
      !customerId ||
      !subscriptionId
    ) {
      app.log.warn({ eventId: event.id }, 'checkout.session.completed without location metadata');
      return null;
    }
    return {
      tenantId: meta.tenantId!,
      locationId: meta.locationId!,
      customerId,
      subscriptionId,
      fromEvent: null,
      createdAt,
    };
  }

  const snapshot = snapshotFromSubscription(object, priceIds);
  // `deleted` arrives with whatever status the object had; the event is what
  // makes it canceled.
  if (event.type === 'customer.subscription.deleted') snapshot.status = 'canceled';
  if (!snapshot.subscriptionId) {
    app.log.warn({ eventId: event.id }, 'subscription event without a subscription id');
    return null;
  }
  const meta = (object.metadata ?? {}) as Record<string, string>;
  let locationId = meta.locationId;
  let tenantId = meta.tenantId;
  // A subscription edited in the Stripe dashboard may carry no metadata; fall
  // back to the row we already linked to this subscription or customer. One
  // we never linked (another product on the same Stripe account, say) is not
  // going to become ours by being retried.
  if (!locationId) {
    const existing = await prisma.locationSubscription.findFirst({
      where: {
        OR: [
          { stripeSubscriptionId: snapshot.subscriptionId },
          ...(snapshot.customerId ? [{ stripeCustomerId: snapshot.customerId }] : []),
        ],
      },
      select: { locationId: true, tenantId: true },
    });
    locationId = existing?.locationId;
    tenantId = existing?.tenantId;
  }
  if (!UUID.test(locationId ?? '') || !UUID.test(tenantId ?? '')) {
    app.log.warn({ eventId: event.id }, 'subscription event for no location of ours');
    return null;
  }
  return {
    tenantId: tenantId!,
    locationId: locationId!,
    customerId: snapshot.customerId,
    subscriptionId: snapshot.subscriptionId,
    fromEvent: snapshot,
    createdAt,
  };
}

/** The subscription row moved between reading the provider and taking the lock. */
class SubscriptionMoved extends Error {}

/**
 * Apply a billing event to its location.
 *
 * The subscription is read back from Stripe *before* the transaction: holding
 * a database connection and a lock on the location across an HTTP call to
 * Stripe stalls everything else waiting on that location for as long as
 * Stripe takes. Correctness comes from the check under the lock instead — if
 * another event wrote the row after we looked, our read of Stripe may be the
 * older one, so the transaction is abandoned and the whole read is repeated.
 */
async function applySubscriptionEvent(
  app: FastifyInstance,
  delivery: { source: string; eventId: string; eventType: string },
  target: SubscriptionTarget,
  provider: BillingProvider | null,
): Promise<boolean> {
  const at = target.createdAt.getTime();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seen = await prisma.locationSubscription.findUnique({
      where: { locationId: target.locationId },
    });
    // Older than what the row already reflects: record it, change nothing,
    // and spare Stripe the read.
    if (seen?.stripeEventCreatedAt && at < seen.stripeEventCreatedAt.getTime()) {
      return processWebhook(delivery, async () => {});
    }
    const duplicate = await prisma.webhookDelivery.findUnique({
      where: { source_eventId: { source: delivery.source, eventId: delivery.eventId } },
      select: { id: true },
    });
    if (duplicate) return false;

    // Provider errors propagate: Stripe being unreachable is worth a retry.
    const current = provider
      ? await provider.getSubscription(target.subscriptionId)
      : target.fromEvent;
    if (provider && !current) {
      app.log.warn(
        { eventId: delivery.eventId, locationId: target.locationId },
        'stripe has no such subscription',
      );
      return processWebhook(delivery, async () => {});
    }

    try {
      return await processWebhook(delivery, async (tx) => {
        // NO KEY UPDATE, not UPDATE: this serializes billing writes for the
        // location without blocking the rows that reference it (a new call or
        // order takes a KEY SHARE lock on its location).
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM locations
          WHERE id = ${target.locationId}::uuid AND "tenantId" = ${target.tenantId}::uuid
          FOR NO KEY UPDATE
        `;
        if (!locked.length) {
          app.log.warn(
            { eventId: delivery.eventId, locationId: target.locationId },
            'billing event for a location that no longer exists',
          );
          return;
        }
        const existing = await tx.locationSubscription.findUnique({
          where: { locationId: target.locationId },
        });
        if (!sameRow(seen, existing)) throw new SubscriptionMoved();

        const data = {
          stripeCustomerId: target.customerId || null,
          stripeSubscriptionId: target.subscriptionId,
          stripeEventCreatedAt: target.createdAt,
        };
        const otherSubscription =
          !!existing?.stripeSubscriptionId &&
          existing.stripeSubscriptionId !== target.subscriptionId;

        if (!current) {
          // Checkout with no provider to read back: it proves which
          // subscription and customer belong here, not what state they are in.
          // The subscription's own events say that.
          if (existing && !otherSubscription) {
            await tx.locationSubscription.update({ where: { id: existing.id }, data });
            return;
          }
          await tx.locationSubscription.upsert({
            where: { locationId: target.locationId },
            create: {
              tenantId: target.tenantId,
              locationId: target.locationId,
              plan: null,
              status: 'incomplete',
              ...data,
            },
            update: {
              plan: null,
              status: 'incomplete',
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
              ...data,
            },
          });
          return;
        }

        // A subscription the location has moved off can still send events —
        // its `deleted` often lands after the replacement was created. It must
        // not pull a live location back onto the dead one.
        if (
          otherSubscription &&
          existing &&
          isPaidAndServiceable(
            existing.plan as BillingPlan | null,
            existing.status as SubscriptionStatus,
          ) &&
          ENDED.includes(current.status)
        ) {
          app.log.info(
            { eventId: delivery.eventId, locationId: target.locationId },
            'ended subscription event ignored; the location is on another live subscription',
          );
          return;
        }

        const state = {
          plan: current.plan,
          status: current.status,
          currentPeriodEnd: current.currentPeriodEnd,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
          ...data,
        };
        await tx.locationSubscription.upsert({
          where: { locationId: target.locationId },
          create: { tenantId: target.tenantId, locationId: target.locationId, ...state },
          update: state,
        });
      });
    } catch (err) {
      if (err instanceof SubscriptionMoved) continue;
      throw err;
    }
  }
  throw new HttpError(503, 'Subscription is changing; retry', 'subscription_busy');
}

type SubscriptionRow = Awaited<ReturnType<typeof prisma.locationSubscription.findUnique>>;

function sameRow(a: SubscriptionRow, b: SubscriptionRow): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.updatedAt.getTime() === b.updatedAt.getTime() &&
    a.stripeEventCreatedAt?.getTime() === b.stripeEventCreatedAt?.getTime() &&
    a.stripeSubscriptionId === b.stripeSubscriptionId &&
    a.status === b.status &&
    a.plan === b.plan
  );
}

export { planFromPriceId };
