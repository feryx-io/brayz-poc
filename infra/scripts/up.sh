#!/usr/bin/env bash
# Bring the dev environment up — from a paused one, or from nothing.
#
#   PROJECT=brayz-dev ./infra/scripts/up.sh
#   ./infra/scripts/up.sh --skip-deploy     # infra + database only
#   ./infra/scripts/up.sh --seed            # also load the demo tenant
#
# Every step is idempotent, so this is also the "did that work?" command: run it
# again and it will fix whatever drifted and tell you what it found.
#
# It does, in order:
#   1. terraform apply, secrets only — the containers have to exist first
#   2. generates the shared secrets Brayz owns, if they have no value yet
#   3. gives every optional secret a placeholder version, so Cloud Run can start
#   3b. terraform apply for everything else (unpauses the database, recreates
#       the voice VM, creates the Cloud Run services against those secrets)
#   4. creates/updates the `brayz` SQL user and writes DATABASE_URL
#   5. runs migrations through the Cloud SQL Auth Proxy
#   6. builds and deploys the three services
#   7. prints what you need to point Twilio, SiphonAI, and Stripe at
#
# Vendor keys it CANNOT invent (Anthropic, Deepgram, Twilio) are reported as
# missing with the exact command to set them, rather than silently deploying a
# bot that cannot speak.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ENV_DIR="$ROOT/infra/terraform/envs/dev"
PROJECT="${PROJECT:-brayz-dev}"
REGION="${REGION:-us-east4}"
PREFIX="${PREFIX:-$PROJECT}"
SKIP_DEPLOY=0
SEED=0
for arg in "$@"; do
  case "$arg" in
    --skip-deploy) SKIP_DEPLOY=1 ;;
    --seed) SEED=1 ;;
    *)
      echo "Usage: up.sh [--skip-deploy] [--seed]" >&2
      exit 2
      ;;
  esac
done

for tool in terraform gcloud node npm curl openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: $tool is not installed." >&2
    exit 1
  }
done
gcloud auth print-access-token >/dev/null 2>&1 || {
  echo "ERROR: not authenticated. Run: gcloud auth login && gcloud auth application-default login" >&2
  exit 1
}

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- secret helpers ---------------------------------------------------------

secret_has_version() {
  gcloud secrets versions list "$1" --project "$PROJECT" --limit 1 --format='value(name)' 2>/dev/null | grep -q .
}

# Add a version only if the secret has none, so re-running never rotates a
# working key out from under a deployed service.
seed_secret() {
  local name="$1" value="$2" label="$3"
  if secret_has_version "$name"; then return 0; fi
  # Secret Manager rejects an empty payload outright ("Secret Payload cannot be
  # empty"), so a placeholder cannot literally be "". A newline is the smallest
  # thing it will store, and @brayz/config's optionalSecret trims before
  # deciding, so whitespace reads as "not configured" exactly as "" would —
  # which is the whole point of the placeholder: Cloud Run refuses to start on a
  # secret with NO version, but is happy with one that means nothing.
  printf '%s' "${value:-$'\n'}" |
    gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null
  echo "    seeded $name ($label)"
}

# --- 1. infrastructure ------------------------------------------------------

say "Applying Terraform (secret containers)"
cd "$ENV_DIR"
[ -f backend.hcl ] || {
  echo "ERROR: backend.hcl is missing. Copy backend.hcl.example and set the bucket" >&2
  echo "       from the one-time bootstrap (infra/terraform/README.md)." >&2
  exit 1
}
terraform init -backend-config=backend.hcl -input=false >/dev/null

# The secret CONTAINERS have to exist before the versions can be added, and the
# versions have to exist before Cloud Run will start — a service whose env
# references a secret with no version fails to create. All three are in the same
# root module, so a single apply orders them wrong and the first build of a new
# environment dies on the API service. Hence a targeted apply for the secrets,
# the seeding below, and only then everything else.
terraform apply -input=false -target=module.secrets
cd "$ROOT"

# --- 2 & 3. secrets ---------------------------------------------------------

say "Checking secrets"

# Shared secrets Brayz owns both ends of — no reason to make a human invent them.
seed_secret "${PREFIX}-siphon-node-token" "$(openssl rand -hex 32)" "generated"
seed_secret "${PREFIX}-siphon-webhook-secret" "$(openssl rand -hex 32)" "generated"

