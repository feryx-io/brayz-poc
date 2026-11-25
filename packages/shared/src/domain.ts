import { z } from 'zod';
import { E164 } from './ids.js';
// From its own module, not the index: domain.ts is evaluated before the index
// reaches delivery.js, and the schemas below use it at load time.
import { DeliveryAddress } from './delivery.js';

/** ---- Account / auth ---- */
// Dev-mode self-service registration (AUTH_MODE=dev). No password — dev only.
export const DevRegisterInput = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
});
export type DevRegisterInput = z.infer<typeof DevRegisterInput>;

// Editable fields on the caller's own account profile.
export const UpdateProfileInput = z.object({
  displayName: z.string().min(1).max(120),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

/** ---- Tenant ---- */
export const CreateTenantInput = z.object({
  name: z.string().min(1).max(200),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

export const UpdateTenantInput = z.object({
  name: z.string().min(1).max(200),
});
export type UpdateTenantInput = z.infer<typeof UpdateTenantInput>;

/** ---- Phone-number provisioning (Twilio) ---- */
// Search filters for available carrier numbers (query params on GET).
export const NumberSearchQueryInput = z.object({
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  region: z.string().length(2).optional(),
  locality: z.string().min(1).max(100).optional(),
  contains: z.string().min(1).max(20).optional(),
});
export type NumberSearchQueryInput = z.infer<typeof NumberSearchQueryInput>;

// Purchase a specific available number for a location.
export const ProvisionNumberInput = z.object({
  e164Number: E164,
});
export type ProvisionNumberInput = z.infer<typeof ProvisionNumberInput>;

export const Tenant = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof Tenant>;

/** ---- Location ---- */
export const CreateLocationInput = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).default('America/New_York'),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  mainPhone: E164.optional(),
  escalationPhone: E164.optional(),
  notificationPhone: E164.optional(),
  pickupEnabled: z.boolean().default(true),
  deliveryEnabled: z.boolean().default(false),
  // Opening lines (rotated per call) and welcome-back lines for a regular.
  aiGreetings: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  welcomeBackLines: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  // The owner saw the possible-duplicate warnings and chose to continue. Not
  // stored on the location; audited instead.
  acknowledgeDuplicates: z.boolean().optional(),
});
export type CreateLocationInput = z.infer<typeof CreateLocationInput>;

/** ---- Duplicate restaurants at sign-up ---- */

/**
 * A restaurant name the way two owners might each type it: case, punctuation
 * and generic trailing words ("restaurant", "pizzeria") set aside, "the"
 * dropped from the front. "Jimmy's Pizza" and "jimmys pizza restaurant" are
 * the same name here; "Jimmy's Pizza" and "Jimmy's Pizzeria" are not — the
 * check is deliberately exact once normalized, so a coincidence is a warning
 * and never a wall.
 */
export function normalizeRestaurantName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/\s+(restaurant|eatery|grill|kitchen|cafe|diner)$/, '')
    .trim();
}

const STREET_WORDS: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  av: 'ave',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  highway: 'hwy',
  route: 'rte',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};

