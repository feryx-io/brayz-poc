# All null when the node is disabled, so a caller can print "not deployed"
# rather than failing to plan.
output "static_ip" {
  description = "The VM's static external IP — use for the Twilio origination URI and config.toml external_ip."
  value       = one(google_compute_address.siphon[*].address)
}

output "instance_name" {
  value = one(google_compute_instance.siphon[*].name)
}

output "instance_self_link" {
  value = one(google_compute_instance.siphon[*].self_link)
}

output "zone" {
  value = one(google_compute_instance.siphon[*].zone)
}
