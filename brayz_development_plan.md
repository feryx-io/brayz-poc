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

