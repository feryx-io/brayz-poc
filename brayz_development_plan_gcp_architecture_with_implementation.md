# Brayz Development Plan

## Product Vision

Brayz is an AI-powered guest engagement platform for restaurants. It answers every call, takes orders, remembers guests, supports loyalty rewards, and creates a personalized restaurant experience using real-time voice AI.

**Core promise:** Every call gets answered. Every guest feels like a regular.

---

## 1. Product Modules

### Brayz Voice
AI phone answering and real-time voice conversation.

Features:
- Instant call answering
- Natural voice conversation
- Barge-in support
- Call transfer to staff
- Menu questions
- Hours/location questions
- Order taking
- Reservation handling
- Message taking
- Escalation to human staff

### Brayz Orders
Order capture and routing.

Features:
- Pickup orders
- Delivery orders
- Order confirmation
- Modifiers and substitutions
- Special instructions
- Upsells and add-ons
- Kitchen ticket output
- SMS/email order delivery for MVP
- POS integrations later

### Brayz Guests
Customer memory and guest profiles.

Features:
- Name recognition
- Phone number history
- Multiple phone numbers per guest
- Order history
- Favorite items
- Saved addresses
- Dietary preferences
- Customer notes
- Staff/persona affinity

### Brayz Rewards
Loyalty and personalized promotions.

Features:
- Points tracking
- VIP status
- Birthday rewards
- Favorite-item discounts
- Win-back campaigns
- Personalized offers
- Promotion rules engine

### Brayz Staff
Restaurant voice personas.

Features:
- Staff voice profiles
- Owner/manager/host voices
- Rotating staff personas
- Shift-based voices
- Customer affinity-based voice selection
- Voice consent management

### Brayz Insights
Restaurant analytics dashboard.

Features:
- Calls answered
- Missed calls prevented
- Orders captured
- Upsell revenue
- Loyalty redemptions
- Top guests
- Guest lifetime value
- Favorite menu items
- Call recordings and transcripts

---

## 2. User Web Page / Web App

The web app should serve two purposes:

1. Public-facing marketing site
2. Restaurant owner/admin portal

### Public Marketing Site

Pages:
- Home
- How It Works
- Features
- Pricing
- Demo
- Restaurant Use Cases
- About
- Contact
- Login

Homepage hero message:

> Brayz answers every restaurant call, remembers every guest, and helps turn first-time callers into regulars.

Primary CTA:

> Book a Demo

Secondary CTA:

> Hear Brayz in Action

Key homepage sections:
- Never miss another call
- AI order taking
- Guest memory
- Personalized rewards
- Familiar staff voices
- Restaurant dashboard
- Works with your existing phone number

### Restaurant Admin Portal

Core screens:

#### Dashboard
- Today's calls
- Active calls
- Orders captured
- Revenue captured
- Upsell revenue
- Loyalty redemptions
- Recent guests

#### Calls
- Call history
- Recordings
- Transcripts
- AI summaries
- Escalation notes

#### Orders
- New orders
- In-progress orders
- Completed orders
- Canceled orders
- Kitchen ticket view

#### Guests
- Guest profiles
- Order history
- Favorite items
- Saved addresses
- Loyalty points
- Notes
- Phone numbers
- Voice recognition status

#### Menu
- Menu items
- Prices
- Modifiers
- Availability
- Specials
- Upsell rules

#### Loyalty
- Reward rules
- VIP rules
- Promotions
- Birthday offers
- Win-back campaigns

#### Staff Voices
- Staff persona list
- Voice upload/onboarding
- Consent status
- Rotation rules
- Shift schedules

#### Settings
- Restaurant profile
- Hours
- Holiday hours
- Phone numbers
- Forwarding rules
- Escalation numbers
- Delivery zones
- Notification preferences
- Billing

---

## 3. Mobile Apps: iPhone and Android

Mobile should start as an owner/operator companion app, not a customer app.

### Restaurant Owner App

Primary use cases:
- New order alerts
- Call summaries
- Live call monitoring
- Push notifications
- Order approval
- Guest lookup
- Quick menu edits
- Specials/promotions
- Escalation handling

Screens:
- Dashboard
- Orders
- Active Calls
- Guests
- Promotions
- Notifications
- Settings

Important mobile features:
- Push notification for new order
- Push notification for escalated call
- Accept/reject order
- Mark order ready
- Call customer back
- Pause AI ordering
- Update item availability

### Future Customer App

Not needed for MVP.

Possible later features:
- Order history
- Loyalty points
- Favorite orders
- Saved addresses
- Push offers
- Reorder usual

Recommendation: Avoid building the customer app early. The phone call is the product advantage.

---

## 4. Recommended Tech Stack

### Core Voice Platform

- Siphon-AI for SIP-to-WebSocket voice bridge
- Rust for SIP/RTP/media components
- WebSocket protocol for AI media sessions
- 20 ms PCM audio frames
- VAD and barge-in support
- Call control API for transfer, hold, and escalation

### Backend API

Recommended stack:
- TypeScript + NestJS or Fastify
- PostgreSQL via Supabase or self-hosted Postgres
- Redis for sessions, queues, rate limits, and active call state
- BullMQ or Temporal for background workflows
- Object storage for recordings
- Stripe for billing

Alternative if you want to stay Python-heavy:
- FastAPI
- Celery/RQ
- Postgres/Supabase
- Redis

My recommendation: TypeScript backend for the Brayz SaaS layer, Rust for the real-time voice layer.

### Database

Postgres should be the system of record.

Use:
- Supabase for MVP speed
- Postgres RLS for tenant isolation
- pgvector for voice embeddings and customer matching
- Row-level tenant scoping everywhere

Core tables:
- tenants
- locations
- users
- staff_profiles
- staff_voice_profiles
- guests
- guest_phone_numbers
- guest_addresses
- guest_voiceprints
- orders
- order_items
- calls
- call_transcripts
- loyalty_accounts
- loyalty_events
- promotions
- menu_items
- menu_modifiers
- integrations

### Web Frontend

Recommended:
- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Supabase Auth or Clerk
- Stripe Billing Portal

### Mobile App

Recommended:
- React Native with Expo
- TypeScript
- Expo Router
- Native push notifications
- Supabase client or API-only access

Expo and Supabase are a good fit for quickly building authenticated cross-platform mobile apps.

### AI / Voice Providers

Provider-agnostic design is important.

Initial options:
- STT: Deepgram, OpenAI, AssemblyAI, Google Speech
- LLM: OpenAI, Anthropic, Google Gemini, local models later
- TTS: ElevenLabs, Cartesia, OpenAI, Deepgram
- Voice cloning: ElevenLabs, Cartesia, PlayAI, or licensed provider

Design this behind provider interfaces:

- SpeechToTextProvider
- LlmProvider
- TextToSpeechProvider
- VoiceCloneProvider
- EmbeddingProvider

### POS Integrations

MVP should not require POS integration.

Phase 1:
- Send orders by SMS
- Send orders by email
- Web dashboard ticket
- Printable kitchen ticket

