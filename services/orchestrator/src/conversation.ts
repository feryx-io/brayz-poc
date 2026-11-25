import {
  DEFAULT_WELCOME_BACK_LINES,
  guestOrderTextsOffer,
  fillGuestName,
  fillStaffName,
  formatDeliveryAddress,
  type DeliveryAddress,
  type UpsellSuggestion,
} from '@brayz/shared';
/**
 * Conversation engine: the real-time AI brain (implementation plan §7.2).
 *
 * Drives greet -> listen -> think -> speak -> barge-in over the injected
 * STT / LLM / TTS providers. Business rules live in tools (RECEPTIONIST_TOOLS +
 * an injected ToolExecutor that calls the internal API) — never in this prompt,
 * never computing prices or inventing menu items (CLAUDE.md rule #5).
 *
 * It is provider-agnostic (rule #2): it only touches the @brayz/ai interfaces,
 * so swapping Deepgram/Anthropic for another vendor needs no change here.
 */
import type { Logger } from 'pino';
import {
  buildCallSummaryPrompt,
  buildReceptionistSystemPrompt,
  RECEPTIONIST_TOOLS,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolDefinition,
  type LlmUsage,
  type SpeechToTextProvider,
  type SttStreamHandle,
  type TextToSpeechProvider,
  type TranscriptSegment,
} from '@brayz/ai';
import type { CallState, OutboundControl } from './protocol.js';
import type { RecentOrder } from './tools.js';

export interface ConversationProviders {
  stt: SpeechToTextProvider;
  llm: LlmProvider;
  tts: TextToSpeechProvider;
}

export interface ConversationContext {
  callId: string;
  restaurantName?: string;
  sampleRate: number;
  /**
   * The restaurant's Brayz service has lapsed (its free trial ended with no
   * paid plan) and there is nowhere to forward the call: say
   * OUT_OF_SERVICE_LINE and hang up, with no STT and no model.
   */
  outOfService?: boolean;
}

/** What a caller hears when the restaurant is out of service and there is no number to send them to. */
export const OUT_OF_SERVICE_LINE = "Sorry, we can't take your call right now. Please try again later.";

/** How the engine talks back to Siphon-AI: PCM playback frames + control msgs. */
export interface CallIo {
  sendAudio(frame: Uint8Array): void;
  send(control: OutboundControl): void;
}

/**
 * Executes a tool call against the internal API and returns a short result
 * string for the LLM. transfer_call is special-cased by the engine (it sends a
 * transfer control); everything else routes through here.
 */
export type ToolExecutor = (call: LlmToolCall, ctx: ConversationContext) => Promise<string>;

/** A resolved transfer destination the caller can be REFERed to. */
export interface TransferTarget {
  key: string;
  label: string;
  description?: string | null;
  sipUri: string;
}

/** One choosable option on a menu item (a crust, a topping, a sauce). */
export interface MenuModifierInfo {
  id: string;
  name: string;
  priceCents: number;
  /**
   * On a chosen option: which part of the item it goes on. Unset means the
   * whole item. Set to left/right by the half-and-half arguments, and priced
   * for that portion already (the group's rule), so the readback adds it up
   * like any other option.
   */
  portion?: ModifierPortion;
}

export type ModifierPortion = 'whole' | 'left' | 'right';

/** A set of options the caller picks from for an item. */
export interface MenuModifierGroupInfo {
  id: string;
  name: string;
  /** single | multi — how many of this group's options may be chosen. */
  selectionType?: string;
  required?: boolean;
  minSelections?: number;
  maxSelections?: number | null;
  /** The caller may put an option on one half only ("half pepperoni"). */
  allowsHalves?: boolean;
  /** What a half costs: full (the whole option price) or half of it. */
  halfPricing?: string;
  modifiers: MenuModifierInfo[];
}

/** An authoritative menu item (loaded from the API) the bot may offer. */
export interface MenuItemInfo {
  /** DB id — carried onto order lines so the API re-prices by id (rule #5). */
  id?: string;
  name: string;
  /** The menu section the item sits in — what tells a sausage sub from a pizza. */
  category?: string | null;
  priceCents: number;
  description?: string | null;
  ingredients?: string[] | null;
  /** The item's options, if it has any. Priced by the API, like the item is. */
  modifierGroups?: MenuModifierGroupInfo[] | null;
}

/** What the engine knows about a recognized returning caller (rule #6 gated by the API). */
export interface GuestInfo {
  isReturning: boolean;
  displayName?: string | null;
  /** The restaurant's personalization posture: full | confirm | off. */
  mode: 'full' | 'confirm' | 'off';
  /** VIP regular (loyalty lifetime-spend rule, computed by the API). */
  vip?: boolean;
  /** Full memory mode only: where their last delivery went, for "still delivering to…?". */
  savedAddress?: DeliveryAddress | null;
  /**
   * They have a saved delivery address. In confirm mode that is all the engine
   * is told: the address itself stays unsaid until the caller gives its street
   * number (confirm_saved_address) — rule #6.
   */
  hasSavedAddress?: boolean;
}

/** The API's answer on a delivery address: in the area or not, and what delivery costs. */
export interface DeliveryCheck {
  deliverable: boolean;
  /** no_rules | in_zip | in_radius | unverified | outside | needs_zip | delivery_off */
  check: string;
  distanceMiles?: number | null;
  /** The ZIP the lookup found, when the caller did not say one. */
  postalCode?: string | null;
  radiusMiles?: number | null;
  feeCents: number;
  minimumCents: number;
  etaMinutes: number;
}

/** Confirm mode: the street number check on a saved address. The address only on a match. */
export interface SavedAddressCheck {
  confirmed: boolean;
  address?: DeliveryAddress;
  /** no_saved_address | mismatch | locked | unreadable */
  reason?: string;
  attemptsLeft?: number;
}

/** Which voice answers this call (consent-gated staff voice, or the default). */
export interface CallVoice {
  /** Provider voice id to synthesize with; null → the TTS default. */
  voiceId?: string | null;
  /** Staff member the voice belongs to (for the greeting), if any. */
  staffName?: string | null;
}

/** One line of the in-call order draft (held in the engine, priced from the menu). */
/** The API would not place the order because it breaks a menu option rule. */
export interface OrderRefusal {
  refused: { code: string; message: string };
}

export interface OrderLine {
  menuItemId?: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  specialInstructions?: string;
  /**
   * Options chosen for this line, matched against the item's own groups. Sent
   * to the API as ids; the prices here are for the readback only, since the API
   * re-prices every one of them from the menu (rule #5).
   */
  modifiers?: MenuModifierInfo[];
  /** This line came from an add-on the bot offered. Attribution only. */
  viaUpsell?: boolean;
}

export interface ConversationDeps {
  providers: ConversationProviders;
  context: ConversationContext;
  io: CallIo;
  log: Logger;
  tools?: LlmToolDefinition[];
  toolExecutor?: ToolExecutor;
  /** Loads the location's transfer destinations; the LLM routes to one by intent. */
  loadTransferTargets?: (ctx: ConversationContext) => Promise<TransferTarget[]>;
  /** Loads the location's menu so the bot knows the items + prices up front. */
  loadMenu?: (ctx: ConversationContext) => Promise<MenuItemInfo[]>;
  /** Loads whether the caller is a recognized returning guest (name + mode). */
  loadGuest?: (ctx: ConversationContext) => Promise<GuestInfo>;
  /** Loads which voice answers this call (staff persona rotation, rule #6-gated). */
  loadVoice?: (ctx: ConversationContext) => Promise<CallVoice | null>;
  /** The staff personas a caller may ask for by name; empty unless the location allows it. */
  loadPersonas?: (ctx: ConversationContext) => Promise<string[]>;
  /** Hands the call to a persona by name (switch_persona); null when nobody by that name is available. */
  switchPersona?: (ctx: ConversationContext, name: string) => Promise<CallVoice | null>;
  /**
   * The location's profile — its name, so the greeting is the restaurant's, and
   * how it wants each item confirmed as it is added.
   */
  loadProfile?: (
    ctx: ConversationContext,
  ) => Promise<{
    name?: string;
    greeting?: string | null;
    welcomeBack?: string | null;
    orderAckMode?: 'fast' | 'natural';
    /** Which ways the location hands an order over, and what it quotes for each. */
    pickupEnabled?: boolean;
    deliveryEnabled?: boolean;
    pickupEtaMinutes?: number;
    deliveryEtaMinutes?: number;
    deliveryFeeCents?: number;
    deliveryMinimumCents?: number;
    /** Whether the doors are open now, and whether there are hours to say so by. */
    openNow?: boolean;
    hoursKnown?: boolean;
    /** The owner asked for closed callers to be told, and the restaurant is shut. */
    announceClosed?: boolean;
    /** Phrased by the API, which knows the restaurant's timezone. */
    hoursToday?: string | null;
    nextOpen?: { at: string; spoken: string } | null;
    scheduling?: { enabled: boolean; maxDaysAhead: number; leadMinutes: number; today?: string | null };
    /** Does this location want a message taken when it is shut? */
    offerMessageWhenClosed?: boolean;
    /** Offer this caller a text when their order is ready. */
    guestOrderTexts?: { offer: boolean };
  } | null>;
  /**
   * Can the order be made for the time the caller asked for? The API decides —
   * it holds the hours, the timezone, the kitchen's lead time and how far ahead
   * this location takes orders (rule #5). Null when it could not be asked.
   */
  scheduleOrder?: (
    ctx: ConversationContext,
    request: { time: string; day?: string },
  ) => Promise<
    | { ok: true; scheduledFor: string; spoken: string }
    | {
        ok: false;
        reason: string;
        earliest: { at: string; spoken: string } | null;
        latest?: { at: string; spoken: string } | null;
        hoursToday?: string | null;
      }
    | null
  >;
  /**
   * Report a request the menu could not satisfy. Fire-and-forget: the caller is
   * mid-order and a dashboard statistic must not cost them a pause.
   */
  reportMenuGap?: (
    ctx: ConversationContext,
    gap: { kind: 'item' | 'option'; term: string; onItem?: string },
  ) => void;
  /** Add-ons worth offering for the current draft. Matched and priced by the API. */
  loadUpsells?: (
    ctx: ConversationContext,
    lines: Array<{ menuItemId?: string; name: string }>,
  ) => Promise<UpsellSuggestion[]>;
  /**
   * Persists the finalized order (place_order). The API re-prices each line from
   * the menu by id — the prices the engine sends are advisory only (rule #5).
   * Returns the order's short confirmation code + authoritative total, the
   * menu rule it broke when the API refused it for one, or null on failure.
   */
  placeOrder?: (
    ctx: ConversationContext,
    lines: OrderLine[],
    opts: {
      customerName?: string;
      redeemReward?: boolean;
      promotionCode?: string;
      fulfillmentType?: 'pickup' | 'delivery';
      deliveryAddress?: DeliveryAddress;
      /** The time the API agreed to, when the caller ordered for later. */
      scheduledFor?: string;
    },
  ) => Promise<{
    orderCode: string;
    totalCents: number;
    discountCents?: number;
    birthdayBonusPoints?: number;
    winbackBonusPoints?: number;
    deliveryFeeCents?: number;
    /** What the location quotes for this kind of order, from its settings. */
    etaMinutes?: number;
    /** A scheduled order is quoted by its time, not by a wait in minutes. */
    scheduledSpoken?: string | null;
  } | OrderRefusal | null>;
  /**
   * The caller's own most recent order at this location, if the kitchen has not
   * taken it yet and rule #6 allows them to hear about it. The API decides all
   * of that; null when it could not be asked.
   */
  loadRecentOrder?: (ctx: ConversationContext) => Promise<RecentOrder | null>;
  /** Confirm mode: the caller reads their confirmation code back before we describe the order. */
  confirmRecentOrder?: (
    ctx: ConversationContext,
    code: string,
  ) => Promise<{ confirmed: boolean; reason?: string; attemptsLeft?: number } | null>;
  /** Save a changed order: every line it should have now, re-priced by the API. */
  changeOrder?: (
    ctx: ConversationContext,
    orderId: string,
    lines: OrderLine[],
  ) => Promise<
    | { ok: true; orderCode: string; totalCents: number; posTicket: boolean }
    | { ok: false; code: string; message: string }
    | null
  >;
  /** Cancel it, while it can still be canceled. */
  cancelOrder?: (
    ctx: ConversationContext,
    orderId: string,
  ) => Promise<{ ok: boolean; orderCode?: string; code?: string } | null>;
  /**
   * The caller said yes to a text when their order is ready. The API records
   * the consent and sends the confirmation text; false if it could not.
   */
  recordOrderTextConsent?: (ctx: ConversationContext, consent: { orderCode: string; callerWords?: string }) => Promise<boolean>;
  /**
   * Is this address inside the delivery area, and what does delivery cost?
   * The API decides (ZIP list or radius); null when it could not be asked.
   */
  checkDelivery?: (ctx: ConversationContext, address: DeliveryAddress) => Promise<DeliveryCheck | null>;
  /**
   * Confirm mode: does this street number match the guest's saved address? The
   * address comes back only on a match (rule #6); null when it could not be asked.
   */
  confirmSavedAddress?: (ctx: ConversationContext, streetNumber: string) => Promise<SavedAddressCheck | null>;
  onStateChange?: (state: CallState) => void;
  onTranscript?: (segment: TranscriptSegment, speaker: 'caller' | 'agent') => void;
}

/** What the media session drives. */
export interface Conversation {
  start(): Promise<void>;
  pushAudio(frame: Uint8Array): void;
  bargeIn(): Promise<void>;
  /** SiphonAI `speech_stopped`: the caller has stopped talking for now. */
  speechStopped(): void;
  stop(): Promise<void>;
  /** A staff-facing summary of the finished call, or null if there is nothing to say. */
  summarize(): Promise<string | null>;
}

/**
 * The tool result when a change or cancel lost a race: the order moved after
 * it was read to the caller. Looked up again rather than guessed at — it may
 * now be with the kitchen, or carry someone else's change.
 */
const ORDER_CHANGED_UNDERFOOT =
  'Not saved — that order changed after you read it to the caller (the kitchen may have just taken it). ' +
  'Call lookup_recent_order again and tell the caller what it says before changing anything.';

const MAX_TOOL_ITERATIONS = 5;
/** What the API accepts on a line (CreateOrderItemInput), so nothing is cut there. */
const MAX_SPECIAL_INSTRUCTIONS = 500;
/** The call is already over; wait a beat for a summary, then let the record close. */
const SUMMARY_TIMEOUT_MS = 10_000;
/** Staff scan these in a list — a summary longer than this is not being read. */
const MAX_SUMMARY_CHARS = 600;

/**
 * Echo suppression. A caller on speakerphone feeds the agent's own voice back
 * into the mic; STT transcribes it and it arrives as a caller final, which would
 * abort the very turn that is speaking. Two conditions have to hold before we
 * drop a final: our audio was on the wire moments ago, AND the words match what
 * we just said. A caller genuinely interrupting says something else, so their
 * barge-in still lands.
 */
// Generous on purpose: STT only emits a final after its endpointing silence
// plus processing, so an echo of our last sentence lands 1-2.5 s AFTER our audio
// stopped (measured on a live speakerphone call, 2026-08-25). A tighter window
// let every greeting echo through and the bot talked over itself.
const ECHO_TAIL_MS = 3000; // how long our audio can still be coming back
/**
 * How long a VAD barge-in waits for words before we believe it. The bridge's
 * detector fires on room noise as well as speech; muting the rest of a reply on
 * every trigger made the bot stutter in and out. We pause instead, and resume
 * where we left off if nothing was actually said.
 */
const BARGE_IN_CONFIRM_MS = 1200;
const ECHO_MEMORY_MS = 15_000; // how long we remember what we said
/** Below this, an utterance is too short to judge on word overlap alone. */
const ECHO_MIN_WORDS = 3;
/**
 * How much of what we heard has to be our own sentence, in our own order,
 * before it is an echo rather than a caller using our words. Below this a
 * question that borrows our phrasing gets through — which is the side to err
 * on: a leaked echo costs one spurious turn, a swallowed question leaves the
 * caller repeating themselves to a bot that never answers.
 */
const ECHO_RUN_COVERAGE = 0.7;
/**
 * How long to let finals accumulate before answering them as one utterance.
 * Deepgram splits a single sentence into several finals ("I'll take" / "I'll
 * take a large one"), and answering the first the moment it lands means
 * replying to half a sentence and then replying again to the rest. The pieces
 * of one breath arrive back to back — on the call that prompted this they were
 * 0.0 s apart — so this only has to outlast that, not a speaker's pause. Kept
 * short deliberately: it is added to every reply the caller waits for.
 */
const UTTERANCE_SETTLE_MS = 250;
/**
 * The longest an utterance may be held open while the caller keeps talking.
 * The hold is released by SiphonAI's `speech_stopped`; this only bounds the
 * case where that never arrives (an energy VAD latched on room noise), so it
 * has to outlast a real sentence — the call that prompted it ran 4.5 s from
 * the first final to the end of the thought. Past this the utterance is
 * answered as it stands and anything further is a new one.
 */
const UTTERANCE_HOLD_MAX_MS = 8000;
/**
 * How long to keep waiting when the caller has stopped but has plainly not
 * finished. "Actually," is not something to answer; it is the run-up to
 * something. On the call of 2026-09-02 18:10 it was answered on its own — "what
 * would you like to change?" — and the sentence it belonged to arrived two
 * seconds later, after the reply was already on the wire, so it queued behind
 * it: eleven seconds from the caller saying it to being answered.
 *
 * A pause after a trailing "actually" or a comma is someone gathering the rest
 * of the thought, and the settle window is far too short to cover it. The cost
 * of waiting here is bounded and only ever paid by an utterance that could not
 * be answered well anyway; the cost of not waiting was that whole exchange.
 */
const UNFINISHED_HOLD_MS = 1500;
/**
 * Words an utterance does not end on if it is finished. Connectives and
 * articles only — a caller who says "large" or "no" or "that's it" has
 * finished, and must not be made to wait for a continuation that is not
 * coming. A trailing comma says the same thing more strongly.
 */
const UNFINISHED_TAIL = new Set([
  'actually', 'and', 'but', 'or', 'so', 'well', 'um', 'uh', 'hmm', 'also',
  'plus', 'with', 'a', 'an', 'the', 'my', 'of', 'for', 'to',
  // "How about" / "what about" is the run-up to the thing itself and never the
  // whole of it. On the call of 2026-09-11 21:43 the caller said "How about",
  // paused, then "tacos? Do you have tacos?" — the pause was answered on its
  // own with "Go ahead, I'm listening", and their real question was not
  // answered until 8.8 s after they finished asking it.
  'about',
]);
/**
 * How much of the shorter utterance has to be the longer one, in order, for it
 * to be the caller saying the same thing again rather than something new.
 */
const RESTATEMENT_COVERAGE = 0.8;
/**
 * Utterances that are decisions, never echo. Each one is also something the
 * agent says constantly, so the echo guard would otherwise eat the caller's
 * half of every yes/no question — including the readback that gates place_order.
 */
const ANSWER_PHRASES = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'yes please',
  'correct',
  'right',
  'thats right',
  'no',
  'nope',
  'nah',
  'no thanks',
  'no thank you',
  'thats wrong',
  'ok',
  'okay',
  'sure',
  'done',
  'thats it',
  'thats all',
  'thats everything',
]);

/** Tools the engine handles itself against the in-call order draft. */
const ORDER_TOOLS = new Set([
  'add_item',
  'update_item',
  'remove_item',
  'review_order',
  'place_order',
  // Handled here rather than by the generic tool executor so the engine keeps
  // the ids it offered, and can mark a later add_item as an upsell without
  // taking the model's word for it.
  'suggest_upsell',
  // Pickup or delivery, and where to: state the read-back and place_order
  // gates read, so the engine keeps it rather than the model.
  'set_fulfillment',
  'set_delivery_address',
  'use_saved_address',
  'confirm_saved_address',
  // The time a caller asked for: the API judges it, the engine keeps it, and
  // the read-back and place_order both carry it.
  'schedule_order',
  // Changing an order already placed. The draft the rest of these tools work
  // on is seeded from it, so a caller adds and removes exactly as they did the
  // first time.
  'lookup_recent_order',
  'confirm_order_code',
  'change_order',
  'cancel_order',
  // The caller's answer to the engine's own text offer: gated on that offer
  // having been spoken and answered, which the engine alone knows.
  'order_text_updates',
]);

/**
 * One synthesized sentence and where its audio sits in the turn's frame
 * stream, so an interruption can be told what the caller actually heard.
 */
interface SpokenSpan {
  text: string;
  startFrame: number;
  endFrame: number;
}

