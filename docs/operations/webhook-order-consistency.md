# Webhook and order consistency

Deploy migrations `20260913210000_webhook_order_consistency` and
`20260913220000_order_granted_discount` before deploying the API. Both are add-only:

```bash
npm run migrate:deploy -w @brayz/db
npm run db:generate
npm run build
```

They add the last Stripe event timestamp to each location subscription, a
revision counter to orders, and the discount granted when an order was placed
(`orders.discountCents`, backfilled from each order's totals).

## Webhooks

Webhook delivery IDs now commit in the same transaction as their business updates.
A processing or database failure returns an error and leaves the delivery retryable.

Retrying is kept for failures a retry can fix. An event nothing will ever change
is recorded and acknowledged with a warning in the log. Stripe disables an endpoint
that keeps failing, and SiphonAI's spool is capped, so a delivery that can never
succeed would cost other deliveries.

- **Stripe, acknowledged:** events we don't consume; a subscription with no
  location metadata and no row linked to its subscription or customer (e.g. one
  created in the Stripe dashboard, or for another product on the same account);
  metadata naming a location that no longer exists; a subscription Stripe says
  does not exist.
- **Stripe, retried:** Stripe unreachable while reading the subscription back;
  a database failure.
- **SiphonAI `recording_uploaded` for a call we cannot find:** retried (503) for
  15 minutes after the upload's own `timestamp`, then acknowledged. A call row is
  written when the call starts, so a miss after that is a call we never recorded.

Recording storage audit entries commit with the recording update.

### Stripe ordering

Stripe events must include their original `created` timestamp. Events older than
the last one applied to a location are ignored. With a billing provider
configured, each event reads the current subscription from Stripe and applies
that state, not the event payload. This handles events sharing a timestamp.

The Stripe read happens **before** the database transaction, so no connection or
lock is held while Stripe answers. The write then locks the location
`FOR NO KEY UPDATE` (this blocks other billing writes but not new calls or orders
for the location). If the subscription row changed after it was read, the Stripe
read is repeated. Stripe requests time out after 10 seconds.

An event for a subscription the location has moved off (typically the old one's
`deleted`, landing after the replacement was created) does not replace a live
subscription with a canceled one.

Without a provider (`STRIPE_SECRET_KEY` unset), events apply their own payloads in
arrival order, and checkout completion only links the customer and subscription;
the subscription's events set its plan and status.

Delivery records written by older versions remain deduplicated. If an earlier
deployment lost an event after claiming it, investigate the specific delivery
before removing its delivery record and requesting a replay from the sender.

## Orders

Order amendments, cancellations, and dashboard status changes compare the current
status and revision before updating. A competing change returns 409; refresh the
order before retrying.

On a call, a change or cancel for an order the kitchen has already taken returns
409 `order_locked` (with its status), and the bot tells the caller it is already
with the kitchen. An `order_changed` 409 means the order moved after it was read
to the caller; the bot drops its draft and looks the order up again. Either way the
draft is discarded, so a later `place_order` cannot place it as a second order.

- **Kitchen texts** include modifiers, half selections, line instructions, and
  order notes. A change's text is keyed on the revision it made, so two changes
  that come to the same total are both sent.
- **Loyalty** adjustments for a change are keyed on the revision too, so points
  follow $10 → $20 → $10 → $20 correctly.
- **Discounts** come off the food, never the delivery fee, on a change as on
  placing. The granted amount stays on the order, so food removed and added back
  gets the whole discount again.
- **Option groups** are enforced on placing and changing: a required choice (or
  `minSelections`) must be made and `maxSelections` not exceeded (`422
  modifier_required` / `modifier_limit`). A half-and-half is checked per side. A
  group whose options are all unavailable asks nothing. The Orchestrator hands
  these two refusals back to the conversation, so the bot sorts the choice out
  with the caller instead of giving up on the order.

## Scheduled orders

An order is ready no sooner than the kitchen's lead time after the restaurant
opens. At 10:50, with an 11:00 opening and 20 minutes to prepare, the earliest
time is 11:20. Windows that meet (11–15, 15–22) count as one stretch.

## Tests

Focused PostgreSQL regression tests can use a disposable, migrated database:

```bash
TEST_DATABASE_URL=postgresql://brayz:brayz@localhost:55439/brayz \
  npm run test -w @brayz/api -- test/p1-consistency.integration.test.ts
```

Supplying `TEST_DATABASE_URL` makes these regressions fail if that database is
unavailable, rather than silently skipping their checks.
