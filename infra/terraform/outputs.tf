output "api_ip" {
  description = "Public IP address for the JSON inference API."
  value       = google_compute_address.api.address
}
