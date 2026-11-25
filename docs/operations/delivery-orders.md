# Delivery orders

Brayz takes delivery orders as well as pickup. When a restaurant does both, the AI asks every caller
"Is this for pickup or delivery?". For a delivery it takes the address, checks the address is inside
the delivery area, and reads the address and the delivery fee back with the order. The address is
kept on the guest, so their next call can be asked "Are we still delivering to 12 Main Street, or
someplace else?".

Dispatch is out of scope. Brayz does not route drivers, track them live, measure drive time, or price
delivery by zone. It takes the order and knows where it goes.

## Settings (Settings → Pickup & delivery)

| Setting | Column (`locations`) | Notes |
|---|---|---|
| Take pickup / delivery orders | `pickupEnabled`, `deliveryEnabled` | With only one on, nobody is asked; that is what an order is. With both off, the AI falls back to pickup rather than refusing every order. |
| Pickup ready in / delivery arrives in | `pickupEtaMinutes` (20), `deliveryEtaMinutes` (45) | Quoted after the order is placed: "ready in about 20 minutes". |
| Delivery fee | `deliveryFeeCents` | The API adds it to the total. Discounts come off the food, never the fee. |
| Minimum order | `deliveryMinimumCents` | Counts the food before the fee. |
| Radius | `deliveryRadiusMiles` | Straight-line distance from the restaurant, 0.5–50 miles. |
| ZIP codes | `deliveryZipCodes` | Normalized on save (`12866-1234` becomes `12866`). |

**The delivery area has two rules, and either one qualifies an address.** The address is inside the
radius, or its ZIP is on the list. With neither set, delivery goes anywhere. The decision is
`decideArea` in `services/api/src/lib/delivery.ts`, and it is pure.

## Where an address is placed

The radius needs the restaurant's position and the caller's. Both come from a `GeocodingProvider`
(`services/api/src/lib/geocoding.ts`, rule #2). The provider is the US Census geocoder: free, no key,
US addresses only. It needs either a ZIP or a city plus state.

- The restaurant's position is found when the owner saves a radius, or on the first delivery call
  that needs it. It is kept in `locations.latitude/longitude`. Editing the address clears it, so the
  radius is measured from where the restaurant is now. Settings shows a warning while the restaurant
  has not been found.
- A caller's address is looked up only when the radius needs it. A listed ZIP answers straight away,
  with a caller waiting on the line. A caller rarely names their own town, so the restaurant's city
  and state are used when they don't.

| Outcome | `check` | What happens |
|---|---|---|
| No rules set | `no_rules` | Delivered |
| ZIP is listed | `in_zip` | Delivered |
| Within the radius | `in_radius` | Delivered |
| ZIP rule, but the caller gave no ZIP | `needs_zip` | The AI asks for the ZIP |
| Radius rule, and the address could not be placed | `unverified` | **Taken**, and flagged on the ticket and in the text |
| Every rule answered, none says yes | `outside` | Refused; the AI offers pickup or another address |

A failed lookup never loses an order. If Census is down or slow (4 s timeout), radius checks come
back `unverified` and orders keep coming in, marked "not checked".

## Privacy (rule #6)

The saved address is guest memory. It follows the location's memory mode and the guest's opt-out:

- **full**: `/tools/guest` returns `savedAddress`, and the AI offers it back by name.
- **confirm**: `/tools/guest` says only `hasSavedAddress: true`, and the engine never receives the
  address. The AI asks "Can you confirm the street number on your usual delivery address?".
  `POST /v1/calls/:id/tools/guest/address/confirm` compares the number with the saved house number and
  returns the address only on a match. The read is audited as `guest_profile.accessed`
  (`field: deliveryAddress`). After two wrong numbers it is not offered again on that call. Each miss
  is a `guest.address_confirm_failed` call event.
- **off**, or an opted-out guest: nothing is offered and nothing is saved.

An address is saved when a delivery is placed. The audit entry is `guest.memory.updated`
(`via: order`), written only when the address changed. Owners can edit or remove it on the guest's
page (`PATCH /v1/guests/:id { deliveryAddress | null }`).

## How it fits together

- **Engine** (`services/orchestrator/src/conversation.ts`). There are four tools: `set_fulfillment`,
  `set_delivery_address`, `use_saved_address` and `confirm_saved_address`. They are handled by the
  engine, like the other order tools. `review_order` and `place_order` refuse until the order is
  settled: pickup or delivery must be known, a delivery needs an address that passed the check, and
  the food must meet the minimum. This works like the name gate; the rule is in the tool, not the
  prompt. A pickup-only restaurant's read-back is word for word what it was before.
  **Which one it is comes from the caller.** `set_fulfillment` refuses a value the caller has
  neither said nor been asked for, because on 2026-09-11 the bot announced "this'll be a pickup
  order" and the caller had to correct it into a delivery. The check is satisfied by the caller's
  own words ("I'll pick it up", "can you deliver") or by the question having been put to them and
  answered. A restaurant that offers only one way is preset and never reaches it.
- **Choices the caller never made.** A menu group the item *requires* stops the read-back until it
  is chosen (`update_item`), the same way a missing name does. A group that is merely offered is
  named in the read-back instead — "1 Quesadilla (no Toppings chosen)" — so a question the caller
  talked over is still heard before they confirm. That case is real: on 2026-09-11 the bot was
  listing the Quesadilla's toppings, the caller cut in with the next item, and a plain Quesadilla
  went to the kitchen with the question unfinished.
- **API**:
  - `POST /v1/calls/:id/tools/delivery/check` answers during the call.
  - `POST /v1/calls/:id/order` asks the same questions again when the order is placed. It refuses with
    `pickup_unavailable`, `delivery_unavailable`, `delivery_address_required`,
    `below_delivery_minimum`, `delivery_zip_required` or `outside_delivery_area`.
  - The order stores `deliveryAddress` (a snapshot), `deliveryFeeCents` and `deliveryAreaCheck`.
  - Loyalty points are earned on the food, not the fee.
- **POS**. Square gets a `DELIVERY` fulfillment with the recipient's address, and the fee as a
  service charge, so Square's total matches the one the caller heard.
- **Kitchen**. The Orders screen shows the address and driver notes on the ticket and the card, plus
  a warning when the address was not checked. The text reads "New delivery order #… Deliver to …".

## Deploying

The `delivery_orders` migration only adds columns, and the defaults leave every existing location
pickup-only. No Terraform change is needed. The API calls `geocoding.geo.census.gov` over the
internet.
