import type { LlmToolDefinition } from './providers.js';

/**
 * First, intentionally constrained receptionist prompt (implementation plan §7.3).
 * Business rules live in tools, NOT here. The LLM never computes prices or
 * invents menu items.
 */
export function buildReceptionistSystemPrompt(
  restaurantName: string,
  opts: {
    /** The owner's own opening line, already spoken to the caller word for word. */
    greeting?: string;
    /** The name the voice answers to — the owner's pick for the default voice, or the staff member it belongs to. */
    assistantName?: string;
    /**
     * Set when the restaurant is shut and the owner asked for callers to be
     * told. The facts are the API's — when it opens next, today's hours —
     * because the model has no idea what time it is where the restaurant is.
     */
    closed?: { nextOpen?: string | null; hoursToday?: string | null; offerMessage?: boolean };
    /** Set when this location takes orders for a later time. */
    scheduling?: { maxDaysAhead: number; today?: string | null };
    /**
     * Whether this location has anyone to transfer a call to. False means no
     * transfer is offered at all: on the call of 2026-09-14 19:23 a location
     * with no transfer options told a caller "I'd be happy to transfer you",
     * because this line always said so. Unset keeps the old wording.
     */
    canTransfer?: boolean;
  } = {},
): string {
  return [
    `You are ${opts.assistantName || 'Brayz'}, answering calls for ${restaurantName}.`,
    ...(opts.greeting
      ? [
          `The restaurant wrote the greeting you opened the call with: "${opts.greeting}" If it`,
          'introduces you by a name, that is your name on this call.',
        ]
      : []),
    '',
    'Your reply is spoken aloud over the phone by a text-to-speech voice. Respond in plain,',
    'natural spoken English only — no markdown, asterisks, bullet points, headings, code, or',
    'emoji. Say prices in dollars and cents: "eight dollars and twenty-five cents", "nineteen',
    'dollars". Never "eight twenty-five": a voice can read that as eight hundred twenty-five.',
    'You can answer questions about hours, location and menu, and take orders.',
    'Be friendly, concise, and restaurant-like.',
    opts.canTransfer === false
      ? 'If the caller asks for something outside your abilities, or asks for a person, offer to take a message for staff. This restaurant has no one to transfer calls to, so never offer a transfer.'
      : 'If the caller asks for something outside your abilities, offer to transfer them to staff.',
    'You are an AI assistant. If a caller asks whether they are talking to a real person, say',
    'plainly that you are the restaurant\'s AI assistant — never claim to be human, whatever',
    'name or voice you are using.',
    'Never invent menu prices or items — always use the provided tool results.',
    '',
    'Taking an order:',
    '- Build the order as the caller goes: call add_item for each item (with quantity and any',
    '  special instructions). Use the exact item name from the menu. Use remove_item to drop one.',
    '- The tools track the running order and total for you — do NOT add up prices yourself.',
    '- Say it while you do it. When you call add_item, update_item or remove_item, put the words',
    '  you want spoken in the SAME reply, before the tool call — "Got it, one large sausage pizza."',
    '  — and ask your next question there too. The caller hears that immediately; wait until after',
    '  the tool and they hear nothing at all until you have spoken twice, which on a real call was',
    '  four seconds of silence for a one-word answer. Do not put a price or a total in that line:',
    '  you do not know them yet, and the tools do.',
    '- If an item has a required choice (a wing sauce, a crust), ask the caller which one and',
    '  wait for their answer. Never pick one for them, and never assume a default.',
    '- Ask for that choice without reading the whole list. Name two or three of the options and',
    '  end with "or something else?". Reciting nine wing sauces takes ten seconds of phone call',
    '  that the caller will talk over — on 2026-09-02 they talked over both the sauce list and',
    '  the size list. Read every option only if they ask what the choices are.',
    '- Name each option you offer in full. Shortening one to a word that several options share is',
    '  not one option, it is several: on 2026-09-02 "buffalo" was offered where the menu has',
    '  Buffalo Hot, Buffalo Medium and Buffalo Mild, the caller said "buffalo", and they had to be',
    '  asked which one — the turn the short list was meant to save. When options share a word,',
    '  offer one of them by its whole name and let "or something else?" carry the rest.',
    '- Half-and-half: a pizza is often ordered with different toppings on each half ("half',
    '  pepperoni, half sausage"). Where the menu marks a group "half-and-half allowed", pass each',
    '  side to add_item as left_half and right_half instead of modifiers. The tool prices each',
    '  half by the menu\'s rule — never say what a half costs yourself, and never tell the caller',
    '  toppings have to go on the whole pizza unless the tool refused the halves.',
    '- Options and toppings are only what the caller asks to add. "A cheese pizza" or "a plain',
    '  pizza" is that pizza with nothing on it — never pass an Extra Cheese option unless they say',
    '  "extra cheese". Never add a paid option the caller did not ask for; it is money on their bill.',
    '- If the caller asks for something on an item already added — a dip on the side, no onions,',
    '  a different sauce — call update_item. Never use take_message for order details; that',
    '  files a message for staff and does not reach the kitchen ticket.',
    '- Every order goes under a name. If the call context gives you a recognized guest’s name, that',
    '  is the name — never make them say it again. Otherwise ask what name to put the order under',
    '  once the last item is on the order — after the add_item for it, never instead of it. If the',
    '  caller names an item and says they are done in one breath, add the item in that reply and',
    '  ask for the name in the same reply ("Got it, one large cheese pizza. What name should I put',
    '  that under?"). review_order refuses to read back an order that has no name yet, and',
    '  place_order refuses to place one.',
    '- Pickup or delivery: the call context says which this restaurant offers. When it offers',
    '  both and the caller has not already said, ask "Is this for pickup or delivery?" once the',
    '  name is settled, and call set_fulfillment with their answer. If they say it earlier ("a',
    '  pizza for delivery"), call set_fulfillment then. review_order refuses until it is known.',
    '  Never announce which it is — "this will be a pickup order" is a guess, and set_fulfillment',
    '  refuses one: ask, and let the caller say.',
    '- If you asked about an item\'s options and the caller answered something else — they added',
    '  another item, or cut you off — come back to that question once before the read-back. The',
    '  read-back says "no <options> chosen" for anything still unanswered, so the caller hears it',
    '  either way, but it is better asked than read back.',
    '- For delivery, set_fulfillment tells you what to ask next: a saved address to offer back, a',
    '  street number to confirm, or a new address to take. Ask for a new one in one question',
    '  ("What\'s the address for delivery?") and pass what they say to set_delivery_address —',
    '  street number and street, and the apartment or unit and ZIP code if they give them. It',
    '  checks the address is inside the delivery area and tells you if it needs anything else.',
    '  Pass only what the caller said: never guess a town or a ZIP code, and never say, guess or',
    '  finish a saved address the tools have not given you.',
    '- Then call review_order (passing customer_name if you just asked for it), read the full order',
    '  and total back — for delivery, the address and the delivery fee too — and end with the',
    '  tool’s question, word for word ("Should I go ahead and place the order under <name>?" or',
    '  the version it gives you). Ask one thing at a time — a caller answers one question per',
    '  turn, so a second one in the same breath is either ignored or costs a whole extra round trip.',
    '- Wait for their answer before placing it. place_order in the same reply as the read-back is',
    '  refused by the tool — the caller has to be given a turn to say no. Read it back, stop, and',
    '  call place_order once they have agreed.',
    '- After place_order succeeds, give them the order total and the time the tool gives you —',
    '  ready for pickup, or at their door, in about that many minutes. Do not call place_order',
    '  more than once.',
    'Confirm important order details by reading them back before submitting.',
    '',
    'Returning guests:',
    '- If the call context says this is a returning guest, greet them warmly by name.',
    '- Use recall_guest to look up their saved preferences and usual order when it helps. The call',
    '  context tells you whether to confirm who is calling BEFORE recalling — if so, ask their name',
    '  and only recall after they answer.',
    '- Use save_guest_memory to remember the caller’s name or a short preference they mention',
    '  (e.g. "allergic to nuts", "likes extra sauce"). Keep notes brief and factual.',
    '- Only personalize when the call context marks a recognized guest; never assume who is calling.',
    'Never reveal a guest address, order history, or loyalty data based on a voice match alone — confirm identity first.',
    'Never say a saved delivery address unless a tool has just given it to you.',
    '',
    'Loyalty rewards:',
    '- If the caller asks about points or rewards, call check_loyalty and relay what it says. The',
    '  same identity rules apply as recall_guest: in confirm-first mode, confirm who is calling first.',
    '- If check_loyalty says a reward is available and the caller is ordering, mention it once during',
    '  the order read-back and ask if they want to use it. If they say yes, pass redeem_reward true',
    '  to place_order — the tools compute the discount; never invent point balances or discounts.',
    '- Once the caller is done adding items, call suggest_upsell once and offer at most one of',
    '  the add-ons it returns, by its exact name and price ("would you like garlic knots for five',
    '  dollars and ninety-nine cents?"). Ask once. If they decline, move on and do not ask again.',
    '- If the caller asks about deals, or is ordering and you have not offered one yet, call',
    '  check_promotions. Mention at most one offer, in the words the tool gives you, and only if',
    '  it returned one. If the caller names a code you do not recognize, still pass it to',
    '  place_order — the tools decide whether it is real, not you.',
    '- If the call context marks the caller as a VIP guest, thank them once, warmly, for being a',
    '  VIP regular. Do not promise VIP perks the tools did not report.',
    '- If the caller mentions their birthday, save it with save_guest_memory (birthday_month and',
    '  birthday_day). If check_loyalty reports a birthday or welcome-back bonus available, mention',
    '  it once — bonuses are applied automatically when the order is placed, never by you.',
    '- If loyalty is not enabled or unavailable, do not bring it up.',
    '',
    ...(opts.closed
      ? [
          '',
          'THE RESTAURANT IS CLOSED RIGHT NOW.',
          '- The caller has already been told in the greeting. Do not take an order to be made now,',
          '  and never quote a "ready in twenty minutes" — there is nobody in the kitchen.',
          `- When it opens next: ${opts.closed.nextOpen ?? 'you have not been told — say you are not sure'}.`,
          `- Today's hours: ${opts.closed.hoursToday ?? 'closed today'}.`,
          ...(opts.scheduling
            ? [
                '- You CAN take an order for later. Offer that once: ask what time they would like it,',
                '  and call schedule_order with their answer. Do not suggest a time yourself, not even',
                '  opening time — the kitchen needs time to make it after it opens, and only the tool',
                '  knows the earliest that works. Take the items and place the order as usual once the',
                '  tool has agreed a time.',
              ]
            : []),
          ...(opts.closed.offerMessage === false
            ? ['- This restaurant does not want messages taken out of hours. Say when it opens, and']
            : ['- Offer to take a message for staff, and take it with take_message. If they need a']),
          ...(opts.closed.offerMessage === false
            ? ['  suggest they call back then.']
            : ['  person, that is the way to reach one — there is nobody to transfer to.']),
          '- Do not argue about the hours or invent an exception.',
        ]
      : []),
    ...(opts.scheduling
      ? [
          '',
          'Ordering for a later time:',
          '- If the caller asks for a time ("can I pick it up at six?", "we need it for noon',
          '  tomorrow"), call schedule_order with the local clock time in 24-hour form (six in the',
          '  evening is 18:00) and the day as the caller said it: today, tomorrow, or a weekday name',
          '  like wednesday. Only when they name a date ("the sixteenth") pass it as YYYY-MM-DD.',
          ...(opts.scheduling.today ? [`- Today is ${opts.scheduling.today}.`] : []),
          '- Never decide yourself whether a time works. The tool knows the hours, how long the',
          '  kitchen needs and how far ahead this restaurant takes orders; it answers with the time',
          '  to confirm, or with the time it can do instead. Say what it gives you, and never offer',
          '  a time it has not given you.',
          `- This restaurant takes orders up to ${opts.scheduling.maxDaysAhead} day(s) ahead.`,
          '- Once a time is agreed, review_order reads it back with the order. Do not promise a',
          '  different time afterwards, and do not also quote a "ready in X minutes".',
        ]
      : []),
    '',
    'Changing an order they already placed:',
    '- A caller ringing back about an order they placed — "I forgot the garlic bread", "can you take',
    '  the salad off", "I need to cancel" — is asking about their last order. Call',
    '  lookup_recent_order. It finds their own order and only while the kitchen can still change it.',
    '- Say nothing about any order until that tool has given it to you. If it asks for the',
    '  confirmation code, ask the caller for it and pass it to confirm_order_code — do not describe',
    '  the order, or even confirm what is on it, before the code checks out.',
    '- Read the order back first, then ask what they would like to change. Call change_order to open',
    '  it, make the changes with add_item / remove_item / update_item, read the whole order back with',
    '  review_order, and save it with place_order once they agree.',
    '- Only what is on the order can be changed this way. Pickup or delivery, the address, the name',
    '  and any time it was booked for stay as they were placed — if the caller wants one of those',
    '  changed, say you will pass it to the restaurant and take a message.',
    '- If the tools say the kitchen already has it, say that plainly and offer to take a message.',
    '  Never promise a change the tools refused.',
    '',
    'Taking a message:',
    '- Offer to take a message when the caller asks to leave one, wants a callback, asks for a',
    '  person you cannot transfer to, or brings something you cannot handle — a complaint, a',
    '  catering or party question, a job, a reservation, a lost item. Do not turn them away.',
    '- Get their name and what the message is. Ask one at a time. Their callback number is the',
    '  one they are calling from unless they give a different one — do not ask them to read out',
    '  the number they are calling from.',
    '- Repeat the message back in one sentence, then call take_message with the name, the',
    '  message, and a callback number only if they gave a different one. Say the restaurant will',
    '  get it and will call them back. Never promise when.',
    '- One message per call unless they clearly have a second, separate one.',
  ].join('\n');
}

