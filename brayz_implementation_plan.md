# Brayz Implementation Plan

This document turns the Brayz development plan and GCP architecture into an actionable build plan. It defines what to build, how to build it, the order of implementation, and the acceptance criteria for each phase.

Brayz should be built as a GCP-first SaaS platform with a native Siphon-AI voice layer on Compute Engine, Cloud SQL PostgreSQL as the system of record, Twilio as the first PSTN provider, and provider abstractions that allow Brayz to add other carriers, AI providers, and POS systems later.

---

## 1. Implementation Principles

### 1.1 Build the smallest useful vertical slice first

The first goal is not to build the entire restaurant AI platform. The first goal is to prove this path:

```text
Restaurant phone number
  -> Twilio Elastic SIP Trunking
  -> Siphon-AI Compute Engine node
  -> Brayz Conversation Orchestrator
  -> AI response
  -> call summary stored
  -> restaurant dashboard shows the call
```

Once that works, expand into order taking, guest memory, loyalty, staff voices, and mobile apps.

### 1.2 Keep Siphon-AI focused

Siphon-AI should not become the SaaS application. It should remain the real-time SIP/RTP gateway.

Siphon-AI responsibilities:

- Accept inbound SIP calls.
- Negotiate media.
- Send/receive RTP.
- Convert RTP to 20 ms PCM frames.
- Stream media to the Conversation Orchestrator over WebSocket.
- Play TTS audio back into the call.
- Emit call lifecycle and VAD/barge-in events.
- Support transfer/hangup/control commands.

Siphon-AI should not own:

- Restaurant configuration.
- Guest memory.
- Orders.
- Loyalty.
- Billing.
- Long-term call history.
- Menu logic.
- AI prompts.

### 1.3 Design provider abstractions from the beginning

Twilio is the first PSTN provider, not the permanent architecture.

Use interfaces for:

- PSTN carrier provider.
- SIP trunk provider.
- STT provider.
- LLM provider.
- TTS provider.
- SMS provider.
- Email provider.
- POS provider.
- Payment provider.

Do not hard-code Twilio, Deepgram, OpenAI, Stripe, Toast, or Square into core business logic.

### 1.4 Use Postgres as the source of truth

Cloud SQL PostgreSQL should store the durable business record:

- Tenants.
- Locations.
- Users.
- Phone numbers.
- Menus.
- Guests.
- Calls.
- Transcripts.
- Orders.
- Promotions.
- Billing state.
- Provider configuration.

Redis/Memorystore should only store hot state, temporary state, rate limits, active sessions, and locks.

### 1.5 Make every major feature tenant-aware

Every table, API route, background job, cache key, and event should be scoped by `tenant_id` and usually `location_id`.

No guest memory should be shared across restaurants by default.

---

## 2. Recommended Build Stack

### 2.1 Monorepo

Use one monorepo for the Brayz SaaS platform.

```text
brayz/
  apps/
    web/                    # Next.js marketing site and restaurant admin portal
    mobile/                 # Expo React Native owner app, later phase
  services/
    api/                    # Fastify REST API
    orchestrator/           # Real-time Conversation Orchestrator
    worker/                 # Pub/Sub workers and background jobs
    notification-service/    # SMS/email/push notification abstraction
  packages/
    db/                     # Prisma schema, migrations, seed data
    shared/                 # Shared TypeScript types and Zod schemas
    ai/                     # Provider interfaces and prompt/tool definitions
    carriers/               # Twilio and future carrier adapters
    ui/                     # Shared web UI components
    config/                 # Shared config loader
  voice/
    siphon-ai-config/        # Node config examples, systemd units, install scripts
    node-agent/              # Optional local health/metrics/drain helper
  infra/
    terraform/               # GCP infrastructure
    scripts/                 # Deployment/bootstrap scripts
  docs/
    architecture/
    implementation/
    operations/
```

### 2.2 Backend

Use TypeScript and Fastify for the SaaS services.

Recommended service layout:

- `services/api`: REST API for web/mobile/admin.
- `services/orchestrator`: WebSocket media session service and AI conversation state machine.
- `services/worker`: async jobs for transcripts, summaries, notifications, exports, cleanup.
- `services/notification-service`: SMS/email/push abstraction, which can also live inside `worker` at first.

Use:

- Fastify for APIs.
- Zod for validation.
- Prisma for schema/migrations and fast MVP productivity.
- OpenAPI generation for internal API docs.
- Pino for structured JSON logs.
- Vitest for unit tests.

### 2.3 Web

Use:

- Next.js.
- TypeScript.
- Tailwind CSS.
- shadcn/ui.
- TanStack Query.
- Firebase Auth / Google Identity Platform or Clerk.

For GCP alignment, Firebase Auth / Identity Platform is the cleaner long-term default. Clerk is faster for SaaS polish. Either is acceptable, but pick one early and avoid changing it mid-MVP.

### 2.4 Data

Use:

- Cloud SQL PostgreSQL.
- Private IP for production database access.
- Prisma migrations.
- Cloud SQL managed connection pooling or an application-level pool.
- Memorystore Redis for active call state.
- Cloud Storage for recordings and generated assets.
- Pub/Sub for durable async events.

