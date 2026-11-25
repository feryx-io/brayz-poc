# Call recordings and summaries

Two things fill in the Calls screen after a call ends. Summaries need nothing
configured; recordings need SiphonAI set up to record, upload, and tell us.

## Summaries

The Orchestrator asks the LLM to summarize the conversation as the media
session tears down, then PATCHes it onto the call. Nothing to configure — it
uses the same `ANTHROPIC_API_KEY` and model as the conversation itself.

It is deliberately best-effort: the request is bounded (10 s) and a failure
leaves the summary null rather than holding the call record open. A call where
the caller never spoke is not summarized at all, so an abandoned call costs no
tokens.

## Recordings

SiphonAI records on the node — Brayz never touches audio. Three pieces have to
line up, and **in GCP all three are Terraform** (`recording_enabled`, on by
default in `envs/dev`): `modules/recording-bucket` creates the bucket with an
HMAC key per side and writes the keys into Secret Manager, `modules/siphon-node`
renders the `[recording]` / `[recording.storage]` blocks below and reads the
node's key at boot, and the API gets its endpoint and key. The sections below
describe what that produces, and what to set up by hand anywhere else.

### 1. Record

In the node's `config.toml` (see `docs/RECORDING.md` in the siphon-ai repo):

```toml
[recording]
mode   = "always"        # or "on_demand" — see the PCI note below
format = "wav"           # every browser plays it from <audio>; ~2 MB/min at 8 kHz
dir    = "/var/lib/siphon-ai/recordings"
```

The Orchestrator captures the `recording_started` / `recording_stopped` /
`recording_failed` lifecycle events, so the dashboard shows whether a call was
recorded even before the file goes anywhere.

> **PCI**: with `mode = "on_demand"` the WS server drives `pause_recording` /
> `resume_recording` around a card number so the digits are never written.
> Brayz does not take card payments today, so `always` is fine — revisit this
> before it does.

### 2. Upload

A recording on the node's disk is not reachable from the dashboard. Point
SiphonAI at object storage:

```toml
[recording.storage]
enabled      = true
endpoint     = "https://storage.googleapis.com"   # GCS S3-compat, or S3/R2/MinIO
bucket       = "brayz-dev-call-recordings"
region       = "auto"
access_key   = "${RECORDING_S3_ACCESS_KEY}"        # from the daemon environment
secret_key   = "${RECORDING_S3_SECRET_KEY}"
key_template = "{date}/{call_id}"
delete_local_after_upload = true
spool_dir    = "/var/lib/siphon-ai/upload-spool"   # not /var/spool: the unit's ProtectSystem=strict
```

The node's key belongs to its own service account, which the bucket lets
**create** objects and nothing else; the API's key belongs to the API's account,
which may only **read**. Retention is the bucket lifecycle rule
(`recording_retention_days`), since the daemon deletes its local copy after a
durable upload and never schedules deletion in the bucket.

**Not sealed with `[recording.encryption]`, deliberately.** Playback is a signed
URL straight to the object, which a browser cannot decrypt, and there is no
decrypting proxy. The bucket enforces public-access prevention, an object is
reachable only through a 5-minute signed URL, every access is audited, and GCS
encrypts at rest. Revisit if recordings ever leave GCP or a decrypting playback
path is built — the daemon's envelope format is documented for exactly that.

### 3. Tell Brayz

SiphonAI confirms each upload with a `recording_uploaded` lifecycle webhook.
Point its webhook sink at the API and share a secret:

```toml
[webhooks]
url    = "https://<api-host>/v1/webhooks/siphon"
secret = "<the same value as SIPHON_WEBHOOK_SECRET>"
events = ["recording_uploaded"]
```

Set the matching `SIPHON_WEBHOOK_SECRET` on the API (locally in `.env`; in GCP
as a Secret Manager version). **Without it the endpoint refuses every
delivery** — an unauthenticated endpoint that stamps a URL onto a call record
is not a safe default, so it fails closed rather than open.

