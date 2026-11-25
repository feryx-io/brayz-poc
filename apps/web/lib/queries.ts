'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from './auth';

export interface Location {
  id: string;
  name: string;
  timezone: string;
  addressLine1?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  mainPhone?: string | null;
  escalationPhone?: string | null;
  notificationPhone?: string | null;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  /** What the bot quotes once an order is placed. */
  pickupEtaMinutes?: number;
  deliveryEtaMinutes?: number;
  deliveryFeeCents?: number;
  /** Before the fee; 0 = none. */
  deliveryMinimumCents?: number;
  /** Delivery area: inside the radius OR a listed ZIP. Neither set = anywhere. */
  deliveryRadiusMiles?: number | null;
  deliveryZipCodes?: string[];
  /** The restaurant's position for the radius, found from its address. */
  latitude?: number | null;
  longitude?: number | null;
  /** Opening lines, rotated per call ({staff_name} = whoever answers). */
  aiGreetings?: string[];
  /** Welcome-back lines for a recognized regular ({guest_name} = their name). */
  welcomeBackLines?: string[];
}

export interface Modifier {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
}
export interface ModifierGroup {
  id: string;
  name: string;
  selectionType: 'single' | 'multi';
  required: boolean;
  minSelections: number;
  maxSelections?: number | null;
  /** Callers may put an option on one half only ("half pepperoni, half sausage"). */
  allowsHalves?: boolean;
  /** What a half costs: the whole option price, or half of it. */
  halfPricing?: 'full' | 'half';
  modifiers: Modifier[];
}
export interface MenuItem {
  id: string;
  name: string;
  description?: string | null;
  priceCents: number;
  available: boolean;
  ingredients?: string[];
  /** What this item pairs with; the bot offers it when the order matches one. */
  upsellTags?: string[];
  modifierGroups: ModifierGroup[];
}
export interface MenuTree {
  id: string;
  name: string;
  categories: Array<{
    id: string;
    name: string;
    sortOrder: number;
    items: MenuItem[];
  }>;
}

export type GuestMemoryMode = 'full' | 'confirm' | 'off';

export interface AiSettings {
  transferEnabled: boolean;
  transferWhenOpen: boolean;
  offerMessageWhenClosed: boolean;
  maxCallSeconds: number;
  voicePersona?: string | null;
  voiceMode?: 'default' | 'fixed' | 'rotate';
  fixedVoiceProfileId?: string | null;
  /** In rotate mode: a new voice each day, or each call. */
  voiceRotation?: 'daily' | 'per_call';
  /** Callers may ask for a staff persona by name and the call is handed to that voice. */
  personaSwitchEnabled?: boolean;
  /** The built-in voice (provider voice id) and the name it answers to. */
  defaultVoiceId?: string | null;
  assistantName?: string | null;
  guestMemoryMode?: GuestMemoryMode;
  orderAckMode?: OrderAckMode;
  /** What a caller hears out of hours: business as usual, or that you are closed. */
  closedBehavior?: 'take_orders' | 'announce';
  /** Whether callers may order for a later time, and how far ahead. */
  scheduleOrdersEnabled?: boolean;
  /** Offer callers a text when their order is ready, sent only to those who say yes. */
  guestOrderTextsEnabled?: boolean;
  scheduleMaxDaysAhead?: number;
  /** Days a recording is kept before it is deleted; null = the platform ceiling. */
  recordingRetentionDays?: number | null;
  /** The platform ceiling (read-only; the API sets it from deployment config). */
  recordingRetentionMaxDays?: number;
}

/** A voice the TTS provider offers for the built-in receptionist. */
export interface TtsVoice {
  id: string;
  name: string;
  language: string;
  accent?: string;
  age?: string;
  tags: string[];
  sampleUrl?: string;
}

/** Who phrases the "added that" line as an order is built: the system, or the AI. */
export type OrderAckMode = 'fast' | 'natural';

/** Something callers asked for that this menu does not sell. */
export interface MenuGap {
  term: string;
  label: string;
  kind: 'item' | 'option';
  onItems: string[];
  count: number;
  lastAskedAt: string;
}

export interface HolidayEntry {
  date: string; // YYYY-MM-DD
  closed: boolean;
  opensAt?: number | null;
  closesAt?: number | null;
  label?: string | null;
}

/** All locations for the active tenant (keyed by tenant so switching refetches). */
export function useLocations() {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['locations', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<Location[]>('/v1/locations'),
  });
}

export interface Call {
  id: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  status: string;
  provider: string;
  startedAt: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  summary?: string | null;
  /** started | stopped | failed | uploaded. Absent when the node isn't recording. */
  recordingStatus?: string | null;
}