/** A street address the way two owners might each type it — "123 Main Street" and "123 main st." agree. */
export function normalizeStreetAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Unit designators do not distinguish a restaurant from itself.
    .replace(/\s+(suite|ste|unit|apt|#)\s*\S+$/, '')
    .split(' ')
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

/** The first five digits of a US ZIP, or the trimmed value elsewhere. */
export function normalizePostalCode(raw: string): string {
  const t = raw.trim();
  const us = /^(\d{5})(-\d{4})?$/.exec(t);
  return us ? us[1]! : t.toLowerCase();
}

export const DuplicateFindingKind = z.enum([
  // Another account already lists this main phone. A published number belongs to one business: not allowed.
  'phone_claimed',
  // Another account has a location at this street address and ZIP.
  'same_address',
  // Another account has a restaurant of this name in this city (or ZIP).
  'same_name_nearby',
  // This account already has a location of this name in this city — almost always a slip.
  'same_name_in_account',
]);
export type DuplicateFindingKind = z.infer<typeof DuplicateFindingKind>;

/**
 * One thing the sign-up check noticed. Says only that a match exists and
 * where (the city the owner typed); never anything about the other account
 * (rule #1) — its name, phone, address, or owner.
 */
export interface DuplicateFinding {
  kind: DuplicateFindingKind;
  /** A blocking finding stops the save outright; the rest are warnings the owner can acknowledge. */
  blocking: boolean;
  message: string;
}

export const DuplicateCheckInput = z.object({
  name: z.string().trim().min(1).max(200),
  addressLine1: z.string().trim().optional(),
  city: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
  mainPhone: E164.optional(),
  /** When editing: the location being edited is never its own duplicate. */
  excludeLocationId: z.string().uuid().optional(),
});
export type DuplicateCheckInput = z.infer<typeof DuplicateCheckInput>;

/** An optional text field an owner may also clear: `null` means "remove it". */
const clearable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

// A partial update: every field optional, and the nullable-in-Postgres text
// fields accept null so a form can send an untouched empty field as-is and an
// owner can clear a number or greeting. `name` and `timezone` stay required
// strings when present.
export const UpdateLocationInput = CreateLocationInput.partial()
  .omit({ tenantId: true })
  .extend({
    addressLine1: clearable(z.string()),
    addressLine2: clearable(z.string()),
    city: clearable(z.string()),
    region: clearable(z.string()),
    postalCode: clearable(z.string()),
    mainPhone: clearable(E164),
    escalationPhone: clearable(E164),
    notificationPhone: clearable(E164),
    // What the bot quotes once an order is placed.
    pickupEtaMinutes: z.number().int().min(5).max(240).optional(),
    deliveryEtaMinutes: z.number().int().min(5).max(240).optional(),
    // Delivery pricing — added to the order by the API, never by the model (rule #5).
    deliveryFeeCents: z.number().int().min(0).max(10_000).optional(),
    deliveryMinimumCents: z.number().int().min(0).max(100_000).optional(),
    // The delivery area: within the radius OR in a listed ZIP; null/empty = no limit.
    deliveryRadiusMiles: clearable(z.number().min(0.5).max(50)),
    deliveryZipCodes: z.array(z.string().trim().min(3).max(10)).max(200).optional(),
  });
export type UpdateLocationInput = z.infer<typeof UpdateLocationInput>;

/** ---- Hours ---- A weekly schedule; day 0 = Sunday. */
export const HoursInterval = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  // Minutes from midnight in the location's timezone.
  opensAt: z.number().int().min(0).max(1439),
  closesAt: z.number().int().min(0).max(1440),
});
export type HoursInterval = z.infer<typeof HoursInterval>;

export const SetHoursInput = z.object({
  intervals: z.array(HoursInterval),
});
export type SetHoursInput = z.infer<typeof SetHoursInput>;

/** ---- Holiday hours ---- A specific date override. */
export const HolidayHours = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  closed: z.boolean().default(true),
  opensAt: z.number().int().min(0).max(1439).nullable().optional(),
  closesAt: z.number().int().min(0).max(1440).nullable().optional(),
  label: z.string().max(120).optional(),
});
export type HolidayHours = z.infer<typeof HolidayHours>;

export const SetHolidayHoursInput = z.object({
  entries: z.array(HolidayHours),
});
export type SetHolidayHoursInput = z.infer<typeof SetHolidayHoursInput>;

/** ---- AI / transfer settings ---- */
export const GuestMemoryMode = z.enum(['full', 'confirm', 'off']);
export type GuestMemoryMode = z.infer<typeof GuestMemoryMode>;

/** Who phrases the "added that" line — the engine, or the model. */
export const OrderAckMode = z.enum(['fast', 'natural']);
export type OrderAckMode = z.infer<typeof OrderAckMode>;

/** What the bot does with a call that lands when the restaurant is shut. */
export const ClosedBehavior = z.enum(['take_orders', 'announce']);
export type ClosedBehavior = z.infer<typeof ClosedBehavior>;

/** The furthest ahead any location may let a caller order. */
export const SCHEDULE_MAX_DAYS_AHEAD = 14;

