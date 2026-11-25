variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  description = "Zone for the VM, e.g. us-east4-a."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix, e.g. \"brayz-dev\"."
  type        = string
}

variable "node_index" {
  description = "Node ordinal for naming/scaling, e.g. \"001\"."
  type        = string
  default     = "001"
}

variable "machine_type" {
  description = "VM machine type. e2-medium is fine for a low-volume dev node."
  type        = string
  default     = "e2-medium"
}

variable "boot_image" {
  description = "Boot image. SiphonAI ships static musl release builds, so any recent Debian works; 13 matches its published install docs."
  type        = string
  default     = "debian-cloud/debian-13"
}

variable "boot_disk_gb" {
  type    = number
  default = 20
}

variable "subnet_self_link" {
  description = "Self link of the subnet to attach the VM to."
  type        = string
}

variable "network_tag" {
  description = "Network tag carrying the SIP/RTP/SSH firewall rules."
  type        = string
}

variable "service_account_email" {
  description = "Service account to attach (brayz-siphon-gateway-sa)."
  type        = string
}

variable "enabled" {
  description = <<-EOT
    Create the voice-gateway VM.

    Set false to stop paying for the machine between test sessions. The
    reserved static IP is kept separately (see reserve_ip), so the address
    Twilio dials survives the teardown and the VM that comes back gets it again.
  EOT
  type        = bool
  default     = true
}

variable "reserve_ip" {
  description = <<-EOT
    Hold the node's static external IP.

    Kept even when the VM is gone, because the address is configured somewhere
    Brayz does not control — Twilio's origination URI — and re-pointing that on
    every rebuild is worse than the few dollars a month an unattached reserved
    address costs. Only set this false when you are finished with the project.
  EOT
  type        = bool
  default     = true
}

variable "siphon_version" {
  description = "SiphonAI release to install (github.com/thevoiceguy/siphon-ai). Bump to upgrade the node."
  type        = string
  default     = "0.50.1"
}

variable "ws_url" {
  description = "Orchestrator media WebSocket the bridge connects to, e.g. wss://host/v1/media."
  type        = string
}

variable "node_token_secret" {
  description = "Secret Manager secret holding BRAYZ_NODE_SHARED_SECRET; the VM reads it at boot."
  type        = string
}

variable "sip_port" {
  description = "SIP signalling port. Must match the firewall rule."
  type        = number
  default     = 5060
}

variable "rtp_port_min" {
  description = "Low end of the RTP range. Must match the firewall, or calls set up and carry no audio."
  type        = number
}

variable "rtp_port_max" {
  description = "High end of the RTP range. Must match the firewall."
  type        = number
}

variable "twilio_sip_ranges" {
  description = "Twilio signalling CIDRs the daemon accepts INVITEs from — the same list the firewall allows."
  type        = list(string)
}

variable "api_url" {
  description = "Brayz API base URL; the node POSTs signed lifecycle webhooks to it."
  type        = string
}

variable "webhook_secret_name" {
  description = "Secret Manager secret holding the HMAC key the node signs webhooks with."
  type        = string
}

variable "recording" {
  description = <<-EOT
    Call recording. When enabled the daemon records every call to local disk,
    uploads it to the S3-compatible bucket when the call finalizes, deletes the
    local copy after a durable upload, and confirms with the recording_uploaded
    webhook. The HMAC credentials are read from Secret Manager at boot.
  EOT
  type = object({
    enabled           = bool
    bucket            = string
    endpoint          = string
    region            = string
    access_key_secret = string
    secret_key_secret = string
  })
  default = {
    enabled           = false
    bucket            = ""
    endpoint          = ""
    region            = ""
    access_key_secret = ""
    secret_key_secret = ""
  }
}

variable "hep" {
  description = <<-EOT
    HEP3 shipping to a Homer collector. When enabled the daemon emits SIP
    messages, RTCP, per-RR RTP QoS, lifecycle logs, the CDR, and the
    STIR/SHAKEN verdict, all correlated by SIP Call-ID.

    Costs nothing to leave on: SiphonAI's own load results measure HEP as free
    on CPU (against recording at +81%/call and neural VAD at +191%). Emission
    is best-effort and never blocks the audio path — a full queue drops the
    packet and ticks a counter.

    `capture_id` is HEP3's tenant key, and SiphonAI v1 scopes it per node, not
    per route: every Brayz tenant's signalling lands under one id, with no
    separation inside Homer. That is a reason to keep the collector private and
    its retention short, not a reason to leave this off.
  EOT
  type = object({
    enabled         = bool
    collector       = string
    capture_id      = number
    password_secret = string
  })
  default = {
    enabled         = false
    collector       = ""
    capture_id      = 0
    password_secret = ""
  }
}