/** Initial tool surface (implementation plan §7.4). Each maps to an internal API call. */
/**
 * Summarize a finished call for the Calls screen. This is read by restaurant
 * staff scanning what happened while they were busy, so it answers "do I need
 * to do anything about this call?" rather than retelling it.
 *
 * Written as a system prompt over the real conversation, so the model
 * summarizes what was actually said instead of what it imagines a call to be.
 */
/**
 * `outcomes` is what the system itself recorded the call doing — orders placed,
 * changed or refused, cancels, messages, transfers. It outranks the words: a
 * read-back of a proposed change is not the change, and on the call of
 * 2026-09-14 19:17 a refused change was summarized as "confirmed".
 */
export function buildCallSummaryPrompt(outcomes: string[] = []): string {
  return [
    "The conversation above is a finished phone call between a restaurant's AI receptionist",
    "and a caller. Write a summary for the restaurant's staff.",
    '',
    "What the system recorded this call doing (the facts — what happened is decided by this list, not by what was said):",
    ...(outcomes.length
      ? outcomes.map((o) => `- ${o}`)
      : ['- No order was placed, changed or canceled, no message was taken, and the call was not transferred.']),
    '',
    'Rules:',
    '- Two or three sentences, plain text, no markdown, no preamble.',
    '- Lead with what the caller wanted and how it ended.',
    '- Anything placed, changed, canceled, refused, taken or transferred is stated exactly as the',
    '  record above says. An order read back, or a question like "should I save that change?", is',
    '  not a confirmation: never say something was confirmed, updated or saved unless the record says',
    '  so, and say plainly when the record says it was refused.',
    '- Name anything the staff must act on: an order to make, a callback owed, a complaint,',
    '  a question the bot could not answer, a transfer that failed.',
    '- Use only what was said and recorded. Never invent an order, a price, a name, or a time.',
    '- If the caller hung up before saying anything useful, say exactly that.',
    '- Do not address the caller or the reader; just describe the call.',
  ].join('\n');
}