export const LocationAiSettingsInput = z.object({
  transferEnabled: z.boolean().optional(),
  transferWhenOpen: z.boolean().optional(),
  offerMessageWhenClosed: z.boolean().optional(),
  maxCallSeconds: z.number().int().positive().max(3600).optional(),
  voicePersona: z.string().max(120).nullable().optional(),
  // How much the bot personalizes for a recognized returning caller (rule #6).
  guestMemoryMode: GuestMemoryMode.optional(),
  // Which voice answers calls: the built-in persona, one fixed staff voice, or
  // a daily rotation of the rotation-enabled staff voices.
  voiceMode: z.enum(['default', 'fixed', 'rotate']).optional(),
  fixedVoiceProfileId: z.string().uuid().nullable().optional(),
  // How often a rotating voice changes: once a day, or every call (round robin).
  voiceRotation: z.enum(['daily', 'per_call']).optional(),
  // Callers may ask for a staff persona by name; the call is handed to that voice.
  personaSwitchEnabled: z.boolean().optional(),
  // The built-in voice: which provider voice speaks when no staff voice does,
  // and the name it answers to ("this is Sam"). Null = the provider default,
  // answering as Brayz.
  defaultVoiceId: z.string().min(1).max(120).nullable().optional(),
  assistantName: z.string().trim().min(1).max(60).nullable().optional(),
  // How each item is confirmed as it is added. "fast" is the engine's own line,
  // spoken the moment the tool has done it; "natural" buys the assistant's own
  // wording with a second model round trip, and the caller waits for it.
  orderAckMode: OrderAckMode.optional(),
  // What a caller hears when the restaurant is closed: business as usual, or
  // told it is shut and when it opens next.
  closedBehavior: ClosedBehavior.optional(),
  // May a caller order ahead for a later time — when closed, and while open.
  scheduleOrdersEnabled: z.boolean().optional(),
  // How many days past today an order may be scheduled for; 0 is today only.
  scheduleMaxDaysAhead: z.number().int().min(0).max(SCHEDULE_MAX_DAYS_AHEAD).optional(),
  // After an order is placed, offer the caller a text when it is ready, and
  // send it when the order is marked ready — only with their spoken consent.
  guestOrderTextsEnabled: z.boolean().optional(),
  // Days a call recording is kept before it is deleted from storage. Null
  // means no per-location policy — the platform ceiling applies. The API
  // rejects a value above that ceiling, which it alone knows.
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export type LocationAiSettingsInput = z.infer<typeof LocationAiSettingsInput>;

/** Hear a voice say a line before choosing it. */
export const VoicePreviewInput = z.object({
  voiceId: z.string().min(1).max(120),
  text: z.string().trim().min(1).max(300),
});
export type VoicePreviewInput = z.infer<typeof VoicePreviewInput>;

/**
 * The placeholder an owner may put in a greeting for whoever is speaking —
 * the default voice's name or the staff member a cloned voice belongs to.
 */
export const STAFF_NAME_PLACEHOLDER = '{staff_name}';
export function fillStaffName(text: string, name: string | null | undefined): string {
  return text.split(STAFF_NAME_PLACEHOLDER).join(name?.trim() || 'Brayz');
}

/** The placeholder in a welcome-back line for the recognized caller's name. */
export const GUEST_NAME_PLACEHOLDER = '{guest_name}';
export function fillGuestName(text: string, name: string): string {
  return text.split(GUEST_NAME_PLACEHOLDER).join(name.trim());
}

/** What a regular hears before the greeting when the owner wrote nothing. */
export const DEFAULT_WELCOME_BACK_LINES: readonly string[] = [
  'Welcome back, {guest_name}!',
  'Hey {guest_name}, good to hear from you!',
  '{guest_name}! Good to have you back.',
];

/**
 * Which of several lines this call gets. A recognized caller cycles through
 * them by how many times they have called, so consecutive calls never repeat
 * and the sequence is the same for everyone who tests it; an unknown caller
 * gets one at random. One line is always itself; none is undefined.
 */
export function pickLine(
  lines: readonly string[],
  who: { priorCalls: number } | { random: number },
): string | undefined {
  if (lines.length === 0) return undefined;
  if (lines.length === 1) return lines[0];
  const index =
    'priorCalls' in who ? who.priorCalls % lines.length : Math.floor(who.random * lines.length) % lines.length;
  return lines[index];
}

/** ---- Loyalty (per-location program config; disabled until turned on) ---- */
export const LocationLoyaltySettingsInput = z.object({
  enabled: z.boolean().optional(),
  // Points earned per whole dollar of a confirmed order's total.
  pointsPerDollar: z.number().int().min(1).max(1000).optional(),
  // rewardPoints buys rewardCents off an order.
  rewardPoints: z.number().int().min(1).max(1_000_000).optional(),
  rewardCents: z.number().int().min(1).max(100_000).optional(),
  // VIP rule: lifetime spend threshold + earn multiplier.
  vipEnabled: z.boolean().optional(),
  vipSpendCents: z.number().int().min(1).max(100_000_000).optional(),
  vipPointsMultiplier: z.number().int().min(1).max(10).optional(),
  // Birthday offer: bonus points once per year in the guest's birthday month.
  birthdayEnabled: z.boolean().optional(),
  birthdayBonusPoints: z.number().int().min(1).max(1_000_000).optional(),
  // Win-back: bonus points on the first order after winbackDays inactive.
  winbackEnabled: z.boolean().optional(),
  winbackDays: z.number().int().min(7).max(365).optional(),
  winbackBonusPoints: z.number().int().min(1).max(1_000_000).optional(),
});
export type LocationLoyaltySettingsInput = z.infer<typeof LocationLoyaltySettingsInput>;

/** ---- Phone numbers ---- */
export const CreatePhoneNumberInput = z.object({
  e164Number: E164,
  provider: z.string().default('twilio'),
  providerNumberId: z.string().optional(),
  inboundRouteType: z.enum(['ai', 'forward', 'voicemail']).default('ai'),
  active: z.boolean().default(true),
});
export type CreatePhoneNumberInput = z.infer<typeof CreatePhoneNumberInput>;

/** ---- Transfer targets (per-location, named REFER destinations) ---- */
export const CreateTransferTargetInput = z.object({
  // Stable slug the LLM selects by; lowercase letters/digits/hyphen.
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'key must be lowercase letters, digits, or hyphens'),
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  // A sip:/sips: URI, or a phone/extension turned into one with the SIP domain.
  destination: z.string().min(1).max(256),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateTransferTargetInput = z.infer<typeof CreateTransferTargetInput>;

export const UpdateTransferTargetInput = CreateTransferTargetInput.partial();
export type UpdateTransferTargetInput = z.infer<typeof UpdateTransferTargetInput>;

/** ---- Menu ---- */
export const Money = z.number().int().nonnegative(); // cents, never floats

export const CreateMenuCategoryInput = z.object({
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
});
export type CreateMenuCategoryInput = z.infer<typeof CreateMenuCategoryInput>;

export const UpdateMenuCategoryInput = z.object({
  name: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateMenuCategoryInput = z.infer<typeof UpdateMenuCategoryInput>;

// Bulk menu import — the (user-reviewed) structure committed after AI extraction.
export const ImportMenuItem = z.object({
  name: z.string().min(1).max(160),
  priceCents: z.number().int().nonnegative(),
  description: z.string().max(1000).optional(),
  ingredients: z.array(z.string().min(1).max(80)).max(60).optional(),
});
export const ImportMenuCategory = z.object({
  name: z.string().min(1).max(120),
  items: z.array(ImportMenuItem),
});
export const ImportMenuMode = z.enum(['append', 'replace', 'merge']);
export type ImportMenuMode = z.infer<typeof ImportMenuMode>;
export const ImportMenuInput = z.object({
  categories: z.array(ImportMenuCategory).min(1),
  // append: add to the menu (may duplicate). replace: wipe + recreate. merge:
  // update matching items by name, add new, remove items not in the import.
  mode: ImportMenuMode.default('append'),
  // A menu template whose option groups the imported items get (toppings on
  // a pizza, sauce on wings), so a flat import is orderable by phone. Only
  // items this import creates are touched; existing items keep their own.
  templateId: z.string().min(1).max(40).optional(),
});
export type ImportMenuInput = z.infer<typeof ImportMenuInput>;

/**
 * Lay a menu template onto a location. `sections` creates the template's
 * categories (matched by name, never duplicated), `starterItems` its example
 * items (unpriced and hidden until the owner prices them); option groups are
 * attached to every matching item on the menu either way. `replace` wipes
 * the menu first.
 */
export const ApplyMenuTemplateInput = z.object({
  templateId: z.string().min(1).max(40),
  mode: z.enum(['append', 'replace']).default('append'),
  sections: z.boolean().default(true),
  starterItems: z.boolean().default(true),
});
export type ApplyMenuTemplateInput = z.infer<typeof ApplyMenuTemplateInput>;

export const CreateMenuItemInput = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional(),
  priceCents: Money,
  available: z.boolean().default(true),
  upsellTags: z.array(z.string()).default([]),
  ingredients: z.array(z.string().min(1).max(80)).max(60).default([]),
});
export type CreateMenuItemInput = z.infer<typeof CreateMenuItemInput>;

export const UpdateMenuItemInput = CreateMenuItemInput.partial().omit({ categoryId: true });
export type UpdateMenuItemInput = z.infer<typeof UpdateMenuItemInput>;

export const ModifierSelectionType = z.enum(['single', 'multi']);
export type ModifierSelectionType = z.infer<typeof ModifierSelectionType>;

/** Which part of an item an option goes on. Half-and-half is `left` + `right`. */
export const ModifierPortion = z.enum(['whole', 'left', 'right']);
export type ModifierPortion = z.infer<typeof ModifierPortion>;

/** What a half topping costs: the whole topping price, or half of it. */
export const HalfPricing = z.enum(['full', 'half']);
export type HalfPricing = z.infer<typeof HalfPricing>;

/**
 * Should a new group allow half-and-half? Yes for a multi-select toppings
 * group on a pizza; no for anything else — a calzone or a sub is one thing.
 * The migration that added the column backfilled existing groups by the same
 * rule, so a restaurant never has to click through 27 toppings per size.
 */
export function defaultAllowsHalves(
  item: { name: string; category?: string | null },
  group: { name: string; selectionType: string },
): boolean {
  // A calzone or stromboli under a "Pizza" section is still one folded thing.
  if (/calzone|stromboli/i.test(item.name)) return false;
  const pizza = /pizza/i.test(item.name) || /pizza/i.test(item.category ?? '');
  return pizza && group.selectionType === 'multi' && /topping/i.test(group.name);
}

/** What an option costs on the given portion under the group's rule. */
export function portionPriceCents(
  priceCents: number,
  portion: ModifierPortion,
  halfPricing: HalfPricing | string | null | undefined,
): number {
  if (portion === 'whole' || halfPricing !== 'half') return priceCents;
  // Rounded up: two halves must never add up to less than the whole.
  return Math.ceil(priceCents / 2);
}

/** How a portioned option reads on a ticket: "Pepperoni (left half)". */
export function modifierLabel(name: string, portion: ModifierPortion | string | null | undefined): string {
  return portion === 'left' || portion === 'right' ? `${name} (${portion} half)` : name;
}

export const CreateModifierGroupInput = z.object({
  menuItemId: z.string().uuid(),
  name: z.string().min(1).max(120),
  selectionType: ModifierSelectionType,
  required: z.boolean().default(false),
  minSelections: z.number().int().nonnegative().default(0),
  maxSelections: z.number().int().positive().optional(),
  // Omitted means "decide by defaultAllowsHalves" — the route fills it in.
  allowsHalves: z.boolean().optional(),
  halfPricing: HalfPricing.default('full'),
});
export type CreateModifierGroupInput = z.infer<typeof CreateModifierGroupInput>;

/**
 * Editing a group after the fact. selectionType is here because a restaurant
 * finds out from a call that a group is really single-choice — the wings dip
 * they set up as multi, that a caller then asked for both of.
 */
export const UpdateModifierGroupInput = z.object({
  name: z.string().min(1).max(120).optional(),
  selectionType: ModifierSelectionType.optional(),
  required: z.boolean().optional(),
  minSelections: z.number().int().nonnegative().optional(),
  maxSelections: z.number().int().positive().nullable().optional(),
  allowsHalves: z.boolean().optional(),
  halfPricing: HalfPricing.optional(),
});
export type UpdateModifierGroupInput = z.infer<typeof UpdateModifierGroupInput>;

export const CreateModifierInput = z.object({
  modifierGroupId: z.string().uuid(),
  name: z.string().min(1).max(120),
  priceCents: Money.default(0),
  available: z.boolean().default(true),
});
export type CreateModifierInput = z.infer<typeof CreateModifierInput>;

/**
 * Editing one option. `available` is the soft form of deleting it: a dip they
 * have run out of should stop being offered without losing the tickets that
 * already reference it.
 */
export const UpdateModifierInput = z.object({
  name: z.string().min(1).max(120).optional(),
  priceCents: Money.optional(),
  available: z.boolean().optional(),
});
export type UpdateModifierInput = z.infer<typeof UpdateModifierInput>;

/** ---- Menu gaps (asked for, not on the menu) ---- */
export const MenuGapKind = z.enum(['item', 'option']);
export type MenuGapKind = z.infer<typeof MenuGapKind>;

export const RecordMenuGapInput = z.object({
  kind: MenuGapKind,
  /** As the caller said it. Normalized server-side so spellings aggregate. */
  term: z.string().min(1).max(120),
  /** The item the option was asked for on, when kind is "option". */
  onItem: z.string().max(200).optional(),
});
export type RecordMenuGapInput = z.infer<typeof RecordMenuGapInput>;

/** ---- Orders (in-call pickup orders) ---- */
// One line the Orchestrator submits. menuItemId is authoritative — the API
// re-prices by it from the menu and ignores any client-supplied price (rule #5).
// `name` is a fallback label for display if the item was since removed.
export const CreateOrderItemInput = z.object({
  menuItemId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(99).default(1),
  specialInstructions: z.string().max(500).optional(),
  // Options chosen for this line (crust, toppings, sauce). Ids only: the API
  // resolves each one against this item's own modifier groups and takes the
  // name and the price from the menu, so a caller's choice can never introduce
  // an option this item does not have, or a price (rule #5).
  modifierIds: z.array(z.string().uuid()).max(20).optional(),
  // The portioned form of modifierIds: an option and which part of the item it
  // goes on. Either field may be used; both together are merged.
  modifiers: z
    .array(z.object({ id: z.string().uuid(), portion: ModifierPortion.default('whole') }))
    .max(20)
    .optional(),
  // Set by the Orchestrator when this line came from an add-on the bot offered.
  // Attribution only — it never affects price.
  viaUpsell: z.boolean().optional(),
});
export type CreateOrderItemInput = z.infer<typeof CreateOrderItemInput>;

/** ---- Guests (guest memory) ---- */
// Dashboard edits to a guest's memory + consent. null clears a field.
export const UpdateGuestInput = z.object({
  displayName: z.string().max(120).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  // The guest's opt-out switch; false stops all personalization for them.
  memoryEnabled: z.boolean().optional(),
  // Month/day only (no year), for the birthday offer. Null clears it.
  birthdayMonth: z.number().int().min(1).max(12).nullable().optional(),
  birthdayDay: z.number().int().min(1).max(31).nullable().optional(),
  // The address their last delivery went to, offered on the next call. Null removes it.
  deliveryAddress: DeliveryAddress.nullable().optional(),
});
export type UpdateGuestInput = z.infer<typeof UpdateGuestInput>;

/** ---- Staff voices (Phase 7; consent-gated, rule #6) ---- */
export const CreateStaffInput = z.object({
  name: z.string().min(1).max(120),
  role: z.string().max(120).optional(),
  // Give the persona a catalog voice on creation. Absent = no voice yet (clone
  // one after consent, or assign a catalog voice later).
  providerVoiceId: z.string().min(1).max(120).optional(),
});
export type CreateStaffInput = z.infer<typeof CreateStaffInput>;

export const UpdateStaffInput = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateStaffInput = z.infer<typeof UpdateStaffInput>;

export const RecordConsentInput = z.object({
  action: z.enum(['granted', 'revoked']),
  // How consent was captured; a real signature/recording reference goes in notes.
  source: z.enum(['dashboard', 'paper', 'recorded_call']),
  notes: z.string().max(2000).optional(),
});
export type RecordConsentInput = z.infer<typeof RecordConsentInput>;

export const CreateVoiceProfileInput = z.object({
  label: z.string().min(1).max(120),
});
export type CreateVoiceProfileInput = z.infer<typeof CreateVoiceProfileInput>;

/** Hand the call to another staff persona, by the name the caller used. */
export const SwitchPersonaInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type SwitchPersonaInput = z.infer<typeof SwitchPersonaInput>;

/** A catalog (vendor) voice for a staff persona — no consent involved, it is nobody's real voice. */
export const AssignProviderVoiceInput = z.object({
  voiceId: z.string().min(1).max(120),
  label: z.string().min(1).max(120).optional(),
});
export type AssignProviderVoiceInput = z.infer<typeof AssignProviderVoiceInput>;

export const UpdateVoiceProfileInput = z.object({
  enabledForRotation: z.boolean().optional(),
});
export type UpdateVoiceProfileInput = z.infer<typeof UpdateVoiceProfileInput>;

/**
 * A time the caller asked for, as the model heard it: a local clock time and
 * which day it is on. Deliberately not a timestamp — the model does not know
 * the restaurant's timezone, and should never be the thing that computes an
 * instant. The API resolves and validates it.
 */
export const ScheduleOrderInput = z.object({
  /** 24-hour local time, HH:MM. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM, 24-hour'),
  /**
   * today | tomorrow | a weekday name (the next one) | a local calendar date
   * (YYYY-MM-DD). Defaults to today. Case-insensitive.
   */
  day: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z.union([
        z.enum(['today', 'tomorrow', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ]),
    )
    .optional(),
});
export type ScheduleOrderInput = z.infer<typeof ScheduleOrderInput>;

/**
 * The whole of a changed order: every line it should have after the change,
 * not a diff. The engine rebuilds the draft from what was placed and sends it
 * back as it now stands, so the API prices one list rather than replaying a
 * sequence of edits it cannot see.
 */
export const ChangeOrderInput = z.object({
  items: z.array(CreateOrderItemInput).min(1),
});
export type ChangeOrderInput = z.infer<typeof ChangeOrderInput>;

export const CreateOrderInput = z.object({
  items: z.array(CreateOrderItemInput).min(1),
  customerName: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  fulfillmentType: z.enum(['pickup', 'delivery']).default('pickup'),
  // Where a delivery order goes. The API refuses a delivery without one, and
  // checks it against the location's delivery area itself.
  deliveryAddress: DeliveryAddress.optional(),
  // Apply the caller's loyalty reward to this order. The API validates
  // eligibility and owns the discount math (CLAUDE.md rule #5).
  redeemReward: z.boolean().optional(),
  // Apply a promotion the caller asked for, by id (from the promotions tool) or
  // by the code they said out loud. Same rule: the API re-checks eligibility and
  // computes the money — the model only passes along what was asked for.
  promotionId: z.string().uuid().optional(),
  promotionCode: z.string().max(24).optional(),
  // When the caller asked for it. The API re-checks it against the opening
  // hours and the location's own limit — the engine proposes, the API decides
  // (rule #5). Absent means as soon as possible.
  scheduledFor: z.string().datetime().optional(),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

/**
 * An add-on the bot may offer alongside what is already in the order. Priced by
 * the API from the live menu (rule #5) — the model reads these out, it never
 * invents an item or a price.
 */
export const UpsellSuggestion = z.object({
  menuItemId: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  description: z.string().nullable(),
});
export type UpsellSuggestion = z.infer<typeof UpsellSuggestion>;

/** ---- Calls list (dashboard) ---- */
/**
 * A page of calls. `from`/`to` are instants; the dashboard turns a day in the
 * restaurant's timezone into them. `cursor` is opaque and comes from the
 * previous page — keyset paging, so a page is the same page whether or not a
 * call landed while it was being read.
 */
/**
 * Which orders the Orders screen is looking at. `open` is everything still in
 * the kitchen's hands (not completed or canceled), all of it, however old — a
 * call-ahead for Friday must not scroll off behind today's rush. `closed` is
 * completed and canceled, newest first, a page at a time. No status keeps the
 * old answer: the newest hundred of everything.
 */
export const ListOrdersQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuery>;

/** How many orders were taken in a time range — the dashboard's "Orders today", in the restaurant's day. */
export const OrderCountQuery = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((q) => q.from < q.to, { message: 'from must be before to' });
export type OrderCountQuery = z.infer<typeof OrderCountQuery>;

export const ListCallsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListCallsQuery = z.infer<typeof ListCallsQuery>;

/** Calls counted per calendar day in a timezone — the collapsed view. */
export const CallDaysQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // An IANA name; the route checks it is one the runtime knows.
  tz: z.string().min(1).max(64).default('UTC'),
});
export type CallDaysQuery = z.infer<typeof CallDaysQuery>;

/**
 * What a restaurant's Insights screen asks for: a window, the timezone its
 * days are cut in, and how finely to slice the series. Defaults are filled in
 * by the route (the last 30 days, by day) so the screen can ask for nothing.
 */
export const InsightsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  tz: z.string().min(1).max(64).default('UTC'),
  bucket: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  /** How many rows the "top" tables come back with. */
  top: z.coerce.number().int().min(1).max(25).default(5),
});
export type InsightsQuery = z.infer<typeof InsightsQuery>;

/** ---- Menu health (findings about a menu, and the edit that fixes each) ---- */
/**
 * One key per thing named, so ten spellings count as one thing. Lowercased,
 * punctuation dropped, a leading article removed — "a Ketchup!" and "ketchup"
 * are the same request. Shared by the menu-gap recorder and the health checks
 * so an ask and an option compare on equal terms.
 */
export function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the|some|extra|side of|order of)\s+/, '')
    .trim()
    .slice(0, 120);
}

