#!/bin/bash
# Deploy Argus to Google Cloud Run
# Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY> [WEATHER_LAT] [WEATHER_LON] [TIMEZONE]

set -e

PROJECT_ID="agus-488919"
REGION="us-central1"
SERVICE_NAME="argus"
GEMINI_API_KEY="${1:-$GEMINI_API_KEY}"
WEATHER_LAT="${2:-${WEATHER_LAT:-41.88}}"
WEATHER_LON="${3:-${WEATHER_LON:--87.63}}"
TIMEZONE="${4:-${TIMEZONE:-America/Chicago}}"

if [ -z "$GEMINI_API_KEY" ]; then
    echo "Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY> [WEATHER_LAT] [WEATHER_LON] [TIMEZONE]"
    echo "Or set GEMINI_API_KEY environment variable"
    exit 1
fi

echo "🏛️ Deploying Argus to Cloud Run..."
echo "   Project:  $PROJECT_ID"
echo "   Region:   $REGION"
echo "   Service:  $SERVICE_NAME"
echo "   Location: $WEATHER_LAT, $WEATHER_LON ($TIMEZONE)"

# Configure project
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "📦 Enabling APIs..."
gcloud services enable \n    run.googleapis.com \n    artifactregistry.googleapis.com \n    cloudbuild.googleapis.com \n    firestore.googleapis.com

# Deploy directly from source (Cloud Build handles the Docker image)
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \n    --source . \n    --region $REGION \n    --allow-unauthenticated \n    --set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY,GCP_PROJECT_ID=$PROJECT_ID,WEATHER_LAT=$WEATHER_LAT,WEATHER_LON=$WEATHER_LON,TIMEZONE=$TIMEZONE" \n    --port 8080 \n    --memory 512Mi \n    --cpu 1 \n    --min-instances 0 \n    --max-instances 10 \n    --timeout 3600 \n    --session-affinity

# Get the URL
URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)')
echo ""
echo "✅ Argus deployed successfully!"
echo "🌐 URL: $URL"
echo ""
echo "Test: curl $URL/api/health"
echo "Open in browser: $URL"
