# The Brayz staff admin portal

`/admin` in the web app is **ours, not a customer's**. It is the one screen that reads
across every tenant: how many restaurants are on Brayz, what they are paying, how many
calls they are taking, and what they have asked us for help with.

- Web: `apps/web/app/admin/*` (Overview, Customers, Support, Staff)
- API: `services/api/src/routes/admin.ts` (staff side), `routes/support.ts` (customer side)
- Gate: `services/api/src/auth/platform.ts`
- Trail: `platform_audit_logs`, written by `services/api/src/lib/platformAudit.ts`

## Why it is allowed to read across tenants

Rule #1 in `CLAUDE.md` says every query carries a tenant. `routes/admin.ts` is the second
and last deliberate exception (after `lib/duplicates.ts`), and it earns it the same way:

1. **One file.** Raw `prisma`, never `forTenant`, and confined to that file.
2. **Every route gated** by `requirePlatformStaff` — a role that lives in
   `users.platformRole`, which no customer can grant themselves.
3. **Aggregates, not contents.** Counts, plans, and the support requests customers
   deliberately sent us. No transcript, no recording, no guest, no order. Support that
   needs those is a conversation with the customer, not a back door.
4. **Every read of an identifiable customer is audited** with who did it.
5. **Not a master key.** No tenant-scoped route consults a platform role, so being staff
   does not make `/v1/locations/:id` answer for a restaurant you do not belong to.

## The two roles

| Role | Can |
| --- | --- |
| `support` | Open the portal, read the overview, customers, and the support queue |
| `admin` | All of that, plus reply to and resolve support requests, grant/revoke staff access, and read the staff audit trail |

Everyone else — every restaurant owner, however senior in their own tenant — gets a 403.

## Creating the first admin

The portal grants access, but the first admin cannot grant themselves. Set
`PLATFORM_ADMIN_EMAILS` (comma-separated) on the **API**.

Locally, in your env:

```bash
PLATFORM_ADMIN_EMAILS=you@brayz.ai,cofounder@brayz.ai
```

On GCP it is **Terraform**, not `gcloud run services update` — a manual update is
reverted by the next apply. Set `platform_admin_emails` in the gitignored
`infra/terraform/envs/dev/terraform.tfvars` and apply:

```bash
terraform -chdir=infra/terraform/envs/dev plan    # expect one env var added to the API
terraform -chdir=infra/terraform/envs/dev apply
```

It is not a secret — a list of our own addresses — so it is a plain env var like
`twilio_sms_from`, not a Secret Manager entry. **Set on `brayz-dev` 2026-09-09**
(two staff addresses); it stays inert until an image
containing this code is deployed.

Those emails are promoted to `admin` **the first time they call `/v1/me`** after signing
in normally — so sign in to `app.brayz.ai` as usual, and the "Brayz staff portal →" link
appears in the sidebar.

After that, `users.platformRole` is the source of truth. **Removing an email from
`PLATFORM_ADMIN_EMAILS` does not revoke access** — that is deliberate: revocation is an
explicit act on `/admin/staff`, not a config edit nobody notices.

It is set on the API service only; the web app never sees it.

## Granting access to someone else

`/admin/staff`, as an `admin`. **They must have signed in to Brayz at least once** — we
grant a role to an account, we do not create one. An admin cannot demote themselves: the
last one doing so would leave the portal unreachable by anyone, recoverable only by
editing the database by hand.

## Support requests

A restaurant files one from **Help** in its own dashboard (`/app/help`, any member may —
it is a cry for help, not a config change). It lands in `support_requests`, tenant-scoped
like everything else, and appears in the staff queue at `/admin/support`, oldest first.

- Staff `admin` picks it up (`in_progress`), replies, and resolves it. The reply is shown
  to the customer on their own Help screen — write it as an answer, not an internal note.
- The customer can withdraw one **only while it is still open**. Once we have picked it
  up, the thread is a shared record and deleting it would erase the reply from under
  whoever needs to read it.
- There is no notification yet: staff watch the queue, customers check the screen. Wiring
  it to `lib/notifier.ts` is the obvious next step.

## Free trials

Every account created after trials shipped starts on a **30-day free trial of Pro**
(`TRIAL_DAYS` / `TRIAL_PLAN` in `@brayz/billing`), set on `tenants.trialStartedAt` /
`trialEndsAt` when the sign-up wizard creates the business. The trial belongs to the
**account**: every location it opens in those 30 days is on Pro, and adding a location
does not restart the clock. Accounts from before trials have no `trialEndsAt` and keep
the unrestricted access they always had.