export interface CallRange {
  /** Instants; the Calls screen derives them from days in the location's timezone. */
  from?: Date;
  to?: Date;
}

export interface CallPage {
  calls: Call[];
  /** Opaque; pass back to get the next page. Null on the last one. */
  nextCursor: string | null;
}

function callQuery(range: CallRange | undefined, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (range?.from) q.set('from', range.from.toISOString());
  if (range?.to) q.set('to', range.to.toISOString());
  const str = q.toString();
  return str ? `?${str}` : '';
}

/** The newest calls in a range — one page. The Dashboard reads today's. */
export function useCalls(locationId: string | undefined, range?: CallRange, limit = 200) {
  const { api, activeTenantId } = useAuth();
  const q = callQuery(range, { limit: String(limit) });
  return useQuery({
    queryKey: ['calls', activeTenantId, locationId, q],
    enabled: !!locationId,
    refetchInterval: 15_000,
    queryFn: () => api<CallPage>(`/v1/locations/${locationId}/calls${q}`),
  });
}

/** Every page of a day's calls, fetched as the user asks for more. */
export function useDayCalls(locationId: string | undefined, range: CallRange, opts: { live: boolean }) {
  const { api, activeTenantId } = useAuth();
  const base = callQuery(range, { limit: '100' });
  return useInfiniteQuery({
    queryKey: ['calls', 'day', activeTenantId, locationId, base],
    enabled: !!locationId,
    // Today's list keeps up with the phones; a past day is settled.
    refetchInterval: opts.live ? 15_000 : false,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<CallPage>(
        `/v1/locations/${locationId}/calls${base}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export interface CallDay {
  /** YYYY-MM-DD in the location's timezone. */
  day: string;
  calls: number;
  orders: number;
  transferred: number;
  failed: number;
}

/** Calls per day in the location's timezone, newest day first. */
export function useCallDays(locationId: string | undefined, range: CallRange, tz: string) {
  const { api, activeTenantId } = useAuth();
  const q = callQuery(range, { tz });
  return useQuery({
    queryKey: ['calls', 'days', activeTenantId, locationId, q],
    enabled: !!locationId,
    refetchInterval: 15_000,
    queryFn: () => api<{ tz: string; days: CallDay[] }>(`/v1/locations/${locationId}/calls/days${q}`),
  });
}

/** The path the CSV export lives at, for `apiBlob`. */
export function callsExportPath(locationId: string, range: CallRange, tz: string): string {
  return `/v1/locations/${locationId}/calls/export.csv${callQuery(range, { tz })}`;
}

export interface CallEventRow {
  id: string;
  eventType: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
}
export interface CallDetail extends Call {
  events: CallEventRow[];
}

/** One call with its lifecycle events. Polls while the call is still live. */
export function useCall(callId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['call', activeTenantId, callId],
    enabled: !!callId,
    queryFn: () => api<CallDetail>(`/v1/calls/${callId}`),
    refetchInterval: (query) => (isLiveCall(query.state.data?.status) ? 5_000 : false),
  });
}

export interface TranscriptTurn {
  speaker: 'caller' | 'agent';
  text: string;
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number;
  at?: string;
}

/**
 * The call's transcript, written turn-by-turn by the Orchestrator during the
 * call — so an in-progress call is polled and fills in as the guest talks.
 */
export function useCallTranscript(callId: string | undefined, live: boolean) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['call-transcript', activeTenantId, callId],
    enabled: !!callId,
    refetchInterval: live ? 5_000 : false,
    queryFn: () => api<{ turns: TranscriptTurn[] }>(`/v1/calls/${callId}/transcript`),
  });
}

/** A call still in progress: its transcript and events are still growing. */
export function isLiveCall(status?: string): boolean {
  return status === 'started' || status === 'in_progress' || status === 'transferred';
}

export interface OrderItemModifierRow {
  id: string;
  name: string;
  priceCents: number;
  /** Which part of the item it goes on: whole | left | right. */
  portion?: string;
}

/** An option as the ticket reads it: "Pepperoni (left half)". */
export function modifierLabel(m: { name: string; portion?: string | null }): string {
  return m.portion === 'left' || m.portion === 'right' ? `${m.name} (${m.portion} half)` : m.name;
}

export interface OrderItemRow {
  id: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  specialInstructions?: string | null;
  /** Options chosen on the call (crust, toppings). Priced on top of the item. */
  modifiers?: OrderItemModifierRow[];
}

/** What one of a line costs: the item plus every option chosen for it. */
export function orderItemUnitCents(item: OrderItemRow): number {
  return (item.modifiers ?? []).reduce((sum, m) => sum + m.priceCents, item.unitPriceCents);
}
/** How the ticket's push to the restaurant's POS ended. Null = no POS connected. */
export interface OrderPosSync {
  provider: string;
  status: 'pending' | 'synced' | 'failed' | 'unsupported';
  externalOrderId?: string | null;
  attempts: number;
  lastError?: string | null;
}
/** Where a delivery goes — the order's snapshot, or a guest's saved address. */
export interface DeliveryAddressView {
  line1: string;
  line2?: string;
  city?: string;
  postalCode?: string;
  instructions?: string;
}

export interface Order {
  id: string;
  code: string;
  status: string;
  fulfillmentType: string;
  customerName?: string | null;
  customerPhone?: string | null;
  subtotalCents: number;
  totalCents: number;
  /** Delivery orders only. */
  deliveryAddress?: DeliveryAddressView | null;
  deliveryFeeCents?: number;
  /** How the address met the delivery area; `unverified` means it could not be checked. */
  deliveryAreaCheck?: string | null;
  notes?: string | null;
  createdAt: string;
  /** Set when the caller ordered for later; the order is due then, not now. */
  scheduledFor?: string | null;
  items: OrderItemRow[];
  pos?: OrderPosSync | null;
}

/** Statuses the dashboard may set by hand; `draft`/`failed` are system-owned. */
export const SETTABLE_ORDER_STATUSES = ['accepted', 'ready', 'completed', 'canceled'] as const;
export type SettableOrderStatus = (typeof SETTABLE_ORDER_STATUSES)[number];

/** An order nobody can move any further — the till would only desync. */
export function isFinalOrderStatus(status: string): boolean {
  return status === 'completed' || status === 'canceled';
}

/**
 * Pickup and delivery orders for a location (newest first). Polls so new calls'
 * orders appear live. `open` is every order the kitchen still has, however
 * old; without it, the newest hundred of everything.
 */
export function useOrders(locationId: string | undefined, status?: 'open') {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['orders', activeTenantId, locationId, status ?? 'all'],
    enabled: !!locationId,
    refetchInterval: 15_000,
    queryFn: () => api<Order[]>(`/v1/locations/${locationId}/orders${status ? `?status=${status}` : ''}`),
  });
}

/**
 * How many orders were taken in a range (every status). The dashboard reads
 * today's, in the restaurant's day — counted by the API, not by filtering a
 * page of orders, which stopped being right past a hundred of them.
 */
export function useOrderCount(locationId: string | undefined, range: CallRange) {
  const { api, activeTenantId } = useAuth();
  const q = callQuery(range);
  return useQuery({
    queryKey: ['orders', 'count', activeTenantId, locationId, q],
    enabled: !!locationId,
    refetchInterval: 15_000,
    queryFn: () => api<{ count: number }>(`/v1/locations/${locationId}/orders/count${q}`),
  });
}

/** Whether the restaurant's texts are arriving (last week), from the provider's delivery reports. */
export interface TextHealth {
  windowDays: number;
  sent: number;
  delivered: number;
  notDelivered: number;
  latest: { at: string; delivered: boolean; notDelivered: boolean; errorCode: string | null; reason: string | null } | null;
}

/** Whether this location's alert texts are on — consent recorded and confirmed. */
export function useSmsConsentState(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['sms-consent', locationId, activeTenantId],
    enabled: !!locationId,
    refetchInterval: 60_000,
    queryFn: () =>
      api<{ state: 'none' | 'pending' | 'on' | 'off'; phone: string | null; smsConfigured: boolean }>(
        `/v1/locations/${locationId}/sms-consent`,
      ),
  });
}

export function useTextHealth(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['text-health', activeTenantId, locationId],
    enabled: !!locationId,
    refetchInterval: 60_000,
    queryFn: () => api<TextHealth>(`/v1/locations/${locationId}/text-health`),
  });
}

export interface OrderPage {
  orders: Order[];
  nextCursor: string | null;
}

/** Completed and canceled orders, newest first, a page at a time as the user asks for more. */
export function useDoneOrders(locationId: string | undefined, opts: { enabled: boolean }) {
  const { api, activeTenantId } = useAuth();
  return useInfiniteQuery({
    queryKey: ['orders', 'done', activeTenantId, locationId],
    enabled: !!locationId && opts.enabled,
    // Slower than the open list: an order lands here by someone pressing
    // Complete on this screen, which refreshes it anyway.
    refetchInterval: 60_000,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<OrderPage>(
        `/v1/locations/${locationId}/orders?status=closed&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** A message a caller left for the restaurant. */
export interface CallMessage {
  id: string;
  callId?: string | null;
  callerName?: string | null;
  callbackNumber?: string | null;
  body: string;
  status: 'new' | 'done';
  /** When the restaurant was texted about it; null if that did not happen. */
  notifiedAt?: string | null;
  createdAt: string;
  doneAt?: string | null;
}

export interface CallMessagePage {
  messages: CallMessage[];
  /** How many are still new, whatever filter was asked for. */
  newCount: number;
}

/** Messages callers left, newest first. Polls so one taken mid-shift shows up. */
export function useMessages(locationId: string | undefined, status: 'new' | 'done' | 'all' = 'new') {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['messages', activeTenantId, locationId, status],
    enabled: !!locationId,
    refetchInterval: 15_000,
    queryFn: () => api<CallMessagePage>(`/v1/locations/${locationId}/messages?status=${status}`),
  });
}

export interface PosIntegration {
  provider: string;
  enabled: boolean;
  configured: boolean;
  environment?: string;
  externalLocationId?: string | null;
  /** Whether a token is on file — the token itself is never sent to the browser. */
  hasAccessToken?: boolean;
  capabilities?: {
    createOrder: boolean;
    updateOrderStatus: boolean;
    getMenu: boolean;
    syncMenu: boolean;
  } | null;
  updatedAt?: string;
}

/** The location's POS connection. */
export function usePosIntegration(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['pos-integration', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<PosIntegration>(`/v1/locations/${locationId}/pos`),
  });
}

export type BillingPlanId = 'starter' | 'growth' | 'pro';

export interface PlanDefinition {
  plan: BillingPlanId;
  name: string;
  monthlyCents: number;
  summary: string;
  entitlements: string[];
  includedCalls: number;
}

export interface LocationBilling {
  plan: BillingPlanId | null;
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  entitlements: string[];
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Whether Stripe is configured at all — the UI only offers buttons that work. */
  billingAvailable: boolean;
  hasCustomer: boolean;
  /** Whether plan tiers actually gate features yet. */
  enforced: boolean;
  plans: PlanDefinition[];
  usage: { calls: number; aiMinutes: number; since: string; includedCalls: number | null };
  /**
   * Where access comes from: a paid plan, the account's free trial (Pro), a
   * lapsed trial, or an account from before trials.
   */
  source: 'subscription' | 'trial' | 'trial_expired' | 'unrestricted';
  /** False once a trial has lapsed with no paid plan — Brayz is not answering this location. */
  inService: boolean;
  trial: TrialInfo | null;
}

export interface TrialInfo {
  startedAt: string | null;
  endsAt: string;
  active: boolean;
  daysLeft: number;
}

export interface TenantTrial {
  trial: TrialInfo | null;
  /** Any location pays — the trial no longer matters. */
  converted: boolean;
  plan: BillingPlanId;
  trialDays: number;
}

/** The account's free trial, for the banner on every screen. */
export function useTenantTrial() {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['trial', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<TenantTrial>(`/v1/tenants/${activeTenantId}/trial`),
    staleTime: 60_000,
  });
}

