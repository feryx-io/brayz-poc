# brayz-dev environment: enables APIs, then builds network -> service accounts -> secrets
# -> the Siphon-AI VM. project-services is a dependency of everything (resources need their
# API enabled first).

module "project_services" {
  source     = "../../modules/project-services"
  project_id = var.project_id
}

module "network" {
  source      = "../../modules/network"
  project_id  = var.project_id
  region      = var.region
  name_prefix = var.name_prefix

  twilio_sip_source_ranges   = var.twilio_sip_source_ranges
  twilio_media_source_ranges = var.twilio_media_source_ranges
  # The Homer collector has no external IP by design, and it installs Docker
  # and pulls its images from the internet at boot — without NAT it sits in
  # its startup script forever. So Homer brings NAT with it — while its VM
  # runs; a paused Homer has nothing to egress for.
  enable_cloud_nat = var.enable_cloud_nat || (var.homer_enabled && var.homer_running)
  enable_flow_logs = var.enable_flow_logs

  depends_on = [module.project_services]
}

module "service_accounts" {
  source     = "../../modules/service-accounts"
  project_id = var.project_id

  depends_on = [module.project_services]
}

module "secrets" {
  source            = "../../modules/secrets"
  project_id        = var.project_id
  name_prefix       = var.name_prefix
  runtime_sa_emails = module.service_accounts.emails

  depends_on = [module.project_services]
}

# Call recordings: the bucket, per-side HMAC keys, and their Secret Manager
# versions. The node uploads with one identity and the API signs playback URLs
# with the other; see the module for why Terraform writes these two secrets.
module "recording_bucket" {
  source = "../../modules/recording-bucket"
  count  = var.recording_enabled ? 1 : 0

  project_id        = var.project_id
  region            = var.region
  uploader_sa_email = module.service_accounts.siphon_gateway_email
  reader_sa_email   = module.service_accounts.emails["api"]

  uploader_access_key_secret = module.secrets.secret_resource_ids["${var.name_prefix}-recording-upload-access-key"]
  uploader_secret_key_secret = module.secrets.secret_resource_ids["${var.name_prefix}-recording-upload-secret-key"]
  reader_access_key_secret   = module.secrets.secret_resource_ids["${var.name_prefix}-recording-s3-access-key"]
  reader_secret_key_secret   = module.secrets.secret_resource_ids["${var.name_prefix}-recording-s3-secret-key"]

  retention_days = var.recording_retention_days
  # dev is torn down between sessions; a bucket that refuses to go because it
  # holds test calls would block the destroy the same way Cloud SQL's did.
  force_destroy = true

  depends_on = [module.project_services]
}

# Homer/HEP collector. Off by default; when on it is a private VM (no public
# IP, IAP only) that the voice node ships HEP3 to across the VPC.
module "homer_node" {
  source                = "../../modules/homer-node"
  project_id            = var.project_id
  region                = var.region
  zone                  = var.zone
  name_prefix           = var.name_prefix
  enabled               = var.homer_enabled
  running               = var.homer_running
  machine_type          = var.homer_machine_type
  retention_days        = var.homer_retention_days
  subnet_self_link      = module.network.subnet_self_link
  network_tag           = module.network.homer_tag
  service_account_email = module.service_accounts.emails["homer"]

  hep_password_secret   = "${var.name_prefix}-hep-password"
  db_password_secret    = "${var.name_prefix}-homer-db-password"
  admin_password_secret = "${var.name_prefix}-homer-admin-password"

  depends_on = [module.secrets]
}

module "siphon_node" {
  source                = "../../modules/siphon-node"
  project_id            = var.project_id
  region                = var.region
  zone                  = var.zone
  name_prefix           = var.name_prefix
  enabled               = var.enable_voice_node
  reserve_ip            = var.reserve_voice_static_ip
  machine_type          = var.siphon_machine_type
  subnet_self_link      = module.network.subnet_self_link
  network_tag           = module.network.siphon_tag
  service_account_email = module.service_accounts.siphon_gateway_email
  siphon_version        = var.siphon_version

