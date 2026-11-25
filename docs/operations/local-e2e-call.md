# Local end-to-end call (no GCP, no Twilio)

Runs the whole voice path on one box: a SIP softphone → the external **SiphonAI**
bridge (`github.com/thevoiceguy/siphon-ai`, native binary) → the Brayz
**Orchestrator** WS server → the API → Postgres. Everything except PSTN ingress.
Cost: a few cents of Deepgram/Anthropic usage.

```
Softphone (LAN)  --SIP/RTP-->  siphon-ai :5060  --WS-->  orchestrator :4100
                                                              |
                                                     API :4000 -> Postgres
```

## 1. Data plane

```bash
docker compose up -d                      # postgres (+ redis if not on the host)
npm --workspace @brayz/db run migrate     # if the schema moved
npm --workspace @brayz/db run seed        # demo tenant "Mario's Pizza"
```

Provision a number for the seeded location. `toNumber` is validated as **E.164**
(`packages/shared` `EnsureCallInput`), so extension-style dialing (`5000`) is
rejected by the API — the softphone must dial the full number.

```sql
insert into phone_numbers (id,"tenantId","locationId","e164Number",provider,"inboundRouteType",active)
values (gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000b1',
        '+15185559898','lab','ai',true);
```

(The `/v1/locations/:id/phone-numbers/provision` route needs Twilio creds, hence
the direct insert for a lab fixture.)

## 2. Services

`@brayz/config` reads `.env` from the process CWD, so start from the repo root:

```bash
npm run build
node services/api/dist/main.js            # :4000
node services/orchestrator/dist/main.js    # :4100, media WS at /v1/media
```

The Orchestrator logs `Conversation engine disabled` unless **both**
`DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` are set — without them the media
plane still runs (call record + lifecycle), but nobody speaks.

## 3. SiphonAI

Config lives at `infra/local/siphon-ai.lab.toml` (bridge → `ws://127.0.0.1:4100/v1/media`,
registrar + digest auth on, G.711, catch-all route). Update `[node].public_address`
to this box's LAN IP.

```bash
export BRAYZ_LAB_SIP_PASSWORD=<softphone secret>
siphon-ai check  --config infra/local/siphon-ai.lab.toml
siphon-ai        --config infra/local/siphon-ai.lab.toml
```

## 4. Softphone

Linphone / Zoiper on the LAN:

- Domain / proxy: `<lan-ip>:5060` (UDP), username `phone1`, password
  `$BRAYZ_LAB_SIP_PASSWORD`. Registering is optional — SiphonAI answers a direct
  `sip:+15185559898@<lan-ip>` too — but the INVITE is digest-challenged either way.
- **Set the softphone's username/caller-ID to an E.164 number** if you want guest
  memory / loyalty recognition to fire: `fromNumber` is matched against
  `guest_phone_numbers`.
- Dial `+15185559898`.

Verify:

```bash
curl -s localhost:9091/metrics | grep siphon_ai_calls        # daemon
docker exec brayz-postgres psql -U brayz -d brayz -c 'select status,"fromNumber","toNumber" from calls order by "startedAt" desc limit 5;'
```

## Smoke test without a phone

`sipp` drives the same path headlessly (SIPp's `[authentication]` digest client
doesn't match SiphonAI's verify for a user-bearing Request-URI, so point it at a
copy of the config with `[sip.auth].enabled = false`):

```bash
sed 's#\(INVITE\|ACK\|BYE\) sip:\[remote_ip\]:\[remote_port\]#\1 sip:[service]@[remote_ip]:[remote_port]#' \
    <siphon-ai>/test-harness/sipp-scenarios/basic_call_then_bye.xml > /tmp/smoke.xml
sipp -i 127.0.0.1 -sf /tmp/smoke.xml -m 1 -s "+15185559898" 127.0.0.1:5062
```

A pass leaves one `completed` row in `calls` and a `call.answered` row in
`call_events`.
