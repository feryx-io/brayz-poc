# CLAUDE.md

Guidance for working in the **Brayz** codebase. Read this before making changes.

Brayz is an AI-powered guest-engagement platform for restaurants. It answers every
inbound phone call with real-time voice AI, takes pickup and delivery orders, remembers guests,
and supports loyalty rewards — delivered to restaurants as a multi-tenant SaaS.

> Core promise: every call gets answered, every guest feels like a regular.

The authoritative design and phase plan live at the **repo root** — read these before
non-trivial changes (they lay out modules, screens, schema/API/UI checklists, and build order):

- `brayz_development_plan.md` — product vision, product modules, the **Restaurant Admin
  Portal** screens (Dashboard, Calls, Orders, Guests, Menu, Loyalty, Staff Voices,
  Settings), marketing site, pricing, phased roadmap.
- `brayz_implementation_plan.md` — phased build steps, the web page list
  (`/`, `/login`, `/app/{dashboard,calls,orders,guests,menu,settings}`), DB schema /
  API endpoint / Pub/Sub checklists, and the build order.
- `brayz_development_plan_gcp_architecture_with_implementation.md` — the full GCP
  architecture writeup.

When this file and those plans disagree, the plans win — and update this file.

---

## Non-negotiable rules

These are the rules most likely to be violated by a quick change. Hold them firmly.

1. **Everything is tenant-scoped.** Every table, API route, background job, cache key,
   Pub/Sub event, and query must carry `tenant_id` and usually `location_id`. There is
   no global guest, order, menu, or call. Guest memory is **never** shared across
   tenants by default. Use the tenant-scope helpers in `packages/db` rather than raw
   queries; never write a query that could read across tenants. There are exactly
   **two** deliberate exceptions, both confined to one file and both earning it the
   same way:
   - `services/api/src/lib/duplicates.ts` (sign-up duplicate checks) reads other
     tenants' location name/address/phone to answer "is this restaurant already on
     Brayz?", returns findings only, and never surfaces another tenant's data.
   - `services/api/src/routes/admin.ts` (the Brayz staff admin portal) reads every
     tenant because that is the point. It is gated by `requirePlatformStaff` — a role
     in `users.platformRole` that no customer can grant themselves — returns
     aggregates and the support requests customers deliberately sent us (never a
     transcript, recording, guest, or order), and audits every read of an identifiable
     customer to `platform_audit_logs`. Being staff is **not** a master key: no
     tenant-scoped route consults a platform role.

   Do not add a third without the same discipline.

2. **Providers are abstracted — never hard-code a vendor in business logic.** Twilio,
   Deepgram, OpenAI, ElevenLabs, Stripe, Square, Toast are *implementations* behind
   interfaces, not the platform model. Core code talks to `CarrierProvider`,
   `SpeechToTextProvider`, `LlmProvider`, `TextToSpeechProvider`, `VoiceCloneProvider`,
   `EmbeddingProvider`, payment/POS/notification interfaces. New vendor → new adapter,
   no changes to call/order/guest logic. Carrier events are normalized before they
   reach the rest of the system (`NormalizedCarrierCallEvent`).

3. **Postgres (Cloud SQL) is the system of record. Redis is ephemeral only.** Durable
   business state — tenants, locations, users, menus, guests, calls, transcripts,
   orders, promotions, billing, consent, audit — lives in Postgres. Redis/Memorystore
   holds only hot/temporary state: active-call state, locks, idempotency keys, menu
   cache, rate limits, node heartbeats, live order drafts. Never put guest memory,
   final call records, billing, consent, or audit logs in Redis.

4. **SiphonAI is the SIP↔WebSocket bridge — an external product; Brayz is the WS server.**
   SiphonAI (its own repo: github.com/thevoiceguy/siphon-ai) does all telephony — SIP/RTP,
   codecs, media negotiation, 20 ms PCM framing, VAD/barge-in, DTMF, hold, transfer,
   recording. It connects **as a WebSocket client** to the Brayz **Orchestrator** (the WS
   server) and speaks SiphonAI's published **v1 protocol** (`docs/PROTOCOL.md` in that repo;
   subprotocol `siphon-ai.v1`). We do **not** build or fork a SIP stack, and there is no
   Brayz "gateway" binary. The Orchestrator's media layer
   (`services/orchestrator/src/{mediaServer,protocol,conversation}.ts`) must mirror that
   protocol exactly (every server→bridge message echoes `call_id`; barge-in is
   `speech_started`→`clear`; `stop`/`error` end the call). Keep **all** business logic —
   restaurant config, guest memory, orders, loyalty, billing, menu, AI prompts, history —
   in the Orchestrator/API, never in the media-protocol layer.

5. **The Orchestrator reaches data through the internal tool API, not raw tables.**
   AI tools call stable internal endpoints (`lookup_guest`, `lookup_menu_item`,
   `price_order`, `create_order`, `apply_promotion`, `transfer_call`,
   `save_guest_memory`, `take_message`, …). This keeps business rules out of the prompt and the AI
   layer testable. Never let the LLM compute prices or invent menu items — pricing and
   menu come from tool results, and an order is read back and confirmed before it is
   created.

6. **Privacy and consent are enforced in code, not just policy.**
   - Phone-number match is the MVP identity signal; voice recognition is later and
     opt-in.
   - **Never reveal address, order history, or loyalty data based on a voice match
     alone.** Confirm identity first.
   - Guest memory must be opt-out, editable, and deletable from the dashboard.
   - Voiceprints and staff voice cloning require explicit, recorded consent.
   - Record call-recording disclosures where required; write audit-log entries for
     guest-profile access, recording playback, consent changes, menu price changes,
     and routing changes.

7. **Workers are idempotent.** Pub/Sub redelivers. Enforce uniqueness on external
   event IDs / job IDs and check idempotency keys before processing.

---

## Repository layout (npm-workspaces monorepo)

> **Toolchain note:** the plan calls for pnpm/Turborepo. The repo currently uses
> **npm workspaces** (no turbo) because the dev box drives a Windows `fnm` Node
> from a WSL shell where the pnpm/turbo shims break on path translation; npm works
> in both. The layout is identical, so pnpm/turbo can be reintroduced later
> without moving files. Use `npm` commands (see "Common commands").


