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

locals {
  api_tag       = "${var.name_prefix}-api-gateway"
  caller_tag    = "${var.name_prefix}-caller-worker"
  inference_tag = "${var.name_prefix}-inference-worker"
  worker_tags   = [local.caller_tag, local.inference_tag]

  common_metadata = {
    enable-oslogin = "TRUE"
    repo-url       = var.repository_url
    repo-ref       = var.repository_ref
    iii-version    = var.iii_version
  }
}

resource "google_compute_network" "main" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "private" {
  name                     = "${var.name_prefix}-private"
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

resource "google_compute_router" "main" {
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.private.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

resource "google_compute_address" "api" {
  name   = "${var.name_prefix}-api-ip"
  region = var.region
}

resource "google_compute_firewall" "api_http" {
  name    = "${var.name_prefix}-allow-api-http"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.api_tag]
}

resource "google_compute_firewall" "iap_ssh" {
  name    = "${var.name_prefix}-allow-iap-ssh"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.api_tag, local.caller_tag, local.inference_tag]
}

resource "google_compute_firewall" "worker_rpc" {
  name    = "${var.name_prefix}-allow-worker-rpc"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["49134"]
  }

  source_tags = local.worker_tags
  target_tags = [local.api_tag]
}

resource "google_compute_instance" "api_gateway" {
  name         = "${var.name_prefix}-api-gateway"
  machine_type = var.api_machine_type
  zone         = var.zone
  tags         = [local.api_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
    network_ip = var.gateway_private_ip

    access_config {
      nat_ip = google_compute_address.api.address
    }
  }

  metadata = merge(local.common_metadata, {
    engine-url = "ws://${var.gateway_private_ip}:49134"
  })

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-gateway.sh")

  allow_stopping_for_update = true

  depends_on = [google_compute_router_nat.main]
}

resource "google_compute_instance" "caller_worker" {
  name         = "${var.name_prefix}-caller-worker"
  machine_type = var.caller_machine_type
  zone         = var.zone
  tags         = [local.caller_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = merge(local.common_metadata, {
    engine-url = "ws://${var.gateway_private_ip}:49134"
  })

  metadata_startup_script = file("${path.module}/../../deploy/scripts/bootstrap-caller.sh")

  allow_stopping_for_update = true

  depends_on = [
    google_compute_instance.api_gateway,
    google_compute_router_nat.main,
  ]
}

resource "google_compute_instance" "inference_worker" {
  name         = "${var.name_prefix}-inference-worker"
  machine_type = var.inference_machine_type
  zone         = var.zone
  tags         = [local.inference_tag]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = 50
      type  = "pd-balanced"
    }
  }

  network_interface {
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
