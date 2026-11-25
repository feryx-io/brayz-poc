import type { FastifyInstance } from 'fastify';
import {
  CreateTenantInput,
  UpdateTenantInput,
  type BillingPlan,
  type SubscriptionStatus,
} from '@brayz/shared';
import { TRIAL_DAYS, TRIAL_PLAN, isPaidAndServiceable } from '@brayz/billing';
import { prisma } from '@brayz/db';
import { loadConfig } from '@brayz/config';
import { notFound, parse, unauthorized } from '../lib/http.js';
import { trialInfo } from '../lib/billing.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

const DAY_MS = 86_400_000;

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // Every new account starts its free trial here: TRIAL_PLAN on every location
  // it opens, for TRIAL_DAYS. Accounts from before trials have no trialEndsAt
  // and keep the unrestricted access they always had (accessFor, @brayz/billing).
  app.post('/v1/tenants', async (request, reply) => {
    const input = parse(CreateTenantInput, request.body);
    const { userId, email } = request.auth;
    if (!userId && !(loadConfig().AUTH_MODE === 'dev' && email)) {
      throw unauthorized('Sign in before creating a tenant');
    }
    const now = new Date();
    const tenant = await prisma.$transaction(async (tx) => {
      const ownerId =
        userId ??
        (
          await tx.user.upsert({
            where: { email: email! },
            update: {},
            create: { email: email!, authSubject: `dev:${email}` },
          })
        ).id;
      const created = await tx.tenant.create({
        data: {
          name: input.name,
          trialStartedAt: now,
          trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS),
        },
      });
      await tx.userTenantMembership.create({
        data: { tenantId: created.id, userId: ownerId, role: 'owner' },
      });
      return created;
    });
    return reply.status(201).send(tenant);
  });

  app.get('/v1/tenants/:tenantId', async (request) => {
    const tenantId = requireTenant(request);
    const { tenantId: paramId } = request.params as { tenantId: string };
    if (paramId !== tenantId) throw notFound('Tenant');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound('Tenant');
    return tenant;
  });

  /**
   * GET /v1/tenants/:tenantId/trial — the account's free trial, for the banner
   * every screen shows: how long is left, or that it has lapsed. `converted`
   * once any location pays, after which the trial no longer matters.
   */
  app.get('/v1/tenants/:tenantId/trial', async (request) => {
    const tenantId = requireTenant(request);
    const { tenantId: paramId } = request.params as { tenantId: string };
    if (paramId !== tenantId) throw notFound('Tenant');
    const [tenant, subscriptions] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { trialStartedAt: true, trialEndsAt: true },
      }),
      prisma.locationSubscription.findMany({
        where: { tenantId },
        select: { plan: true, status: true },
      }),
    ]);
    if (!tenant) throw notFound('Tenant');
    return {
      trial: trialInfo(tenant.trialStartedAt, tenant.trialEndsAt),
      converted: subscriptions.some((s) =>
        isPaidAndServiceable(s.plan as BillingPlan | null, s.status as SubscriptionStatus),
      ),
      plan: TRIAL_PLAN,
      trialDays: TRIAL_DAYS,
    };
  });

  // Rename the business (tenant). Manager+ in that tenant only.
  app.patch('/v1/tenants/:tenantId', async (request) => {
    const tenantId = requireTenant(request);
    const { tenantId: paramId } = request.params as { tenantId: string };
    if (paramId !== tenantId) throw notFound('Tenant');
    await requireTenantRole(request, tenantId, 'manager');
    const input = parse(UpdateTenantInput, request.body);
    return prisma.tenant.update({ where: { id: tenantId }, data: input });
  });
}