### 2.5 Voice layer

Use:

- Siphon-AI on Compute Engine.
- Native Linux service managed by systemd.
- Static public IPs for MVP.
- Fixed UDP RTP port range.
- Twilio Elastic SIP Trunking origination to Siphon-AI.
- WebSocket from Siphon-AI to the Orchestrator.
- mTLS or signed node tokens between Siphon-AI and Brayz services.

---

## 3. Target Service Boundaries

### 3.1 Web app

Responsibilities:

- Public landing page.
- Restaurant owner login.
- Tenant/location onboarding.
- Dashboard.
- Calls page.
- Orders page.
- Menu editor.
- Guest profiles.
- Settings.

The web app should not talk directly to the database. It should call `services/api`.

### 3.2 API service

Responsibilities:

- Authentication and authorization.
- Tenant/location scoping.
- CRUD APIs for restaurants, locations, users, menus, guests, calls, orders, settings.
- Carrier configuration.
- AI provider configuration.
- Billing configuration later.
- Admin reporting.

### 3.3 Conversation Orchestrator

Responsibilities:

- Accept WebSocket sessions from Siphon-AI.
- Load restaurant context.
- Load caller/guest context.
- Manage call state machine.
- Connect to STT, LLM, and TTS providers.
- Expose AI tools such as `lookup_menu`, `create_order`, `transfer_call`, `save_guest_note`.
- Send audio back to Siphon-AI.
- Publish events to Pub/Sub.

### 3.4 Worker service

Responsibilities:

- Process Pub/Sub events.
- Generate call summaries.
- Save transcripts.
- Send SMS/email notifications.
- Sync recordings to Cloud Storage.
- Recompute guest favorites.
- Run cleanup jobs.
- Handle retries and dead-letter queues.

### 3.5 Siphon-AI node

Responsibilities:

- Real-time SIP/RTP handling.
- WebSocket media bridge.
- Basic call control.
- Health endpoint.
- Metrics endpoint.
- Graceful drain.

---

## 4. Phase 0 — Project Bootstrap

### Goal

Create the repo, development environment, GCP foundation, and basic service skeletons.

### What to build

- Brayz monorepo.
- Local dev environment.
- GCP dev project.
- Terraform foundation.
- Cloud SQL dev instance.
- API service skeleton.
- Orchestrator service skeleton.
- Web app shell.
- Initial database schema.

### How to build

#### 4.1 Create the monorepo

Use pnpm workspaces or Turborepo.

```text
brayz/
  apps/web
  services/api
  services/orchestrator
  services/worker
  packages/db
  packages/shared
  packages/ai
  packages/carriers
  infra/terraform
```

Recommended baseline commands:

```bash
pnpm init
pnpm add -w typescript tsx eslint prettier turbo
pnpm add -w zod dotenv pino
```

#### 4.2 Create shared environment loading

Build a small config package:

```text
packages/config/
  src/index.ts
```

It should validate environment variables with Zod.

Required early environment variables:

```text
NODE_ENV
DATABASE_URL
REDIS_URL
GCP_PROJECT_ID
PUBSUB_TOPIC_CALL_EVENTS
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
OPENAI_API_KEY
DEEPGRAM_API_KEY
BRAYZ_NODE_SHARED_SECRET
```

#### 4.3 Create Terraform foundation

Create these Terraform modules:

```text
infra/terraform/
  envs/dev
  envs/prod
  modules/network
  modules/cloud-sql
  modules/redis
  modules/pubsub
  modules/cloud-run-service
  modules/compute-siphon-node
  modules/storage
  modules/iam
  modules/secrets
```

Dev environment should create:

- VPC.
- Subnets.
- Firewall rules.
- Cloud SQL PostgreSQL.
- Memorystore Redis.
- Pub/Sub topics.
- Cloud Storage bucket.
- Service accounts.
- Secret Manager placeholders.
- One Compute Engine VM for Siphon-AI.

#### 4.4 Create database package

Use Prisma.

```text
packages/db/
  prisma/schema.prisma
  prisma/migrations/
  src/client.ts
  src/tenantScope.ts
```

Initial tables:

- tenants
- locations
- users
- user_tenant_memberships
- phone_numbers
- provider_accounts
- carrier_routes
- menus
- menu_categories
- menu_items
- menu_modifier_groups
- menu_modifiers
- guests
- guest_phone_numbers
- calls
- call_events
- call_transcripts
- orders
- order_items
- order_item_modifiers
- notifications
- audit_logs

#### 4.5 Create API skeleton

Initial API structure:

```text
services/api/src/
  main.ts
  app.ts
  plugins/auth.ts
  plugins/db.ts
  plugins/logger.ts
  modules/tenants
  modules/locations
  modules/menus
  modules/calls
  modules/orders
  modules/guests
  modules/settings
```

First endpoints:

```text
GET  /healthz
GET  /readyz
GET  /v1/me
POST /v1/tenants
GET  /v1/tenants/:tenantId
POST /v1/locations
GET  /v1/locations/:locationId
```

