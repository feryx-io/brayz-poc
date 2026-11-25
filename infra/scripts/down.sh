#!/usr/bin/env bash
# Stop paying for the dev environment between test sessions.
#
#   ./infra/scripts/down.sh            # pause: stop the database, delete the VM
#   ./infra/scripts/down.sh --destroy  # also destroy the database (data is lost)
#   ./infra/scripts/down.sh --all      # destroy everything, secrets included
#
# The default is a PAUSE, not a teardown, because pausing is both cheaper to
# reverse and cheaper to hold:
#
#   Cloud SQL      stopped, not destroyed. Compute billing ends; the disk keeps
#                  the data. Starting it is a minute — a recreate would mean new
#                  migrations, a new seed, a new connection name, and Cloud SQL
#                  refusing to reuse the instance name for about a week.
#   Voice VM       destroyed. It is the largest hourly cost and it holds no
#                  state; the startup script rebuilds it. Its static IP is
#                  RESERVED SEPARATELY and kept, so the address Twilio dials
#                  survives and the rebuilt VM picks it up again.
#   Homer VM       destroyed too, when homer_enabled (homer_running=false),
#                  and Cloud NAT with it — nothing sends HEP while the voice VM
#                  is gone. Its data disk and reserved internal address are
#                  kept, so capture history survives and the voice node's
#                  [hep].collector is unchanged when it comes back.
#   Cloud Run      left up, so the URLs survive — SiphonAI's ws_url and Stripe's
#                  webhook endpoint stay valid instead of needing reconfiguration
#                  every cycle. The API and web scale to zero and cost nothing;
#                  the Orchestrator's warm instance (which exists so a caller is
#                  not waiting on a cold start) is dropped to zero here, since
#                  nothing is calling a paused environment.
#   Secrets        kept. Cents a month, and the values are the slowest thing to
#                  put back by hand.
#
# What that leaves is roughly Cloud SQL disk + Secret Manager + whatever images
# are in Artifact Registry — dollars a month rather than tens.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ENV_DIR="$ROOT/infra/terraform/envs/dev"
MODE="pause"
case "${1:-}" in
  --destroy) MODE="destroy" ;;
  --all) MODE="all" ;;
  "") ;;
  *)
    echo "Usage: down.sh [--destroy|--all]" >&2
    exit 2
    ;;
esac

command -v terraform >/dev/null 2>&1 || {
  echo "ERROR: terraform is not installed." >&2
  exit 1
}

cd "$ENV_DIR"
[ -f backend.hcl ] || {
  echo "ERROR: backend.hcl is missing — see infra/terraform/README.md." >&2
  exit 1
}
terraform init -backend-config=backend.hcl -input=false >/dev/null

case "$MODE" in
  pause)
    echo "==> Pausing: stopping Cloud SQL and removing the voice VM (and Homer's, if on)."
    terraform apply \
      -var=cloudsql_running=false \
      -var=enable_voice_node=false \
      -var=homer_running=false \
      -var=orchestrator_min_instances=0
    echo
    echo "Paused. The database is stopped with its data intact and every Cloud"
    echo "Run URL is unchanged."
    ;;
  destroy)
    echo "==> Destroying the database and the voice VM."
    echo "    THE DATABASE AND ITS DATA GO WITH IT. Cloud Run depends on the"
    echo "    instance, so those services are destroyed too and their URLs will"
    echo "    change on the next apply — SiphonAI and Stripe will need"
    echo "    repointing. './down.sh' with no flag avoids all of that."
    read -r -p "Type 'destroy' to continue: " confirm
    [ "$confirm" = "destroy" ] || {
      echo "Aborted."
      exit 1
    }
    # -target on the database takes its dependents with it, which is why the
    # Cloud Run URLs change; the VM is named explicitly because nothing
    # depends on it.
    # The static IP is inside module.siphon_node, so this drops it too and
    # Twilio will need the new address next time.
    terraform destroy -target=module.cloud_sql -target=module.siphon_node
    ;;
  all)
    echo "==> Destroying EVERYTHING in envs/dev, including Secret Manager."
    echo "    Coming back from this means re-entering every vendor key by hand."
    read -r -p "Type 'everything' to continue: " confirm
    [ "$confirm" = "everything" ] || {
      echo "Aborted."
      exit 1
    }
    terraform destroy
    ;;
esac

echo
echo "Bring it back with:  ./infra/scripts/up.sh"
