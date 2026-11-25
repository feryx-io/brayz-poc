import type { FastifyInstance } from 'fastify';
import { forTenant } from '@brayz/db';
import { notFound } from '../lib/http.js';
import { requireTenant } from '../plugins/auth.js';

const WINDOW_DAYS = 7;

/**
 * Why a text did not arrive, in words an owner can act on. Codes are the
 * provider's (Twilio's today); anything unlisted falls back to the code itself.
 */
const REASONS: Record<string, string> = {
  '30034': 'The sending number is not registered for business texting (A2P 10DLC). Texts are blocked until the campaign is approved.',
  '30032': 'The sending number has been suspended by the carrier.',
  '30003': 'The phone receiving the texts is switched off or out of service.',
  '30004': 'The receiving number has blocked texts from this number.',
  '30005': 'The receiving number does not exist or is no longer in service.',
  '30006': 'The receiving number cannot get texts — it may be a landline.',
  '30007': 'The carrier filtered the text as spam.',
  '30008': 'The carrier could not deliver the text (unknown error).',
  '21610': 'The receiving number replied STOP and has opted out of texts.',
};

/**
 * Are the restaurant's texts arriving? The last week of texts to a location:
 * how many were delivered and not, and the most recent one's fate with a
 * plain reason. The dashboard warns when the latest text was not delivered —
 * a restaurant that is not getting its order texts has no other way to know.
 */
export async function textHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/locations/:locationId/text-health', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
    if (!location) throw notFound('Location');
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const texts = await db.notification.findMany({
      where: { locationId, channel: 'sms', audience: 'restaurant', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { status: true, deliveryStatus: true, deliveryErrorCode: true, createdAt: true, recipient: true },
    });
    const count = (pred: (t: (typeof texts)[number]) => boolean) => texts.filter(pred).length;
    // The newest text whose fate is known. A text still waiting on its callback
    // says nothing yet, so it does not hide an earlier failure.
    const latest = texts.find((t) => t.status === 'failed' || t.deliveryStatus);
    const notDelivered = !!latest && (latest.status === 'failed' || latest.deliveryStatus === 'undelivered' || latest.deliveryStatus === 'failed');
    return {
      windowDays: WINDOW_DAYS,
      sent: texts.length,
      delivered: count((t) => t.deliveryStatus === 'delivered'),
      notDelivered: count((t) => t.status === 'failed' || t.deliveryStatus === 'undelivered' || t.deliveryStatus === 'failed'),
      latest: latest
        ? {
            at: latest.createdAt.toISOString(),
            delivered: latest.deliveryStatus === 'delivered',
            notDelivered,
            errorCode: latest.deliveryErrorCode,
            reason: notDelivered
              ? latest.deliveryErrorCode
                ? (REASONS[latest.deliveryErrorCode] ?? `The carrier reported error ${latest.deliveryErrorCode}.`)
                : 'The text could not be sent.'
              : null,
          }
        : null,
    };
  });
}