Phase 2:
- Square Orders API
- Toast partner integration
- Clover integration

Square provides Orders APIs for itemized orders and commerce workflows. Toast has restaurant APIs, but access may require partner/custom integration approval, so it should not block the MVP.

---

## 5. MVP Scope

The MVP should prove that restaurants will pay for the core experience.

### MVP Goal

A restaurant forwards calls to Brayz. Brayz answers, takes pickup orders, remembers guests, and sends completed orders to the restaurant.

### MVP Features

Must-have:
- Restaurant signup/onboarding
- Restaurant profile
- Business hours
- Menu setup
- AI phone answering
- Pickup order taking
- Guest lookup by phone number
- Basic guest memory
- Order summary confirmation
- SMS/email order delivery
- Call recording
- Transcript storage
- Admin dashboard
- Human transfer/escalation

Nice-to-have:
- Loyalty points
- Personalized offers
- Staff voice personas
- Delivery address memory
- Mobile owner app

Avoid in MVP:
- Full POS integration
- Payments
- Complex delivery dispatch
- Customer mobile app
- Fully automated voice biometrics

---

## 6. Phased Roadmap

### Phase 0: Foundation

Build the Brayz SaaS foundation.

Deliverables:
- Brand and landing page
- Auth
- Tenant/location model
- Restaurant profile
- Menu management
- Basic dashboard
- Siphon-AI integration
- Call event storage

### Phase 1: AI Receptionist MVP

Deliverables:
- Inbound call answering
- Hours/location/menu questions
- Message taking
- Human transfer
- Call transcripts
- Call recordings
- Restaurant notifications

### Phase 2: Order Taking

Deliverables:
- Menu-aware order capture
- Item modifiers
- Order confirmation
- Kitchen ticket view
- SMS/email order delivery
- Order status management
- Owner push notifications

### Phase 3: Guest Memory

Deliverables:
- Guest profile creation
- Phone number matching
- Order history
- Favorite items
- Saved addresses
- Repeat-customer greetings
- “Would you like your usual?” flow

### Phase 4: Loyalty & Promotions

Deliverables:
- Points engine
- VIP rules
- Personalized rewards
- Win-back campaigns
- Birthday rewards
- Promotion analytics

### Phase 5: Staff Voices

Deliverables:
- Staff persona management
- Voice consent tracking
- Voice cloning workflow
- Rotating staff voices
- Shift-based voice rules
- Guest affinity voice routing

### Phase 6: Mobile Apps

Deliverables:
- iOS owner app
- Android owner app
- Push notifications
- Active calls
- Orders
- Guest lookup
- Quick menu changes
- Promotion controls

### Phase 7: Integrations

Deliverables:
- Square integration
- Toast partner integration
- Clover integration
- Stripe billing
- CRM/export tools

---

## 7. Architecture Overview

```text
Caller
  ↓
Restaurant Phone Number / SIP Trunk
  ↓
Siphon-AI Voice Gateway
  ↓
Brayz Conversation Orchestrator
  ↓
AI Providers
  ↓
Brayz Backend API
  ↓
Postgres / Redis / Object Storage
  ↓
Restaurant Dashboard + Mobile App
```

### Real-Time Call Flow

```text
Incoming SIP call
  ↓
Siphon-AI answers
  ↓
Audio streamed to AI session
  ↓
Caller ID lookup
  ↓
Guest memory loaded
  ↓
Restaurant context loaded
  ↓
AI handles conversation
  ↓
Tools called as needed:
    - lookup menu
    - create order
    - apply promotion
    - transfer call
    - save guest memory
  ↓
Order/call summary stored
  ↓
Restaurant notified
```

---

## 8. Multi-Tenant Design

Every object should be scoped by tenant_id and location_id.

Important entities:
- Tenant = restaurant group/business
- Location = physical restaurant
- User = owner/manager/staff login
- Guest = customer
- Call = phone interaction
- Order = restaurant order
- Menu = location-specific menu
- Promotion = tenant or location campaign
- Staff Persona = approved voice/personality profile

Rules:
- Never share guest memory across restaurants by default
- Guest profile is scoped to tenant/location
- Phone number uniqueness should be tenant-scoped
- Voiceprints require explicit consent
- Staff voice cloning requires explicit staff consent

---

## 9. Privacy and Safety

Important safeguards:
- Guest memory opt-out
- Voice recognition opt-in
- Staff voice cloning consent
- Ability to delete guest profile
- Ability to delete staff voice
- Call recording disclosure where required
- Audit logs for profile access
- No sensitive data exposed from voice match alone

Voice recognition rule:

> Never reveal address, order history, or loyalty data based only on a voice match. Confirm identity first.

Example:

> “I may recognize your voice. Is this Mike?”

Then:

> “Great. Can you confirm the street number on your usual delivery address?”

---

## 10. Initial Pricing Ideas

### Starter
$99/month per location
- AI receptionist
- Basic call answering
- Call summaries
- Limited calls

### Growth
$249/month per location
- AI order taking
- Guest memory
- Loyalty basics
- Higher call volume

### Pro
$499/month per location
- Staff voices
- Personalized promotions
- Advanced analytics
- Integrations

### Usage-Based Add-ons
- Voice cloning
- High call volume
- SMS messages
- POS integration
- Additional locations

---

## 11. First Build Priorities

Immediate next steps:

1. Create Brayz landing page
2. Build restaurant admin portal shell
3. Define database schema
4. Add tenant/location/user model
5. Build menu editor
6. Connect Siphon-AI call events to backend
7. Build AI receptionist prompt and tool layer
8. Store calls, transcripts, and recordings
9. Add basic order taking
10. Deliver order by SMS/email/dashboard

---

## 12. Suggested Repo Structure

```text
brayz/
  apps/
    web/              # Next.js marketing + admin portal
    mobile/           # Expo React Native app
    api/              # Backend API
  services/
    voice-gateway/    # Siphon-AI integration / Rust service
    worker/           # Background jobs
    ai-orchestrator/  # Conversation tools and prompts
  packages/
    db/               # Database schema and migrations
    shared/           # Shared types
    ui/               # Shared UI components
    sdk/              # Internal client SDK
  infra/
    docker/
    terraform/
    k8s/
  docs/
```

---

## 13. Recommended MVP Demo Script

Customer calls Mario's Pizza.

Brayz answers:

> “Thanks for calling Mario’s Pizza, this is Tony. How can I help you?”

Customer:

> “I want to place an order.”

Brayz:

> “Absolutely. Is this for pickup or delivery?”

Customer orders pizza, wings, and garlic knots.

Brayz:

> “Perfect. I have one large pepperoni pizza, one order of medium wings, and garlic knots. Your total is $32.50. Would you like to add a two-liter soda for $3.99?”

Customer accepts.

Brayz:

> “Great. That will be ready for pickup in about 25 minutes. I’ll send the order to the kitchen now.”

Restaurant receives order instantly.

Next time customer calls:

> “Welcome back Mike. Last time you ordered garlic knots and wings. Would you like your usual today?”

---

## 14. GCP-First Architecture Direction