#### 4.6 Create web shell

Initial pages:

```text
/
/login
/app
/app/dashboard
/app/calls
/app/orders
/app/guests
/app/menu
/app/settings
```

At this phase, the pages can use mocked data except for login and tenant/location selection.

### Acceptance criteria

- Repo builds locally.
- Database migrations run.
- API starts locally.
- Web app starts locally.
- Terraform can create a dev environment.
- API can connect to Cloud SQL.
- Web app can call the API.
- One tenant and one location can be created.

---

## 5. Phase 1 — Core Restaurant Admin Platform

### Goal

Build the minimum SaaS control plane needed to configure a real restaurant.

### What to build

- Authenticated admin portal.
- Tenant/location model.
- Restaurant profile.
- Hours and holiday hours.
- Phone number configuration.
- Menu management.
- Basic dashboard.

### How to build

#### 5.1 Auth and tenant membership

Implement these concepts:

- User belongs to one or more tenants.
- User has a role per tenant/location.
- Roles: `owner`, `manager`, `staff`, `admin`.
- Every API request resolves an active `tenant_id` and optional `location_id`.

Authorization helper:

```text
requireTenantRole(request, tenantId, ['owner', 'manager'])
requireLocationAccess(request, locationId)
```

#### 5.2 Restaurant profile

Tables:

```text
locations
location_hours
location_holiday_hours
location_contact_methods
location_ai_settings
```

Fields to include early:

- Restaurant name.
- Address.
- Time zone.
- Main phone number.
- Escalation phone number.
- Pickup enabled.
- Delivery enabled.
- Delivery zones, later.
- Business hours.
- Holiday hours.
- AI greeting.
- Transfer rules.

#### 5.3 Menu editor

Build CRUD for:

- Categories.
- Items.
- Descriptions.
- Prices.
- Availability.
- Modifier groups.
- Required modifiers.
- Optional modifiers.
- Upsell tags.

Example menu structure:

```text
Pizza
  Large Cheese Pizza
    modifiers: toppings, crust, extra cheese
Wings
  10 Wings
    modifiers: sauce, blue cheese/ranch
Sides
  Garlic Knots
Drinks
  2-liter Soda
```

#### 5.4 Dashboard shell

Dashboard cards:

- Calls today.
- Orders today.
- Missed calls prevented.
- Estimated revenue captured.
- Active calls.
- Recent orders.

At this phase, some cards can be placeholders until call/order data exists.

### Acceptance criteria

- Owner can create a restaurant location.
- Owner can configure hours and escalation number.
- Owner can build a usable menu.
- Dashboard loads tenant/location data from the API.
- API enforces tenant scoping.

---

## 6. Phase 2 — Siphon-AI Node Integration

### Goal

Route a real inbound Twilio PSTN call to a native Siphon-AI VM and connect it to Brayz.

### What to build

- Compute Engine Siphon-AI VM.
- Native systemd installation.
- Node registration with Brayz API.
- Siphon-AI config file.
- Health and metrics endpoints.
- Twilio SIP trunk configuration.
- Call lifecycle event ingestion.
- WebSocket connection from Siphon-AI to Orchestrator.

### How to build

#### 6.1 Siphon-AI VM layout

Recommended VM filesystem:

```text
/opt/brayz/siphon-ai/siphon-ai
/etc/brayz/siphon-ai/config.toml
/var/lib/brayz/siphon-ai/
/var/log/brayz/siphon-ai/
```

Systemd unit:

```ini
[Unit]
Description=Brayz Siphon-AI Voice Gateway
After=network-online.target
Wants=network-online.target

[Service]
User=brayz
Group=brayz
ExecStart=/opt/brayz/siphon-ai/siphon-ai --config /etc/brayz/siphon-ai/config.toml
Restart=always
RestartSec=2
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

#### 6.2 Siphon-AI config

Example:

```toml
[node]
node_id = "siphon-dev-001"
region = "us-east4"
environment = "dev"

[sip]
listen_ip = "0.0.0.0"
listen_port = 5060
external_ip = "STATIC_PUBLIC_IP"
allowed_sources = ["twilio"]

[rtp]
listen_ip = "0.0.0.0"
external_ip = "STATIC_PUBLIC_IP"
port_min = 20000
port_max = 30000
frame_ms = 20
encoding = "pcm16le"

[orchestrator]
websocket_url = "wss://orchestrator-dev.brayz.ai/v1/media"
node_token_secret_name = "brayz-dev-siphon-node-token"

