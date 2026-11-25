# Cloud SQL Postgres — the API's system of record (CLAUDE.md rule #3). Cloud Run
# connects via the built-in Cloud SQL connector (connection name), so a public
# IPv4 endpoint is enough for dev; lock down to private IP for prod later.
#
# Secrets stay out of Terraform: this creates the instance + database only. The
# operator creates the `brayz` SQL user + password and writes the full
# DATABASE_URL into the `*-database-url` Secret Manager secret (see infra README).
# pgvector is enabled by the Prisma `init` migration (CREATE EXTENSION vector).
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Cloud SQL will not let a deleted instance's name be reused for about a week.
# For an environment that is deliberately torn down between test sessions that
# turns a rebuild into a week-long wait, so every instance gets a fresh suffix.
# The value lives in Terraform state, so it is stable across applies and only
# rolls over once the instance has actually been destroyed.
resource "random_id" "instance" {
  byte_length = 3
}

resource "google_sql_database_instance" "pg" {
  name             = coalesce(var.instance_name, "${var.name_prefix}-pg-${random_id.instance.hex}")
  project          = var.project_id
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    # ENTERPRISE allows shared-core tiers (db-f1-micro/db-g1-small). New projects
    # default to ENTERPRISE_PLUS, which only accepts db-perf-optimized-* tiers.
    edition           = var.edition
    tier              = var.tier
    availability_type = "ZONAL"

    # "NEVER" stops the instance: compute billing ends, the disk and its data
    # stay, and starting it again is a minute rather than a recreate. That is
    # what makes a between-sessions pause cheap AND fast — a destroyed instance
    # would take its data, its connection name, and (for about a week) its name
    # with it.
    activation_policy = var.running ? "ALWAYS" : "NEVER"
    disk_size         = var.disk_size_gb
    disk_autoresize   = true

    backup_configuration {
      # Backups cost storage and mean nothing for an environment that is
      # destroyed between sessions; on for staging/prod, off for a scratch dev.
      enabled = var.backups_enabled
    }

    ip_configuration {
      ipv4_enabled = true
    }
  }

  deletion_protection = var.deletion_protection
}

resource "google_sql_database" "brayz" {
  name     = "brayz"
  project  = var.project_id
  instance = google_sql_database_instance.pg.name
}