This section expands the initial development plan into a concrete GCP deployment architecture for Brayz.

### Core Architecture Decisions

| Area | Decision | Reason |
|---|---|---|
| Cloud provider | Google Cloud Platform | Strong managed database, networking, Pub/Sub, observability, storage, IAM, and Cloud Run support. |
| PSTN provider | Twilio Elastic SIP Trunking for MVP | Fast path to phone numbers, SIP trunking, call routing, and carrier-grade PSTN connectivity. |
| Carrier strategy | Provider-agnostic carrier abstraction | Start with Twilio, but avoid hard-coding Twilio into the product model so Telnyx, SignalWire, Bandwidth, or direct SIP can be added later. |
| Voice gateway | Siphon-AI on GCP Compute Engine instances, not Docker | Real-time SIP/RTP workloads benefit from predictable networking, static ports, low jitter, direct systemd control, and simpler packet-level troubleshooting. |
| Backend/API | Cloud Run for SaaS APIs and worker endpoints | Good fit for stateless HTTP APIs, webhooks, workers, admin backend, and autoscaling. |
| Database | Cloud SQL for PostgreSQL | Managed Postgres keeps the MVP simple while still supporting production HA, backups, read replicas, and extensions such as pgvector. |
| Cache / active call state | Memorystore for Redis or Valkey | Fast ephemeral state for active calls, locks, sessions, rate limits, and real-time coordination. |
| Events | Pub/Sub | Decouples call events, order events, transcript jobs, notification jobs, analytics, and integrations. |
| Recordings / audio assets | Cloud Storage | Durable storage for recordings, generated prompts, staff voice samples, exported reports, and order ticket PDFs. |
| Secrets | Secret Manager | Store API keys, DB credentials, Twilio auth tokens, AI provider keys, signing keys, and webhook secrets. |
| Infrastructure | Terraform | Repeatable dev/staging/prod environments and safer production changes. |

### Recommended Initial Region

For a Northeast-heavy restaurant customer base, start in:

```text
Primary GCP region: us-east4
Reason: good East Coast latency and strong fit for New York / Northeast restaurants.
```

Alternative:

```text
us-central1
Reason: broad GCP service coverage and central US placement.
```

For the MVP, choose one primary region and stay disciplined. Multi-region active-active is not necessary at first. The near-term goal should be stable single-region HA with clean backups, observability, and predictable failover.

---

## 15. Target GCP Service Map

```text
Internet / Browser / Mobile
  ↓
Cloud Load Balancing / Firebase Hosting / Cloud Run domain mapping
  ↓
Next.js Web App / Admin Portal
  ↓
Brayz API Services on Cloud Run
  ↓
Cloud SQL PostgreSQL
Memorystore Redis/Valkey
Pub/Sub
Cloud Storage
Secret Manager

PSTN Caller
  ↓
Twilio Elastic SIP Trunking
  ↓
Public static IPs / optional Network Load Balancer
  ↓
Siphon-AI Compute Engine Nodes
  ↓ WebSocket / gRPC / HTTPS internal API
Conversation Orchestrator
  ↓
STT / LLM / TTS Providers
  ↓
Brayz Tool API + Postgres + Redis + Pub/Sub
```

### Service-by-Service Responsibility

| Component | GCP Service | Responsibility |
|---|---|---|
| Marketing site | Cloud Run, Firebase Hosting, or Cloud Storage + CDN | Public Brayz website. |
| Admin portal | Cloud Run-hosted Next.js | Restaurant dashboard, order management, menu editor, call history. |
| Backend API | Cloud Run | Tenant/location/user APIs, order APIs, menu APIs, guest APIs, carrier config, billing. |
| Conversation Orchestrator | Cloud Run initially; Compute/GKE later if needed | Real-time AI session manager, prompt runtime, tool calling, STT/LLM/TTS coordination. |
| Siphon-AI | Compute Engine | SIP signaling, RTP media, VAD/barge-in, 20 ms PCM WebSocket streaming. |
| PostgreSQL | Cloud SQL for PostgreSQL | System of record. |
| Redis/Valkey | Memorystore | Active calls, session state, locks, dedupe keys, rate limits. |
| Events | Pub/Sub | Durable async event bus. |
| Jobs | Cloud Run jobs / Pub/Sub push handlers / Cloud Tasks | Transcription post-processing, notifications, analytics, exports. |
| Object storage | Cloud Storage | Recordings, transcripts, staff voice assets, generated prompts, reports. |
| Secrets | Secret Manager | API keys, DB credentials, SIP secrets, carrier credentials. |
| Logging/metrics | Cloud Logging, Cloud Monitoring, Error Reporting, Trace | Observability and alerting. |
| IaC | Terraform | Network, IAM, Cloud SQL, Cloud Run, Compute, Pub/Sub, Storage, DNS. |

---

## 16. Voice and PSTN Architecture

### MVP Voice Path

```text
Customer phone
  ↓ PSTN
Twilio phone number
  ↓ Twilio Elastic SIP Trunking origination
Siphon-AI node public IP / SIP URI
  ↓
SIP INVITE accepted by Siphon-AI
  ↓
RTP audio terminates on Siphon-AI
  ↓
20 ms PCM frames over WebSocket
  ↓
Brayz Conversation Orchestrator
  ↓
STT → LLM/tool calls → TTS
  ↓
20 ms PCM frames back to Siphon-AI
  ↓
RTP audio back to caller
```

### Twilio Trunking Model

For MVP:

- Buy or port one Twilio number per test restaurant.
- Attach the number to a Twilio Elastic SIP Trunk.
- Configure Twilio Origination URIs pointing to Brayz Siphon-AI ingress targets.
- Start with IP ACL-based trunk security.
- Add SIP digest authentication and TLS/SRTP once the baseline is stable.
- Store Twilio call identifiers alongside Brayz internal call IDs.

### Twilio Origination Target Options

#### Option A: Direct-to-Node Static IPs

```text
Twilio Origination URI 1 → sip:brayz-gw-1.example.com
Twilio Origination URI 2 → sip:brayz-gw-2.example.com
```

Use this for MVP because it is simple and debuggable.

Benefits:
- Easy packet captures.
- Easy sngrep troubleshooting.
- No ambiguity about which node owns the call.
- Twilio can fail over between targets.

Tradeoffs:
- Node health and failover behavior must be tested carefully.
- Scaling is more manual at first.

#### Option B: External Passthrough Network Load Balancer

```text
Twilio → Regional external passthrough NLB → Siphon-AI MIG
```

Use this after the MVP when call volume increases.

Benefits:
- One ingress IP per region.
- Better VM pool abstraction.
- Easier to add/remove gateway nodes.

Tradeoffs:
- SIP/RTP statefulness must be carefully tested.
- Requires strict session affinity behavior.
- RTP advertised media address must be consistent with the node actually handling the call.
- Debugging is harder than direct-to-node.

### Recommended MVP Choice

Start with **direct-to-node static IPs** and Twilio multiple origination URIs. Revisit an external passthrough Network Load Balancer after Brayz has stable traffic, clear SIP/RTP metrics, and a tested call-draining process.

