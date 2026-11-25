output "network_id" {
  value = google_compute_network.vpc.id
}

output "network_self_link" {
  value = google_compute_network.vpc.self_link
}

output "subnet_id" {
  value = google_compute_subnetwork.primary.id
}

output "subnet_self_link" {
  value = google_compute_subnetwork.primary.self_link
}

output "siphon_tag" {
  description = "Network tag the Siphon-AI VM must carry for SIP/RTP/SSH rules to apply."
  value       = var.siphon_tag
}

# The daemon's own config has to match these exactly: SIP on a port the firewall
# does not open never arrives, and an RTP range outside the rule sets calls up
# and then carries no audio. Exported so the node renders from the same values
# rather than a second list someone keeps in step by hand.
output "sip_port" {
  value = var.sip_port
}

output "rtp_port_min" {
  value = var.rtp_port_min
}

output "rtp_port_max" {
  value = var.rtp_port_max
}

output "homer_tag" {
  description = "Tag the Homer collector VM carries, targeted by the IAP rule."
  value       = var.homer_tag
}
