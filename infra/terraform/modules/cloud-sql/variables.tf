variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name_prefix" {
  description = "Resource name prefix, e.g. \"brayz-dev\"."
  type        = string
}

variable "edition" {
  description = "Cloud SQL edition. ENTERPRISE allows shared-core tiers; ENTERPRISE_PLUS needs db-perf-optimized-* tiers."
  type        = string
  default     = "ENTERPRISE"
}

variable "tier" {
  description = "Cloud SQL machine tier. db-f1-micro (shared core, ENTERPRISE only) is fine for dev."
  type        = string
  default     = "db-f1-micro"
}

variable "disk_size_gb" {
  type    = number
  default = 10
}

variable "deletion_protection" {
  description = "Block accidental instance deletion. Keep true outside throwaway dev."
  type        = bool
  default     = true
}

variable "backups_enabled" {
  description = "Automated backups. Off for a scratch environment that gets destroyed."
  type        = bool
  default     = true
}

variable "running" {
  description = "False stops the instance (activation_policy NEVER): no compute billing, data kept."
  type        = bool
  default     = true
}

variable "instance_name" {
  description = <<-EOT
    Adopt an existing instance by name instead of creating a suffixed one.

    Normally the instance is "<name_prefix>-pg-<random>" so a destroyed
    environment can be rebuilt without waiting out Cloud SQL's week-long name
    lock. That suffix cannot be applied to an instance that already exists:
    the name forces replacement, and a replacement takes the data with it.

    Set this to the existing instance's name to keep it. Clear it after a
    --destroy so the next build goes back to fresh suffixed names.
  EOT
  type        = string
  default     = null
}
