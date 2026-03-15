#!/bin/bash
# Deploy Argus to Cloud Run with full Firestore memory setup
set -e
PROJECT_ID="agus-488919"
REGION="us-central1"
SERVICE_NAME="argus"
GEMINI_API_KEY="${1:-$GEMINI_API_KEY}"
WEATHER_LAT="${2:-${WEATHER_LAT:-41.88}}"
WEATHER_LON="${3:-${WEATHER_LON:--87.63}}"
TIMEZONE="${4:-${TIMEZONE:-America/Chicago}}"
if [ -z "$GEMINI_API_KEY" ]; then
  echo "Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY>"
  exit 1
fi
echo "Deploying Argus v0.3..."
echo "  Project: $PROJECT_ID | Region: $REGION"
gcloud config set project $PROJECT_ID
# Enable APIs
echo "Enabling APIs..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com
# Create Firestore database (skips if already exists)
echo "Setting up Firestore..."
gcloud firestore databases create --location=us-central --type=firestore-native 2>/dev/null || echo "(Firestore already exists)"
# Grant Cloud Run service account Firestore access
echo "Granting Firestore permissions..."
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/datastore.user" --condition=None 2>/dev/null || true
echo "  Service account $SA granted datastore.user"
# Deploy
echo "Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY,GCP_PROJECT_ID=$PROJECT_ID,WEATHER_LAT=$WEATHER_LAT,WEATHER_LON=$WEATHER_LON,TIMEZONE=$TIMEZONE" \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --timeout 3600 \
  --session-affinity
URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)")
echo ""
echo "Argus deployed!"
echo "URL: $URL"
echo "Open on your phone: $URL"
