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
  region  = var.region
  zone    = var.zone
}

# These tags are labels Terraform puts on VMs so firewall rules can find them.
locals {
  api_tag       = "${var.name_prefix}-api-gateway"
  caller_tag    = "${var.name_prefix}-caller-worker"
  inference_tag = "${var.name_prefix}-inference-worker"
  worker_tags   = [local.caller_tag, local.inference_tag]

  # Each VM reads this metadata during startup to clone the right repository version.
  common_metadata = {
    enable-oslogin = "TRUE"
    repo-url       = var.repository_url
    repo-ref       = var.repository_ref
    iii-version    = var.iii_version
  }
}

# Creates the VPC network that all machines will join.
resource "google_compute_network" "main" {
  name                    = "${var.name_prefix}-vpc"
  # Terraform creates only the subnet below instead of letting Google create defaults.
  auto_create_subnetworks = false
}

# Creates the private IP range used by the VMs.
resource "google_compute_subnetwork" "private" {
  name                     = "${var.name_prefix}-private"
  # Google assigns worker private IPs from this address range.
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  # Private VMs can still call Google APIs without getting public IPs.
  private_ip_google_access = true
}

# Cloud NAT needs this router to attach NAT to the VPC.
resource "google_compute_router" "main" {
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.main.id
}

# Lets private VMs reach the internet without giving them public IPs.
resource "google_compute_router_nat" "main" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
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
  name   = "${var.name_prefix}-api-ip"
  region = var.region
}

# Allows public HTTP traffic only to the API gateway VM.
resource "google_compute_firewall" "api_http" {
  name    = "${var.name_prefix}-allow-api-http"
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
  name    = "${var.name_prefix}-allow-iap-ssh"
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
  name    = "${var.name_prefix}-allow-worker-rpc"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    # The gateway listens for worker traffic on this port.
    ports    = ["49134"]
  }

  # Only worker-tagged VMs can send this traffic to the gateway-tagged VM.
  source_tags = local.worker_tags
  target_tags = [local.api_tag]
}

# Creates the API gateway VM with both private and public networking.
resource "google_compute_instance" "api_gateway" {
  name         = "${var.name_prefix}-api-gateway"
  machine_type = var.api_machine_type
  zone         = var.zone
  # Firewall rules use this tag to identify the gateway.
  tags         = [local.api_tag]

  boot_disk {
    initialize_params {
      # Google creates a new boot disk from this image.
      image = var.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
    # Gives the gateway a fixed private IP so workers know where to connect.
    network_ip = var.gateway_private_ip

    access_config {
      # Attaches the reserved public IP to the gateway.
      nat_ip = google_compute_address.api.address
    }
  }

  # Startup scripts read this metadata from the VM metadata service.
  metadata = merge(local.common_metadata, {
    engine-url = "ws://${var.gateway_private_ip}:49134"
  })

  # This script runs when the VM boots for the first time.
  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-gateway.sh")

  allow_stopping_for_update = true

  # NAT must exist before startup so the VM can download packages and code.
  depends_on = [google_compute_router_nat.main]
}

# Creates the caller worker VM with private networking only.
resource "google_compute_instance" "caller_worker" {
  name         = "${var.name_prefix}-caller-worker"
  machine_type = var.caller_machine_type
  zone         = var.zone
  # Firewall rules use this tag to identify the caller worker.
  tags         = [local.caller_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    # Without access_config, Google does not assign this VM a public IP.
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = merge(local.common_metadata, {
    engine-url = "ws://${var.gateway_private_ip}:49134"
  })

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-caller.sh")

  allow_stopping_for_update = true

  # The worker starts after gateway and NAT are ready.
  depends_on = [
    google_compute_instance.api_gateway,
    google_compute_router_nat.main,
  ]
}

# Creates the inference worker VM with private networking and a larger disk.
resource "google_compute_instance" "inference_worker" {
  name         = "${var.name_prefix}-inference-worker"
  machine_type = var.inference_machine_type
  zone         = var.zone
  # Firewall rules use this tag to identify the inference worker.
  tags         = [local.inference_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      # Inference gets more disk space for runtime files and model data.
      size  = 50
      type  = "pd-balanced"
    }
  }

  network_interface {
    # Google assigns a private IP from the subnet above.
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = merge(local.common_metadata, {
    engine-url = "ws://${var.gateway_private_ip}:49134"
  })

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-inference.sh")

  allow_stopping_for_update = true

  depends_on = [
    google_compute_instance.api_gateway,
    google_compute_router_nat.main,
  ]
}