/** The location's subscription, plan catalog, and usage this period. */
export function useBilling(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['billing', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<LocationBilling>(`/v1/locations/${locationId}/billing`),
  });
}

export interface PhoneNumber {
  id: string;
  e164Number: string;
  provider: string;
  inboundRouteType: string;
  active: boolean;
}

export interface AvailableNumber {
  e164Number: string;
  friendlyName: string;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
}

/** Phone numbers provisioned to a location. */
export function usePhoneNumbers(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['phone-numbers', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<PhoneNumber[]>(`/v1/locations/${locationId}/phone-numbers`),
  });
}

export function useMenu(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['menu', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<MenuTree>(`/v1/locations/${locationId}/menu`),
  });
}

/** Asked for, not sold. Aggregated by the API, most-asked first. */
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
  // Build mode: names, not ids, because the thing does not exist yet. An
  // unpriced item is created hidden until the owner prices it.
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

export interface MenuFixGroup {
  name: string;
  selectionType: 'single' | 'multi';
  required: boolean;
  maxSelections?: number;
  allowsHalves?: boolean;
  modifiers: Array<{ name: string; priceCents: number }>;
}

export interface AssistantProposal {
  id: string;
  summary: string;
  reason: string;
  fix: MenuHealthFix;
}

export interface AssistantReply {
  reply: string;
  proposals: AssistantProposal[];
  toolsUsed: string[];
}

