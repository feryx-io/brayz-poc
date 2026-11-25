# The Siphon-AI voice gateway VM: a native Rust binary under systemd (NOT Docker), with a
# regional static external IP so Twilio can send SIP/RTP to a stable address. The startup
# script preps the box (brayz user + dirs); the binary comes from SiphonAI's own repo
# (github.com/thevoiceguy/siphon-ai) — it is a separate product, so there is nothing here
# to build. The config this node runs is infra/siphon/siphon-ai.dev-node.toml.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# Stable external IP for the Twilio origination URI + the node's config.toml
# external_ip.
#
# Reserved independently of the VM on purpose: the address is the one piece of
# this node that is configured somewhere Brayz does not control — Twilio's
# origination URI — so it outlives the machine. A reserved address that is not
# attached to a running instance bills a few dollars a month; a changed address
# means editing Twilio and the node config on every rebuild.
resource "google_compute_address" "siphon" {
  count        = var.reserve_ip ? 1 : 0
  name         = "${var.name_prefix}-siphon-${var.node_index}-ip"
  project      = var.project_id
  region       = var.region
  address_type = "EXTERNAL"
}

locals {
  startup_script = templatefile("${path.module}/startup-script.sh.tftpl", {
    siphon_version      = var.siphon_version
    project_id          = var.project_id
    node_token_secret   = var.node_token_secret
    webhook_secret_name = var.webhook_secret_name
    ops_agent_yaml      = file("${path.module}/ops-agent.yaml")
    recording           = var.recording
    hep                 = var.hep
    # brayz-node-heartbeat: who this node is, and where it reports its health.
    api_url        = var.api_url
    node_id        = "${var.name_prefix}-siphon-${var.node_index}"
    region         = var.region
    environment    = var.name_prefix
    public_address = var.reserve_ip ? google_compute_address.siphon[0].address : ""
    config_toml = templatefile("${path.module}/config.toml.tftpl", {
      node_id           = "${var.name_prefix}-siphon-${var.node_index}"
      public_address    = var.reserve_ip ? google_compute_address.siphon[0].address : ""
      sip_port          = var.sip_port
      rtp_port_min      = var.rtp_port_min
      rtp_port_max      = var.rtp_port_max
      ws_url            = var.ws_url
      api_url           = var.api_url
      twilio_sip_ranges = var.twilio_sip_ranges
      recording         = var.recording
      hep               = var.hep
    })
  })
}

# Changing the startup script updates instance metadata in place — the script
# itself only re-runs at boot. So a siphon_version bump, or any config change,
# would sit in metadata doing nothing until someone happened to reboot the VM.
# Keying a replacement off the rendered script makes "bump the version and
# apply" mean what it says. Replacing costs about a minute on a node that holds
# no state and whose address is reserved separately.
resource "terraform_data" "provision" {
  count = var.enabled ? 1 : 0
  input = sha256(local.startup_script)
}

resource "google_compute_instance" "siphon" {
  count        = var.enabled ? 1 : 0
  name         = "${var.name_prefix}-siphon-${var.node_index}"
  project      = var.project_id
  zone         = var.zone
  machine_type = var.machine_type

  # Resizing a running instance is rejected unless this is set. The node holds
  # no state — SiphonAI is reinstalled by the startup script and the static IP
  # is a separate resource — so a stop/start to change shape costs a rebuild of
  # something we already rebuild on every up, and refusing the change instead
  # just leaves the apply broken.
  allow_stopping_for_update = true

  # SIP/RTP/SSH firewall rules in the network module target this tag.
  tags = [var.network_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = var.subnet_self_link

    access_config {
      nat_ip = google_compute_address.siphon[0].address
    }
  }

  service_account {
    email  = var.service_account_email
    scopes = ["cloud-platform"] # actual authority is the SA's IAM roles, not scopes
  }

  metadata = {
    # Block project-wide SSH keys; rely on IAP + OS Login.
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
    startup-script         = local.startup_script
  }

  lifecycle {
    replace_triggered_by = [terraform_data.provision]

    # The startup script IS the install now — version, config, and secret all
    # come from it — so metadata must not be ignored: a siphon_version bump or a
    # config change has to reach the box. Metadata updates in place; the script
    # re-runs on the next boot, and `up.sh` after a `down.sh` pause is a fresh
    # VM running it from scratch.

    # The VM attaches the reserved address, so it cannot come up without one.
    precondition {
      condition     = var.reserve_ip
      error_message = "enabled = true requires reserve_ip = true — the VM attaches the reserved address."
    }
  }
}
