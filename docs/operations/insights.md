# Insights

`/app/insights` answers the question a restaurant asks at renewal: **what did Brayz actually do for
me?** The dashboard says what is happening right now; Insights says what happened over a stretch of
time — a week, a month, a year.

`GET /v1/locations/:locationId/insights?from&to&tz&bucket&top` returns the whole screen in one
payload. It is tenant-scoped like every other location read (rule #1) and needs only membership, not
a manager role: it is the restaurant's own trade, and it reveals nothing a member cannot already see.

## Days are cut where the restaurant is

Buckets and the "after hours" test use the **location's own timezone** by default, not the browser's
and not UTC. A Friday night order at 20:00 in New York is a Saturday in UTC, and counting it on
Saturday would make every weekend look wrong. The series is gap-free: a quiet day comes back as zero
rather than missing, so a chart never has to guess what a hole means.

## "Calls that would have rung out"

The temptation is to count every answered call and call them all saved. That is flattering and
false: a restaurant that would have picked up anyway was saved nothing.

A call is counted only when it would genuinely have gone unanswered:

- it came in **outside opening hours** (weekly hours, with holiday rows overriding their date, and a
  shift that closes after midnight keeping the previous day open into this one); or
- it arrived **while another call was already on the line** — the second ring at a restaurant with
  one handset.

A call that was both is counted once. The breakdown of each is shown underneath, so the number can
be taken apart. **A location with no opening hours saved reports zero after-hours calls** and says
so on the screen, rather than implying its calls all arrived mid-service.

A call still in progress (no end recorded) counts for itself but is never used to say a later call
was competing with it: an unfinished row is as often a lost end event as a live call, and it must
not inflate the number.

The logic is pure and unit-tested in `services/api/src/lib/insights.ts`.

## What the rest of the numbers mean

| Number | Where it comes from |
|---|---|
| Orders captured, revenue, average | Confirmed orders in the window. A **canceled order is never revenue**. |
| Pickup / delivery split, delivery fees | `orders.fulfillmentType` and the fee stored on the order. |
| Upsell revenue | Order lines the engine marked `viaUpsell` — attribution from what the bot actually offered, not what the model said it did — priced from the stored line, so it matches what the guest was charged. |
| Discounts given | Subtotal plus fee, less the total: loyalty rewards and promotions, as actually applied. |
| Loyalty | `loyalty_events` in the window: points earned, redemptions, birthday and win-back bonuses. |
| Guests who ordered | Distinct guests with an order in the window, split into **returning** (they have ordered here more than once — a first visit earlier in the same window counts) and **new** (this is their only order here so far). Counted as of the window's end, so an old report does not change when they order again. |
| Favourite items | `order_items` grouped by name — the name as sold, so a renamed item does not merge with its old self. |
| Top guests | Orders and spend in the window, with lifetime spend alongside. |

Recordings and transcripts are **not** duplicated here; the screen links to Calls, which already
plays them back and audits the playback (rule #6).

## The two views

Insights has tabs over the same window:

- **Overview** — what happened: calls, orders, upsell, loyalty, guests, favourite items. The
  option breakdown here is **trimmed** — the first few groups, the first few options in each —
  because the point of the overview is a glance.
- **Menu items** (`/app/insights/items`, `GET /v1/locations/:id/insights/items?from&to&tz`) — every
  item on the menu and what it sold, **including the ones that sold nothing**.

The second view is built **from the menu**, with sales joined onto it. That is the whole reason it
exists: an item nobody ordered has no order rows to be found in, so counting from orders can never
show it, however the counting is done. Favourites answers "what sells"; this answers "what earns its
place on the menu", which is the one a restaurant acts on.

Three details that are deliberate:

- **`lastOrderedAt` reaches outside the window.** "Nothing this month" and "nothing since June" are
  different facts, and the second is what decides whether an item comes off the menu.
- **Revenue is the price charged on the line**, not today's menu price, so a price change since does
  not rewrite last month's takings.
- **An item hidden from the AI is flagged rather than blamed.** It cannot sell while it is hidden,
  which is a different problem from one nobody wants.

Items sold in the window but no longer on the menu — deleted since, or lines the menu could not
price — are listed separately as **off-menu** rather than dropped: the money was taken either way,
and a total that quietly omits it is wrong.

## Ranges

The range and bucket pickers are the staff portal's (`apps/web/lib/histogram.ts`), so both screens
snap to whole buckets and handle DST the same way. A range that would draw more than
`CALL_HISTOGRAM_MAX_BUCKETS` bars is refused with `too_many_buckets` rather than served slowly.

## Deliberately not here

Anything Brayz cannot measure honestly. There is no "revenue saved" or "hours of staff time saved"
figure: both would be a guess dressed as a metric.

## What was chosen on each item

"A large pizza sold 34 times" is a number. *Which toppings went on them* is what stock is
ordered against, and it lives on the **Menu items** tab: open any row and the options chosen
on it appear, kept in the groups the menu asks them in — toppings apart from crusts, a wing
sauce apart from its dip — with each option's share of that item beside the count ("Pepperoni
20 (59%)").

Counting rules, the same ones the overview uses:

- summed on the **line's quantity**, so two pizzas on one line with pepperoni are two
  pepperonis, not one;
- halves fold into their option — pepperoni on half a pizza is still pepperoni being ordered;
- an option the menu can no longer place (asked for out loud, or since deleted) is kept under
  **Other** rather than dropped or filed under a group it never belonged to;
- **uncapped here**, unlike the overview: a breakdown that quietly drops the seventh topping
  is not a record of what sold.

## Export

Two CSVs, from the Menu items tab, over whatever range is on screen:

| File | A row per | Columns |
|---|---|---|
| `insights/items.csv` | menu item | category, item, menu price, on menu, available, quantity, order lines, revenue, last ordered |
| `insights/item-options.csv` | item + option | category, item, option group, option, quantity, share of item |

Two files rather than one because they count different things: an item's quantity and a
topping's quantity summed in the same column would be nonsense in a pivot table. Money is a
plain number with no symbol, so a spreadsheet adds it up instead of reading it as text. Items
sold in the window but **no longer on the menu** are in the items file, last, marked
`on_menu=no` — the money was taken either way.

Both exports are the same data as the screen, built from the same query, at the same access
level: the restaurant's own trade, with no guest in it.