# Optional integrations. A Cloud Run service refuses to start on a secret with
# no version at all, so each gets an empty placeholder; the API reads empty as
# "not configured" and leaves the feature off.
for optional in stripe-secret-key stripe-webhook-secret recording-s3-access-key recording-s3-secret-key; do
  seed_secret "${PREFIX}-${optional}" "" "placeholder — feature stays off"
done

# Vendor keys nobody can generate for you.
MISSING=()
for required in anthropic-api-key deepgram-api-key twilio-account-sid twilio-auth-token openai-api-key; do
  secret_has_version "${PREFIX}-${required}" || MISSING+=("${PREFIX}-${required}")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo
  echo "  These have no value yet. The services will deploy, but the features"
  echo "  behind them will not work:"
  for m in "${MISSING[@]}"; do
    echo "    printf '%s' \"\$KEY\" | gcloud secrets versions add $m --project=$PROJECT --data-file=-"
  done
fi

# --- 3b. the rest of the infrastructure -------------------------------------

say "Applying Terraform (everything else)"
cd "$ENV_DIR"

# A Cloud Run revision that fails to start is never retried, and the service
# spec that produced it is already what Terraform wants — so a later apply plans
# no change and re-reports the dead revision forever. The service can only be
# recovered by replacing it, which Terraform will not do on its own. Taint the
# ones with no ready revision and apply again, so a transient failure (a secret
# that had no version yet, a cold dependency) costs a retry instead of a manual
# rescue.
heal_dead_services() {
  local healed=0 svc name ready
  for svc in api orchestrator web; do
    name="$PREFIX-$svc"
    gcloud run services describe "$name" --project "$PROJECT" --region "$REGION" \
      --format='value(name)' >/dev/null 2>&1 || continue
    ready="$(gcloud run services describe "$name" --project "$PROJECT" --region "$REGION" \
      --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
    if [ -z "$ready" ]; then
      echo "    $name has no ready revision — tainting so it is rebuilt"
      terraform taint "module.cloud_run_$svc.google_cloud_run_v2_service.svc" >/dev/null 2>&1 && healed=1
    fi
  done
  return $(( healed == 1 ? 0 : 1 ))
}

# Applied with defaults on purpose: `down.sh` pauses via CLI -var flags, which
# Terraform does not persist, so a plain apply is what brings everything back.
if ! terraform apply -input=false; then
  say "Apply failed — checking for Cloud Run services stuck on a dead revision"
  if heal_dead_services; then
    terraform apply -input=false
  else
    echo "  Nothing self-healable. The error above is the one to read." >&2
    exit 1
  fi
fi

CONN="$(terraform output -raw cloudsql_connection_name)"
SIPHON_IP="$(terraform output -raw siphon_static_ip 2>/dev/null || echo '')"
cd "$ROOT"

# --- 4. database user + DATABASE_URL ---------------------------------------

say "Database user"
DB_PW_SECRET="${PREFIX}-db-password"
# The password lives in its own secret so a rebuilt instance can reuse it and
# DATABASE_URL stays reproducible.
if ! gcloud secrets describe "$DB_PW_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$DB_PW_SECRET" --project "$PROJECT" --replication-policy=automatic >/dev/null
fi
if ! secret_has_version "$DB_PW_SECRET"; then
  printf '%s' "$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)" |
    gcloud secrets versions add "$DB_PW_SECRET" --project "$PROJECT" --data-file=- >/dev/null
  echo "    generated a database password"
fi
DB_PW="$(gcloud secrets versions access latest --secret "$DB_PW_SECRET" --project "$PROJECT")"

INSTANCE="${CONN##*:}"
if gcloud sql users list --instance "$INSTANCE" --project "$PROJECT" --format='value(name)' 2>/dev/null | grep -qx brayz; then
  gcloud sql users set-password brayz --instance "$INSTANCE" --project "$PROJECT" --password "$DB_PW" >/dev/null
  echo "    user 'brayz' already existed — password reset to the stored one"
else
  gcloud sql users create brayz --instance "$INSTANCE" --project "$PROJECT" --password "$DB_PW" >/dev/null
  echo "    created user 'brayz'"
fi

# Cloud Run reaches Postgres over the Cloud SQL unix socket, so the URL embeds
# the connection name rather than a host.
DATABASE_URL="postgresql://brayz:${DB_PW}@localhost/brayz?host=/cloudsql/${CONN}&schema=public"
printf '%s' "$DATABASE_URL" |
  gcloud secrets versions add "${PREFIX}-database-url" --project "$PROJECT" --data-file=- >/dev/null
echo "    wrote ${PREFIX}-database-url"

