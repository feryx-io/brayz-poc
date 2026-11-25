output "secret_ids" {
  description = "Created secret containers (values added out-of-band via gcloud)."
  value       = [for s in google_secret_manager_secret.this : s.secret_id]
}

output "secret_resource_ids" {
  description = "secret_id => full resource id (projects/…/secrets/…), for modules that add versions."
  value       = { for k, s in google_secret_manager_secret.this : k => s.id }
}
