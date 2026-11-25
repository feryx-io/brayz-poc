# Call-recording storage: the bucket SiphonAI uploads to and the API signs
# playback URLs against.
#
# SiphonAI speaks S3 (path-style PUT, SigV4) and the API's presigner speaks S3,
# so both reach the bucket through GCS's S3-interoperability endpoint with HMAC
# keys rather than through the GCS-native API. That keeps the node and the API
# portable across S3/R2/MinIO (CLAUDE.md rule #2) at the cost of one indirection
# here: each side gets an HMAC key minted for its own service account, and the
# bucket IAM decides what that identity may do — the node can only create
# objects, the API can only read them.
#
# Secret material note. This module is the one place Terraform handles a secret
# value: an HMAC key's secret exists only in the create response, so the choice
# is Terraform writing it straight into Secret Manager (below) or an operator
# copying it by hand. It went unbuilt for weeks as a by-hand step, so Terraform
# does it — the state bucket is private to the same people who can read the
# secrets anyway. Nothing here is committed or baked into an image.
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_storage_bucket" "recordings" {
  project  = var.project_id
  name     = "${var.project_id}-call-recordings" # project ids are globally unique, so this is too
  location = var.region

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy

  # The platform ceiling on retention: the daemon deletes its local copy after
  # a durable upload and never schedules deletion in the bucket, so this rule
  # is what finally removes a recording. A location that wants less keeps it
  # in `recordingRetentionDays`, which the API's hourly sweep enforces; the
  # API refuses a value above this one.
  lifecycle_rule {
    condition {
      age = var.retention_days
    }
    action {
      type = "Delete"
    }
  }
}

# The voice node writes recordings and nothing else — objectCreator cannot read,
# list, overwrite or delete.
resource "google_storage_bucket_iam_member" "uploader" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${var.uploader_sa_email}"
}

# The API signs GET URLs for the dashboard (and deletes on retention — below).
resource "google_storage_bucket_iam_member" "reader" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.reader_sa_email}"
}

# The API also runs the per-location retention sweep, which needs to delete
# objects and nothing more. No predefined role stops at "delete" — objectUser
# and objectAdmin both bring create and overwrite — so this is a custom role
# with the one permission, bound on this bucket alone.
resource "google_project_iam_custom_role" "recording_deleter" {
  project     = var.project_id
  role_id     = "recordingDeleter"
  title       = "Call recording deleter"
  description = "Delete call-recording objects (retention sweep). No read, list, create or overwrite."
  permissions = ["storage.objects.delete"]
}

resource "google_storage_bucket_iam_member" "deleter" {
  bucket = google_storage_bucket.recordings.name
  role   = google_project_iam_custom_role.recording_deleter.id
  member = "serviceAccount:${var.reader_sa_email}"
}

resource "google_storage_hmac_key" "uploader" {
  project               = var.project_id
  service_account_email = var.uploader_sa_email
}

resource "google_storage_hmac_key" "reader" {
  project               = var.project_id
  service_account_email = var.reader_sa_email
}

# The secret containers come from the secrets module (with their accessor
# bindings); this module only adds the versions.
resource "google_secret_manager_secret_version" "uploader_access_key" {
  secret      = var.uploader_access_key_secret
  secret_data = google_storage_hmac_key.uploader.access_id
}

resource "google_secret_manager_secret_version" "uploader_secret_key" {
  secret      = var.uploader_secret_key_secret
  secret_data = google_storage_hmac_key.uploader.secret
}

resource "google_secret_manager_secret_version" "reader_access_key" {
  secret      = var.reader_access_key_secret
  secret_data = google_storage_hmac_key.reader.access_id
}

resource "google_secret_manager_secret_version" "reader_secret_key" {
  secret      = var.reader_secret_key_secret
  secret_data = google_storage_hmac_key.reader.secret
}
