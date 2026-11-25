# One service account per runtime (CLAUDE.md: brayz-{api,orchestrator,worker,siphon-gateway}-sa),
# each with least-privilege project roles. Per-secret access is granted in the `secrets`
# module, not here, so secret access stays scoped to the specific secrets a runtime needs.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

locals {
  # account_id => { display, roles }
  service_accounts = {
    api = {
      display = "Brayz API (control plane)"
      roles = [
        "roles/cloudsql.client",
        "roles/pubsub.publisher",
        "roles/logging.logWriter",
        "roles/cloudtrace.agent",
        "roles/monitoring.metricWriter",
      ]
    }
    orchestrator = {
      display = "Brayz Conversation Orchestrator"
      roles = [
        "roles/cloudsql.client",
        "roles/pubsub.publisher",
        "roles/storage.objectAdmin", # call recordings / voice assets
        "roles/logging.logWriter",
        "roles/cloudtrace.agent",
        "roles/monitoring.metricWriter",
      ]
    }
    worker = {
      display = "Brayz Workers (Pub/Sub jobs)"
      roles = [
        "roles/cloudsql.client",
        "roles/pubsub.subscriber",
        "roles/pubsub.publisher",
        "roles/storage.objectAdmin",
        "roles/logging.logWriter",
        "roles/cloudtrace.agent",
        "roles/monitoring.metricWriter",
      ]
    }
    # Identity Cloud Scheduler invokes internal API jobs as. It holds no
    # project roles at all: its only power is that the API recognises the OIDC
    # tokens minted for it (SCHEDULER_INVOKER_EMAIL).
    scheduler = {
      display = "Brayz Cloud Scheduler (internal API jobs)"
      roles   = []
    }
    # The Homer/HEP collector VM. Like the gateway it is a thin box: it reads
    # three secrets at boot (granted in the secrets module) and writes logs and
    # metrics. It never touches the database, Pub/Sub, or object storage — a
    # SIP capture already holds enough that it should hold nothing else.
    homer = {
      display = "Brayz Homer HEP collector VM"
      roles = [
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter",
      ]
    }
    "siphon-gateway" = {
      display = "Brayz Siphon-AI voice gateway VM"
      # The VM is a thin media gateway: it reads its node token from Secret Manager
      # (granted in the secrets module) and writes logs/metrics. No DB, no Pub/Sub.
      roles = [
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter",
        "roles/cloudtrace.agent",
      ]
    }
  }

  # Flattened (account, role) pairs for the IAM binding fan-out.
  sa_role_pairs = merge([
    for acct, cfg in local.service_accounts : {
      for role in cfg.roles : "${acct}|${role}" => {
        acct = acct
        role = role
      }
    }
  ]...)
}

resource "google_service_account" "this" {
  for_each = local.service_accounts

  project      = var.project_id
  account_id   = "brayz-${each.key}-sa"
  display_name = each.value.display
}

resource "google_project_iam_member" "this" {
  for_each = local.sa_role_pairs

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.this[each.value.acct].email}"
}
