#!/bin/bash
# deploy-cloudrun.sh — Deploy a Roundtable workspace to Cloud Run
# Usage: ./deploy-cloudrun.sh <workspace-id> <workspace-name>
#
# Prerequisites:
#   1. Cloud SQL instance created:
#      gcloud sql instances create roundtable-db --database-version=POSTGRES_14 \
#        --tier=db-f1-micro --region=us-central1 --project=your-gcp-project
#      gcloud sql databases create roundtable --instance=roundtable-db
#
#   2. Secrets created in Secret Manager:
#      echo -n "postgresql://roundtable:PASSWORD@/roundtable?host=/cloudsql/your-gcp-project:us-central1:roundtable-db" | \
#        gcloud secrets create DATABASE_URL --data-file=- --project=your-gcp-project
#      openssl rand -hex 32 | gcloud secrets create SESSION_SECRET --data-file=- --project=your-gcp-project
#
#   3. Artifact Registry repo created:
#      gcloud artifacts repositories create roundtable --repository-format=docker \
#        --location=us-central1 --project=your-gcp-project
#
#   4. GCS bucket for workspace storage:
#      gsutil mb -p your-gcp-project -l us-central1 gs://roundtable-workspaces
#
#   5. Image built and pushed:
#      gcloud builds submit --project=your-gcp-project

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-your-gcp-project}"
REGION="${REGION:-us-central1}"
WORKSPACE_ID="${1:?Usage: $0 <workspace-id> <workspace-name>}"
WORKSPACE_NAME="${2:-$WORKSPACE_ID}"
SERVICE_NAME="rt-${WORKSPACE_ID}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/roundtable/roundtable:latest"
CLOUD_SQL_INSTANCE="${PROJECT_ID}:${REGION}:roundtable-db"
BUCKET="roundtable-workspaces"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  Deploying Roundtable workspace: ${WORKSPACE_ID}"
echo "║  Service:  ${SERVICE_NAME}"
echo "║  Project:  ${PROJECT_ID}"
echo "║  Region:   ${REGION}"
echo "╚═══════════════════════════════════════════════════╝"

gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --execution-environment=gen2 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=1 \
  --max-instances=3 \
  --port=3000 \
  --session-affinity \
  --allow-unauthenticated \
  --add-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
  --set-env-vars="WORKSPACE_ID=${WORKSPACE_ID},WORKSPACE_NAME=${WORKSPACE_NAME},GCP_PROJECT=${PROJECT_ID},GCP_LOCATION=${REGION}" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest" \
  --update-volumes="name=workspace,type=cloud-storage,bucket=${BUCKET},mount-path=/app/workspace"

# Get the service URL and update WORKSPACE_URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')

echo ""
echo "✅ Deployed: ${SERVICE_URL}"
echo "   Workspace: ${WORKSPACE_ID} (${WORKSPACE_NAME})"
echo ""
echo "To update WORKSPACE_URL for cross-workspace messaging:"
echo "  gcloud run services update ${SERVICE_NAME} --update-env-vars=WORKSPACE_URL=${SERVICE_URL}"
