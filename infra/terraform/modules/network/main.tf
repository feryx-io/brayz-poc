# VPC + subnet + Cloud NAT + firewall for the platform. The Siphon-AI VM lives here with a
# static external IP (it must receive UDP SIP/RTP directly), tagged so the SIP/RTP rules
# apply only to it. Everything else is deny-by-default (GCP implicit deny).

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_compute_network" "vpc" {
  name                    = "${var.name_prefix}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "primary" {
  name          = "${var.name_prefix}-subnet-${var.region}"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.subnet_cidr

  # Let resources without an external IP reach Google APIs (Secret Manager, logging, …).
  private_ip_google_access = true

  # VPC flow logs bill on log ingestion. Half-sampled with full metadata is a
  # real line item for a network nobody is auditing between test calls.
  dynamic "log_config" {
    for_each = var.enable_flow_logs ? [1] : []
    content {
      aggregation_interval = "INTERVAL_5_SEC"
      flow_sampling        = 0.5
      metadata             = "INCLUDE_ALL_METADATA"
    }
  }
}

# --- Cloud NAT: egress for instances WITHOUT an external IP ---------------
#
# Off by default, because nothing here needs it: the only VM (the Siphon-AI
# node) carries its own external IP and egresses through that, Cloud Run does
# not route through the VPC, and `private_ip_google_access` above already lets
# an IP-less instance reach Google APIs. A NAT gateway bills by the hour whether
# or not a packet crosses it, so an unused one is pure standing cost.
#
# Turn it on the moment something lands in the VPC without an external IP —
# a private-IP Cloud SQL, or Cloud Run behind a VPC connector. The Homer
# collector is one (envs/dev turns this on whenever `homer_enabled` is): it has
# no external IP on purpose, and it needs the internet for Docker and its images.
resource "google_compute_router" "router" {
  count   = var.enable_cloud_nat ? 1 : 0
  name    = "${var.name_prefix}-router"
  project = var.project_id
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  count                              = var.enable_cloud_nat ? 1 : 0
  name                               = "${var.name_prefix}-nat"
  project                            = var.project_id
  region                             = var.region
  router                             = google_compute_router.router[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# --- Firewall ---------------------------------------------------------------

# Allow traffic between instances inside the VPC.
resource "google_compute_firewall" "allow_internal" {
  name      = "${var.name_prefix}-allow-internal"
  project   = var.project_id
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges = [var.subnet_cidr]

  allow {
    protocol = "tcp"
  }
  allow {
    protocol = "udp"
  }
  allow {
    protocol = "icmp"
  }
}

# SSH only via Identity-Aware Proxy (no public :22). 35.235.240.0/20 is IAP's range.
resource "google_compute_firewall" "allow_iap_ssh" {
  name      = "${var.name_prefix}-allow-iap-ssh"
  project   = var.project_id
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges = ["35.235.240.0/20"]
  target_tags   = [var.siphon_tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# IAP to the Homer collector: SSH, and the web UI. The UI is deliberately not
# published anywhere else — a SIP capture holds every caller's number, so
# reaching it should cost an IAP tunnel and a Google identity.
resource "google_compute_firewall" "allow_iap_homer" {
  name      = "${var.name_prefix}-allow-iap-homer"
  project   = var.project_id
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges = ["35.235.240.0/20"]
  target_tags   = [var.homer_tag]

  allow {
    protocol = "tcp"
    ports    = ["22", tostring(var.homer_ui_port)]
  }
}

# SIP signaling from Twilio only, to the Siphon-AI VM only.
resource "google_compute_firewall" "allow_sip" {
  name      = "${var.name_prefix}-allow-sip"
  project   = var.project_id
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges = var.twilio_sip_source_ranges
  target_tags   = [var.siphon_tag]

  allow {
    protocol = "udp"
    ports    = [tostring(var.sip_port)]
  }
  allow {
    protocol = "tcp"
    ports    = [tostring(var.sip_port)]
  }
}

# RTP media from Twilio only, to the Siphon-AI VM only, on the fixed observable range.
resource "google_compute_firewall" "allow_rtp" {
  name      = "${var.name_prefix}-allow-rtp"
  project   = var.project_id
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges = var.twilio_media_source_ranges
  target_tags   = [var.siphon_tag]

  allow {
    protocol = "udp"
    ports    = ["${var.rtp_port_min}-${var.rtp_port_max}"]
  }
}
