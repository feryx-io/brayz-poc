#!/usr/bin/env bash
# Build the API + Orchestrator + Web images in Cloud Build and roll them onto the
# Terraform-created Cloud Run services. Run AFTER `terraform apply` (which makes
# the registry, Cloud SQL, secrets, and the service shells) and after the
# required secret versions are populated (see infra/terraform/README.md).
#
# Usage:  PROJECT=brayz-dev REGION=us-east4 ./infra/scripts/deploy-cloud-run.sh
# Web auth mode (baked into the web image at build time): WEB_AUTH_MODE=dev|firebase
# For WEB_AUTH_MODE=firebase, also pass the public web config (from the Firebase console):
#   FIREBASE_API_KEY=AIza...  [FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com]  [FIREBASE_PROJECT_ID=<project>]
set -euo pipefail

PROJECT="${PROJECT:-brayz-dev}"
REGION="${REGION:-us-east4}"
REPO="${PROJECT}-containers"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
# Per-project deploy settings (public values), so a plain run of this script
# deploys the same auth mode as last time instead of quietly falling back to dev.
# Variables already set in the environment win over the file.
ENV_FILE="$(dirname "$0")/env/${PROJECT}.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . <(sed -E 's/^([A-Z_]+)=/\1=${\1:-/; s/$/}/' "$ENV_FILE" | grep -E '^[A-Z_]+=') ; set +a
fi
WEB_AUTH_MODE="${WEB_AUTH_MODE:-dev}"

# Firebase web config (public, baked into the client bundle at build time).
FIREBASE_API_KEY="${FIREBASE_API_KEY:-}"
FIREBASE_AUTH_DOMAIN="${FIREBASE_AUTH_DOMAIN:-${PROJECT}.firebaseapp.com}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-${PROJECT}}"
if [ "${WEB_AUTH_MODE}" = "firebase" ] && [ -z "${FIREBASE_API_KEY}" ]; then
  echo "ERROR: WEB_AUTH_MODE=firebase requires FIREBASE_API_KEY (Firebase console -> Project settings -> Your apps -> Web app)." >&2
  exit 1
fi

REG="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
IMAGE_API="${REG}/api:${TAG}"
IMAGE_ORCH="${REG}/orchestrator:${TAG}"
IMAGE_WEB="${REG}/web:${TAG}"

cd "$(git rev-parse --show-toplevel)"

# The web image bakes in the API URL at build time (NEXT_PUBLIC_*). The API
# service already exists (TF-created), so its URL is stable and known now.
API_URL="$(gcloud run services describe "${PROJECT}-api" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)' 2>/dev/null || true)"
if [ -z "${API_URL}" ]; then
  echo "ERROR: could not resolve the API URL — run 'terraform apply' first so the API service exists." >&2
  exit 1
fi
echo "==> Web will call API at: ${API_URL} (auth mode: ${WEB_AUTH_MODE})"

echo "==> Building images in Cloud Build (tag: ${TAG})"
gcloud builds submit --project "${PROJECT}" --config infra/cloudbuild.yaml \
  --substitutions "_IMAGE_API=${IMAGE_API},_IMAGE_ORCH=${IMAGE_ORCH},_IMAGE_WEB=${IMAGE_WEB},_API_URL=${API_URL},_AUTH_MODE=${WEB_AUTH_MODE},_FIREBASE_API_KEY=${FIREBASE_API_KEY},_FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},_FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}" .

echo "==> Deploying API"
gcloud run deploy "${PROJECT}-api" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE_API}" --quiet

echo "==> Deploying Orchestrator"
gcloud run deploy "${PROJECT}-orchestrator" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE_ORCH}" --quiet

echo "==> Deploying Web"
gcloud run deploy "${PROJECT}-web" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE_WEB}" --quiet

echo
echo "API URL:          ${API_URL}"
ORCH_URL="$(gcloud run services describe "${PROJECT}-orchestrator" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')"
echo "Orchestrator URL: ${ORCH_URL}"
echo "Point SiphonAI [bridge].ws_url at: ${ORCH_URL/https:/wss:}/v1/media"
echo "Web URL:          $(gcloud run services describe "${PROJECT}-web" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')"