# --- 5. migrations ----------------------------------------------------------

say "Migrations"
PROXY="$ROOT/.cache/cloud-sql-proxy"
if [ ! -x "$PROXY" ]; then
  mkdir -p "$(dirname "$PROXY")"
  echo "    downloading cloud-sql-proxy"
  curl -fsSL -o "$PROXY" \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64"
  chmod +x "$PROXY"
fi

# Find a port nothing else holds. 5433 is not safe to assume: a Debian box with
# a local Postgres cluster puts it there (5432 being taken), and a dev machine
# running the compose stack has both. The old code bound 5433 blind, and the
# readiness probe below cannot tell our proxy from whatever else answers — so a
# clash meant migrations ran against a STRANGER'S DATABASE. That failed loudly
# here only because the passwords differed; a local `brayz` role with the same
# password would have migrated the wrong database in silence.
PROXY_PORT=""
for candidate in $(seq 5433 5460); do
  if ! (exec 3<>/dev/tcp/127.0.0.1/"$candidate") 2>/dev/null; then
    PROXY_PORT="$candidate"
    break
  fi
done
if [ -z "$PROXY_PORT" ]; then
  echo "ERROR: no free port in 5433-5460 for the Cloud SQL proxy." >&2
  exit 1
fi

"$PROXY" "$CONN" --port "$PROXY_PORT" >/tmp/cloud-sql-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null && break
  sleep 1
done

# The port answering is not proof our proxy is the one answering. Check the
# process we started is still alive: if it lost a race for the port, or failed
# to authorize, it has already exited and anything we do next talks to the
# wrong server.
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "ERROR: the Cloud SQL proxy exited. Last lines of /tmp/cloud-sql-proxy.log:" >&2
  tail -5 /tmp/cloud-sql-proxy.log >&2
  exit 1
fi
echo "    proxy on 127.0.0.1:$PROXY_PORT -> $CONN"

export DATABASE_URL="postgresql://brayz:${DB_PW}@127.0.0.1:${PROXY_PORT}/brayz?schema=public"
npm --workspace @brayz/db run generate >/dev/null
npm --workspace @brayz/db run migrate:deploy
if [ "$SEED" = "1" ]; then
  echo "    seeding the demo tenant"
  npm --workspace @brayz/db run seed
fi
kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT

# --- 6. deploy --------------------------------------------------------------

if [ "$SKIP_DEPLOY" = "0" ]; then
  say "Building and deploying"
  PROJECT="$PROJECT" REGION="$REGION" "$ROOT/infra/scripts/deploy-cloud-run.sh"
else
  echo
  echo "Skipped the build/deploy (--skip-deploy)."
fi

# --- 7. what to point where -------------------------------------------------

url_of() {
  gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true
}
API_URL="$(url_of "${PROJECT}-api")"
ORCH_URL="$(url_of "${PROJECT}-orchestrator")"
WEB_URL="$(url_of "${PROJECT}-web")"

say "Up"
cat <<EOF
  Web            ${WEB_URL:-(not deployed)}
  API            ${API_URL:-(not deployed)}
  Orchestrator   ${ORCH_URL:-(not deployed)}

  SiphonAI       [bridge].ws_url = ${ORCH_URL/https:/wss:}/v1/media
                 [webhooks].url  = ${API_URL}/v1/webhooks/siphon
                 [webhooks].secret = (value of ${PREFIX}-siphon-webhook-secret)
  Stripe         webhook endpoint = ${API_URL}/v1/webhooks/stripe
EOF

if [ -n "$SIPHON_IP" ]; then
  cat <<EOF
  Voice VM       ${SIPHON_IP}
                 Reserved separately from the VM, so this address survives a
                 './down.sh' pause and Twilio needs no changes. It only moves
                 if you released it with --destroy/--all or
                 reserve_voice_static_ip=false.
EOF
else
  echo "  Voice VM       not deployed (enable_voice_node=false)"
  echo "                 Its static IP is still reserved unless you released it."
fi

# Homer (optional HEP collector) has no public route; the tunnel is the way in.
HOMER_TUNNEL="$(terraform -chdir="$ROOT/infra/terraform/envs/dev" output -raw homer_ui_tunnel_command 2>/dev/null || true)"
if [ -n "$HOMER_TUNNEL" ]; then
  echo "  Homer          ${HOMER_TUNNEL}"
  echo "                 then http://localhost:9080 (admin / ${PREFIX}-homer-admin-password)"
fi

echo
echo "  Pause it again with: ./infra/scripts/down.sh"
