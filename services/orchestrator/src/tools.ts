/**
 * Tool executor: runs the receptionist tools against the internal API (rule #5)
 * and returns short, speakable result strings for the LLM. The API resolves
 * tenant/location from the callId and owns pricing/menu truth — the LLM never
 * computes prices or invents items; it only relays these results.
 *
 * transfer_call is handled by the engine itself (it sends a transfer control),
 * so it never reaches here.
 */
import type { LlmToolCall } from '@brayz/ai';
import type { DeliveryAddress, EligiblePromotion, UpsellSuggestion } from '@brayz/shared';
import type {
  CallVoice,
  ConversationContext,
  DeliveryCheck,
  GuestInfo,
  SavedAddressCheck,
  MenuItemInfo,
  OrderLine,
  OrderRefusal,
  ToolExecutor,
  TransferTarget,
} from './conversation.js';

type FetchLike = typeof fetch;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function createApiToolExecutor(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): ToolExecutor {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  const base = (callId: string) => `${baseUrl}/v1/calls/${encodeURIComponent(callId)}/tools`;

  async function getJson(url: string): Promise<unknown> {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`tool request failed: ${res.status}`);
    return res.json();
  }

  return async (call: LlmToolCall, ctx: ConversationContext): Promise<string> => {
    const { callId } = ctx;
    try {
      switch (call.name) {
        case 'lookup_restaurant_profile': {
          const loc = (await getJson(`${base(callId)}/profile`)) as ProfileResult;
          return formatProfile(loc);
        }
        case 'lookup_hours': {
          const { hours } = (await getJson(`${base(callId)}/hours`)) as { hours: HoursRow[] };
          return formatHours(hours);
        }
        case 'lookup_menu': {
          const q = typeof call.arguments.query === 'string' ? call.arguments.query : '';
          const { items } = (await getJson(
            `${base(callId)}/menu?q=${encodeURIComponent(q)}`,
          )) as { items: MenuRow[] };
          return formatMenu(items);
        }
        case 'take_message': {
          const message = typeof call.arguments.message === 'string' ? call.arguments.message.trim() : '';
          if (!message) return 'No message was given. Ask the caller what they would like to pass on.';
          const str = (k: string) => (typeof call.arguments[k] === 'string' ? (call.arguments[k] as string).trim() : '');
          // The API fills the callback number from the call itself when the
          // caller gave none, and texts the restaurant. The reply here is what
          // the bot may promise: that it was taken, not when anyone will call.
          const res = await fetchImpl(`${base(callId)}/message`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              message,
              ...(str('caller_name') ? { callerName: str('caller_name') } : {}),
              ...(str('callback_number') ? { callbackNumber: str('callback_number') } : {}),
            }),
          });
          if (!res.ok) throw new Error(`message failed: ${res.status}`);
          const { callbackNumber } = (await res.json()) as { callbackNumber?: string | null };
          return callbackNumber
            ? `Message taken for the restaurant; they will call back at ${callbackNumber}. Tell the caller it has been passed on.`
            : 'Message taken for the restaurant. Tell the caller it has been passed on.';
        }
        case 'recall_guest': {
          const res = await fetchImpl(`${base(callId)}/guest/details`, { headers });
          // The API withholds details when memory is off or the guest opted out.
          if (res.status === 403) return 'I can’t pull up saved details; please confirm who’s calling.';
          if (!res.ok) throw new Error(`guest details failed: ${res.status}`);
          return formatGuestDetails((await res.json()) as GuestDetails);
        }
        case 'check_loyalty': {
          const res = await fetchImpl(`${base(callId)}/loyalty`, { headers });
          // The API withholds status when memory is off or the guest opted out.
          if (res.status === 403)
            return 'I can’t pull up loyalty details; please confirm who’s calling.';
          if (!res.ok) throw new Error(`loyalty failed: ${res.status}`);
          return formatLoyalty((await res.json()) as LoyaltyStatus);
        }
        case 'check_promotions': {
          const res = await fetchImpl(`${base(callId)}/promotions`, { headers });
          if (!res.ok) throw new Error(`promotions failed: ${res.status}`);
          const { promotions } = (await res.json()) as { promotions: EligiblePromotion[] };
          return formatPromotions(promotions);
        }
        case 'save_guest_memory': {
          const name = typeof call.arguments.name === 'string' ? call.arguments.name.trim() : '';
          const note = typeof call.arguments.note === 'string' ? call.arguments.note.trim() : '';
          const birthdayMonth =
            typeof call.arguments.birthday_month === 'number' ? call.arguments.birthday_month : undefined;
          const birthdayDay =
            typeof call.arguments.birthday_day === 'number' ? call.arguments.birthday_day : undefined;
          if (!name && !note && !birthdayMonth) return 'Nothing to remember was provided.';
          const res = await fetchImpl(`${base(callId)}/guest/memory`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: name || undefined,
              note: note || undefined,
              birthdayMonth,
              birthdayDay,
            }),
          });
          if (!res.ok) throw new Error(`save memory failed: ${res.status}`);
          const out = (await res.json()) as { saved?: boolean };
          return out.saved ? 'Got it, I’ll remember that.' : 'Okay.';
        }
        default:
          return `Unknown tool: ${call.name}.`;
      }
    } catch (err) {
      log.warn({ err, tool: call.name, callId }, 'tool execution failed');
      return 'That information is not available right now.';
    }
  };
}