- **When it ends with nothing paid for, the account is out of service** — whatever
  `BILLING_ENFORCED` says (that flag is about plan tiers). The AI stops answering:
  `POST /v1/calls` tells the Orchestrator, which rings the call through to the
  restaurant (its first enabled transfer target, else its escalation phone, as a SIP URI
  — a bare number needs `BRAYZ_TRANSFER_SIP_DOMAIN`) or, with nowhere to send it, says
  one line and hangs up. The call is still recorded, with a `call.out_of_service` event,
  and paid features return 402 `trial_expired`. The customer's dashboard says so on every
  screen. A paid plan on any location turns it straight back on.
- **Subscribing mid-trial keeps the days left**: Checkout carries the trial's end as
  Stripe's `trial_end` (when at least 48 hours remain — Stripe's minimum), so billing
  starts when the trial would have ended.
- **`/admin/trials`** (support and admin; audited as `admin.trials.listed`): every trial,
  filterable by active / ending soon (≤ 7 days) / expired / converted, with how far
  through it is, setup progress (number live, menu items, first call, first order),
  calls and orders during the trial, and — once lapsed — calls since it ended.
- **Extending** is `admin` only, from that page or the customer's page, and always takes
  a reason: `POST /v1/admin/trials/:tenantId/extend` with `days` (1–90, added to the
  later of today and the current end — so a lapsed trial restarts today) or an exact
  `endsAt` (at most a year out). On an account with no trial it **starts** one. Each
  change is written to `platform_audit_logs` (`admin.trial.extended` /
  `admin.trial.granted`, with from, to, days and reason), and that log is the trial
  history the customer page shows.

## Live calls and call history

The Overview leads with **active calls right now** — every customer, every voice node —
and follows the usage tiles with a histogram of call volume.

- **Live** (`GET /v1/admin/calls/live`, polled every 5 s). A call is live while its row has
  no `endedAt` and it started within the last two hours. The Orchestrator records a call's
  end best-effort (a lost PATCH never fails a call), so an open row older than that is
  reported as **stale** and not counted — a live number that only ever creeps up is worse
  than none. Per node: active now, calls in the last 24 h, and when the last one started.
  A node that has taken a call in the last 7 days stays listed at zero, so an idle node
  reads as idle rather than vanishing.
- **Which node.** SiphonAI's `start` message does not say which node sent it, so each node
  names itself on the URL it dials: Terraform renders `[bridge].ws_url` as
  `…/v1/media?node=<[node].id>` (`modules/siphon-node/config.toml.tftpl`). The Orchestrator
  stores it on the call (`calls.nodeId`), falling back to the address the node connected
  from (`ip:…`), and never fails a call over a malformed one. **Adding a node needs nothing
  here** — its own `[node].id` is enough. Calls from before this was recorded show as
  *Unattributed*.
- **Node health.** Nothing outside a node can reach SiphonAI's `/health`, `/ready` and
  `/metrics` (loopback only, and the API is on Cloud Run), so each node reports in: the
  siphon-node startup script installs `brayz-node-heartbeat`, a systemd timer that every
  30 s posts a snapshot to `POST /v1/voice-nodes/<id>/heartbeat` (node-secret auth,
  registering itself on the first 404). It reads — service active, `/health`, `/ready`,
  uptime, version, calls/dialogs active, RTP ports in use, HEP collector up, webhook and
  recording upload backlogs, load, memory, disk — and never acts: nothing in it restarts,
  drains or reconfigures siphon-ai. The latest snapshot overwrites `voice_nodes.health`
  (current state only, no history; Postgres rather than rule #3's Redis because the row
  already existed and Redis is not deployed). `services/api/src/lib/nodeHealth.ts` judges
  it: **down** after 90 s without a beat, or with the service or `/health` down;
  **draining**; **degraded** with a reason per fault (not ready, Homer unreachable,
  webhooks or recordings backed up, RTP ports ≥ 80 %, disk or memory ≥ 90 %, load ≥ 1.5×
  cores); otherwise **healthy**. The node is listed from its first heartbeat, before it
  takes a call, and stays listed — as down — for a week after its last. The node's own
  active-call count is shown beside ours when the two disagree. The heartbeat is a Brayz
  sidecar on a VM we already provision, not a change to SiphonAI (rule #4).
- **History** (`GET /v1/admin/calls/histogram?bucket=hour|day|week|month&from=&to=&tz=`).
  Gap-free — a bucket with no calls is a zero, never missing — and cut in the viewer's
  timezone, at most 1,000 buckets a request. The page offers ranges from 24 hours to 24
  months and only the groupings that make 2–200 bars; every chart has a table view.
- Both are counts that identify no customer, so neither is audited, like the overview.

Shipping it: `calls.nodeId` is an add-only migration, so it deploys in one step. The
node's `ws_url` change replaces the voice node (about a minute of voice downtime, like any
node config change) — apply it when no one is on a call.
