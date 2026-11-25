variable "project_id" {
  type = string
}

variable "name_prefix" {
  description = "Secret name prefix, e.g. \"brayz-dev\"."
  type        = string
}

variable "runtime_sa_emails" {
  description = "Map of runtime key (api, orchestrator, worker, siphon-gateway) => SA email."
  type        = map(string)
}