export const MenuHealthSeverity = z.enum(['fix', 'warn', 'info']);
export type MenuHealthSeverity = z.infer<typeof MenuHealthSeverity>;

/**
 * The menu edit that resolves a finding, in terms of the existing menu
 * routes — the dashboard applies it by calling them, so it is role-gated and
 * audited exactly like a hand edit.
 */
export type MenuHealthFix =
  | {
      kind: 'create_group';
      itemId: string;
      name: string;
      selectionType: 'single' | 'multi';
      required: boolean;
      maxSelections?: number;
      modifiers: Array<{ name: string; priceCents: number }>;
    }
  | { kind: 'add_modifier'; groupId: string; name: string; priceCents: number }
  | { kind: 'allow_halves'; groupId: string }
  | { kind: 'update_item'; itemId: string; name?: string; priceCents?: number; available?: boolean }
  | { kind: 'update_modifier'; modifierId: string; name?: string; priceCents?: number; available?: boolean }
  // Build mode: a section or an item that does not exist yet, so these carry
  // names, not ids. An item names its section; applying creates the section
  // if the menu lacks one of that name. An item without a price is created
  // unpriced and hidden, exactly as a template's starter item is — the bot
  // never quotes a guess — and menu health lists it until the owner prices it.
  | { kind: 'create_category'; name: string }
  | {
      kind: 'create_item';
      category: string;
      name: string;
      description?: string;
      priceCents?: number;
      ingredients?: string[];
      groups: MenuFixGroup[];
    };

