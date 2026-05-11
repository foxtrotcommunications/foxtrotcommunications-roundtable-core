#!/bin/bash
# deploy-gke.sh — Deploy a Roundtable workspace to GKE
# Usage: ./deploy-gke.sh <workspace-id> <workspace-name>
#
# Prerequisites:
#   1. GKE cluster created:
#      gcloud container clusters create roundtable --num-nodes=2 \
#        --machine-type=e2-medium --region=us-central1 \
#        --workload-pool=roundtable-public.svc.id.goog \
#        --project=roundtable-public
#
#   2. Cloud SQL instance + database (same as Cloud Run)
#
#   3. Workload Identity binding for Cloud SQL:
#      kubectl create serviceaccount roundtable-sa
#      gcloud iam service-accounts create roundtable-gke --project=roundtable-public
#      gcloud projects add-iam-policy-binding roundtable-public \
#        --member="serviceAccount:roundtable-gke@roundtable-public.iam.gserviceaccount.com" \
#        --role="roles/cloudsql.client"
#      kubectl annotate serviceaccount roundtable-sa \
#        iam.gke.io/gcp-service-account=roundtable-gke@roundtable-public.iam.gserviceaccount.com
#
#   4. Secrets created:
#      kubectl create secret generic roundtable-secrets \
#        --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
#        --from-literal=DATABASE_URL=postgresql://roundtable:PASSWORD@127.0.0.1:5432/roundtable
#
#   5. ConfigMap applied:
#      kubectl apply -f k8s/configmap.yaml

set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> <workspace-name>}"
WORKSPACE_NAME="${2:-$WORKSPACE_ID}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  Deploying workspace to GKE: ${WORKSPACE_ID}"
echo "╚═══════════════════════════════════════════════════╝"

# Generate workspace manifest from template
sed "s/WORKSPACE_ID/${WORKSPACE_ID}/g; s/WORKSPACE_NAME/${WORKSPACE_NAME}/g" \
  k8s/workspace.yaml | kubectl apply -f -

echo ""
echo "✅ Workspace deployed: ${WORKSPACE_ID}"
echo "   Internal URL: http://rt-${WORKSPACE_ID}.default.svc.cluster.local:3000"
echo ""
echo "To expose externally, add a rule to k8s/ingress.yaml and apply:"
echo "  kubectl apply -f k8s/ingress.yaml"
