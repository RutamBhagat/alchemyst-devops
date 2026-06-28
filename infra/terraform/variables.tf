variable "project_id" {
  description = "GCP project ID that will host the assignment stack."
  type        = string
}

variable "region" {
  description = "GCP region for regional resources."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for Compute Engine VMs."
  type        = string
  default     = "us-central1-a"
}

variable "name_prefix" {
  description = "Prefix applied to all created resource names."
  type        = string
  default     = "alchemyst-devops"
}

variable "repository_url" {
  description = "Git URL for this repository. Startup scripts clone it onto each VM."
  type        = string
}

variable "iii_version" {
  description = "iii engine version installed on the gateway. Keep this minor line aligned with the SDK packages."
  type        = string
  default     = "0.11.0"
}

variable "subnet_cidr" {
  description = "CIDR range for the private subnet."
  type        = string
  default     = "10.10.0.0/24"
}

variable "gateway_private_ip" {
  description = "Static private IP for the gateway and iii engine endpoint."
  type        = string
  default     = "10.10.0.10"
}

variable "boot_image" {
  description = "Compute Engine boot image for all VMs."
  type        = string
  default     = "debian-cloud/debian-12"
}

variable "api_machine_type" {
  description = "Machine type for the public API gateway."
  type        = string
  default     = "e2-small"
}

variable "caller_machine_type" {
  description = "Machine type for the TypeScript caller worker."
  type        = string
  default     = "e2-small"
}

variable "inference_machine_type" {
  description = "Machine type for the Python model worker."
  type        = string
  default     = "e2-standard-4"
}