```text
brayz/
  apps/
    web/                  # Next.js marketing site + restaurant admin portal
    mobile/               # Expo React Native owner app (later phase)
  services/
    api/                  # Fastify REST API — SaaS control plane
    orchestrator/         # Real-time Conversation Orchestrator (WebSocket media + AI)
    worker/               # Pub/Sub workers, background jobs
    notification-service/ # SMS/email/push abstraction (may start inside worker)
  packages/
    db/                   # Prisma schema, migrations, seeds, tenantScope helpers
    shared/               # Shared TS types + Zod schemas
    ai/                   # Provider interfaces, prompt + tool definitions
    carriers/             # Twilio adapter + future carrier adapters
    pos/                  # PosProvider interface + Square/manual adapters
    billing/              # BillingProvider interface + Stripe adapter, plans, entitlements
    ui/                   # Shared web UI components
    config/               # Zod-validated env/config loader
  infra/
    terraform/            # GCP IaC (envs/{dev,staging,prod}, modules/*)
    scripts/              # Deploy/bootstrap scripts
  docs/                   # architecture/, implementation/, operations/
```

Boundary reminders: the **web app never touches the database directly** — it calls
`services/api`. The Orchestrator persists via the API/tool layer, not direct table
writes (with the narrow exceptions noted in the plan). **SiphonAI is not in this repo** —
it's the external SIP↔WS bridge (rule #4); Brayz integrates with it as the WS server.

---

## Tech stack

- **Language:** TypeScript across web/api/orchestrator/worker. (SiphonAI, the SIP↔WS
  bridge, is a separate Rust product we integrate with — not code in this repo.)
- **Backend:** Fastify, Zod (validation), Prisma (schema + migrations), Pino
  (structured JSON logs), Vitest (tests). NestJS is an acceptable alternative for the
  API if more structure is wanted — pick one, don't mix mid-MVP.
- **Web:** Next.js, Tailwind CSS, shadcn/ui, TanStack Query. Auth via Firebase
  Auth / Google Identity Platform (cleaner GCP fit) or Clerk — pick one early.
- **Mobile:** Expo + React Native, Expo Router, native push.
- **Data:** Cloud SQL PostgreSQL (system of record, `pgvector` enabled),
  Memorystore Redis/Valkey (ephemeral), Pub/Sub (events), Cloud Storage (recordings,
  voice assets, exports).
- **AI/voice providers (behind interfaces):** STT/LLM/TTS via Deepgram, Anthropic
  (Claude — current default LLM), OpenAI, ElevenLabs, etc.; voice cloning via a licensed
  provider. Concrete adapters live in `packages/ai` (`AnthropicLlmProvider`,
  `DeepgramSttProvider`, `DeepgramTtsProvider`).
- **Billing:** Stripe.

---

## Infrastructure (GCP-first)

- **Primary region:** `us-east4` (East Coast / Northeast restaurant base). Single
  region with HA for the MVP — no multi-region active-active yet.
- **API + Orchestrator + workers:** Cloud Run. (Move the Orchestrator to Compute
  Engine/GKE only if WebSocket session limits, jitter, or cost at scale force it.)
- **SiphonAI (external bridge):** runs as its own service on a Compute Engine VM
  (native binary under systemd — *not* Docker — for predictable UDP SIP/RTP, static IP,
  fixed RTP port range 20000–30000, `sngrep`/`tcpdump`). Brayz Terraform provisions the
  VM + static IP + SIP/RTP firewall (`infra/terraform/modules/siphon-node`); SiphonAI
  itself is installed and operated from its own repo, and bridges call media to the
  Orchestrator over WebSocket.
- **PSTN:** Twilio Elastic SIP Trunking for the MVP, behind the carrier abstraction.
  Start with direct-to-node static IPs + multiple Twilio origination URIs; revisit an
  external passthrough Network Load Balancer only after traffic and SIP/RTP metrics
  are stable.
- **Call troubleshooting (optional):** SiphonAI ships **HEP3** to a private
  **Homer** collector (`infra/terraform/modules/homer-node`, behind
  `homer_enabled`, default off) — SIP, RTCP, RTP QoS, lifecycle logs, CDR and
  STIR/SHAKEN verdict on one timeline per `Call-ID`. It is the *network* view and
  deliberately not part of the admin portal, which stays the tenant-scoped,
  audited business view. Homer holds guest phone numbers with no tenant
  separation, so: no public IP, IAP only, short retention.
  `docs/operations/homer-hep.md`.
- **Secrets:** Secret Manager only — never commit secrets or bake them into images
  or VM disks. Naming: `prod/<vendor>/<key>` (e.g. `prod/twilio/auth-token`).
- **IaC:** Terraform, with hard-isolated projects `brayz-dev`, `brayz-staging`,
  `brayz-prod`. One service account per runtime (`brayz-api-sa`,
  `brayz-orchestrator-sa`, `brayz-worker-sa`, `brayz-siphon-gateway-sa`, …),
  least privilege.
- **Observability:** Cloud Logging/Monitoring/Trace/Error Reporting. Every log line
  must include `call_id`, `tenant_id`, `location_id`, `node_id`, `provider`,
  `provider_call_id`, `session_id`, `trace_id` where applicable.

Domains: `brayz.ai` (marketing), `app.brayz.ai` (portal), `api.brayz.ai`,
`sip-us-east4.brayz.ai` / `sip-gw-N.brayz.ai` (voice ingress).
Live today: `brayz.ai`, `www.brayz.ai` and `dev.brayz.ai` all serve the **dev** web service
(Cloud Run domain mappings, `web_domains` in `envs/dev`; since 2026-09-15). DNS stays at the
registrar (GoDaddy), never in a project `down.sh` can pause, because email rides the same zone;
`terraform output web_domain_dns_records` lists the records. A new host also has to be added
to Firebase Auth's authorized domains or sign-in fails there. The SMS campaign cites
`brayz.ai/{privacy,terms,sms-opt-in}`.

---

## Common commands

Confirm against `package.json` / `turbo.json` before relying on these — adjust this
section as scripts are added.

