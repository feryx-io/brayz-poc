variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  description = "Cloud Run service name, e.g. \"brayz-dev-api\"."
  type        = string
}

variable "image" {
  description = "Container image. Defaults to a placeholder; the deploy script sets the real one."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "service_account_email" {
  type = string
}

variable "container_port" {
  type    = number
  default = 8080
}

variable "env" {
  description = "Plain environment variables."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Env var name -> Secret Manager secret id (latest version)."
  type        = map(string)
  default     = {}
}

variable "cloudsql_instances" {
  description = "Cloud SQL connection names to attach (mounts /cloudsql)."
  type        = list(string)
  default     = []
}

variable "ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_ALL"
}

variable "allow_unauthenticated" {
  type    = bool
  default = true
}

variable "timeout_seconds" {
  description = "Request timeout. The Orchestrator needs the max (3600) for long WebSocket calls."
  type        = number
  default     = 300
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 4
}

variable "concurrency" {
  type    = number
  default = 80
}

variable "deletion_protection" {
  description = "Terraform-side guard against destroying/replacing the service. False for throwaway envs."
  type        = bool
  default     = true
}

variable "cpu_idle" {
  description = "True throttles CPU to request processing (Cloud Run's default). False keeps it allocated — required for real-time media."
  type        = bool
  default     = true
}

variable "startup_cpu_boost" {
  description = "Full CPU during container startup, so a scale-up does not land its cost on the first caller."
  type        = bool
  default     = true
}
