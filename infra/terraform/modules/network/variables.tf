variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name_prefix" {
  description = "Prefix for network resource names, e.g. \"brayz-dev\"."
  type        = string
}

variable "subnet_cidr" {
  description = "Primary subnet CIDR."
  type        = string
  default     = "10.20.0.0/20"
}

variable "siphon_tag" {
  description = "Network tag applied to Siphon-AI VMs; SIP/RTP/SSH rules target it."
  type        = string
  default     = "siphon-ai"
}

variable "sip_port" {
  description = "SIP signaling port."
  type        = number
  default     = 5060
}

variable "rtp_port_min" {
  description = "Low end of the fixed RTP media port range."
  type        = number
  default     = 20000
}

variable "rtp_port_max" {
  description = "High end of the fixed RTP media port range."
  type        = number
  default     = 30000
}

variable "twilio_sip_source_ranges" {
  description = <<-EOT
    Twilio SIP *signaling* source CIDRs allowed to reach SIP/:5060. VERIFY against
    https://www.twilio.com/docs/sip-trunking/ip-addresses before apply — stale ranges
    silently drop inbound calls.
  EOT
  type        = list(string)
}

variable "twilio_media_source_ranges" {
  description = <<-EOT
    Twilio *media* (RTP) source CIDRs allowed to reach the RTP range. VERIFY against
    https://www.twilio.com/docs/sip-trunking/ip-addresses before apply.
  EOT
  type        = list(string)
}

variable "enable_cloud_nat" {
  description = "Cloud NAT for instances with no external IP. Bills hourly whether used or not."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "VPC flow logs. Bills on log ingestion; off for a scratch environment."
  type        = bool
  default     = false
}

variable "homer_tag" {
  description = <<-EOT
    Network tag on the Homer collector VM. It has no public IP, so the only
    ingress is the IAP rule this tag targets — SSH plus the web UI, both
    reached with `gcloud compute start-iap-tunnel`.
  EOT
  type        = string
  default     = "homer-collector"
}

variable "homer_ui_port" {
  description = "Homer web UI port opened to IAP only. Matches the homer-node module."
  type        = number
  default     = 9080
}