```bash
# Install (monorepo root)
npm install

# Run a service in dev (tsx watch)
npm --workspace @brayz/api run dev
npm --workspace @brayz/web run dev
npm --workspace @brayz/orchestrator run dev

# Quality gates (must pass before commit/PR) — run across all workspaces
npm run typecheck
npm run build
npm run test
npm run lint

# Database (packages/db)
npm --workspace @brayz/db run generate            # prisma generate
npm --workspace @brayz/db run migrate -- --name <change>   # prisma migrate dev
npm --workspace @brayz/db run studio
npm --workspace @brayz/db run seed

# Infra — Terraform foundation (applied to brayz-dev)
terraform -chdir=infra/terraform/envs/dev plan
terraform -chdir=infra/terraform/envs/dev apply
```

Required local env vars (validated by `packages/config` with Zod — add new vars there,
never read `process.env` directly elsewhere):

```text
NODE_ENV  DATABASE_URL  REDIS_URL  GCP_PROJECT_ID
PUBSUB_TOPIC_CALL_EVENTS
TWILIO_ACCOUNT_SID  TWILIO_AUTH_TOKEN
OPENAI_API_KEY  DEEPGRAM_API_KEY  ANTHROPIC_API_KEY  (ANTHROPIC_MODEL  ANTHROPIC_THINKING)
BRAYZ_NODE_SHARED_SECRET  (BRAYZ_TRANSFER_SIP_URI)
(PLATFORM_ADMIN_EMAILS — comma-separated; bootstraps the first Brayz staff admin)
```

---

## Domain glossary

- **Tenant** — a restaurant business/group (billing + isolation boundary).
- **Location** — a physical restaurant; most config and data are location-scoped.
- **Guest** — a customer, scoped to tenant/location; identified by phone number first.
- **Call** — one phone interaction; has legs, events, transcript, optional recording.
- **Order / order draft** — draft is the live in-call working order (Redis); the
  confirmed `order` is persisted in Postgres after readback.
