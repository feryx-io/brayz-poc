output "enabled_apis" {
  description = "The set of APIs enabled by this module."
  value       = [for s in google_project_service.this : s.service]
}