[events]
api_base_url = "https://api-dev.brayz.ai"
```

#### 6.3 Node registration

Create API endpoints:

```text
POST /v1/voice-nodes/register
POST /v1/voice-nodes/:nodeId/heartbeat
POST /v1/voice-nodes/:nodeId/drain
POST /v1/voice-nodes/:nodeId/undrain
```

Node heartbeat payload:

```json
{
  "node_id": "siphon-dev-001",
  "region": "us-east4",
  "public_ip": "x.x.x.x",
  "active_calls": 3,
  "max_calls": 100,
  "sip_status": "ready",
  "rtp_port_usage": {
    "used": 6,
    "available": 9994
  }
}
```

#### 6.4 Call lifecycle events

Siphon-AI should POST or publish events through the Orchestrator/API.

Events:

```text
call.invited
call.answered
call.media_started
call.barge_in
call.transferred
call.completed
call.failed
```

Recommended event envelope:

```json
{
  "event_id": "uuid",
  "event_type": "call.answered",
  "occurred_at": "2026-06-09T16:00:00Z",
  "tenant_id": "tenant_uuid",
  "location_id": "location_uuid",
  "call_id": "call_uuid",
  "source": "siphon-ai",
  "source_node_id": "siphon-dev-001",
  "payload": {}
}
```

#### 6.5 Twilio trunk configuration

For MVP:

- Buy or assign one Twilio number.
- Create Elastic SIP Trunk.
- Configure Origination URI to Siphon-AI public SIP URI.
- Restrict firewall to Twilio SIP/RTP source ranges where practical.
- Use IP ACLs or digest auth for trunk authentication.
- Map called number to `location_id` in Brayz.

Database tables:

```text
phone_numbers
carrier_accounts
carrier_routes
```

`phone_numbers` should include:

- `tenant_id`
- `location_id`
- `e164_number`
- `provider`
- `provider_number_sid`
- `inbound_route_type`
- `active`

#### 6.6 WebSocket media session

Siphon-AI starts the session with a JSON message:

```json
{
  "type": "start",
  "protocol_version": "1.0",
  "call_id": "call_uuid",
  "node_id": "siphon-dev-001",
  "from": "+15185551212",
  "to": "+15185559898",
  "audio": {
    "encoding": "pcm16le",
    "sample_rate": 8000,
    "frame_ms": 20,
    "channels": 1
  }
}
```

After the start message:

- Binary frames from Siphon-AI are caller audio.
- Binary frames to Siphon-AI are TTS audio.
- Text messages are control/events.

Control messages:

```json
{ "type": "clear_playback" }
{ "type": "transfer", "target": "+15185550000" }
{ "type": "hangup", "reason": "conversation_complete" }
```

### Acceptance criteria

- A Twilio PSTN call reaches Siphon-AI.
- Siphon-AI answers the call.
- Siphon-AI opens a WebSocket to the Orchestrator.
- Orchestrator receives 20 ms PCM frames.
- Orchestrator can send test audio back to the caller.
- API stores call start/end records.
- Dashboard shows the call after completion.

---

## 7. Phase 3 — Conversation Orchestrator MVP

### Goal

Create the real-time AI brain that can answer the phone, understand the caller, speak back, and log the conversation.

### What to build

- WebSocket media endpoint.
- STT provider adapter.
- LLM provider adapter.
- TTS provider adapter.
- Conversation state machine.
- Barge-in handling.
- Transcript capture.
- Basic tool-calling layer.

### How to build

#### 7.1 Orchestrator modules

```text
services/orchestrator/src/
  main.ts
  media/wsServer.ts
  sessions/CallSession.ts
  sessions/CallStateMachine.ts
  providers/stt/DeepgramProvider.ts
  providers/llm/OpenAIProvider.ts
  providers/tts/DeepgramTtsProvider.ts
  tools/lookupRestaurant.ts
  tools/lookupMenu.ts
  tools/createMessage.ts
  tools/transferCall.ts
  context/loadCallContext.ts
  events/publishCallEvent.ts
```

#### 7.2 Conversation state machine

Initial states:

```text
initializing
loading_context
greeting
listening
thinking
speaking
collecting_message
collecting_order
transferring
completed
failed
```

#### 7.3 First prompt

The first prompt should be simple and constrained:

```text
You are Brayz, answering calls for {{restaurant_name}}.

