import { z } from 'zod';

/** Roles a user can hold within a tenant (and optionally a location). */
export const Role = z.enum(['owner', 'manager', 'staff', 'admin']);
export type Role = z.infer<typeof Role>;

/** Role precedence for simple "at least this role" checks. Higher = more power. */
export const ROLE_RANK: Record<Role, number> = {
  staff: 1,
  manager: 2,
  owner: 3,
  admin: 4,
};

export function roleAtLeast(have: Role, required: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[required];
}
