import type { PrismaClient } from '@brayz/db';

/**
 * Turn a location's text alerts on for tests: the alerts number set, and the
 * two ledger records a real owner leaves (box checked, then YES). Texts are
 * sent only to a number with confirmed consent (lib/smsConsent.ts), so a test
 * that expects a text needs this.
 */
export async function alertsOn(prisma: PrismaClient, tenantId: string, locationId: string, phone: string): Promise<void> {
  await prisma.location.update({ where: { id: locationId }, data: { notificationPhone: phone } });
  const base = {
    tenantId,
    locationId,
    phone,
    purpose: 'restaurant_alerts',
    disclosureVersion: 'restaurant-alerts-v1',
    disclosureText: 'test consent',
  };
  const now = Date.now();
  await prisma.smsConsentRecord.create({
    data: { ...base, action: 'granted', source: 'dashboard', createdAt: new Date(now - 1000) },
  });
  await prisma.smsConsentRecord.create({ data: { ...base, action: 'confirmed', source: 'sms_reply', createdAt: new Date(now) } });
}

/** The consent records a test left for a location (the ledger has no cascade: it is evidence). */
export async function alertsCleanup(prisma: PrismaClient, locationId: string): Promise<void> {
  await prisma.smsConsentRecord.deleteMany({ where: { locationId } }).catch(() => {});
}
