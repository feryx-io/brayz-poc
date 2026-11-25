import { prisma } from '@brayz/db';
import {
  normalizePostalCode,
  normalizeRestaurantName,
  normalizeStreetAddress,
  type DuplicateCheckInput,
  type DuplicateFinding,
} from '@brayz/shared';

/**
 * Is this restaurant already on Brayz under someone else — or already under
 * this account?
 *
 * This is the ONE deliberate cross-tenant read in the codebase (CLAUDE.md
 * rule #1 exception). It exists because the alternative is worse: an owner
 * making a second account for the same restaurant, or someone claiming a
 * restaurant that is not theirs, and nobody noticing. It is kept narrow on
 * purpose:
 *
 * - It reads only the columns it compares and returns findings, never rows.
 * - A finding says a match exists and repeats the city the caller typed. It
 *   never carries the other account's name, phone, address, or owner.
 * - Names and addresses are compared exactly once normalized; "nearby" means
 *   the same ZIP, or the same city when no ZIP was given. Chains and
 *   coincidences pass as warnings; only a claimed phone blocks.
 */
export async function findDuplicateLocations(
  input: DuplicateCheckInput,
  ctx: { tenantId: string },
): Promise<DuplicateFinding[]> {
  const name = normalizeRestaurantName(input.name);
  const street = input.addressLine1?.trim() ? normalizeStreetAddress(input.addressLine1) : null;
  const zip = input.postalCode?.trim() ? normalizePostalCode(input.postalCode) : null;
  const city = input.city?.trim().toLowerCase() || null;
  const where = city ?? zip ?? 'this area';

  // Candidates: anything sharing the phone, the ZIP, or the city. The exact
  // comparison happens here in code so the normalization has one home.
  const or: Array<Record<string, unknown>> = [];
  if (input.mainPhone) or.push({ mainPhone: input.mainPhone });
  if (zip) or.push({ postalCode: { startsWith: zip } });
  if (city) or.push({ city: { equals: city, mode: 'insensitive' } });
  if (or.length === 0) return [];

  const candidates = await prisma.location.findMany({
    where: {
      OR: or,
      ...(input.excludeLocationId ? { id: { not: input.excludeLocationId } } : {}),
    },
    select: { tenantId: true, name: true, addressLine1: true, city: true, postalCode: true, mainPhone: true },
  });

  const findings: DuplicateFinding[] = [];
  const seen = new Set<string>();
  const add = (f: DuplicateFinding) => {
    if (!seen.has(f.kind)) {
      seen.add(f.kind);
      findings.push(f);
    }
  };

  for (const c of candidates) {
    const other = c.tenantId !== ctx.tenantId;
    const sameName = normalizeRestaurantName(c.name) === name;
    const cZip = c.postalCode ? normalizePostalCode(c.postalCode) : null;
    const nearby = zip && cZip ? cZip === zip : city !== null && c.city?.trim().toLowerCase() === city;

    if (other && input.mainPhone && c.mainPhone === input.mainPhone) {
      add({
        kind: 'phone_claimed',
        blocking: true,
        message:
          'That main phone number is already on Brayz under another account. If this is your restaurant, sign in to that account or contact support.',
      });
      continue;
    }
    if (other && street && c.addressLine1 && normalizeStreetAddress(c.addressLine1) === street && nearby) {
      add({
        kind: 'same_address',
        blocking: false,
        message: `Another account already has a restaurant at this address in ${where}. Continue only if this is a different business.`,
      });
    }
    if (other && sameName && nearby) {
      add({
        kind: 'same_name_nearby',
        blocking: false,
        message: `Another restaurant with this name is already on Brayz in ${where}. That is fine if it is not yours — continue if so.`,
      });
    }
    if (!other && sameName && nearby) {
      add({
        kind: 'same_name_in_account',
        blocking: false,
        message: `You already have a location with this name in ${where}. Add it again only if it is really a second one.`,
      });
    }
  }
  // Blocking first, so a client that shows one message shows the one that matters.
  return findings.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}