---

## 17. Siphon-AI Compute Node Design

Siphon-AI should run directly on Compute Engine instances as a native Linux service.

### VM Design

```text
siphon-ai-gw-1
  OS: Ubuntu LTS or Debian stable
  Runtime: native Rust binary
  Process manager: systemd
  Network: public static IP + private VPC IP
  SIP: UDP/TCP 5060 initially, TLS 5061 later
  RTP: fixed UDP port range, example 20000-30000
  Health: local HTTP health endpoint
  Logs: journald + Cloud Ops Agent
```

### Why Compute Engine Instead of Docker for Siphon-AI

Real-time media nodes are different from normal web services. For Brayz, Compute Engine gives better control over:

- UDP SIP/RTP port ranges.
- Static public IPs.
- Packet captures with tcpdump and sngrep.
- Kernel/network tuning.
- RTP jitter troubleshooting.
- CPU pinning or machine tuning later.
- systemd service lifecycle.
- Predictable deployment without container networking surprises.

### Recommended Instance Shape for MVP

Start small and benchmark:

```text
Machine family: C3, C4, N2, or E2 depending on cost/performance testing
Initial test size: 2 vCPU / 4-8 GB RAM
Initial production minimum: 2 nodes
Disk: small balanced persistent disk
Network: public static IP per node
OS: Debian or Ubuntu LTS
```

The exact call capacity should be measured with a SIP/RTP load test. Do not guess the final calls-per-node number early.

### Node Software Layout

```text
/opt/brayz/siphon-ai/
  siphon-ai                  # Rust binary
  config.toml                # non-secret runtime config
  env                        # environment file with Secret Manager references only
  certs/                     # TLS certs later
  logs/                      # optional local logs if needed

/etc/systemd/system/siphon-ai.service
/etc/brayz/siphon-ai.toml
```

### systemd Unit

```ini
[Unit]
Description=Brayz Siphon-AI Voice Gateway
After=network-online.target
Wants=network-online.target

[Service]
User=brayz
Group=brayz
WorkingDirectory=/opt/brayz/siphon-ai
EnvironmentFile=/etc/brayz/siphon-ai.env
ExecStart=/opt/brayz/siphon-ai/siphon-ai --config /etc/brayz/siphon-ai.toml
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

### Node Config Example

```toml
[node]
node_id = "gw-us-east4-a-001"
region = "us-east4"
zone = "us-east4-a"
public_ip = "STATIC_PUBLIC_IP"
private_ip = "PRIVATE_VPC_IP"

[sip]
listen_udp = "0.0.0.0:5060"
listen_tcp = "0.0.0.0:5060"
external_sip_host = "sip-gw-1.brayz.ai"
allowed_carrier_cidrs = ["TWILIO_IP_RANGE_PLACEHOLDER"]

[rtp]
listen_ip = "0.0.0.0"
advertised_ip = "STATIC_PUBLIC_IP"
port_min = 20000
port_max = 30000
frame_ms = 20
encoding = "pcm16le"

[orchestrator]
ws_url = "wss://orchestrator.internal.brayz.ai/v1/media"
connect_timeout_ms = 500
session_timeout_seconds = 7200

[events]
publish_call_events = true
backend_url = "https://api.internal.brayz.ai"
```

### Deployment Approach

1. Build a release binary in CI.
2. Store the binary artifact in Cloud Storage or Artifact Registry.
3. Use Terraform to create instance templates.
4. Use a startup script to install the binary, config, Ops Agent, and systemd unit.
5. Deploy using a Managed Instance Group only when ready for rolling updates.
6. For the earliest MVP, two standalone VMs are acceptable if that speeds up iteration.

### Gateway Health Checks

Expose a local HTTP endpoint, separate from SIP/RTP:

```text
GET /health/live
GET /health/ready
GET /metrics
```

Health should verify:

- Process is running.
- SIP listener is bound.
- RTP port allocator is available.
- Orchestrator connectivity is healthy.
- Redis connectivity is healthy if used by gateway.
- Node is not in draining mode.

### Draining Calls Before Deploy

Siphon-AI needs a graceful drain mode.

```text
1. Mark node as draining.
2. Stop accepting new INVITEs.
3. Continue existing calls.
4. Wait for active_calls = 0 or max drain timeout.
5. Restart or replace node.
```

Add an admin endpoint:

```text
POST /admin/drain
POST /admin/undrain
GET /admin/active-calls
```

---

## 18. Conversation Orchestrator Architecture

The Conversation Orchestrator is the real-time brain of Brayz. Siphon-AI should stay focused on SIP/RTP/media. The orchestrator should handle AI session logic, guest context, menu tools, order tools, loyalty tools, and provider integrations.

### Responsibilities

- Accept WebSocket media sessions from Siphon-AI.
- Receive `start`, `audio`, `vad`, `barge_in`, `dtmf`, and `call_state` events.
- Stream caller audio to STT.
- Maintain conversation state.
- Call LLM with restaurant-specific prompt and tool definitions.
- Stream TTS audio back to Siphon-AI.
- Trigger barge-in stop events.
- Call Brayz tools: menu lookup, create order, lookup guest, apply promotion, transfer call.
- Publish call events to Pub/Sub.
- Persist transcripts, summaries, and outcomes.

### Runtime Choice

Use Cloud Run for MVP if WebSocket performance is acceptable.

```text
Siphon-AI → WebSocket → Cloud Run Conversation Orchestrator
```

Reasons:
- Faster deployment.
- Autoscaling.
- Easy secret injection.
- Simple HTTPS endpoints.
- No server management for the AI logic.

Move to Compute Engine or GKE only if:

- WebSocket session duration becomes a Cloud Run constraint.
- You need more predictable real-time scheduling.
- You want colocated media + orchestrator processes.
- You need custom networking or lower jitter.
- Cost at scale is better on reserved instances.

### Orchestrator Internal Modules

```text
orchestrator/
  sessions/          # active call session state
  media/             # frame handling, pacing, codec assumptions
  stt/               # provider adapters
  llm/               # provider adapters
  tts/               # provider adapters
  tools/             # menu/order/guest/loyalty/call-control tools
  prompts/           # restaurant-specific prompt templates
  policies/          # safety, escalation, order confirmation rules
  events/            # Pub/Sub publishing
  memory/            # guest memory load/save
```

### Session Lifecycle

```text
Siphon-AI sends start event
  ↓
Orchestrator creates session
  ↓
Load restaurant by dialed number / trunk / location_id
  ↓
Lookup guest by caller ID
  ↓
Load menu, hours, specials, promotions
  ↓
Start STT stream
  ↓
Start LLM conversation loop
  ↓
Stream TTS frames back
  ↓
Persist transcript and events
  ↓