/** Loads the call location's transfer destinations (already resolved to REFER URIs). */
export function createTransferTargetLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<TransferTarget[]> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/transfer-targets`,
        { headers },
      );
      if (!res.ok) throw new Error(`transfer-targets request failed: ${res.status}`);
      const data = (await res.json()) as { targets?: TransferTarget[] };
      return data.targets ?? [];
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadTransferTargets failed');
      return [];
    }
  };
}

export interface LocationProfile {
  name?: string;
  /** The owner's opening line chosen for this call, if they wrote any; spoken verbatim ({staff_name} filled here). */
  greeting?: string | null;
  /** The welcome-back line chosen for this call ({guest_name} filled here once the guest gate allows a name). */
  welcomeBack?: string | null;
  timezone?: string;
  city?: string;
  region?: string;
  /** Who phrases "added that": the engine (fast) or the model (natural). */
  orderAckMode?: 'fast' | 'natural';
  /** Which ways this location hands an order over, and what it quotes for each. */
  pickupEnabled?: boolean;
  deliveryEnabled?: boolean;
  pickupEtaMinutes?: number;
  deliveryEtaMinutes?: number;
  /** For the read-back only — the API charges the fee and enforces the minimum (rule #5). */
  deliveryFeeCents?: number;
  deliveryMinimumCents?: number;
  /** Is the restaurant open at this moment, and does it have hours to say so by? */
  openNow?: boolean;
  hoursKnown?: boolean;
  /** The owner asked for closed callers to be told, and the doors are shut now. */
  announceClosed?: boolean;
  /** Today's hours and the next opening, phrased by the API — it knows the timezone. */
  hoursToday?: string | null;
  nextOpen?: { at: string; spoken: string } | null;
  /** Whether this location takes orders for a later time, and how far ahead. */
  scheduling?: { enabled: boolean; maxDaysAhead: number; leadMinutes: number; today?: string | null };
  /** Does this location want a message taken when it is shut? */
  offerMessageWhenClosed?: boolean;
  /** Offer this caller a text when their order is ready (setting on, caller ID textable, not already agreed). */
  guestOrderTexts?: { offer: boolean };
}

/** What the API said about a time the caller asked for. */
export type ScheduleAnswer =
  | { ok: true; scheduledFor: string; spoken: string }
  | {
      ok: false;
      reason: string;
      earliest: { at: string; spoken: string } | null;
      /** too_far only: the same time on the last day the location takes orders for. */
      latest?: { at: string; spoken: string } | null;
      hoursToday?: string | null;
    };

/**
 * Asks the API whether the order can be made for the time the caller asked
 * for. The API decides — it holds the hours, the timezone and the kitchen's
 * lead time (rule #5) — and the order route checks again at placing. Null when
 * it could not be asked at all.
 */
export function createScheduler(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, request: { time: string; day?: string }) => Promise<ScheduleAnswer | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, request) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/schedule`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(`schedule request failed: ${res.status}`);
      return (await res.json()) as ScheduleAnswer;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'scheduleOrder failed');
      return null;
    }
  };
}

