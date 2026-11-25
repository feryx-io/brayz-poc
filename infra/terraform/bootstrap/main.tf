# One-time bootstrap: the GCS bucket that stores Terraform remote state for all envs.
# This config itself uses LOCAL state (chicken-and-egg) — commit nothing; the bucket is
# the durable artifact. Run once per state-hosting project.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_storage_bucket" "tf_state" {
  name     = coalesce(var.state_bucket_name, "${var.project_id}-tf-state")
  location = var.region
  project  = var.project_id

  # State is sensitive and must never be world-readable or accidentally deleted.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  # Keep a bounded history of state versions rather than unbounded growth.
  lifecycle_rule {
    condition {
      num_newer_versions = 20
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
