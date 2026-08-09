#!/bin/bash
# Deploy Argus to Cloud Run with full Firestore memory setup
set -e
PROJECT_ID="agus-488919"
REGION="us-central1"
SERVICE_NAME="argus"
GEMINI_API_KEY="${1:-$GEMINI_API_KEY}"
WS_SHARED_SECRET="${2:-$WS_SHARED_SECRET}"
WEATHER_LAT="${3:-${WEATHER_LAT:-41.88}}"
WEATHER_LON="${4:-${WEATHER_LON:--87.63}}"
TIMEZONE="${5:-${TIMEZONE:-America/Chicago}}"
MAX_GLOBAL_CONCURRENT_SESSIONS="${6:-${MAX_GLOBAL_CONCURRENT_SESSIONS:-250}}"
if [ -z "$GEMINI_API_KEY" ] || [ -z "$WS_SHARED_SECRET" ]; then
  echo "Usage: ./deploy-cloudrun.sh <GEMINI_API_KEY> <WS_SHARED_SECRET> [WEATHER_LAT] [WEATHER_LON] [TIMEZONE] [MAX_GLOBAL_CONCURRENT_SESSIONS]"
  echo "Generate a shared secret with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
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
  --set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY,WS_SHARED_SECRET=$WS_SHARED_SECRET,GCP_PROJECT_ID=$PROJECT_ID,WEATHER_LAT=$WEATHER_LAT,WEATHER_LON=$WEATHER_LON,TIMEZONE=$TIMEZONE,MAX_GLOBAL_CONCURRENT_SESSIONS=$MAX_GLOBAL_CONCURRENT_SESSIONS" \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 15 \
  --concurrency 40 \
  --timeout 3600 \
  --session-affinity
URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)")
echo ""
echo "Argus deployed!"
echo "URL: $URL"
echo "Open on your phone: $URL"
echo ""
echo "NOTE: there is still no billing budget alert configured. Gemini Live cost"
echo "scales directly with concurrent open connections and there's no cap on"
echo "spend itself (only on connection count, via MAX_GLOBAL_CONCURRENT_SESSIONS)."
echo "Set one up with:"
echo "  gcloud billing accounts list"
echo "  gcloud billing budgets create --billing-account=<ACCOUNT_ID> \\"
echo "    --display-name=\"Argus monthly budget\" --budget-amount=500USD \\"
echo "    --filter-projects=projects/$PROJECT_ID \\"
echo "    --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \\"
echo "    --threshold-rule=percent=1.0 --threshold-rule=percent=1.5"