/**
 * Records that the caller said yes to a text when their order is ready. The API
 * writes the consent (with the disclosure it regenerates) and sends the
 * confirmation text. False when it could not be recorded.
 */
export function createOrderTextConsent(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, consent: { orderCode: string; callerWords?: string }) => Promise<boolean> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, consent) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/order-texts/consent`, {
        method: 'POST',
        headers,
        body: JSON.stringify(consent),
      });
      if (!res.ok) throw new Error(`order text consent failed: ${res.status}`);
      return true;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'recordOrderTextConsent failed');
      return false;
    }
  };
}

/** Loads the call location's profile so the bot knows whose phone it answered. */
export function createProfileLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<LocationProfile | null> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/profile`,
        { headers },
      );
      if (!res.ok) throw new Error(`profile request failed: ${res.status}`);
      return (await res.json()) as LocationProfile;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadProfile failed');
      return null;
    }
  };
}

/** An order the caller placed earlier, as the API is willing to describe it. */
export type RecentOrder =
  | { found: false; reason: string; status?: string }
  | { found: true; needsCode: true; attemptsLeft: number }
  | {
      found: true;
      needsCode: false;
      orderId: string;
      orderCode: string;
      placedAt: string;
      fulfillmentType: string;
      scheduledFor: string | null;
      customerName: string | null;
      subtotalCents: number;
      deliveryFeeCents: number;
      totalCents: number;
      items: Array<{
        menuItemId: string | null;
        name: string;
        quantity: number;
        unitPriceCents: number;
        specialInstructions: string | null;
        modifiers: Array<{ modifierId: string | null; name: string; priceCents: number; portion: string }>;
      }>;
      posTicket: boolean;
    };

/**
 * The caller's own most recent order at this location, if it can still be
 * changed. The API decides all of that — whose order it is, whether the
 * kitchen has taken it, and whether this caller may be told about it at all
 * (rule #6). Null when it could not be asked.
 */
export function createRecentOrderLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<RecentOrder | null> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/order/recent`, {
        headers,
      });
      if (!res.ok) throw new Error(`recent order request failed: ${res.status}`);
      return (await res.json()) as RecentOrder;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadRecentOrder failed');
      return null;
    }
  };
}

/** Confirm mode: the caller reads the confirmation code back before we say a word about the order. */
export function createOrderConfirmer(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (
  ctx: ConversationContext,
  code: string,
) => Promise<({ confirmed: boolean; reason?: string; attemptsLeft?: number } & Partial<RecentOrder>) | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, code) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/order/recent/confirm`,
        { method: 'POST', headers, body: JSON.stringify({ code }) },
      );
      if (!res.ok) throw new Error(`order confirm failed: ${res.status}`);
      return (await res.json()) as { confirmed: boolean; reason?: string; attemptsLeft?: number };
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'confirmOrder failed');
      return null;
    }
  };
}

/**
 * Save the changed order: every line it should have now, re-priced by the API
 * (rule #5). A refusal comes back with its reason so the bot can say what is
 * actually true — "the kitchen already has it", "that would put it under the
 * delivery minimum".
 */
export function createOrderChanger(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (
  ctx: ConversationContext,
  orderId: string,
  lines: OrderLine[],
) => Promise<
  | { ok: true; orderCode: string; totalCents: number; posTicket: boolean }
  | { ok: false; code: string; message: string }
  | null
> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, orderId, lines) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/order/${encodeURIComponent(orderId)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            items: lines.map((l) => ({
              menuItemId: l.menuItemId,
              name: l.name,
              quantity: l.quantity,
              specialInstructions: l.specialInstructions,
              modifiers: l.modifiers?.length
                ? l.modifiers.map((m) => ({ id: m.id, portion: m.portion ?? 'whole' }))
                : undefined,
              viaUpsell: l.viaUpsell,
            })),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        orderCode?: string;
        totalCents?: number;
        posTicket?: boolean;
        error?: { code?: string; message?: string };
      };
      if (!res.ok) {
        return {
          ok: false as const,
          code: data.error?.code ?? String(res.status),
          message: data.error?.message ?? 'The order could not be changed.',
        };
      }
      if (!data.orderCode || typeof data.totalCents !== 'number') throw new Error('bad change response');
      return {
        ok: true as const,
        orderCode: data.orderCode,
        totalCents: data.totalCents,
        posTicket: data.posTicket === true,
      };
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'changeOrder failed');
      return null;
    }
  };
}