export class ConversationEngine implements Conversation {
  private state: CallState = 'initializing';
  private readonly messages: LlmMessage[] = [];
  private stt: SttStreamHandle | null = null;
  private turn: AbortController | null = null;
  private stopped = false;
  private transferTargets: TransferTarget[] = [];
  private menu: MenuItemInfo[] = [];
  private guest: GuestInfo = { isReturning: false, mode: 'full' };
  private voice: CallVoice = {};
  /** Names a caller may ask for; the model is told these, and only these, switch. */
  private personas: string[] = [];
  /** In-call order draft; built by add_item, persisted by place_order. */
  private order: OrderLine[] = [];
  /** Menu items the bot has offered as add-ons this call, for attribution. */
  private suggestedItemIds = new Set<string>();
  /** Frames the in-flight turn has put on the wire — barge-in needs something to interrupt. */
  private turnAudioFrames = 0;
  /** Frames of this turn the caller actually heard, so an interruption knows where it landed. */
  private turnPlayedFrames = 0;
  /** The in-flight turn has run a tool — it has changed something, so it is not free to drop. */
  private turnRanTools = false;
  /** Resolved at call start from the location profile; the context rarely carries it. */
  private restaurantName?: string;
  /** The owner's greeting chosen for this call, spoken word for word when set. */
  private ownerGreeting?: string;
  /** How a recognized regular is welcomed, with {guest_name} still to fill. */
  private welcomeBack: string = DEFAULT_WELCOME_BACK_LINES[0]!;
  /** Caller utterances that arrived mid-turn; run after the turn finishes. */
  private queued: string[] = [];
  /** Finals gathering into one utterance, waiting for the caller to finish. */
  private settling: string[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the utterance being gathered began, so the hold below cannot run forever. */
  private settleStartedMs = 0;
  /** The caller is mid-breath right now (SiphonAI `speech_started`, no `speech_stopped` yet). */
  private callerSpeaking = false;
  /** What the turn in flight is answering, so a repeat of it is not answered twice. */
  private answering: string | null = null;
  /** An order was placed and its code has not been read to the caller yet. */
  private pendingOrderCode: string | null = null;
  /** This location texts guests about their orders, and this caller has not agreed yet. */
  private offerOrderTexts = false;
  /** An order was placed and the text offer is owed after its confirmation. */
  private pendingTextOffer: string | null = null;
  /**
   * The text offer the engine asked, and the turn it was asked on: the tool
   * that records a yes is only usable once the caller has spoken since.
   */
  private textOffer: { orderCode: string; askedOnTurn: number; answered: boolean } | null = null;
  /** Caller utterances answered so far — the clock the confirmation gate reads. */
  private turnsAnswered = 0;
  /** The turn review_order last ran in; -1 until the order has been read back. */
  private reviewedOnTurn = -1;
  /**
   * Whose name the order goes under. Seeded from a recognized guest in full
   * memory mode; otherwise it has to come from the caller, through
   * review_order or place_order, before either will read back or place.
   */
  private orderName: string | undefined;
  /**
   * Pickup or delivery, once known. Preset at call start when the location
   * offers only one; otherwise it comes from the caller through
   * set_fulfillment, and review_order will not read back without it.
   */
  private fulfillment: 'pickup' | 'delivery' | null = 'pickup';
  /** What this location offers, from its profile; pickup only if that could not load. */
  private offers = { pickup: true, delivery: false };
  /** What the location quotes. The API's figure on the placed order wins. */
  private etaMinutes = { pickup: 20, delivery: 45 };
  /** Delivery fee and minimum as the settings say, for the read-back; the API charges them. */
  private deliveryTerms = { feeCents: 0, minimumCents: 0 };
  /** Where a delivery goes, once an address has passed the area check (or could not be checked). */
  private deliveryAddress: DeliveryAddress | null = null;
  /**
   * The guest's saved address, once the caller may hear it: from the start in
   * full memory mode, after a street-number match in confirm mode (rule #6).
   */
  private savedAddress: DeliveryAddress | null = null;
  /**
   * Whether the restaurant is open, what it says when it is not, and whether a
   * caller may order for later. Loaded once with the profile: the answer must
   * not change mid-call, or a caller is told two different things.
   */
  private hours: {
    openNow: boolean;
    announceClosed: boolean;
    hoursToday: string | null;
    nextOpen: string | null;
    scheduling: { enabled: boolean; maxDaysAhead: number; today: string | null };
    offerMessage: boolean;
  } = {
    openNow: true,
    announceClosed: false,
    hoursToday: null,
    nextOpen: null,
    scheduling: { enabled: false, maxDaysAhead: 0, today: null },
    offerMessage: true,
  };
  /** The time the API agreed this order is for, once a caller has asked for one. */
  private scheduledFor: { at: string; spoken: string } | null = null;
  /** The order the caller placed earlier, once looked up and allowed to be heard. */
  private recentOrder: Extract<RecentOrder, { needsCode: false }> | null = null;
  /**
   * What the call actually did, as the engine saw each tool come back — order
   * placed, change saved or refused, cancel, message, transfer. The summary is
   * written from this, not only from the words: on the call of 2026-09-14 19:17
   * the bot read back "your updated order… Should I save that change?", the
   * API then refused it (the kitchen had accepted), and the summary opened
   * "The system confirmed the update and a new total of $25.25".
   */
  private outcomes: string[] = [];
  /**
   * Set while the draft is a change to an order already placed. place_order
   * saves it back to that order instead of creating a second one — which is
   * the whole risk here: a caller ringing to add a drink must not end up with
   * two dinners.
   */
  private amendingOrderId: string | null = null;
  /** The read-back has been spoken this turn and the caller owes an answer. */
  private awaitingConfirmation = false;
  /** The tool that just ran changed the order and said nothing the caller needs told. */
  private orderToolSpokeForItself = false;
  /** Every tool in the pass just did as it was asked — nothing to relay. */
  private passNeedsNoReply = false;
  /**
   * Who phrases "added that" for this location. `fast` lets the engine say it
   * the moment the tool has done it; `natural` spends a model round trip on
   * the assistant's own wording. Per location, because it is a taste question
   * a restaurant should answer, not a default we pick for them.
   */
  private orderAckMode: 'fast' | 'natural' = 'fast';
  /** What the engine would say about the change the last tool made. */
  private pendingAck: string | null = null;
  /** A VAD barge-in is waiting to be confirmed by words (or taken back). */
  private bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the agent said recently, normalized — the echo we expect to hear back. */
  private recentSpeech: Array<{ text: string; atMs: number; choices: string[] }> = [];
  /** When we last handed a frame to the pump; echo trails playout by a beat. */
  private lastPlayoutMs = 0;
  /** When this turn's first frame went out — the end of the caller's dead air. */
  private turnFirstFrameMs = 0;
  /** Section words from the menu's headings, built on first use. */
  private sectionWordCache: Set<string> | null = null;
  private readonly pump: PlaybackPump;

  constructor(private readonly deps: ConversationDeps) {
    // Paced playout: send one 20 ms frame at a time so chunked/streamed TTS
    // doesn't overflow SiphonAI's ~200 ms outbound buffer (protocol §5.5).
    this.pump = new PlaybackPump((frame) => {
      // Stamp the moment audio actually goes out, not when TTS handed it over:
      // a prefetched sentence is pushed in one burst but plays for seconds, and
      // the echo of it comes back against playout time, not push time.
      this.lastPlayoutMs = nowMs();
      this.turnPlayedFrames += 1;
      if (this.turnFirstFrameMs === 0) this.turnFirstFrameMs = this.lastPlayoutMs;
      this.deps.io.sendAudio(frame);
    }, 20);
    const name = deps.context.restaurantName ?? 'the restaurant';
    this.messages.push({ role: 'system', content: buildReceptionistSystemPrompt(name) });
  }

  /**
   * The restaurant is out of service and the call had nowhere to go: one fixed
   * line, then hang up. No STT and no model — nothing about this call needs
   * either. A short grace after playout lets SiphonAI's buffer drain before the
   * BYE, so the line is not clipped.
   */
  private async declineCall(): Promise<void> {
    try {
      await this.speak(OUT_OF_SERVICE_LINE, new AbortController());
      this.deps.onTranscript?.({ text: OUT_OF_SERVICE_LINE, isFinal: true }, 'agent');
    } catch (err) {
      this.deps.log.warn({ err, callId: this.callId }, 'out-of-service line failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    this.deps.io.send({ type: 'hangup', cause: 'normal' });
    this.setState('completed');
  }

  async start(): Promise<void> {
    if (this.deps.context.outOfService) return this.declineCall();
    this.setState('loading_context');
    this.stt = await this.deps.providers.stt.openStream({
      sampleRate: this.deps.context.sampleRate,
      onSegment: (seg) => this.onSegment(seg),
      onError: (err) => this.deps.log.warn({ err, callId: this.callId }, 'stt error'),
    });

    // Load this location's transfer options + menu before the first turn and tell
    // the LLM about them (routing/menu are data, not prompt — CLAUDE.md rule #5).
    // Run concurrently so a cold API doesn't delay the greeting (a slow greeting
    // invites the caller to talk first, which barges in and cancels it).
    const defaultGuest: GuestInfo = { isReturning: false, mode: 'full' };
    const [targets, menu, guest, voice, profile, personas] = await Promise.all([
      Promise.resolve(this.deps.loadTransferTargets?.(this.deps.context) ?? []).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadTransferTargets failed');
        return [] as TransferTarget[];
      }),
      Promise.resolve(this.deps.loadMenu?.(this.deps.context) ?? []).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadMenu failed');
        return [] as MenuItemInfo[];
      }),
      Promise.resolve(this.deps.loadGuest?.(this.deps.context) ?? defaultGuest).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadGuest failed');
        return defaultGuest;
      }),
      Promise.resolve(this.deps.loadVoice?.(this.deps.context) ?? null).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadVoice failed');
        return null;
      }),
      Promise.resolve(this.deps.loadProfile?.(this.deps.context) ?? null).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadProfile failed');
        return null;
      }),
      Promise.resolve(this.deps.loadPersonas?.(this.deps.context) ?? []).catch((err) => {
        this.deps.log.warn({ err, callId: this.callId }, 'loadPersonas failed');
        return [] as string[];
      }),
    ]);
    // The constructor could only build the prompt from the context, which rarely
    // carries a name — without this the bot answers for "the restaurant" and the
    // model fills the gap with a name of its own.
    this.restaurantName = profile?.name ?? this.deps.context.restaurantName;
    this.voice = voice ?? {};
    this.personas = personas;
    // "{staff_name}" in the owner's greeting is whoever answers: the default
    // voice's name, or the staff member a cloned voice belongs to.
    const rawGreeting = profile?.greeting?.trim();
    this.ownerGreeting = rawGreeting ? fillStaffName(rawGreeting, this.voice.staffName) : undefined;
    this.welcomeBack = profile?.welcomeBack?.trim() || DEFAULT_WELCOME_BACK_LINES[0]!;
    this.orderAckMode = profile?.orderAckMode === 'natural' ? 'natural' : 'fast';
    // Which ways this location hands an order over. Only one: that is what it
    // is, and nobody is asked. Both: the caller is asked, and the read-back
    // waits for the answer. Neither (or no profile) keeps the old pickup-only
    // behaviour rather than refusing every order.
    const pickup = profile?.pickupEnabled ?? true;
    const delivery = profile?.deliveryEnabled ?? false;
    this.offers = pickup || delivery ? { pickup, delivery } : { pickup: true, delivery: false };
    this.fulfillment =
      this.offers.pickup && this.offers.delivery ? null : this.offers.delivery ? 'delivery' : 'pickup';
    this.etaMinutes = {
      pickup: profile?.pickupEtaMinutes ?? 20,
      delivery: profile?.deliveryEtaMinutes ?? 45,
    };
    this.deliveryTerms = {
      feeCents: profile?.deliveryFeeCents ?? 0,
      minimumCents: profile?.deliveryMinimumCents ?? 0,
    };
    // Whether the doors are open. A profile that failed to load leaves this
    // open: the bot answering as it always has beats turning a caller away
    // because a request timed out.
    this.offerOrderTexts = profile?.guestOrderTexts?.offer === true;
    this.hours = {
      openNow: profile?.openNow ?? true,
      announceClosed: profile?.announceClosed === true,
      hoursToday: profile?.hoursToday ?? null,
      nextOpen: profile?.nextOpen?.spoken ?? null,
      scheduling: {
        enabled: profile?.scheduling?.enabled === true,
        maxDaysAhead: profile?.scheduling?.maxDaysAhead ?? 0,
        today: profile?.scheduling?.today ?? null,
      },
      offerMessage: profile?.offerMessageWhenClosed !== false,
    };
    if (this.restaurantName) {
      this.messages[0] = {
        role: 'system',
        content: buildReceptionistSystemPrompt(this.restaurantName, {
          ...this.hoursPromptOpts(),
          greeting: this.ownerGreeting,
          assistantName: this.voice.staffName ?? undefined,
          canTransfer: targets.length > 0,
        }),
      };
    }
    this.transferTargets = targets;
    this.menu = menu;
    this.guest = guest;
    // A recognized guest's order goes under their name without asking again —
    // but only in full memory mode. In confirm mode the name the caller gives
    // is the identity check, so it must come from them (see guestPrompt).
    if (guest.isReturning && guest.mode === 'full' && guest.displayName?.trim()) {
      this.orderName = guest.displayName.trim();
    }
    // Same posture for where they live: full mode trusts the caller-id match
    // with the saved address, confirm mode only gets it after the caller gives
    // its street number (confirm_saved_address). The API already withholds it
    // in confirm mode; this is the engine not relying on that alone.
    if (guest.isReturning && guest.mode === 'full' && guest.savedAddress) {
      this.savedAddress = guest.savedAddress;
    }
    if (this.transferTargets.length) {
      this.messages.push({ role: 'system', content: this.transferOptionsPrompt() });
    }
    if (this.personas.length) {
      this.messages.push({ role: 'system', content: this.personasPrompt() });
    }
    if (this.menu.length) {
      this.messages.push({ role: 'system', content: this.menuPrompt() });
      this.messages.push({ role: 'system', content: this.fulfillmentPrompt() });
    }
    if (this.guest.isReturning) {
      this.messages.push({ role: 'system', content: this.guestPrompt() });
    }

    this.setState('greeting');
    const name = this.restaurantName;
    // Greet a recognized returning guest by name (phone match; the API already
    // applied the location's memory mode + the guest's opt-out before telling us).
    const known = this.guest.isReturning ? (this.guest.displayName ?? undefined) : undefined;
    // Introduce the staff persona by name when one answers (consent-gated by the API).
    const intro = this.voice.staffName ? `, this is ${this.voice.staffName}` : '';
    // An owner who wrote greetings in Settings hears the one chosen for this
    // call word for word — it was saved and then ignored on the call of
    // 2026-09-07 19:50. A recognized guest is welcomed back by name first,
    // with the welcome line chosen for this call; the staff intro is left out
    // of an owner's line, since it already says who is speaking.
    const welcome = known ? fillGuestName(this.welcomeBack, known) : undefined;
    const opening = this.ownerGreeting
      ? welcome
        ? `${welcome} ${this.ownerGreeting}`
        : this.ownerGreeting
      : welcome
        ? `${welcome} Thanks for calling ${name ?? 'us'}${intro}. How can I help you today?`
        : name
          ? `Thanks for calling ${name}${intro}. How can I help you today?`
          : `Thanks for calling${intro}. How can I help you today?`;
    const greeting = withClosedNotice(opening, this.closedGreetingSuffix());
    // The greeting is interruptible: park it on a turn controller so a barge-in
    // (or an early caller utterance) can abort it. An abort here is normal — the
    // caller talked first — and must NOT crash start(); barge-in already moved us
    // to listening, so just swallow the cancellation. Real TTS errors still throw.
    const greet = new AbortController();
    this.turn = greet;
    this.turnAudioFrames = 0;
    this.turnPlayedFrames = 0;
    this.turnFirstFrameMs = 0;
    const greetSpans: SpokenSpan[] = [];
    try {
      await this.speakTracked(greeting, greet, greetSpans);
    } catch (err) {
      if (!greet.signal.aborted) throw err;
    }
    this.recordGreeting(greetSpans);
    if (this.turn === greet) {
      this.turn = null;
      if (!greet.signal.aborted) this.setState('listening');
    }
    // A caller who talked over the greeting is answered now, not dropped.
    this.runQueued();
  }

  pushAudio(frame: Uint8Array): void {
    this.stt?.pushAudio(frame);
  }

  async bargeIn(): Promise<void> {
    this.callerSpeaking = true;
    // Caller started talking over the agent (SiphonAI `speech_started`): cancel
    // the in-flight turn (LLM + TTS), drop our queued frames, and flush buffered
    // playout on SiphonAI's side via `clear`.
    // A turn that hasn't put a frame on the wire yet has nothing to interrupt:
    // an energy VAD fires `speech_started` on room noise, and cancelling here
    // kills the greeting before it is ever heard (the caller then gets silence
    // until SiphonAI's start-deadline drops the call). Real speech still lands
    // as a final transcript, which aborts the turn in onSegment.
    if (this.turn && this.turnAudioFrames === 0) {
      // ...but if that silent turn is answering the caller, this is not noise
      // over a greeting — it is the caller carrying on, and the turn is a reply
      // to half of what they mean to say. Take it back rather than ignore them.
      if (this.reclaimUnspokenTurn()) return;
      this.deps.log.debug({ callId: this.callId, state: this.state }, 'barge-in ignored: no audio on the wire yet');
      return;
    }
    // No reply in flight and nothing of ours playing: the caller is simply
    // talking, and there is nothing to interrupt. Arming a barge-in here was
    // the bug on the call of 2026-09-04 22:13 — the caller listed "lettuce,
    // tomato," paused, said "cucumbers", and the pause fired the VAD; the next
    // word then "confirmed" an interruption of nothing, and confirming one
    // threw away the words being held. Lettuce and tomato never reached the
    // wrap. Anyone who pauses mid-sentence would lose the first half.
    if (!this.turn && !this.pump.isPlaying()) {
      this.deps.log.debug({ callId: this.callId, state: this.state }, 'speech while idle: nothing to interrupt');
      return;
    }
    // Go quiet at once — but provisionally. The rest of the reply is held, not
    // dropped: if words follow, onSegment commits the interruption; if this was
    // noise, we resume mid-sentence and the caller hears the reply finish.
    this.pump.pause();
    this.deps.io.send({ type: 'clear' });
    this.setState('listening');
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = null;
      if (this.stopped) return;
      this.deps.log.debug({ callId: this.callId }, 'barge-in unconfirmed — resuming playout');
      this.pump.resume();
      if (this.turn) this.setState('speaking');
    }, BARGE_IN_CONFIRM_MS);
    this.bargeInTimer.unref?.();
  }

  /**
   * The caller's breath ended (SiphonAI `speech_stopped`). Only releases the
   * hold on a gathering utterance — endpointing and the words themselves come
   * from STT, so nothing here decides what was said.
   */
  speechStopped(): void {
    this.callerSpeaking = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.settling.length = 0;
    this.turn?.abort();
    this.pump.stop();
    await this.stt?.close().catch(() => {});
    this.stt = null;
  }

  /** Answer whatever the caller said while we were busy, as one utterance. */
  private runQueued(): void {
    if (this.stopped || this.turn || !this.queued.length) return;
    const text = this.queued.splice(0).join(' ').trim();
    if (text) void this.runTurn(text);
  }

  private rememberSpeech(text: string): void {
    const norm = normalizeSpeech(text);
    if (!norm) return;
    const at = nowMs();
    // The alternatives are taken from the text before it is normalized: it is
    // the question mark that makes "sub, or pizza" a question rather than a
    // description, and normalizing throws the punctuation away.
    this.recentSpeech.push({ text: norm, atMs: at, choices: offeredChoices(text) });
    this.recentSpeech = this.recentSpeech.filter((s) => at - s.atMs < ECHO_MEMORY_MS);
  }

  /** Is this final our own voice coming back through the caller's handset? */
  private isSelfEcho(text: string): boolean {
    const at = nowMs();
    // Nothing of ours is playing or has just played, so nothing can echo.
    if (!this.pump.isPlaying() && at - this.lastPlayoutMs > ECHO_TAIL_MS) return false;
    const heard = normalizeSpeech(text);
    if (!heard) return false;
    // A bare "no" / "okay" / "that's it" is how a caller answers a question, and
    // it is also a word we almost certainly just used ourselves ("No problem",
    // "Okay, one large pizza"), so no amount of text comparison separates the
    // two. Decide it by consequence instead: a leaked echo costs one spurious
    // turn, while swallowing the "no" to "anything else?" leaves the caller
    // talking to silence and stalls the order. Answers always go through.
    if (ANSWER_PHRASES.has(heard)) return false;
    const recent = this.recentSpeech.filter(({ atMs }) => at - atMs < ECHO_MEMORY_MS);
    // A caller choosing between two things we offered answers in our exact
    // words — that is what choosing is — so no measure of overlap can tell
    // their answer from our echo. The question itself is what separates them:
    // an answer picks ONE of the alternatives, an echo plays the question back
    // with both of them in it.
    if (recent.some(({ choices }) => picksOneChoice(choices, heard))) return false;
    return recent.some(({ text: said }) => echoes(said, heard));
  }

  /**
   * Ask the model to summarize the call that just happened. Runs after the
   * media session is over, so it is never on the latency path — but it is still
   * bounded and best-effort: a slow or failing LLM must not hold a call record
   * open, and a call with no summary is better than a call stuck ending.
   */
  async summarize(): Promise<string | null> {
    // The system prompts are scaffolding and the tool plumbing is not
    // conversation, so a summary needs neither. Nothing said means nothing to
    // summarize.
    const spoken = this.messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim(),
    );
    if (!spoken.some((m) => m.role === 'user')) return null;

    // Replay the call as text, not as message turns. The live history pairs
    // each assistant tool call with a `tool` result message, and a turn the
    // caller barged is aborted between the two — so replaying only the user and
    // assistant messages hands the provider a tool call with no result, which
    // it rejects outright (400). That failed every summary on every real call.
    // Words are all a summary needs.
    const transcript = spoken
      .map((m) => `${m.role === 'user' ? 'Caller' : 'Receptionist'}: ${m.content.trim()}`)
      .join('\n');

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SUMMARY_TIMEOUT_MS);
    timer.unref?.();
    let text = '';
    try {
      await this.deps.providers.llm.stream({
        // The transcript first, then the instruction — so the model summarizes
        // what was said rather than continuing the conversation.
        messages: [{ role: 'user', content: `${transcript}\n\n${buildCallSummaryPrompt(this.outcomes)}` }],
        temperature: 0,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'text') text += event.textDelta;
        },
      });
    } catch (err) {
      this.deps.log.warn({ err, callId: this.callId }, 'call summary failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
    const summary = text.trim();
    return summary ? summary.slice(0, MAX_SUMMARY_CHARS) : null;
  }

  private get callId(): string {
    return this.deps.context.callId;
  }

  private setState(state: CallState): void {
    this.state = state;
    this.deps.onStateChange?.(state);
  }

  private onSegment(seg: TranscriptSegment): void {
    if (seg.isFinal && this.isSelfEcho(seg.text)) {
      // Not the caller — our own voice coming back. Dropped before the
      // transcript so the record doesn't attribute our words to the guest.
      this.deps.log.debug({ callId: this.callId, text: seg.text }, 'dropped self-echo');
      return;
    }
    // Words confirm the interruption, interim or final. Waiting for a final
    // meant waiting for Deepgram's endpointing silence plus processing, which
    // is reliably longer than BARGE_IN_CONFIRM_MS — so the window expired every
    // time, playout resumed, and the caller who had just asked something over
    // the top of the reply was talked through. Six of those in one call.
    //
    // An interim carrying words is far stronger evidence than the VAD trigger
    // this provisional scheme exists to distrust: the VAD fires on a cough, but
    // STT does not transcribe one. The turn is aborted here; the final that
    // follows runs the answer through the normal path.
    if (this.bargeInTimer && seg.text.trim() && !this.isSelfEcho(seg.text)) {
      this.deps.log.debug(
        { callId: this.callId, isFinal: seg.isFinal },
        'barge-in confirmed by words',
      );
      this.commitBargeIn();
    }
    this.deps.onTranscript?.(seg, 'caller');
    if (!seg.isFinal || this.stopped) return;
    // STT only closes a final after its endpointing silence, so a final is
    // itself proof the caller has stopped — and a surer one than the bridge's
    // energy VAD, which may not have said so yet. If they carry on, the next
    // `speech_started` sets this again and the utterance keeps gathering.
    this.callerSpeaking = false;
    // A turn in flight is left to finish. Aborting it on every final made the
    // bot restart itself on room noise and its own leaked audio, and a readback
    // never survived long enough to reach place_order. The utterance is queued
    // and answered next — the caller waits at most one sentence, and their audio
    // still cuts our playout immediately via barge-in.
    if (this.bargeInTimer) {
      // The VAD was right: real words followed. Take the interruption now —
      // drop the held audio and answer instead of finishing the old reply.
      this.commitBargeIn();
      this.settle(seg.text);
      return;
    }
    if (this.turn) {
      // The rest of a sentence whose start is already being answered. Checked
      // before the restatement rule, which it would otherwise match: "How
      // about" was answered on its own on the call of 2026-09-14, and "how
      // about tomorrow at 6PM?" then read as a repeat of it and was dropped —
      // the caller had to say the time again.
      if (this.replaceWithRestOfSentence(seg.text)) {
        this.settle(seg.text);
        return;
      }
      // The caller repeating themselves is not a new thing to answer. It
      // happens when a reply is slow: they ask, hear nothing, ask again — and
      // answering each copy produces "I'm adding a Large Sgt Peppers", then
      // "Anything else?", then "I've ALREADY added one", which is worse than
      // the silence that caused it.
      if (this.isRestatement(seg.text)) {
        this.deps.log.debug({ callId: this.callId, text: seg.text }, 'dropped restatement');
        return;
      }
      // ...unless it has not made a sound or done anything yet, in which case
      // it is worth nothing and waiting for it costs the caller a whole reply
      // to something they have already moved past.
      if (this.dropStaleTurn()) {
        this.settle(seg.text);
        return;
      }
      this.queued.push(seg.text);
      return;
    }
    this.settle(seg.text);
  }

  /**
   * Take a provisional barge-in for real: drop the audio being held, abandon
   * the reply, and drop what was queued behind it. The caller is interrupting,
   * so whatever was waiting for that reply is superseded. Words still being
   * gathered for an utterance nobody has answered yet are not: they are the
   * caller's own sentence in progress, and the final that follows this
   * interruption joins them through settle().
   */
  private commitBargeIn(): void {
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
    this.pump.clear();
    this.turn?.abort();
    this.turn = null;
    this.answering = null;
    this.queued.length = 0;
  }

  /**
   * Gather finals into one utterance before answering. STT ends a final at a
   * pause, not at the end of a thought, so a single sentence can arrive in
   * pieces; answering the first piece means talking over the rest of it.
   */
  private settle(text: string): void {
    if (!this.settling.length) this.settleStartedMs = nowMs();
    this.settling.push(text);
    this.armSettle();
  }

  /**
   * Wait out the settle window, and keep waiting while the caller is still
   * talking. STT closes a final at a pause, not at the end of a thought: on
   * the call of 2026-09-01 the caller said "Actually," — paused — "I changed my
   * mind, can I get barbecue instead?", and answering the first word alone got
   * them asked what they wanted to change. From there every reply was one turn
   * behind and they repeated themselves twice more.
   */
  private armSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.stopped) return;
      if (this.callerSpeaking && nowMs() - this.settleStartedMs < UTTERANCE_HOLD_MAX_MS) {
        this.armSettle();
        return;
      }
      // They have stopped, but not on anything answerable. Give the rest of the
      // sentence a moment to arrive rather than replying to the run-up — and
      // keep the wait bounded, because the caller who really did just say
      // "actually" and stop is owed an answer too.
      const pending = this.settling.join(' ').trim();
      if (
        pending &&
        looksUnfinished(pending) &&
        nowMs() - this.settleStartedMs < UNFINISHED_HOLD_MS
      ) {
        this.deps.log.debug({ callId: this.callId, text: pending }, 'holding an unfinished utterance');
        this.armSettle();
        return;
      }
      const merged = this.settling.splice(0).join(' ').trim();
      if (!merged) return;
      // A turn may have started while we gathered (a confirmed barge-in); let
      // the queue handle it rather than running two turns at once.
      if (this.turn) {
        if (this.replaceWithRestOfSentence(merged)) {
          void this.runTurn(merged);
          return;
        }
        if (this.isRestatement(merged)) return;
        if (this.dropStaleTurn()) {
          void this.runTurn(merged);
          return;
        }
        this.queued.push(merged);
        return;
      }
      void this.runTurn(merged);
    }, UTTERANCE_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /**
   * The caller started talking again before the turn we just dispatched put a
   * sound on the wire or ran a tool. That is not an interruption — the reply
   * has not happened yet — it is the rest of what they were saying. Hand the
   * turn's text back to the settle buffer so both halves are answered as one,
   * and drop it from the model's history so the fragment is not sent twice.
   *
   * Being wrong here costs one settle window: if the VAD fired on room noise
   * and nothing follows, the same text runs a beat later. Being wrong the
   * other way costs the caller the rest of the call, which is what happened.
   */
  private reclaimUnspokenTurn(): boolean {
    // No `answering` means the greeting, which nothing has asked for yet.
    if (!this.turn || this.answering === null) return false;
    if (this.turnPlayedFrames > 0 || this.turnRanTools) return false;
    if (nowMs() - this.settleStartedMs >= UTTERANCE_HOLD_MAX_MS) return false;
    const text = this.answering;
    this.deps.log.debug({ callId: this.callId, text }, 'reclaimed a turn that had not spoken');
    this.turn.abort();
    this.turn = null;
    this.pump.clear();
    this.answering = null;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && last.content === text) this.messages.pop();
    this.settling.unshift(text);
    this.armSettle();
    return true;
  }

  /**
   * Abandon the turn in flight when it has put no audio on the wire and run no
   * tools — it has said nothing and changed nothing, so there is nothing to
   * lose by answering the newer utterance instead. Returns whether it did.
   *
   * On a live call (2026-08-31) the caller said "I know" over the sauce list
   * and named their sauce a second too late to merge with it. The turn was
   * still thinking, so their answer queued behind it, and they were asked which
   * sauce they wanted after they had said it. They repeated themselves.
   *
   * Once we are speaking, or once a tool has run, the old behaviour holds: the
   * turn finishes and the new utterance waits its place. That is what keeps a
   * readback alive to reach place_order.
   *
   * "Speaking" means a frame has reached the wire, not that the synthesizer
   * has produced one. On the call of 2026-09-04 23:27 the caller said "One
   * large pizza." — the model asked what toppings they wanted — and "Half
   * sausage, half mushrooms." arrived while that question was still being
   * synthesized, its first frame half a second from the wire. TTS had already
   * buffered audio, so the turn counted as speaking, the answer queued behind
   * the question, and the caller heard a question they had just answered and
   * said it again. Audio nobody has heard is nothing to lose; it is dropped
   * from the pump along with the turn.
   */
  private dropStaleTurn(): boolean {
    if (!this.turn || this.turnPlayedFrames > 0 || this.turnRanTools) return false;
    this.deps.log.debug({ callId: this.callId }, 'replacing a turn that had not spoken');
    this.turn.abort();
    this.turn = null;
    this.pump.clear();
    return true;
  }

  /**
   * The caller carried on past what we are answering: `text` is that same
   * utterance with more on the end. If the turn has said nothing and done
   * nothing yet, drop it — and its fragment from the history, so the model is
   * not sent the start twice — and report true so the whole sentence is
   * answered instead. A queued fragment is swapped for the longer text in
   * place. A turn that has already spoken is left alone: the rest of the
   * sentence is then not a restatement (see isRestatement) and queues.
   */
  private replaceWithRestOfSentence(text: string): boolean {
    const queuedAt = this.queued.findIndex((prev) => extendsUtterance(prev, text));
    if (queuedAt >= 0) {
      this.queued[queuedAt] = text;
      return false;
    }
    if (!this.turn || this.answering === null || !extendsUtterance(this.answering, text)) return false;
    if (this.turnPlayedFrames > 0 || this.turnRanTools) return false;
    this.deps.log.debug(
      { callId: this.callId, was: this.answering, text },
      'replacing a turn with the rest of its sentence',
    );
    this.turn.abort();
    this.turn = null;
    this.pump.clear();
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && last.content === this.answering) this.messages.pop();
    this.answering = null;
    return true;
  }

  /** Is this the caller saying again what we are already answering? */
  private isRestatement(text: string): boolean {
    const heard = normalizeSpeech(text);
    if (!heard) return true; // nothing to answer
    const against = [this.answering, ...this.queued].filter(Boolean) as string[];
    return against.some((prev) => {
      // Saying more than before is not saying it again.
      if (extendsUtterance(prev, text)) return false;
      const a = normalizeSpeech(prev).split(' ');
      const b = heard.split(' ');
      const shorter = Math.min(a.length, b.length);
      if (!shorter) return false;
      return longestOrderedRun(a, b) / shorter >= RESTATEMENT_COVERAGE;
    });
  }

  private async runTurn(userText: string): Promise<void> {
    this.messages.push({ role: 'user', content: userText });
    // One tick per caller utterance answered. The confirmation gate below reads
    // it to tell "the caller agreed" from "we asked and answered ourselves".
    this.turnsAnswered += 1;
    const turn = new AbortController();
    this.turn = turn;
    // What this turn is answering, so a caller who repeats themselves while it
    // runs is recognised rather than answered a second time.
    this.answering = userText;
    this.turnAudioFrames = 0;
    this.turnPlayedFrames = 0;
    this.turnFirstFrameMs = 0;
    this.turnRanTools = false;
    this.awaitingConfirmation = false;
    /** Everything this turn said, across passes — what the code check reads. */
    let saidThisTurn = '';
    // Latency bookkeeping. The engine had no timing instrumentation at all, so
    // every gap on a real call had to be reconstructed afterwards from word
    // counts against an assumed speech rate — which was wrong by 20% and made a
    // 4-second gap read as 5.5. Anchored on the caller's first final rather
    // than on this method: the wait they hear starts when they stop talking,
    // and the settle window (UTTERANCE_SETTLE_MS) is part of what they wait.
    // Deepgram's own endpointing silence is still ahead of that anchor and not
    // counted here.
    const heardAtMs = this.settleStartedMs || nowMs();
    const passTtfbMs: number[] = [];
    const passUsage: LlmUsage[] = [];
    let toolCalls = 0;

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        this.setState('thinking');
        // Sentence-by-sentence playout positions, so a barge-in mid-reply knows
        // which sentences reached the caller and which died in the pump. Per
        // pass, not per turn: a turn speaks once before each tool call and
        // again after, and each of those is recorded as it finishes. Kept
        // across the whole turn, an interruption in a later pass replayed the
        // sentences the earlier passes had already written — the transcript
        // said them twice (seen on the call of 2026-08-31 21:09).
        const spans: SpokenSpan[] = [];
        let full = '';
        let pending = '';
        const calls: LlmToolCall[] = [];
        // Synthesize sentence-by-sentence as the LLM streams, so first audio
        // starts after sentence one instead of the whole reply. Sentences play
        // in order via a serial chain into the paced pump.
        let speakChain: Promise<void> = Promise.resolve();
        let speaking = false;
        let spoken = 0;
        const enqueue = (sentence: string) => {
          if (!sentence.trim()) return;
          if (!speaking) {
            speaking = true;
            this.setState('speaking');
          }
          if (spoken++ === 0) {
            // First sentence streams straight into the pump — nothing is playing
            // yet, so time-to-first-audio is what matters.
            speakChain = speakChain.then(async () => {
              if (turn.signal.aborted) return;
              const startFrame = this.turnAudioFrames;
              try {
                await this.synthesizeToPump(sentence, turn);
              } finally {
                // Recorded even when synthesis was cut short: the frames it did
                // push are frames the caller heard.
                spans.push({ text: sentence, startFrame, endFrame: this.turnAudioFrames });
              }
            });
            return;
          }
          // Later sentences prefetch: synthesis runs while the previous sentence
          // is still playing out, so a TTS round-trip never drains the pump and
          // leaves a hole in the middle of a reply. Order is preserved by the
          // chain; only the network wait moves off it.
          const pending = this.synthesizeBuffered(sentence, turn).catch(() => [] as Uint8Array[]);
          speakChain = speakChain.then(async () => {
            const frames = await pending;
            if (turn.signal.aborted) return;
            const startFrame = this.turnAudioFrames;
            for (const frame of frames) {
              this.turnAudioFrames += 1;
              this.pump.push(frame);
            }
            spans.push({ text: sentence, startFrame, endFrame: this.turnAudioFrames });
          });
        };

        const passStartedMs = nowMs();
        let passFirstMs = 0;
        await this.deps.providers.llm.stream({
          messages: this.messages,
          tools: this.callTools(),
          signal: turn.signal,
          onEvent: (e) => {
            // First byte of the model's answer, whatever form it takes: a tool
            // call costs the caller the same wait as a spoken word.
            // A provider that says when its answer starts is measured to that,
            // not to a tool call it has finished writing out.
            if (!passFirstMs && (e.type === 'start' || e.type === 'text' || e.type === 'tool_call')) {
              passFirstMs = nowMs();
              passTtfbMs.push(Math.round(passFirstMs - passStartedMs));
            }
            if (e.type === 'usage' && e.usage) passUsage.push(e.usage);
            if (e.type === 'text' && e.textDelta) {
              full += e.textDelta;
              pending += e.textDelta;
              const { sentences, rest } = drainSentences(pending);
              pending = rest;
              for (const s of sentences) enqueue(s);
            } else if (e.type === 'tool_call' && e.toolCall) {
              calls.push(e.toolCall);
            }
          },
        });

        if (turn.signal.aborted) return this.recordInterrupted(spans);
        if (pending.trim()) enqueue(pending); // trailing partial sentence
        await speakChain; // all sentence synthesis finished pushing frames
        await this.pump.drain(); // wait for playout to finish before the next turn
        if (turn.signal.aborted) return this.recordInterrupted(spans);

        this.messages.push({
          role: 'assistant',
          content: full,
          toolCalls: calls.length ? calls : undefined,
        });
        if (full.trim()) this.deps.onTranscript?.({ text: full, isFinal: true }, 'agent');
        saidThisTurn += ` ${full}`;
        const spokeThisPass = Boolean(full.trim());

        if (!calls.length) break;
        toolCalls += calls.length;
        await this.executeTools(calls, turn);
        if (turn.signal.aborted) return;
        // The read-back has been spoken and the gate below turned down the
        // place_order that came with it. The turn is finished: another pass
        // would only ask the question the caller has already heard, and asked
        // to explain itself the model apologizes and asks it again. Ending here
        // costs one fewer round trip than that, and the tool result stays in
        // the history for the turn their answer starts.
        if (this.awaitingConfirmation && saidThisTurn.trim()) break;
        // The pass spoke, and all it did was change the order. Another round
        // trip would only rephrase what the caller already heard, and it is the
        // most expensive thing on the call: on 2026-09-02 a plain "Large."
        // cost 2483 ms to decide and 1503 ms to say it again, with the caller
        // hearing nothing until the second one finished.
        if (this.passNeedsNoReply && spokeThisPass) {
          saidThisTurn += ` ${await this.inviteIfNothingWasAsked(full, turn)}`;
          break;
        }
        // It said nothing, so the caller has heard nothing. Asked to announce
        // the change itself the model complies about a third of the time
        // (measured 0/10 on the real prompt, 3-4/10 with the rule moved
        // around), which is not something a caller can be left waiting on. In
        // `fast` the engine says it instead, from what the tool actually did,
        // and the turn ends here. In `natural` the round trip is the point:
        // the restaurant asked for the assistant's own words.
        if (this.passNeedsNoReply && this.orderAckMode === 'fast' && this.pendingAck) {
          const ack = this.pendingAck;
          this.pendingAck = null;
          await this.speak(ack, turn);
          if (turn.signal.aborted) return;
          this.messages.push({ role: 'assistant', content: ack });
          this.deps.onTranscript?.({ text: ack, isFinal: true }, 'agent');
          saidThisTurn += ` ${ack}`;
          break;
        }
      }
      await this.sayOrderCodeIfMissed(saidThisTurn, turn);
      await this.offerOrderTextsIfDue(turn);
    } catch (err) {
      if (!turn.signal.aborted) {
        // Fallback path (CLAUDE.md working style): on provider failure, transfer
        // to the first configured destination rather than leaving the caller in
        // dead air; if none, hang up cleanly.
        this.deps.log.error({ err, callId: this.callId }, 'conversation turn failed');
        const fallback = this.transferTargets[0];
        if (fallback) {
          this.deps.io.send({ type: 'transfer', target: fallback.sipUri });
          this.setState('transferring');
        } else {
          this.deps.io.send({ type: 'hangup', cause: 'normal' });
          this.setState('failed');
        }
      }
    } finally {
      this.logTurnLatency(heardAtMs, passTtfbMs, toolCalls, turn.signal.aborted, passUsage);
      if (this.turn === turn) {
        this.turn = null;
        // Held until the queue is flushed below: a repeat that arrives in the
        // same breath as the turn ending is still a repeat.
        if (!turn.signal.aborted && this.state !== 'transferring') this.setState('listening');
      }
      this.runQueued();
      if (this.turn === null) this.answering = null;
    }
  }

  /**
   * Hand the turn back to the caller when the reply forgot to.
   *
   * Ending a turn on the pass that changed the order removed a round trip
   * (#61) and, with it, the reply that used to end in "anything else?" — the
   * model is asked to put its next question in the same breath as the tool
   * call and does not always. On the call of 2026-09-02 18:09 it said "Got it,
   * one large pizza with sausage." and stopped; ten seconds later the caller
   * said "Hello?" to find out whether the line was still there.
   *
   * A question mark is the test. It is crude, and it is the right kind of
   * crude: anything the model ends with a question is already an invitation to
   * speak, and anything it does not is silence the caller has to break.
   */
  private async inviteIfNothingWasAsked(said: string, turn: AbortController): Promise<string> {
    if (turn.signal.aborted || said.includes('?')) return '';
    const line = 'Anything else?';
    await this.speak(line, turn);
    if (turn.signal.aborted) return '';
    this.messages.push({ role: 'assistant', content: line });
    this.deps.onTranscript?.({ text: line, isFinal: true }, 'agent');
    return line;
  }

  /**
   * Say the confirmation code if the reply did not.
   *
   * The code is the one thing about the order a caller cannot recover on their
   * own, and asking the model to say it is not the same as saying it: measured
   * over eighteen live turns it left the code out of about one reply in ten,
   * and on the call of 2026-09-01 the caller had to ask "I think you forgot the
   * confirmation number". Rewording the tool result did not move that rate
   * (twenty-four more live turns; the difference was inside the noise), which
   * is what makes this the wrong thing to ask a model for at all. Pricing is
   * already settled this way — the tool decides, not the prompt (rule #5).
   *
   * An interrupted turn leaves the code pending rather than forcing it into a
   * barge-in: the caller is talking, and the next turn will still owe it.
   */
  private async sayOrderCodeIfMissed(said: string, turn: AbortController): Promise<void> {
    const code = this.pendingOrderCode;
    if (!code || turn.signal.aborted) return;
    if (saidCode(said, code)) {
      this.pendingOrderCode = null;
      return;
    }
    const line = `Your confirmation code is ${spellCode(code)}.`;
    await this.speak(line, turn);
    if (turn.signal.aborted) return;
    this.pendingOrderCode = null;
    // Into the model's own history too, so the next turn knows it was said and
    // does not offer it again.
    this.messages.push({ role: 'assistant', content: line });
    this.deps.onTranscript?.({ text: line, isFinal: true }, 'agent');
  }

  /**
   * Ask whether the caller wants a text when their order is ready — after its
   * confirmation code, in fixed words (guestOrderTextsOffer), never the
   * model's. The words are the disclosure the caller agrees to (rule #6), so
   * they are said exactly, the way the confirmation code is. The yes itself is
   * recorded by the order_text_updates tool, which opens only once the caller
   * has answered.
   */
  private async offerOrderTextsIfDue(turn: AbortController): Promise<void> {
    const code = this.pendingTextOffer;
    if (!code || this.pendingOrderCode || turn.signal.aborted) return;
    const line = guestOrderTextsOffer(this.restaurantName ?? 'The restaurant');
    await this.speak(line, turn);
    if (turn.signal.aborted) return;
    this.pendingTextOffer = null;
    this.textOffer = { orderCode: code, askedOnTurn: this.turnsAnswered, answered: false };
    this.messages.push({ role: 'assistant', content: line });
    this.deps.onTranscript?.({ text: line, isFinal: true }, 'agent');
  }

  /**
   * What the caller waited, and which leg spent it.
   *
   * `deadAirMs` is the number that matters: their last word to our first frame.
   * `passMs` breaks the model's share out per pass, because a turn that touches
   * an order tool pays for two round trips and a turn that only talks pays for
   * one — reading a single total, those look like the same problem and are not.
   * `spokeMs` is what is left once the model has answered: TTS plus the first
   * frame reaching the pump.
   *
   * Logged at info, not debug: this is the measurement, and dev strips debug on
   * every `up.sh`. An aborted turn is logged too, marked, since a barge-in that
   * lands before we ever speak is itself a latency symptom.
   */
  private logTurnLatency(
    heardAtMs: number,
    passMs: number[],
    tools: number,
    aborted: boolean,
    usage: LlmUsage[] = [],
  ): void {
    const spoke = this.turnFirstFrameMs;
    const modelMs = passMs.reduce((a, b) => a + b, 0);
    this.deps.log.info(
      {
        callId: this.callId,
        turn: this.turnsAnswered,
        deadAirMs: spoke ? Math.round(spoke - heardAtMs) : null,
        modelMs,
        passMs,
        spokeMs: spoke ? Math.round(spoke - heardAtMs) - modelMs : null,
        tools,
        // Per pass, beside passMs: a slow pass with cacheRead 0 is our prompt
        // missing the cache; a slow pass that read it back is the provider.
        ...(usage.length
          ? {
              inputTokens: usage.map((u) => u.inputTokens ?? null),
              cacheReadTokens: usage.map((u) => u.cacheReadTokens ?? null),
              cacheWriteTokens: usage.map((u) => u.cacheWriteTokens ?? null),
              requestIds: usage.map((u) => u.requestId ?? null),
            }
          : {}),
        ...(aborted ? { aborted: true } : {}),
      },
      'turn latency',
    );
  }

  /**
   * The greeting belongs in both records. In the transcript, so the call does
   * not open with the caller answering something nobody said. And in what the
   * model is told, so its first reply knows the caller has already been
   * welcomed — without that it greets them a second time in its own opening
   * words, which is what James got on the call of 2026-09-02.
   *
   * Told as a system line rather than pushed as an assistant turn for two
   * reasons. The Messages API requires the first message to be `user`, and the
   * greeting is spoken before the caller has said anything, so an assistant
   * turn here would be `messages[0]` and rejected outright. And system entries
   * are hoisted into the system prompt wherever they sit in the list, so a
   * caller who cuts the greeting off and gets answered before start() returns
   * cannot land their utterance ahead of it.
   *
   * What it reports is the part that played, not the part we synthesized: a
   * greeting the caller talked over is a greeting they half heard.
   */
  private recordGreeting(spans: SpokenSpan[]): void {
    const said = this.heardSoFar(spans);
    if (!said) return;
    this.deps.onTranscript?.({ text: said, isFinal: true }, 'agent');
    this.messages.push({
      role: 'system',
      content: `You have already greeted the caller — you opened the call with: "${said}" Do not greet them or welcome them back again; answer what they say next.`,
    });
  }

  /**
   * A turn the caller cut off still happened. Record the part of it that
   * reached them — in the transcript, so the call history is not missing the
   * half of a reply the caller is responding to, and in the model's own
   * history, so the next turn knows what it already said.
   */
  private recordInterrupted(spans: SpokenSpan[]): void {
    const said = this.heardSoFar(spans);
    if (!said) return;
    // Content only. Any tool calls this turn made never ran, and an assistant
    // tool call with no result is a conversation the provider rejects outright.
    this.messages.push({ role: 'assistant', content: said });
    this.deps.onTranscript?.({ text: said, isFinal: true }, 'agent');
  }

  /**
   * What the caller actually heard of an interrupted turn. Frames *sent* is the
   * honest measure, not frames synthesized: playout is paced 20 ms at a time, so
   * at the moment of a barge-in the pump can still be holding whole prefetched
   * sentences that never reached the caller's ear. The ellipsis marks the reply
   * as cut off rather than finished.
   */
  private heardSoFar(spans: SpokenSpan[]): string {
    const played = this.turnPlayedFrames;
    const heard = spans.filter((s) => s.startFrame < played);
    if (!heard.length) return '';
    const cutShort = heard.length < spans.length || heard[heard.length - 1]!.endFrame > played;
    const text = heard
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(' ');
    if (!text) return '';
    return cutShort ? `${text}…` : text;
  }

  private async executeTools(calls: LlmToolCall[], turn: AbortController): Promise<void> {
    // From here the turn has consequences — an order line added, an order
    // placed — so it is no longer something a later utterance may discard.
    this.turnRanTools = true;
    // A pass only needs answering if something in it has news for the caller.
    this.passNeedsNoReply = calls.length > 0;
    for (const [i, call] of calls.entries()) {
      if (turn.signal.aborted) {
        // The caller cut in, so the rest of the tools do not run — but every
        // call still needs an answer. Leaving one unanswered leaves a tool call
        // with no result in the history, which the provider rejects on the next
        // request: one barge-in mid-tool would take the whole call down.
        for (const unrun of calls.slice(i)) {
          this.messages.push({
            role: 'tool',
            toolCallId: unrun.id,
            content: 'Not run — the caller interrupted.',
          });
        }
        return;
      }
      if (call.name === 'switch_persona') {
        const name = typeof call.arguments.name === 'string' ? call.arguments.name.trim() : '';
        const next = name && this.deps.switchPersona ? await this.deps.switchPersona(this.deps.context, name) : null;
        if (next?.staffName) {
          this.becomePersona(next);
          this.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `You are now ${next.staffName}; the call was handed to you. Say hello briefly as ${next.staffName} and carry on with what the caller needs.`,
          });
        } else {
          this.deps.log.warn({ callId: this.callId, name }, 'persona not available');
          this.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: 'Nobody by that name can take the call; offer a transfer if one is listed, or take a message.',
          });
        }
        // Either way the caller is waiting on an answer: the new persona's
        // hello, or word that nobody by that name is here.
        this.passNeedsNoReply = false;
        continue;
      }
      if (call.name === 'transfer_call') {
        const target = this.resolveTransfer(call.arguments.target);
        if (target) {
          // REFER the caller to the chosen destination (SiphonAI §4.4). SiphonAI
          // then sends `stop { reason: "transfer" }` and closes the WS.
          this.deps.io.send({ type: 'transfer', target: target.sipUri });
          this.outcomes.push(`The call was TRANSFERRED to ${target.label}.`);
          this.setState('transferring');
          this.messages.push({ role: 'tool', toolCallId: call.id, content: `Connecting the caller to ${target.label} now.` });
        } else {
          this.deps.log.warn({ callId: this.callId, target: call.arguments.target }, 'unknown transfer target');
          this.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: 'That transfer option is not available; offer to take a message instead.',
          });
        }
        continue;
      }
      if (ORDER_TOOLS.has(call.name)) {
        // Order tools are engine-held: add/remove/review work on the in-memory
        // draft priced from this.menu; place_order persists via deps.placeOrder.
        const startedMs = nowMs();
        let content: string;
        try {
          content = await this.handleOrderTool(call);
        } catch (err) {
          this.deps.log.warn({ err, tool: call.name, callId: this.callId }, 'order tool failed');
          content = 'That could not be completed right now; offer to take a message for staff.';
        }
        // What the model asked for and what it was told, on every order tool.
        // Reading back the call of 2026-09-11 22:21 there was no way to tell
        // whether the bot had set the order to pickup or merely said so aloud:
        // the gates leave a debug line, the tools themselves left none.
        // Where the caller lives is theirs — the log says a field was given,
        // not what it said (rule #6).
        const logged = Object.fromEntries(
          Object.entries(call.arguments).map(([k, v]) =>
            ['line1', 'line2', 'city', 'postal_code', 'instructions', 'street_number'].includes(k)
              ? [k, '[given]']
              : [k, v],
          ),
        );
        // The other half of that: a result quotes the address back — "Delivering
        // to 15 Cook Circle…", "For delivery to …" — and on 2026-09-11 a guest's
        // home address reached Cloud Logging that way. The engine knows exactly
        // which strings are addresses, because it formatted them, so those come
        // out rather than anything that merely looks like one. Redacted before
        // the result is cut short: a truncated address would survive the cut.
        const addresses = [this.deliveryAddress, this.savedAddress, this.guest.savedAddress]
          .filter((a): a is DeliveryAddress => !!a)
          .flatMap((a) => [
            formatDeliveryAddress(a),
            [a.line1, a.line2].filter(Boolean).join(', '),
            a.line1,
          ])
          .filter((form) => form.length > 0);
        let safe = content;
        for (const form of addresses) safe = safe.split(form).join('[address]');
        this.deps.log.info(
          {
            callId: this.callId,
            turn: this.turnsAnswered,
            tool: call.name,
            args: logged,
            ms: Math.round(nowMs() - startedMs),
            // Enough of the answer to tell a refusal from a result.
            result: safe.length > 200 ? `${safe.slice(0, 200)}…` : safe,
          },
          'order tool',
        );
        this.messages.push({ role: 'tool', toolCallId: call.id, content });
        this.passNeedsNoReply &&= this.orderToolSpokeForItself;
        continue;
      }
      let result: string;
      try {
        result = this.deps.toolExecutor
          ? await this.deps.toolExecutor(call, this.deps.context)
          : 'That information is not available right now.';
      } catch (err) {
        this.deps.log.warn({ err, tool: call.name, callId: this.callId }, 'tool failed');
        result = 'That information is not available right now.';
      }
      if (call.name === 'take_message' && /^Message taken/.test(result)) {
        const from = typeof call.arguments.caller_name === 'string' && call.arguments.caller_name.trim();
        const body = typeof call.arguments.message === 'string' ? call.arguments.message.trim() : '';
        this.outcomes.push(`A MESSAGE was taken for staff${from ? ` from ${from}` : ''}: "${body}".`);
      }
      this.messages.push({ role: 'tool', toolCallId: call.id, content: result });
      this.passNeedsNoReply = false;
    }
  }

  /**
   * Run one order tool against the in-call draft. Pricing comes from this.menu
   * (loaded from the DB) — the LLM never computes a price (CLAUDE.md rule #5).
   * Returns a short, speakable result for the LLM to relay.
   */
  private async handleOrderTool(call: LlmToolCall): Promise<string> {
    // Assume the answer is for the model to relay. Only the three tools that
    // simply change the order, and only when they succeed, opt out below.
    this.orderToolSpokeForItself = false;
    this.pendingAck = null;
    switch (call.name) {
      case 'suggest_upsell': {
        if (!this.deps.loadUpsells || !this.order.length) {
          return 'There is nothing to suggest yet — take the order first.';
        }
        const suggestions = await this.deps
          .loadUpsells(
            this.deps.context,
            this.order.map((l) => ({ menuItemId: l.menuItemId, name: l.name })),
          )
          .catch((err) => {
            this.deps.log.warn({ err, callId: this.callId }, 'loadUpsells failed');
            return [] as UpsellSuggestion[];
          });
        if (!suggestions.length) return 'No add-ons to suggest for this order.';
        for (const s of suggestions) this.suggestedItemIds.add(s.menuItemId);
        return [
          'Add-ons you may offer (pick ONE, use these exact names and prices):',
          ...suggestions.map((s) => `- ${s.name} at ${money(s.priceCents)}`),
        ].join('\n');
      }
      case 'add_item': {
        const itemArg = typeof call.arguments.item === 'string' ? call.arguments.item : '';
        const match = this.matchMenuItem(itemArg);
        if (!match.item) {
          if (match.candidates?.length) {
            // The options the name itself asked for go back too, so asking
            // which size does not lose the topping that prompted the question.
            const carried = match.modifiers?.length
              ? ` Keep ${match.modifiers.join(', ')} as the option when you add it.`
              : '';
            return `Several items match "${itemArg}": ${match.candidates
              .map((c) => c.name)
              .join(', ')}. Ask the caller which one they mean.${carried}`;
          }
          // Counted before it is turned down: a thing asked for and not sold is
          // the only evidence a restaurant gets that it might want to sell it.
          this.noteMenuGap({ kind: 'item', term: itemArg });
          return `"${itemArg}" is not on the menu. Tell the caller and offer the closest available item.`;
        }
        const rawQty = call.arguments.quantity;
        const quantity =
          typeof rawQty === 'number' && Number.isFinite(rawQty) && rawQty >= 1 ? Math.floor(rawQty) : 1;
        const asked =
          typeof call.arguments.special_instructions === 'string' &&
          call.arguments.special_instructions.trim()
            ? call.arguments.special_instructions.trim()
            : undefined;
        // Options the item's name asked for ("a sausage pizza") count the same
        // as options the caller listed; the name is how they listed them.
        const named = Array.isArray(call.arguments.modifiers)
          ? [...(match.modifiers ?? []), ...call.arguments.modifiers]
          : (match.modifiers ?? call.arguments.modifiers);
        const whole = this.matchModifiers(match.item, named);
        const left = this.matchModifiers(match.item, call.arguments.left_half, 'left');
        const right = this.matchModifiers(match.item, call.arguments.right_half, 'right');
        const notHalvable = [...left.notHalvable, ...right.notHalvable];
        if (notHalvable.length) {
          // Nothing is added: a half the kitchen cannot make must not become a
          // whole the caller did not ask for (never add a paid option unasked).
          return cannotHalve(match.item.name, notHalvable);
        }
        const chosen = [...whole.chosen, ...left.chosen, ...right.chosen];
        const unknown = [...whole.unknown, ...left.unknown, ...right.unknown];
        const overLimit = tooManyChoices(match.item, chosen, [], asked ?? '');
        if (overLimit) return overLimit;
        // An option the item does not list is kept as a special request, never
        // dropped. Most menus are missing groups the kitchen makes anyway: on a
        // real call (2026-08-31) the caller asked for BBQ wings, the menu had no
        // sauce group at all, and "barbecue" left the order entirely while the
        // bot confirmed it aloud. Free text on the ticket is ugly; a ticket that
        // has lost what the caller asked for is wrong.
        const si =
          [asked, ...unknown].filter(Boolean).join('; ').slice(0, MAX_SPECIAL_INSTRUCTIONS) ||
          undefined;
        const line: OrderLine = {
          menuItemId: match.item.id,
          name: match.item.name,
          quantity,
          unitPriceCents: match.item.priceCents,
          specialInstructions: si,
          // Attribution from what we actually offered, not from what the model
          // says it was doing.
          viaUpsell:
            (match.item.id && this.suggestedItemIds.has(match.item.id)) || undefined,
        };
        this.applyModifiers(line, match.item, chosen);
        this.order.push(line);
        this.setState('collecting_order');
        const withOpts = describeModifiers(line.modifiers, (n) => n);
        // Said out loud too, so the model knows it is a note to the kitchen
        // rather than a priced choice, and can offer the real ones if it has
        // them. It is on the ticket either way.
        // The ranch case: the kitchen will make it, the menu cannot price it,
        // and the restaurant should be told it keeps being asked for.
        for (const u of unknown) {
          this.noteMenuGap({ kind: 'option', term: u, onItem: match.item.name });
        }
        const missed = unknown.length
          ? ` ${match.item.name} has no listed option for "${unknown.join('", "')}", so ${
              unknown.length > 1 ? 'they are' : 'it is'
            } noted as a special request on the line.`
          : '';
        // Nothing here the caller has not already been told: the reply that
        // asked for this tool announced it. An option the menu could not price
        // is the exception — that one has to be said out loud.
        this.orderToolSpokeForItself = !missed;
        // No article: menu names are plural as often as not, and "one Boneless
        // Wings" is worse than saying nothing about the count at all. A count
        // only appears when there is more than one.
        this.pendingAck = `Got it — ${quantity > 1 ? `${spokenCount(quantity)} ` : ''}${spokenItem(
          match.item.name,
        )}${describeModifiers(line.modifiers, spokenOption)}. Anything else?`;
        return `Added ${quantity} ${match.item.name}${withOpts} at ${money(
          this.lineUnitCents(this.order[this.order.length - 1]!),
        )} each${si ? ` (${si})` : ''}. The order total is now ${money(this.orderTotal())}.${missed}`;
      }
      case 'update_item': {
        // A request that lands after the item is already on the order — "ranch
        // on the side", "actually make that mild". Without this the model had
        // nowhere to put it: special_instructions can only be set by add_item,
        // and on a live call (2026-08-31) it reached for create_call_note
        // instead, which files a message for staff and leaves the ticket
        // saying nothing about the ranch the caller asked for.
        const itemArg = typeof call.arguments.item === 'string' ? call.arguments.item : '';
        const idx = this.findOrderLine(itemArg);
        if (idx < 0) {
          return `There is no "${itemArg}" on the order yet — add it with add_item first.`;
        }
        const line = this.order[idx]!;
        const menuItem = this.menu.find((m) =>
          line.menuItemId ? m.id === line.menuItemId : m.name === line.name,
        );
        const whole = this.matchModifiers(menuItem, call.arguments.modifiers);
        const left = this.matchModifiers(menuItem, call.arguments.left_half, 'left');
        const right = this.matchModifiers(menuItem, call.arguments.right_half, 'right');
        const notHalvable = [...left.notHalvable, ...right.notHalvable];
        if (notHalvable.length) return cannotHalve(line.name, notHalvable);
        const chosen = [...whole.chosen, ...left.chosen, ...right.chosen];
        const unknown = [...whole.unknown, ...left.unknown, ...right.unknown];
        const asked =
          typeof call.arguments.special_instructions === 'string'
            ? call.arguments.special_instructions.trim()
            : '';
        const overLimit = menuItem ? tooManyChoices(menuItem, chosen, line.modifiers ?? [], asked) : null;
        if (overLimit) return overLimit;
        // Asking for the option the line already carries is not a change to it.
        // Wings come with a dip, and a caller who asks for "another ranch" has
        // two ways to be understood: add_item, which reaches the priced side,
        // or this, which does not. Applied, the single-select rule replaces
        // Ranch with Ranch — no change, no charge, and a tool result reading
        // "Added Ranch. Removed Ranch, since only one may be chosen." So the
        // request is turned down here and sent to the tool that can price it.
        // Only when nothing else was asked: a repeat option alongside "no
        // onions" is a real change carrying a redundancy, not a request for
        // a second helping.
        const already =
          chosen.length > 0 &&
          !asked &&
          unknown.length === 0 &&
          chosen.every((c) => (line.modifiers ?? []).some((m) => sameChoice(m, c)));
        if (already) {
          const names = chosen.map((c) => modifierLabel(c)).join(', ');
          return (
            `${line.name} already has ${names}, so nothing changed. If the caller wants another ` +
            `one, that is a separate item — call add_item for it, since a second serving is its ` +
            `own line and its own price. If they meant a different option, name that one instead.`
          );
        }
        for (const u of unknown) {
          this.noteMenuGap({ kind: 'option', term: u, onItem: line.name });
        }
        const { added, replaced } = this.applyModifiers(line, menuItem, chosen);
        // A note that only narrates the swap the option change already made —
        // "Sauce changed from Garlic Parmesan to BBQ", on the call of
        // 2026-09-04 18:01 — says nothing the ticket does not, and puts the
        // kitchen's eye on a sentence it has to parse to find out it can be
        // ignored. Dropped when it names both the option that left and the
        // one that arrived; anything else the caller asked for is kept.
        const narratesSwap =
          !!asked &&
          replaced.some((r) => mentionsOption(asked, r.name)) &&
          added.some((a) => mentionsOption(asked, a.name));
        const request = narratesSwap ? '' : asked;
        // Added to what the line already carries, never replacing it: two
        // requests for one item are two requests.
        line.specialInstructions =
          [line.specialInstructions, request, ...unknown]
            .filter(Boolean)
            .join('; ')
            .slice(0, MAX_SPECIAL_INSTRUCTIONS) || undefined;
        const gained = added.length ? ` Added ${added.map((m) => modifierLabel(m)).join(', ')}.` : '';
        // Spoken back, because the model reported a switch that had not
        // happened the last time this went wrong.
        const dropped = replaced.length
          ? ` Removed ${replaced.map((m) => m.name).join(', ')}, since only one may be chosen.`
          : '';
        const noted =
          request || unknown.length ? ` Noted "${[request, ...unknown].filter(Boolean).join('; ')}".` : '';
        // A swap the caller did not ask for is news; a plain update is not.
        this.orderToolSpokeForItself = !dropped;
        this.pendingAck = `Done — ${spokenItem(line.name)}${describeModifiers(
          line.modifiers,
          spokenOption,
        )}. Anything else?`;
        return `Updated ${line.name}.${gained}${dropped}${noted} The order total is now ${money(
          this.orderTotal(),
        )}.`;
      }
      case 'remove_item': {
        const itemArg = typeof call.arguments.item === 'string' ? call.arguments.item : '';
        const idx = this.findOrderLine(itemArg);
        if (idx < 0) return `There is no "${itemArg}" on the order.`;
        const [removed] = this.order.splice(idx, 1);
        this.orderToolSpokeForItself = true;
        this.pendingAck = `Taken off — ${spokenItem(removed?.name ?? 'that item')}. Anything else?`;
        return `Removed ${removed?.name ?? 'the item'}. ${
          this.order.length ? `The order total is now ${money(this.orderTotal())}.` : 'The order is now empty.'
        }`;
      }
      case 'set_fulfillment': {
        const type =
          call.arguments.type === 'delivery' ? 'delivery' : call.arguments.type === 'pickup' ? 'pickup' : null;
        if (!type) return 'Pass type "pickup" or "delivery" — ask the caller which it is.';
        if (!this.offers[type]) {
          return type === 'delivery'
            ? 'This restaurant does not deliver — pickup only. Tell the caller, and ask whether pickup works for them.'
            : 'This restaurant does not do pickup — delivery only. Tell the caller, and take a delivery address.';
        }
        // Which one it is comes from the caller, never from the model's
        // assumption. On the call of 2026-09-11 22:21 the bot announced "Great,
        // this'll be a pickup order" without asking, and the caller had to
        // correct it into a delivery. A restaurant that only does one is preset
        // at the start of the call and never reaches this.
        if (this.offers.pickup && this.offers.delivery && !this.fulfillmentSaidOrAsked()) {
          this.deps.log.debug(
            { callId: this.callId, type },
            'set_fulfillment held: the caller has not said and has not been asked',
          );
          return (
            'Not set — the caller has not said whether this is for pickup or delivery, and it must ' +
            'not be assumed. Ask them "Is this for pickup or delivery?", and call set_fulfillment ' +
            'with the answer they give.'
          );
        }
        // A change of mind after the read-back changes the total (the fee), so
        // it has to be read back again before it can be placed.
        if (this.fulfillment !== type) this.reviewedOnTurn = -1;
        this.fulfillment = type;
        if (type === 'pickup') {
          // A booked time is the promise; a wait in minutes beside it
          // contradicts it (said by this tool on every scheduled call of
          // 2026-09-14, after the time had been agreed).
          return this.scheduledFor
            ? `Pickup — ready ${this.scheduledFor.spoken}, as booked.`
            : `Pickup — it will be ready about ${this.etaMinutes.pickup} minutes after the order is placed.`;
        }
        return `Delivery.${this.deliveryTermsNote()} ${this.deliveryNextStep()}`;
      }
      case 'set_delivery_address': {
        if (!this.offers.delivery) return 'This restaurant does not deliver — pickup only. Tell the caller.';
        const text = (key: string): string | undefined => {
          const v = call.arguments[key];
          return typeof v === 'string' && v.trim() ? v.trim() : undefined;
        };
        const line1 = text('line1');
        if (!line1 || line1.length < 3) return 'Ask the caller for the street number and street.';
        return this.acceptDeliveryAddress({
          line1,
          line2: text('line2'),
          city: text('city'),
          postalCode: text('postal_code'),
          instructions: text('instructions'),
        });
      }
      case 'use_saved_address': {
        if (!this.offers.delivery) return 'This restaurant does not deliver — pickup only. Tell the caller.';
        if (!this.savedAddress) {
          return this.guest.hasSavedAddress && this.guest.mode === 'confirm'
            ? 'Not yet — the saved address has not been confirmed, and you must not say or hint at it. ' +
                'Ask "Can you confirm the street number on your usual delivery address?" and pass the ' +
                'answer to confirm_saved_address, or take a new address.'
            : 'There is no saved address. Ask the caller for the delivery address.';
        }
        return this.acceptDeliveryAddress(this.savedAddress);
      }
      case 'confirm_saved_address': {
        if (!this.offers.delivery) return 'This restaurant does not deliver — pickup only. Tell the caller.';
        const raw = call.arguments.street_number;
        const streetNumber = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
        if (!streetNumber) return 'Ask the caller for the street number on their usual delivery address.';
        // Already known (full memory mode, or confirmed earlier in the call).
        if (this.savedAddress) return this.acceptDeliveryAddress(this.savedAddress);
        const unavailable =
          'The saved address cannot be checked right now. Do not guess it — ask for the delivery address.';
        if (!this.deps.confirmSavedAddress) return unavailable;
        const res = await this.deps.confirmSavedAddress(this.deps.context, streetNumber).catch(() => null);
        if (!res) return unavailable;
        if (res.confirmed && res.address) {
          this.savedAddress = res.address;
          return this.acceptDeliveryAddress(res.address);
        }
        this.deps.log.debug(
          { callId: this.callId, reason: res.reason, attemptsLeft: res.attemptsLeft },
          'saved address not confirmed',
        );
        switch (res.reason) {
          case 'unreadable':
            return 'Pass the street number as digits, e.g. "12".';
          case 'mismatch':
            return res.attemptsLeft
              ? 'That does not match the saved address. Do not say or hint at what it is. Ask them to ' +
                  'try the number once more, or to give the full delivery address.'
              : 'That does not match the saved address, and it cannot be offered again on this call. ' +
                  'Do not say or hint at it — ask for the full delivery address.';
          case 'locked':
            return 'The saved address cannot be used on this call. Do not say or hint at it — ask for the full delivery address.';
          default:
            return 'There is no saved address to use. Ask the caller for the delivery address.';
        }
      }
      case 'lookup_recent_order': {
        if (!this.deps.loadRecentOrder)
          return 'Changing an order already placed is not available on this call. Offer to take a message for staff.';
        const found = await this.deps.loadRecentOrder(this.deps.context);
        if (!found)
          return 'I could not look that up just now. Apologize, and offer to take a message for staff.';
        if (!found.found) {
          switch (found.reason) {
            case 'locked':
              return (
                `That order is already ${found.status ?? 'with the kitchen'}, so it cannot be changed from here. ` +
                'Tell the caller it is already being made, and offer to take a message for staff.'
              );
            case 'memory_off':
            case 'unknown_caller':
            case 'none':
            default:
              return (
                'There is no recent order for this number that can still be changed. Say so plainly, ' +
                'and offer to take a message for staff.'
              );
          }
        }
        if (found.needsCode) {
          return (
            'There is a recent order, but do not say anything about it yet. Ask the caller for the ' +
            'confirmation code they were given when they ordered, and call confirm_order_code with it.'
          );
        }
        this.recentOrder = found;
        return this.describeRecentOrder(found);
      }
      case 'confirm_order_code': {
        if (!this.deps.confirmRecentOrder)
          return 'Confirming an order is not available on this call. Offer to take a message for staff.';
        const code = typeof call.arguments.code === 'string' ? call.arguments.code.trim() : '';
        if (!code) return 'Ask the caller for the confirmation code and pass it as `code`.';
        const answer = await this.deps.confirmRecentOrder(this.deps.context, code);
        if (!answer)
          return 'I could not check that code just now. Apologize, and offer to take a message for staff.';
        if (!answer.confirmed) {
          if (answer.reason === 'locked' || answer.attemptsLeft === 0) {
            return (
              'That code does not match, and the order cannot be looked up again on this call. Do not ' +
              'say anything about it. Offer to take a message for staff instead.'
            );
          }
          return (
            'That code does not match. Do not say or hint at anything about the order. Ask them to ' +
            'read the code again, or offer to take a message for staff.'
          );
        }
        const order = answer as unknown as Extract<RecentOrder, { needsCode: false }>;
        this.recentOrder = order;
        return this.describeRecentOrder(order);
      }
      case 'change_order': {
        const order = this.recentOrder;
        if (!order)
          return 'Look the order up first with lookup_recent_order — nothing can be changed until it is found.';
        // The draft becomes the order as it stands, so every tool the caller
        // used the first time works the same way now.
        this.order = order.items.map((i) => ({
          menuItemId: i.menuItemId ?? undefined,
          name: i.name,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          specialInstructions: i.specialInstructions ?? undefined,
          modifiers: i.modifiers
            .filter((m) => !!m.modifierId)
            .map((m) => ({
              id: m.modifierId as string,
              name: m.name,
              priceCents: m.priceCents,
              portion: (m.portion === 'left' || m.portion === 'right' ? m.portion : 'whole') as ModifierPortion,
            })),
        }));
        this.amendingOrderId = order.orderId;
        this.orderName = order.customerName ?? this.orderName;
        this.fulfillment = order.fulfillmentType === 'delivery' ? 'delivery' : 'pickup';
        // Whatever was read back before belongs to the order as it was.
        this.reviewedOnTurn = -1;
        this.suggestedItemIds.clear();
        return (
          `Order #${order.orderCode} is open for changes. Add or remove items exactly as you would on a ` +
          'new order, then call review_order to read the whole thing back, and place_order to save it. ' +
          'Where it is going, the name on it and any time it was booked for stay as they are — if the ' +
          'caller wants those changed, take a message instead.'
        );
      }
      case 'cancel_order': {
        const order = this.recentOrder;
        if (!order)
          return 'Look the order up first with lookup_recent_order — nothing can be canceled until it is found.';
        if (!this.deps.cancelOrder)
          return 'Canceling is not available on this call. Offer to take a message for staff.';
        const done = await this.deps.cancelOrder(this.deps.context, order.orderId);
        if (done && !done.ok && done.code === 'order_locked') {
          this.outcomes.push(
            `The caller asked to cancel order #${order.orderCode}. The cancel was REFUSED because the kitchen had already accepted it. The order stands.`,
          );
          this.abandonChange();
          return (
            'That order is already with the kitchen, so it cannot be canceled now. Tell the caller, ' +
            'and offer to take a message for staff.'
          );
        }
        if (done && !done.ok && done.code === 'order_changed') {
          this.abandonChange();
          return ORDER_CHANGED_UNDERFOOT;
        }
        if (!done?.ok)
          return (
            'I could not cancel it just now — it may already be with the kitchen. Apologize, and offer ' +
            'to take a message for staff.'
          );
        this.outcomes.push(`Order #${order.orderCode} was CANCELED.`);
        this.order = [];
        this.amendingOrderId = null;
        this.recentOrder = null;
        return (
          `Order #${order.orderCode} is canceled. Tell the caller it is canceled and nothing will be made` +
          `${order.posTicket ? ', and that the restaurant has been told' : ''}.`
        );
      }
      case 'schedule_order': {
        if (!this.deps.scheduleOrder)
          return 'Orders for a later time are not available on this call. Offer what you can do now, or take a message.';
        const time = typeof call.arguments.time === 'string' ? call.arguments.time.trim() : '';
        const day = typeof call.arguments.day === 'string' ? call.arguments.day.trim() : undefined;
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
          return 'Pass the time as a 24-hour clock time, HH:MM — six in the evening is "18:00".';
        const answer = await this.deps.scheduleOrder(this.deps.context, { time, day: day || undefined });
        if (!answer)
          return 'I could not check that time just now. Apologize, and offer to take a message for staff.';
        if (answer.ok) {
          this.scheduledFor = { at: answer.scheduledFor, spoken: answer.spoken };
          // The read-back is what the caller agrees to, and it now says a
          // different thing than it did — so it has to happen again.
          this.reviewedOnTurn = -1;
          return `That time works: ${answer.spoken}. Confirm it back to the caller and carry on with the order.`;
        }
        this.scheduledFor = null;
        const earliest = answer.earliest ? ` The earliest that works is ${answer.earliest.spoken}.` : '';
        switch (answer.reason) {
          case 'disabled':
            return 'This restaurant does not take orders for a later time. Do not offer one — offer what you can do now, or take a message.';
          case 'closed_then':
            return (
              `The restaurant is closed at that time.${earliest} Tell the caller that, offer the ` +
              `earliest time, and call schedule_order again with whatever they choose.`
            );
          case 'too_soon':
            return (
              `That is sooner than the kitchen can have it ready.${earliest} Offer that instead and ` +
              'call schedule_order again with what they agree to.'
            );
          case 'too_far':
            return answer.latest
              ? 'That is further ahead than this restaurant takes orders. The furthest ahead it can ' +
                  `do is ${answer.latest.spoken} — offer that, and call schedule_order again with ` +
                  'what they agree to.'
              : 'That is further ahead than this restaurant takes orders. Say you can only take it ' +
                  `nearer the time.${earliest}`;
          case 'past':
            return `That time has already gone by.${earliest} Ask which time they meant.`;
          default:
            return `I could not book that time.${earliest} Offer the earliest one, or take a message.`;
        }
      }
      case 'review_order': {
        if (!this.order.length) return 'The order is empty so far — nothing has been added yet.';
        this.takeOrderName(call.arguments.customer_name);
        const nameless = this.unnamedOrder();
        if (nameless) return nameless;
        const unfulfilled = this.unfulfilledOrder();
        if (unfulfilled) return unfulfilled;
        const missingChoice = this.unchosenRequired();
        if (missingChoice) return missingChoice;
        const lines = this.order.map(
          (l) =>
            `${l.quantity} ${l.name}${describeModifiers(l.modifiers, (n) => n)}${this.describeUnchosen(
              l,
            )}${l.specialInstructions ? ` (${l.specialInstructions})` : ''} — ${money(
              this.lineUnitCents(l) * l.quantity,
            )}`,
        );
        // The read-back happens in this turn, so place_order cannot also happen
        // in it: the caller has to be given a turn to answer in between.
        this.reviewedOnTurn = this.turnsAnswered;
        const dropOff = this.fulfillment === 'delivery' ? this.deliveryAddress : null;
        const fee = dropOff ? this.deliveryTerms.feeCents : 0;
        const feeLine = fee > 0 ? ` Delivery fee ${money(fee)}.` : '';
        const where = dropOff ? ` For delivery to ${formatDeliveryAddress(dropOff)}.` : '';
        // Only a restaurant that does both says which in the question; a
        // pickup-only read-back is word for word what it always was.
        const how = this.offers.pickup && this.offers.delivery ? ` for ${this.fulfillment}` : '';
        // A time the caller asked for is part of what they are agreeing to: it
        // is read back with the order, never left to the end.
        const when = this.scheduledFor ? ` For ${this.scheduledFor.spoken}.` : '';
        // A change is agreed to in its own words: "place the order" invites a
        // second dinner, which is the one mistake this whole path must not make.
        if (this.amendingOrderId) {
          return (
            `The changed order: ${lines.join('; ')}. Total ${money(this.orderTotal() + fee)}. ` +
            'Read that back as what the order will now be, and end with exactly this question: ' +
            '"Should I save that change?"'
          );
        }
        return (
          `Current order: ${lines.join('; ')}.${feeLine} Total ${money(this.orderTotal() + fee)}.${where}${when} ` +
          `Under the name ${this.orderName}. Read that back and end with exactly this question: ` +
          `"Should I go ahead and place the order${how} under ${this.orderName}?"`
        );
      }
      case 'place_order': {
        if (!this.order.length) return 'There are no items on the order yet, so there is nothing to place.';
        this.takeOrderName(call.arguments.customer_name);
        const nameless = this.unnamedOrder();
        if (nameless) return nameless;
        const unfulfilled = this.unfulfilledOrder();
        if (unfulfilled) return unfulfilled;
        const missingChoice = this.unchosenRequired();
        if (missingChoice) return missingChoice;
        const ungated = this.unconfirmedOrder();
        if (ungated) return ungated;
        // The kitchen is dark: the only order that can be taken is one for
        // later. The API refuses this too (rule #5) — this is the engine not
        // spending a caller's turn on a request it knows will fail.
        if (this.hours.announceClosed && !this.scheduledFor) {
          this.deps.log.info({ callId: this.callId }, 'place_order held: the restaurant is closed');
          return this.hours.scheduling.enabled
            ? 'Not placed — the restaurant is closed right now. Ask what time they would like it — do ' +
                'not suggest one, the tool says what works — and call schedule_order with their answer.'
            : 'Not placed — the restaurant is closed right now and cannot take an order for later. ' +
                'Say so, and offer to take a message for staff.';
        }
        // Changing an order already placed: save it back, never create a
        // second one.
        if (this.amendingOrderId) {
          if (!this.deps.changeOrder)
            return 'Changing the order is not available right now; offer to take a message for staff.';
          const orderId = this.amendingOrderId;
          const changing = this.recentOrder?.orderCode ? `order #${this.recentOrder.orderCode}` : 'their earlier order';
          const proposed = this.describeLinesForRecord();
          const saved = await this.deps.changeOrder(this.deps.context, orderId, this.order);
          if (!saved)
            return 'I could not save the change just now. Apologize, and offer to take a message for staff.';
          if (!saved.ok) {
            // The API's reasons are things the caller needs told, not errors to
            // swallow: the kitchen has it, or it would fall under the minimum.
            this.deps.log.info({ callId: this.callId, code: saved.code }, 'order change refused');
            // Either way the draft is let go, not just the order id: a draft
            // left behind with nothing to save it to would be placed as a
            // second order by the next place_order.
            if (saved.code === 'order_locked' || saved.code === 'order_status_final') {
              this.outcomes.push(
                `The caller asked to change ${changing} to: ${proposed}. The change was REFUSED because the kitchen had already accepted the order. Nothing was changed.`,
              );
              this.abandonChange();
              return (
                'That order is already with the kitchen, so it cannot be changed now. Tell the caller, ' +
                'and offer to take a message for staff.'
              );
            }
            // Something else changed it after it was read to the caller — the
            // kitchen taking it, or a change from another call. What they
            // agreed to is no longer what is there.
            if (saved.code === 'order_changed') {
              this.outcomes.push(
                `A change to ${changing} was NOT saved: the order had changed since it was read to the caller. Nothing was changed.`,
              );
              this.abandonChange();
              return ORDER_CHANGED_UNDERFOOT;
            }
            this.outcomes.push(`A change to ${changing} was NOT saved: ${saved.message}`);
            return `${saved.message} Tell the caller that, and ask what they would like to do.`;
          }
          this.outcomes.push(
            `Order #${saved.orderCode} was CHANGED and saved. It is now: ${proposed}. New total ${money(saved.totalCents)}.`,
          );
          this.order = [];
          this.amendingOrderId = null;
          this.recentOrder = null;
          this.reviewedOnTurn = -1;
          return (
            `Saved. Order ${spellCode(saved.orderCode)} is now ${money(saved.totalCents)}. Tell the caller ` +
            'the change is made and give them the new total. Do not read the confirmation code again ' +
            'unless they ask — they already have it.'
          );
        }
        if (!this.deps.placeOrder)
          return 'Order submission is not available right now; offer to take a message for staff.';
        const customerName = this.orderName;
        const redeemReward = call.arguments.redeem_reward === true;
        const promotionCode =
          typeof call.arguments.promotion_code === 'string'
            ? call.arguments.promotion_code.trim() || undefined
            : undefined;
        const fulfillmentType = this.fulfillment ?? 'pickup';
        const result = await this.deps.placeOrder(this.deps.context, this.order, {
          customerName,
          redeemReward,
          promotionCode,
          fulfillmentType,
          deliveryAddress: fulfillmentType === 'delivery' ? (this.deliveryAddress ?? undefined) : undefined,
          scheduledFor: this.scheduledFor?.at,
        });
        if (!result)
          return 'I could not submit the order just now. Apologize and offer to take a message for staff.';
        // The menu's option rules, which the API holds the order to: a choice
        // still to make, or more picked than the item takes. Something to sort
        // out with the caller, not a reason to give up on the order.
        if ('refused' in result) {
          this.deps.log.info(
            { callId: this.callId, code: result.refused.code },
            'order refused by the menu option rules',
          );
          this.reviewedOnTurn = -1;
          return (
            `Not placed — ${result.refused.message}. Sort that choice out with the caller, ` +
            'update the item, and read the order back again before placing it.'
          );
        }
        this.outcomes.push(
          `Order #${result.orderCode} was PLACED for ${fulfillmentType}` +
            `${this.scheduledFor ? `, booked for ${result.scheduledSpoken ?? this.scheduledFor.spoken}` : ''}` +
            ` under ${customerName}: ${this.describeLinesForRecord()}. Total ${money(result.totalCents)}.`,
        );
        this.order = [];
        this.reviewedOnTurn = -1; // a second order in the same call is read back again
        // Kept for the line below, then cleared: a second order in this call
        // is not for the first one's time.
        const bookedFor = this.scheduledFor?.spoken ?? null;
        this.scheduledFor = null;
        this.pendingOrderCode = result.orderCode;
        // One offer per call, for the first order placed on it.
        if (this.offerOrderTexts && this.deps.recordOrderTextConsent && !this.textOffer) {
          this.pendingTextOffer = result.orderCode;
        }
        const extras: string[] = [];
        if (result.discountCents && result.discountCents > 0)
          extras.push(`A loyalty reward of ${money(result.discountCents)} was applied.`);
        if (result.birthdayBonusPoints && result.birthdayBonusPoints > 0)
          extras.push(
            `A birthday bonus of ${result.birthdayBonusPoints} points was added — wish them a happy birthday.`,
          );
        if (result.winbackBonusPoints && result.winbackBonusPoints > 0)
          extras.push(
            `A welcome-back bonus of ${result.winbackBonusPoints} points was added — tell them it's great to have them back.`,
          );
        const extra = extras.length ? ` ${extras.join(' ')}` : '';
        // The location's own figure, from its settings — the API's answer on
        // this order, else what the profile said at the start of the call.
        const eta = result.etaMinutes ?? this.etaMinutes[fulfillmentType];
        // An order for later is quoted by its time. "Ready in about twenty
        // minutes" would be a second, contradictory promise.
        const scheduled = result.scheduledSpoken ?? bookedFor;
        const when = scheduled
          ? fulfillmentType === 'delivery'
            ? `it will be delivered ${scheduled}`
            : `it will be ready for pickup ${scheduled}`
          : fulfillmentType === 'delivery'
            ? `it will be delivered in about ${eta} minutes`
            : `it will be ready for pickup in about ${eta} minutes`;
        // The engine asks about a text right after this reply; a goodbye first
        // would put a question after "thanks for calling, see you soon".
        const more = this.pendingTextOffer
          ? ' Do not thank them for calling or say goodbye: the system asks them one more question right after you.'
          : '';
        return `Order placed. Confirmation code ${spellCode(result.orderCode)}, total ${money(
          result.totalCents,
        )}.${extra} Tell the caller ${when}.${more}`;
      }
      case 'order_text_updates': {
        const offer = this.textOffer;
        if (!offer || offer.answered) return 'No text offer is waiting for an answer. Carry on.';
        // The question has to have been heard and answered: a yes the model
        // infers before the caller has spoken is not the caller's yes.
        if (this.turnsAnswered <= offer.askedOnTurn) {
          return 'The caller has not answered the text question yet. Wait for their answer.';
        }
        const lastWords = [...this.messages].reverse().find((m) => m.role === 'user')?.content;
        offer.answered = true;
        if (call.arguments.agreed !== true) {
          this.outcomes.push(`The caller DECLINED a text when order #${offer.orderCode} is ready.`);
          return 'No texts. Say that is fine, and ask if there is anything else.';
        }
        const ok = await this.deps.recordOrderTextConsent!(this.deps.context, {
          orderCode: offer.orderCode,
          callerWords: lastWords,
        });
        if (!ok) return 'Texts could not be set up just now. Say so briefly, and ask if there is anything else.';
        this.outcomes.push(`The caller AGREED to a text when order #${offer.orderCode} is ready.`);
        return 'Done: they will get a text when the order is ready. Say so in a few words, and ask if there is anything else.';
      }
      default:
        return `Unknown tool: ${call.name}.`;
    }
  }

  /**
   * Put an address through the delivery-area check and, if it passes, make it
   * where this order goes. The API decides (ZIP list or radius); the engine
   * relays the answer. A check that cannot be made takes the address anyway —
   * the order route checks again when the order is placed, and a failed lookup
   * must not cost the caller their order.
   */
  private async acceptDeliveryAddress(address: DeliveryAddress): Promise<string> {
    const check = this.deps.checkDelivery
      ? await this.deps.checkDelivery(this.deps.context, address).catch(() => null)
      : null;
    if (check) {
      this.deliveryTerms = { feeCents: check.feeCents, minimumCents: check.minimumCents };
      this.etaMinutes.delivery = check.etaMinutes;
      if (check.check === 'delivery_off') {
        this.offers = { pickup: true, delivery: false };
        this.fulfillment = null;
        return 'This restaurant is not taking deliveries right now — pickup only. Tell the caller, and ask whether pickup works.';
      }
      if (check.check === 'needs_zip') {
        return (
          'Ask the caller for the ZIP code of that address, then call set_delivery_address again ' +
          'with the whole address and the ZIP code.'
        );
      }
      if (!check.deliverable) {
        const far =
          check.distanceMiles != null
            ? ` It is about ${check.distanceMiles} miles away${
                check.radiusMiles ? `, and delivery goes up to ${check.radiusMiles} miles` : ''
              }.`
            : '';
        return (
          `That address is outside the delivery area.${far} Tell the caller, and offer pickup or a ` +
          'different address instead. Do not place a delivery to it.'
        );
      }
    }
    const next: DeliveryAddress = { ...address, postalCode: address.postalCode ?? check?.postalCode ?? undefined };
    // A different address after the read-back is a different order to confirm.
    if (this.deliveryAddress && formatDeliveryAddress(this.deliveryAddress) !== formatDeliveryAddress(next)) {
      this.reviewedOnTurn = -1;
    }
    this.deliveryAddress = next;
    if (this.fulfillment !== 'delivery') this.reviewedOnTurn = -1;
    this.fulfillment = 'delivery';
    const short = this.orderTotal() < this.deliveryTerms.minimumCents;
    const minimum =
      this.deliveryTerms.minimumCents > 0 && this.order.length && short
        ? ` Delivery needs at least ${money(this.deliveryTerms.minimumCents)} of food before the fee; the order is ${money(this.orderTotal())} so far.`
        : '';
    return `Delivering to ${formatDeliveryAddress(next)}.${minimum} Carry on with the order.`;
  }

  /** The fee, minimum and time, for the model to mention when it matters. */
  private deliveryTermsNote(): string {
    const parts: string[] = [];
    if (this.deliveryTerms.feeCents > 0) parts.push(`delivery fee ${money(this.deliveryTerms.feeCents)}`);
    if (this.deliveryTerms.minimumCents > 0) {
      parts.push(`minimum ${money(this.deliveryTerms.minimumCents)} of food before the fee`);
    }
    parts.push(this.scheduledFor ? `delivered ${this.scheduledFor.spoken}, as booked` : `about ${this.etaMinutes.delivery} minutes`);
    return ` (${parts.join('; ')}.)`;
  }

  /** After "delivery": what to ask, given what is known — and allowed to be said — about where they live. */
  private deliveryNextStep(): string {
    if (this.deliveryAddress) return `The address is set: ${formatDeliveryAddress(this.deliveryAddress)}.`;
    if (this.savedAddress) {
      const where = [this.savedAddress.line1, this.savedAddress.line2].filter(Boolean).join(', ');
      return (
        `They have a saved address: ${formatDeliveryAddress(this.savedAddress)}. Ask exactly: ` +
        `"Are we still delivering to ${where}, or someplace else?" If they say yes, call ` +
        'use_saved_address; if it is somewhere else, take the new address and call set_delivery_address.'
      );
    }
    if (this.guest.isReturning && this.guest.hasSavedAddress && this.guest.mode === 'confirm') {
      return (
        'They have a saved delivery address, but you do not know it and must not guess or hint at it. ' +
        'Ask: "Can you confirm the street number on your usual delivery address?" and pass their answer ' +
        'to confirm_saved_address. If they would rather give a different address, take it and call ' +
        'set_delivery_address.'
      );
    }
    return 'Ask for the delivery address ("What\'s the address for delivery?") and pass it to set_delivery_address.';
  }

  /**
   * Has pickup-or-delivery come from the caller rather than from us? Either
   * they said something about it themselves, or the question was put to them
   * and they have spoken since — that utterance is their answer. Asking and
   * assuming in the same breath does not count: nobody has answered yet.
   *
   * This reads the caller's own words, which the engine otherwise avoids
   * (a keyword list decides badly). It is safe here because it only ever
   * *permits* what the model asked for: the failure mode of a missed word is
   * one more question, not a wrong order.
   */
  private fulfillmentSaidOrAsked(): boolean {
    /** The caller saying which way the order goes. */
    const said = /\b(pick ?up|pick (it|them|that) up|picking (it|them) up|deliver|delivery|delivered|carry ?out|take ?out|to go)\b/i;
    /** Us putting the question to them. */
    const asked = /pickup or delivery|delivery or pickup/i;
    let askedAt = -1;
    for (const [i, m] of this.messages.entries()) {
      const text = typeof m.content === 'string' ? m.content : '';
      if (!text) continue;
      if (m.role === 'user' && said.test(text)) return true;
      if (m.role === 'assistant' && asked.test(text)) askedAt = i;
    }
    return askedAt >= 0 && this.messages.slice(askedAt + 1).some((m) => m.role === 'user');
  }

  /**
   * The option groups on a line that nothing has been chosen from, split by
   * whether the menu says a choice is required.
   *
   * A group the caller was asked about and never answered looks exactly like
   * one nobody raised — the engine cannot tell them apart, and on the call of
   * 2026-09-11 22:32 that difference cost the order: the bot was listing the
   * Quesadilla's toppings, the caller cut in with the next item, and a plain
   * Quesadilla went to the kitchen without the question ever being finished.
   * So a required choice stops the read-back, and an optional one is said in
   * it, where the caller hears it and can correct it.
   */
  private unchosenGroups(line: OrderLine): {
    required: MenuModifierGroupInfo[];
    optional: MenuModifierGroupInfo[];
  } {
    const item = this.menu.find((m) =>
      line.menuItemId ? m.id === line.menuItemId : m.name === line.name,
    );
    const required: MenuModifierGroupInfo[] = [];
    const optional: MenuModifierGroupInfo[] = [];
    for (const group of item?.modifierGroups ?? []) {
      if (!group.modifiers?.length) continue;
      const ids = new Set(group.modifiers.map((o) => o.id));
      if ((line.modifiers ?? []).some((chosen) => ids.has(chosen.id))) continue;
      (group.required || (group.minSelections ?? 0) > 0 ? required : optional).push(group);
    }
    return { required, optional };
  }

  /** "(no Toppings chosen)" — what the read-back says about a question left hanging. */
  private describeUnchosen(line: OrderLine): string {
    const { optional } = this.unchosenGroups(line);
    if (!optional.length) return '';
    return ` (no ${optional.map((g) => g.name).join(' or ')} chosen)`;
  }

  /**
   * Why an order cannot be read back or placed yet for want of a choice the
   * menu says the item needs. Same reasoning as the name and the confirmation:
   * the kitchen cannot make a wing with no sauce, so the tool refuses rather
   * than the prompt asking.
   */
  private unchosenRequired(): string | null {
    for (const line of this.order) {
      const { required } = this.unchosenGroups(line);
      if (!required.length) continue;
      const group = required[0]!;
      const options = group.modifiers
        .slice(0, 3)
        .map((o) => o.name)
        .join(', ');
      this.deps.log.debug(
        { callId: this.callId, item: line.name, group: group.name },
        'order held: a required choice has not been made',
      );
      return (
        `Not yet — the ${line.name} needs a choice from ${group.name}. Ask the caller which they ` +
        `want (${options}${group.modifiers.length > 3 ? ', or something else' : ''}) and add it with update_item.`
      );
    }
    return null;
  }

  /**
   * Why an order cannot be read back or placed yet for want of how it leaves
   * the restaurant: nobody has said pickup or delivery, a delivery has no
   * address, or it is short of the delivery minimum. The same reasoning as the
   * name: a fact the ticket depends on is enforced by the tool rather than
   * requested of the model (rule #5). A location that only does one of the
   * two is preset at the start of the call and never trips this.
   */
  private unfulfilledOrder(): string | null {
    // A change to an order already placed: pickup or delivery, and where to,
    // were settled then and are not being changed here.
    if (this.amendingOrderId) return null;
    if (!this.fulfillment) {
      this.deps.log.debug({ callId: this.callId, turn: this.turnsAnswered }, 'order held: pickup or delivery?');
      return (
        'Not yet — nobody has said whether this is for pickup or delivery. Ask the caller "Is this for ' +
        'pickup or delivery?" and call set_fulfillment with their answer.'
      );
    }
    if (this.fulfillment !== 'delivery') return null;
    if (!this.deliveryAddress) {
      this.deps.log.debug({ callId: this.callId, turn: this.turnsAnswered }, 'order held: no delivery address');
      return `Not yet — there is no delivery address. ${this.deliveryNextStep()}`;
    }
    const minimum = this.deliveryTerms.minimumCents;
    if (minimum > 0 && this.orderTotal() < minimum) {
      return (
        `Not yet — delivery orders need at least ${money(minimum)} of food before the delivery fee, and ` +
        `this one is ${money(this.orderTotal())}. Tell the caller, and ask whether they would like to add ` +
        'something or make it pickup instead.'
      );
    }
    return null;
  }

  /** Adopt a customer_name argument when the model passes one. */
  private takeOrderName(arg: unknown): void {
    if (typeof arg === 'string' && arg.trim()) this.orderName = arg.trim();
  }

  /**
   * Why an order cannot be read back or placed yet: it has no name.
   *
   * Every order goes under a name — it is how the guest and the counter (or
   * the driver) find each other — and the prompt has always said to ask for one. On the
   * call of 2026-09-04 16:48 it did not: a first-time caller's order was read
   * back, confirmed and placed with no name at all, and the ticket had a blank
   * where the name goes. Same lesson as the confirmation gate: a rule the
   * order depends on is enforced by the tool, not requested of the model
   * (rule #5). review_order will not read back a nameless order and
   * place_order will not place one, so the only way through is to ask.
   *
   * A recognized guest's name is seeded at the start of the call, so they are
   * never asked again — the read-back confirms it instead ("under Mike?").
   */
  private unnamedOrder(): string | null {
    if (this.orderName) return null;
    this.deps.log.debug(
      { callId: this.callId, turn: this.turnsAnswered },
      'order held: no name to put it under',
    );
    return (
      'Not yet — there is no name on the order. Ask the caller what name to put the order ' +
      'under, and once they answer call review_order with customer_name to read it back.'
    );
  }

  /**
   * Why an order may not be placed yet, or null when it may.
   *
   * "Read the order back and confirm it before creating it" is a rule the
   * prompt has always stated and the model has always been trusted to follow.
   * It does not always: replaying the call of 2026-09-02 through the live
   * model, the read-back and the place_order that acts on it came back in the
   * same assistant message — "shall I go ahead and place it?" and the placing,
   * with no gap for the caller to say no. The pre-change prompt does it too, so
   * this is not new; it is the same class of thing as the confirmation code,
   * where asking the model to say it was not the same as saying it. A rule the
   * caller's money depends on belongs in the tool, not the prompt (rule #5).
   *
   * The gate is structural, not semantic: it asks whether the caller has been
   * given a turn since the read-back, never whether their words sounded like a
   * yes. "Yeah go ahead", "sure", "that's right" and "yep" are all agreement,
   * and a keyword list that decides which of them counts would fail on the
   * ones it had not thought of — with a placed order as the cost.
   *
   * It cannot deadlock. Being refused tells the model exactly what is missing,
   * and doing that — review_order, read it back, stop — clears the gate for the
   * caller's next utterance. A refusal that lands on a turn which has already
   * spoken the read-back ends that turn (see runTurn) rather than running
   * another pass to say so.
   */
  private unconfirmedOrder(): string | null {
    // Logged because a gate that never speaks up is a gate you cannot tell from
    // a model that behaved. On the call of 2026-09-02 14:07 the order was placed
    // on the caller's answer and nothing here fired — which is the good outcome,
    // but reading the logs afterwards there was no way to know that.
    if (this.reviewedOnTurn < 0) {
      this.deps.log.debug(
        { callId: this.callId, turn: this.turnsAnswered },
        'place_order held: the order has not been read back',
      );
      return (
        'Not placed — the order has not been read back yet. Call review_order, read the whole ' +
        'order and total to the caller, and ask them to confirm. Place it once they answer.'
      );
    }
    if (this.reviewedOnTurn === this.turnsAnswered) {
      this.awaitingConfirmation = true;
      this.deps.log.debug(
        { callId: this.callId, turn: this.turnsAnswered },
        'place_order held: read back this turn, the caller has not answered',
      );
      return (
        'Not placed — the caller has heard the read-back but has not answered it yet. This is the ' +
        'normal sequence, not a mistake: their answer is the next thing that happens. Do not ask ' +
        'again or apologize; call place_order once they agree.'
      );
    }
    return null;
  }

  /**
   * Note something the menu could not sell, and never let that matter.
   *
   * The reporter is fire-and-forget, but "never throws" is a promise the engine
   * should not have to trust. A synchronous throw here is caught upstream and
   * turns "that is not on the menu" into "that could not be completed right
   * now" — a worse answer to the caller than the statistic is worth.
   */
  private noteMenuGap(gap: { kind: 'item' | 'option'; term: string; onItem?: string }): void {
    try {
      this.deps.reportMenuGap?.(this.deps.context, gap);
    } catch (err) {
      this.deps.log.debug({ err, callId: this.callId, term: gap.term }, 'menu-gap note failed');
    }
  }

  /**
   * Match a caller's item text to a menu item.
   *
   * The hard case is an item named by what is on it. This menu has no "sausage
   * pizza": it has a Hot Subs item called "Sausage" and build-your-own pizzas
   * with a Sausage topping. Plain substring matching answered "sausage pizza"
   * with the sub — one confident match, no ambiguity reported — and the caller
   * got a sandwich. The prompt has carried a paragraph teaching the model to
   * reason this out from menu sections ever since (#40, #53), and that
   * reasoning is the single thing in this conversation that needs the model's
   * thinking pass: measured on this menu, it holds 4/4 at effort high and
   * drops to 1-2/4 at any lower setting, which is what pins every turn of every
   * call to a ~3.5 s time-to-first-token. It is a menu fact, not a language
   * problem, and it belongs here for the same reason prices do (rule #5).
   *
   * Two rules do it. A section word in the query ("pizza", "sub", "wings") says
   * what kind of thing is being asked for, so a candidate from the wrong
   * section is not a match at all. And once the section is known, words left
   * over are matched against the options the items in that section actually
   * offer — "sausage" against the Toppings group — so the query resolves to a
   * real item plus a real option rather than to nothing.
   *
   * `modifiers` carries what the name itself asked for, to be added to whatever
   * the caller chose explicitly.
   */
  private matchMenuItem(query: string): {
    item?: MenuItemInfo;
    candidates?: MenuItemInfo[];
    modifiers?: string[];
  } {
    const q = query.trim().toLowerCase();
    if (!q) return {};
    const exact = this.menu.find((m) => m.name.toLowerCase() === q);
    if (exact) return { item: exact };

    const asked = menuWords(q);
    const sections = this.sectionWords();
    const named = asked.filter((w) => sections.has(w));

    const partial = this.menu.filter(
      (m) => m.name.toLowerCase().includes(q) || q.includes(m.name.toLowerCase()),
    );
    // A name match from a section the caller did not ask for is a different
    // food. Without this the sub wins "sausage pizza" outright.
    const consistent = named.length
      ? partial.filter((m) => named.every((w) => this.itemIsUnder(m, w)))
      : partial;
    if (consistent.length === 1) return { item: consistent[0] };
    if (consistent.length > 1) return { candidates: consistent };

    // Nothing is named that. If they named a section, they may have described
    // the item by what goes on it.
    return named.length ? this.matchBySectionOptions(asked, named) : {};
  }

  /** Does this item sit under (or carry) a section word the caller used? */
  private itemIsUnder(item: MenuItemInfo, word: string): boolean {
    return (
      menuWords(item.category ?? '').includes(word) || menuWords(item.name).includes(word)
    );
  }

  /** Section words, from the menu's own headings. Built once; the menu is fixed per call. */
  private sectionWords(): Set<string> {
    if (!this.sectionWordCache) {
      this.sectionWordCache = new Set(
        this.menu.flatMap((m) => menuWords(m.category ?? '')).filter((w) => !SECTION_STOPWORDS.has(w)),
      );
    }
    return this.sectionWordCache;
  }

  /**
   * "a sausage pizza" — a section, plus words naming options the items in that
   * section offer. Resolves to the item when the query also pins one down (a
   * size), and to that section's choices when it does not, so the caller is
   * asked which size rather than told their pizza is not on the menu.
   */
  private matchBySectionOptions(
    asked: string[],
    named: string[],
  ): { item?: MenuItemInfo; candidates?: MenuItemInfo[]; modifiers?: string[] } {
    const inSection = this.menu.filter((m) => named.every((w) => this.itemIsUnder(m, w)));
    if (!inSection.length) return {};
    const rest = asked.filter((w) => !named.includes(w) && !SECTION_STOPWORDS.has(w));
    if (!rest.length) return { candidates: inSection };

    const optionsOf = (m: MenuItemInfo) =>
      (m.modifierGroups ?? []).flatMap((g) => g.modifiers.map((o) => o.name));
    const offers = (m: MenuItemInfo, w: string) =>
      optionsOf(m).some((name) => menuWords(name).includes(w));

    const optionWords = rest.filter((w) => inSection.some((m) => offers(m, w)));
    if (!optionWords.length) return {};
    const withOptions = inSection.filter((m) => optionWords.every((w) => offers(m, w)));
    if (!withOptions.length) return {};

    // Whatever is left over — "large" — narrows the section to one item.
    const nameWords = rest.filter((w) => !optionWords.includes(w));
    const narrowed = nameWords.length
      ? withOptions.filter((m) => nameWords.every((w) => menuWords(m.name).includes(w)))
      : [];
    const picked = narrowed.length ? narrowed : withOptions;

    // Report the options by the names the menu gives them, not the caller's.
    const modifiers = optionWords
      .map((w) => optionsOf(picked[0]!).find((name) => menuWords(name).includes(w)))
      .filter((n): n is string => Boolean(n));

    return picked.length === 1
      ? { item: picked[0], modifiers }
      : { candidates: picked, modifiers };
  }

  /**
   * Put the chosen options on a line, one per single-select group.
   *
   * The menu says how many of a group may be chosen, and until this used it,
   * options only ever accumulated: on a live call (2026-08-31) the bot picked
   * Buffalo (Medium) by itself, the caller asked for BBQ "instead of buffalo",
   * and the ticket went to the kitchen carrying both sauces while the bot said
   * it had switched them. Multi-select groups (toppings) still add up, which is
   * what a caller means by "and mushrooms".
   */
  private applyModifiers(
    line: OrderLine,
    item: MenuItemInfo | undefined,
    chosen: MenuModifierInfo[],
  ): { added: MenuModifierInfo[]; replaced: MenuModifierInfo[] } {
    const added: MenuModifierInfo[] = [];
    const replaced: MenuModifierInfo[] = [];
    for (const option of chosen) {
      const on = line.modifiers ?? [];
      if (on.some((m) => sameChoice(m, option))) continue;
      const group = (item?.modifierGroups ?? []).find((g) =>
        g.modifiers.some((o) => o.id === option.id),
      );
      // Only where the menu actually says single. A group whose type is missing
      // or unrecognized keeps adding: losing a topping the caller asked for is
      // worse than carrying one they will hear read back.
      if (group?.selectionType === 'single') {
        const sameGroup = new Set(group.modifiers.map((o) => o.id));
        for (const m of on) if (sameGroup.has(m.id)) replaced.push(m);
        line.modifiers = on.filter((m) => !sameGroup.has(m.id));
      } else {
        line.modifiers = on;
      }
      line.modifiers.push(option);
      added.push(option);
    }
    return { added, replaced };
  }

  /** The draft's lines in plain words, for the call's record: "1 Knots (Garlic); 1 Large Pizza (18")". */
  private describeLinesForRecord(): string {
    return (
      this.order
        .map(
          (l) =>
            `${l.quantity} ${l.name}${describeModifiers(l.modifiers, (n) => n)}` +
            (l.specialInstructions ? ` (${l.specialInstructions})` : ''),
        )
        .join('; ') || 'nothing'
    );
  }

  /** Let go of an order change that cannot be saved: the draft, the id, and the order as read. */
  private abandonChange(): void {
    this.order = [];
    this.amendingOrderId = null;
    this.recentOrder = null;
    this.reviewedOnTurn = -1;
  }

  /** Which line on the draft the model means, by exact name then by overlap. */
  private findOrderLine(query: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return -1;
    const exact = this.order.findIndex((l) => l.name.toLowerCase() === q);
    if (exact >= 0) return exact;
    return this.order.findIndex(
      (l) => l.name.toLowerCase().includes(q) || q.includes(l.name.toLowerCase()),
    );
  }

  /** What one of a line costs: the item plus every option chosen for it. */
  private lineUnitCents(line: OrderLine): number {
    return (line.modifiers ?? []).reduce((sum, m) => sum + m.priceCents, line.unitPriceCents);
  }

  private orderTotal(): number {
    return this.order.reduce((sum, l) => sum + this.lineUnitCents(l) * l.quantity, 0);
  }

  /**
   * Resolve the option names the model passed against the item's own groups.
   * Only options this item actually has can be chosen, and their prices come
   * from the menu — the model never names a price (rule #5). Anything that
   * matches nothing is handed back so the caller hears about it.
   */
  private matchModifiers(
    item: MenuItemInfo | undefined,
    arg: unknown,
    portion: ModifierPortion = 'whole',
  ): { chosen: MenuModifierInfo[]; unknown: string[]; notHalvable: string[] } {
    const names = Array.isArray(arg) ? arg.filter((n): n is string => typeof n === 'string') : [];
    const options = (item?.modifierGroups ?? []).flatMap((g) =>
      g.modifiers.map((o) => ({ option: o, group: g })),
    );
    const chosen: MenuModifierInfo[] = [];
    const unknown: string[] = [];
    const notHalvable: string[] = [];
    for (const raw of names) {
      const q = raw.trim().toLowerCase();
      if (!q) continue;
      const hit =
        options.find(({ option: o }) => o.name.toLowerCase() === q) ??
        options.find(
          ({ option: o }) => o.name.toLowerCase().includes(q) || q.includes(o.name.toLowerCase()),
        );
      if (!hit) {
        unknown.push(raw.trim());
        continue;
      }
      if (portion !== 'whole' && !hit.group.allowsHalves) {
        notHalvable.push(hit.option.name);
        continue;
      }
      if (chosen.some((c) => c.id === hit.option.id)) continue;
      chosen.push(
        portion === 'whole'
          ? hit.option
          : {
              ...hit.option,
              portion,
              // The menu's rule for a half, applied here so the readback and
              // the running total need no special case (the API re-prices by
              // the same rule when the order is placed).
              priceCents:
                hit.group.halfPricing === 'half'
                  ? Math.ceil(hit.option.priceCents / 2)
                  : hit.option.priceCents,
            },
      );
    }
    return { chosen, unknown, notHalvable };
  }

  /** Match the LLM's chosen `target` (a key, or a label fragment) to a destination. */
  private resolveTransfer(arg: unknown): TransferTarget | undefined {
    if (typeof arg !== 'string' || !arg.trim()) return undefined;
    const q = arg.trim().toLowerCase();
    return (
      this.transferTargets.find((t) => t.key.toLowerCase() === q) ??
      this.transferTargets.find((t) => t.label.toLowerCase().includes(q) || q.includes(t.key.toLowerCase()))
    );
  }

  private menuPrompt(): string {
    const itemLine = (m: MenuItemInfo) => {
      const price = `$${(m.priceCents / 100).toFixed(2)}`;
      const ing = m.ingredients?.length ? ` [ingredients: ${m.ingredients.join(', ')}]` : '';
      const opts = (m.modifierGroups ?? [])
        .filter((g) => g.modifiers.length)
        .map((g) => {
          const choices = g.modifiers
            .map((o) => (o.priceCents ? `${o.name} +$${(o.priceCents / 100).toFixed(2)}` : o.name))
            .join(', ');
          const flags = [
            g.required ? 'required' : '',
            choiceLimit(g) === 1 ? 'choose one' : Number.isFinite(choiceLimit(g)) ? `up to ${choiceLimit(g)}` : '',
            g.allowsHalves ? 'half-and-half allowed' : '',
          ]
            .filter(Boolean)
            .join(', ');
          return `\n    ${g.name}${flags ? ` (${flags})` : ''}: ${choices}`;
        })
        .join('');
      return `- ${m.name} — ${price}${m.description ? ` (${m.description})` : ''}${ing}${opts}`;
    };

    // Grouped by section, in menu order. A flat list hides what an item IS: the
    // sub named "Sausage" and the build-your-own pizzas read alike, and on a
    // real call (2026-08-31) "one sausage pizza" got the sub — the caller was
    // asked to pick its cheese and sauce, then told his pizza was a sandwich.
    const sections = new Map<string, MenuItemInfo[]>();
    for (const m of this.menu) {
      const key = m.category?.trim() || '';
      const bucket = sections.get(key);
      if (bucket) bucket.push(m);
      else sections.set(key, [m]);
    }
    const lines = [...sections].flatMap(([section, items]) =>
      section ? [`${section}:`, ...items.map(itemLine)] : items.map(itemLine),
    );
    return [
      'Menu (authoritative — only offer these items and these prices; never invent items or',
      'prices). Use lookup_menu for details during an order. If a caller asks for something not',
      'listed, say it’s not on the menu and offer the closest item.',
      'Sections: items are grouped under the menu section they belong to. When the caller names an',
      'item by what is on it — "a sausage pizza", where the menu has no such item — pass what they',
      'said to add_item unchanged. The tool resolves it against the sections and the options each',
      'item offers, and tells you when it needs a size. Do not work out which item they meant.',
      'Options: an item’s choices are listed indented under it. A choice marked (required) is one',
      'the caller has to make — ask them which one and wait for the answer. Never pick one for',
      'them and never assume a default. Pass what the caller picks to add_item as `modifiers`, using',
      'the option names exactly as listed. Anything else they ask for goes in special_instructions.',
      'Pass an option ONLY if the caller asked for it. Naming an item is not asking for an option',
      'that shares a word with it — "a cheese pizza" is the plain pizza, not one with Extra Cheese.',
      'Ingredients: answer ingredient questions ONLY from the [ingredients: ...] list shown for an',
      'item. If an ingredient is not in that list, say it is not in the item. If an item has no',
      'ingredients listed, do NOT guess — say you’re not certain and offer to take a note or have',
      'staff confirm. Never invent or assume ingredients (allergen safety).',
      ...lines,
    ].join('\n');
  }

  /** How orders leave this restaurant, so the model knows what to offer and whether to ask. */
  private fulfillmentPrompt(): string {
    const { pickup, delivery } = this.offers;
    if (pickup && !delivery) {
      return (
        'Orders here are for pickup only — this restaurant does not deliver. Do not ask "pickup or ' +
        'delivery"; if a caller asks for delivery, say so and offer pickup. Pickup is ready in about ' +
        `${this.etaMinutes.pickup} minutes.`
      );
    }
    const terms = this.deliveryTermsNote();
    if (!pickup) {
      return (
        `Orders here are for delivery only — no pickup.${terms} Every order needs a delivery address; ` +
        'set_delivery_address (or the saved address) once the name is settled.'
      );
    }
    return (
      `Orders here can be for pickup (ready in about ${this.etaMinutes.pickup} minutes) or delivery${terms} ` +
      'If the caller has not said which, ask "Is this for pickup or delivery?" once the name is settled.'
    );
  }

  private guestPrompt(): string {
    const who = this.guest.displayName ?? 'this caller';
    const lines = [
      `Returning guest: ${who} is a recognized returning caller (matched by phone number).`,
    ];
    if (this.guest.vip) {
      lines.push('This guest is a VIP regular — thank them once, warmly, for their loyalty.');
    }
    if (this.guest.mode === 'confirm') {
      lines.push(
        'Before referencing their past orders or saved preferences, confirm who is calling — ask their',
        'name and check it matches — then call recall_guest.',
      );
      // Rule #6: where someone lives is never said on a caller-id match
      // alone. The engine does not even know it yet; the street number is the check.
      if (this.guest.hasSavedAddress && this.offers.delivery) {
        lines.push(
          'They have a saved delivery address, which you do not know and must not guess or hint at.',
          'For a delivery, ask "Can you confirm the street number on your usual delivery address?" and',
          'pass their answer to confirm_saved_address.',
        );
      }
    } else {
      if (this.savedAddress && this.offers.delivery) {
        lines.push(
          `Their saved delivery address is ${formatDeliveryAddress(this.savedAddress)}. For a delivery,`,
          'offer it back ("Are we still delivering to …, or someplace else?") — set_fulfillment gives you',
          'the exact words.',
        );
      }
      lines.push('You may call recall_guest to offer their usual or recall their preferences.');
      // Only in full-memory mode: in confirm mode we do not yet know that the
      // person on the phone is the guest whose number this is, so the name they
      // give is the identity check, not a formality to skip.
      if (this.guest.displayName) {
        lines.push(
          `Their name is ${this.guest.displayName}, and an order goes under it automatically.`,
          'Do not ask them what name to put the order under; the read-back asks them to confirm',
          'placing it under that name instead.',
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Hand the rest of the call to another persona: every line from here is
   * spoken in that voice, and the model answers to that name. The greeting
   * and history stay — it is the same conversation, continued by someone else.
   */
  private becomePersona(next: CallVoice): void {
    this.voice = { voiceId: next.voiceId ?? null, staffName: next.staffName ?? null };
    if (this.restaurantName) {
      this.messages[0] = {
        role: 'system',
        content: buildReceptionistSystemPrompt(this.restaurantName, {
          ...this.hoursPromptOpts(),
          greeting: this.ownerGreeting,
          assistantName: this.voice.staffName ?? undefined,
          canTransfer: this.transferTargets.length > 0,
        }),
      };
    }
    this.deps.log.info({ callId: this.callId, staffName: this.voice.staffName, voiceId: this.voice.voiceId }, 'persona switched');
  }

  /**
   * The tools this call may actually use. A location that does not take orders
   * for later is not offered schedule_order at all: a tool the model can see
   * is a tool it will eventually try, and "we don't do that" is a worse answer
   * than never raising it.
   */
  private callTools(): LlmToolDefinition[] {
    const tools = this.deps.tools ?? RECEPTIONIST_TOOLS;
    // Nobody to transfer to, no transfer tool: the model offered one anyway
    // on the call of 2026-09-14 19:23, and a tool it can see, it will use.
    return tools.filter(
      (t) =>
        (t.name !== 'schedule_order' || this.hours.scheduling.enabled) &&
        (t.name !== 'transfer_call' || this.transferTargets.length > 0) &&
        (t.name !== 'order_text_updates' || (!!this.textOffer && !this.textOffer.answered)),
    );
  }

  /**
   * The order the caller placed earlier, in the words the bot should read back
   * before changing anything. Reading it back is the point: it is how the
   * caller finds out we have the right order, and how a wrong one gets caught
   * before a line is touched.
   */
  private describeRecentOrder(order: Extract<RecentOrder, { needsCode: false }>): string {
    const lines = order.items
      .map(
        (i) =>
          `${i.quantity} ${i.name}` +
          (i.modifiers.length ? ` (${i.modifiers.map((m) => m.name).join(', ')})` : '') +
          (i.specialInstructions ? ` (${i.specialInstructions})` : ''),
      )
      .join('; ');
    const when = order.scheduledFor ? ' It is booked for later.' : '';
    return (
      `Their order #${order.orderCode}: ${lines}. Total ${money(order.totalCents)}, for ` +
      `${order.fulfillmentType}.${when} Read it back and ask what they would like to change. ` +
      'To change what is on it call change_order; to cancel it call cancel_order. Do not do either ' +
      'until the caller has said which they want.'
    );
  }

  /**
   * What the system prompt is told about the hours. The closed block appears
   * only when the owner asked for it and the restaurant is genuinely shut; the
   * scheduling block whenever this location takes orders for later, open or
   * not — "can I pick it up at six" is an ordinary question at lunchtime.
   */
  private hoursPromptOpts(): {
    closed?: { nextOpen?: string | null; hoursToday?: string | null; offerMessage?: boolean };
    scheduling?: { maxDaysAhead: number; today?: string | null };
  } {
    return {
      ...(this.hours.announceClosed
        ? {
            closed: {
              nextOpen: this.hours.nextOpen,
              hoursToday: this.hours.hoursToday,
              offerMessage: this.hours.offerMessage,
            },
          }
        : {}),
      ...(this.hours.scheduling.enabled
        ? { scheduling: { maxDaysAhead: this.hours.scheduling.maxDaysAhead, today: this.hours.scheduling.today } }
        : {}),
    };
  }

  /**
   * What a caller hears when the restaurant is shut, in place of the question
   * the greeting ends on (see withClosedNotice). It is said in the same breath as the greeting rather than
   * waiting for the model, because the first thing a caller at 8am needs to
   * know is that nobody is cooking — and because a greeting that ends "what can
   * I get started for you?" is a promise the kitchen cannot keep.
   */
  private closedGreetingSuffix(): string {
    if (!this.hours.announceClosed) return '';
    const when = this.hours.nextOpen ? ` We open again ${this.hours.nextOpen}.` : '';
    const offer = this.hours.scheduling.enabled
      ? this.hours.offerMessage
        ? ' I can take an order for when we open, or take a message.'
        : ' I can take an order for when we open.'
      : this.hours.offerMessage
        ? ' I can take a message for the team.'
        : '';
    return ` We're closed right now.${when}${offer}`;
  }

  private personasPrompt(): string {
    return [
      'Staff who can take the call — when the caller asks for one of these by name, say you are',
      'getting them, then call switch_persona with the name. Only these names; anyone else is a',
      this.transferTargets.length ? 'transfer or a message.' : 'message.',
      ...this.personas.map((n) => `- ${n}`),
    ].join('\n');
  }

  private transferOptionsPrompt(): string {
    const lines = this.transferTargets.map(
      (t) => `- ${t.key}: ${t.label}${t.description ? ` — ${t.description}` : ''}`,
    );
    return [
      'Transfer options — when the caller asks to reach a person, call transfer_call with the',
      'matching key. Only these are valid; if the caller wants someone not listed, take a message.',
      ...lines,
    ].join('\n');
  }

  /** Speak a whole fixed string (e.g. the confirmation code) and wait for playout. */
  private async speak(text: string, turn: AbortController): Promise<void> {
    this.setState('speaking');
    await this.synthesizeToPump(text, turn);
    await this.pump.drain();
  }

  /**
   * Speak a fixed line sentence by sentence, filling `spans` with where each
   * one landed in the playout, so a caller who talks over it is recorded as
   * having heard the part that actually played. One TTS call for the whole
   * line is one span, and a greeting cut off after two words would then be
   * written down as if the caller had heard all of it.
   *
   * `spans` is filled rather than returned because an abort throws out of
   * synthesis, and the sentences that did play are exactly what the caller
   * heard — they must survive the throw.
   *
   * Time-to-first-audio is unchanged: the first sentence still streams
   * straight into the pump, and the rest synthesize while it plays.
   */
  private async speakTracked(
    text: string,
    turn: AbortController,
    spans: SpokenSpan[],
  ): Promise<void> {
    const { sentences, rest } = drainSentences(text);
    const parts = [...sentences, rest].map((p) => p.trim()).filter(Boolean);
    this.setState('speaking');
    for (const sentence of parts) {
      if (turn.signal.aborted) break;
      const startFrame = this.turnAudioFrames;
      try {
        await this.synthesizeToPump(sentence, turn);
      } finally {
        spans.push({ text: sentence, startFrame, endFrame: this.turnAudioFrames });
      }
    }
    await this.pump.drain();
  }

  /** Synthesize one chunk into memory, for playout after the current one. */
  private async synthesizeBuffered(text: string, turn: AbortController): Promise<Uint8Array[]> {
    this.rememberSpeech(text);
    const frames: Uint8Array[] = [];
    await this.deps.providers.tts.synthesize({
      text: toSpeakable(text),
      voiceId: this.voice.voiceId ?? undefined,
      sampleRate: this.deps.context.sampleRate,
      signal: turn.signal,
      // Copy: the provider hands out subarrays of a reused read buffer.
      onAudio: (frame) => frames.push(new Uint8Array(frame)),
    });
    return frames;
  }

  /** Synthesize one chunk and push its frames into the paced pump. */
  private async synthesizeToPump(text: string, turn: AbortController): Promise<void> {
    this.rememberSpeech(text);
    await this.deps.providers.tts.synthesize({
      // Strip markdown so the TTS voice doesn't read "**" as "star star", etc.
      text: toSpeakable(text),
      voiceId: this.voice.voiceId ?? undefined,
      sampleRate: this.deps.context.sampleRate,
      signal: turn.signal,
      onAudio: (frame) => {
        this.turnAudioFrames += 1;
        this.pump.push(frame);
      },
    });
  }
}

/**
 * Does `heard` look like a piece of `said`? STT chops a played-back sentence
 * into fragments ("let me review your order for you gray"), so containment
 * either way catches most of it; word overlap covers the rest, where STT
 * mangled a word or two on the way through the speaker.
 *
 * Containment is compared word by word, never as raw substrings: "no" is inside
 * "know", "so" inside "also", "it" inside "with", so a character-level test
 * calls half the short answers a caller gives an echo of whatever we last said.
 */
function echoes(said: string, heard: string): boolean {
  const saidWords = said.split(' ');
  const heardWords = heard.split(' ');
  // Too short to judge — and this test has to come FIRST. A caller answering a
  // question we just asked necessarily answers in our words: "boneless or
  // traditional?" is answered "Boneless", which is by definition contained in
  // what we said. Checking containment before length made every one-word answer
  // our own voice, and on a live call the caller said "Boneless" three times
  // before one got through.
  //
  // This is the reasoning already written into ANSWER_PHRASES, applied to every
  // short reply rather than an enumerated list of them: a leaked echo costs one
  // spurious turn, a swallowed answer leaves the caller repeating themselves.
  // It does mean a short filler of ours ("Perfect") can leak back — the cheaper
  // of the two mistakes.
  if (heardWords.length < ECHO_MIN_WORDS) return false;
  // One utterance repeated whole inside the other is an echo outright.
  if (containsRun(saidWords, heardWords) || containsRun(heardWords, saidWords)) return true;

  // Everything below is about ORDER, never bare overlap. A caller in a
  // restaurant necessarily answers in the words we just used — "Do you have a
  // SGT pizza?" after we described the SGT Peppers shares every word we said,
  // and an overlap test called it our own voice and swallowed the question.
  // Their words also survive in our order for a moment ("have a sgt"), so the
  // length of the run cannot decide it either.
  //
  // What separates them is how MUCH of the utterance is our sentence: a real
  // echo is our line played back, so nearly all of it lands in our order, with
  // STT dropping a word here and there. A caller borrowing our vocabulary
  // matches a phrase and then goes their own way.
  const run = longestOrderedRun(saidWords, heardWords);
  if (run < ECHO_MIN_WORDS) return false;
  return run / heardWords.length >= ECHO_RUN_COVERAGE;
}

/**
 * The alternatives a question offered, if it offered any: "Did you want the
 * Philly Steak sub, or the Philly Steak Pizza?" is two, "small, medium, or
 * large?" is three. Only questions — a sentence with an "or" in the middle of
 * it is not a choice being put to anyone ("we can add sausage or pepperoni to
 * that") unless it ends in a question mark.
 */
function offeredChoices(text: string): string[] {
  const sentence = text.trim();
  if (!sentence.endsWith('?') || !/\bor\b/i.test(sentence)) return [];
  return sentence
    .slice(0, -1)
    .split(/,|\bor\b/i)
    .map((part) => normalizeSpeech(part))
    .filter(Boolean);
}

/**
 * Did the caller pick exactly one of the alternatives we offered?
 *
 * The fix for a live call on 2026-09-12: the bot asked "the Philly Steak sub,
 * or the Philly Steak Pizza?", the caller said "the Philly steak sub", and four
 * of those five words were a run of our own sentence — so it was suppressed as
 * our voice, and the caller sat in silence for fourteen seconds before asking
 * "Hello?". Short answers were already let through for exactly this reason; a
 * five-word one fell straight back into the trap that rule was built to escape.
 *
 * An answer matches ONE alternative and carries nothing from the others. Our
 * own question echoing back matches an alternative too, but brings the rest of
 * the question with it — the other option's words — and is not an answer. A
 * fragment starting "or…" is the tail of our own sentence, never a reply.
 */
function picksOneChoice(choices: string[], heard: string): boolean {
  if (choices.length < 2) return false;
  const heardWords = heard.split(' ');
  if (heardWords[0] === 'or') return false;
  const wordLists = choices.map((c) => c.split(' '));
  const matched: number[] = [];
  wordLists.forEach((words, i) => {
    const run = longestOrderedRun(words, heardWords);
    if (run >= Math.min(ECHO_MIN_WORDS, heardWords.length) && run / heardWords.length >= ECHO_RUN_COVERAGE) {
      matched.push(i);
    }
  });
  if (matched.length !== 1) return false;
  // Nothing from any other alternative: "sub" is what makes the answer the sub
  // rather than the pizza, and a replay of the question would have both.
  const chosen = new Set(wordLists[matched[0]!]);
  const others = new Set(wordLists.flatMap((w, i) => (i === matched[0] ? [] : w)).filter((w) => !chosen.has(w)));
  return !heardWords.some((w) => others.has(w));
}

/** Longest run of consecutive whole words the two share. */
function longestOrderedRun(a: string[], b: string[]): number {
  let best = 0;
  // Small utterances; the clarity of the straightforward scan is worth more
  // than the table a longest-common-substring implementation would need.
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
}

/** Does `words` contain `run` as a consecutive run of whole words? */
function containsRun(words: string[], run: string[]): boolean {
  if (!run.length || run.length > words.length) return false;
  outer: for (let i = 0; i <= words.length - run.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer;
    return true;
  }
  return false;
}

/** Remember an utterance we are about to speak, for echo comparison. */
function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Paced audio playout. TTS produces frames in bursts faster than real time;
 * SiphonAI only buffers ~200 ms and drops the rest (protocol §5.5). The pump
 * sends one frame every `frameMs` so playout is smooth and TTS can run ahead.
 */
class PlaybackPump {
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters: Array<() => void> = [];
  /** Paused by a suspected barge-in: hold the queue, send nothing. */
  private paused = false;
  /** Wall-clock time the next frame is due, so a late tick catches up instead of drifting. */
  private nextDueMs = 0;

  constructor(
    private readonly send: (frame: Uint8Array) => void,
    private readonly frameMs: number,
    /** Head start handed to SiphonAI's outbound buffer (protocol §5.5: ~200 ms). */
    private readonly leadMs = 120,
  ) {}

  /** Audio of ours is on the wire right now (or queued to be). */
  isPlaying(): boolean {
    return this.timer !== null || this.queue.length > 0;
  }

  /** Stop sending but keep the queue: a suspected barge-in we may take back. */
  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resume a paused playout from where it stopped, on a fresh schedule. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.queue.length) {
      this.halt();
      return;
    }
    this.nextDueMs = nowMs() - this.leadMs;
    this.timer = setInterval(() => this.tick(), Math.max(5, Math.floor(this.frameMs / 2)));
    this.timer.unref?.();
    this.tick();
  }

  push(frame: Uint8Array): void {
    this.queue.push(frame);
    if (!this.timer && !this.paused) {
      // Resume the existing schedule when playout only briefly starved (TTS
      // catching up mid-utterance) — restarting it there would re-grant the lead
      // every time and burst audio past the bridge's ~200 ms buffer. Only a
      // genuinely idle pump starts fresh, `leadMs` in the past, so the first
      // frames flush immediately and give the bridge a cushion against an
      // event-loop hiccup mid-call (STT parsing, LLM streaming, tool HTTP).
      const t = nowMs();
      if (this.nextDueMs === 0 || t - this.nextDueMs > this.leadMs) this.nextDueMs = t - this.leadMs;
      // Tick finer than a frame so pacing granularity isn't the timer's period.
      this.timer = setInterval(() => this.tick(), Math.max(5, Math.floor(this.frameMs / 2)));
      this.timer.unref?.(); // never let a stray pump keep the process alive
      this.tick();
    }
  }

  private tick(): void {
    // Send every frame whose slot has arrived — one per frameMs of wall clock,
    // catching up after a late timer rather than losing the time permanently.
    for (;;) {
      if (nowMs() < this.nextDueMs) return;
      const frame = this.queue.shift();
      if (!frame) {
        this.halt();
        return;
      }
      this.send(frame);
      this.nextDueMs += this.frameMs;
    }
  }

  /**
   * Drop pending frames (barge-in). Playout is over, so anything waiting on
   * drain() is released here rather than on the next empty tick: a barge-in
   * pauses before it clears, and a paused pump has no timer left to tick and
   * discover the queue is empty. Without this the turn that was speaking hangs
   * on its own drain until some later turn's audio happens to finish.
   */
  clear(): void {
    this.queue = [];
    this.paused = false;
    this.halt();
  }

  /** Resolve once the queue has fully played out. */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.timer) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    this.queue = [];
    this.paused = false;
    this.halt();
  }

  private halt(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * Words to match menu text by: lowercased, punctuation dropped, and a trailing
 * plural stripped so a caller's "sub" finds the "Hot Subs" section.
 */
function menuWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/**
 * Words that never say what kind of food something is. "Create Your Own Pizza"
 * is a section about pizza; the rest is furniture, and treating it as meaning
 * would make "your" a thing a caller can order from.
 */
const SECTION_STOPWORDS = new Set([
  'create', 'your', 'own', 'the', 'and', 'with', 'our', 'a', 'an', 'of', 'one',
  'some', 'please', 'get', 'my', 'for', 'order', 'special',
]);

/**
 * Menu names are written to be read, not said. "Large Pizza (18\")" spoken
 * whole becomes "large pizza open paren eighteen inch"; the size is already in
 * the words before it, so the parenthetical goes. Option names keep their
 * qualifier — "Buffalo (Hot)" is a different sauce from "Buffalo (Mild)" — and
 * only lose the brackets.
 */
function spokenItem(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
}

function spokenOption(name: string): string {
  return name.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

/** Does a free-text note name this option? Every real word of the name, in any order. */
function mentionsOption(note: string, optionName: string): boolean {
  const text = note.toLowerCase();
  const words = spokenOption(optionName)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => text.includes(w));
}

/** The same option on the same part of the item. */
function sameChoice(a: MenuModifierInfo, b: MenuModifierInfo): boolean {
  return a.id === b.id && (a.portion ?? 'whole') === (b.portion ?? 'whole');
}

/** An option's name with its portion, for the model: "Pepperoni (left half)". */
function modifierLabel(m: MenuModifierInfo): string {
  return m.portion && m.portion !== 'whole' ? `${m.name} (${m.portion} half)` : m.name;
}

/**
 * A line's options as a phrase: " with Mushroom, half Pepperoni, half Sausage".
 * Whole options first, then each half — the order a person says it in. `say`
 * shapes each name (spokenOption for the voice, identity for the model).
 */
function describeModifiers(
  mods: MenuModifierInfo[] | undefined,
  say: (name: string) => string,
): string {
  if (!mods?.length) return '';
  const whole = mods.filter((m) => !m.portion || m.portion === 'whole').map((m) => say(m.name));
  const halves = [
    ...mods.filter((m) => m.portion === 'left'),
    ...mods.filter((m) => m.portion === 'right'),
  ].map((m) => `half ${say(m.name)}`);
  const wholeText = say === spokenOption ? whole.join(' and ') : whole.join(', ');
  if (whole.length && halves.length) return ` with ${wholeText}, ${halves.join(', ')}`;
  if (whole.length) return ` with ${wholeText}`;
  return `, ${halves.join(', ')}`;
}

/** Why a half-and-half request was turned down, and what to do instead. */
/** How many of a group's options one item may carry: one for a single-choice group, else its maximum. */
export function choiceLimit(group: MenuModifierGroupInfo): number {
  if (group.selectionType === 'single') return 1;
  return group.maxSelections != null && group.maxSelections > 0 ? group.maxSelections : Infinity;
}

/**
 * Refuses a request that puts more of one group's options on an item than the
 * menu allows, before anything is changed. On the call of 2026-09-14 16:46 the
 * caller asked for wings "half barbecue, half garlic parm"; the model passed
 * both sauces to add_item, the single-choice rule let the second replace the
 * first, and the tool reported "Added Wings with Blue Cheese, Garlic Parmesan"
 * as though that were what was asked. The bot then read it back to a caller
 * who had asked for BBQ. A request with more than one choice from a group is a
 * question for the caller, not a replacement.
 *
 * `request` is what this call asks for; `onLine` is what an existing line
 * already carries. Within a single-choice group one new option replaces the
 * old ("make that mild"), so only the request is counted there. A group with a
 * maximum counts what stays on the line too. A group that allows halves is
 * counted per side, as the API counts it.
 */
export function tooManyChoices(
  item: MenuItemInfo,
  request: MenuModifierInfo[],
  onLine: MenuModifierInfo[],
  note = '',
): string | null {
  for (const group of item.modifierGroups ?? []) {
    const limit = choiceLimit(group);
    if (!Number.isFinite(limit)) continue;
    const inGroup = new Set(group.modifiers.map((o) => o.id));
    const asked = request.filter((o) => inGroup.has(o.id));
    const lineInGroup = onLine.filter((o) => inGroup.has(o.id));
    // Options the special-instructions note names. The note exists so an
    // option the menu does not list is never lost; it is not a way past a
    // limit the menu does set. On the retest of 2026-09-14 17:23, refused two
    // sauces, the model wrote "Half BBQ sauce, half Garlic Parmesan sauce" into
    // the note instead, and the ticket read "Wings (Blue Cheese; BBQ; Half BBQ
    // sauce, half Garlic Parmesan sauce)". A group that allows halves is left
    // out: a note there is how a kitchen hears about a half it can make.
    // Naming the option being swapped out ("BBQ instead of garlic parm") is
    // narration of the swap, not a second choice, so what is already on the
    // line does not count when the request replaces it.
    const inNote = group.allowsHalves || !note
      ? []
      : group.modifiers.filter(
          (o) => mentionsOption(note, o.name) && !(asked.length && lineInGroup.some((l) => l.id === o.id)),
        );
    if (!asked.length && !inNote.length) continue;
    const kept = group.selectionType === 'single' && asked.length ? [] : lineInGroup;
    const all = [...kept, ...asked, ...inNote];
    const side = (s: 'left' | 'right') =>
      new Set(all.filter((o) => (o.portion ?? 'whole') === 'whole' || o.portion === s).map((o) => o.id)).size;
    const count = group.allowsHalves ? Math.max(side('left'), side('right')) : new Set(all.map((o) => o.id)).size;
    if (count <= limit) continue;
    const names = [...new Set([...asked, ...inNote].map((o) => o.name))];
    const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const what = group.name.toLowerCase();
    const byNote = inNote.length ? ' A special-instructions note cannot add another one either.' : '';
    return limit === 1
      ? `${item.name} takes one ${what}, and the caller asked for ${listed}, so nothing was changed.${byNote} ` +
          `Tell them it is one ${what}${group.allowsHalves ? '' : ' — it cannot be split half and half'}, ` +
          'and ask which one they want. If they want more than one, each is its own order of ' +
          `${item.name}, added separately.`
      : `${item.name} takes up to ${limit} ${what}${kept.length ? `, it already has ${kept.map((o) => o.name).join(', ')},` : ''} ` +
          `and the caller asked for ${listed}, so nothing was changed.${byNote} Tell them it is ${limit} at ` +
          `most, and ask which ${limit} they want.`;
  }
  return null;
}

function cannotHalve(itemName: string, options: string[]): string {
  return (
    `${itemName} cannot be made half-and-half — its options go on the whole item, so nothing ` +
    `was changed. Ask the caller whether they want ${options.join(' and ')} on the whole ` +
    `${itemName}, and pass what they choose as modifiers.`
  );
}

/** Small counts read better as words than as digits over a phone. */
function spokenCount(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
}

/**
 * Does this utterance read as the start of something rather than the whole of
 * it? A trailing comma, or a last word that nothing ends on.
 */
/**
 * Does `later` start with every word of `earlier` and then say more? "how
 * about" → "how about tomorrow at six". Word-for-word from the start on
 * purpose: a caller who repeats themselves with a filler in front ("yes, a
 * large pepperoni") is repeating, and stays a restatement.
 */
export function extendsUtterance(earlier: string, later: string): boolean {
  const a = normalizeSpeech(earlier).split(' ').filter(Boolean);
  const b = normalizeSpeech(later).split(' ').filter(Boolean);
  return a.length > 0 && b.length > a.length && a.every((w, i) => b[i] === w);
}

/**
 * The greeting with the closed notice worked in. A greeting usually ends on a
 * question — "What can I get started for you today?" — and put after it, the
 * notice answered the caller's first thought with "we're closed" (every closed
 * call of 2026-09-14). The notice takes that question's place; it ends on its
 * own offer. A greeting with no closing question gets the notice after it.
 */
export function withClosedNotice(opening: string, notice: string): string {
  if (!notice) return opening;
  const withoutQuestion = opening.replace(/(^|[.!?])\s*[^.!?]*\?\s*$/, '$1').trim();
  return `${withoutQuestion || opening.trim()}${notice}`;
}

export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[,;]$/.test(trimmed)) return true;
  const last = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, '')
    .trim()
    .split(/\s+/)
    .pop();
  return last ? UNFINISHED_TAIL.has(last) : false;
}

