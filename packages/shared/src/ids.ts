import { z } from 'zod';

/** Branded UUID helpers for compile-time id safety. */
export const Uuid = z.string().uuid();

export const TenantId = Uuid.brand<'TenantId'>();
export const LocationId = Uuid.brand<'LocationId'>();
export const UserId = Uuid.brand<'UserId'>();
export const GuestId = Uuid.brand<'GuestId'>();
export const CallId = Uuid.brand<'CallId'>();
export const OrderId = Uuid.brand<'OrderId'>();
export const MenuItemId = Uuid.brand<'MenuItemId'>();

export type TenantId = z.infer<typeof TenantId>;
export type LocationId = z.infer<typeof LocationId>;
export type UserId = z.infer<typeof UserId>;
export type GuestId = z.infer<typeof GuestId>;
export type CallId = z.infer<typeof CallId>;
export type OrderId = z.infer<typeof OrderId>;
export type MenuItemId = z.infer<typeof MenuItemId>;

/** E.164 phone number — the MVP guest identity signal. */
export const E164 = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number, e.g. +15185551212');
export type E164 = z.infer<typeof E164>;