/** Cancel it outright, while the kitchen still has not taken it. */
export function createOrderCanceller(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (
  ctx: ConversationContext,
  orderId: string,
) => Promise<{ ok: boolean; orderCode?: string; code?: string } | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, orderId) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/order/${encodeURIComponent(orderId)}/cancel`,
        { method: 'POST', headers },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        return { ok: false, code: body.error?.code };
      }
      const data = (await res.json()) as { orderCode?: string };
      return { ok: true, orderCode: data.orderCode };
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'cancelOrder failed');
      return null;
    }
  };
}

/** The staff personas a caller may ask for by name (empty unless the location allows it). */
export function createPersonaLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<string[]> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/personas`, { headers });
      if (!res.ok) throw new Error(`personas request failed: ${res.status}`);
      const data = (await res.json()) as { personas?: Array<{ name: string }> };
      return (data.personas ?? []).map((p) => p.name);
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadPersonas failed');
      return [];
    }
  };
}

/** Hand the call to a persona by name; null when there is no such persona (or switching is off). */
export function createPersonaSwitcher(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, name: string) => Promise<CallVoice | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, name) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/persona`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
      });
      if (res.status === 404 || res.status === 409) return null;
      if (!res.ok) throw new Error(`persona request failed: ${res.status}`);
      const data = (await res.json()) as { voiceId?: string | null; staffName?: string | null };
      return { voiceId: data.voiceId ?? null, staffName: data.staffName ?? null };
    } catch (err) {
      log.warn({ err, callId: ctx.callId, name }, 'switchPersona failed');
      return null;
    }
  };
}

/**
 * Add-ons for the order so far. The API matches the draft against the menu's
 * upsell tags and prices them, so the engine never guesses a pairing.
 */
export function createUpsellLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (
  ctx: ConversationContext,
  lines: Array<{ menuItemId?: string; name: string }>,
) => Promise<UpsellSuggestion[]> {
  const headers = { 'x-brayz-node-secret': nodeSecret, 'content-type': 'application/json' };
  return async (ctx, lines) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/upsell`,
        { method: 'POST', headers, body: JSON.stringify({ lines }) },
      );
      if (!res.ok) throw new Error(`upsell request failed: ${res.status}`);
      const body = (await res.json()) as { suggestions: UpsellSuggestion[] };
      return body.suggestions ?? [];
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadUpsells failed');
      return [];
    }
  };
}

/** Loads the call location's full menu (items + prices) for the up-front prompt. */
export function createMenuLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<MenuItemInfo[]> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/menu`,
        { headers },
      );
      if (!res.ok) throw new Error(`menu request failed: ${res.status}`);
      const data = (await res.json()) as { items?: MenuItemInfo[] };
      return data.items ?? [];
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadMenu failed');
      return [];
    }
  };
}

/** Loads whether the caller is a recognized returning guest (name + memory mode). */
export function createGuestLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<GuestInfo> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  const fallback: GuestInfo = { isReturning: false, mode: 'full' };
  return async (ctx) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/guest`,
        { headers },
      );
      if (!res.ok) throw new Error(`guest request failed: ${res.status}`);
      return (await res.json()) as GuestInfo;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadGuest failed');
      return fallback;
    }
  };
}

/** Loads which voice answers this call (staff persona / rotation, consent-gated
 *  by the API — a revoked voice is never returned). Null → the TTS default. */
