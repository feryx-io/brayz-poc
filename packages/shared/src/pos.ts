import { z } from 'zod';

/**
 * POS integration contracts (Phase 8.4). The provider interfaces themselves
 * live in `@brayz/pos`; these are the wire shapes the API and dashboard share.
 */

/** POS vendors Brayz can talk to. `manual` is the no-POS fallback. */
export const PosProviderName = z.enum(['manual', 'square', 'toast', 'clover']);
export type PosProviderName = z.infer<typeof PosProviderName>;

export const PosEnvironment = z.enum(['sandbox', 'production']);
export type PosEnvironment = z.infer<typeof PosEnvironment>;

/** How the push to the POS ended. `unsupported` = the adapter cannot do it. */
export const PosSyncStatus = z.enum(['pending', 'synced', 'failed', 'unsupported']);
export type PosSyncStatus = z.infer<typeof PosSyncStatus>;

/**
 * Configure the location's POS. The access token is write-only: it goes in here
 * and is never returned by any read endpoint — and it is optional on purpose, so
 * an owner can toggle `enabled` or fix a location id without re-entering
 * credentials. Whether the result is actually usable is decided by the route,
 * which can see the stored token this payload may be omitting.
 */
export const UpsertPosIntegrationInput = z.object({
  provider: PosProviderName,
  enabled: z.boolean().default(true),
  externalLocationId: z.string().min(1).optional(),
  environment: PosEnvironment.default('sandbox'),
  accessToken: z.string().min(1).optional(),
});
export type UpsertPosIntegrationInput = z.infer<typeof UpsertPosIntegrationInput>;

/** Brayz order lifecycle. The dashboard moves an order along; the POS follows. */
export const OrderStatus = z.enum([
  'draft',
  'confirmed',
  'accepted',
  'ready',
  'completed',
  'canceled',
  'failed',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** Statuses the dashboard may set by hand. `draft`/`failed` are system-owned. */
export const SettableOrderStatus = z.enum(['accepted', 'ready', 'completed', 'canceled']);
export type SettableOrderStatus = z.infer<typeof SettableOrderStatus>;

export const UpdateOrderStatusInput = z.object({ status: SettableOrderStatus });
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusInput>;
