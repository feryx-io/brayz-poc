# Homer: the SIP-world packet-flow explorer, and the collector SiphonAI ships
# HEP3 at. Three containers — heplify-server (the HEP3 collector), Postgres, and
# the Homer web UI — on one VM with no public IP.
#
# ## Why this is a separate box, and not part of the admin portal
#
# The Brayz staff portal is the business view: tenant-scoped, audited,
# aggregates only. This is the network view — SIP ladders, RTCP, jitter and
# loss — and it belongs to whoever is debugging the voice path, not to anyone
# with a Brayz login. Keeping them apart means the portal never grows a second
# cross-tenant exception, and Homer never needs to learn what a tenant is.
#
# ## What lands here
#
# What SiphonAI emits for a call, all keyed by SIP Call-ID (since 0.51.1 —
# before that RTCP/QoS used its bridge id and no Log chunks were sent; see
# docs/operations/homer-hep.md): SIP messages (HEP 0x01), RTCP (0x05), per-RR
# RTP QoS (0x20), call_started / call_ended lifecycle logs (0x64) and the CDR
# (0x65) — plus the STIR/SHAKEN verdict (0x66) when the node verifies. No RTP
# payload — SiphonAI ships reports, never
# media — so this cannot become a store of call audio sitting outside the
# consent ledger and the retention sweep.
#
# It IS, however, a store of guest phone numbers: every INVITE carries From and
# To, under a single capture_id with no tenant separation (SiphonAI's HEP v1
# scopes capture_id per node, not per route). That is why the box has no public
# IP, is reachable only through IAP, and drops partitions on a short retention.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# Postgres data, deliberately not on the boot disk: replacing the VM is how this
# module ships a config change, and capture history should survive that. Not
# attached to the instance's auto-delete, so only a `terraform destroy` removes
# it — which is the behaviour #27 fixed the env to allow.
resource "google_compute_disk" "data" {
  count   = var.enabled ? 1 : 0
  name    = "${var.name_prefix}-homer-data"
  project = var.project_id
  zone    = var.zone
  size    = var.data_disk_gb
  type    = "pd-balanced"
}

# The collector's address, reserved so it outlives the VM. The voice node's
# [hep].collector is rendered from it, and the voice node ships config by
# replacement too — so were this the instance's ephemeral IP, every Homer
# replacement would plan a new collector address and take the voice node down
# with it.
resource "google_compute_address" "internal" {
  count        = var.enabled ? 1 : 0
  name         = "${var.name_prefix}-homer-ip"
  project      = var.project_id
  region       = var.region
  subnetwork   = var.subnet_self_link
  address_type = "INTERNAL"
}

locals {
  startup_script = templatefile("${path.module}/startup-script.sh.tftpl", {
    hep_port              = var.hep_port
    ui_port               = var.ui_port
    retention_days        = var.retention_days
    hep_password_secret   = var.hep_password_secret
    db_password_secret    = var.db_password_secret
    admin_password_secret = var.admin_password_secret
    compose_yaml = templatefile("${path.module}/compose.yaml.tftpl", {
      hep_port       = var.hep_port
      ui_port        = var.ui_port
      retention_days = var.retention_days
    })
  })
}

# Same reasoning as the siphon node: the startup script is the whole install, so
# a change to it has to reach the box rather than sitting in metadata until
# someone reboots. The VM holds no state the data disk does not.
resource "terraform_data" "provision" {
  count = var.enabled ? 1 : 0
  input = sha256(local.startup_script)
}

# Only the VM goes when paused (`running = false`, which down.sh sets): the
# data disk and the reserved address follow `enabled` alone, so capture history
# and the collector address — and with it the voice node's config — survive a
# pause/resume cycle unchanged. Same shape as the voice node and its static IP.
resource "google_compute_instance" "homer" {
  count        = var.enabled && var.running ? 1 : 0
  name         = "${var.name_prefix}-homer"
  project      = var.project_id
  zone         = var.zone
  machine_type = var.machine_type

  allow_stopping_for_update = true

  tags = [var.network_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.data[0].id
    device_name = "homer-data"
  }

  # No access_config: no public IP. Ingress is IAP only. Egress — Docker's apt
  # repo and Docker Hub at boot — goes through Cloud NAT, which envs/dev turns
  # on whenever Homer is (Private Google Access alone reaches Secret Manager,
  # not the internet, and the first boot hung on exactly that).
  network_interface {
    subnetwork = var.subnet_self_link
    network_ip = google_compute_address.internal[0].address
  }

  service_account {
    email  = var.service_account_email
    scopes = ["cloud-platform"]
  }

  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
    startup-script         = local.startup_script
  }

  lifecycle {
    replace_triggered_by = [terraform_data.provision]
  }
}
