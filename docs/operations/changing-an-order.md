# Changing an order already placed

"I just ordered — can I add a Coke?" Until now the bot had no tool that could see an order,
let alone change one: the best it could do was take a message and leave a human to sort it
out. Now it can read the order back, change what is on it, or cancel it.

## Which order

**The caller's own, at this location, that the kitchen has not accepted.** Status decides it,
not the clock: `confirmed` means the ticket is sitting there; anything past it means somebody
is already cooking, and a bot must not rewrite that. A locked order is reported *as locked*,
with its status, so the caller hears "it's already being made" rather than "I can't find it".

The caller is matched by their number — the guest the call already resolved to, or the guest
that number belongs to. A number with no guest behind it has nothing to find, and is told so.

## Who may hear about it

The same gate as the saved delivery address (rule #6), driven by the location's
`guestMemoryMode`:

| Mode | What a caller gets |
|---|---|
| `full` | The caller-id match is enough, as it already is for their name and their address. |
| `confirm` | Only that an order exists. **Nothing about it** — not a line, not the total — until they read their confirmation code back. Two wrong answers and it is not offered again on that call. |
| `off` | No lookup at all. |

Every read that returns an order is written to the audit log (`order.voice_lookup`), as are
the change (`order.changed`) and the cancellation (`order.canceled`).

## What can change

**What is on the order.** Items can be added, removed and amended exactly as they were the
first time: the engine seeds its in-call draft from the placed order, so `add_item`,
`remove_item`, `update_item`, halves, options and the read-back all behave identically, and
the whole order is read back and agreed before it is saved.

**Not** where it is going. Pickup or delivery, the address, the name on it and any time it was
booked for stay as they were placed — a caller who wants one of those changed gets a message
taken. Rewriting an address from a phone call the driver cannot see is not a thing to do
quietly.

The saved order is asked for as **the whole list of lines, not a diff**: the API prices one
list rather than replaying edits it cannot see. Every line re-prices from the live menu
(rule #5), so an order changed on a second call costs what it would have on the first.

Two rules survive the change:

- a delivery order still has to meet the **delivery minimum** after a removal, or the change
  is refused and the bot says why;
- any **discount already given** — a loyalty reward, a promotion — is carried across whole
  rather than recomputed. It was granted; taking it back because the caller added a drink
  would be a nasty surprise.

Loyalty points follow the new total. The ledger is append-only, so the difference is its own
entry (`Order changed`) rather than a rewrite of the earn, keyed on the new total so a replay
cannot double it.

## What the restaurant sees

A change texts the restaurant a message that reads as a change in its first word — `CHANGED —
order #C56FB is now: …. Total $22.00 (was $19.00).` A ticket already pushed to the POS adds
*"Amend the ticket on the till."*: the Square adapter can create an order and set its status,
but it cannot edit lines, so Brayz updates its own record and tells a human rather than
pretending the till changed. A cancellation texts `CANCELED —` and does push the cancel to
the POS, the same way the dashboard does.

## Known gaps

- **A cancelled order keeps its loyalty points.** The dashboard's cancel has always behaved
  this way; the voice path matches it rather than inventing a second behaviour. Worth fixing
  in both places at once.
- Changing fulfilment, address or the booked time is a message, not a change.
- The POS ticket is not rewritten — see above.
