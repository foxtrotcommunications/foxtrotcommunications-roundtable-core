#!/bin/bash
# deploy-gke.sh — Deploy Roundtable to Google Kubernetes Engine
#
# Usage:
#   First time (creates cluster + IAM + secrets):
#     ./deploy-gke.sh --setup
#
#   Deploy a workspace:
#     ./deploy-gke.sh <workspace-id> [workspace-name]
#
# Environment:
#   GCP_PROJECT      — GCP project ID (default: your-gcp-project)
#   GCP_REGION       — GCP region (default: us-central1)
#   CLOUDSQL_INSTANCE — Cloud SQL instance name (default: roundtable-db)
#   AI_PROJECT       — GCP project for Vertex AI (default: same as GCP_PROJECT)
#   DB_PASSWORD      — Postgres password (reads from Secret Manager if not set)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-your-gcp-project}"
GCP_REGION="${GCP_REGION:-us-central1}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:-roundtable-db}"
AI_PROJECT="${AI_PROJECT:-${GCP_PROJECT}}"
CLUSTER_NAME="roundtable-standard"
GCP_SA_NAME="roundtable-gke"
GCP_SA_EMAIL="${GCP_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
CLOUDSQL_CONNECTION="${GCP_PROJECT}:${GCP_REGION}:${CLOUDSQL_INSTANCE}"

# ─── Setup Mode ───────────────────────────────────────
if [[ "${1:-}" == "--setup" ]]; then
  echo "╔═══════════════════════════════════════════════════╗"
  echo "║  GKE Setup: ${GCP_PROJECT}"
  echo "╚═══════════════════════════════════════════════════╝"

  # 1. Create Autopilot cluster
  echo ""
  echo "→ Step 1/5: Creating GKE Autopilot cluster..."
  if gcloud container clusters describe "${CLUSTER_NAME}" \
    --region="${GCP_REGION}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    echo "  ✓ Cluster '${CLUSTER_NAME}' already exists"
  else
    gcloud container clusters create "${CLUSTER_NAME}" \
      --region="${GCP_REGION}" \
      --project="${GCP_PROJECT}" \
      --machine-type=e2-standard-2 \
      --num-nodes=1 --min-nodes=1 --max-nodes=3 \
      --enable-autoscaling \
      --spot \
      --disk-type=pd-standard \
      --disk-size=50 \
      --workload-pool="${GCP_PROJECT}.svc.id.goog" \
      --release-channel=stable \
      --quiet
    echo "  ✓ Cluster created"
  fi

  # Get credentials
  gcloud container clusters get-credentials "${CLUSTER_NAME}" \
    --region="${GCP_REGION}" --project="${GCP_PROJECT}" --quiet
  echo "  ✓ kubectl configured"

  # 2. Create GCP service account + Workload Identity
  echo ""
  echo "→ Step 2/5: Setting up Workload Identity..."
  if gcloud iam service-accounts describe "${GCP_SA_EMAIL}" \
    --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    echo "  ✓ GCP SA '${GCP_SA_NAME}' already exists"
  else
    gcloud iam service-accounts create "${GCP_SA_NAME}" \
      --display-name="Roundtable GKE Workload Identity" \
      --project="${GCP_PROJECT}" --quiet
    echo "  ✓ GCP SA created"
  fi

  # Grant Cloud SQL client role
  gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
    --member="serviceAccount:${GCP_SA_EMAIL}" \
    --role="roles/cloudsql.client" \
    --condition=None --quiet >/dev/null 2>&1
  echo "  ✓ Cloud SQL client role granted"

  # Grant Vertex AI user role (on AI_PROJECT)
  gcloud projects add-iam-policy-binding "${AI_PROJECT}" \
    --member="serviceAccount:${GCP_SA_EMAIL}" \
    --role="roles/aiplatform.user" \
    --condition=None --quiet >/dev/null 2>&1
  echo "  ✓ Vertex AI user role granted on ${AI_PROJECT}"

  # Grant BigQuery access on the Foxtrot application data project (cross-project)
  FOXTROT_DATA_PROJECT="foxtrot-communications-public"
  gcloud projects add-iam-policy-binding "${FOXTROT_DATA_PROJECT}" \
    --member="serviceAccount:${GCP_SA_EMAIL}" \
    --role="roles/bigquery.jobUser" \
    --condition=None --quiet >/dev/null 2>&1
  gcloud projects add-iam-policy-binding "${FOXTROT_DATA_PROJECT}" \
    --member="serviceAccount:${GCP_SA_EMAIL}" \
    --role="roles/bigquery.dataViewer" \
    --condition=None --quiet >/dev/null 2>&1
  echo "  ✓ BigQuery access granted on ${FOXTROT_DATA_PROJECT}"

  # 3. Apply base config
  echo ""
  echo "→ Step 3/5: Applying ConfigMap..."
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: roundtable-config
data:
  PORT: "3000"
  NODE_ENV: "production"
  EMBED_MODE: "false"
  GCP_PROJECT: "${AI_PROJECT}"
  GCP_LOCATION: "${GCP_REGION}"
