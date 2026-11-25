output "siphon_static_ip" {
  description = "Siphon-AI VM static public IP — Twilio origination URI + node config.toml external_ip."
  value       = module.siphon_node.static_ip
}

output "siphon_instance" {
  description = "Siphon-AI VM name and zone (for `gcloud compute ssh` / scp of the binary)."
  value = {
    name = module.siphon_node.instance_name
    zone = module.siphon_node.zone
  }
}

output "service_account_emails" {
  description = "Per-runtime service account emails."
  value       = module.service_accounts.emails
}

output "secret_ids" {
  description = "Secret Manager containers created (add values with `gcloud secrets versions add`)."
  value       = module.secrets.secret_ids
}

output "network_self_link" {
  value = module.network.network_self_link
}

output "artifact_registry_url" {
  description = "Docker repo to push images to (REGION-docker.pkg.dev/PROJECT/REPO)."
  value       = module.artifact_registry.repository_url
}

output "cloudsql_connection_name" {
  description = "project:region:instance — for DATABASE_URL ?host=/cloudsql/... and the auth proxy."
  value       = module.cloud_sql.connection_name
}

output "api_url" {
  description = "Public API URL (set as the Orchestrator's API_INTERNAL_URL automatically)."
  value       = module.cloud_run_api.uri
}

output "orchestrator_url" {
  description = "Public Orchestrator URL. SiphonAI [bridge].ws_url = wss://<host>/v1/media."
  value       = module.cloud_run_orchestrator.uri
}

output "web_url" {
  description = "Public admin portal + marketing site URL."
  value       = module.cloud_run_web.uri
}

output "web_domain_dns_records" {
  description = "DNS records to create at the registrar for each mapped web domain."
  value = {
    for d, m in google_cloud_run_domain_mapping.web :
    d => [for r in m.status[0].resource_records : { type = r.type, name = r.name, value = r.rrdata }]
  }
}

output "homer_collector" {
  description = "Homer's HEP collector (internal host:port), rendered into the voice node's [hep].collector. Null when homer_enabled is off."
  value       = module.homer_node.collector
}

output "homer_ui_tunnel_command" {
  description = "The IAP tunnel to the Homer UI (it has no public route). Null when Homer is off or paused."
  value       = module.homer_node.ui_tunnel_command
}

output "recording_bucket" {
  description = "Call-recording bucket (empty when recording is off)."
  value       = var.recording_enabled ? module.recording_bucket[0].bucket : ""
}
