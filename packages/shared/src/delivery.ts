import { z } from 'zod';

/**
 * Delivery orders (development plan: "Delivery orders" under Brayz Orders,
 * "Delivery address memory" under Guests). The address shape the bot captures
 * on a call, the order keeps as a snapshot, and a guest's profile keeps for
 * next time. Dispatch — routing drivers, live tracking — is out of MVP scope;
 * this is taking the order and knowing where it goes.
 */
export const DeliveryAddress = z.object({
  /** Street number and street, e.g. "12 Main Street". */
  line1: z.string().trim().min(3).max(200),
  /** Apartment, unit, suite, floor. */
  line2: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(12).optional(),
  /** For the driver: "side door", "ring twice". */
  instructions: z.string().trim().max(300).optional(),
});
export type DeliveryAddress = z.infer<typeof DeliveryAddress>;

/** A US ZIP as its five digits ("12866-1234" → "12866"); anything else trimmed and upper-cased. */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  const us = s.match(/^(\d{5})(?:-?\d{4})?$/);
  return us ? us[1]! : s.replace(/\s+/g, ' ');
}

/** "12866, 12831 12020" → ["12866", "12831", "12020"]: split on commas and spaces, normalized, deduplicated. */
export function parseZipList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const zip = normalizeZip(part);
    if (zip && !out.includes(zip)) out.push(zip);
  }
  return out;
}

/** One line for a ticket, a text or a read-back: "12 Main Street, Apt 2, Saratoga Springs 12866". */
export function formatDeliveryAddress(a: DeliveryAddress): string {
  const place = [a.city, a.postalCode].filter((p) => p && p.trim()).join(' ');
  return [a.line1, a.line2, place].filter((p) => p && p.trim()).join(', ');
}

/**
 * The house number an address starts with ("12B Main St" → "12B"), for the
 * identity check that stands in for reading a saved address out loud.
 */
export function houseNumber(line1: string): string | null {
  const m = line1.trim().match(/^(\d+[A-Za-z]?)\b/);
  return m ? m[1]!.toUpperCase() : null;
}
