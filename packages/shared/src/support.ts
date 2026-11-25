import { z } from 'zod';

/**
 * Support requests, and the Brayz-staff roles that work them.
 *
 * A support request belongs to a tenant like everything else. What is unusual
 * is who reads it: Brayz staff, across every tenant, through /v1/admin. That
 * surface is gated by `PlatformRole` alone.
 */

/** Brayz staff, not a restaurant's user. Null/absent for every customer. */
export const PlatformRole = z.enum(['support', 'admin']);
export type PlatformRole = z.infer<typeof PlatformRole>;

/** `support` reads the admin portal; `admin` also writes and promotes staff. */
export function platformRoleAtLeast(role: string | null | undefined, min: PlatformRole): boolean {
  if (role !== 'support' && role !== 'admin') return false;
  return min === 'support' ? true : role === 'admin';
}

export const SupportSeverity = z.enum(['low', 'normal', 'high', 'urgent']);
export type SupportSeverity = z.infer<typeof SupportSeverity>;

export const SupportStatus = z.enum(['open', 'in_progress', 'resolved']);
export type SupportStatus = z.infer<typeof SupportStatus>;

/** What a restaurant fills in when it asks for help. */
export const CreateSupportRequestInput = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(5000),
  severity: SupportSeverity.default('normal'),
  /** The location it is about, when it is about one. */
  locationId: z.string().uuid().nullable().optional(),
});
export type CreateSupportRequestInput = z.infer<typeof CreateSupportRequestInput>;

/**
 * What Brayz staff change on one. `staffReply` is shown to the customer, so it
 * is an answer rather than an internal note.
 */
export const UpdateSupportRequestInput = z
  .object({
    status: SupportStatus.optional(),
    staffReply: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.staffReply !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateSupportRequestInput = z.infer<typeof UpdateSupportRequestInput>;

/** Granting or removing Brayz staff access. Only an `admin` may call it. */
export const SetPlatformRoleInput = z.object({
  email: z.string().trim().email(),
  role: PlatformRole.nullable(),
});
export type SetPlatformRoleInput = z.infer<typeof SetPlatformRoleInput>;
