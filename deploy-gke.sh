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

  # Grant BigQuery access — least-privilege (optional):
  #   Set BQ_DATA_PROJECT and BQ_DATASETS to grant cross-project BigQuery access.
  #   BQ_DATA_PROJECT — the GCP project containing the datasets
  #   BQ_DATASETS     — space-separated list of dataset names to grant READER on
  #
  # Example:
  #   BQ_DATA_PROJECT=my-data-project BQ_DATASETS="dataset1 dataset2" ./deploy-gke.sh --setup
  BQ_DATA_PROJECT="${BQ_DATA_PROJECT:-}"
  BQ_DATASETS="${BQ_DATASETS:-}"

  if [[ -n "${BQ_DATA_PROJECT}" ]]; then
    # jobUser at project level (required to run query jobs)
    gcloud projects add-iam-policy-binding "${BQ_DATA_PROJECT}" \
      --member="serviceAccount:${GCP_SA_EMAIL}" \
      --role="roles/bigquery.jobUser" \
      --condition=None --quiet >/dev/null 2>&1
    echo "  ✓ BigQuery jobUser granted on ${BQ_DATA_PROJECT}"

    if [[ -n "${BQ_DATASETS}" ]]; then
      # Grant READER on each authorized dataset via BigQuery REST API (idempotent)
      BQ_TOKEN=$(gcloud auth print-access-token)
      for BQ_DATASET in ${BQ_DATASETS}; do
        CURRENT_ACCESS=$(curl -s -H "Authorization: Bearer ${BQ_TOKEN}" \
          "https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_DATA_PROJECT}/datasets/${BQ_DATASET}" \
          | python3 -c "
import json,sys
d=json.load(sys.stdin)
access=d.get('access',[])
if not any(a.get('userByEmail')=='${GCP_SA_EMAIL}' for a in access):
    access.append({'role':'READER','userByEmail':'${GCP_SA_EMAIL}'})
print(json.dumps({'access':access}))
" 2>/dev/null)
        curl -s -X PATCH \
          -H "Authorization: Bearer ${BQ_TOKEN}" \
          -H "Content-Type: application/json" \
          "https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_DATA_PROJECT}/datasets/${BQ_DATASET}" \
          -d "${CURRENT_ACCESS}" >/dev/null 2>&1
        echo "  ✓ BigQuery READER on ${BQ_DATA_PROJECT}.${BQ_DATASET}"
      done
    fi
  else
    echo "  ⊘ BQ_DATA_PROJECT not set — skipping cross-project BigQuery IAM grants"
  fi

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
  echo "→ Step 4/7: Creating secrets..."
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
  # DATABASE_URL points to pgbouncer ClusterIP service (not localhost).
  # PgBouncer handles Cloud SQL proxy connectivity centrally.
  kubectl create secret generic roundtable-secrets \
    --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
    --from-literal=DATABASE_URL="postgresql://roundtable:${DB_PASSWORD}@pgbouncer:5432/roundtable" \
    --from-literal=PGBOUNCER_DB_USER="roundtable" \
    --from-literal=PGBOUNCER_DB_PASSWORD="${DB_PASSWORD}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "  ✓ Secrets created (DB via PgBouncer service)"

  # 5. Deploy PgBouncer (connection pooler with Cloud SQL proxy sidecar)
  echo ""
  echo "→ Step 5/7: Deploying PgBouncer..."
  export CLOUDSQL_CONNECTION GCP_SA_EMAIL
  envsubst < k8s/overlays/gcp/pgbouncer.yaml | kubectl apply -f -
  echo "  ⏳ Waiting for PgBouncer to be ready..."
  kubectl rollout status deployment/pgbouncer --timeout=120s 2>/dev/null || true
  echo "  ✓ PgBouncer deployed (transaction-mode pooling, 20 real connections)"

  # 6. Install nginx-ingress
  echo ""
  echo "→ Step 6/7: Installing nginx-ingress controller..."
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
  echo "║  PgBouncer deployed — all workspaces route through it."
  echo "║  Config: transaction pooling, 20 real connections, 400 max clients"
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
DB_ROLE="rt_${WORKSPACE_ID}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  Deploying workspace to GKE: ${WORKSPACE_ID}"
echo "║  DB role: ${DB_ROLE}"
echo "╚═══════════════════════════════════════════════════╝"

# Ensure we have credentials
gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --region="${GCP_REGION}" --project="${GCP_PROJECT}" --quiet 2>/dev/null || true

# ─── Create per-workspace DB role ────────────────────────
echo "→ Creating database role: ${DB_ROLE}..."

# Get admin DB password
if [[ -z "${DB_PASSWORD:-}" ]]; then
  DB_URL=$(gcloud secrets versions access latest \
    --secret=DATABASE_URL --project="${GCP_PROJECT}" 2>/dev/null || true)
  if [[ -n "${DB_URL}" ]]; then
    DB_PASSWORD=$(echo "${DB_URL}" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
  fi
fi

# Generate a unique password for this workspace role
WS_DB_PASSWORD=$(openssl rand -hex 16)

# Create the workspace role via Cloud SQL proxy (using admin credentials)
# The roundtable admin role has BYPASSRLS and owns all tables
ADMIN_DB_URL="postgresql://roundtable:${DB_PASSWORD}@pgbouncer:5432/roundtable"

# Use a temporary pod to run the role creation SQL
kubectl run db-setup-${WORKSPACE_ID} \
  --image=postgres:15-alpine \
  --restart=Never \
  --rm -i --quiet \
  --env="PGPASSWORD=${DB_PASSWORD}" \
  -- psql "host=pgbouncer port=5432 dbname=roundtable user=roundtable" -c "
    -- Ensure admin role has BYPASSRLS (idempotent)
    ALTER ROLE roundtable BYPASSRLS;

    -- Create workspace role if it doesn't exist
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_ROLE}') THEN
        CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${WS_DB_PASSWORD}';
      ELSE
        ALTER ROLE ${DB_ROLE} PASSWORD '${WS_DB_PASSWORD}';
      END IF;
    END \$\$;

    -- Grant DML permissions (no DDL, no BYPASSRLS)
    GRANT USAGE ON SCHEMA public TO ${DB_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${DB_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DB_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DB_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${DB_ROLE};
  " 2>/dev/null || echo "  ⚠ Role creation via pod failed — role may already exist"

echo "  ✓ DB role ${DB_ROLE} ready"

# ─── Create per-workspace K8s secret ────────────────────────
echo "→ Creating workspace secret: rt-${WORKSPACE_ID}-db..."
# DATABASE_URL uses the workspace-specific role (not the admin roundtable role)
kubectl create secret generic "rt-${WORKSPACE_ID}-db" \
  --from-literal=DATABASE_URL="postgresql://${DB_ROLE}:${WS_DB_PASSWORD}@pgbouncer:5432/roundtable" \
  --from-literal=WS_ID="${DB_ROLE}" \
  --dry-run=client -o yaml | kubectl apply -f - -n "${NAMESPACE}"
echo "  ✓ Workspace secret created (connects as ${DB_ROLE} via PgBouncer)"

# ─── Deploy workspace pod ────────────────────────
echo "→ Deploying workspace pod..."
# Deploy using GCP overlay (connects to PgBouncer — no Cloud SQL proxy sidecar needed)
export WORKSPACE_ID WORKSPACE_NAME NAMESPACE GCP_SA_EMAIL DB_ROLE
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
echo "╔═══════════════════════════════════════════════════╗"
echo "║  ✅ Workspace deployed: ${WORKSPACE_ID}"
echo "║"
echo "║  DB role:  ${DB_ROLE} (RLS-enforced, DML only)"
echo "║  Admin:    roundtable (BYPASSRLS, full access)"
echo "║  Secret:   rt-${WORKSPACE_ID}-db"
echo "║"
echo "║  Internal: http://rt-${WORKSPACE_ID}.${NAMESPACE}.svc.cluster.local:3000"
echo "║  External: http://${EXTERNAL_IP} (via ingress)"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "Pod status:"
kubectl get pods -l workspace=${WORKSPACE_ID} -n "${NAMESPACE}"

