variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "name_prefix" {
  description = "Resource name prefix, e.g. \"brayz-dev\"."
  type        = string
}

variable "enabled" {
  description = "Build the collector at all. Off means no VM, no disk, no cost."
  type        = bool
  default     = false
}

variable "running" {
  description = <<-EOT
    Run the collector VM. False deletes the VM only — the data disk and the
    reserved address stay (they follow `enabled`), so a pause keeps capture
    history and the collector address, and resuming changes nothing on the
    voice node. down.sh sets this false.
  EOT
  type        = bool
  default     = true
}

variable "machine_type" {
  description = <<-EOT
    Homer is three containers and a Postgres; e2-small handles a dev node's
    traffic. Raise it before pointing production volume at this box.
  EOT
  type        = string
  default     = "e2-small"
}

variable "boot_image" {
  type    = string
  default = "debian-cloud/debian-12"
}

variable "boot_disk_gb" {
  type    = number
  default = 20
}

variable "data_disk_gb" {
  description = <<-EOT
    Postgres data lives here, not on the boot disk, so replacing the VM (a
    startup-script change, a machine-type bump) keeps the capture history. A
    `terraform destroy` still removes it — this survives rebuilds, not teardowns.
  EOT
  type        = number
  default     = 50
}

variable "subnet_self_link" {
  type = string
}

variable "network_tag" {
  description = "Tag the IAP firewall rule targets. The VM has no public IP."
  type        = string
}

variable "service_account_email" {
  type = string
}

variable "hep_port" {
  description = "UDP port heplify-server listens on. 9060 is the HEP convention."
  type        = number
  default     = 9060
}

variable "ui_port" {
  description = "Homer web UI, reachable only by IAP TCP forwarding."
  type        = number
  default     = 9080
}

variable "retention_days" {
  description = <<-EOT
    Days of capture heplify-server keeps before dropping the partition.

    This is the whole retention story for HEP data: every INVITE carries the
    caller's number, so Homer holds guest PII with none of Brayz's tenant
    scoping, audit trail, or per-location retention. Keep it short.
  EOT
  type        = number
  default     = 14
}

variable "hep_password_secret" {
  description = "Secret Manager id holding the HEP auth key both ends share."
  type        = string
}

variable "db_password_secret" {
  description = "Secret Manager id holding Homer's Postgres password."
  type        = string
}

variable "admin_password_secret" {
  description = <<-EOT
    Secret Manager id holding the Homer UI's admin password. An empty version
    leaves the upstream default (admin/sipcapture) in place and the startup
    script says so loudly — acceptable only because the box has no public IP
    and the UI is reachable only through IAP.
  EOT
  type        = string
}
