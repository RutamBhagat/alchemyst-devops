terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = "us-central1"
  zone    = "us-central1-a"
}

# These tags are labels Terraform puts on VMs so firewall rules can find them.
locals {
  api_tag       = "alchemyst-devops-api-gateway"
  caller_tag    = "alchemyst-devops-caller-worker"
  inference_tag = "alchemyst-devops-inference-worker"
}

# Creates the VPC network that all machines will join.
resource "google_compute_network" "main" {
  name                    = "alchemyst-devops-vpc"
  # Terraform creates only the subnet below instead of letting Google create defaults.
  auto_create_subnetworks = false
}

# Creates the private IP range used by the VMs.
resource "google_compute_subnetwork" "private" {
  name                     = "alchemyst-devops-private"
  # Google assigns worker private IPs from this address range.
  ip_cidr_range            = "10.10.0.0/24"
  region                   = "us-central1"
  network                  = google_compute_network.main.id
  # Private VMs can still call Google APIs without getting public IPs.
  private_ip_google_access = true
}

# Cloud NAT needs this router to attach NAT to the VPC.
resource "google_compute_router" "main" {
  name    = "alchemyst-devops-router"
  region  = "us-central1"
  network = google_compute_network.main.id
}

# Lets private VMs reach the internet without giving them public IPs.
resource "google_compute_router_nat" "main" {
  name                               = "alchemyst-devops-nat"
  router                             = google_compute_router.main.name
  region                             = "us-central1"
  # Google creates the public IPs used by NAT automatically.
  nat_ip_allocate_option             = "AUTO_ONLY"
  # Only subnets listed in this resource will use this NAT.
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.private.id
    # All IPs in this subnet can use NAT for outbound traffic.
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

# Reserves one stable public IP for the API gateway.
resource "google_compute_address" "api" {
  name   = "alchemyst-devops-api-ip"
  region = "us-central1"
}

# Allows public HTTP traffic only to the API gateway VM.
resource "google_compute_firewall" "api_http" {
  name    = "alchemyst-devops-allow-api-http"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    # Port 80 is the public web/API port.
    ports    = ["80"]
  }

  # Anyone can connect, but only VMs with api_tag receive the traffic.
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.api_tag]
}

# Allows SSH only through Google IAP, not directly from the internet.
resource "google_compute_firewall" "iap_ssh" {
  name    = "alchemyst-devops-allow-iap-ssh"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    # SSH uses port 22 on the selected VMs.
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.api_tag, local.caller_tag, local.inference_tag]
}

# Allows worker VMs to talk to the gateway inside the private network.
resource "google_compute_firewall" "worker_rpc" {
  name    = "alchemyst-devops-allow-worker-rpc"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    # The gateway listens for worker traffic on this port.
    ports    = ["49134"]
  }

  # Only worker-tagged VMs can send this traffic to the gateway-tagged VM.
  source_tags = [local.caller_tag, local.inference_tag]
  target_tags = [local.api_tag]
}

# Creates the API gateway VM with both private and public networking.
resource "google_compute_instance" "api_gateway" {
  name         = "alchemyst-devops-api-gateway"
  machine_type = "e2-small"
  zone         = "us-central1-a"
  # Firewall rules use this tag to identify the gateway.
  tags         = [local.api_tag]

  boot_disk {
    initialize_params {
      # Google creates a new boot disk from this image.
      image = "debian-cloud/debian-12"
      size  = 15
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
    # Gives the gateway a fixed private IP so workers know where to connect.
    network_ip = "10.10.0.10"

    access_config {
      # Attaches the reserved public IP to the gateway.
      nat_ip = google_compute_address.api.address
    }
  }

  # Startup scripts read this metadata from the VM metadata service.
  metadata = {
    enable-oslogin = "TRUE"
    repo-url        = var.repository_url
  }

  # This script runs when the VM boots for the first time.
  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-gateway.sh")

  # NAT must exist before startup so the VM can download packages and code.
  depends_on = [google_compute_router_nat.main]
}

# Creates the caller worker VM with private networking only.
resource "google_compute_instance" "caller_worker" {
  name         = "alchemyst-devops-caller-worker"
  machine_type = "e2-small"
  zone         = "us-central1-a"
  # Firewall rules use this tag to identify the caller worker.
  tags         = [local.caller_tag]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 15
      type  = "pd-balanced"
    }
  }

  network_interface {
    # Without access_config, Google does not assign this VM a public IP.
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = {
    enable-oslogin = "TRUE"
    repo-url        = var.repository_url
  }

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-caller.sh")

  # The worker starts after gateway and NAT are ready.
  depends_on = [
    google_compute_instance.api_gateway,
    google_compute_router_nat.main,
  ]
}

# Creates the inference worker VM with private networking and a larger disk.
resource "google_compute_instance" "inference_worker" {
  name         = "alchemyst-devops-inference-worker"
  machine_type = "e2-standard-2"
  zone         = "us-central1-a"
  # Firewall rules use this tag to identify the inference worker.
  tags         = [local.inference_tag]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      # Inference gets more disk space for runtime files and model data.
      size  = 30
      type  = "pd-balanced"
    }
  }

  network_interface {
    # Google assigns a private IP from the subnet above.
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = {
    enable-oslogin = "TRUE"
    repo-url        = var.repository_url
  }

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-inference.sh")

  depends_on = [
    google_compute_instance.api_gateway,
    google_compute_router_nat.main,
  ]
}
