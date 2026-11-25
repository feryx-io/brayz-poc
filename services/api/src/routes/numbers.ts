import type { FastifyInstance } from 'fastify';
import { NumberSearchQueryInput, ProvisionNumberInput } from '@brayz/shared';
import {
  CarrierNotConfiguredError,
  TwilioNumberProvisioner,
  type NumberProvisioner,
} from '@brayz/carriers';
import { loadConfig } from '@brayz/config';
import { forTenant, prisma, type TenantScopedClient } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export interface NumberRouteOptions {
  /** Inject a provisioner (tests). `undefined` → build from config; `null` → unconfigured. */
  provisioner?: NumberProvisioner | null;
}

/**
 * Brayz phone-number provisioning: search the carrier for available numbers and
 * purchase one for a location (attaching it to the SIP trunk so calls route to
 * Brayz). Manager-gated; the provisioner is provider-agnostic (CLAUDE.md rule #2).
 */
export async function numberRoutes(app: FastifyInstance, opts: NumberRouteOptions = {}): Promise<void> {
  const provisioner = opts.provisioner === undefined ? buildProvisioner() : opts.provisioner;

  app.get('/v1/numbers/available', async (request) => {
    requireTenant(request); // any member may browse numbers
    if (!provisioner) throw notConfigured();
    const q = parse(NumberSearchQueryInput, request.query);
    if (!q.areaCode && !q.region && !q.locality && !q.contains) {
      throw new HttpError(400, 'Provide at least one of areaCode, region, locality, or contains', 'missing_filter');
    }
    return { numbers: await runCarrier(() => provisioner.searchAvailable(q)) };
  });

  app.post('/v1/locations/:locationId/phone-numbers/provision', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    if (!provisioner) throw notConfigured();
    const { locationId } = request.params as { locationId: string };
    await assertLocation(forTenant(tenantId), locationId);
    const { e164Number } = parse(ProvisionNumberInput, request.body);

    // Idempotency: a number maps to exactly one location (unique e164Number).
    const existing = await prisma.phoneNumber.findUnique({ where: { e164Number }, select: { id: true } });
    if (existing) throw new HttpError(409, `${e164Number} is already provisioned`, 'already_provisioned');

    const result = await runCarrier(() => provisioner.provision(e164Number));
    const created = await prisma.phoneNumber.create({
      data: {
        tenantId,
        locationId,
        e164Number: result.e164Number,
        provider: provisioner.name,
        providerNumberId: result.providerNumberId,
        inboundRouteType: 'ai',
        active: true,
      },
    });
    return reply.status(201).send(created);
  });
}

function buildProvisioner(): NumberProvisioner | null {
  const cfg = loadConfig();
  if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) return null;
  return new TwilioNumberProvisioner({
    creds: {
      accountSid: cfg.TWILIO_ACCOUNT_SID,
      authToken: cfg.TWILIO_AUTH_TOKEN,
      trunkSid: cfg.TWILIO_TRUNK_SID || undefined,
    },
  });
}

const notConfigured = () =>
  new HttpError(503, 'Number provisioning is not configured (Twilio credentials missing)', 'carrier_not_configured');

/** Map carrier/SDK failures to clean HTTP errors instead of opaque 500s. */
async function runCarrier<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CarrierNotConfiguredError) throw notConfigured();
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : 'Carrier request failed';
    throw new HttpError(502, message, 'carrier_error');
  }
}

async function assertLocation(db: TenantScopedClient, locationId: string): Promise<void> {
  const loc = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!loc) throw notFound('Location');
}