export function createVoiceLoader(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext) => Promise<CallVoice | null> {
  const headers = { 'x-brayz-node-secret': nodeSecret };
  return async (ctx) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/voice`,
        { headers },
      );
      if (!res.ok) throw new Error(`voice request failed: ${res.status}`);
      const data = (await res.json()) as { voiceId?: string | null; staffName?: string | null };
      // A name without a voice still matters: the provider default then
      // answers as "Sam" rather than as nobody.
      if (!data.voiceId && !data.staffName) return null;
      return { voiceId: data.voiceId ?? null, staffName: data.staffName ?? null };
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'loadVoice failed');
      return null;
    }
  };
}

/** API refusals a caller can fix by choosing differently. */
const ORDER_OPTION_RULES = new Set(['modifier_required', 'modifier_limit']);

/**
 * Persists a finalized order via the internal API (place_order). Sends the draft
 * lines; the API re-prices each by menuItemId from the location's menu and owns
 * the total (rule #5). Returns the short confirmation code + total, or null.
 */
export function createOrderPlacer(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (
  ctx: ConversationContext,
  lines: OrderLine[],
  opts: {
    customerName?: string;
    redeemReward?: boolean;
    promotionCode?: string;
    fulfillmentType?: 'pickup' | 'delivery';
    deliveryAddress?: DeliveryAddress;
    /** ISO instant the API agreed to in schedule_order, if the caller asked for one. */
    scheduledFor?: string;
  },
) => Promise<{
  orderCode: string;
  totalCents: number;
  discountCents?: number;
  birthdayBonusPoints?: number;
  winbackBonusPoints?: number;
  deliveryFeeCents?: number;
  etaMinutes?: number;
  /** Set when the order is for later: the time as it should be said out loud. */
  scheduledSpoken?: string | null;
} | OrderRefusal | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, lines, opts) => {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/order`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: lines.map((l) => ({
            menuItemId: l.menuItemId,
            name: l.name,
            quantity: l.quantity,
            specialInstructions: l.specialInstructions,
            // Ids and portions only — the API prices each option from the menu
            // (rule #5), by the same half rule the engine used for the readback.
            modifiers: l.modifiers?.length
              ? l.modifiers.map((m) => ({ id: m.id, portion: m.portion ?? 'whole' }))
              : undefined,
            viaUpsell: l.viaUpsell,
          })),
          customerName: opts.customerName,
          redeemReward: opts.redeemReward || undefined,
          promotionCode: opts.promotionCode || undefined,
          fulfillmentType: opts.fulfillmentType,
          deliveryAddress: opts.fulfillmentType === 'delivery' ? opts.deliveryAddress : undefined,
          scheduledFor: opts.scheduledFor,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = body.error?.code;
        // Only the menu's option rules come back to the conversation; every
        // other failure is still "could not submit".
        if (res.status === 422 && code && ORDER_OPTION_RULES.has(code)) {
          return { refused: { code, message: body.error?.message ?? 'An option is missing' } };
        }
        throw new Error(`order request failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        orderCode?: string;
        totalCents?: number;
        discountCents?: number;
        birthdayBonusPoints?: number;
        winbackBonusPoints?: number;
        deliveryFeeCents?: number;
        etaMinutes?: number;
        scheduledSpoken?: string | null;
      };
      if (!data.orderCode || typeof data.totalCents !== 'number') throw new Error('bad order response');
      return {
        orderCode: data.orderCode,
        totalCents: data.totalCents,
        discountCents: data.discountCents,
        birthdayBonusPoints: data.birthdayBonusPoints,
        winbackBonusPoints: data.winbackBonusPoints,
        deliveryFeeCents: data.deliveryFeeCents,
        etaMinutes: data.etaMinutes,
        scheduledSpoken: data.scheduledSpoken ?? null,
      };
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'placeOrder failed');
      return null;
    }
  };
}

/**
 * Asks the API whether an address is inside the delivery area and what
 * delivery costs (set_delivery_address / use_saved_address). The API decides —
 * ZIP list or radius — and the order route checks again at placing. Null when
 * it could not be asked.
 */
export function createDeliveryChecker(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, address: DeliveryAddress) => Promise<DeliveryCheck | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, address) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/delivery/check`,
        { method: 'POST', headers, body: JSON.stringify({ address }) },
      );
      if (!res.ok) throw new Error(`delivery check failed: ${res.status}`);
      return (await res.json()) as DeliveryCheck;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'checkDelivery failed');
      return null;
    }
  };
}

/**
 * Confirm mode: checks the street number a caller gives against their saved
 * delivery address. The address comes back only on a match (rule #6). Memory
 * off or opted out is an answer (not confirmed), not a failure.
 */
