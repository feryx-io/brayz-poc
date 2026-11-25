variable "project_id" {
  type = string
}

variable "region" {
  description = "Bucket location. Same region as the node and the API, so uploads and playback stay local."
  type        = string
}

variable "uploader_sa_email" {
  description = "Service account of the SiphonAI voice node — gets objectCreator and an HMAC key."
  type        = string
}

variable "reader_sa_email" {
  description = "Service account of the API — gets objectViewer plus a delete-only custom role (retention sweep), and an HMAC key."
  type        = string
}

variable "uploader_access_key_secret" {
  description = "Secret Manager resource id (projects/…/secrets/…) that receives the node's HMAC access id."
  type        = string
}

variable "uploader_secret_key_secret" {
  description = "Secret Manager resource id that receives the node's HMAC secret."
  type        = string
}

variable "reader_access_key_secret" {
  description = "Secret Manager resource id that receives the API's HMAC access id."
  type        = string
}

variable "reader_secret_key_secret" {
  description = "Secret Manager resource id that receives the API's HMAC secret."
  type        = string
}

variable "retention_days" {
  description = "Platform ceiling: recordings older than this are deleted by the bucket lifecycle rule. Per-location policies can only be shorter."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to remove a non-empty bucket. True in dev, where the environment is torn down between sessions; false where recordings are records."
  type        = bool
  default     = false
}
