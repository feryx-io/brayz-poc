output "state_bucket_name" {
  description = "Name of the GCS bucket holding Terraform remote state. Put this in each env's backend.hcl."
  value       = google_storage_bucket.tf_state.name
}
