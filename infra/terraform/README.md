# Brayz — Terraform (GCP IaC)

Infrastructure-as-code for the Brayz platform. This is the **Phase 0 dev foundation**:
enough to stand up the `brayz-dev` project's network, per-runtime service accounts,
Secret Manager containers, and the **Siphon-AI voice gateway VM** (static IP + SIP/RTP
firewall) so the Phase 2 voice path has somewhere to run.

> Scope today: `envs/dev`. `staging`/`prod` reuse the same `modules/` with their own
> tfvars and isolated projects (`brayz-staging`, `brayz-prod`) — hard project isolation
> per `CLAUDE.md`.

## Layout

```text
infra/terraform/
  bootstrap/            # one-time: creates the GCS bucket that holds remote TF state
  modules/
    project-services/  # enables the required GCP APIs
    network/           # VPC + subnet + Cloud NAT + SIP/RTP/IAP firewall rules
    service-accounts/  # brayz-{api,orchestrator,worker,siphon-gateway}-sa + IAM
    secrets/           # Secret Manager secret *containers* (values added out-of-band)
    siphon-node/       # Compute Engine VM + regional static IP for Siphon-AI
  envs/
    dev/               # the brayz-dev root module (wires the modules together)
```

## Day to day: up, pause, up again

Two scripts cover the whole cycle once the one-time setup below is done.

```bash
./infra/scripts/up.sh            # apply, secrets, DB user, migrations, deploy
./infra/scripts/down.sh          # stop paying between test sessions
```

`up.sh` is idempotent — it is also the "is everything still right?" command.
Re-running fixes drift and reports what it found.

### What `down.sh` actually does

The default is a **pause**, not a teardown, and the difference matters:

| | Paused (`down.sh`) | Destroyed (`down.sh --destroy`) |
|---|---|---|
| Cloud SQL | stopped, data kept | gone, data gone |
| Coming back | ~1 minute, no migrations | apply + migrate + seed |
| Instance name | reusable | **locked for ~a week** by Cloud SQL |
| Cloud Run URLs | unchanged | new — SiphonAI and Stripe need repointing |
| Voice static IP | kept — Twilio unchanged | released — Twilio needs the new address |
| Cost while down | disk + IP + secrets (a few dollars/month) | secrets only (cents) |

The voice VM is destroyed on a pause: largest hourly cost, no state, rebuilt by
its startup script. **Its static IP is reserved separately and kept**, so the
address Twilio dials does not change and the rebuilt VM picks it up again. An
unattached reserved address costs a few dollars a month — cheaper than editing
the origination URI and the node's `config.toml` every cycle. `reserve_voice_static_ip = false`
releases it, and `--destroy`/`--all` drop it too, so those are the paths where
Twilio needs repointing.

`down.sh --all` destroys everything including Secret Manager. That is the "done
with this project" button, not the between-sessions one — coming back from it
means re-entering every vendor key by hand.

### Adopting a Cloud SQL instance that predates the suffixed naming

Instances are named `<prefix>-pg-<random>` so a destroyed environment can be
rebuilt without waiting out the week-long name lock. An instance created before
that change is named `<prefix>-pg`, and the difference is not a rename Cloud SQL
will perform in place — Terraform plans a **replacement**, which takes the data
with it.

Point `cloudsql_instance_name` at the existing instance and the apply becomes an
in-place update instead:

```hcl
cloudsql_instance_name = "brayz-dev-pg"
```

Clear it after a `down.sh --destroy`, so the next build goes back to fresh
suffixed names and keeps the fast-rebuild property.

### What costs money while idle

Roughly, at list price, and worth re-checking against your own billing:

- **Cloud SQL** — the instance is the big one. Stopped, you pay only for the
  disk.
- **The voice VM** — an `e2-medium` running full time. Its reserved IP bills
  only while unattached (a few dollars a month); attached to a running VM it is
  free.
- **Cloud NAT** — bills hourly whether or not a packet crosses it. Off by
  default here, because nothing needs it: the only VM has its own external IP,
  Cloud Run does not route through the VPC, and `private_ip_google_access`
  already covers an IP-less instance reaching Google APIs. Turn on
  `enable_cloud_nat` the moment something lands in the VPC without an external
  IP.