On hangup: summarize, classify, create follow-up jobs
```

### Real-Time Event Contract

Initial WebSocket message:

```json
{
  "type": "start",
  "call_id": "call_123",
  "node_id": "gw-us-east4-a-001",
  "tenant_id": "tenant_123",
  "location_id": "loc_123",
  "from_number": "+15185550123",
  "to_number": "+15185550999",
  "provider": "twilio",
  "provider_call_id": "CAxxxx",
  "audio": {
    "encoding": "pcm16le",
    "sample_rate": 8000,
    "frame_ms": 20,
    "channels": 1
  }
}
```

Barge-in event:

```json
{
  "type": "barge_in",
  "call_id": "call_123",
  "timestamp_ms": 18420,
  "reason": "caller_speech_detected"
}
```

Tool result event:

```json
{
  "type": "tool_result",
  "call_id": "call_123",
  "tool": "create_order",
  "status": "success",
  "order_id": "ord_123"
}
```

---

## 19. Backend API Architecture

The Backend API is the SaaS control plane for Brayz.

### Recommended Backend Stack

```text
Language: TypeScript
Framework: NestJS or Fastify
Runtime: Cloud Run
Database: Cloud SQL PostgreSQL
Cache: Memorystore Redis/Valkey
Queue/Event bus: Pub/Sub
Auth: Clerk, Auth0, Firebase Auth, or custom JWT
Billing: Stripe
```

NestJS is a good fit if you want strong structure and clear modules. Fastify is a good fit if you want lighter weight and high performance.

### Backend Services

```text
api/
  auth-service
  tenant-service
  location-service
  menu-service
  guest-service
  order-service
  call-service
  loyalty-service
  promotion-service
  staff-voice-service
  carrier-service
  notification-service
  billing-service
  integration-service
```

For MVP, these can be modules inside one API service. Split into separate services later only when there is a clear operational reason.

### API Boundaries

| API Area | Purpose |
|---|---|
| `/v1/tenants` | Restaurant groups/businesses. |
| `/v1/locations` | Individual restaurant locations. |
| `/v1/menu` | Menu items, modifiers, availability, specials. |
| `/v1/guests` | Guest profiles, phone numbers, preferences, memory. |
| `/v1/orders` | Create, confirm, update, cancel, and route orders. |
| `/v1/calls` | Call records, transcripts, recordings, summaries. |
| `/v1/loyalty` | Points, redemptions, VIP status, promotions. |
| `/v1/staff-voices` | Staff personas, consent, voice assets. |
| `/v1/carriers` | Twilio and future PSTN/SIP provider configuration. |
| `/v1/webhooks/twilio` | Twilio status callbacks and provisioning callbacks. |
| `/v1/internal/tools` | Internal AI tool execution endpoints. |
| `/v1/internal/call-control` | Transfer, hold, hangup, whisper/barge later. |

### Internal Tool API

The orchestrator should not talk directly to every database table. It should call a stable internal tool API.

```text
lookup_guest(from_number, tenant_id, location_id)
lookup_menu_item(query, location_id)
check_item_availability(menu_item_id)
price_order(order_draft)
create_order(order_draft)
apply_promotion(order_id, promotion_code or rule)
send_order_to_restaurant(order_id)
transfer_call(call_id, target)
save_guest_memory(guest_id, memory_event)
```

This makes the AI layer easier to test and keeps business rules out of the prompt.

---

## 20. Database Architecture: Cloud SQL PostgreSQL

Cloud SQL for PostgreSQL is a solid default for Brayz because Postgres should be the system of record and Cloud SQL keeps operations manageable.

### Recommendation

Use Cloud SQL PostgreSQL with:

- HA regional instance for production.
- Automated backups.
- Point-in-time recovery.
- Private IP connectivity from Cloud Run and Compute Engine.
- Read replica later for analytics/reporting.
- pgvector extension for menu search, guest preference embeddings, and future similarity search.
- Strict tenant/location scoping.
- Monthly partitioning for high-volume event tables.

### Cloud SQL vs Alternatives

| Option | Use When | Notes |
|---|---|---|
| Cloud SQL PostgreSQL | MVP through early production | Best balance of managed ops, Postgres compatibility, cost, and simplicity. |
| AlloyDB for PostgreSQL | Later, if higher write volume or vector/search performance becomes a bottleneck | More advanced managed Postgres-compatible option, but likely unnecessary for MVP. |
| Self-managed Postgres on Compute | Only if you need deep DB control | More operational burden. Not recommended for MVP. |
| Supabase | Great for speed, but less aligned with all-GCP production | Useful for prototypes, but Cloud SQL keeps Brayz cleaner inside GCP. |

### Database Role Separation

```text
brayz_app_rw        # API write/read role
brayz_app_ro        # dashboard read-only where possible
brayz_worker_rw     # background workers
brayz_gateway_rw    # only if gateway needs direct DB access; prefer API instead
brayz_migration     # schema migrations only
brayz_analytics_ro  # reporting/export access
```

### Connection Pooling

Use connection pooling from day one.

Options:

- Application-level pooling in the API.
- PgBouncer on Compute or Cloud Run sidecar pattern if needed.
- Cloud SQL connectors for secure connectivity.
- Keep direct DB access out of Siphon-AI unless absolutely needed.

### Core Schema Additions

The existing plan already includes core product tables. Add these platform tables to support carrier abstraction, GCP operations, and real-time call routing.

```sql
-- Carrier abstraction
carriers
carrier_accounts
carrier_numbers
carrier_trunks
carrier_origination_targets
carrier_events

-- Voice gateway inventory
voice_gateway_nodes
voice_gateway_node_events
voice_gateway_drains

-- Real-time call tracking
calls
call_legs
call_events
call_media_sessions
call_transcript_segments
call_recordings
call_summaries

-- AI runtime
ai_sessions
ai_messages
ai_tool_calls
ai_provider_usage
ai_prompt_versions

-- Ordering runtime
order_drafts
orders
order_items
order_status_events
order_delivery_attempts

-- Notifications
notification_destinations
notification_events
sms_messages
email_messages
push_notifications

-- Audit and compliance
audit_log
consent_records
data_deletion_requests
recording_disclosures
```

### Call Table Example

```sql
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  location_id UUID NOT NULL,
  carrier_id UUID NOT NULL,
  carrier_account_id UUID,
  provider TEXT NOT NULL,
  provider_call_id TEXT,
  from_number TEXT,
  to_number TEXT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  guest_id UUID,
  order_id UUID,
  voice_gateway_node_id UUID,
  recording_url TEXT,
  transcript_status TEXT,
  summary_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calls_tenant_started_at ON calls (tenant_id, started_at DESC);
