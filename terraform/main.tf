# Argus — Infrastructure as Code (Terraform)
# Automated Google Cloud deployment for bonus hackathon points

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
  default     = "agus-488919"
}

variable "region" {
  description = "Google Cloud region"
  type        = string
  default     = "us-central1"
}

variable "gemini_api_key" {
  description = "Gemini API key"
  type        = string
  sensitive   = true
}

variable "ws_shared_secret" {
  description = "Shared secret gating the WebSocket endpoint. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  type        = string
  sensitive   = true
}

variable "weather_lat" {
  description = "Latitude for weather (default: Chicago)"
  type        = string
  default     = "41.88"
}

variable "weather_lon" {
  description = "Longitude for weather (default: Chicago)"
  type        = string
  default     = "-87.63"
}

variable "timezone" {
  description = "Timezone for time-aware responses"
  type        = string
  default     = "America/Chicago"
}

variable "max_global_concurrent_sessions" {
  description = "Fleet-wide cap on concurrent WebSocket/Gemini sessions across all Cloud Run instances"
  type        = string
  # Raised from 250: the Firestore sharded counter behind this is deliberately
  # approximate, so a cap only 25% above a 200-user target would start
  # rejecting real users before 200 was actually reached.
  default     = "400"
}

variable "billing_account_id" {
  description = "Billing account ID (format XXXXXX-XXXXXX-XXXXXX, from `gcloud billing accounts list`) to attach a budget alert to. Leave empty to skip creating the budget — there is otherwise NO spend cap anywhere in this stack, and a Gemini Live API bill scales directly with concurrent open connections."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly budget amount (USD) that triggers alert emails to billing account admins at 50%/90%/100%/150% of this figure. Only used if billing_account_id is set."
  type        = number
  default     = 500
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

resource "google_project_service" "firestore" {
  service = "firestore.googleapis.com"
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
        name  = "WS_SHARED_SECRET"
        value = var.ws_shared_secret
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "WEATHER_LAT"
        value = var.weather_lat
      }

      env {
        name  = "WEATHER_LON"
        value = var.weather_lon
      }

      env {
        name  = "TIMEZONE"
        value = var.timezone
      }

      env {
        name  = "MAX_GLOBAL_CONCURRENT_SESSIONS"
        value = var.max_global_concurrent_sessions
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }
    }

    # Sizing revisited 2026-08-09: the binding constraint here is CPU, not
    # memory. Each session JSON-parses a ~43KB base64 audio chunk every second
    # plus a ~150KB base64 JPEG every 2s, and re-serialises both to the Gemini
    # SDK, so per-instance concurrency is really "how many simultaneous
    # transcode+relay streams fit on one vCPU". The earlier relay-load test
    # measured only ~0.7-0.9MB RSS per connection, which is why the previous
    # 1cpu/1Gi/40-concurrency shape looked comfortable on memory while being
    # tight on CPU. Now 2 vCPU for 25 concurrent streams, and 20 * 25 = 500
    # slots against the 200-concurrent-user target — headroom matters because
    # session affinity sticks reconnects to one instance, so load is not
    # evenly distributed.
    max_instance_request_concurrency = 25

    scaling {
      # Logs showed a cold start on essentially every session at low traffic
      # ("Starting new instance. Reason: AUTOSCALING" 2-3s before most
      # connects), adding ~700ms-1s to connection open. One warm instance
      # removes that for the common case.
      min_instance_count = 1
      max_instance_count = 20
    }

    session_affinity = true
    timeout          = "3600s"
  }

  depends_on = [
    google_project_service.run,
    google_artifact_registry_repository.argus
  ]
}

# Allow unauthenticated access
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.argus.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Budget alert — there's no hard spend cap anywhere in this stack (Gemini
# Live billing scales with concurrent open connections, and the WS auth
# secret is readable in the public page's HTML per known issue #12), so
# this is the backstop that turns "silent runaway bill" into "an email
# fires." Optional (count=0 skips it) since billing_account_id has no safe
# default — get it from `gcloud billing accounts list` and pass it via
# `-var="billing_account_id=..."`, or set TF_VAR_billing_account_id.
resource "google_billing_budget" "argus_budget" {
  count           = var.billing_account_id != "" ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "Argus monthly budget"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  threshold_rules { threshold_percent = 1.5 }
  # No monitoring_notification_channels set — defaults to emailing billing
  # account admins/users, no extra Pub/Sub or notification-channel infra
  # needed for a first pass.
}

# Output the service URL
output "service_url" {
  value       = google_cloud_run_v2_service.argus.uri
  description = "Argus Cloud Run service URL"
}
