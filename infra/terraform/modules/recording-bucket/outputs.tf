output "bucket" {
  description = "Bucket name."
  value       = google_storage_bucket.recordings.name
}

output "endpoint" {
  description = "S3-compatible endpoint both the node and the API talk to."
  value       = "https://storage.googleapis.com"
}

output "signing_region" {
  description = "Region in the SigV4 credential scope. GCS accepts any value; \"auto\" is its documented choice for the interop endpoint."
  value       = "auto"
}

# The node reads these secret names at boot. Derived from the version
# resources rather than passed through, so a node that renders them cannot
# boot before the values exist.
output "uploader_access_key_secret_name" {
  value = regex("[^/]+$", google_secret_manager_secret_version.uploader_access_key.secret)
}

output "uploader_secret_key_secret_name" {
  value = regex("[^/]+$", google_secret_manager_secret_version.uploader_secret_key.secret)
}