/** An option group as a fix carries it: what create_group has, minus the item it goes on. */
export interface MenuFixGroup {
  name: string;
  selectionType: 'single' | 'multi';
  required: boolean;
  maxSelections?: number;
  allowsHalves?: boolean;
  modifiers: Array<{ name: string; priceCents: number }>;
}

/**
 * The same shape as a schema, for edits that arrive from outside the code —
 * the assistant's proposals. Anything the union does not name is refused.
 */
export const MenuHealthFixInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_group'),
    itemId: z.string().uuid(),
    name: z.string().min(1).max(120),
    selectionType: z.enum(['single', 'multi']),
    required: z.boolean().default(false),
    maxSelections: z.number().int().positive().optional(),
    modifiers: z.array(z.object({ name: z.string().min(1).max(120), priceCents: Money })).min(1).max(60),
  }),
  z.object({
    kind: z.literal('add_modifier'),
    groupId: z.string().uuid(),
    name: z.string().min(1).max(120),
    priceCents: Money,
  }),
  z.object({ kind: z.literal('allow_halves'), groupId: z.string().uuid() }),
  z.object({
    kind: z.literal('update_item'),
    itemId: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    priceCents: Money.optional(),
    available: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('update_modifier'),
    modifierId: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    priceCents: Money.optional(),
    available: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('create_category'), name: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal('create_item'),
    category: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    priceCents: Money.optional(),
    ingredients: z.array(z.string().min(1).max(80)).max(60).optional(),
    groups: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          selectionType: z.enum(['single', 'multi']),
          required: z.boolean().default(false),
          maxSelections: z.number().int().positive().optional(),
          allowsHalves: z.boolean().optional(),
          modifiers: z.array(z.object({ name: z.string().min(1).max(120), priceCents: Money })).min(1).max(60),
        }),
      )
      .max(12)
      .default([]),
  }),
]);