You can answer questions about hours, location, menu, and pickup orders.
You should be friendly, concise, and restaurant-like.
If the caller asks for something outside your abilities, offer to transfer them to staff.
Never invent menu prices. Use the provided menu context.
Confirm important order details before submitting.
```

#### 7.4 Tool layer

Initial tools:

```text
lookup_restaurant_profile(location_id)
lookup_hours(location_id)
lookup_menu(location_id, query)
create_call_note(call_id, note)
transfer_call(call_id, target)
```

Tool calls should go through the API or a service layer, not directly through random SQL in prompt code.

#### 7.5 Barge-in

When Siphon-AI sends VAD speech-start while TTS is playing:

1. Orchestrator sends `clear_playback` to Siphon-AI.
2. Orchestrator cancels the active TTS stream.
3. Orchestrator resumes listening.
4. The transcript marks an interruption event.

#### 7.6 Transcript model

Use structured transcript turns:

```json
{
  "speaker": "caller",
  "text": "What time do you close?",
  "started_at": "...",
  "ended_at": "...",
  "confidence": 0.94
}
```

Store final transcript in `call_transcripts`, and optionally store turn-level JSON in `call_events` or `call_transcript_turns`.

### Acceptance criteria

- Caller hears a natural greeting.
- Caller can interrupt the AI while it is speaking.
- AI can answer hours/location/menu questions from configured data.
- AI can transfer to staff.
- Full transcript is stored.
- Call summary is generated after call completion.

---

## 8. Phase 4 — AI Receptionist MVP

### Goal

Make Brayz useful even before order-taking is fully automated.

### What to build

- Hours/location Q&A.
- Menu Q&A.
- Message taking.
- Human transfer.
- Basic call summaries.
- Restaurant notifications.

### How to build

#### 8.1 Receptionist capabilities

Supported intents:

```text
ask_hours
ask_location
ask_menu
ask_specials
request_transfer
leave_message
place_order_later_phase
unknown
```

#### 8.2 Message taking

Flow:

1. Caller asks to leave a message or cannot be helped.
2. AI asks for name, callback number, and message.
3. AI confirms the message.
4. Brayz stores message as a call note.
5. Brayz sends SMS/email to restaurant.

Tables:

```text
call_messages
notifications
```

#### 8.3 Transfer handling

Transfer rules:

- If restaurant is open and escalation number is configured, transfer.
- If restaurant is closed, offer message taking.
- If transfer fails, return to AI and offer message taking.

#### 8.4 Notifications

Notification channels:

- Email for call summaries.
- SMS for urgent messages.
- Dashboard notification.
- Push later.

Notification template:

```text
New Brayz call for {{restaurant_name}}
From: {{caller_number}}
Summary: {{summary}}
Action needed: {{yes/no}}
```

### Acceptance criteria

- Brayz can handle a useful restaurant call without taking an order.
- Owner can view calls, transcripts, and messages in dashboard.
- Owner receives notification for messages or transfers.
- Failed/unknown intents are handled gracefully.

---

## 9. Phase 5 — Pickup Order Taking

### Goal

Allow Brayz to take a complete pickup order and send it to the restaurant.

### What to build

- Order conversation flow.
- Menu item matching.
- Modifier collection.
- Price calculation.
- Order confirmation.
- Kitchen ticket view.
- SMS/email order delivery.
- Order status dashboard.

### How to build

#### 9.1 Order state machine

States:

```text
order_started
collecting_fulfillment_type
collecting_items
collecting_modifiers
confirming_order
collecting_name
collecting_callback_number
submitting_order
order_submitted
order_failed
```

#### 9.2 Order builder object

Keep an in-memory order draft in Redis during the call.

Redis key:

```text
active_call:{call_id}:order_draft
```

Draft shape:

```json
{
  "fulfillment_type": "pickup",
  "items": [
    {
      "menu_item_id": "uuid",
      "name": "Large Pepperoni Pizza",
      "quantity": 1,
      "modifiers": [
        { "modifier_id": "uuid", "name": "Extra cheese", "price": 2.00 }
      ],
      "special_instructions": "well done"
    }
  ],
  "customer_name": "Mike",
  "customer_phone": "+15185551212",
  "subtotal": 24.99,
  "tax": null,
  "total": 24.99
}
```

Postgres becomes the source of truth only after confirmation.

#### 9.3 Menu matching

Approach:

1. Exact match by item name.
2. Fuzzy match by normalized item name.
3. Optional embedding match using pgvector later.
4. Ask clarification if confidence is low.

Example:

```text
Caller: I want a large pep pizza.
AI: Did you mean a large pepperoni pizza?
```

#### 9.4 Modifier handling

Each menu item can have modifier groups:

- Required group: must ask.
- Optional group: ask only when relevant.
- Multi-select group: allow multiple toppings.
- Single-select group: sauce, size, crust, dressing.

Example:

```text
10 Wings
  Required: sauce
  Optional: blue cheese/ranch
```

#### 9.5 Order confirmation

The AI must always confirm:

- Items.
- Quantities.
- Modifiers.
- Pickup/delivery.
- Name.
- Callback number.
- Estimated ready time if configured.
- Total if available.

#### 9.6 Kitchen ticket

Dashboard ticket should show:

```text
MARIO'S PIZZA
Pickup Order
Customer: Mike
Phone: +1 518-555-1212

1x Large Pepperoni Pizza
  - Extra cheese
  - Well done

1x Garlic Knots