export interface MenuHealthFinding {
  id: string;
  code: string;
  severity: 'fix' | 'warn' | 'info';
  itemId?: string;
  itemName?: string;
  groupId?: string;
  title: string;
  detail: string;
  evidence: { count?: number; lastAt?: string; samples?: string[] };
  fix?: MenuHealthFix;
}

/** What about the menu will trip the bot up, with the edit that fixes each. */
export function useMenuHealth(locationId: string | undefined, days = 30) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['menu-health', activeTenantId, locationId, days],
    enabled: !!locationId,
    queryFn: () =>
      api<{ generatedAt: string; days: number; findings: MenuHealthFinding[] }>(
        `/v1/locations/${locationId}/menu-health?days=${days}`,
      ),
  });
}

/** A menu template as the picker shows it: what applying it would create. */
export interface MenuTemplateSummary {
  id: string;
  name: string;
  description: string;
  categories: Array<{ name: string; items: Array<{ name: string; groups: string[] }> }>;
  groups: Array<{ name: string; selectionType: 'single' | 'multi'; required: boolean; options: number }>;
}

export function useMenuTemplates() {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['menu-templates', activeTenantId],
    enabled: !!activeTenantId,
    staleTime: Infinity,
    queryFn: () => api<{ templates: MenuTemplateSummary[] }>('/v1/menu-templates').then((r) => r.templates),
  });
}

