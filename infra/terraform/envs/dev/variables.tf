variable "project_id" {
  description = "The brayz-dev GCP project ID."
  type        = string
  default     = "brayz-dev"
}

variable "region" {
  description = "Primary region (CLAUDE.md: us-east4)."
  type        = string
  default     = "us-east4"
}

variable "zone" {
  description = "Zone for the Siphon-AI VM."
  type        = string
  default     = "us-east4-a"
}

variable "name_prefix" {
  description = "Resource name prefix for this env."
  type        = string
  default     = "brayz-dev"
}

variable "siphon_machine_type" {
  description = "Siphon-AI VM machine type."
  type        = string
  default     = "e2-medium"
}

variable "twilio_sip_source_ranges" {
  description = "Twilio SIP signaling CIDRs (VERIFY against Twilio docs). See terraform.tfvars.example."
  type        = list(string)
}

variable "twilio_media_source_ranges" {
  description = "Twilio media/RTP CIDRs (VERIFY against Twilio docs). See terraform.tfvars.example."
  type        = list(string)
}

# ---- Cloud Run / Cloud SQL ----

variable "api_auth_mode" {
  description = "API auth mode: \"firebase\" (verifies Identity Platform ID tokens — the deployed default) or \"dev\" (trusts headers; local runs and tests only, never a reachable environment)."
  type        = string
  default     = "firebase"
}

variable "anthropic_model" {
  description = "LLM for the Orchestrator. Sonnet 5: Haiku 4.5 mis-takes orders on real restaurant menus."
  type        = string
  default     = "claude-sonnet-5"
}

variable "anthropic_thinking" {
  description = "Model deliberation. Off on a phone line: it costs ~2.5 s of the caller's silence per model round trip, and the one thing that needed it moved into the tool layer. Set to \"adaptive\" to put it back."
  type        = string
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "adaptive"], var.anthropic_thinking)
    error_message = "anthropic_thinking must be \"disabled\" or \"adaptive\"."
  }
}

variable "log_level" {
  description = <<-EOT
    Pino log level for the API and Orchestrator (the web app has none). Debug
    here because dev exists to watch calls: the Orchestrator's barge-in, echo
    and turn-queue lines are debug, and they are how call quality is compared
    between deploys. staging/prod set "info". Must be a level @brayz/config
    accepts, so a typo fails the plan rather than the container start.
  EOT
  type        = string
  default     = "debug"
  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level must be one of fatal, error, warn, info, debug, trace, silent."
  }
}

variable "transfer_sip_domain" {
  description = "SIP domain used to build REFER URIs from phone/extension transfer targets (optional)."
  type        = string
  default     = ""
}

variable "twilio_trunk_sid" {
  description = "Elastic SIP Trunk SID (TK...) that provisioned numbers attach to so inbound calls route to Brayz. Empty disables trunk attach."
  type        = string
  default     = ""
}

variable "twilio_sms_from" {
  description = <<-EOT
    Fallback E.164 sender for restaurant texts (new orders, messages taken). The
    API texts from the location's own Twilio number when it has one; this is only
    used for a location without one. Empty means such a location gets no texts.
    US-bound SMS from a 10DLC number needs A2P registration on the Twilio account.
  EOT
  type        = string
  default     = ""
}

variable "twilio_messaging_service_sid" {
  description = "Twilio Messaging Service SID (MG...) to send restaurant texts through instead of a bare number — the A2P-compliant path once the account is registered. Empty sends from numbers directly."
  type        = string
  default     = ""
}

variable "cloudsql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "cloudsql_deletion_protection" {
  description = <<-EOT
    Terraform-side guard against destroying the database.

    False here on purpose: `envs/dev` exists to be stood up and torn down, and
    a guard that makes `terraform destroy` fail is the thing that turns a
    teardown into a manual console visit. staging/prod set it true.
  EOT
  type        = bool
  default     = false
}

variable "orchestrator_min_instances" {
  description = <<-EOT
    Warm instances for the Orchestrator. 1, not 0: a caller who has already been
    connected cannot wait for a container to start, and on a live call that cold
    start cost 15 seconds of silence before the first reply — long enough that
    the caller repeated the question three times and then got three answers.

    This does cost money while idle, unlike the other two services. `down.sh`
    drops it back to 0 when pausing, so the bill only runs while the environment
    is meant to be up.
  EOT
  type        = number
  default     = 1
}

variable "web_min_instances" {
  description = "Warm instances for the web portal."
  type        = number
  default     = 0
}

variable "web_domains" {
  description = "Domains mapped to the web service (e.g. brayz.ai, www.brayz.ai). Each must be verified in Search Console by the Terraform identity first."
  type        = list(string)
  default     = []
}

variable "cloudsql_running" {
  description = <<-EOT
    Whether the Cloud SQL instance is running.

    False stops it: compute billing ends and only the disk is charged, while
    the data, the connection name, and every Cloud Run URL survive. This is the
    lever `down.sh` pulls between test sessions — destroying the instance would
    also take the Cloud Run services that depend on it, and with them the URLs
    SiphonAI and Stripe are pointed at.
  EOT
  type        = bool
  default     = true
}

variable "cloudsql_backups" {
  description = "Automated Cloud SQL backups. Off for an environment that gets destroyed."
  type        = bool
  default     = false
}