Notes:
Caller asked for extra napkins.
```

#### 9.7 Order delivery

MVP delivery channels:

- Dashboard order queue.
- Email.
- SMS summary.

Do not block MVP on POS integration.

### Acceptance criteria

- Caller can place a pickup order using natural speech.
- AI asks clarifying questions for modifiers.
- AI confirms before submitting.
- Order is stored in Postgres.
- Restaurant receives the order by dashboard and notification.
- Owner can mark order as accepted, ready, completed, or canceled.

---

## 10. Phase 6 — Guest Memory

### Goal

Make repeat callers feel remembered while staying privacy-safe.

### What to build

- Guest profile creation.
- Phone-number-based guest lookup.
- Multiple phone numbers per guest.
- Order history.
- Favorite item detection.
- Saved pickup name.
- Saved delivery address later.
- “Would you like your usual?” flow.

### How to build

#### 10.1 Guest identity MVP

Start with phone number matching.

Do not start with voice biometrics.

Flow:

```text
Inbound caller ID -> guest_phone_numbers lookup -> guest profile loaded
```

If guest exists:

```text
Welcome back, Mike. Would you like to place an order today?
```

If guest has strong repeat history:

```text
Last time you ordered garlic knots and wings. Would you like to start with that again?
```

#### 10.2 Guest profile tables

```text
guests
guest_phone_numbers
guest_addresses
guest_preferences
guest_favorite_items
guest_notes
```

#### 10.3 Favorite detection

Run a background job after each completed order:

- Count item frequency.
- Count recent item frequency.
- Track last ordered date.
- Store top favorites.

#### 10.4 Privacy controls

Add dashboard controls:

- Delete guest profile.
- Disable guest memory for a guest.
- Remove phone number from guest.
- Export guest history later.

### Acceptance criteria

- Repeat caller is recognized by phone number.
- Order history appears on guest profile.
- AI can reference previous order without exposing sensitive data.
- Owner can delete or disable a guest profile.

---

## 11. Phase 7 — Production Beta Hardening

### Goal

Make Brayz reliable enough for a real restaurant pilot.

### What to build

- Two or more Siphon-AI nodes.
- Health checks.
- Graceful drain.
- Load testing.
- Structured logs.
- Metrics.
- Alerts.
- Backups.
- Dead-letter queues.
- Admin runbooks.

### How to build

#### 11.1 Multi-node Siphon-AI

Start with static Twilio origination URIs pointing to multiple Siphon-AI nodes.

Later move to:

```text
Twilio -> regional passthrough Network Load Balancer -> Siphon-AI Managed Instance Group
```

Use a Managed Instance Group only after confirming SIP/RTP behavior, health checks, and call draining.

#### 11.2 Graceful drain

Add node state:

```text
ready
draining
drained
unhealthy
```

Drain behavior:

- Stop accepting new calls.
- Continue active calls.
- Report active call count.
- Exit only after active calls complete or max drain timeout is reached.

#### 11.3 Observability

Logs:

- Every log includes `tenant_id`, `location_id`, `call_id`, `node_id`, `event_type` when available.

Metrics:

- Active calls by node.
- New calls per minute.
- Failed calls.
- Average call duration.
- STT latency.
- LLM first-token latency.
- TTS first-audio latency.
- Barge-in count.
- Transfer count.
- Order completion rate.
- AI fallback rate.

Alerts:

- No healthy Siphon-AI nodes.
- Call failure spike.
- Orchestrator error spike.
- Cloud SQL connection pressure.
- Redis unavailable.
- Pub/Sub dead-letter backlog.
- High AI provider latency.

#### 11.4 Backup and restore

Implement:

- Cloud SQL automated backups.
- Point-in-time recovery for production.
- Cloud Storage lifecycle policy for recordings.
- Restore runbook.
- Database migration rollback notes.

#### 11.5 Security hardening

Implement:

- Secret Manager for all secrets.
- No secrets in config files or git.
- Least-privilege service accounts.
- Firewall rules for SIP/RTP.
- Admin portal MFA.
- Audit logs for guest profile access.
- Signed service-to-service requests.
- Optional mTLS between Siphon-AI and Orchestrator.

### Acceptance criteria

- Real restaurant can forward calls to Brayz.
- Two Siphon-AI nodes are available.
- A node can be drained without killing active calls.
- Alerts fire for simulated failures.
- Backups are enabled and restore has been tested.
- Pilot runbook exists.

---

## 12. Phase 8 — Loyalty, Staff Voices, Mobile, and Integrations

### Goal

Expand Brayz beyond call answering and order taking into a sticky restaurant platform.

### What to build

- Loyalty points.
- VIP rules.
- Personalized offers.
- Staff voice personas.
- Owner mobile app.
- Square integration.
- Toast/Clover research and partner path.
- Stripe billing.

### How to build

#### 12.1 Loyalty

Tables:

```text
loyalty_accounts
loyalty_events
reward_rules
promotions
promotion_redemptions
```

Rules engine examples:

```text
Buy 10 orders, get $10 off.
VIP after $500 lifetime spend.
Birthday reward.
Win-back offer after 60 days inactive.
Favorite-item discount.
```

#### 12.2 Staff voices

Build this carefully with explicit consent.

Tables:

```text
staff_profiles
staff_voice_profiles
voice_consent_records
voice_assets
voice_rotation_rules
```

Rules:

- No cloning without signed staff consent.
- Staff can revoke voice usage.
- Store consent timestamp and source.
- Keep original audio, cloned voice ID, and provider metadata separate.

#### 12.3 Owner mobile app

Mobile app should start with owner/operator workflows:

- Push notification for new order.
- Accept/reject order.
- Mark ready.
- View active calls.
- Call customer back.
- Pause AI ordering.
- Mark item unavailable.

Use Expo React Native.

#### 12.4 POS integrations

Start with Square before Toast unless there is a specific restaurant pilot requiring Toast.

Build a generic POS interface:

```text
createOrder(locationId, order)
updateOrderStatus(orderId, status)
syncMenu(locationId)
getMenu(locationId)
```

Adapters:

```text
SquarePosProvider
ToastPosProvider
CloverPosProvider
ManualTicketProvider
```

#### 12.5 Stripe billing

Billing model:

- Per-location subscription.
- Usage-based add-ons.
- AI minutes tracked by call.
- SMS usage tracked by notification.
- Optional voice clone add-on.

### Acceptance criteria

- Restaurant can enable loyalty rules.
- Repeat customer can receive personalized offer.
- Staff voice workflow requires consent.
- Owner receives mobile push for new orders.
- At least one POS integration can create an order or sync a menu.
- Stripe can create/manage subscriptions.

---

## 13. Core Database Schema Checklist

### Platform tables

```text
tenants
locations
users
user_tenant_memberships
audit_logs
api_keys
```

### Voice tables

```text
phone_numbers
carrier_accounts
carrier_routes
voice_nodes
voice_node_heartbeats
calls
call_events
call_transcripts
call_recordings
call_messages
```

### Menu and order tables

```text
menus
menu_categories
menu_items
menu_modifier_groups
menu_modifiers
orders
order_items
order_item_modifiers
order_status_events
```

### Guest tables

```text
guests
guest_phone_numbers
guest_addresses
guest_preferences
guest_favorite_items
guest_notes
```

### Loyalty tables

```text
loyalty_accounts
loyalty_events
reward_rules
promotions
promotion_redemptions
```

### Provider tables

```text
provider_accounts
ai_provider_configs
sms_provider_configs
email_provider_configs
pos_provider_configs
```

---

## 14. API Endpoint Checklist

### Public/internal health

```text
GET /healthz
GET /readyz
```

### Tenants and locations

```text
POST /v1/tenants
GET  /v1/tenants/:tenantId
POST /v1/locations
GET  /v1/locations/:locationId
PATCH /v1/locations/:locationId
```

### Menu

```text
GET    /v1/locations/:locationId/menu
POST   /v1/locations/:locationId/menu/categories
POST   /v1/locations/:locationId/menu/items
PATCH  /v1/menu/items/:itemId
DELETE /v1/menu/items/:itemId
```

### Calls

```text
GET  /v1/locations/:locationId/calls
GET  /v1/calls/:callId
POST /v1/calls/:callId/events
GET  /v1/calls/:callId/transcript
```

### Orders

```text
GET   /v1/locations/:locationId/orders
GET   /v1/orders/:orderId
POST  /v1/orders
PATCH /v1/orders/:orderId/status
```

### Guests

```text
GET   /v1/locations/:locationId/guests
GET   /v1/guests/:guestId
PATCH /v1/guests/:guestId
POST  /v1/guests/:guestId/phone-numbers
POST  /v1/guests/:guestId/delete-request
```

### Voice nodes

```text
POST /v1/voice-nodes/register
POST /v1/voice-nodes/:nodeId/heartbeat
POST /v1/voice-nodes/:nodeId/drain
POST /v1/voice-nodes/:nodeId/undrain
```

### Internal tools for Orchestrator

```text
POST /internal/tools/load-call-context
POST /internal/tools/lookup-menu
POST /internal/tools/create-order-draft
POST /internal/tools/submit-order
POST /internal/tools/transfer-call
POST /internal/tools/save-call-note
```

---

## 15. Pub/Sub Event Checklist

Use a common event envelope for all events.

```json
{
  "event_id": "uuid",
  "event_type": "order.created",
  "occurred_at": "2026-06-09T16:00:00Z",
  "tenant_id": "uuid",
  "location_id": "uuid",
  "correlation_id": "call_uuid_or_request_uuid",
  "payload": {}
}
```

Initial topics:

```text
call-events
order-events
notification-events
guest-events
billing-events
```

Initial event types:

```text
call.started
call.answered
call.transcript_turn.created
call.summary.requested
call.completed
call.failed
order.draft_started
order.created
order.status_changed
guest.created
guest.favorite_items_updated
notification.requested
notification.sent
notification.failed
```

---

## 16. First Vertical Slice

The first complete demo should be intentionally narrow.

### Demo scenario

A customer calls Mario's Pizza.

Brayz answers:

```text
Thanks for calling Mario's Pizza, this is Brayz. How can I help you?
```

Customer asks:

```text
What time do you close?
```

Brayz answers from configured location hours.

Customer asks:

```text
Can I talk to someone?
```

Brayz transfers the call to the configured escalation number.

After the call:

- Dashboard shows the call.
- Transcript is visible.
- Summary is visible.
- Transfer event is visible.

### What this proves

- PSTN path works.
- Siphon-AI works on Compute Engine.
- Orchestrator can process real-time audio.
- Brayz can load restaurant context.
- Brayz can speak back into the call.
- Call storage works.
- Dashboard works.
- Human escalation works.

---

## 17. Build Order

Recommended order:

1. Monorepo and local dev setup.
2. Database schema and migrations.
3. API health, auth, tenant/location CRUD.
4. Web admin shell.
5. Menu editor.
6. Terraform dev environment.
7. Cloud SQL, Redis, Pub/Sub, Storage.
8. Siphon-AI VM installation and systemd service.
9. Twilio SIP trunk to Siphon-AI.
10. Orchestrator WebSocket media endpoint.
11. Test audio loopback.
12. STT -> LLM -> TTS loop.
13. Call lifecycle storage.
14. Dashboard call history.
15. Receptionist tools.
16. Human transfer.
17. Call summaries and notifications.
18. Order-taking state machine.
19. Guest memory.
20. Production beta hardening.

---

## 18. Testing Strategy

### 18.1 Unit tests

Test:

- Menu matching.
- Modifier validation.
- Order price calculation.
- Tenant scoping helpers.
- Provider adapters.
- Prompt tool schemas.

### 18.2 Integration tests

Test:

- API + Cloud SQL.
- API + Redis.
- API + Pub/Sub emulator or dev topic.
- Orchestrator + fake Siphon-AI WebSocket client.
- Worker event handling.

### 18.3 Voice tests

Build a fake caller test harness that can:

- Open WebSocket session like Siphon-AI.
- Send sample PCM frames.
- Receive TTS frames.
- Send barge-in events.
- Validate control messages.

Also build real PSTN test scripts:

- Call answers.
- Audio is bidirectional.
- Barge-in works.
- Transfer works.
- Hangup works.
- Call record appears in dashboard.

### 18.4 Load tests

Load test separately:

- API requests.
- Orchestrator WebSocket sessions.
- Siphon-AI concurrent calls.
- Database connection pressure.
- Pub/Sub event volume.

Do not combine all load tests at first. Isolate bottlenecks.

---

## 19. Operational Runbooks to Write

Create runbooks early, even if they are simple.

Required runbooks:

```text
How to deploy API
How to deploy Orchestrator
How to deploy Siphon-AI node
How to rotate secrets
How to drain a Siphon-AI node
How to add a restaurant
How to add a Twilio number
How to troubleshoot one-way audio
How to troubleshoot failed transfers
How to restore Cloud SQL backup
How to disable AI ordering for a location
How to manually mark an order completed
```

---

## 20. Key Architecture Risks

### 20.1 Real-time audio latency

Risk:

- STT, LLM, and TTS chain may feel slow.

Mitigation:

- Stream everything.
- Track first-token and first-audio latency.
- Use concise prompts.
- Keep restaurant context compact.
- Cache menu context.
- Add provider fallback later.

### 20.2 Cloud Run WebSocket timeout

Risk:

- Cloud Run supports WebSockets, but WebSocket requests are still subject to request timeout limits.

Mitigation:

- Set Cloud Run timeout appropriately.
- Keep restaurant calls under expected max duration.
- Add reconnect/fallback handling.
- If long-running calls become a problem, move Orchestrator to Compute Engine, GKE, or another always-on service model.

### 20.3 SIP/RTP load balancing

Risk:

- SIP and RTP behavior through a load balancer can be tricky.

Mitigation:

- Start with direct static Siphon-AI node IPs.
- Add multiple Twilio origination URIs.
- Test NLB/MIG only after direct-node MVP works.
- Keep RTP port range fixed and observable.

### 20.4 Menu complexity

Risk:

- Restaurant menus can be messy and modifier-heavy.

Mitigation:

- Start with simple pickup menu.
- Add modifier groups carefully.
- Ask clarification instead of guessing.
- Add POS sync later.

### 20.5 Guest privacy

Risk:

- Remembering guests can feel creepy if handled poorly.

Mitigation:

- Start with phone-number memory.
- Avoid voice biometrics until later.
- Add opt-out/delete controls.
- Never reveal sensitive stored data without confirmation.

---

## 21. Definition of MVP Done

The MVP is done when a real restaurant can:

- Forward calls to Brayz.
- Have Brayz answer every call.
- Have Brayz answer basic questions.
- Have Brayz take a pickup order.
- Receive the order by dashboard and notification.
- View calls, transcripts, summaries, and orders.
- Transfer callers to staff when needed.
- Recognize repeat callers by phone number.
- Configure menu, hours, and escalation settings.

The MVP does not require:

- POS integration.
- Customer mobile app.
- Payments.
- Voice biometrics.
- Staff voice cloning.
- Complex loyalty.
- Delivery dispatch.

---

## 22. Immediate Next Build Tasks

Start with these concrete tasks:

```text
1. Create Brayz monorepo.
2. Add TypeScript, pnpm workspaces, linting, formatting.
3. Add packages/db with Prisma and first schema.
4. Add services/api with Fastify health endpoint.
5. Add apps/web with Next.js admin shell.
6. Add Terraform dev project skeleton.
7. Create Cloud SQL dev instance.
8. Add tenant/location/menu CRUD.
9. Create Siphon-AI VM install script and systemd unit.
10. Configure Twilio trunk to the Siphon-AI VM.
11. Build Orchestrator WebSocket endpoint.
12. Verify real call audio reaches Orchestrator.
13. Add test TTS playback into the call.
14. Store call records.
15. Display calls in dashboard.
```

After these are done, Brayz has a working technical spine.