export function useMenuGaps(locationId: string | undefined, days = 30) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['menu-gaps', activeTenantId, locationId, days],
    enabled: !!locationId,
    queryFn: () => api<MenuGap[]>(`/v1/locations/${locationId}/menu-gaps?days=${days}`),
  });
}

export interface Guest {
  id: string;
  displayName?: string | null;
  memoryEnabled: boolean;
  notes?: string | null;
  phones: string[];
  orderCount: number;
  lastOrderAt?: string | null;
  createdAt: string;
}
export interface GuestDetail {
  id: string;
  displayName?: string | null;
  memoryEnabled: boolean;
  notes?: string | null;
  phones: string[];
  createdAt: string;
  orders: Order[];
  birthdayMonth?: number | null;
  birthdayDay?: number | null;
  /** Where their last delivery went; offered back on their next call. */
  deliveryAddress?: DeliveryAddressView | null;
  deliveryAddressUpdatedAt?: string | null;
  vip?: boolean;
  loyalty?: {
    pointsBalance: number;
    lifetimePoints: number;
    lifetimeSpendCents: number;
  } | null;
}

/** Guest profiles for a location (newest activity first). */
export function useGuests(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['guests', activeTenantId, locationId],
    enabled: !!locationId,
    refetchInterval: 30_000,
    queryFn: () => api<Guest[]>(`/v1/locations/${locationId}/guests`),
  });
}

/** One guest's full profile + order history. */
export function useGuest(id: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['guest', activeTenantId, id],
    enabled: !!id,
    queryFn: () => api<GuestDetail>(`/v1/guests/${id}`),
  });
}

export interface LoyaltySettings {
  enabled: boolean;
  pointsPerDollar: number;
  rewardPoints: number;
  rewardCents: number;
  vipEnabled: boolean;
  vipSpendCents: number;
  vipPointsMultiplier: number;
  birthdayEnabled: boolean;
  birthdayBonusPoints: number;
  winbackEnabled: boolean;
  winbackDays: number;
  winbackBonusPoints: number;
}

export type PromotionKind = 'percent_off' | 'amount_off';
export type PromotionAudience = 'all' | 'vip' | 'lapsed' | 'birthday';

export interface Promotion {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  kind: PromotionKind;
  percentOff: number | null;
  amountOffCents: number | null;
  minSubtotalCents: number;
  audience: PromotionAudience;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  maxPerGuest: number;
  active: boolean;
  /** Worded by the API — the dashboard never derives this. */
  offer: string;
  redemptionCount: number;
}

/** Offers configured for a location, active ones first. */
export function usePromotions(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['promotions', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<Promotion[]>(`/v1/locations/${locationId}/promotions`),
  });
}

export interface LoyaltyStats {
  enabled: boolean;
  members: number;
  vipCount: number;
  pointsOutstanding: number;
  last30Days: {
    pointsEarned: number;
    redemptions: number;
    pointsRedeemed: number;
    birthdayBonuses: number;
    winbackBonuses: number;
    discountCents: number;
    upsellItems: number;
    upsellRevenueCents: number;
  };
}

/** Loyalty program analytics for a location (members, balances, 30-day activity). */
export function useLoyaltyStats(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['loyalty-stats', activeTenantId, locationId],
    enabled: !!locationId,
    refetchInterval: 60_000,
    queryFn: () => api<LoyaltyStats>(`/v1/locations/${locationId}/loyalty-stats`),
  });
}

/** Per-location loyalty program config (defaults to disabled). */
export function useLoyaltySettings(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['loyalty-settings', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<LoyaltySettings>(`/v1/locations/${locationId}/loyalty-settings`),
  });
}

