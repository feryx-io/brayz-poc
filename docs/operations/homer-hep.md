# Homer / HEP call capture

SiphonAI ships HEP3 at a [Homer](https://sipcapture.io/) collector, giving one
correlated timeline per call — every SIP message, RTCP report, RTP quality
summary, lifecycle log line, the CDR, and the STIR/SHAKEN verdict — keyed by SIP
`Call-ID`. This is the network view of a call. The Brayz staff portal is the
business view. They are deliberately separate systems.

- Terraform: `infra/terraform/modules/homer-node`, wired in `envs/dev` behind
  `homer_enabled` (default **false**).
- The `[hep]` block on the voice node: `modules/siphon-node/config.toml.tftpl`.
- SiphonAI's own reference: `docs/HEP.md` in github.com/thevoiceguy/siphon-ai.

## Before you turn it on

**Homer holds guest phone numbers.** Every INVITE carries `From` and `To`, and
HEP3's `capture_id` — its tenant key — is scoped **per node, not per route** in
SiphonAI v1. So every Brayz tenant's signalling lands under one id with no
separation inside Homer, in a system that has none of Brayz's tenant scoping,
audit log, or per-location retention.

That is why the collector has **no public IP**, is reachable **only through
IAP**, and drops partitions on `homer_retention_days` (14 by default). Keep that
window short. In dev with your own test calls none of this matters much; before
pointing real callers at it, decide the retention and access story deliberately.

**What it does not hold: audio.** SiphonAI ships RTCP and QoS *summaries*, never
RTP payload, so this cannot become a store of call recordings living outside the
consent ledger and the retention sweep (rule #6).

## What lands in Homer

| Emitter | Content | HEP chunk |
| --- | --- | --- |
| `siphon-rs` | SIP messages, parsed inbound + serialized outbound | `0x01` |
| `forge-media` | RTCP (SR/RR/SDES/BYE) | `0x05` |
| `forge-media` | Per-RR RTP QoS — ssrc, jitter, loss | `0x20` |
| `siphon-ai` | Per-call lifecycle log lines | `0x64` |
| `siphon-ai` | Full CDR JSON at call end | `0x65` |
| `siphon-ai` | STIR/SHAKEN verdict per inbound call | `0x66` |

## You may not need this

The node already keeps an in-process **SIP ladder for the last ~50 calls**
(`sip_ring_size`, ~1.9 MB, on by default — the startup line says
`sip_ladder: true`), served at `GET /admin/v1/calls/{id}/sip` and read by
**sightglass**, SiphonAI's terminal operator console. For "what happened on
that one call", that costs no infrastructure — **but only once `[admin]` is
configured.** Our node renders no `[admin]` block, and without one SiphonAI does
not serve `/admin/*` at all, so today the ladder is held and unreadable. The
same goes for `POST /admin/v1/hep/test` below.

Homer earns its keep on what the ladder cannot do: search, history past the ring,
RTCP/QoS and CDR on one timeline, and survival across VM rebuilds.

> The ladder endpoint returns SIP **verbatim, including `Authorization` headers,
> deliberately unredacted** — which is why it is operator-gated. Set
> `sip_ring_size = 0` if you would rather the node not hold them at all.

## Turning it on

Three secret containers are created whether or not the collector is enabled (the
same way the recording secrets are). Seed them **before** the first apply with
`homer_enabled = true`, or the VM's startup script refuses to start rather than
run an unauthenticated collector:

```bash
P=brayz-dev
# The HEP auth key — HEP chunk 0x0011. Both ends share it.
openssl rand -hex 32 | gcloud secrets versions add "$P-hep-password"        --project "$P" --data-file=-
# Homer's own Postgres password.
openssl rand -hex 32 | gcloud secrets versions add "$P-homer-db-password"   --project "$P" --data-file=-
# The Homer UI's admin password. Empty leaves the upstream default.
openssl rand -hex 24 | gcloud secrets versions add "$P-homer-admin-password" --project "$P" --data-file=-
```

Then set `homer_enabled = true` in the gitignored `envs/dev/terraform.tfvars`
and apply.

> **This replaces the voice node.** Adding the `[hep]` block changes the startup
> script, and the siphon-node module ships config changes by replacing the VM —
> that is deliberate (otherwise a config change sits in metadata until someone
> reboots), but it costs about a minute of voice downtime. Do it when no one is
> on a call.

## Opening the UI

There is no public route. Tunnel to it:

```bash
gcloud compute start-iap-tunnel brayz-dev-homer 9080 \
  --local-host-port=localhost:9080 --zone=us-east4-a --project=brayz-dev
```

Then <http://localhost:9080>. `terraform output` prints this command for you.

## Checking it works

The daemon exports these from startup, before any call, so an alert can be
written against them without tolerating an absent series:

| Metric | Means |
| --- | --- |
| `siphon_ai_hep_packets_sent_total` | packets written to the wire |
| `siphon_ai_hep_packets_dropped_total{reason="queue_full"}` | producer outran `queue_capacity` |
| `siphon_ai_hep_packets_dropped_total{reason="collector_down"}` | the socket was refused — a dead collector's ICMP unreachable |
| `siphon_ai_hep_collector_up` | `0` if any send was refused in the last 10 s sample |

A **black-holed** collector — dropping packets with no ICMP back — is the one
case UDP cannot report; SiphonAI's `docs/HEP.md` has the diagnostic order.

There is also an admin endpoint that sends a test packet:
`POST /admin/v1/hep/test` (admin-token gated).

## What the first real call showed (2026-09-11, SiphonAI 0.51.0)

One inbound call placing an order: the node sent 49 HEP packets, heplify-server
received 49 (6 SIP, 21 RTCP, 21 RTP-QoS, 1 CDR), none dropped.

- **SIP ladder and CDR are keyed by SIP Call-ID**, as documented — search Homer
  by Call-ID and INVITE / 100 / 200 / ACK / BYE / 200 are there. The CDR
  (payload 101, stored in `hep_proto_35_default`) carries both `sip_call_id` and
  SiphonAI's own `call_id`, plus a quality summary: MOS, jitter, loss, RTCP RTT,
  barge-in count, time to first audio.
- **RTCP and RTP-QoS were keyed by SiphonAI's call id (`siphon-…`), not the
  SIP Call-ID** — contrary to SiphonAI's HEP.md — so they landed but did not
  thread onto the call view. **Fixed in 0.51.1**
  ([siphon-ai#603](https://github.com/thevoiceguy/siphon-ai/issues/603)).
- **No lifecycle-log chunks (0x64) were emitted**, though HEP.md described a
  `call_started` / `call_ended` timeline. **Fixed in 0.51.1**
  ([siphon-ai#604](https://github.com/thevoiceguy/siphon-ai/issues/604)).

**Re-checked on 0.51.1 the same day** (one inbound call, 63 s): 33 packets sent
and 33 received — 6 SIP, 12 RTCP, 12 RTP-QoS, 2 Log, 1 CDR — **every one keyed
by the SIP Call-ID**, and no new rows under a `siphon-…` id. The Log chunks
read `call_started call_id=siphon-… direction=inbound node=… route=… from=… to=…`
and `call_ended call_id=siphon-… … cause=caller_hangup duration_ms=63164`; the
bridge id in the text is the join to the CDR and the node's own logs.
- **No STIR/SHAKEN chunk** — expected: it ships only with
  `[security.stir_shaken].enabled`, which our node does not set.
- **The HEP auth key is not enforced.** heplify-server 1.59.6 has no auth-key
  setting at all (its startup config dump lists none); `HEPLIFYSERVER_HEPAUTHKEY`
  is ignored and it accepts HEP from anything that reaches 9060/udp. The node
  still sends the key, and the secret still gates the node's startup. The real
  control is the one that was always load-bearing: no public IP, and only the
  internal subnet reaches the port.
- **The CDR holds the recording's object key** (`s3://…-call-recordings/<date>/<call>.wav`)
  and its path on the node — a pointer, not a signed URL, useless without the
  bucket's HMAC keys. Still no audio in Homer.
- **UI admin password:** homer-app's flags are `-update-ui-user` /
  `-update-ui-password` and the binary is `/homer-app`. The first boot used the
  wrong ones and left admin/sipcapture; the startup script is fixed, and the
  rotated hash lives on the data disk.

## Cost

HEP emission is **free** on the node: SiphonAI's 0.48.10 load results measure it
at no measurable CPU cost per call, against recording at +81% and neural VAD at
+191%. Emission is best-effort and never blocks the audio path — a full queue
drops the packet and ticks a counter.

The collector VM is the real cost: one `e2-small` plus a 50 GB disk. Enabling
Homer also turns on **Cloud NAT** (`envs/dev` forces `enable_cloud_nat` while
`homer_enabled`) — the collector has no external IP, and it installs Docker and
pulls its images from the internet at boot. Without NAT it hangs on the Docker
install indefinitely (Private Google Access reaches Secret Manager, not
download.docker.com or Docker Hub). That is a few dollars a month: the gateway's
per-VM hour and its auto-allocated address.

**Pausing.** `down.sh` sets `homer_running = false` alongside the voice node:
the Homer VM and Cloud NAT are deleted, the 50 GB data disk and the reserved
internal address are kept. A paused Homer costs the disk (~$5/month) and
nothing else; `up.sh` rebuilds the VM at the same address onto the same
history, so the voice node's `[hep].collector` never changes across the cycle.
To stop paying for Homer entirely, set `homer_enabled = false` — that drops the
disk and the captures with it.