Deliveries are HMAC-signed and verified against a 5-minute freshness window, so
a captured POST cannot be replayed later. Delivery is at-least-once — retries
and post-restart spool replays are deduped on `X-SiphonAI-Event-Id`.

### Retention

Two layers, and a location can only tighten, never loosen:

1. **The platform ceiling** is the bucket's lifecycle rule
   (`recording_retention_days`, 90 in dev). It deletes every object older
   than that, whoever it belongs to. Nothing in the API can keep a recording
   past it, which is why the API refuses a per-location value above it (422
   `retention_above_ceiling`) — a setting that promised otherwise would lie.
2. **A per-location policy** is Settings → AI & call handling → "Keep call
   recordings for (days)" (`LocationAiSettings.recordingRetentionDays`; null
   means no policy, the ceiling applies). Once an hour Cloud Scheduler POSTs
   `/v1/internal/recordings/sweep`, and the API finds calls at locations with
   a policy whose `startedAt` is past the cutoff and still have an uploaded
   recording, deletes the object through the same S3 endpoint (a header-signed
   `DELETE`), sets `recordingStatus = deleted`, clears `recordingUrl`, and
   writes a `recording.deleted` audit entry with the policy that caused it.
   The transcript and summary are untouched. The Calls screen shows the call
   as "Recording deleted".

The sweep is idempotent (rule #7): the object goes before the row is touched,
so a crash between the two is retried next run, and a `404` from the store —
the bucket rule got there first — counts as done. A store that refuses leaves
the row alone with a warning, so the call keeps saying it has a recording
until it actually does not. Each run deletes at most `RECORDING_SWEEP_BATCH`
(200) per location and reports `{ locations, scanned, deleted, failed }`.

**Who may trigger it.** The API's Cloud Run URL is public, so the API checks
the caller itself: a Google OIDC identity token for the scheduler service
account (`SCHEDULER_INVOKER_EMAIL`, audience `SCHEDULER_OIDC_AUDIENCE` — both
Terraform, no shared secret anywhere), or the node secret, which is how it is
run locally and by hand:

```bash
curl -X POST -H "x-brayz-node-secret: $BRAYZ_NODE_SHARED_SECRET" \
  https://<api-host>/v1/internal/recordings/sweep
```

The API's bucket identity gains a custom role with only
`storage.objects.delete` for this (`recordingDeleter` in
`modules/recording-bucket`); it still cannot create, list or overwrite.

### Playback

The stored URL is an `s3://bucket/key` URI, which a browser cannot play.
`GET /v1/calls/:id/recording` turns it into a short-lived SigV4 signed URL
(`services/api/src/lib/recordingStorage.ts`, `RECORDING_URL_TTL_SECONDS`,
default 300 s) when `RECORDING_S3_ENDPOINT` and the API's key pair are set;
without them it returns the object URI only, and the Calls screen says the
recording exists but cannot be played. The signer is vendor-neutral SigV4 with
no SDK — GCS interop, S3, R2 and MinIO all accept it.

To check the whole chain after a call: the node's
`siphon_ai_recording_uploads_total{result="ok"}` counter moved, the API logged
`recording.stored` in the audit log, and `calls.recordingStatus` is `uploaded`
(later `deleted`, once the location's retention policy has run — see below).
Recordings are stereo: **left = caller, right = bot.**

## Who can see a recording

Reaching for a recording's location is a separate, audited act (CLAUDE.md rule
#6). `recordingUrl` is **not** returned by `GET /v1/calls/:id` or the calls
list — only by `GET /v1/calls/:id/recording`, which writes a
`recording.accessed` audit entry naming the user. The webhook writes
`recording.stored` when the file first becomes reachable, and the retention
sweep writes `recording.deleted` when it removes one.

If you add playback, keep it on that route so the audit trail stays true.
