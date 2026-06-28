variable "project_id" {
  description = "GCP project ID that will host the assignment stack."
  type        = string
}

variable "repository_url" {
  description = "Git URL for this repository. Startup scripts clone it onto each VM."
  type        = string
}