  # Rendered into the daemon's config from the same values the firewall rules
  # use, so the two cannot drift apart.
  sip_port          = module.network.sip_port
  rtp_port_min      = module.network.rtp_port_min
  rtp_port_max      = module.network.rtp_port_max
  twilio_sip_ranges = var.twilio_sip_source_ranges

  # Cloud Run hands back https://; the bridge speaks wss over the same 443.
  ws_url            = "${replace(module.cloud_run_orchestrator.uri, "https://", "wss://")}/v1/media"
  node_token_secret = "${var.name_prefix}-siphon-node-token"

  # Signed recording_uploaded webhooks — without these the call record never
  # learns an upload finished, so a recording stays unplayable in the dashboard.
  api_url             = module.cloud_run_api.uri
  webhook_secret_name = "${var.name_prefix}-siphon-webhook-secret"

  # Recording target. The secret names come off the version resources, so the
  # node cannot render (and boot) before the HMAC keys exist in Secret Manager.
  # HEP3 to the collector above. Its internal address is only known once the VM
  # exists, so this is empty (and the [hep] block absent) whenever Homer is off.
  hep = var.homer_enabled ? {
    enabled         = true
    collector       = module.homer_node.collector
    capture_id      = var.homer_capture_id
    password_secret = "${var.name_prefix}-hep-password"
    } : {
    enabled         = false
    collector       = ""
    capture_id      = 0
    password_secret = ""
  }

  recording = var.recording_enabled ? {
    enabled           = true
    bucket            = module.recording_bucket[0].bucket
    endpoint          = module.recording_bucket[0].endpoint
    region            = module.recording_bucket[0].signing_region
    access_key_secret = module.recording_bucket[0].uploader_access_key_secret_name
    secret_key_secret = module.recording_bucket[0].uploader_secret_key_secret_name
    } : {
    enabled           = false
    bucket            = ""
    endpoint          = ""
    region            = ""
    access_key_secret = ""
    secret_key_secret = ""
  }
}

# ---- Cloud Run control plane: Artifact Registry, Cloud SQL, API, Orchestrator ----

module "artifact_registry" {
  source      = "../../modules/artifact-registry"
  project_id  = var.project_id
  region      = var.region
  name_prefix = var.name_prefix

  depends_on = [module.project_services]
}

module "cloud_sql" {
  source              = "../../modules/cloud-sql"
  project_id          = var.project_id
  region              = var.region
  name_prefix         = var.name_prefix
  tier                = var.cloudsql_tier
  deletion_protection = var.cloudsql_deletion_protection
  backups_enabled     = var.cloudsql_backups
  running             = var.cloudsql_running
  instance_name       = var.cloudsql_instance_name

  depends_on = [module.project_services]
}

# API — Fastify control plane. DATABASE_URL + node secret come from Secret Manager;
# Cloud SQL is mounted at /cloudsql via the connection name.
module "cloud_run_api" {
  source                = "../../modules/cloud-run-service"
  deletion_protection   = var.cloud_run_deletion_protection
  project_id            = var.project_id
  region                = var.region
  name                  = "${var.name_prefix}-api"
  service_account_email = module.service_accounts.emails["api"]
  cloudsql_instances    = [module.cloud_sql.connection_name]
  timeout_seconds       = 300

