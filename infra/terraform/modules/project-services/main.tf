# Enables the GCP APIs the platform needs. Enabling them now (even for services not yet
# managed by Terraform) means the Cloud SQL / Redis / Pub/Sub / Cloud Run modules can be
# added later without a separate enablement step.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

locals {
  required_apis = [
    "compute.googleapis.com",        # Siphon-AI VMs, VPC, firewall, static IPs
    "iam.googleapis.com",            # service accounts
    "iamcredentials.googleapis.com", # impersonation / workload identity
    "cloudresourcemanager.googleapis.com",
    "secretmanager.googleapis.com",     # vendor + node secrets
    "storage.googleapis.com",           # recordings, voice assets, exports, TF state
    "run.googleapis.com",               # api / orchestrator / worker (Cloud Run)
    "artifactregistry.googleapis.com",  # container images for Cloud Run
    "vpcaccess.googleapis.com",         # Cloud Run -> VPC connector
    "servicenetworking.googleapis.com", # Cloud SQL private IP peering
    "sqladmin.googleapis.com",          # Cloud SQL (Postgres + pgvector)
    "redis.googleapis.com",             # Memorystore (ephemeral state)
    "pubsub.googleapis.com",            # event backbone
    "cloudscheduler.googleapis.com",    # scheduled jobs (recording retention sweep)
    "identitytoolkit.googleapis.com",   # Identity Platform / Firebase Auth (user login)
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
    "clouderrorreporting.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.required_apis)

  project = var.project_id
  service = each.value

  # Don't tear down APIs (and the resources depending on them) on `destroy`.
  disable_on_destroy         = false
  disable_dependent_services = false
}
