# project:region:instance — used by Cloud Run's --add-cloudsql-instances and in
# the DATABASE_URL unix-socket host (?host=/cloudsql/<connection_name>).
output "connection_name" {
  value = google_sql_database_instance.pg.connection_name
}

output "instance_name" {
  value = google_sql_database_instance.pg.name
}

output "public_ip" {
  value = google_sql_database_instance.pg.public_ip_address
}