CREATE INDEX idx_calls_location_started_at ON calls (location_id, started_at DESC);
CREATE INDEX idx_calls_provider_call_id ON calls (provider, provider_call_id);
```

### Call Events Table Example

```sql
CREATE TABLE call_events (
  id BIGSERIAL PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES calls(id),
  tenant_id UUID NOT NULL,
  location_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_source TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_events_call_id ON call_events (call_id, occurred_at);
CREATE INDEX idx_call_events_tenant_time ON call_events (tenant_id, occurred_at DESC);
```

### Guest Memory Model

Keep guest memory scoped to a restaurant tenant/location.

```text
guest
  ↓
guest_phone_numbers
  ↓
guest_orders
  ↓
guest_preferences
  ↓
guest_memory_events
```

Rules:

- Phone number match is the MVP identity signal.
- Voice recognition is later and opt-in.
- Never expose sensitive guest data based only on voice recognition.
- Guest memory should be editable and deletable from the dashboard.
- Guest memory should include source and confidence.

Example memory event:

```json
{
  "type": "favorite_item_detected",
  "source": "order_history",
  "confidence": 0.92,
  "value": {
    "item": "garlic knots",
    "modifier": "extra marinara"
  }
}
```

---

## 21. Redis / Memorystore Architecture

Postgres is the source of truth. Redis/Valkey is for fast ephemeral coordination.

### Use Redis For

- Active call state.
- Call locks.
- Idempotency keys.
- WebSocket session routing hints.
- Short-lived guest context cache.
- Menu cache.
- Rate limiting.
- Dedupe of carrier callbacks.
- Gateway node heartbeats.
- Temporary order drafts during a live call.

### Do Not Use Redis For

- Permanent guest memory.
- Permanent order history.
- Final call records.
- Billing records.
- Consent records.
- Audit logs.

### Key Examples

```text
active_call:{call_id}
call_lock:{call_id}
provider_event_dedupe:{provider}:{event_id}
gateway_heartbeat:{node_id}
location_menu_cache:{location_id}
order_draft:{call_id}
rate_limit:{tenant_id}:{operation}
```

### Active Call State Example

```json
{
  "call_id": "call_123",
  "tenant_id": "tenant_123",
  "location_id": "loc_123",
  "node_id": "gw-us-east4-a-001",
  "provider": "twilio",
  "provider_call_id": "CAxxxx",
  "status": "in_conversation",
  "started_at": "2026-06-09T15:00:00Z",
  "last_audio_at": "2026-06-09T15:00:22Z",
  "current_order_draft_id": "draft_123"
}
```

---

## 22. Event-Driven Architecture

Use Pub/Sub to decouple real-time call handling from slower downstream work.

### Topics

```text
call.started
call.answered
call.ended
call.failed
call.transcript.segment.created
call.recording.created
call.summary.requested
call.summary.completed
order.draft.created
order.confirmed
order.sent_to_restaurant
order.failed_delivery
notification.requested
notification.sent
guest.memory.updated
loyalty.event.created
analytics.event.created
carrier.event.received
```

### Event Envelope

```json
{
  "event_id": "evt_123",
  "event_type": "order.confirmed",
  "tenant_id": "tenant_123",
  "location_id": "loc_123",
  "call_id": "call_123",
  "occurred_at": "2026-06-09T15:04:11Z",
  "source": "conversation-orchestrator",
  "schema_version": "1.0",
  "data": {
    "order_id": "ord_123",
    "total_cents": 3250
  }
}
```

### Worker Pattern

```text
Pub/Sub topic
  ↓
Cloud Run push endpoint or pull worker
  ↓
Idempotency check
  ↓
Process job
  ↓
Update Postgres
  ↓
Emit next event if needed
```

Every worker should be idempotent. Pub/Sub delivery can retry, so the database should enforce uniqueness for external event IDs and job IDs.

### Good Async Jobs

- Generate call summary.
- Run transcript cleanup.
- Extract guest memory.
- Send SMS/email order ticket.
- Send owner push notification.
- Update analytics aggregates.
- Export call data.
- Sync with POS integration.

---

## 23. Carrier Abstraction Design

Do not make Twilio the product model. Twilio should be the first implementation of a generic carrier interface.

### Carrier Interface

```ts
interface CarrierProvider {
  providerName: 'twilio' | 'telnyx' | 'signalwire' | 'bandwidth' | 'generic_sip';

  normalizeInboundCall(event: unknown): NormalizedCarrierCallEvent;
  normalizeStatusCallback(event: unknown): NormalizedCarrierStatusEvent;

  createNumber?(request: NumberPurchaseRequest): Promise<CarrierNumber>;
  releaseNumber?(numberId: string): Promise<void>;
  configureOrigination?(numberId: string, targets: SipTarget[]): Promise<void>;

  sendSms?(request: SmsRequest): Promise<SmsResult>;
  placeOutboundCall?(request: OutboundCallRequest): Promise<OutboundCallResult>;
}
```

### Normalized Carrier Call Event

```json
{
  "provider": "twilio",
  "provider_call_id": "CAxxxx",
  "direction": "inbound",
  "from_number": "+15185550123",
  "to_number": "+15185550999",
  "sip_trunk_id": "twilio_trunk_123",
  "received_at": "2026-06-09T15:00:00Z",
  "raw": {}
}
```

### Database Carrier Tables

```sql
CREATE TABLE carriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE carrier_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  carrier_id UUID NOT NULL REFERENCES carriers(id),
  display_name TEXT NOT NULL,
  credentials_secret_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE carrier_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  location_id UUID NOT NULL,
  carrier_id UUID NOT NULL REFERENCES carriers(id),
  carrier_account_id UUID NOT NULL REFERENCES carrier_accounts(id),
  phone_number TEXT NOT NULL,
  provider_number_id TEXT,
  routing_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (carrier_id, phone_number)
);
```

### Why This Matters

Later you can add:

- Telnyx as a cheaper SIP carrier.
- SignalWire for programmable telecom workflows.
- Bandwidth for more direct carrier relationships.
- Direct SIP trunking for larger restaurant groups.
- BYOC where a customer points an existing carrier trunk to Brayz.

The AI/order/guest product should not care which carrier delivered the call.

---

## 24. Network Architecture

### VPC Layout

```text
brayz-prod-vpc
  subnets:
    prod-app-us-east4       # Cloud Run VPC connector / API egress
    prod-voice-us-east4     # Siphon-AI Compute Engine nodes
    prod-data-us-east4      # Private services / Cloud SQL private IP
