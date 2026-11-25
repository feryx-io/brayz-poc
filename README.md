# Brayz

AI-powered guest-engagement platform for restaurants. Brayz answers every inbound
phone call with real-time voice AI, takes pickup and delivery orders, remembers
guests, and runs loyalty and promotions — delivered as a multi-tenant SaaS.

> Core promise: every call gets answered, every guest feels like a regular.

**Status: a working proof of concept, proven on real phone calls.** A caller
dials a Twilio number, talks to the AI receptionist, places an order with the
right line items and totals, and the order lands in the restaurant's dashboard,
on its phone as a text, and (optionally) in Square. Returning callers are
recognized. Everything on the build plan has shipped at least an MVP slice except
the owner mobile app and the background worker — see
[Implemented vs. planned](#implemented-vs-planned).

## Architecture

```mermaid
flowchart LR
  caller([Caller]) -- PSTN --> twilio[Twilio SIP trunk]
  twilio -- SIP/RTP --> siphon["SiphonAI bridge<br/>(external, Compute Engine VM)"]
  siphon -- "WebSocket · PCM16 20 ms frames<br/>siphon-ai.v1 protocol" --> orch

  subgraph brayz [Brayz — this repo]
    orch["Orchestrator<br/>conversation engine + tool loop"]
    api["API (Fastify)<br/>tenant-scoped control plane<br/>+ internal tool API"]
    web["Web (Next.js)<br/>restaurant portal · staff admin · marketing"]
    orch -- "tools: menu, pricing, orders,<br/>guests, loyalty, hours" --> api
    web -- REST --> api
  end

  orch <--> stt[Deepgram STT]
  orch <--> llm[Claude LLM]
  orch <--> tts[Deepgram Aura TTS]

  api --> pg[(Postgres + pgvector<br/>system of record)]
  api --> ext["Twilio SMS · Square POS · Stripe<br/>object storage (recordings)"]
```

The design rules that shape the code (full text in [`CLAUDE.md`](./CLAUDE.md)):

- **Everything is tenant-scoped.** Every table, route, cache key and event carries
  `tenant_id`; queries go through the scope helpers in `packages/db`. The two
  deliberate cross-tenant readers (sign-up duplicate checks and the staff admin
  portal) are each confined to one file and return aggregates only.
- **Vendors sit behind interfaces.** Twilio, Deepgram, Anthropic, Square and Stripe
  are adapters for `CarrierProvider`, `SpeechToTextProvider`, `LlmProvider`,
  `TextToSpeechProvider`, `PosProvider`, `BillingProvider`. Business logic never
  names a vendor.
- **The model never computes prices or invents menu items.** The Orchestrator
  reaches data only through a stable internal tool API; pricing, fees, discounts
  and menu matching happen in the API, and an order is read back and confirmed
  before it is created.
- **Telephony is not ours to build.** [SiphonAI](https://github.com/thevoiceguy/siphon-ai)
  (a separate Rust product) handles SIP/RTP, codecs, VAD and recording, and
  connects to the Orchestrator as a WebSocket client.
- **Privacy is enforced in code.** Saved addresses, order history and loyalty data
  are gated on a per-location guest-memory mode; consent for SMS and voice cloning
  is recorded in append-only ledgers; sensitive reads are audited.

## Implemented vs. planned

### Implemented

| Area | What works today |
| --- | --- |
| **Voice receptionist** | Greet → listen → think → speak loop with an agentic tool loop, barge-in, self-echo suppression, rotating greetings, staff personas and selectable voices. |
| **Order taking** | Pickup and delivery; modifiers with choice limits; half-and-half pizzas; upsell suggestions with deterministic attribution; read-back and confirmation; orders scheduled for later; changing or cancelling an order already placed. |
| **Delivery** | Address checked against a radius or ZIP list via a geocoding provider; fee and minimum applied by the API; unverifiable addresses flagged rather than lost. |
| **Opening hours** | Weekly and holiday hours, after-midnight closes and DST; configurable closed-hours behaviour (take orders or announce closed). |
| **Guest memory** | Callers recognized by phone number; names, saved addresses and order history gated by a per-location mode (full / confirm / off). |
| **Loyalty and promotions** | Points ledger, rewards, VIP tier, birthday and win-back bonuses; amount-off and percent-off promotions aimed at audiences. |
| **Messages and transfer** | Takes a message and texts the restaurant; transfers to configured staff destinations. |
| **Calls** | Call records, transcripts, AI summaries, recordings with signed-URL playback and per-location retention, CSV export. |
| **Restaurant portal** | Dashboard, Calls, Orders, Guests, Menu, Messages, Loyalty, Staff Voices, Insights, Assistant, Settings, Account, Help. |
| **Menu tooling** | Editor with modifier groups, menu import, templates, deterministic menu-health checks, and an assistant that proposes edits the owner applies. |
| **Insights** | Calls answered, orders, revenue, upsell revenue, new vs. returning guests, per-item option breakdowns, CSV exports. |
| **Staff admin portal** | Cross-tenant overview for platform staff: customers, trials, live calls, voice-node health, support queue — aggregates only, audited. |
| **Integrations** | Twilio (SIP trunk, numbers, SMS with consent and delivery status), Square POS, Stripe billing with per-location subscriptions and a 30-day trial. |
| **Auth** | Firebase / Identity Platform ID tokens in deployed environments; header-based dev mode for local work and tests. Role-gated writes. |
| **Infrastructure** | Terraform for a GCP environment: network, Cloud SQL, Cloud Run services, secrets, per-runtime service accounts, the voice node, recording bucket, optional Homer SIP capture; scripts to pause and resume the environment. |

### Planned or partial

| Area | State |
| --- | --- |
| **Owner mobile app** | Not started (Expo + React Native). |
| **Background worker** | `services/worker` is still a skeleton with an idempotent event-handler shape. Work it would own (summaries, notifications) currently runs inline in the API and Orchestrator. |
| **Redis hot state** | Provisioned locally and in config, but no code uses it yet: the in-call order draft lives in the Orchestrator process and Postgres holds everything durable. |
| **Voice cloning** | Consent ledger, lifecycle and selection are built; the clone itself uses a development stand-in. No vendor adapter yet. |
| **Loyalty extras** | Multi-tier rewards and proactive SMS campaigns are deferred. |
| **Deliberately out of scope** | In-call payments, delivery dispatch, a customer-facing app, voice biometrics. |

## How the conversation handles failure

Real calls — speakerphones, noisy rooms, people talking over the bot — drove most
of this. The behaviours below are implemented in
`services/orchestrator/src/conversation.ts` and enforced by tests.

- **Provider failure mid-turn.** If STT, the LLM or TTS fails, the call is
  transferred to the restaurant's first configured destination rather than left
  in dead air; with no destination it ends cleanly.
- **Barge-in is provisional.** When the caller starts speaking, playout pauses and
  the bridge buffer is flushed, but the audio is held: words within 1.2 s commit
  the interruption, silence resumes where the bot left off. A cough does not
  cancel a sentence.
- **Self-echo suppression.** On a speakerphone the bot's own voice comes back and
  is transcribed as the caller. Echo is detected by word order, never overlap
  alone, and short answers ("yes", "no") or a caller picking one of two options
  the bot just offered are never suppressed.
- **Turns run to completion.** Something said mid-turn is queued rather than
  aborting a tool call half-way.
- **Tools refuse instead of guessing.** The order tools reject a pickup-or-delivery
  choice the caller never made, a half-topping on an item that does not allow it,
  more options than a group permits, and an order with a required choice missing.
  An option the caller talked over is named in the read-back so it is still heard.
- **Addresses that cannot be verified** are accepted and flagged for the
  restaurant, so a geocoder outage does not lose an order.
- **Things the bot cannot do** become a message for the restaurant, or a transfer
  when one is configured — it never offers a transfer that has nowhere to go.
- **Closed, or out of service.** A closed restaurant says so and when it opens
  next; an account whose trial lapsed forwards to the restaurant or plays a short
  line and hangs up. Both are still recorded as calls.
- **Summaries never block a call closing.** Summarization is bounded at 10 s and
  every failure path yields no summary rather than an open call record.
- **Side effects are best-effort and idempotent.** Loyalty earns, kitchen texts and
  POS pushes never fail the order, and each carries a dedupe key so a retry
  cannot double-apply.

## Tests

`npm run test` runs every workspace with Vitest. Last full run, against a local
Postgres:

| Workspace | Test files | Tests |
| --- | ---: | ---: |
| `services/api` | 55 | 512 |
| `services/orchestrator` | 37 (+6 skipped) | 215 (+18 skipped) |
| `packages/billing` | 3 | 29 |
| `packages/ai` | 4 | 24 |
| `apps/web` | 2 | 19 |
| `packages/shared` | 3 | 18 |
| `packages/pos` | 1 | 14 |
| `packages/carriers` | 2 | 11 |
| **Total** | **107 passed** | **842 passed** |

The API suite is mostly integration tests against a real database, including
tenant-isolation checks. The six skipped Orchestrator files replay conversations
through the live model and run only when an Anthropic API key is present — prompt
changes are verified there, because a fake LLM can only check a prompt's shape.

There is no CI configuration in the repository yet; the gates are run locally.

## Repository layout

```text
apps/web               Next.js marketing site, restaurant portal (/app), staff admin (/admin)
services/api           Fastify REST API — control plane and internal tool API
services/orchestrator  Real-time conversation engine and WebSocket media server
services/worker        Pub/Sub worker (skeleton)
packages/db            Prisma schema (42 models), migrations, tenant-scope helper, seed
packages/shared        Shared types, Zod schemas, event envelope, menu templates
packages/ai            Provider interfaces + Deepgram STT/TTS and Claude adapters, prompts
packages/carriers      CarrierProvider + Twilio adapter, numbers, SMS
packages/pos           PosProvider + Square adapter and manual-ticket fallback
packages/billing       BillingProvider + Stripe adapter, plans, entitlements
packages/config        Zod-validated env loader (never read process.env elsewhere)
infra/terraform        GCP infrastructure as code (modules + envs/dev)
infra/scripts          Deploy, pause and resume scripts
docs/operations        Runbooks and design notes per feature
```

## Development setup

Requires Node ≥ 20 and Docker. The repo uses **npm workspaces**.

```bash
npm install
cp .env.example .env                       # local defaults work as-is; add API keys for live calls

# Local Postgres (pgvector) + Redis
docker compose up -d

# The Prisma CLI reads .env from its own package directory
echo 'DATABASE_URL=postgresql://brayz:brayz@localhost:5432/brayz?schema=public' > packages/db/.env

npm --workspace @brayz/db run generate
npm --workspace @brayz/db run migrate:deploy
npm --workspace @brayz/db run seed         # demo tenant "Mario's Pizza"

npm run build                              # packages must be built before services typecheck

# Run services
npm --workspace @brayz/api run dev          # http://localhost:4000
npm --workspace @brayz/orchestrator run dev # ws://localhost:4100/v1/media
npm --workspace @brayz/web run dev          # http://localhost:3000
```

Quality gates:

```bash
npm run typecheck
npm run build
npm run test
```

Locally the API runs with `AUTH_MODE=dev` and takes its context from headers:

```bash
curl -XPOST localhost:4000/v1/tenants -H 'content-type: application/json' \
  -H 'x-brayz-user-email: owner@mario.test' -d '{"name":"Mario'\''s Pizza"}'

curl localhost:4000/v1/locations \
  -H 'x-brayz-user-email: owner@mario.test' -H 'x-brayz-tenant-id: <tenantId>'
```

To place a real voice call against a local stack (softphone → SiphonAI →
Orchestrator, no GCP or Twilio needed), follow
[`docs/operations/local-e2e-call.md`](./docs/operations/local-e2e-call.md). It
needs Deepgram and Anthropic API keys.

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — engineering rules and a detailed build log.
- [`brayz_development_plan.md`](./brayz_development_plan.md) — product vision and modules.
- [`brayz_implementation_plan.md`](./brayz_implementation_plan.md) — phased build plan.
- [`brayz_development_plan_gcp_architecture_with_implementation.md`](./brayz_development_plan_gcp_architecture_with_implementation.md) — GCP architecture.
- [`docs/operations/`](./docs/operations) — per-feature notes: delivery orders,
  changing an order, closed hours and scheduling, call recordings, SMS consent,
  billing, insights, the staff admin portal, Firebase auth, SIP capture.