/** Monotonic milliseconds — immune to wall-clock steps mid-call. */
function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/**
 * Pull complete sentences out of a streaming buffer, leaving the trailing
 * partial as `rest`. A sentence ends at . ! ? followed by whitespace, or a
 * newline — so decimals like "$16.99" don't split.
 */
export function drainSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[\s\S]*?(?:[.!?]+\s|\n)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    sentences.push(match[0]);
    lastIndex = re.lastIndex;
  }
  return { sentences, rest: buffer.slice(lastIndex) };
}

/** Cents → a "$18.00" string; the LLM relays it in natural spoken form. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Space out a short order code so the TTS voice reads it character by character. */
function spellCode(code: string): string {
  return code.split('').join(' ');
}

/**
 * Digits a model may write as words when reading a code aloud. Deliberately not
 * "oh" for zero: it is a word models use for other reasons, and reading a code
 * twice is a small annoyance where failing to read it at all is the bug.
 */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** The word a model may write instead of the digit, for matching a spelled code. */
const WORD_FOR_DIGIT: Record<string, string> = Object.fromEntries(
  Object.entries(DIGIT_WORDS).map(([word, digit]) => [digit, word]),
);

/**
 * Did the reply read this code out in a way the caller could write down?
 *
 * Containing the characters is not the same as reading them out. On the call of
 * 2026-09-02 18:44 the reply gave "confirmation code F489-1", which has every
 * character of F4891 in order and so counted as said — but a TTS voice reads
 * that as "F four eighty-nine dash one", and the one thing on the call a caller
 * cannot recover on their own went out as a number they would have to guess at.
 *
 * So the characters have to be separated: spaces, commas, hyphens, or the digit
 * as a word. That is what makes it a spelling rather than a string. A reply that
 * ran them together is treated as not having said it, and the engine says it
 * properly afterwards — the caller hears the code twice, the second time in the
 * form they can act on, which is the right way round for this particular fact.
 */
function saidCode(said: string, code: string): boolean {
  const pattern = code
    .toLowerCase()
    .split('')
    .map((c) => {
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return WORD_FOR_DIGIT[c] ? `(?:${escaped}|${WORD_FOR_DIGIT[c]})` : escaped;
    })
    // Any run of non-alphanumerics between them: " ", ", ", " - ", " as in dog ".
    .join('[^a-z0-9]+');
  return new RegExp(pattern, 'i').test(said.toLowerCase());
}

/**
 * Make LLM output safe to speak: strip markdown the TTS engine would read aloud
 * (e.g. "**" → "star star", backticks, headings, bullets, links).
 */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/__([^_]+)__/g, '$1') // bold (underscore)
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/[*`~]/g, '') // any stray emphasis chars the TTS would voice
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