export interface StaffVoiceProfileRow {
  id: string;
  label: string;
  status: 'pending' | 'ready' | 'revoked';
  /** clone = a real person's voice (consent-gated); provider = a catalog voice given to this persona. */
  source: 'clone' | 'provider';
  provider?: string | null;
  /** Set for catalog voices so they can be previewed; a clone's vendor id is not sent. */
  providerVoiceId?: string | null;
  enabledForRotation: boolean;
}
export interface StaffMember {
  id: string;
  name: string;
  role?: string | null;
  active: boolean;
  createdAt: string;
  consent: { action: 'granted' | 'revoked'; source: string; at: string } | null;
  voiceProfiles: StaffVoiceProfileRow[];
}

/** Staff profiles + consent + voice personas for a location. */
export function useStaff(locationId: string | undefined) {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['staff', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<StaffMember[]>(`/v1/locations/${locationId}/staff`),
  });
}

export const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const parseMoney = (dollars: string) => Math.round(parseFloat(dollars || '0') * 100);

/* ---------------------------------------------------------------------------
 * Support — the customer's side. A restaurant asking Brayz for help.
 * ------------------------------------------------------------------------- */

export interface SupportRequest {
  id: string;
  subject: string;
  body: string;
  severity: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'resolved';
  staffReply?: string | null;
  repliedAt?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  locationId?: string | null;
  locationName?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
}

export function useSupportRequests() {
  const { api, activeTenantId } = useAuth();
  return useQuery({
    queryKey: ['support-requests', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<{ requests: SupportRequest[] }>('/v1/support-requests'),
  });
}

/* ---------------------------------------------------------------------------
 * Admin — the Brayz staff portal. Every one of these hits a route that
 * re-checks the platform role server-side; `enabled` here only avoids a
 * pointless 403 for a customer.
 * ------------------------------------------------------------------------- */

export interface AdminOverview {
  customers: { total: number };
  locations: { total: number; subscribed: number };
  users: { total: number };
  calls: { today: number; last7Days: number; last30Days: number; total: number };
  revenue: {
    mrrCents: number;
    byPlan: Record<string, { locations: number; mrrCents: number }>;
    byStatus: Record<string, number>;
  };
  support: { open: number; inProgress: number };
}

export function useAdminOverview() {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'overview'],
    enabled: !!platformRole,
    queryFn: () => api<AdminOverview>('/v1/admin/overview'),
  });
}

export type NodeHealthState = 'healthy' | 'degraded' | 'draining' | 'down';

/** The node's latest self-report; any metric it does not export is null. */
export interface NodeHealthSnapshot {
  version?: string | null;
  serviceActive: boolean;
  live: boolean;
  ready: boolean;
  uptimeSeconds?: number | null;
  dialogsActive?: number | null;
  rtpPortPairsAllocated?: number | null;
  rtpPortPairsCapacity?: number | null;
  hepCollectorUp?: boolean | null;
  webhookSpoolDepth?: number | null;
  recordingSpoolDepth?: number | null;
  load1?: number | null;
  cpus?: number | null;
  memUsedPct?: number | null;
  diskUsedPct?: number | null;
}

export interface AdminNodeHealth {
  state: NodeHealthState;
  reasons: string[];
  lastHeartbeatAt: string;
  reportedActiveCalls: number;
  snapshot: NodeHealthSnapshot | null;
}

export interface AdminLiveNode {
  /** The SiphonAI node, or null for calls that never said which one. */
  nodeId: string | null;
  active: number;
  last24Hours: number;
  lastCallAt: string | null;
  /** Null for a node that has never sent a heartbeat. */
  health: AdminNodeHealth | null;
}

export interface AdminLiveCalls {
  asOf: string;
  active: number;
  /** Rows still open past the window: counted separately, never as live. */
  stale: number;
  activeWindowMinutes: number;
  nodes: AdminLiveNode[];
}

/** Calls in progress right now, per SiphonAI node. Polled: it is the live number. */
export function useAdminLiveCalls() {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'calls', 'live'],
    enabled: !!platformRole,
    queryFn: () => api<AdminLiveCalls>('/v1/admin/calls/live'),
    refetchInterval: 5_000,
  });
}

export type HistogramBucket = 'hour' | 'day' | 'week' | 'month';

