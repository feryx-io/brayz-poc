output "emails" {
  description = "Map of runtime key (api, orchestrator, worker, siphon-gateway) => SA email."
  value       = { for k, sa in google_service_account.this : k => sa.email }
}

output "siphon_gateway_email" {
  description = "Email of the Siphon-AI VM service account (attach to the instance)."
  value       = google_service_account.this["siphon-gateway"].email
}