export function createSavedAddressConfirmer(
  baseUrl: string,
  nodeSecret: string,
  log: { warn: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, streetNumber: string) => Promise<SavedAddressCheck | null> {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return async (ctx, streetNumber) => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/guest/address/confirm`,
        { method: 'POST', headers, body: JSON.stringify({ streetNumber }) },
      );
      if (res.status === 403) return { confirmed: false, reason: 'unavailable' };
      if (!res.ok) throw new Error(`address confirm failed: ${res.status}`);
      return (await res.json()) as SavedAddressCheck;
    } catch (err) {
      log.warn({ err, callId: ctx.callId }, 'confirmSavedAddress failed');
      return null;
    }
  };
}

interface LoyaltyStatus {
  enabled: boolean;
  enrolled?: boolean;
  pointsBalance?: number;
  rewardAvailable?: boolean;
  rewardPoints?: number;
  rewardCents?: number;
  pointsPerDollar?: number;
  vip?: boolean;
  birthdayBonusAvailable?: boolean;
  birthdayBonusPoints?: number;
  winbackBonusAvailable?: boolean;
  winbackBonusPoints?: number;
}

/**
 * Offers, already worded by the API. Deliberately gives the model no numbers to
 * work with beyond the minimum-spend threshold — it relays these, it does not
 * price them (rule #5).
 */
function formatPromotions(promotions: EligiblePromotion[]): string {
  if (!promotions.length) return 'There are no offers available for this caller right now.';
  return [
    'Offers this caller qualifies for (mention at most one, in these words):',
    ...promotions.map((p) => {
      const min = p.minSubtotalCents
        ? ` on orders over $${(p.minSubtotalCents / 100).toFixed(2)}`
        : '';
      const code = p.code ? ` Code: ${p.code}.` : '';
      return `- ${p.name}: ${p.offer}${min}.${p.description ? ` ${p.description}` : ''}${code}`;
    }),
  ].join('\n');
}

function formatLoyalty(s: LoyaltyStatus): string {
  if (!s.enabled) return 'This restaurant does not have a loyalty program.';
  const parts: string[] = [];
  parts.push(`Points balance: ${s.pointsBalance ?? 0}.`);
  if (s.vip) parts.push('This caller is a VIP regular (earns points at the VIP rate).');
  if (s.rewardAvailable && s.rewardCents) {
    parts.push(
      `A reward is available: $${(s.rewardCents / 100).toFixed(2)} off this order for ${s.rewardPoints} points.`,
    );
  } else if (s.rewardPoints != null) {
    const missing = Math.max(0, s.rewardPoints - (s.pointsBalance ?? 0));
    parts.push(`The next reward unlocks at ${s.rewardPoints} points (${missing} to go).`);
  }
  if (s.birthdayBonusAvailable && s.birthdayBonusPoints) {
    parts.push(
      `It's their birthday month: a ${s.birthdayBonusPoints}-point birthday bonus applies automatically to their next order.`,
    );
  }
  if (s.winbackBonusAvailable && s.winbackBonusPoints) {
    parts.push(
      `They haven't ordered in a while: a ${s.winbackBonusPoints}-point welcome-back bonus applies automatically to this order.`,
    );
  }
  if (s.pointsPerDollar) parts.push(`Callers earn ${s.pointsPerDollar} points per dollar spent.`);
  return parts.join(' ');
}

interface GuestDetails {
  displayName?: string | null;
  notes?: string | null;
  usual?: string[];
  recentOrders?: Array<{ when: string; items: string[] }>;
}

function formatGuestDetails(d: GuestDetails): string {
  const parts: string[] = [];
  if (d.displayName) parts.push(`Name: ${d.displayName}.`);
  if (d.usual?.length) parts.push(`Usual: ${d.usual.join(', ')}.`);
  if (d.notes) parts.push(`Notes: ${d.notes}.`);
  const last = d.recentOrders?.[0];
  if (last?.items?.length) parts.push(`Last order: ${last.items.join(', ')}.`);
  return parts.length ? parts.join(' ') : 'No saved details for this guest yet.';
}

