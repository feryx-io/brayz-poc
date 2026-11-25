# All null when the collector is disabled, so a caller can print "not deployed"
# rather than failing to plan.
output "instance_name" {
  value = one(google_compute_instance.homer[*].name)
}

output "zone" {
  value = one(google_compute_instance.homer[*].zone)
}

# What SiphonAI's [hep].collector points at. Internal address: the node reaches
# it across the VPC, and nothing outside the VPC can. Read from the reserved
# address, not the instance, so it stays known while the VM is being replaced —
# an unknown here would plan a voice-node replacement for nothing.
output "collector" {
  description = "host:port for [hep].collector on the voice node."
  value = one(google_compute_address.internal[*].address) == null ? null : (
    "${one(google_compute_address.internal[*].address)}:${var.hep_port}"
  )
}

output "internal_ip" {
  value = one(google_compute_address.internal[*].address)
}

# The UI has no public route on purpose. This is how you open it.
output "ui_tunnel_command" {
  value = one(google_compute_instance.homer[*].name) == null ? null : join(" ", [
    "gcloud compute start-iap-tunnel",
    one(google_compute_instance.homer[*].name),
    tostring(var.ui_port),
    "--local-host-port=localhost:${var.ui_port}",
    "--zone=${var.zone}",
    "--project=${var.project_id}",
  ])
}