  env = {
    NODE_ENV                 = "production"
    API_PORT                 = "8080"
    GCP_PROJECT_ID           = var.project_id
    AUTH_MODE                = var.api_auth_mode
    FIREBASE_PROJECT_ID      = var.project_id
    PUBSUB_TOPIC_CALL_EVENTS = "call-events"
    # Elastic SIP Trunk that provisioned numbers attach to (routes calls to Brayz).
    TWILIO_TRUNK_SID = var.twilio_trunk_sid
    # Restaurant texts (orders, messages): sent from the location's own number,
    # else this fallback sender / messaging service.
    TWILIO_SMS_FROM              = var.twilio_sms_from
    TWILIO_MESSAGING_SERVICE_SID = var.twilio_messaging_service_sid
    # Billing: plan price ids and whether tiers actually gate features.
    STRIPE_PRICE_STARTER = var.stripe_price_starter
    STRIPE_PRICE_GROWTH  = var.stripe_price_growth
    STRIPE_PRICE_PRO     = var.stripe_price_pro
    BILLING_ENFORCED     = var.billing_enforced ? "true" : "false"
    # Where SiphonAI uploads call recordings, for playback signing. Blank when
    # recording is off, which the API reads as "no playback".
    RECORDING_S3_ENDPOINT = var.recording_enabled ? module.recording_bucket[0].endpoint : ""
    RECORDING_S3_REGION   = var.recording_enabled ? module.recording_bucket[0].signing_region : "auto"
    # The bucket lifecycle ceiling, so the API can refuse a per-location
    # retention it could never honour.
    RECORDING_MAX_RETENTION_DAYS = tostring(var.recording_retention_days)
    # Cloud Scheduler's identity + the audience its tokens are minted for, so
    # the API can tell the retention sweep's caller from anyone else on the
    # public URL. Same audience string as the job below.
    SCHEDULER_INVOKER_EMAIL = module.service_accounts.emails["scheduler"]
    SCHEDULER_OIDC_AUDIENCE = local.scheduler_audience
    # Bootstrap for the Brayz staff admin portal — the first admin only. Not a
    # secret (a list of our own addresses), and not the source of truth after
    # the first sign-in: see the variable's description.
    PLATFORM_ADMIN_EMAILS = var.platform_admin_emails
    LOG_LEVEL             = var.log_level
  }
  secret_env = {
    DATABASE_URL             = "${var.name_prefix}-database-url"
    BRAYZ_NODE_SHARED_SECRET = "${var.name_prefix}-siphon-node-token"
    # Twilio API creds for number search/purchase (secrets must hold versions).
    TWILIO_ACCOUNT_SID = "${var.name_prefix}-twilio-account-sid"
    TWILIO_AUTH_TOKEN  = "${var.name_prefix}-twilio-auth-token"
    # Claude key for AI menu extraction (secret already populated for the orchestrator).
    ANTHROPIC_API_KEY = "${var.name_prefix}-anthropic-api-key"
    # Deepgram key so the dashboard can list Aura voices and preview one.
    DEEPGRAM_API_KEY = "${var.name_prefix}-deepgram-api-key"
    # SiphonAI lifecycle webhooks (recording uploads).
    SIPHON_WEBHOOK_SECRET = "${var.name_prefix}-siphon-webhook-secret"
    # Billing and recording playback. Every one of these is optional at runtime:
    # an empty version reads as "not configured" and the feature stays off, which
    # is why `up.sh` seeds a placeholder version for each. Without one, Cloud Run
    # would refuse to start on a secret that has no version at all.
    STRIPE_SECRET_KEY       = "${var.name_prefix}-stripe-secret-key"
    STRIPE_WEBHOOK_SECRET   = "${var.name_prefix}-stripe-webhook-secret"
    RECORDING_S3_ACCESS_KEY = "${var.name_prefix}-recording-s3-access-key"
    RECORDING_S3_SECRET_KEY = "${var.name_prefix}-recording-s3-secret-key"
  }

  depends_on = [module.secrets, module.cloud_sql]
}

# Recording retention sweep: hourly POST to the API, which deletes recordings
# past their location's policy (docs/operations/call-recordings.md). The job
# authenticates with an OIDC token for the scheduler SA — no shared secret in
# this file, in state, or in the job — and the API checks email + audience.
# The audience is an opaque string rather than the API's URL because the API's
# own env cannot reference its own URI without a cycle.
locals {
  scheduler_audience = "${var.name_prefix}-api-internal"
}