variable "enable_voice_node" {
  description = <<-EOT
    Create the Siphon-AI voice VM.

    The VM is the largest standing cost here, so `down.sh` sets this false
    between test sessions. Its static IP is reserved separately and kept, so
    the address Twilio dials does not change across the cycle.
  EOT
  type        = bool
  default     = true
}

variable "reserve_voice_static_ip" {
  description = <<-EOT
    Hold the voice node's static external IP even while the VM is gone.

    True by default: an unattached reserved address costs a few dollars a
    month, and the alternative is editing the Twilio origination URI and the
    node's config.toml on every rebuild. Set false only when you are done with
    the project.
  EOT
  type        = bool
  default     = true
}

variable "enable_cloud_nat" {
  description = "Cloud NAT. Bills hourly. Forced on while homer_enabled (the collector has no external IP); otherwise nothing needs it — the voice node has its own."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "VPC flow logs. Bills on ingestion."
  type        = bool
  default     = false
}

# ---- Billing (Stripe) ----

variable "stripe_price_starter" {
  description = "Stripe price id for the Starter plan. Blank leaves that plan unbuyable."
  type        = string
  default     = ""
}

variable "stripe_price_growth" {
  type    = string
  default = ""
}

variable "stripe_price_pro" {
  type    = string
  default = ""
}

variable "billing_enforced" {
  description = "Whether plan tiers actually gate features. Off until real plans exist."
  type        = bool
  default     = false
}

# ---- Call recordings ----

variable "recording_enabled" {
  description = <<-EOT
    Record calls. Creates the recordings bucket (modules/recording-bucket) with
    an HMAC key per side, tells the voice node to record and upload, and gives
    the API what it needs to sign playback URLs. Off leaves every call with no
    recording and the Calls screen saying so.
  EOT
  type        = bool
  default     = true
}

variable "recording_retention_days" {
  description = "Platform ceiling: the bucket lifecycle deletes recordings older than this, and no location may keep them longer. A location shortens it with its own retention setting."
  type        = number
  default     = 90
}

variable "recording_sweep_schedule" {
  description = "Cron for the per-location retention sweep (Cloud Scheduler, UTC). Hourly is plenty: a policy is in days."
  type        = string
  default     = "17 * * * *"
}

variable "cloudsql_instance_name" {
  description = <<-EOT
    Adopt an existing Cloud SQL instance by name rather than creating a new
    suffixed one. Leave null for a fresh environment; set it when an instance
    predates the suffixed naming, so an apply updates it in place instead of
    replacing it and dropping the data.
  EOT
  type        = string
  default     = null
}

variable "siphon_version" {
  description = "SiphonAI release the voice node installs at boot. Bump to upgrade the node."
  type        = string
  default     = "0.51.1"
}

variable "cloud_run_deletion_protection" {
  description = <<-EOT
    Terraform-side guard against destroying or replacing a Cloud Run service.

    False here for the same reason as cloudsql_deletion_protection: `envs/dev`
    exists to be stood up and torn down. It also blocks the replacement of a
    service left tainted by a failed create, which is exactly when an apply most
    needs to be able to finish. staging/prod set it true.
  EOT
  type        = bool
  default     = false
}

variable "platform_admin_emails" {
  description = <<-EOT
    Comma-separated emails granted the Brayz staff `admin` platform role the first
    time they call /v1/me after signing in. This exists only to create the FIRST
    admin: the portal that grants staff access is the one they cannot yet open.

    After that, users.platformRole in the database is the source of truth, and
    removing an address here does NOT revoke access — revocation is an explicit
    act on /admin/staff, so that losing staff access is never a side effect of a
    config edit nobody noticed.

    The account must already exist: signing in creates it, and the role attaches
    on the next /v1/me. An address that never signs in is simply never promoted.

    Empty (the default) means no bootstrap, which is correct for any environment
    that already has an admin.
  EOT
  type        = string
  default     = ""
}

variable "homer_enabled" {
  description = <<-EOT
    Stand up the Homer/HEP collector and point the voice node at it.

    Off by default. When on, SiphonAI ships every call's SIP messages, RTCP,
    RTP QoS, lifecycle logs and CDR (and STIR/SHAKEN verdict, when verifying)
    to a private VM running heplify-server + Homer, all correlated by SIP
    Call-ID (since SiphonAI 0.51.1). Enabling also turns on Cloud NAT while the
    VM runs.

    Before turning this on in an environment with real callers, read that doc:
    Homer holds guest phone numbers with none of Brayz's tenant scoping, audit
    trail, or per-location retention.
  EOT
  type        = bool
  default     = false
}

variable "homer_running" {
  description = <<-EOT
    Run the Homer VM (only meaningful while homer_enabled). down.sh sets this
    false to pause: the VM and Cloud NAT go, the data disk and the reserved
    collector address stay, so resuming brings back the same history at the
    same address.
  EOT
  type        = bool
  default     = true
}

variable "homer_machine_type" {
  type    = string
  default = "e2-small"
}

variable "homer_retention_days" {
  description = "Days of HEP capture kept before the partition is dropped."
  type        = number
  default     = 14
}

variable "homer_capture_id" {
  description = <<-EOT
    HEP3 capture id (Homer's "agent"). One per node is the convention;
    SiphonAI v1 cannot vary it per tenant.
  EOT
  type        = number
  default     = 2001
}
