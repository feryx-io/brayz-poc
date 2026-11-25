# Closed hours, and orders for later

Until now the bot answered a 4am call exactly as it answered a lunchtime one: it took the
order, quoted "ready in about twenty minutes", and texted a ticket to a dark kitchen. The
hours were saved in Settings, shown on the dashboard, and counted by Insights — the one
thing that never read them was the AI.

Two settings fix that, both per location, both off until an owner turns them on.

## When you're closed

`LocationAiSettings.closedBehavior`:

| Value | What a caller hears |
|---|---|
| `take_orders` (default) | Exactly what they heard before. No change on deploy. |
| `announce` | "We're closed right now. We open again tomorrow at 11:00 AM." |

The announcement is part of the **greeting**, not left to the model's first turn. It takes
the place of the question the owner's greeting ends on ("What can I get started for you
today?"), since it ends on its own offer; a greeting with no closing question gets it
appended. The first thing a caller at 8am needs is to know nobody is
cooking — and an owner's greeting that ends "what can I get started for you today?" is a
promise the kitchen cannot keep.

While closed in `announce` mode, `place_order` is refused twice over: the engine holds it
(it already knows), and the **API refuses it too** — that is where an order becomes real
(rule #5), and a confused model must not be able to book a dark kitchen.

**A location with no hours saved is treated as open.** We do not know it is shut, and
turning a real caller away on a guess is the worse mistake. The same posture Insights
takes when it reports zero after-hours calls.

`offerMessageWhenClosed` — saved since Phase 1 and never read by anything — now decides
whether the closed caller is offered a message.

## Orders for later

`scheduleOrdersEnabled`, with `scheduleMaxDaysAhead` (0 = today only; default 1).

This works **whether the restaurant is open or closed**: "can I pick that up at six?" is an
ordinary lunchtime question, and an overnight caller ordering for opening time is the same
mechanism.

The model's only job is to hear a time. It passes a local clock time and the day **as the
caller said it** — `today`, `tomorrow`, or a weekday name (`wednesday`, meaning the next one;
today's own name is today) — to `schedule_order`. A `YYYY-MM-DD` date only when the caller
names a date, and the prompt carries today's date ("Today is Monday, September 14") for
that. Never an instant, and never a date worked out from a weekday: on 2026-09-14 the model,
not told the date, turned "Wednesday" into 2026-09-02 on 5 of 6 replays. The API answers:

- **yes**, with the time phrased for reading back ("tomorrow at 6:00 PM"); or
- **no**, with the reason and **the earliest time that would work**, so the bot always has
  something to offer rather than a dead end. A `too_far` refusal also carries `latest`: the
  same clock time on the last day the location takes orders for, when that works — a
  caller asking about Wednesday wants the furthest day on offer, not the soonest.

The bot never proposes a time itself, opening time included: the kitchen needs its lead
time after the doors open, and only the tool knows the earliest that works. Once a time is
booked, `set_fulfillment` quotes it ("ready tomorrow at 6:00 PM, as booked") rather than a
wait in minutes.

Refusals are `closed_then`, `too_soon` (sooner than the kitchen's own pickup ETA),
`too_far`, `past`, `disabled`, `hours_unknown`. The decision is pure and unit-tested in
`services/api/src/lib/schedule.ts`; the calendar arithmetic — DST included — is in
`services/api/src/lib/hours.ts`, which Insights now shares, so the rule that counts a call
as after-hours is the same rule that tells a caller the restaurant is shut.

Once a time is agreed it is **read back with the order** (it is part of what the caller is
agreeing to), stored on `orders.scheduledFor`, and re-validated by the order route. The
confirmation is quoted by its time — "ready for pickup tomorrow at 6:00 PM" — never also as
a wait in minutes.

## What the kitchen sees

A scheduled order goes to the kitchen **immediately**, the way a call-ahead always has, with
the time on it:

- the SMS leads with `FOR TOMORROW AT 6:00 PM —`, in capitals;
- the POS ticket note carries the same, ahead of any other note;
- the Orders board sorts by when an order is **due**, not when it was taken, and a
  scheduled ticket is not counted late until its time has come. Otherwise a 9am call-ahead
  for six o'clock sits red at the head of the board all day.

Holding tickets back and releasing them near the time would need a scheduler and a queue
nobody can see; it is deliberately not built.

## Where it lives

| Piece | File |
|---|---|
| Hours arithmetic (open now, next opening, DST, spoken forms) | `services/api/src/lib/hours.ts` |
| Can it be made for that time? | `services/api/src/lib/schedule.ts` |
| One location's hours, loaded once | `services/api/src/lib/locationSchedule.ts` |
| Tools: `profile` (open state), `schedule` | `services/api/src/routes/tools.ts` |
| Order refusal + storage + ticket | `services/api/src/routes/orders.ts` |
| Greeting, prompt, `schedule_order`, read-back | `services/orchestrator/src/conversation.ts` |
| Settings UI ("When you're closed") | `apps/web/app/app/settings/page.tsx` |