interface ProfileResult {
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  mainPhone?: string | null;
  pickupEnabled?: boolean;
  deliveryEnabled?: boolean;
}
interface HoursRow {
  dayOfWeek: number;
  opensAt: number;
  closesAt: number;
}
interface MenuRow {
  name: string;
  /** The menu section — tells the bot a "Sausage" under Hot Subs is a sandwich. */
  category?: string | null;
  description?: string | null;
  priceCents: number;
  ingredients?: string[] | null;
  modifierGroups?: Array<{
    name: string;
    required?: boolean;
    allowsHalves?: boolean;
    modifiers: Array<{ name: string; priceCents: number }>;
  }> | null;
}

function formatProfile(loc: ProfileResult): string {
  const addr = [loc.addressLine1, loc.addressLine2, loc.city, loc.region, loc.postalCode]
    .filter(Boolean)
    .join(', ');
  const parts = [`${loc.name}.`];
  if (addr) parts.push(`Address: ${addr}.`);
  if (loc.mainPhone) parts.push(`Phone: ${loc.mainPhone}.`);
  parts.push(`Pickup ${loc.pickupEnabled ? 'available' : 'not available'}.`);
  parts.push(`Delivery ${loc.deliveryEnabled ? 'available' : 'not available'}.`);
  return parts.join(' ');
}

function formatHours(hours: HoursRow[]): string {
  const byDay = new Map<number, string[]>();
  for (const h of hours) {
    const list = byDay.get(h.dayOfWeek) ?? [];
    list.push(`${minutesToTime(h.opensAt)} to ${minutesToTime(h.closesAt)}`);
    byDay.set(h.dayOfWeek, list);
  }
  const lines = DAY_NAMES.map((name, day) => {
    const ranges = byDay.get(day);
    return `${name}: ${ranges && ranges.length ? ranges.join(', ') : 'closed'}`;
  });
  return lines.join('. ') + '.';
}

function formatMenu(items: MenuRow[]): string {
  if (!items.length) return 'No matching menu items were found.';
  return items
    .map((i) => {
      const price = `$${(i.priceCents / 100).toFixed(2)}`;
      // The section rides along with every hit: a search for "sausage pizza"
      // returns the sausage sub too, and only the section says which is which.
      const named = i.category ? `${i.name} [${i.category}]` : i.name;
      const base = i.description ? `${named} — ${price} (${i.description})` : `${named} — ${price}`;
      const withIng = i.ingredients?.length
        ? `${base} [ingredients: ${i.ingredients.join(', ')}]`
        : base;
      // A caller asking about an item is often asking what they have to choose,
      // and the answer has to come from the menu rather than the model.
      const opts = (i.modifierGroups ?? [])
        .filter((g) => g.modifiers.length)
        .map((g) => {
          const choices = g.modifiers
            .map((o) => (o.priceCents ? `${o.name} +$${(o.priceCents / 100).toFixed(2)}` : o.name))
            .join(', ');
          const flags = [g.required ? 'required' : '', g.allowsHalves ? 'half-and-half allowed' : '']
            .filter(Boolean)
            .join(', ');
          return ` ${g.name}${flags ? ` (${flags})` : ''}: ${choices}`;
        })
        .join(';');
      return opts ? `${withIng} —${opts}` : withIng;
    })
    .join('. ');
}

function minutesToTime(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Report something the caller asked for that the menu does not sell.
 *
 * The engine is the only place that knows a request went unmatched — it works
 * it out, tells the caller, and until now forgot it. Ten people a week asking
 * for ketchup is worth a restaurant knowing.
 *
 * Deliberately returns void and swallows everything: the caller is mid-order,
 * and a dashboard statistic must never cost them a pause or a failed turn.
 */
export function createMenuGapReporter(
  baseUrl: string,
  nodeSecret: string,
  log: { debug: (obj: unknown, msg?: string) => void },
  fetchImpl: FetchLike = fetch,
): (ctx: ConversationContext, gap: { kind: 'item' | 'option'; term: string; onItem?: string }) => void {
  const headers = { 'content-type': 'application/json', 'x-brayz-node-secret': nodeSecret };
  return (ctx, gap) => {
    void (async () => {
      try {
        await fetchImpl(`${baseUrl}/v1/calls/${encodeURIComponent(ctx.callId)}/tools/menu-gap`, {
          method: 'POST',
          headers,
          body: JSON.stringify(gap),
        });
      } catch (err) {
        log.debug({ err, callId: ctx.callId, term: gap.term }, 'menu-gap report failed');
      }
    })();
  };
}
