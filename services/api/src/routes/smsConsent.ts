import type { FastifyInstance } from 'fastify';
import {
  GrantSmsConsentInput,
  RESTAURANT_ALERTS_DISCLOSURE_VERSION,
  restaurantAlertsConfirmationSms,
  restaurantAlertsDisclosure,
} from '@brayz/shared';
import type { NotificationSender } from '@brayz/carriers';
import { forTenant, prisma, writeAudit } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { buildNotifier, textLocation } from '../lib/notifier.js';
import { consentFor } from '../lib/smsConsent.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export interface SmsConsentRouteOptions {
  /** `null` means no SMS configured; tests inject a fake. */
  notifier?: NotificationSender | null;
}

/** A second confirmation text no sooner than this after the last. */
const RESEND_AFTER_MS = 60_000;

/**
 * A restaurant agreeing to its alert texts (rule #6: consent in code).
 *
 * The owner enters the alerts number and checks an unchecked box beside the
 * disclosure; that is recorded as `granted` with who, when, from where and the
 * exact words, and a confirmation text goes out. Alerts start only when the
 * number replies YES (routes/carriers.ts records `confirmed`). Turning alerts
 * off, here or by replying STOP, records `revoked`. The ledger is append-only.
 */
export async function smsConsentRoutes(app: FastifyInstance, opts: SmsConsentRouteOptions = {}): Promise<void> {
  const notifier = opts.notifier === undefined ? buildNotifier() : opts.notifier;

  const loadLocation = async (tenantId: string, locationId: string) => {
    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true, notificationPhone: true },
    });
    if (!location) throw notFound('Location');
    return location;
  };

  const actorFor = async (request: { auth?: { userId?: string | null; email?: string | null } }) => {
    if (request.auth?.userId) return request.auth.userId;
    if (!request.auth?.email) return null;
    const u = await prisma.user.findUnique({ where: { email: request.auth.email }, select: { id: true } });
    return u?.id ?? null;
  };

  app.get('/v1/locations/:locationId/sms-consent', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const location = await loadLocation(tenantId, locationId);
    const phone = location.notificationPhone;
    const current = phone ? await consentFor(tenantId, locationId, phone) : { state: 'none' as const, latest: null };
    const history = phone
      ? await prisma.smsConsentRecord.findMany({
          where: { tenantId, locationId, phone },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { action: true, source: true, createdAt: true },
        })
      : [];
    return {
      phone,
      state: current.state,
      since: current.latest?.createdAt ?? null,
      disclosure: restaurantAlertsDisclosure(location.name),
      disclosureVersion: RESTAURANT_ALERTS_DISCLOSURE_VERSION,
      smsConfigured: !!notifier,
      history,
    };
  });

  /** Check the box: record the grant and text the number to confirm. */
  app.post('/v1/locations/:locationId/sms-consent', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const input = parse(GrantSmsConsentInput, request.body);
    const location = await loadLocation(tenantId, locationId);
    const actorUserId = await actorFor(request);
    const disclosureText = restaurantAlertsDisclosure(location.name);

    if (location.notificationPhone !== input.phone) {
      await forTenant(tenantId).location.update({ where: { id: locationId }, data: { notificationPhone: input.phone } });
    }
    const record = await prisma.smsConsentRecord.create({
      data: {
        tenantId,
        locationId,
        phone: input.phone,
        purpose: 'restaurant_alerts',
        action: 'granted',
        source: 'dashboard',
        disclosureVersion: RESTAURANT_ALERTS_DISCLOSURE_VERSION,
        disclosureText,
        actorUserId,
        ipAddress: request.ip,
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 400) || null,
      },
    });
    await writeAudit({
      tenantId,
      locationId,
      actorId: actorUserId,
      action: 'consent.changed',
      targetType: 'sms_consent',
      targetId: record.id,
      metadata: { purpose: 'restaurant_alerts', action: 'granted', phone: input.phone, version: RESTAURANT_ALERTS_DISCLOSURE_VERSION },
    });
    const texted = await textLocation(request.log, notifier, {
      tenantId,
      locationId,
      dedupeKey: `sms-consent-confirm:${record.id}`,
      body: restaurantAlertsConfirmationSms(location.name),
      request,
      consentRequest: true,
    });
    return reply.status(201).send({ state: 'pending', confirmationSent: texted });
  });

  /** Send the confirmation text again, while still waiting on YES. */
  app.post('/v1/locations/:locationId/sms-consent/resend', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const location = await loadLocation(tenantId, locationId);
    const phone = location.notificationPhone;
    if (!phone) throw new HttpError(409, 'No alerts number is set', 'no_alerts_number');
    const current = await consentFor(tenantId, locationId, phone);
    if (current.state !== 'pending') {
      throw new HttpError(409, 'There is no confirmation waiting for this number', 'not_pending');
    }
    const last = await prisma.notification.findFirst({
      where: { tenantId, locationId, dedupeKey: { startsWith: 'sms-consent-confirm:' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_AFTER_MS) {
      throw new HttpError(429, 'A confirmation text was just sent', 'resend_too_soon');
    }
    const texted = await textLocation(request.log, notifier, {
      tenantId,
      locationId,
      dedupeKey: `sms-consent-confirm:resend:${locationId}:${Date.now()}`,
      body: restaurantAlertsConfirmationSms(location.name),
      request,
      consentRequest: true,
    });
    return { state: 'pending', confirmationSent: texted };
  });

  /** Turn alerts off from the dashboard. */
  app.delete('/v1/locations/:locationId/sms-consent', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const location = await loadLocation(tenantId, locationId);
    const phone = location.notificationPhone;
    if (!phone) throw new HttpError(409, 'No alerts number is set', 'no_alerts_number');
    const current = await consentFor(tenantId, locationId, phone);
    if (current.state === 'off' || current.state === 'none') return { state: current.state };
    const actorUserId = await actorFor(request);
    const record = await prisma.smsConsentRecord.create({
      data: {
        tenantId,
        locationId,
        phone,
        purpose: 'restaurant_alerts',
        action: 'revoked',
        source: 'dashboard',
        disclosureVersion: RESTAURANT_ALERTS_DISCLOSURE_VERSION,
        disclosureText: restaurantAlertsDisclosure(location.name),
        actorUserId,
        ipAddress: request.ip,
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 400) || null,
      },
    });
    await writeAudit({
      tenantId,
      locationId,
      actorId: actorUserId,
      action: 'consent.changed',
      targetType: 'sms_consent',
      targetId: record.id,
      metadata: { purpose: 'restaurant_alerts', action: 'revoked', phone },
    });
    return { state: 'off' };
  });
}
