#!/bin/bash
# Argus — Automated Cloud Run Deployment
# Usage: ./deploy.sh <PROJECT_ID> <GEMINI_API_KEY>

set -euo pipefail

PROJECT_ID="${1:?Usage: ./deploy.sh <PROJECT_ID> <GEMINI_API_KEY>}"
API_KEY="${2:?Usage: ./deploy.sh <PROJECT_ID> <GEMINI_API_KEY>}"
REGION="us-central1"
SERVICE_NAME="argus"
REPO_NAME="argus"

echo "🏛️ Deploying Argus to Google Cloud Run..."
echo "   Project: $PROJECT_ID"
echo "   Region:  $REGION"

# Enable required APIs
echo "📡 Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT_ID" --quiet

# Create Artifact Registry repo (if not exists)
echo "📦 Setting up Artifact Registry..."
gcloud artifacts repositories create "$REPO_NAME" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID" --quiet 2>/dev/null || true

# Configure Docker auth
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Build and push Docker image
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:latest"
echo "🔨 Building Docker image..."
docker build -t "$IMAGE" ..
echo "📤 Pushing to Artifact Registry..."
docker push "$IMAGE"

# Deploy to Cloud Run
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=3 \
  --session-affinity \
  --set-env-vars="GEMINI_API_KEY=${API_KEY},GCP_PROJECT_ID=${PROJECT_ID}" \
  --quiet

# Get the URL
URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')

echo ""
echo "✅ Argus deployed successfully!"
echo "🌐 URL: $URL"
echo "👁️ Open this URL on your phone to start using Argus"