- **Carrier** — a PSTN/SIP provider (Twilio first) behind `CarrierProvider`.
- **Voice gateway node** — a Compute Engine VM running the external SiphonAI bridge.
- **Orchestrator** — the real-time AI brain that runs the conversation + tools; also the
  WebSocket server SiphonAI bridges call audio to (speaks SiphonAI's v1 protocol).
- **Staff persona** — an approved voice/personality profile (consent-gated).

---

## Event conventions

Pub/Sub decouples real-time call handling from slower downstream work. Use the common
envelope for all events:

```json
{
  "event_id": "uuid",
  "event_type": "order.confirmed",
  "occurred_at": "2026-06-09T16:00:00Z",
  "tenant_id": "uuid",
  "location_id": "uuid",
  "call_id": "uuid",
  "source": "conversation-orchestrator",
  "schema_version": "1.0",
  "data": {}
}
```

Common types include `call.started/answered/ended/failed`,
`call.transcript.segment.created`, `call.summary.requested/completed`,
`order.draft.created`, `order.confirmed`, `order.sent_to_restaurant`,
`notification.requested/sent/failed`, `guest.memory.updated`, `carrier.event.received`.

---

## Where we are in the build

Build the smallest useful vertical slice first, then expand:

```text
Twilio number → SiphonAI bridge (Compute Engine VM) → Orchestrator (WS server) → AI receptionist
             → Postgres call record → dashboard call history → human transfer
```

**That slice now works on real calls** (#18) — orders placed by voice, a returning
caller recognized. Phases 0–8 are merged and green (typecheck + build clean, 261
tests); everything on the plan except the owner mobile app has shipped at least an
MVP slice.

Phase order (see `brayz_implementation_plan.md`):
0. Project bootstrap — monorepo, config, Terraform foundation, DB schema, API + web
   skeletons. **Status: largely done.** Monorepo (npm workspaces), `@brayz/config`
   (Zod env), `@brayz/shared` (types/schemas/event envelope), `@brayz/db` (full
   Prisma schema + `forTenant` scope helper + seed), `@brayz/ai` and `@brayz/carriers`
   (provider interfaces + Twilio adapter), `services/api` (Fastify: health, `/v1/me`,
   tenant/location/menu CRUD, tenant scoping; 4 passing smoke tests), `services/orchestrator`
   (WS media skeleton), `services/worker` (idempotent event-handler skeleton), and
   `apps/web` (Next.js marketing + admin shell, builds clean). Local **Postgres
   (pgvector) + Redis run via `docker compose`**; the `init` migration is applied and
   the demo tenant is seeded; 7 API tests pass incl. live-DB tenant-isolation checks.
   The **Terraform dev foundation** now exists in `infra/terraform/` (bootstrap state
   bucket; `modules/` for project-services, network [VPC/NAT/SIP+RTP+IAP firewall],
   service-accounts [per-runtime SAs], secrets [Secret Manager containers], siphon-node
   [Compute Engine VM + static IP]; wired in `envs/dev`). **Not yet applied** — `terraform
   apply` needs the operator's GCP creds + billing + a created `brayz-dev` project, and the
   Twilio SIP/RTP source ranges in `terraform.tfvars` must be verified against Twilio's
   published list. Cloud SQL/Redis/Pub/Sub/Cloud Run/DNS modules are deliberately deferred
   (their APIs are enabled). **Phase 0 is complete pending the first `apply`.**

   > **Prisma env note:** the Prisma CLI reads `.env` from `packages/db/`, not the repo
   > root, so `DATABASE_URL` must also be set in `packages/db/.env` (gitignored).
   > WSL→Windows `node.exe` does not forward shell env vars across the process boundary,
   > so prefer a `.env` file over `export`.
1. Core admin platform — auth, tenant/location, profile/hours, menu editor, dashboard
   shell. **Status: in progress (vertical slice landed).** Real auth behind an
   `AuthVerifier` abstraction: `AUTH_MODE=dev` (header-based, local/tests) or
   `firebase` (verifies Identity Platform ID tokens via firebase-admin, provisions
   the user, accepts a tenant only if the caller is a member). API adds holiday-hours,
   AI-settings, and phone-number endpoints. Web has Firebase/dev login, protected
   `/app` with tenant switcher + onboarding, and TanStack-Query screens: dashboard
   (live counts), menu editor (CRUD), settings (profile/hours/phones). 16 API tests
   pass incl. an end-to-end owner onboarding flow (now also covering modifier groups +
   holiday hours) and firebase-mode rejection. Settings now has profile, weekly hours,
   **holiday hours**, **AI/call-handling settings**, and phone numbers; the menu editor
   supports **modifier groups + options**; write controls are **role-gated** (staff =
   view-only) via `canManage`. **The deployed `brayz-dev` runs firebase mode on both API and web (since 2026-09-08)**;
   header auth is local/tests only. Setup and the first-sign-in caveat:
   `docs/operations/auth-firebase-setup.md`. **Phase 1 core is complete** — optional
   polish remaining: holiday open/close time inputs, item editing (rename/price/avail),
   and per-location member management.
2. SiphonAI integration (Brayz is the WS server) — VM hosting, Twilio trunk, call
   lifecycle events, WS media session. **Status: Brayz-side done. SiphonAI is an external
   product — no gateway for us to build.** API: node lifecycle (`/v1/voice-nodes/register|heartbeat|drain|undrain`,
   node-secret auth), call lifecycle (`POST /v1/calls` resolves tenant/location by called
   number, `/v1/calls/:id/events` advances status, `PATCH /v1/calls/:id`), dashboard
   reads (`/v1/locations/:id/calls`, `/v1/calls/:id`, transcript), and a normalized
   Twilio status webhook (`/v1/carriers/twilio/status`). Orchestrator persists call
   records **through the API** (rule #5) via an injectable `CallPersistence`; media server
   refactored to `createMediaServer` with a per-session serial message queue (barge-in
   never races `start`). Web: live Calls table + dashboard call metrics. The Orchestrator's
   media WS server (`mediaServer.ts`/`protocol.ts`) implements **SiphonAI's published v1
   protocol** (`start`/`speech_started`→barge-in/`stop`; every server message echoes
   `call_id`; binary PCM16LE 20 ms). The Terraform `siphon-node` VM hosts the external
   SiphonAI daemon; the earlier in-repo `voice/` skeleton has been removed.
3. Orchestrator MVP — STT/LLM/TTS adapters, conversation state machine, barge-in,
   transcripts, first tools. **Status: vertical slice done.** `@brayz/ai` has
   Deepgram STT + Claude LLM + Deepgram Aura TTS adapters; `ConversationEngine`
   (`services/orchestrator/src/conversation.ts`) drives greet→listen→think→speak→barge-in
   with an agentic tool loop; node-authed internal tool API (`/v1/calls/:id/tools/*` —
   profile, hours, menu search, notes). **Proven on real calls** (#18): pickup orders
   placed by voice with correct line items and totals, and a returning caller
   recognized. Calling from a speakerphone in a noisy room exposed what the
   fake-bridge harness cannot — it sends no audio, so it triggers no VAD. Hence
   self-echo suppression (our own voice comes back through the handset and STT
   transcribes it as the caller; anchored on word *order*, never on overlap alone,
   and answers like "yes"/"no" are never suppressed), turns that run to completion
   with a mid-turn utterance queued rather than aborting, and **provisional**
   barge-in (playout pauses and the bridge buffer flushes, but the audio is held —
   words within 1.2 s commit the interruption, silence resumes playout). To run it
   live: put the Orchestrator where SiphonAI can reach it with live Deepgram +
   Anthropic keys and point `[bridge].ws_url` at `/v1/media`
   (`docs/operations/local-e2e-call.md`).
4. Order taking → 5. Guest memory: **done** (see the PR histories).
6. Loyalty — **MVP slice done.** Per-location program config (`LocationLoyaltySettings`:
   enabled + pointsPerDollar + rewardPoints→rewardCents), `LoyaltyAccount` (one per
   guest, balances denormalized) + `LoyaltyEvent` ledger (dedupe-keyed earn/redeem,
   rule #7). Earn happens on confirmed orders in the order route (best-effort, never
   fails the order); redemption is validated server-side and commits atomically with
   the order (balance-guarded against concurrent double-spend). The bot gets
   `check_loyalty` + a `redeem_reward` flag on `place_order`; the voice status
   endpoint is gated exactly like guest memory (rule #6 — 403 unless recognized +
   memory on). Dashboard: Settings → "Loyalty rewards" config card; Guests → account
   summary + `/v1/guests/:id/loyalty` ledger. **Rules layer done too:** VIP (computed
   from lifetime spend, never stored; earn multiplier; surfaced to the greeting via
   `/tools/guest` and a dashboard badge), birthday bonus (month/day only stored on
   the guest, saved by dashboard or `save_guest_memory`; awarded once per calendar
   year on the first order in the birthday month, dedupe-keyed), win-back bonus
   (first order after `winbackDays` inactive), and `/v1/locations/:id/loyalty-stats`
   analytics (members, VIPs, outstanding points, 30-day earn/redeem/bonus activity)
   shown on the Dashboard. Bonuses are separate idempotent transactions so a lost
   race never rolls back the base earn. **Still deferred:** multi-tier rewards,
   proactive campaign sends (SMS blasts), favorite-item discounts.
7. Staff voices — **MVP slice done.** `StaffProfile` + `StaffVoiceProfile` +
   append-only `VoiceConsentRecord` ledger (timestamp, source, who recorded it).
   Consent is enforced in code (rule #6): cloning 422s without a current grant;
   revocation retires every voice immediately and the call-time resolver re-checks
   status, so a revoked voice can never answer; consent changes + voice lifecycle
   are audited. Cloning goes through `VoiceCloneProvider` (rule #2) — currently the
   `DevVoiceCloneProvider` stand-in; a real vendor adapter (e.g. ElevenLabs) slots
   in behind the same interface. Voice selection per location via
   `LocationAiSettings.voiceMode`: default persona | one fixed staff voice |
   rotation of rotation-enabled voices, `voiceRotation` daily or `per_call`
   (round robin stepped by the location's call count; `/v1/calls/:id/tools/voice`,
   node-authed). **Persona hand-off** (2026-09-08): with
   `LocationAiSettings.personaSwitchEnabled` (off by default) a caller may ask
   for a staff persona by name — `/tools/personas` lists the names the model is
   told, the `switch_persona` tool posts `/tools/persona` (re-checks the voice
   is ready; `call.persona_switched` event), and the engine's `becomePersona`
   swaps the voice and the "You are <name>" prompt for the rest of the call. A
   transfer option for that person wins. The prompt always says it is the
   restaurant's AI when asked if it is a real person.
   The engine greets with the staff persona's name and passes `voiceId` to TTS.
   Web: "Staff Voices" screen (staff CRUD, consent record/revoke with source,
   voice creation, rotation toggles, location voice-mode picker). **Staff
   personas with catalog voices** (2026-09-07): `StaffVoiceProfile.source` is
   `clone` (a real person's voice, consent-gated, retired on revocation) or
   `provider` (a catalog voice given to the persona — no consent, survives a
   revocation). `POST /v1/locations/:id/staff` takes `providerVoiceId`;
   `POST /v1/staff/:id/voice/provider` assigns one later; both validate against
   the cached catalog (`lib/tts.ts` `voiceCatalog`). A restaurant can mix, say,
   two catalog personas and three cloned staff. **Default AI
   voice** (2026-09-07): `LocationAiSettings.defaultVoiceId` + `assistantName`
   — the provider voice that answers when no staff voice does, and the name it
   goes by. The catalog comes from `TextToSpeechProvider.listVoices()`
   (`GET /v1/voices`, Deepgram's live models list, aura-2 + English, cached an
   hour) and `POST /v1/locations/:id/voices/preview` speaks a line as WAV
   (manager+; the API holds the Deepgram key for this). `{staff_name}` in the
   owner's greeting is filled with whoever answers (`fillStaffName` in
   `@brayz/shared`), and the system prompt says "You are Sam". **Greeting
   rotation** (2026-09-07): `Location.aiGreetings[]` + `welcomeBackLines[]`
   (the single `aiGreeting` migrated into the list). `/tools/profile` picks
   one of each per call (`pickLine`: a recognized caller cycles by prior call
   count at the location, a stranger gets a random one) and returns
   `greeting` + `welcomeBack` templates; the engine fills `{staff_name}` and
   `{guest_name}` (the guest name only after the rule #6 gate). Settings has
   list editors for both with a "regular's first call back hears" preview. **Deferred:**
   real clone-vendor adapter, sample-audio upload/storage (Cloud Storage),
   shift-based voice schedules, guest-affinity voice routing.
8. Phase 8 — **the remaining plan items except the mobile app are done.**
   - **POS integrations** (#20): `@brayz/pos` with a `PosProvider`
     (`createOrder`/`updateOrderStatus`/`getMenu`/`syncMenu`) plus per-adapter
     `capabilities`, so callers ask before offering an action instead of finding out
     at the vendor. `SquarePosProvider` (Orders + Catalog, cents on both sides — no
     float in money) and a manual adapter. Typed `PosPermanentError` /
     `PosTransientError` so a retry can tell "Square is down" from "our request is
     wrong"; `isRetryable` defaults to retrying, since a misclassification should
     cost an attempt, not a ticket.
   - **Call summaries + recording lifecycle** (#22, restored by #23): the Orchestrator
     summarizes the real turns as the media session tears down and PATCHes the result
     onto the call — receptionist system prompt omitted so the model summarizes
     instead of replying, a call where the caller never spoke is not summarized at
     all, bounded at 10 s, and every failure path returns null (a missing summary
     beats a call record that will not close). Recordings live in object storage behind
     `lib/recordingStorage.ts` (`S3RecordingStorage`, signed URLs — the bytes are
     never proxied through the API); the Calls screen plays them back, and playback
     is audited (rule #6). In GCP the bucket, per-side HMAC keys and the node's
     `[recording]` config are Terraform (`modules/recording-bucket`,
     `recording_enabled`) — see `docs/operations/call-recordings.md`. **Proven on a
     real call 2026-09-04** and merged (#73). **Per-location retention** followed:
     `LocationAiSettings.recordingRetentionDays` (null = the bucket lifecycle
     ceiling, `recording_retention_days`; the API refuses anything longer), enforced
     by an hourly Cloud Scheduler → `POST /v1/internal/recordings/sweep` (OIDC from a
     roleless `scheduler` SA, or the node secret by hand) that deletes the object
     with a delete-only custom role, marks the call `deleted`, and audits
     `recording.deleted`. Idempotent: object first, row second, 404 counts as done.
   - **Promotions** (#24): amount-off / percent-off aimed at an audience — everyone,
     VIP, lapsed, or birthday-month guests — where the audiences **reuse the loyalty
     rules' own definitions**, so a restaurant defines VIP once. Optional spoken code,
     minimum spend, end date, per-guest limit. Web: a real Loyalty screen to run them
     from (loyalty had been an engine with no cockpit).
   - **Upsell, kitchen tickets, recording playback** (#25): `MenuItem.upsellTags` had
     sat unread since Phase 1 — a tag now says what an item pairs *with*, matched
     against the item names and categories already in the draft. The API does the
     matching and pricing (rule #5): `suggest_upsell` returns real items at real
     prices, cheapest first; untagged, already-ordered, and unavailable items are
     never offered. **Attribution is deterministic, not self-reported** — the engine
     records the ids it actually offered and marks a later `add_item` against them
     (`viaUpsell`).
   - **Stripe billing** (#26): `@brayz/billing` — a `BillingProvider` with
     checkout/portal/read-back and `StripeBillingProvider` behind it, plans and
     entitlements from pricing §10. Subscriptions are **per location**, because the
     value is per phone line. Checkout and the portal are Stripe-hosted, so **Brayz
     never sees a card and renders no payment form**. The adapter uses Stripe's REST
     API with an injected fetch rather than the SDK, so it is testable without a
     network.
   - **Cheap GCP pause/rebuild** (#27): the environment is meant to be destroyed
     between test sessions, so `cloudsql_deletion_protection` is `false` in
     `envs/dev` (it blocked `terraform destroy`) and the Cloud SQL instance name is
     no longer fixed (a deleted name is locked for ~a week and would have blocked a
     rebuild for days).
   - **Half-and-half pizzas** (2026-09-04): a caller's "half pepperoni, half sausage"
     had been flattened to a whole pie with both. Options now carry a **portion**
     (whole | left | right) from `add_item`/`update_item` (`left_half`/`right_half`)
     through the draft, `OrderItemModifier.portion`, the POS line name
     ("Pepperoni (left half)") and the dashboard. Whether a group allows it and what
     a half costs are **menu settings** on the modifier group (`allowsHalves`,
     `halfPricing` full|half; `defaultAllowsHalves` in `@brayz/shared` turns it on for
     pizza topping groups, never calzones). The tools refuse halves elsewhere rather
     than adding a whole the caller did not ask for.
   - **Calls list at scale** (2026-09-04): the list had been "the newest 100". Now
     `GET /v1/locations/:id/calls` takes `from`/`to`/`limit`/`cursor` (keyset on
     startedAt+id) and returns `{ calls, nextCursor }`; `/calls/days?tz=` counts each
     day **in the location's timezone** (raw SQL, tenant + location in the WHERE);
     `/calls/export.csv` streams a range as CSV (manager+, audited as
     `calls.exported`, no transcripts). The Calls screen shows presets (today /
     yesterday / 7d / 30d / month / custom) over collapsible day rows with today open,
     paging inside a day. Day math lives in `apps/web/lib/time.ts`. **Call-history
     retention was deliberately left out**: deleting call rows would also delete the
     data loyalty and the dashboard are computed from.
   - **Menu health** (2026-09-04, first slice of the per-account assistant idea):
     `GET /v1/locations/:id/menu-health?days=` runs deterministic checks
     (`services/api/src/lib/menuHealth.ts`, pure over a snapshot) over the menu plus
     the period's menu gaps and order free text, and returns findings with the
     **fix expressed as an ordinary menu edit** (`create_group` / `add_modifier` /
     `allow_halves`). The Menu screen's "Menu health" card applies a fix through the
     existing menu routes, so it is role-gated and audited like a hand edit;
     dismissals are per browser. No model in the loop yet — that layer comes next.
   - **Assistant chat** (2026-09-05, the model layer on menu health):
     `POST /v1/locations/:id/assistant/chat` (manager+, audited as `assistant.chat`)
     runs a bounded tool loop (`services/api/src/lib/assistant.ts`) over read-only
     tools — menu health, the menu, menu gaps, recent calls, one call's transcript
     and ticket — plus `propose_edit`, which **records a proposal and changes
     nothing**. Proposals are `MenuHealthFix` shapes (validated by
     `MenuHealthFixInput`, ids checked against this location's menu); the
     `/app/assistant` page applies one through the ordinary menu routes via
     `apps/web/lib/menuFix.ts`, shared with the Menu health card. Stateless: the
     browser holds the thread. Same `AnthropicLlmProvider` as the receptionist.
   - **Menu templates** (2026-09-05): `packages/shared/src/menuTemplates.ts` holds
     templates as data — sections, starter items, and an **option-group library
     with keyword rules** (`templateGroupsFor`) saying which items get which groups
     (size-priced pizza toppings with halves on, calzone fillings with halves off,
     wing sauce + dip, sub size + extras, salad dressing, bread/cheese on a deli
     sandwich). The rules are the point: every live-call menu defect had been a
     missing group, not a missing section. `GET /v1/menu-templates` lists them;
     `POST /v1/locations/:id/menu/template` (manager+, audited
     `menu.template.applied`) lays one on — sections matched by name, starter
     items skipped where the name exists, **starter items created unpriced and
     hidden** so the bot never quotes a template's guess (menu health notes them
     as `starter_items_unpriced` until priced and enabled), and groups attached to
     every item lacking one of that name (an owner's own group is never touched).
     The importer takes `templateId` and attaches groups to the items it creates;
     its preview returns `suggestedTemplateId` (`suggestMenuTemplate`, by rule
     hits). Web: "Start from a template" on an empty menu, "Add option groups" on a
     menu with items, and a template select in the import review step.
   - **Assistant build mode** (2026-09-06): the same proposals-then-apply loop
     pointed at what the menu lacks. `get_menu_template` shows the model what a
     typical restaurant of this kind sells (the template that fits this menu by
     `suggestMenuTemplate`, or the list), which of its sections are already on
     the menu, and the option-group library with typical prices. Two new fix
     kinds, `create_category` (name) and `create_item` (section by name, created
     on apply if missing; description; `priceCents` only when the owner stated
     it; groups). **The groups on a proposed item come from the template's
     rules in code** (`templateGroupsFor` + `defaultAllowsHalves`, the same
     decision `attachTemplateGroups` makes), not from the model's recall, unless
     it supplies its own. An unpriced item is created hidden, as a starter item
     is, and menu health lists it until priced. Duplicates are refused at
     propose time (a section or item the menu already has, by `normalizeTerm`).
     Web: `applyMenuFix` now takes the location and resolves or creates the
     section. Live-model replay: the model compared the seeded menu to the
     pizzeria template, noticed "10 Wings" already existed and proposed a price
     update instead of a second one, and built a Side Salad with the Dressing
     group, unpriced.
   - **Message taking** (2026-09-06, an MVP must-have that had been missing):
     `take_message` replaces `create_call_note`. The bot offers it when a caller
     asks for a person it cannot transfer to, wants a callback, or brings
     something outside its abilities; it asks name then message, one at a
     time, and **never makes the caller read out the number they are calling
     from** — `POST /v1/calls/:id/tools/message` defaults the callback number
     to the call's `fromNumber`. The message is its own row (`CallMessage`,
     tenant-scoped, `new`|`done`), also a `call.message` event on the call's
     timeline, and the restaurant is **texted** through the shared
     `lib/notifier.ts` (`textLocation`: notification phone, else main phone,
     **sent from the location's own Twilio number** — `TWILIO_SMS_FROM` /
     `TWILIO_MESSAGING_SERVICE_SID` are only the fallback for a location
     without one;
     Notification row with a dedupe key, rule #7; best-effort, never fails the
     take). Web: a **Messages** screen (new/done, mark done, reopen, tel: link,
     "see the call"), a "Messages waiting" dashboard card, and the message shown
     on the call in Calls. Live-model replay 2/2: "is the owner there?" with no
     owner transfer → offered a message → `take_message` with name + message
     and no callback number. `offerMessageWhenClosed` is read as of the
     closed-hours work below.
   - **Brayz staff admin portal + support** (2026-09-09): the business had no
     cockpit of its own — no way to see how many restaurants were on Brayz, what
     they were paying, or that one of them was stuck. `/admin` is that screen, and
     deliberately not under `/app`: `/app` is one restaurant's dashboard scoped to
     the tenant they picked, this is every tenant at once, and the dark chrome is a
     standing reminder of which one you are looking at. Access is `users.platformRole`
     (`support` reads; `admin` also answers support and grants access) — a column,
     never a header, and `PLATFORM_ADMIN_EMAILS` exists only so the **first** admin
     can exist; after that the column is the source of truth and removing the email
     does not revoke. `routes/admin.ts` is rule #1's second exception and states its
     own terms at the top of the file: aggregates only, never a transcript,
     recording, guest, or order, and every read of an identifiable customer written
     to `platform_audit_logs`. Being staff is not a master key — a tenant-scoped
     route never consults a platform role, and there is a test that says so. The
     customer half is **Help** (`/app/help`): a restaurant files a support request,
     Brayz replies from the queue at `/admin/support`, and the reply appears on their
     own screen. Withdrawal is allowed only while it is still open, because after
     that the thread is a shared record. See `docs/operations/admin-portal.md`.
     **Deferred:** notifying staff of a new request (wire to `lib/notifier.ts`),
     per-customer usage graphs, impersonation (deliberately not built).
   - **Live calls + call history in the staff portal** (2026-09-11): the Overview
     leads with active calls right now, across every customer and per SiphonAI
     node (`GET /v1/admin/calls/live`, polled every 5 s), and a gap-free call
     histogram by hour/day/week/month in the viewer's timezone
     (`/v1/admin/calls/histogram`). **Node identity rides the media URL**:
     SiphonAI's `start` does not say which node sent it, so Terraform renders
     each node's `[bridge].ws_url` as `…/v1/media?node=<[node].id>`, the
     Orchestrator (`nodeIdFor`) stores it on `calls.nodeId` (fallback
     `ip:<forwarded address>`; a malformed id is dropped, never fails a call).
     A new node needs only its own `[node].id`. "Live" = no `endedAt` and
     started < 2 h ago; older open rows are reported as stale, not counted,
     because the end is recorded best-effort. Counts only, so unaudited like
     the overview. **Node health** (same day): loopback-only SiphonAI probes
     are unreachable from Cloud Run, so the siphon-node startup script
     installs `brayz-node-heartbeat` (systemd timer, 30 s, runs as
     `siphon-ai`, read-only) posting a `NodeHealthSnapshot` to
     `/v1/voice-nodes/:id/heartbeat` (self-registers on 404) — this finally
     uses the Phase 2 `voice_nodes` table, whose `health` JSON holds the
     latest snapshot. `lib/nodeHealth.ts` → down (90 s silent / service or
     /health down) > draining > degraded (with reasons) > healthy.
   - **30-day free trial** (2026-09-11): every new account (tenant, at
     `POST /v1/tenants`) gets Pro on all its locations until
     `tenants.trialEndsAt`. `accessFor` in `@brayz/billing` is the one rule:
     paid serviceable plan > running trial (Pro) > lapsed trial (**out of
     service**) > pre-trial account (unrestricted, as before). Out of service
     ignores `BILLING_ENFORCED`: `POST /v1/calls` returns `service`, the
     Orchestrator REFERs to the restaurant (first transfer target / escalation
     phone) or says `OUT_OF_SERVICE_LINE` and hangs up; the call is still
     recorded (`call.out_of_service`), paid features 402 `trial_expired`.
     Checkout mid-trial sets Stripe `trial_end`. Staff: `/admin/trials`
     (progress, audited) and admin-only extend with a reason (audit log =
     history; also starts a trial for an old account). See
     `docs/operations/admin-portal.md`.
   - **Delivery orders** (2026-09-11). A restaurant that does both is asked about on
     every call ("Is this for pickup or delivery?"). A delivery takes an address that
     the API checks against the delivery area: the address qualifies if it is within
     the radius **or** its ZIP is listed. The radius is straight-line, measured from
     the restaurant's position, and both positions come from a `GeocodingProvider`
     (the US Census geocoder). A failed lookup takes the order and flags it
     `unverified` rather than losing it. The fee, the minimum and the per-location
     pickup and delivery ETAs are Settings. The fee is added by the API (rule #5),
     and discounts and loyalty points apply to the food only. The address is saved
     on the guest:
     - full memory mode offers it back ("still delivering to …?");
     - confirm mode never gives it to the engine until the caller says its street
       number (`/tools/guest/address/confirm`, audited, two tries);
     - off saves nothing.

     The four engine tools gate the read-back like the name gate does, and two more
     facts the order depends on are enforced in the tool rather than asked of the
     prompt: `set_fulfillment` refuses a pickup-or-delivery the caller never said and
     was never asked ("Great, this'll be a pickup order" was a guess the caller had to
     correct), and a menu group the item *requires* stops the read-back until it is
     chosen, while a group merely offered is named in it ("1 Quesadilla (no Toppings
     chosen)") so a question the caller talked over is still heard before they confirm.
     Every order tool call and its result is logged, which is what made the calls above
     diagnosable. Square gets the address and the fee as a service charge. See
     `docs/operations/delivery-orders.md`.
   - **Brayz Insights** (2026-09-11) — the last product module from the plan that had
     no screen. `/app/insights` and `GET /v1/locations/:id/insights` answer "what did
     Brayz do for me?" over a window: calls answered, orders and revenue, upsell
     revenue (from `viaUpsell`, so attribution is the engine's own record), discounts,
     loyalty, new vs returning guests, favourite items, top guests, and a gap-free
     series cut in **the restaurant's** timezone. **"Calls that would have rung out"
     is defined honestly** — answered outside opening hours (holidays and
     after-midnight shifts included) or while another call was already live, counted
     once, with the breakdown shown and zero claimed when a location has no hours
     saved. The pure part is `lib/insights.ts`; recordings stay on Calls rather than
     being duplicated. The dashboard's hard-coded "Missed calls prevented: 0" card,
     a placeholder since Phase 0, is gone. See `docs/operations/insights.md`.
   - **Changing an order already placed** (2026-09-13): a caller ringing back
     ("I forgot the garlic bread", "take the salad off", "cancel it") had no
     path at all — the bot could not see an order, only take a message. Now
     `lookup_recent_order` finds **their own** order at this location that the
     kitchen has not accepted (status decides it, not the clock; a locked one is
     reported as locked *with its status*, so the caller hears "it's already
     being made"), gated exactly like the saved address by `guestMemoryMode` —
     full trusts caller ID, confirm says only that an order exists until the
     confirmation code is read back (2 tries, counted in call events), off does
     not look. `change_order` seeds the in-call draft from the placed order, so
     add/remove/update/halves/read-back all work unchanged, and `place_order`
     **saves back to that order instead of creating a second one** — the one
     mistake this path must not make. Only the items change: fulfilment,
     address, name and booked time stay put (a message otherwise). The API
     takes the whole line list, re-prices it (rule #5), keeps any discount
     already granted, still enforces the delivery minimum, and appends a
     loyalty delta rather than rewriting the earn. The restaurant is texted
     `CHANGED —` (plus "amend the ticket on the till" when Square has it: the
     adapter can create and set status, never edit lines) or `CANCELED —`, and
     every lookup/change/cancel is audited. See
     `docs/operations/changing-an-order.md`. **Known gap:** a cancelled order
     keeps its loyalty points, matching what the dashboard's cancel has always
     done.
   - **A caller choosing between two things we offered** (2026-09-12): on a
     live call the bot asked "the Philly Steak sub, or the Philly Steak Pizza?",
     the caller said "the Philly steak sub", and echo suppression dropped it as
     our own voice — four of five words were a run of our sentence, over the
     0.7 coverage threshold. Fourteen seconds of silence, then "Hello?". The
     short-answer exemption (`ANSWER_PHRASES`, `ECHO_MIN_WORDS`) exists for
     exactly this, but a five-word answer fell past it. `offeredChoices` now
     records the alternatives of any question we ask (ends in "?", has an
     "or"), and `picksOneChoice` lets through an utterance that matches ONE of
     them and carries no word from the others — an echo of the question brings
     both options with it, and a fragment starting "or…" is our own tail, never
     a reply.
   - **Menu-item option breakdown + CSV export** (2026-09-12): Insights could
     say a large pizza sold 34 times but not what went on them. The Menu items
     tab now opens each row to the options chosen on it, kept in the menu's own
     groups and **uncapped** (the overview still trims for a glance — that is
     what the `caps` argument to `groupOptions` is for), with each option's
     share of the item. Two CSVs — `insights/items.csv` (a row per item) and
     `insights/item-options.csv` (a row per item+option) — because an item's
     quantity and a topping's quantity must not sum in the same column; money
     exports as a plain number and off-menu sales are last and marked. The item
     query is shared by the screen and its export (`menuItemSales`), so the two
     can never disagree. Also fixed a pre-existing **flaky test**: the orders
     integration test asserted the SMS sender against the location's numbers
     *at assertion time*, and test files sharing the seeded location register
     and remove numbers as they run — it now reads them at send time.
   - **Closed hours + orders for later** (2026-09-12): the hours were saved,
     shown and counted by Insights, and the one thing that never read them was
     the AI — a 4am call got an order taken and a ticket texted to a dark
     kitchen. `LocationAiSettings.closedBehavior` (`take_orders` default —
     unchanged on deploy — or `announce`) has the greeting itself say it is
     shut and when it opens next, and `place_order` is then refused by the
     engine *and* the API. `scheduleOrdersEnabled` + `scheduleMaxDaysAhead`
     take an order for a later time, open or closed: the model passes a local
     clock time and a day to `schedule_order` (never an instant — it does not
     know the timezone), and the API answers yes, or no with **the earliest
     time that would work**. The agreed time is read back with the order,
     stored on `orders.scheduledFor`, re-validated at placing, and leads the
     kitchen SMS and the POS note in capitals; the Orders board sorts by when
     an order is due and only calls it late once its time has come. A location
     with **no hours saved is treated as open** (the same posture Insights
     takes). Hours arithmetic — DST, after-midnight closes, holidays, spoken
     forms — is `services/api/src/lib/hours.ts`, now shared with Insights, so
     the rule that counts a call as after-hours is the rule that tells a caller
     the door is shut. See `docs/operations/closed-hours-and-scheduling.md`.
   - **Still to build:** the owner mobile app (Expo + React Native, Expo Router,
     native push).

> **Stacked-PR caution.** #21/#22 merged into their stacked *bases*, not `main`, and
> were stranded until #23 replayed them; #24/#25/#26 show CLOSED on GitHub yet their
> code is on `main`. Judge what landed by file presence, not PR state. Squash merges
> also make `git cherry` and `git log main..branch` report already-merged commits as
> missing — confirm with a two-way `git diff branch origin/main`.

**Explicitly out of MVP scope:** in-call payments, complex delivery dispatch, a
customer-facing mobile app (the *owner* app is in scope), and voice biometrics. Don't
add these without a deliberate decision. (Full POS integration was on this list until
#20 shipped it deliberately.)

---

## Working style in this repo

- Make features tenant-aware and provider-agnostic by default; if a change can't be,
  flag it.
- Validate inputs with Zod at boundaries; share types/schemas via `packages/shared`.
- Prefer adding an adapter over branching on a vendor name.
- Keep prompts simple and constrained; business rules belong in tools, not prompts.
- For voice/real-time changes, think about latency, barge-in, draining active calls,
  and the fallback path (transfer to staff on uncertainty or provider failure).
- Update `docs/` and this file when architecture or commands change.
- **Destructive migrations ship in two steps.** Never drop or rename a column in
  the same deploy that stops reading it: the running image's Prisma client
  selects every column it knows, so the drop 500s every query on that table
  until the new image is live (2026-09-07: `greeting_rotation` dropped
  `aiGreeting` at 20:41 UTC and `/v1/locations` failed for eight minutes — the
  dashboard showed "build your first location"). Order: add-only migration →
  deploy → drop in a later migration once nothing reads the column.
