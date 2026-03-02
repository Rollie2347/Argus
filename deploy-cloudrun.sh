#!/bin/bash
# Deploy Argus to Google Cloud Run
# Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY>

set -e

PROJECT_ID="agus-488919"
REGION="us-central1"
SERVICE_NAME="argus"
GEMINI_API_KEY="${1:-$GEMINI_API_KEY}"

if [ -z "$GEMINI_API_KEY" ]; then
    echo "Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY>"
    echo "Or set GEMINI_API_KEY environment variable"
    exit 1
fi

echo "🏛️ Deploying Argus to Cloud Run..."
echo "   Project: $PROJECT_ID"
echo "   Region:  $REGION"
echo "   Service: $SERVICE_NAME"

# Configure project
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "📦 Enabling APIs..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# Deploy directly from source (Cloud Build will build the Docker image)
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
    --source . \
    --region $REGION \
    --allow-unauthenticated \
    --set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY,GCP_PROJECT_ID=$PROJECT_ID" \
    --port 8080 \
    --memory 512Mi \
    --cpu 1 \
    --min-instances 0 \
    --max-instances 10 \
    --timeout 3600 \
    --session-affinity

# Get the URL
URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)')
echo ""
echo "✅ Argus deployed successfully!"
echo "🌐 URL: $URL"
echo ""
echo "Test it: curl $URL/api/health"