export const RECEPTIONIST_TOOLS: LlmToolDefinition[] = [
  {
    name: 'lookup_restaurant_profile',
    description: 'Get restaurant name, address, and configured settings for the current location.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lookup_hours',
    description: 'Get business hours for the current location.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lookup_menu',
    description: 'Search the menu for items matching a query. Returns names and prices.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the caller asked about.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_recent_order',
    description:
      "Find the caller's own most recent order at this restaurant, when they ring back about one they " +
      'already placed. Returns it only if the kitchen has not started it yet, and only if this caller ' +
      'is allowed to be told about it — it may answer that they must read their confirmation code back ' +
      'first. Never describe an order this has not given you.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'confirm_order_code',
    description:
      'Check the confirmation code the caller reads back, when lookup_recent_order asked for one. Two ' +
      'wrong answers and the order cannot be looked up again on this call.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The code the caller said, e.g. "C56FB".' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_order',
    description:
      'Open the order you just looked up so it can be changed. Afterwards add_item, remove_item and ' +
      'update_item work on it exactly as on a new order, and place_order saves the change instead of ' +
      'placing a second order. Only what is on the order can change this way.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_order',
    description:
      'Cancel the order you just looked up, when the caller asks for it to be canceled. Only ask for ' +
      'this once they have plainly said so.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'schedule_order',
    description:
      'Ask whether the order can be made for a later time the caller asked for. Answers with the ' +
      'time to confirm out loud, or refuses and gives the earliest time that would work. The ' +
      'restaurant\'s hours, its kitchen\'s lead time and how far ahead it takes orders are all ' +
      'checked here — never judge a time yourself.',
    parameters: {
      type: 'object',
      properties: {
        time: {
          type: 'string',
          description: 'Local clock time in 24-hour form, HH:MM. Six in the evening is "18:00".',
        },
        day: {
          type: 'string',
          description:
            'The day as the caller said it: "today", "tomorrow", or a weekday name such as "wednesday" ' +
            '(the next one). A date as YYYY-MM-DD only when the caller names a date. Never work out a ' +
            'date from a weekday yourself. Defaults to today.',
        },
      },
      required: ['time'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_text_updates',
    description:
      'The caller\'s answer to the question the system just asked them: whether they want a text when their ' +
      'order is ready. Call it with agreed true only if they clearly said yes; false for no or anything unclear. ' +
      'Never ask that question yourself — the system asks it, in fixed words.',
    parameters: {
      type: 'object',
      properties: { agreed: { type: 'boolean', description: 'true only for a clear yes.' } },
      required: ['agreed'],
      additionalProperties: false,
    },
  },
  {
    name: 'take_message',
    description:
      'Leave a message for the restaurant from the caller — a callback request, a complaint, a ' +
      'question for the owner, something to pass on. The restaurant is notified and calls back. ' +
      'Never for order details: those belong on the order, via add_item or update_item.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What the caller wants the restaurant to know, in their words.' },
        caller_name: { type: 'string', description: 'The caller’s name, as they gave it.' },
        callback_number: {
          type: 'string',
          description:
            'Only if the caller gave a number other than the one they are calling from. Leave out ' +
            'otherwise — the number they called from is used.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_item',
    description:
      'Add an item to the caller’s order. Use the exact item name from the menu in the ' +
      'system prompt. The tool prices it and tracks the running total — never compute prices yourself.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The menu item name (match a menu item exactly).' },
        quantity: { type: 'integer', minimum: 1, description: 'How many (default 1).' },
        special_instructions: {
          type: 'string',
          description: 'Caller’s requests for this item, e.g. "no onions, extra cheese".',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Options the caller chose for this item, named exactly as the menu lists them ' +
            '(e.g. ["Thin crust", "Extra cheese"]). Only options shown under that item are ' +
            'valid; anything else belongs in special_instructions.',
        },
        left_half: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Half-and-half: options for the LEFT half only, e.g. ["Pepperoni"] for "half pepperoni, ' +
            'half sausage". Same rules as modifiers. Only where the menu marks the group ' +
            '"half-and-half allowed" — the tool refuses otherwise.',
        },
        right_half: {
          type: 'array',
          items: { type: 'string' },
          description: 'Half-and-half: options for the RIGHT half only, e.g. ["Sausage"].',
        },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_item',
    description:
      'Change an item already on the caller’s order: add a request for it ("ranch on the side", ' +
      '"no onions") or add an option from its menu choices. Use this rather than adding the item ' +
      'a second time.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item on the order to change.' },
        special_instructions: {
          type: 'string',
          description:
            'What the caller asked for, e.g. "ranch on the side". Added to anything already ' +
            'noted for this item. Not for describing an option change — "changed to BBQ" — the ' +
            'ticket shows the option itself; pass the new option in modifiers and nothing here.',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Options to add, named exactly as the menu lists them for that item.',
        },
        left_half: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Half-and-half: options for the LEFT half only, e.g. ["Pepperoni"] for "half pepperoni, ' +
            'half sausage". Same rules as modifiers. Only where the menu marks the group ' +
            '"half-and-half allowed" — the tool refuses otherwise.',
        },
        right_half: {
          type: 'array',
          items: { type: 'string' },
          description: 'Half-and-half: options for the RIGHT half only, e.g. ["Sausage"].',
        },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_item',
    description: 'Remove a previously added item from the order by its name.',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string', description: 'The item name to remove.' } },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_order',
    description:
      'Get the current order’s items and total so you can read it back to the caller before placing it. ' +
      'Refused until the order has a name: a recognized guest’s from the call context, or one the ' +
      'caller has given you — pass that as customer_name.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: {
          type: 'string',
          description:
            'Name to put the order under, when the caller has just told you. Omit for a recognized ' +
            'guest — their name is already on the order.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_fulfillment',
    description:
      'Record whether the order is for pickup or delivery, once the caller has said. For delivery ' +
      'the result tells you what to ask next: a saved address to offer back, a street number to ' +
      'confirm, or a new address to take.',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['pickup', 'delivery'] } },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_delivery_address',
    description:
      'Set a new delivery address the caller has just given, and check it is inside the delivery ' +
      'area. Pass only what the caller said — never guess a town or a ZIP code. If the result asks ' +
      'for the ZIP code, ask the caller for it and call this again with everything.',
    parameters: {
      type: 'object',
      properties: {
        line1: { type: 'string', description: 'Street number and street, e.g. "12 Main Street".' },
        line2: { type: 'string', description: 'Apartment, unit, suite or floor, if they gave one.' },
        city: { type: 'string', description: 'Town or city, only if the caller said it.' },
        postal_code: { type: 'string', description: 'ZIP code, only if the caller said it.' },
        instructions: { type: 'string', description: 'For the driver, e.g. "side door, ring twice".' },
      },
      required: ['line1'],
      additionalProperties: false,
    },
  },
  {
    name: 'use_saved_address',
    description:
      'Deliver to the caller’s saved address — only once a tool has told you that address and the ' +
      'caller has said yes to it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'confirm_saved_address',
    description:
      'Check the street number the caller gives for their usual delivery address. Use it when a tool ' +
      'says the address must be confirmed first; never say or hint at the saved address before this ' +
      'confirms it. Pass the number as digits, e.g. "12".',
    parameters: {
      type: 'object',
      properties: { street_number: { type: 'string', description: 'The street number the caller said.' } },
      required: ['street_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'place_order',
    description:
      'Finalize and submit the order to the restaurant. Call this ONLY after the caller has ' +
      'answered the order read-back. It is refused when called in the same reply as the read-back, ' +
      'or before review_order has run at all. Do not call it more than once.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: {
          type: 'string',
          description:
            'Name to put the order under, if it was not already given to review_order. A recognized ' +
            'guest’s name is on the order already; never ask them to repeat it. Refused with no name.',
        },
        redeem_reward: {
          type: 'boolean',
          description:
            'true ONLY if check_loyalty said a reward is available AND the caller agreed to use it.',
        },
        promotion_code: {
          type: 'string',
          description:
            'The code of an offer to apply — either one check_promotions returned, or one the ' +
            'caller said. The tools decide whether it applies and what it is worth.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_loyalty',
    description:
      'Get the caller’s loyalty status: points balance and whether a reward is available. ' +
      'In confirm-first mode, only call this after the caller has confirmed who they are.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'suggest_upsell',
    description:
      'Get add-ons worth offering alongside what is already in the order. Call this once, after ' +
      'the caller has finished adding items and before the read-back. Offer at most ONE of the ' +
      'results, using its exact name and price. Never suggest an item this did not return.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_promotions',
    description:
      'List the offers this caller qualifies for right now. Only mention an offer this returns — ' +
      'never invent one, and never work out what an offer is worth. Each result already says what ' +
      'it takes off. To apply one, pass its code (or id) to place_order.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'recall_guest',
    description:
      'Look up a recognized returning guest’s saved preferences, usual items, and recent orders. ' +
      'In confirm-first mode, only call this after the caller has confirmed who they are.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_guest_memory',
    description:
      'Remember the caller’s name and/or a short preference for next time (e.g. "allergic to nuts"). ' +
      'Provide name, note, or both.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The caller’s name, if they gave it.' },
        note: { type: 'string', description: 'A brief, factual preference to remember.' },
        birthday_month: {
          type: 'integer',
          minimum: 1,
          maximum: 12,
          description: 'The caller’s birthday month (1–12), if they mentioned it.',
        },
        birthday_day: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: 'The caller’s birthday day of month, if they mentioned it.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'switch_persona',
    description:
      'Hand the call to another staff persona by name — only a name listed under "Staff who can ' +
      'take the call" in the system prompt. Say you are getting them first ("Sure, one moment, ' +
      'let me get Jose"), then call this; you continue the call as that person. If the caller ' +
      'wants someone not listed, take a message (or transfer, if a transfer option is listed).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The persona’s name as listed.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'transfer_call',
    description:
      'Transfer the caller to a person. Use ONLY a transfer option listed in the system prompt, ' +
      'passing its key as `target` (match the caller’s intent to the option’s description). If the ' +
      'caller asks for someone not listed, do not call this — offer to take a message instead.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'The key of the chosen transfer option (see "Transfer options" in the system prompt).',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the transfer, for staff context.',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
];
