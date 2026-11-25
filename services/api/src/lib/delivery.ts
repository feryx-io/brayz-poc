import { prisma, writeAudit, type Prisma } from '@brayz/db';
import { DeliveryAddress, normalizeZip } from '@brayz/shared';
import type { GeocodingProvider, GeoPoint } from './geocoding.js';
import { locationGuestMemoryMode } from './guests.js';

/**
 * Whether a delivery address is inside a location's delivery area.
 *
 * Two rules, and either one qualifies an address (the restaurant's choice,
 * 2026-09-11): its ZIP is on the location's list, or its straight-line
 * distance from the restaurant is within the radius. Set neither and there is
 * no area check. Distance comes from geocoding the address; a lookup that
 * fails never loses an order — the address is taken and the ticket says it was
 * not checked — while a missing ZIP, when ZIPs are the rule, is simply asked for.
 */

export type DeliveryAreaCheck = 'no_rules' | 'in_zip' | 'in_radius' | 'outside' | 'unverified' | 'needs_zip';

export interface DeliveryRules {
  zipCodes: string[];
  radiusMiles: number | null;
}

export interface AreaDecision {
  check: DeliveryAreaCheck;
  deliverable: boolean;
}

export interface AreaResult extends AreaDecision {
  distanceMiles: number | null;
  zip: string | null;
  /** What the geocoder made of the address, for the log when a decision looks wrong. */
  matchedAddress?: string | null;
  matchedZip?: string | null;
  /** The match was thrown away because it landed in a different ZIP than the caller's. */
  zipMismatch?: boolean;
}

/** The location fields a delivery decision reads. */
export const DELIVERY_LOCATION_SELECT = {
  id: true,
  addressLine1: true,
  city: true,
  region: true,
  postalCode: true,
  deliveryZipCodes: true,
  deliveryRadiusMiles: true,
  latitude: true,
  longitude: true,
} as const;

export interface DeliveryLocation {
  id: string;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  deliveryZipCodes: string[];
  deliveryRadiusMiles: number | null;
  latitude: number | null;
  longitude: number | null;
}

const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance — "as the crow flies", which is what a delivery radius means here. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The either-rule, on what is known about the address. Pure. A rule that
 * cannot be judged yet is unknown rather than failed: no ZIP is a question to
 * ask (`needs_zip`), an address that could not be placed is let through
 * flagged (`unverified`). Only when every rule that applies has an answer, and
 * none of them is yes, is it `outside`.
 */
export function decideArea(
  rules: DeliveryRules,
  facts: { zip: string | null; distanceMiles: number | null },
): AreaDecision {
  const zips = rules.zipCodes.map(normalizeZip).filter((z): z is string => !!z);
  const hasZipRule = zips.length > 0;
  const radius = rules.radiusMiles ?? 0;
  const hasRadiusRule = radius > 0;
  if (!hasZipRule && !hasRadiusRule) return { check: 'no_rules', deliverable: true };

  const zip = normalizeZip(facts.zip);
  if (hasZipRule && zip && zips.includes(zip)) return { check: 'in_zip', deliverable: true };
  if (hasRadiusRule && facts.distanceMiles != null && facts.distanceMiles <= radius) {
    return { check: 'in_radius', deliverable: true };
  }
  if (hasZipRule && !zip) return { check: 'needs_zip', deliverable: false };
  if (hasRadiusRule && facts.distanceMiles == null) return { check: 'unverified', deliverable: true };
  return { check: 'outside', deliverable: false };
}

/**
 * Judge an address against the location's delivery area, geocoding only when
 * the radius needs it — a listed ZIP answers without a lookup, and there is a
 * caller waiting on the line.
 */
