# Billing (Stripe)

Subscriptions are **per location**: the value Brayz delivers is per phone line,
so a two-site restaurant pays twice and may sit on different tiers.

Brayz never sees a card. Checkout and the Billing Portal are Stripe-hosted, and
the only thing Brayz stores is the customer id, the subscription id, and what
Stripe last told us about them.

## Plans

Prices per the development plan §10. `packages/billing` holds the catalog and
the entitlements; Stripe holds the price of record, so a price changed in
Stripe is never silently contradicted here.

| Plan | Price | Includes |
|---|---|---|
| Starter | $99/mo | calls |
| Growth | $249/mo | + orders, guest memory, loyalty |
| Pro | $499/mo | + promotions, staff voices, POS |

## Setting it up

1. **Create three recurring prices in Stripe** — one per plan — and note the
   `price_...` ids.
2. **Set the API's env:**

   ```bash
   STRIPE_SECRET_KEY=sk_live_...        # or sk_test_... to start
   STRIPE_PRICE_STARTER=price_...
   STRIPE_PRICE_GROWTH=price_...
   STRIPE_PRICE_PRO=price_...
   ```

   With no `STRIPE_SECRET_KEY`, billing is simply off: the Settings screen says
   so and no route pretends a subscription exists.

3. **Add a webhook endpoint** in Stripe pointing at
   `https://<api-host>/v1/webhooks/stripe`, subscribed to:

   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`. **Without it the endpoint
   refuses every delivery** — an unauthenticated endpoint that can mark a
   location as paid is not a safe default.

4. **Enable the Billing Portal** in Stripe (Settings → Billing → Customer
   portal), or the "Manage payment & invoices" button will fail.

## Why the webhook is the source of truth

A subscription is only ever written from a Stripe webhook, never from the
browser's return out of Checkout. A redirect can be lost, replayed, or forged,
and a customer whose card actually failed must not land on an active plan
because their browser followed a success URL.

Deliveries are HMAC-verified with a 5-minute tolerance, so a captured POST
cannot be replayed later, and deduped on Stripe's event id — Stripe retries
until it gets a 2xx, and a replay must not move a subscription backwards.

The location a subscription belongs to travels in Stripe metadata, set at
checkout. A subscription edited directly in the Stripe dashboard may carry no
metadata, so the handler falls back to the row already linked to that
subscription or customer.

## Enforcement

`BILLING_ENFORCED` decides whether plan tiers actually gate features. It is
**off by default**, deliberately: every existing location predates billing, and
denying by default would switch off working restaurants the moment this ships.
Turn it on once real plans exist.

Even with it on, two things keep working:

- **A location with no subscription at all.** Enforcement is about tiers, not
  about locking out anyone who hasn't onboarded.
- **`past_due`.** A failed card must not stop a restaurant's phone being
  answered mid-service. Stripe dunning chases the payment; cancellation is the
  lever that ends service.

Gated today: order taking (Growth) and staff voice cloning (Pro). Both are
enforced in the API where the work happens, not only in the UI that offers it.
Other entitlements are returned by `GET /v1/locations/:id/billing` for the
dashboard, but are not yet refused server-side — add `requireEntitlement` at the
route when you want one to bite.

## Free trial

Every account created since trials shipped starts on **30 days of Pro**
(`TRIAL_DAYS`, `TRIAL_PLAN` in `@brayz/billing`) — no card, nothing in Stripe.
The trial is the account's (`tenants.trialEndsAt`), so every location it opens
in that window is on Pro. `accessFor` in `@brayz/billing` is the single rule
the entitlement gate, the call path and the dashboard all use:

1. A paid plan in a serviceable state wins.
2. Otherwise a running trial gives Pro.
3. Otherwise a **lapsed trial is out of service**: no entitlements, and the AI
   stops answering the account's calls (forwarded to the restaurant, or told
   the call can't be taken). This holds **whatever `BILLING_ENFORCED` says** —
   that flag is about which tier includes what; this is an account that chose
   not to pay.
4. An account from before trials keeps exactly the behaviour described under
   Enforcement above.

**Subscribing mid-trial keeps the days left.** Checkout sets
`subscription_data[trial_end]` to the trial's end, so the Stripe subscription
starts `trialing` and bills when the free trial would have ended. Stripe refuses
a `trial_end` less than 48 hours out, so a trial that is nearly over simply
starts billing that day.

Staff watch and extend trials from `/admin/trials` — see `admin-portal.md`.

## Usage

`GET /v1/locations/:id/billing` reports calls and AI minutes for the current
period. Minutes are metered from answer to hang-up, so an unanswered call costs
nothing, and a call still in progress contributes what it has run so far —
the figure never jumps backwards when the call ends.

Usage is **reported, not yet billed**: nothing is pushed to Stripe as metered
usage. Wiring the over-limit add-on is the next step here.
