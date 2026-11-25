# Text alerts: consent and delivery

Brayz texts a restaurant when an order is placed or changed and when a caller leaves a
message. Carriers (and Twilio's A2P 10DLC registration) require that every recipient opted
in, knowingly, and can stop. Rule #6: consent is enforced in code, not policy.

## How a restaurant opts in

1. **Settings → Text alerts.** A manager or owner enters the mobile number and checks an
   **unchecked** box beside the disclosure
   (`restaurantAlertsDisclosure` in `packages/shared/src/smsConsent.ts`, version
   `restaurant-alerts-v1`). The box links to the SMS Terms and the Privacy Policy.
2. The API records a **`granted`** row in `sms_consent_records` (who, IP, user agent, the
   exact words, the version) plus an `audit_logs` `consent.changed` entry. It then texts the
   number: *"Brayz: Reply YES to get order and message alerts for … Reply STOP to opt out,
   HELP for help."*
3. The number replies **YES**. Twilio posts it to `/v1/carriers/twilio/sms-inbound`, which
   records **`confirmed`**. Only now do alerts go.
4. **STOP** (or UNSUBSCRIBE, CANCEL, END, QUIT…) records **`revoked`** at every location of
   that restaurant. **START/YES** by text restores an opt-out that was made by text. Alerts
   turned off in the dashboard stay off until the box is checked again.

`textLocation` (`services/api/src/lib/notifier.ts`) texts only the location's alerts
number, and only when its newest consent record is `confirmed`. Anything else writes a
`notifications` row with status `skipped_no_consent` and sends nothing. The main phone is
no longer a fallback.

The ledger is append-only: nothing is updated or deleted, and it has no cascade from
locations, because it is evidence.

## Delivery reports

Every text asks Twilio for a status callback (`/v1/carriers/twilio/sms-status`, signed).
`notifications.deliveryStatus` / `deliveryErrorCode` record what happened, moving only
forward. `GET /v1/locations/:id/text-health` feeds the dashboard warning when texts are not
arriving (e.g. 30034 = the number is not registered for A2P 10DLC).

## Twilio console setup (once per Messaging Service)

1. **Messaging Service → Integration → Incoming messages:** "Send a webhook", URL
   `https://<api host>/v1/carriers/twilio/sms-inbound`, method POST.
   Without this, YES replies never reach Brayz and alerts never turn on.
2. **Messaging Service → Opt-out management (Advanced Opt-Out):** keep it on, and set the
   replies to exactly `SMS_HELP_REPLY` / `SMS_OPT_OUT_REPLY` / `SMS_OPT_IN_REPLY` in
   `packages/shared/src/smsConsent.ts` (one set serves both kinds of text; `/sms-opt-in` and the
   campaign quote the same constants). Opt-in keywords YES and START; help HELP and INFO.
   - Help: *"Brayz: texts about restaurant orders and messages. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: support@brayz.ai"*
   - Opt-out: *"Brayz: You're unsubscribed and will get no more texts from this number. Reply START to resubscribe."*
   - Opt-in: *"Brayz: You're subscribed to texts about restaurant orders and messages. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help."*
3. Put every location's sending number in the Messaging Service's sender pool.
4. `API_PUBLIC_URL` is optional. Set it only when the API sits behind a custom domain, so
   Twilio's signature is checked against the URL Twilio actually called.

## A2P campaign answers

The first submission (2026-09-15, owner alerts only) was rejected with **30909**: the reviewer
could not verify the message flow. Its description called itself a dev test, the HELP reply
pointed at brayz.ai while that was a parked page, the checkbox linked only the SMS terms, and the
registered HELP/STOP replies did not match `/sms-opt-in`. The resubmission covers both kinds of
text (a sole-proprietor brand gets one campaign) with every page on brayz.ai.

- **Description:** "Brayz is an AI phone assistant that answers calls for restaurants and takes
  orders and messages. It sends two kinds of transactional text: alerts to a restaurant's owner
  or manager when a caller places or changes an order or leaves a message, and, to a caller who
  asks for it on the call, a confirmation and a text when their order is ready. No marketing."
- **Message flow:** both paths as on `https://brayz.ai/sms-opt-in` — the web form (unchecked box,
  the disclosure word for word, links to `https://brayz.ai/terms#sms` and
  `https://brayz.ai/privacy`, then reply YES) and the spoken offer (word for word, only a yes
  opts in, recorded with the call and order, confirmation text, two texts for that order only).
- **Samples:** a new-order alert, a changed-order alert, a caller message alert (it carries the
  caller's number, so *embedded phone = yes*), the guest confirmation and the guest ready text.
- **Keywords:** opt-in YES, START; opt-out STOP (Twilio's full default list); help HELP, INFO.
  Replies: the three constants above.

## Guest order-update texts

Off by default: **Settings → AI & call handling → "Offer callers a text when their order is
ready."** Only turn it on once the texting registration covers messages to customers. A
sole-proprietor campaign described as owner alerts does not.

1. After an order is placed and its confirmation code has been read, **the engine** (not the
   model) says, word for word: *"Would you like a text when your order is ready? {Restaurant}
   will text the number you're calling from about this order, through Brayz. Message and data
   rates may apply, and you can reply STOP anytime."* (`guestOrderTextsOffer`, version
   `guest-order-updates-v2`; v1 did not name Brayz). It is offered once per call, only with a
   textable caller ID — and on every call that places an order, because a yes covers only the
   order it was given for.
2. The model reports the answer through `order_text_updates`. That tool does not exist until
   the offer has been spoken and the caller has answered it.
3. A yes calls `POST /v1/calls/:id/tools/order-texts/consent`. It records a **`confirmed`**
   row (source `voice_call`, the call and order IDs, the disclosure regenerated server-side,
   and the caller's words), audits it, and texts a confirmation: *"{Restaurant} via Brayz:
   You'll get a text when order #CODE is ready. Msg & data rates may apply. Reply STOP to opt out, HELP for
   help."*
4. When the order is marked **Ready**, the guest gets *"{Restaurant} via Brayz: Your order
   #CODE is ready for pickup"* (or "heading out for delivery"). It goes only when that phone
   said yes **for this order** (`agreedForOrder`) and has not sent STOP since, and it is keyed
   on the order so it is sent once. A later order from the same caller is not texted unless
   they say yes again on that call — the offer said "about this order".
5. **STOP** by text ends every kind of text that restaurant sends that number, guest
   updates included.

Guest texts are notifications with `audience = guest`. They do not count towards the
restaurant's text-health warning.

Live replay (Saratoga's real menu, 3 runs each): "Yeah, sure" and "Yes please, text me" were
recorded as a yes, "No thanks" and "Nah, I'm good" as a no, in 12 of 12 runs, with exactly
one offer per call. Telling the model not to sign off before the offer took "thanks for
calling… would you like a text?" from 12/12 runs to 0/12.

## Not yet built
- **Production ISV registration:** a sole-proprietor brand fits one small sender. Brayz
  texting for many restaurants needs a Standard brand, likely one per restaurant.
