import { prisma } from '@brayz/db';
import type { SmsConsentAction, SmsConsentPurpose, SmsConsentState } from '@brayz/shared';

/**
 * Where a number stands for a location's texts: the newest ledger record
 * decides. granted = box checked, waiting on YES; confirmed = texts may go;
 * revoked = stopped. Read with the tenant in the WHERE, always (rule #1).
 */
export async function consentFor(
  tenantId: string,
  locationId: string,
  phone: string,
  purpose: SmsConsentPurpose = 'restaurant_alerts',
): Promise<{ state: SmsConsentState; latest: { action: SmsConsentAction; source: string; createdAt: Date } | null }> {
  const latest = await prisma.smsConsentRecord.findFirst({
    where: { tenantId, locationId, phone, purpose },
    orderBy: { createdAt: 'desc' },
    select: { action: true, source: true, createdAt: true },
  });
  if (!latest) return { state: 'none', latest: null };
  const action = latest.action as SmsConsentAction;
  return {
    state: action === 'confirmed' ? 'on' : action === 'granted' ? 'pending' : 'off',
    latest: { action, source: latest.source, createdAt: latest.createdAt },
  };
}

/**
 * Did this number say yes to texts about this order? The spoken offer is "about
 * this order", so a yes on one call is not a yes to the next order — each order
 * is asked about on its own call. mayText still decides whether a STOP since
 * has ended it.
 */
export async function agreedForOrder(tenantId: string, locationId: string, phone: string, orderId: string): Promise<boolean> {
  const record = await prisma.smsConsentRecord.findFirst({
    where: { tenantId, locationId, phone, purpose: 'guest_order_updates', action: 'confirmed', orderId },
    select: { id: true },
  });
  return !!record;
}

/** May this number be texted for this purpose right now? Only once confirmed. */
export async function mayText(
  tenantId: string,
  locationId: string,
  phone: string,
  purpose: SmsConsentPurpose = 'restaurant_alerts',
): Promise<boolean> {
  return (await consentFor(tenantId, locationId, phone, purpose)).state === 'on';
}