resource "google_cloud_scheduler_job" "recording_sweep" {
  count = var.recording_enabled ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "${var.name_prefix}-recording-sweep"
  description = "Delete call recordings past their location's retention policy"
  schedule    = var.recording_sweep_schedule
  time_zone   = "Etc/UTC"
  # A sweep is idempotent, so a retry after a timeout costs nothing.
  attempt_deadline = "180s"
  retry_config {
    retry_count = 2
  }

  http_target {
    http_method = "POST"
    uri         = "${module.cloud_run_api.uri}/v1/internal/recordings/sweep"
    # No body and no content-type: the API's JSON parser refuses an empty
    # JSON body, and the sweep takes no input.
    oidc_token {
      service_account_email = module.service_accounts.emails["scheduler"]
      audience              = local.scheduler_audience
    }
  }

  depends_on = [module.project_services]
}

# Orchestrator — WebSocket server SiphonAI connects to. Reaches the API over its
# public URL with the node secret; long timeout for live calls. No DB of its own.
module "cloud_run_orchestrator" {
  source                = "../../modules/cloud-run-service"
  deletion_protection   = var.cloud_run_deletion_protection
  project_id            = var.project_id
  region                = var.region
  name                  = "${var.name_prefix}-orchestrator"
  service_account_email = module.service_accounts.emails["orchestrator"]
  timeout_seconds       = 3600
  min_instances         = var.orchestrator_min_instances
  # A phone call cannot wait for a container to start, and the media loop must
  # not be throttled between websocket messages.
  cpu_idle = false

  env = {
    NODE_ENV                  = "production"
    ORCHESTRATOR_PORT         = "8080"
    GCP_PROJECT_ID            = var.project_id
    DATABASE_URL              = "postgresql://unused" # config requires it; orchestrator never uses the DB
    API_INTERNAL_URL          = module.cloud_run_api.uri
    ANTHROPIC_MODEL           = var.anthropic_model
    ANTHROPIC_THINKING        = var.anthropic_thinking
    BRAYZ_TRANSFER_SIP_DOMAIN = var.transfer_sip_domain
    # The barge-in and echo lines debug turns on are how call quality gets
    # compared between deploys. The per-turn "turn latency" line is at info and
    # does not need it. One knob for the environment (var.log_level) so the API
    # and Orchestrator cannot drift apart, and so it is never set by hand again.
    LOG_LEVEL = var.log_level
  }
  secret_env = {
    ANTHROPIC_API_KEY        = "${var.name_prefix}-anthropic-api-key"
    DEEPGRAM_API_KEY         = "${var.name_prefix}-deepgram-api-key"
    BRAYZ_NODE_SHARED_SECRET = "${var.name_prefix}-siphon-node-token"
  }

  depends_on = [module.secrets, module.cloud_run_api]
}

# Web — Next.js admin portal + marketing. The API URL and auth mode are baked
# into the image at build time (NEXT_PUBLIC_*), so the service needs no env here.
module "cloud_run_web" {
  source                = "../../modules/cloud-run-service"
  deletion_protection   = var.cloud_run_deletion_protection
  project_id            = var.project_id
  region                = var.region
  name                  = "${var.name_prefix}-web"
  service_account_email = module.service_accounts.emails["api"]
  min_instances         = var.web_min_instances

  depends_on = [module.project_services]
}

# The web service on our own domain. Carriers reviewing SMS registration visit
# the brand's site and expect the privacy policy, terms and opt-in proof there,
# not on a *.run.app address. Each domain must first be verified in Search
# Console by the identity running Terraform. The mappings outlive a pause
# (down.sh leaves the web service alone); the DNS records they need are in the
# web_domain_dns_records output and live at the registrar, not here, so pausing
# dev never takes email down with it.
resource "google_cloud_run_domain_mapping" "web" {
  for_each = toset(var.web_domains)

  name     = each.value
  project  = var.project_id
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.cloud_run_web.name
  }
}