export interface MenuHealthFinding {
  /** Stable across runs while the underlying fact holds; the dashboard keys dismissals on it. */
  id: string;
  code:
    | 'options_promised_no_group'
    | 'option_asked_not_offered'
    | 'duplicate_item'
    | 'pizza_halves_off'
    | 'group_without_options'
    | 'item_zero_price'
    | 'starter_items_unpriced';
  severity: MenuHealthSeverity;
  itemId?: string;
  itemName?: string;
  groupId?: string;
  title: string;
  detail: string;
  evidence: { count?: number; lastAt?: string; samples?: string[] };
  fix?: MenuHealthFix;
}

export const MenuHealthQuery = z.object({
  // How far back callers' asks count. A request from last winter is not a
  // reason to change the menu now.
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** ---- Messages a caller leaves for the restaurant ---- */
export const CallMessageStatus = z.enum(['new', 'done']);
export type CallMessageStatus = z.infer<typeof CallMessageStatus>;

/** What the bot sends when it takes a message (node-authed tool endpoint). */
export const TakeMessageInput = z.object({
  message: z.string().min(1).max(2000),
  callerName: z.string().min(1).max(120).optional(),
  // Only when the caller gave a number other than the one they called from;
  // the API fills in the calling number otherwise.
  callbackNumber: z.string().min(3).max(40).optional(),
});
export type TakeMessageInput = z.infer<typeof TakeMessageInput>;

export const CallMessageQuery = z.object({
  status: z.enum(['new', 'done', 'all']).default('new'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const UpdateCallMessageInput = z.object({ status: CallMessageStatus });
export type UpdateCallMessageInput = z.infer<typeof UpdateCallMessageInput>;

/** ---- Assistant (per-account chat over the menu, calls and settings) ---- */
export const AssistantMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(6000),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const AssistantChatInput = z.object({
  // The whole conversation so far, oldest first. The API keeps no session;
  // the dashboard holds the thread and sends it back each time.
  messages: z.array(AssistantMessage).min(1).max(40),
  // How far back the assistant's evidence reaches.
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type AssistantChatInput = z.infer<typeof AssistantChatInput>;

/** A menu edit the assistant suggests. Nothing happens until the owner applies it. */
export interface AssistantProposal {
  id: string;
  summary: string;
  reason: string;
  fix: MenuHealthFix;
}