- **VPC flow logs** — bill on ingestion. Off by default (`enable_flow_logs`).
- **Cloud Run** — the API and web are free at `min_instances = 0`. The
  **Orchestrator keeps one warm instance with CPU always allocated**, which does
  bill while idle. That is deliberate: a caller is already on the line when the
  media session opens, so a cold start is dead air they hear — on a live call it
  was 15 seconds of it. `down.sh` drops it to zero when pausing, so it only costs
  while the environment is meant to answer calls.
- **Secret Manager, VPC, service accounts** — cents, or free.

## What this does NOT manage yet

Pub/Sub topics, Memorystore, and DNS. Their APIs are enabled here so those
modules can be added without re-bootstrapping. (The one Cloud Storage bucket
Brayz needs so far — call recordings — is managed; see below.)

Secret **values** are never in Terraform — only the containers — with one
deliberate exception: the recording bucket's HMAC keys, whose secret exists only
in the create response, are written to Secret Manager by
`modules/recording-bucket` rather than copied by hand. `up.sh` generates the
other secrets Brayz owns both ends of and tells you the exact command for the
vendor keys it cannot invent.

## Prerequisites (run these yourself — they need your GCP credentials)

In this Claude Code session you can run a command yourself by typing `! <command>` so its
output lands in the conversation. `terraform` is **not** installed in the dev box; install
it (or run from Cloud Shell) before `init`.

```bash
# 1. Authenticate and set application-default credentials Terraform will use.
gcloud auth login
gcloud auth application-default login

# 2. Create the dev project (skip if it already exists) and link billing.
gcloud projects create brayz-dev --name="Brayz Dev"
gcloud billing projects link brayz-dev --billing-account=XXXXXX-XXXXXX-XXXXXX

# 3. One-time: create the remote-state bucket.
cd infra/terraform/bootstrap
terraform init
terraform apply -var='project_id=brayz-dev'
#   -> outputs the bucket name; put it in envs/dev/backend.hcl (see below).
```

## Standing up the dev environment

```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars   # then edit: billing-verified Twilio ranges, etc.

# Point the backend at the bucket the bootstrap step created.
cp backend.hcl.example backend.hcl             # edit the bucket name

terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

`terraform apply` prints the Siphon-AI VM's **static public IP** — use it for the Twilio
origination URI and as `[node].public_address` in the node's config.

SiphonAI itself is a separate product with its own repo and release cadence, so nothing
here builds it — but the node now installs and configures itself. The VM's startup script
(`modules/siphon-node/startup-script.sh.tftpl`) downloads the published `.deb` for
`siphon_version`, verifies it against the release `SHA256SUMS`, renders
`modules/siphon-node/config.toml.tftpl` to `/etc/siphon-ai/config.toml`, reads the node
token from Secret Manager with the VM's own service account, runs `siphon-ai check`, and
starts the service. **Upgrading the bridge is a `siphon_version` bump plus an apply** —
there is nothing to do on the box.

The daemon logs **one JSON object per line** (`SIPHON_AI_LOG_FORMAT=json` in
`/etc/siphon-ai/env`, SiphonAI 0.51.0+), and the startup script installs
`modules/siphon-node/ops-agent.yaml` as the Cloud Ops Agent config: a `systemd_journald`
receiver filtered to `siphon-ai.service`, a JSON parse of `MESSAGE`, severity taken from
the daemon's `level`, and the journal's per-line bookkeeping fields dropped. So `call_id`,
`route`, `from_user`, `node_id` arrive in Cloud Logging as `jsonPayload` fields rather than
substrings of a text line, and the default syslog receiver stops carrying the same lines
as text. Per-call fields sit under the span: `jsonPayload.span.call_id`. For example:

```bash
gcloud logging read 'logName:"siphon_journal" AND jsonPayload.span.call_id="siphon-…"' \
  --project=brayz-dev --format='value(timestamp,severity,jsonPayload.message)'
