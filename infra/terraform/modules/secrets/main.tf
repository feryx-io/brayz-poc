# Secret Manager secret *containers* only — values are added out-of-band with
# `gcloud secrets versions add` (see infra/terraform/README.md). Terraform never sees
# secret material. Each secret grants accessor to exactly the runtime SAs that need it.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

locals {
  # secret_id => list of runtime keys (matching service-accounts module) that may read it.
  # secret_id follows the config.example.toml convention: brayz-<env>-<vendor>-<key>.
  secrets = {
    "${var.name_prefix}-siphon-node-token"  = ["siphon-gateway", "orchestrator", "api"]
    "${var.name_prefix}-twilio-account-sid" = ["api"]
    "${var.name_prefix}-twilio-auth-token"  = ["api"]
    "${var.name_prefix}-openai-api-key"     = ["orchestrator"]
    # Deepgram: the orchestrator speaks with it; the API lists and previews voices.
    "${var.name_prefix}-deepgram-api-key"  = ["orchestrator", "api"]
    "${var.name_prefix}-anthropic-api-key" = ["orchestrator", "api"]
    # Full Postgres connection string for the API (built from the Cloud SQL
    # connection name + a user/password the operator sets out-of-band).
    "${var.name_prefix}-database-url" = ["api"]
    # HMAC secret SiphonAI signs its lifecycle webhooks with. Without a value
    # the API refuses every delivery, so recordings never get a playable URL.
    # Both ends read it: the node to sign, the API to verify.
    "${var.name_prefix}-siphon-webhook-secret" = ["siphon-gateway", "api"]
    # Stripe. Optional: an empty version means billing is simply off.
    "${var.name_prefix}-stripe-secret-key"     = ["api"]
    "${var.name_prefix}-stripe-webhook-secret" = ["api"]
    # HMAC keys for the call-recording bucket, one identity per side (values are
    # written by the recording-bucket module). The API's key signs playback URLs
    # and can only read; the node's key uploads and can only create.
    "${var.name_prefix}-recording-s3-access-key"     = ["api"]
    "${var.name_prefix}-recording-s3-secret-key"     = ["api"]
    "${var.name_prefix}-recording-upload-access-key" = ["siphon-gateway"]
    "${var.name_prefix}-recording-upload-secret-key" = ["siphon-gateway"]
    # HEP capture. The auth key is shared by both ends: the voice node sends it
    # as HEP chunk 0x0011, the collector checks it. The other two are Homer's
    # own — its Postgres password and its UI admin password — read by the
    # collector VM at boot. `homer` is not a Cloud Run runtime, so these grant
    # to the collector's own SA rather than to a service.
    "${var.name_prefix}-hep-password"         = ["siphon-gateway", "homer"]
    "${var.name_prefix}-homer-db-password"    = ["homer"]
    "${var.name_prefix}-homer-admin-password" = ["homer"]
  }

  # Flatten (secret, runtime) into accessor bindings.
  accessor_pairs = merge([
    for secret_id, runtimes in local.secrets : {
      for rt in runtimes : "${secret_id}|${rt}" => {
        secret_id = secret_id
        runtime   = rt
      }
    }
  ]...)
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = local.accessor_pairs

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value.secret_id].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_emails[each.value.runtime]}"
}
