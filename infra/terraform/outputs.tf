output "api_ip" {
  description = "Public IP address for the JSON inference API."
  value       = google_compute_address.api.address
}

output "api_url" {
  description = "Public HTTP endpoint for inference requests."
  value       = "http://${google_compute_address.api.address}/v1/chat/completions"
}

output "engine_private_url" {
  description = "Private iii engine WebSocket URL used by workers."
  value       = "ws://${var.gateway_private_ip}:49134"
}

output "worker_vm_names" {
  description = "Private worker VM names."
  value = {
    caller    = google_compute_instance.caller_worker.name
    inference = google_compute_instance.inference_worker.name
  }
}