EOF
  echo "  ✓ ConfigMap applied"

  # 4. Create secrets
  echo ""
  echo "→ Step 4/5: Creating secrets..."
  # Get DB password from Secret Manager or env
  if [[ -z "${DB_PASSWORD:-}" ]]; then
    DB_URL=$(gcloud secrets versions access latest \
      --secret=DATABASE_URL --project="${GCP_PROJECT}" 2>/dev/null || true)
    if [[ -n "${DB_URL}" ]]; then
      # Extract password from DATABASE_URL
      DB_PASSWORD=$(echo "${DB_URL}" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
    fi
  fi

  if [[ -z "${DB_PASSWORD:-}" ]]; then
    echo "  ✗ Could not determine DB_PASSWORD. Set it via:"
    echo "    DB_PASSWORD=<password> ./deploy-gke.sh --setup"
    exit 1
  fi

  SESSION_SECRET=$(openssl rand -hex 32)
  # DATABASE_URL points to localhost because Cloud SQL proxy runs as sidecar
  kubectl create secret generic roundtable-secrets \
    --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
    --from-literal=DATABASE_URL="postgresql://roundtable:${DB_PASSWORD}@127.0.0.1:5432/roundtable" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "  ✓ Secrets created (DB via Cloud SQL proxy @ 127.0.0.1)"

  # 5. Install nginx-ingress
  echo ""
  echo "→ Step 5/5: Installing nginx-ingress controller..."
  kubectl get namespace ingress-nginx >/dev/null 2>&1 || {
    kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
    echo "  ⏳ Waiting for ingress controller..."
    kubectl wait --namespace ingress-nginx \
      --for=condition=ready pod \
      --selector=app.kubernetes.io/component=controller \
      --timeout=120s 2>/dev/null || true
  }
  echo "  ✓ nginx-ingress ready"

  echo ""
  echo "╔═══════════════════════════════════════════════════╗"
  echo "║  ✅ GKE setup complete!"
  echo "║"
  echo "║  Deploy workspaces with:"
  echo "║    ./deploy-gke.sh dev Development"
  echo "║    ./deploy-gke.sh backend 'Backend Team'"
  echo "╚═══════════════════════════════════════════════════╝"
  exit 0
fi

# ─── Workspace Deployment Mode ────────────────────────
WORKSPACE_ID="${1:?Usage: $0 <workspace-id> [workspace-name] | $0 --setup}"
WORKSPACE_NAME="${2:-$WORKSPACE_ID}"
NAMESPACE="${NAMESPACE:-default}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  Deploying workspace to GKE: ${WORKSPACE_ID}"
echo "╚═══════════════════════════════════════════════════╝"

# Ensure we have credentials
gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --region="${GCP_REGION}" --project="${GCP_PROJECT}" --quiet 2>/dev/null || true

# Deploy using GCP overlay (includes Cloud SQL proxy sidecar)
export WORKSPACE_ID WORKSPACE_NAME NAMESPACE CLOUDSQL_CONNECTION GCP_SA_EMAIL
export ROUNDTABLE_IMAGE="us-central1-docker.pkg.dev/${GCP_PROJECT}/roundtable/roundtable:$(git rev-parse --short HEAD)"
envsubst < k8s/overlays/gcp/workspace.yaml | kubectl apply -f - -n "${NAMESPACE}"

# Bind Workload Identity for this workspace's service account
gcloud iam service-accounts add-iam-policy-binding "${GCP_SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${GCP_PROJECT}.svc.id.goog[${NAMESPACE}/rt-${WORKSPACE_ID}]" \
  --project="${GCP_PROJECT}" --quiet >/dev/null 2>&1
echo "  ✓ Workload Identity bound for rt-${WORKSPACE_ID}"

# Wait for rollout
echo "→ Waiting for pod to be ready..."
kubectl rollout status statefulset/rt-${WORKSPACE_ID} -n "${NAMESPACE}" --timeout=180s 2>/dev/null || true

# Get external IP
EXTERNAL_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "pending")

echo ""
echo "✅ Workspace deployed: ${WORKSPACE_ID}"
echo "   Internal: http://rt-${WORKSPACE_ID}.${NAMESPACE}.svc.cluster.local:3000"
echo "   External: http://${EXTERNAL_IP} (via ingress)"
echo ""
echo "Pod status:"
kubectl get pods -l workspace=${WORKSPACE_ID} -n "${NAMESPACE}"
