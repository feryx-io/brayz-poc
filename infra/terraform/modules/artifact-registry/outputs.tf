output "repository_id" {
  value = google_artifact_registry_repository.containers.repository_id
}

# e.g. us-east4-docker.pkg.dev/brayz-dev/brayz-dev-containers
output "repository_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}