/** What Brayz did for one restaurant over a window — the Insights screen's whole payload. */
export interface Insights {
  window: { from: string; to: string; tz: string; bucket: HistogramBucket };
  calls: {
    answered: number;
    /** Answered outside opening hours, or while another call was already live. */
    wouldHaveRungOut: number;
    afterHours: number;
    whileAnotherCallWasLive: number;
    /** False when the location has no opening hours saved, which makes "after hours" meaningless. */
    hoursKnown: boolean;
  };
  orders: {
    count: number;
    revenueCents: number;
    averageCents: number;
    deliveryFeeCents: number;
    byFulfillment: Array<{ type: string; count: number; revenueCents: number }>;
    discountCents: number;
  };
  upsell: { items: number; revenueCents: number };
  loyalty: {
    pointsEarned: number;
    redemptions: number;
    pointsRedeemed: number;
    birthdayBonuses: number;
    winbackBonuses: number;
  };
  guests: {
    ordering: number;
    returning: number;
    new: number;
    top: Array<{
      id: string | null;
      name: string | null;
      orders: number;
      spentCents: number;
      lifetimeSpendCents: number;
    }>;
  };
  items: Array<{
    name: string;
    quantity: number;
    /**
     * What was chosen on it, kept apart by the menu group it came from — a
     * sauce and a dip are two questions, not one list. Biggest first, and
     * options the menu could not place are grouped as "Other".
     */
    optionGroups: Array<{ name: string; options: Array<{ name: string; quantity: number }> }>;
  }>;
  /** Gap-free; `start` is local wall-clock time, YYYY-MM-DDTHH:mm. */
  series: Array<{ start: string; calls: number; orders: number; revenueCents: number }>;
}

/** One menu item and how much of it went out — including none. */
export interface MenuItemInsight {
  menuItemId: string;
  name: string;
  category: string;
  categoryOrder: number;
  /** Today's menu price. Revenue below is what was actually charged. */
  priceCents: number;
  available: boolean;
  quantity: number;
  orderLines: number;
  revenueCents: number;
  /** Over all time, not just this window: "0 this month" and "never" are different facts. */
  lastOrderedAt: string | null;
  /** Every option chosen on it, in the group the menu asks it in. Uncapped here. */
  optionGroups: Array<{ name: string; options: Array<{ name: string; quantity: number }> }>;
}

/**
 * The two spreadsheets behind the menu view: one row per item, one row per
 * option chosen on it. Two files, because an item's quantity and a topping's
 * quantity are different things and must not sum in the same column.
 */
export function menuExportPath(
  locationId: string,
  what: 'items' | 'item-options',
  span: { from: Date; to: Date },
  tz: string,
): string {
  const q = new URLSearchParams({ from: span.from.toISOString(), to: span.to.toISOString(), tz });
  return `/v1/locations/${locationId}/insights/${what}.csv?${q}`;
}

export interface InsightsItems {
  window: { from: string; to: string; tz: string };
  items: MenuItemInsight[];
  /** Sold in the window but not on the menu now — deleted items, or lines the menu could not price. */
  offMenu: Array<{ name: string; quantity: number; orderLines: number; revenueCents: number }>;
  totals: {
    onMenu: number;
    unsoldInWindow: number;
    neverOrdered: number;
    quantity: number;
    revenueCents: number;
  };
}

/** Every item on the menu, with what it sold — the "what does not sell" view. */
export function useInsightsItems(
  locationId: string | undefined,
  params: { from: Date; to: Date; tz: string },
) {
  const { api, activeTenantId } = useAuth();
  const from = params.from.toISOString();
  const to = params.to.toISOString();
  return useQuery({
    queryKey: ['insights', 'items', activeTenantId, locationId, from, to, params.tz],
    enabled: !!locationId,
    queryFn: () =>
      api<InsightsItems>(
        `/v1/locations/${locationId}/insights/items?${new URLSearchParams({ from, to, tz: params.tz })}`,
      ),
    placeholderData: (previous) => previous,
  });
}

export function useInsights(
  locationId: string | undefined,
  params: { bucket: HistogramBucket; from: Date; to: Date; tz: string },
) {
  const { api, activeTenantId } = useAuth();
  const from = params.from.toISOString();
  const to = params.to.toISOString();
  return useQuery({
    queryKey: ['insights', activeTenantId, locationId, params.bucket, from, to, params.tz],
    enabled: !!locationId,
    queryFn: () =>
      api<Insights>(
        `/v1/locations/${locationId}/insights?${new URLSearchParams({
          bucket: params.bucket,
          from,
          to,
          tz: params.tz,
        })}`,
      ),
    // Keep the frame: the last numbers stay up (dimmed) while the next range loads.
    placeholderData: (previous) => previous,
  });
}

export interface AdminCallHistogram {
  bucket: HistogramBucket;
  tz: string;
  from: string;
  to: string;
  total: number;
  /** One per bucket, gap-free; `start` is local wall-clock time, YYYY-MM-DDTHH:mm. */
  points: Array<{ start: string; calls: number }>;
}

