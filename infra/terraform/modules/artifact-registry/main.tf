# Docker image registry for the Cloud Run services (API, Orchestrator).
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name_prefix}-containers"
  format        = "DOCKER"
  description   = "Brayz service container images"
}
