/**
 * Guest-memory helpers shared by the order route and the node-authed guest tools.
 * Identity is by phone number (the MVP signal, CLAUDE.md rule #6); whether the bot
 * personalizes is gated by the location's guestMemoryMode + the guest's opt-out.
 */
import { Prisma, prisma } from '@brayz/db';

export type GuestMemoryMode = 'full' | 'confirm' | 'off';

/** The restaurant's personalization posture for a location (defaults to 'full'). */
export async function locationGuestMemoryMode(locationId: string): Promise<GuestMemoryMode> {
  const s = await prisma.locationAiSettings.findUnique({
    where: { locationId },
    select: { guestMemoryMode: true },
  });
  const mode = s?.guestMemoryMode;
  return mode === 'confirm' || mode === 'off' ? mode : 'full';
}

/** Find the guest for this caller's number, or create one (with their phone). */
export async function resolveOrCreateGuest(
  tenantId: string,
  locationId: string,
  e164: string,
  displayName?: string,
): Promise<string> {
  const existing = await prisma.guestPhoneNumber.findUnique({
    where: { tenantId_e164: { tenantId, e164 } },
    select: { guestId: true },
  });
  if (existing) return existing.guestId;
  try {
    const guest = await prisma.guest.create({
      data: {
        tenantId,
        locationId,
        displayName: displayName || undefined,
        phoneNumbers: { create: { tenantId, e164 } },
      },
      select: { id: true },
    });
    return guest.id;
  } catch (err) {
    // Two concurrent calls from the same new caller can race past the lookup;
    // the loser's create hits the (tenantId, e164) unique key — re-read the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const won = await prisma.guestPhoneNumber.findUnique({
        where: { tenantId_e164: { tenantId, e164 } },
        select: { guestId: true },
      });
      if (won) return won.guestId;
    }
    throw err;
  }
}

/** Top item names by total quantity across the given orders ("the usual"). */
export function computeUsual(
  orders: Array<{ items: Array<{ name: string; quantity: number }> }>,
): string[] {
  const counts = new Map<string, number>();
  for (const o of orders) {
    for (const it of o.items) counts.set(it.name, (counts.get(it.name) ?? 0) + it.quantity);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
}