```

The agent config is validated on the box before it is installed; a rejected config leaves
the previous one in place and says so in the serial log, and the voice path never depends
on logging.

**Call recordings** (`recording_enabled`, default true): `modules/recording-bucket`
creates `<project>-call-recordings` (uniform access, public-access prevention,
lifecycle delete after `recording_retention_days`), grants the node's service
account objectCreator and the API's objectViewer, mints an HMAC key for each and
writes them into the `recording-upload-*` (node) and `recording-s3-*` (API)
secrets. The node config gains `[recording]` + `[recording.storage]` (stereo WAV,
uploaded on finalize through GCS's S3 endpoint, local copy deleted after a
durable upload) and the API gets `RECORDING_S3_ENDPOINT` for signing playback
URLs. Recordings are not client-side encrypted — `docs/operations/call-recordings.md`
has the reasoning. Turning it off leaves calls with no recording; nothing else
changes.

**Recording retention** (with `recording_enabled`): `recording_retention_days`
is the platform ceiling (the bucket lifecycle rule); a location may keep
recordings for less via its own setting, which the API enforces with an hourly
sweep. `google_cloud_scheduler_job.recording_sweep` (`recording_sweep_schedule`,
default `17 * * * *`) POSTs the API's `/v1/internal/recordings/sweep` with an
OIDC token for the `scheduler` service account — a SA with no project roles,
whose only power is that the API recognises it (`SCHEDULER_INVOKER_EMAIL` +
`SCHEDULER_OIDC_AUDIENCE`). The API's bucket identity gains the
`recordingDeleter` custom role (`storage.objects.delete` only) so the sweep can
remove objects without being able to create or overwrite them.

The config's `rtp_port_range`, SIP port, and `[[trunk]] peer_addrs` are all rendered from
the same variables as the firewall rules, so the daemon and the firewall cannot drift
apart. That mattered: a range the firewall does not open sets calls up normally and then
carries no audio, because only the media is dropped.

## Adding secret values (never committed, never in tfvars)

The `secrets` module creates empty containers. Add a version per secret with `gcloud`:

```bash
printf '%s' "$TWILIO_AUTH_TOKEN" | gcloud secrets versions add brayz-dev-twilio-auth-token \
  --project=brayz-dev --data-file=-
printf '%s' "$BRAYZ_NODE_SHARED_SECRET" | gcloud secrets versions add brayz-dev-siphon-node-token \
  --project=brayz-dev --data-file=-
```

## Deploying the API + Orchestrator + Web to Cloud Run

`./infra/scripts/up.sh` does all of this. It exists because the sequence below
is fiddly, order-dependent, and has to be repeated every time the environment
comes back — which is exactly the kind of thing that should not live in a
README.

It runs, in order:

1. `terraform apply` — unpauses the database, recreates the voice VM
2. generates `siphon-node-token` and `siphon-webhook-secret` if they have no
   value (Brayz owns both ends of these; no reason to make a human invent them)
3. gives every optional secret an empty placeholder version — a Cloud Run
   service **refuses to start** on a secret with no version at all, and the API
   reads empty as "not configured" so the feature simply stays off
4. creates or repairs the `brayz` SQL user against a generated password kept in
   its own secret, then writes `DATABASE_URL`
5. runs migrations through the Cloud SQL Auth Proxy (downloading it if needed)
6. builds and deploys the three services
7. prints the URLs, plus exactly what to paste into SiphonAI, Twilio, and Stripe

Vendor keys it cannot invent — Anthropic, Deepgram, Twilio, OpenAI — are
reported as missing with the command to set them, rather than deploying a bot
that cannot speak and leaving you to find out on a call.

```bash
PROJECT=brayz-dev REGION=us-east4 ./infra/scripts/up.sh
./infra/scripts/up.sh --seed          # also load the "Mario's Pizza" demo tenant
./infra/scripts/up.sh --skip-deploy   # infra + database only, no image build
```

The web image bakes `NEXT_PUBLIC_*` in at build time, so `WEB_AUTH_MODE`,
`FIREBASE_API_KEY` and friends still pass through to `deploy-cloud-run.sh`; see
`docs/operations/auth-firebase-setup.md`.

## ⚠️ Verify the Twilio SIP/RTP source ranges before apply

The SIP/RTP firewall only allows traffic from `twilio_sip_source_ranges` /
`twilio_media_source_ranges` (see `terraform.tfvars.example`). The committed example values
are a **starting point and may be stale** — confirm them against Twilio's current published
list before you `apply`, or inbound calls will be silently dropped at the firewall:
<https://www.twilio.com/docs/sip-trunking/ip-addresses>
