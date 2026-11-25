variable "project_id" {
  description = "GCP project that will host the Terraform state bucket (e.g. brayz-dev)."
  type        = string
}

variable "region" {
  description = "Region for the state bucket. Match the primary platform region."
  type        = string
  default     = "us-east4"
}

variable "state_bucket_name" {
  description = "Override the state bucket name. Defaults to <project_id>-tf-state."
  type        = string
  default     = null
}