export function useAdminCallHistogram(params: {
  bucket: HistogramBucket;
  from: Date;
  to: Date;
  tz: string;
}) {
  const { api, platformRole } = useAuth();
  const from = params.from.toISOString();
  const to = params.to.toISOString();
  return useQuery({
    queryKey: ['admin', 'calls', 'histogram', params.bucket, from, to, params.tz],
    enabled: !!platformRole,
    queryFn: () =>
      api<AdminCallHistogram>(
        `/v1/admin/calls/histogram?${new URLSearchParams({ bucket: params.bucket, from, to, tz: params.tz })}`,
      ),
    // Keep the frame: the last chart stays up (dimmed) while the next range loads.
    placeholderData: (previous) => previous,
  });
}

/** `ending` is an active trial with a week or less left. */
export type AdminTrialState = 'active' | 'ending' | 'expired' | 'converted';
export type AdminTrialFilter = AdminTrialState | 'all';

export interface AdminTrial {
  tenantId: string;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  startedAt: string;
  endsAt: string;
  daysLeft: number;
  daysTotal: number;
  daysUsed: number;
  state: AdminTrialState;
  extensions: number;
  setup: {
    locations: number;
    numbersLive: number;
    menuItems: number;
    firstCallAt: string | null;
    firstOrderAt: string | null;
  };
  usage: { callsDuringTrial: number; ordersDuringTrial: number; callsSinceEnded: number };
}

export interface AdminTrials {
  trials: AdminTrial[];
  counts: Record<AdminTrialState, number>;
  trialDays: number;
}

/** Every account's free trial and how it is going. */
export function useAdminTrials(filter: AdminTrialFilter) {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'trials', filter],
    enabled: !!platformRole,
    queryFn: () => api<AdminTrials>(`/v1/admin/trials?state=${filter}`),
    placeholderData: (previous) => previous,
  });
}

export interface AdminCustomer {
  tenantId: string;
  name: string;
  createdAt: string;
  locationCount: number;
  contactEmail: string | null;
  contactName: string | null;
  mainPhone: string | null;
  city: string | null;
  region: string | null;
  calls30d: number;
  openSupport: number;
  plans: string[];
  subscribedLocations: number;
}

export function useAdminCustomers(q: string) {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'customers', q],
    enabled: !!platformRole,
    queryFn: () =>
      api<{ customers: AdminCustomer[] }>(
        `/v1/admin/customers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
  });
}

export interface AdminCustomerDetail {
  tenantId: string;
  name: string;
  createdAt: string;
  calls: { today: number; last30Days: number; total: number };
  mrrCents: number;
  members: Array<{ userId: string; email: string; displayName: string | null; role: string; since: string }>;
  locations: Array<{
    id: string;
    name: string;
    timezone: string;
    mainPhone: string | null;
    address: string | null;
    createdAt: string;
    calls30d: number;
    plan: string | null;
    subscriptionStatus: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
  supportRequests: Array<{
    id: string;
    subject: string;
    severity: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  /** Null for an account from before trials. History is newest first, from the staff audit trail. */
  trial:
    | (TrialInfo & {
        history: Array<{
          at: string;
          actorEmail: string | null;
          action: 'admin.trial.extended' | 'admin.trial.granted';
          from: string | null;
          to: string;
          days: number | null;
          reason: string;
        }>;
      })
    | null;
}

export function useAdminCustomer(tenantId: string | undefined) {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'customer', tenantId],
    enabled: !!platformRole && !!tenantId,
    queryFn: () => api<AdminCustomerDetail>(`/v1/admin/customers/${tenantId}`),
  });
}

export interface AdminSupportRequest extends SupportRequest {
  tenantId: string;
  tenantName: string;
  locationPhone?: string | null;
}

export function useAdminSupportRequests(status: string) {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'support', status],
    enabled: !!platformRole,
    queryFn: () =>
      api<{ requests: AdminSupportRequest[] }>(`/v1/admin/support-requests?status=${status}`),
  });
}

export interface PlatformStaff {
  id: string;
  email: string;
  displayName: string | null;
  platformRole: string;
  createdAt: string;
}

export function useAdminStaff() {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'staff'],
    enabled: !!platformRole,
    queryFn: () => api<{ staff: PlatformStaff[] }>('/v1/admin/staff'),
  });
}

export interface PlatformAuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function useAdminAudit(enabled: boolean) {
  const { api, platformRole } = useAuth();
  return useQuery({
    queryKey: ['admin', 'audit'],
    enabled: enabled && platformRole === 'admin',
    queryFn: () => api<{ entries: PlatformAuditEntry[] }>('/v1/admin/audit'),
  });
}
