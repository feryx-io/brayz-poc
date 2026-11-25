# Brayz

AI-powered guest-engagement platform for restaurants. Brayz answers every inbound
phone call with real-time voice AI, takes pickup orders, remembers guests, and
supports loyalty — delivered as a multi-tenant SaaS.

> Core promise: every call gets answered, every guest feels like a regular.

See [`CLAUDE.md`](./CLAUDE.md) for engineering rules and
[`brayz_implementation_plan.md`](./brayz_implementation_plan.md) for the phased plan.

## Monorepo layout

```
packages/config   Zod-validated env loader (never read process.env elsewhere)
packages/shared   Shared TS types + Zod schemas + Pub/Sub event envelope
packages/db       Prisma schema (Postgres), tenant-scope helper, seed
packages/ai       Provider interfaces (STT/LLM/TTS/embedding) + prompts/tools
packages/carriers CarrierProvider abstraction + Twilio adapter
packages/pos      PosProvider abstraction + Square adapter + manual-ticket fallback
packages/billing  BillingProvider abstraction + Stripe adapter + plan entitlements
services/api       Fastify REST API (SaaS control plane)
services/orchestrator  Real-time Conversation Orchestrator (WS media skeleton)
services/worker    Pub/Sub worker (skeleton)
apps/web           Next.js marketing site + restaurant admin portal
```

## Toolchain

Uses **npm workspaces** (Node ≥ 20). The plan calls for pnpm/Turborepo; see the
note in `CLAUDE.md` — npm is used because the dev environment drives a Windows
`fnm` Node from WSL where pnpm/turbo shims break. The layout is unchanged, so
pnpm/turbo can be reintroduced later.

## Quick start

```bash
npm install
cp .env.example .env                       # fill in as needed
npm --workspace @brayz/db run generate     # generate Prisma client

# Start local Postgres (pgvector) + Redis
docker compose up -d                       # publishes Postgres on localhost:5432

# Prisma CLI reads .env from the package dir, so DATABASE_URL must also live in
# packages/db/.env (gitignored). Create it once:
echo 'DATABASE_URL=postgresql://brayz:brayz@localhost:5432/brayz?schema=public' > packages/db/.env

npm --workspace @brayz/db run migrate -- --name init
npm --workspace @brayz/db run seed         # seeds the "Mario's Pizza" demo tenant

# Run services
npm --workspace @brayz/api run dev          # http://localhost:4000
npm --workspace @brayz/orchestrator run dev # ws://localhost:4100/v1/media
npm --workspace @brayz/web run dev          # http://localhost:3000
```

### Quality gates

```bash
npm run typecheck    # all workspaces
npm run build
npm --workspace @brayz/api test   # Fastify inject smoke tests
```

## Auth (Phase 0 dev mode)

Real auth (Firebase / Identity Platform) lands in Phase 1. For now the API resolves
context from dev headers:

- `x-brayz-user-email` — current user
- `x-brayz-tenant-id` — active tenant

Example:

```bash
# Create a tenant (bootstrap; no tenant context needed)
curl -XPOST localhost:4000/v1/tenants -H 'content-type: application/json' \
  -H 'x-brayz-user-email: owner@mario.test' -d '{"name":"Mario'\''s Pizza"}'

# List that tenant's locations (tenant-scoped)
curl localhost:4000/v1/locations -H 'x-brayz-tenant-id: <tenantId>'
```

## What's next

Phase 0 is largely complete (see `CLAUDE.md` → "Where we are in the build").
Remaining bootstrap work: a real Postgres for migrations and the Terraform dev
foundation. Then Phase 1 (auth, restaurant profile/hours, menu editor UI).