export async function checkDeliveryArea(
  loc: DeliveryLocation,
  address: DeliveryAddress,
  geocoder: GeocodingProvider | null,
): Promise<AreaResult> {
  const rules: DeliveryRules = { zipCodes: loc.deliveryZipCodes, radiusMiles: loc.deliveryRadiusMiles };
  let zip = normalizeZip(address.postalCode);
  const quick = decideArea(rules, { zip, distanceMiles: null });
  if (quick.check === 'no_rules' || quick.check === 'in_zip') return { ...quick, distanceMiles: null, zip };

  let distanceMiles: number | null = null;
  let matchedAddress: string | null = null;
  let matchedZip: string | null = null;
  let zipMismatch = false;
  if ((loc.deliveryRadiusMiles ?? 0) > 0 && geocoder) {
    const origin = await locationOrigin(loc, geocoder);
    if (origin) {
      const hit = await geocoder
        .geocode({
          street: address.line1,
          // A caller rarely names their own town, so the restaurant's stands in
          // — but only when they gave no ZIP. Sent together, the geocoder
          // prefers the town and answers about a different street without
          // saying so: on the call of 2026-09-11 21:43, "40 Example Street … 12801"
          // with the restaurant's Gansevoort filled in matched 40 Example St,
          // GANSEVOORT 12831 — 3.6 miles away instead of 10.7 — and an address
          // outside the area was told it was inside. The ZIP the caller said is
          // the better key, so when there is one it goes alone.
          city: zip ? (address.city ?? null) : (address.city ?? loc.city),
          state: loc.region,
          postalCode: address.postalCode ?? null,
        })
        .catch(() => null);
      if (hit) {
        matchedAddress = hit.matchedAddress ?? null;
        matchedZip = normalizeZip(hit.postalCode);
        // A match in a different ZIP than the caller gave is a different place,
        // and the distance to it means nothing. Treat the address as unplaced
        // rather than trusting it: the order is still taken and flagged, never
        // refused on a match we do not believe.
        zipMismatch = !!(zip && matchedZip && matchedZip !== zip);
        if (!zipMismatch) {
          distanceMiles = Math.round(haversineMiles(origin, hit) * 10) / 10;
          zip = zip ?? matchedZip;
        }
      }
    }
  }
  return {
    ...decideArea(rules, { zip, distanceMiles }),
    distanceMiles,
    zip,
    matchedAddress,
    matchedZip,
    zipMismatch,
  };
}

/**
 * The restaurant's own position: kept on the location once found, and found
 * from its address the first time the radius needs it.
 */
export async function locationOrigin(loc: DeliveryLocation, geocoder: GeocodingProvider): Promise<GeoPoint | null> {
  if (loc.latitude != null && loc.longitude != null) return { lat: loc.latitude, lng: loc.longitude };
  if (!loc.addressLine1) return null;
  const hit = await geocoder
    .geocode({ street: loc.addressLine1, city: loc.city, state: loc.region, postalCode: loc.postalCode })
    .catch(() => null);
  if (!hit) return null;
  await prisma.location
    .update({ where: { id: loc.id }, data: { latitude: hit.lat, longitude: hit.lng } })
    .catch(() => {});
  return { lat: hit.lat, lng: hit.lng };
}

/** An address as a Json column holds it: trimmed, blank fields left out. */
export function addressJson(a: DeliveryAddress): Prisma.InputJsonObject {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** A stored Json address read back, or null when there is none (or it no longer parses). */
export function storedAddress(value: unknown): DeliveryAddress | null {
  const parsed = DeliveryAddress.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sameAddress(a: DeliveryAddress | null, b: DeliveryAddress): boolean {
  if (!a) return false;
  const keys: Array<keyof DeliveryAddress> = ['line1', 'line2', 'city', 'postalCode', 'instructions'];
  return keys.every((k) => (a[k] ?? '').trim().toLowerCase() === (b[k] ?? '').trim().toLowerCase());
}

/**
 * Keep the address a delivery went to on the guest, so the next call can ask
 * "are we still delivering to…?". It is guest memory like the name and the
 * notes: nothing is kept when the location has memory off or the guest opted
 * out. Best-effort — the order is already placed, and never fails on this.
 */
export async function saveGuestDeliveryAddress(args: {
  tenantId: string;
  locationId: string;
  guestId: string;
  address: DeliveryAddress;
}): Promise<boolean> {
  const mode = await locationGuestMemoryMode(args.locationId);
  if (mode === 'off') return false;
  const guest = await prisma.guest.findUnique({
    where: { id: args.guestId },
    select: { memoryEnabled: true, deliveryAddress: true },
  });
  if (!guest?.memoryEnabled) return false;
  const changed = !sameAddress(storedAddress(guest.deliveryAddress), args.address);
  await prisma.guest.update({
    where: { id: args.guestId },
    data: { deliveryAddress: addressJson(args.address), deliveryAddressUpdatedAt: new Date() },
  });
  if (changed) {
    await writeAudit({
      tenantId: args.tenantId,
      locationId: args.locationId,
      action: 'guest.memory.updated',
      targetType: 'guest',
      targetId: args.guestId,
      metadata: { via: 'order', setDeliveryAddress: true },
    });
  }
  return true;
}
