# A Cloud Run v2 service. Reused for the API and the Orchestrator.
#
# Image deployment is split from infra: Terraform owns the service shell (SA,
# env, secrets, scaling, Cloud SQL, ingress) and ignores the image, which the
# deploy script pushes and sets via `gcloud run deploy --image`. So the first
# apply uses a placeholder image and the service goes live on the first deploy.
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_cloud_run_v2_service" "svc" {
  name     = var.name
  project  = var.project_id
  location = var.region
  ingress  = var.ingress

  # The provider defaults this to true, which blocks any replacement — including
  # the forced one a previously failed create leaves behind as a tainted
  # resource. In an environment built to be torn down, that guard costs more
  # than it protects.
  deletion_protection = var.deletion_protection

  template {
    service_account                  = var.service_account_email
    timeout                          = "${var.timeout_seconds}s"
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = var.container_port
      }

      resources {
        # cpu_idle = true is Cloud Run's default: CPU only while a request is
        # being processed. That suits a REST service and is wrong for a live
        # call, where the work between messages — decoding audio, pacing 20 ms
        # playout, streaming a reply — is exactly what gets starved.
        cpu_idle = var.cpu_idle
        # Full CPU during startup, so the first call after a scale-up is not the
        # one that pays for module load and provider handshakes.
        startup_cpu_boost = var.startup_cpu_boost
      }

      # Plain (non-secret) environment.
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secret-backed environment (value pulled from Secret Manager at runtime).
      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # Cloud SQL unix socket at /cloudsql/<connection_name>.
      dynamic "volume_mounts" {
        for_each = length(var.cloudsql_instances) > 0 ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }

    dynamic "volumes" {
      for_each = length(var.cloudsql_instances) > 0 ? [1] : []
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = var.cloudsql_instances
        }
      }
    }
  }

  lifecycle {
    # The deploy script sets the real image; don't let Terraform revert it.
    ignore_changes = [template[0].containers[0].image]
  }
}

# Public invoker (the Orchestrator must be reachable by SiphonAI; the API by the
# dashboard + the Orchestrator). Auth is enforced in-app (Firebase + node secret).
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count    = var.allow_unauthenticated ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.svc.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
