# Argus — Cloud Run Deployment (Terraform IaC)
# This automates deployment for the Gemini Live Agent Challenge

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "us-central1"
}

variable "gemini_api_key" {
  description = "Gemini API Key"
  type        = string
  sensitive   = true
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "run" {
  service = "run.googleapis.com"
}

resource "google_project_service" "artifactregistry" {
  service = "artifactregistry.googleapis.com"
}

resource "google_project_service" "cloudbuild" {
  service = "cloudbuild.googleapis.com"
}

# Artifact Registry for Docker images
resource "google_artifact_registry_repository" "argus" {
  location      = var.region
  repository_id = "argus"
  format        = "DOCKER"

  depends_on = [google_project_service.artifactregistry]
}

# Cloud Run service
resource "google_cloud_run_v2_service" "argus" {
  name     = "argus"
  location = var.region

  template {
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/argus/argus:latest"

      ports {
        container_port = 8080
      }

      env {
        name  = "GEMINI_API_KEY"
        value = var.gemini_api_key
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    # WebSocket support requires session affinity
    session_affinity = true
  }

  depends_on = [
    google_project_service.run,
    google_artifact_registry_repository.argus
  ]
}

# Allow unauthenticated access (public demo)
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.argus.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "url" {
  value       = google_cloud_run_v2_service.argus.uri
  description = "Argus public URL"
}