```

### Public Ingress

| Traffic | Ingress Path |
|---|---|
| Public web | HTTPS load balancer / Cloud Run domain mapping |
| Admin portal | HTTPS only |
| API | HTTPS only |
| Twilio SIP | UDP/TCP 5060 to Siphon-AI public IPs initially |
| RTP | UDP fixed port range to Siphon-AI public IPs |
| Webhooks | HTTPS to Cloud Run `/webhooks/*` |

### Private Traffic

| Source | Destination | Protocol |
|---|---|---|
| Siphon-AI | Orchestrator | WSS/HTTPS over private or public internal endpoint |
| Orchestrator | API tool endpoints | HTTPS/gRPC internal |
| API | Cloud SQL | Private IP |
| API/Orchestrator | Redis | Private IP |
| Workers | Cloud SQL / Redis / Storage | Private IP where supported |

### Firewall Rules

MVP firewall rules:

```text
allow-twilio-sip-udp-5060
allow-twilio-sip-tcp-5060
allow-twilio-rtp-udp-20000-30000
allow-health-checks-http
allow-iap-ssh
allow-internal-vpc
```

Avoid open SSH. Use IAP tunneling or OS Login.

### SIP/RTP Security Progression

Phase 1:
- IP allowlisting for Twilio SIP/RTP ranges.
- Strong random SIP trunk credentials where supported.
- Separate public IPs for voice gateways only.
- Detailed logging and alerting.

Phase 2:
- SIP TLS on 5061.
- SRTP where provider support and Siphon-AI support are ready.
- mTLS for Siphon-AI to Orchestrator/API.
- Automated certificate renewal.

Phase 3:
- Per-carrier ingress pools.
- Regional voice pools.
- WAF/Cloud Armor for HTTPS surfaces.
- Dedicated private connectivity options for large customers.

---

## 25. Security, IAM, and Secrets

### Service Accounts

Use one service account per major runtime.

```text
brayz-api-sa
brayz-orchestrator-sa
brayz-worker-sa
brayz-siphon-gateway-sa
brayz-ci-deploy-sa
brayz-migration-sa
```

### Secret Manager Naming

```text
prod/twilio/account-sid
prod/twilio/auth-token
prod/openai/api-key
prod/deepgram/api-key
prod/elevenlabs/api-key
prod/postgres/app-password
prod/stripe/api-key
prod/webhook/signing-secret
prod/siphon/node-shared-secret
```

### Data Protection Rules

- Encrypt recordings at rest with Cloud Storage default encryption or CMEK later.
- Keep staff voice samples in private buckets.
- Do not expose direct Cloud Storage URLs to restaurant users.
- Use signed URLs or short-lived API proxy downloads.
- Store consent records for voice cloning and call recording policies.
- Keep raw carrier webhook payloads but restrict access.
- Redact payment card data and avoid storing card numbers entirely.

### Admin Audit Events

Track:

- Guest profile viewed.
- Guest profile updated.
- Guest deleted.
- Staff voice uploaded.
- Staff voice consent approved/revoked.
- Recording played/downloaded.
- Promotion created.
- Menu price changed.
- Carrier number routing changed.
- User role changed.

---

## 26. Observability Architecture

Brayz needs both SaaS observability and telecom observability.

### Key Metrics

#### Voice Gateway Metrics

```text
active_calls
calls_started_total
calls_answered_total
calls_failed_total
sip_invites_total
sip_4xx_total
sip_5xx_total
rtp_packets_in_total
rtp_packets_out_total
rtp_packet_loss_estimate
jitter_ms
vad_events_total
barge_in_events_total
orchestrator_ws_connect_failures_total
```

#### AI Metrics

```text
stt_latency_ms
llm_first_token_latency_ms
tts_first_audio_latency_ms
end_to_end_response_latency_ms
barge_in_to_stop_audio_ms
ai_provider_errors_total
ai_provider_cost_cents
conversation_turns_per_call
```

#### Product Metrics

```text
orders_created_total
orders_confirmed_total
orders_canceled_total
upsells_offered_total
upsells_accepted_total
guest_matches_total
repeat_caller_rate
human_transfers_total
missed_call_prevented_estimate
```

### Logging Standards

Every log line should include:

```text
call_id
tenant_id
location_id
node_id
provider
provider_call_id
session_id
trace_id
```

### Alerting

Initial alerts:

- No healthy Siphon-AI nodes.
- SIP 5xx rate above threshold.
- Orchestrator WebSocket failure rate above threshold.
- AI provider error rate above threshold.
- Cloud SQL CPU/storage/connection pressure.
- Redis memory pressure.
- Pub/Sub dead-letter queue has messages.
- Order delivery failures.
- Recording storage failures.

### Debugging Tools

Keep packet-level troubleshooting available on voice nodes:

```text
sngrep
tcpdump
rtp analysis scripts
journalctl
cloud logging agent
custom /metrics endpoint
```

---

## 27. High Availability and Scaling Plan

### MVP HA

```text
Minimum production voice gateways: 2
Minimum zones: 2 if possible
Database: Cloud SQL HA
Redis: Memorystore standard/high availability tier where budget allows
API: Cloud Run min instances > 0 for latency-sensitive services
Storage: regional bucket initially
```

### Voice Gateway Scaling

Scale Siphon-AI based on:

- Active concurrent calls.
- CPU usage.
- RTP packet timing/jitter.
- WebSocket connection count.
- Memory.
- Per-node failure rate.

Practical scaling model:

```text
max_calls_per_node = measured_safe_capacity * 0.7
required_nodes = ceil(active_calls_peak / max_calls_per_node) + 1 spare
```

Example only:

```text
Measured safe node capacity: 100 concurrent calls
Production target per node: 70 concurrent calls
Expected peak: 140 concurrent calls
Required nodes: ceil(140 / 70) + 1 = 3 nodes
```

Do not rely on this example until load testing proves the actual capacity.

### Call Draining and Deploys

Deployments should avoid dropping active calls.

```text
1. Put node in drain mode.
2. Remove node from Twilio origination target or LB backend.
3. Wait for active calls to finish.
4. Replace binary or VM.
5. Run health check.
6. Re-enable traffic.
```

### Failure Scenarios

| Failure | Expected Behavior |
|---|---|
| One Siphon-AI node fails | Twilio routes new calls to another origination target; active calls on failed node drop. |
| Orchestrator fails mid-call | Siphon-AI attempts reconnect if possible; otherwise play fallback apology and transfer/hang up. |
| AI provider outage | Route to backup provider or transfer to restaurant staff. |
| Cloud SQL failover | API retries; calls continue with Redis state but final persistence may lag. |
| Redis outage | Active call features degrade; new calls may still work with reduced context if API can load from Postgres. |
| Pub/Sub delay | Real-time call continues; summaries/notifications may lag. |
| Twilio issue | Future multi-carrier strategy allows routing new numbers through secondary provider. |

---

## 28. Environment Strategy

### Projects

```text
brayz-dev
brayz-staging
brayz-prod
```

Use separate GCP projects for hard isolation.

### Environment Purposes

| Environment | Purpose |
|---|---|
| dev | Fast iteration, test carriers, test prompts, developer experiments. |
| staging | Production-like testing, demo restaurants, load tests, release validation. |
| prod | Paying customers only. |

### Naming Conventions

```text
brayz-prod-api
brayz-prod-orchestrator
brayz-prod-siphon-mig-us-east4
brayz-prod-sql-postgres
brayz-prod-redis
brayz-prod-recordings
brayz-prod-call-events
```

### Domain Layout

```text
brayz.ai                  # public marketing site
app.brayz.ai              # restaurant admin portal
api.brayz.ai              # public API
internal-api.brayz.ai     # internal service APIs if needed
sip-us-east4.brayz.ai     # SIP ingress DNS
sip-gw-1.brayz.ai         # direct node target for MVP
sip-gw-2.brayz.ai         # direct node target for MVP
status.brayz.ai           # status page later
```

---

## 29. CI/CD and Infrastructure-as-Code

### Repositories

Recommended monorepo:

```text
brayz/
  apps/
    web/
    mobile/
    api/
    orchestrator/
  services/
    siphon-ai/
    worker/
  packages/
    db/
    shared/
    ui/
    sdk/
  infra/
    terraform/
    scripts/
  docs/
```

### Build Pipeline

```text
GitHub push
  ↓
CI checks
  - lint
  - unit tests
  - type checks
  - Rust tests
  - database migration checks
  ↓
Build artifacts
  - web container
  - api container
  - orchestrator container
  - worker container
  - siphon-ai native binary
  ↓
Deploy dev
  ↓
Promote staging
  ↓
Promote prod with approval
```

### Siphon-AI Release Pipeline

```text
cargo build --release
  ↓
run unit/integration tests
  ↓
package binary + checksum
  ↓
upload to Cloud Storage / Artifact Registry
  ↓
update instance template metadata with version
  ↓
rolling deploy using drain mode
```

### Terraform Modules

```text
infra/terraform/
  envs/
    dev/
    staging/
    prod/
  modules/
    project-services/
    vpc/
    cloud-sql-postgres/
    memorystore/
    pubsub/
    cloud-storage/
    secret-manager/
    cloud-run-service/
    siphon-ai-compute/
    dns/
    iam/
    monitoring/
```

---

## 30. MVP Build Plan With Architecture Deliverables

### Phase 0A: GCP Foundation

Deliverables:

- Create `brayz-dev` GCP project.
- Terraform baseline.
- VPC/subnets/firewall rules.
- Cloud SQL PostgreSQL dev instance.
- Memorystore dev instance.
- Cloud Storage buckets.
- Pub/Sub topics.
- Secret Manager secrets.
- Cloud Run hello-world API.
- One Siphon-AI Compute Engine VM installed via systemd.

### Phase 0B: Carrier Foundation

Deliverables:

- Twilio Elastic SIP Trunk.
- One test phone number.
- Twilio origination URI to Siphon-AI node.
- Carrier abstraction tables.
- Twilio carrier adapter.
- Normalize inbound call events.
- Store call record in Postgres.
- Publish `call.started` and `call.ended` events.

### Phase 0C: Real-Time AI Path

Deliverables:

- Siphon-AI WebSocket session to Orchestrator.
- `start` event contract.
- Audio frame streaming.
- STT provider adapter.
- LLM provider adapter.
- TTS provider adapter.
- Barge-in stop event.
- Basic call transcript storage.

### Phase 1: AI Receptionist

Deliverables:

- Restaurant profile and hours.
- Menu read-only context.
- Basic prompt runtime.
- Answer calls with restaurant-specific greeting.
- Answer hours/location/menu questions.
- Take messages.
- Transfer to restaurant staff.
- Call summary.
- Dashboard call list.

### Phase 2: Order Taking MVP

Deliverables:

- Menu editor.
- Modifier support.
- Order draft during call.
- Order confirmation readback.
- Price calculation.
- SMS/email order ticket.
- Dashboard kitchen ticket.
- Order status workflow.

### Phase 3: Guest Memory MVP

Deliverables:

- Guest profile by phone number.
- Repeat caller greeting.
- Favorite items from order history.
- Saved pickup/delivery preference.
- Staff-editable guest notes.
- Guest memory opt-out.

### Phase 4: Loyalty and Promotions

Deliverables:

- Basic points ledger.
- VIP rules.
- Favorite-item discounts.
- Promotion rules engine.
- Promotion usage analytics.

### Phase 5: Staff Voices

Deliverables:

- Staff profile management.
- Voice consent workflow.
- Voice asset upload.
- Approved provider integration.
- Rotation rules.
- Fallback voice rules.

---

## 31. Production Readiness Checklist

### Voice

- [ ] Two or more Siphon-AI nodes.
- [ ] Static public IPs.
- [ ] Twilio IP allowlists.
- [ ] SIP/RTP packet capture tooling installed.
- [ ] Health endpoints.
- [ ] Drain mode.
- [ ] Active call metrics.
- [ ] Load test results documented.
- [ ] Fallback transfer path.

### GCP

- [ ] Separate dev/staging/prod projects.
- [ ] Terraform-managed infrastructure.
- [ ] Cloud SQL backups and PITR.
- [ ] Cloud SQL HA for production.
- [ ] Redis HA for production.
- [ ] Secret Manager only for secrets.
- [ ] IAM least privilege.
- [ ] Cloud Logging and Monitoring alerts.
- [ ] Cloud Storage lifecycle rules.

### Product

- [ ] Tenant/location isolation tested.
- [ ] Menu editor works.
- [ ] Order confirmation flow tested.
- [ ] Human escalation tested.
- [ ] Guest memory opt-out tested.
- [ ] Call recording disclosure configured.
- [ ] Admin dashboard supports restaurant operations.

### AI

- [ ] Prompt versions tracked.
- [ ] Tool calls logged.
- [ ] AI cost tracked per call.
- [ ] Provider failover plan.
- [ ] Hallucination guardrails for menu/order pricing.
- [ ] Order readback required before confirmation.
- [ ] Staff transfer on uncertainty.

---

## 32. Early Architecture Decision Records

### ADR-001: Use GCP as Primary Cloud

Decision: Brayz will start on GCP.

Reason: Managed Postgres, strong networking, Cloud Run, Pub/Sub, Cloud Storage, Secret Manager, and observability provide a clean production path.

### ADR-002: Run Siphon-AI on Compute Engine, Not Docker

Decision: Siphon-AI voice gateway nodes will run as native binaries on Compute Engine with systemd.

Reason: Real-time SIP/RTP services need predictable UDP networking, static IPs, packet-level troubleshooting, and direct OS-level control.

### ADR-003: Use Cloud SQL PostgreSQL as System of Record

Decision: Use Cloud SQL PostgreSQL for MVP and early production.

Reason: Cloud SQL provides managed Postgres with HA options, backups, and extensions while avoiding the burden of operating the database directly.

### ADR-004: Keep Carrier Providers Abstracted

Decision: Twilio is the first carrier implementation, not the platform model.

Reason: Brayz may later support Telnyx, SignalWire, Bandwidth, direct SIP trunks, or BYOC. The rest of the product should depend on normalized carrier events.

### ADR-005: Keep POS Integrations Out of the MVP Critical Path

Decision: MVP order delivery will use dashboard, SMS, email, and printable tickets before POS integrations.

Reason: POS integrations can slow down launch. The first proof is whether restaurants value answered calls, reliable ordering, and guest memory.

---

## 33. Recommended First Technical Milestone

The first technical milestone should be a full vertical slice:

```text
Twilio test number
  ↓
Siphon-AI Compute Engine node
  ↓
Conversation Orchestrator
  ↓
Basic AI receptionist
  ↓
Postgres call record
  ↓
Dashboard call history
```

Success criteria:

- A real phone number can be called.
- Siphon-AI answers the call.
- Audio reaches the AI orchestrator.
- The caller hears TTS back.
- The call is recorded in Postgres.
- The dashboard shows the call.
- The transcript or summary appears after the call.
- Human transfer works.

After this works, build order-taking and guest memory on top of the same architecture.



---

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
