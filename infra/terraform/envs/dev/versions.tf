terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Remote state in the GCS bucket created by ../../bootstrap. Bucket name is supplied at
  # init time: `terraform init -backend-config=backend.hcl` (see backend.hcl.example).
  backend "gcs" {
    prefix = "envs/dev"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
