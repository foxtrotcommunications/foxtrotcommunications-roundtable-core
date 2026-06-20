#!/bin/bash
# =============================================================================
# Pendragon Demo — Full Setup Script
# =============================================================================
# Rebuilds the entire Pendragon Capital demo from scratch:
#   1. Creates Kubernetes namespace
#   2. Creates Cloud SQL databases (one per workspace)
#   3. Runs schema migrations (core + domain-specific)
#   4. Seeds demo data
#   4.5 Creates ConfigMap patches from local source
#   5. Creates Kubernetes deployments for each workspace
#   5.5 Creates Ingress with host rules
#   5.75 Creates BigQuery dataset + tracing table
#   6. Seeds Firestore (workspaces, bridges, contracts)
#   7. Verifies everything is running
#
# Prerequisites:
#   - gcloud CLI authenticated with roundtable-public project
#   - kubectl configured for the target GKE cluster
#   - Cloud SQL Proxy running on localhost:5432
#   - Node.js ≥ 18 with firebase-admin installed
#   - jq, psql available on PATH
#
# Usage:
#   ./scripts/setup.sh
#   ./scripts/setup.sh --skip-k8s        # Skip namespace/deployment creation
#   ./scripts/setup.sh --skip-firestore  # Skip Firestore seeding
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — read from JSON config files
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEMO_DIR/config"
SQL_DIR="$DEMO_DIR/sql"

# Parse org config
ORG_ID=$(jq -r '.orgId' "$CONFIG_DIR/org.json")
ORG_SLUG=$(jq -r '.orgSlug' "$CONFIG_DIR/org.json")
GCP_PROJECT=$(jq -r '.gcpProject' "$CONFIG_DIR/org.json")
NAMESPACE=$(jq -r '.clusterNamespace' "$CONFIG_DIR/org.json")
REDIS_URL=$(jq -r '.redisUrl' "$CONFIG_DIR/org.json")
DOCKER_IMAGE=$(jq -r '.dockerImage' "$CONFIG_DIR/org.json")

# Cloud SQL connection — expects proxy on localhost
CLOUD_SQL_INSTANCE="roundtable-public-pg"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-roundtable}"
DB_PASS="${DB_PASS:-yXmA7986!}"

# ---------------------------------------------------------------------------
# Colors & helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()    { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Parse CLI flags
SKIP_K8S=false
SKIP_FIRESTORE=false
for arg in "$@"; do
  case $arg in
    --skip-k8s)       SKIP_K8S=true ;;
    --skip-firestore) SKIP_FIRESTORE=true ;;
    --help)
      echo "Usage: $0 [--skip-k8s] [--skip-firestore]"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
log_step "Phase 0: Preflight Checks"

for cmd in gcloud kubectl jq psql node bq; do
  if ! command -v "$cmd" &> /dev/null; then
    log_error "Required command not found: $cmd"
    exit 1
  fi
done
log_success "All required commands available"

# Verify config files exist
for f in org.json workspaces.json bridges.json contracts.json; do
  if [[ ! -f "$CONFIG_DIR/$f" ]]; then
    log_error "Missing config file: $CONFIG_DIR/$f"
    exit 1
  fi
done
log_success "All config files present"

# Verify SQL files exist
for f in 00-schema-core.sql 01-schema-plaid.sql 02-schema-realestate.sql 03-schema-investments.sql seed-checking.sql seed-debt.sql seed-realestate.sql seed-investments.sql seed-retirement.sql seed-taxes.sql; do
  if [[ ! -f "$SQL_DIR/$f" ]]; then
    log_error "Missing SQL file: $SQL_DIR/$f"
    exit 1
  fi
done
log_success "All SQL files present"

# Test Cloud SQL Proxy connection
if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" &> /dev/null; then
  log_error "Cannot connect to Cloud SQL Proxy at $DB_HOST:$DB_PORT"
  log_error "Start the proxy: cloud-sql-proxy $GCP_PROJECT:us-central1:$CLOUD_SQL_INSTANCE"
  exit 1
fi
log_success "Cloud SQL Proxy is reachable"

echo ""
log_info "Organization: $ORG_SLUG ($ORG_ID)"
log_info "GCP Project:  $GCP_PROJECT"
log_info "Namespace:    $NAMESPACE"
log_info "Workspaces:   $(jq length "$CONFIG_DIR/workspaces.json")"

# ---------------------------------------------------------------------------
# Phase 1: Kubernetes Namespace
# ---------------------------------------------------------------------------
if [[ "$SKIP_K8S" == false ]]; then
  log_step "Phase 1: Kubernetes Namespace"

  if kubectl get namespace "$NAMESPACE" &> /dev/null; then
    log_warn "Namespace $NAMESPACE already exists — skipping creation"
  else
    kubectl create namespace "$NAMESPACE"
    log_success "Created namespace: $NAMESPACE"
  fi

  # Label the namespace for easy identification
  kubectl label namespace "$NAMESPACE" \
    roundtable.io/org="$ORG_SLUG" \
    roundtable.io/env="demo" \
    --overwrite
  log_success "Namespace labeled"
fi

# ---------------------------------------------------------------------------
# Phase 2: Cloud SQL Databases
# ---------------------------------------------------------------------------
log_step "Phase 2: Cloud SQL Databases"

WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")

  # Check if database already exists
  if gcloud sql databases describe "$DB_NAME" \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$GCP_PROJECT" &> /dev/null; then
    log_warn "Database $DB_NAME already exists ($WS_NAME) — skipping"
  else
    gcloud sql databases create "$DB_NAME" \
      --instance="$CLOUD_SQL_INSTANCE" \
      --project="$GCP_PROJECT" \
      --quiet
    log_success "Created database: $DB_NAME ($WS_NAME)"
  fi
done

# ---------------------------------------------------------------------------
# Phase 3: Schema Migrations
# ---------------------------------------------------------------------------
log_step "Phase 3: Schema Migrations"

# Helper: run a SQL file against a specific database
run_sql() {
  local db="$1"
  local sql_file="$2"
  local description="$3"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" \
    -f "$sql_file" \
    --quiet --no-psqlrc 2>&1 | grep -v "NOTICE" || true
  log_success "$description → $db"
}

# 3a. Core schema → all workspaces
log_info "Applying core schema to all workspaces..."
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  run_sql "$DB_NAME" "$SQL_DIR/00-schema-core.sql" "Core schema ($WS_NAME)"
done

# 3b. Plaid schema → checking, debt, investments, retirement, taxes
log_info "Applying Plaid schema to domain workspaces..."
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  if [[ "$DOMAIN_TYPE" == "checking" || "$DOMAIN_TYPE" == "debt" || "$DOMAIN_TYPE" == "investments" || "$DOMAIN_TYPE" == "retirement" || "$DOMAIN_TYPE" == "taxes" ]]; then
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    run_sql "$DB_NAME" "$SQL_DIR/01-schema-plaid.sql" "Plaid schema ($WS_NAME)"
  fi
done

# 3c. Real estate schema → Real Estate workspace
log_info "Applying Real Estate schema..."
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  if [[ "$DOMAIN_TYPE" == "realestate" ]]; then
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    run_sql "$DB_NAME" "$SQL_DIR/02-schema-realestate.sql" "Real Estate schema ($WS_NAME)"
  fi
done

# 3d. Investments schema → investments, retirement
log_info "Applying Investments schema..."
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  if [[ "$DOMAIN_TYPE" == "investments" || "$DOMAIN_TYPE" == "retirement" ]]; then
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    run_sql "$DB_NAME" "$SQL_DIR/03-schema-investments.sql" "Investments schema ($WS_NAME)"
  fi
done

# ---------------------------------------------------------------------------
# Phase 4: Seed Data
# ---------------------------------------------------------------------------
log_step "Phase 4: Seed Data"

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

  case "$DOMAIN_TYPE" in
    checking)    run_sql "$DB_NAME" "$SQL_DIR/seed-checking.sql" "Seed data ($WS_NAME)" ;;
    debt)        run_sql "$DB_NAME" "$SQL_DIR/seed-debt.sql" "Seed data ($WS_NAME)" ;;
    realestate)  run_sql "$DB_NAME" "$SQL_DIR/seed-realestate.sql" "Seed data ($WS_NAME)" ;;
    investments) run_sql "$DB_NAME" "$SQL_DIR/seed-investments.sql" "Seed data ($WS_NAME)" ;;
    retirement)  run_sql "$DB_NAME" "$SQL_DIR/seed-retirement.sql" "Seed data ($WS_NAME)" ;;
    taxes)       run_sql "$DB_NAME" "$SQL_DIR/seed-taxes.sql" "Seed data ($WS_NAME)" ;;
    null|"")     log_info "No seed data for orchestrator: $WS_NAME" ;;
    *)           log_warn "No seed file for domain type: $DOMAIN_TYPE ($WS_NAME)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Phase 4.5: ConfigMap Patches
# ---------------------------------------------------------------------------
if [[ "$SKIP_K8S" == false ]]; then
  log_step "Phase 4.5: ConfigMap Patches"
  REPO_ROOT="$(cd "$DEMO_DIR/.." && pwd)"

  for cm_spec in \
    "a2a-server-patch:server.ts:$REPO_ROOT/server/a2a/server.ts" \
    "intent-bridge-patch:intentBridge.ts:$REPO_ROOT/server/tools/intentBridge.ts" \
    "aiprovider-patch:aiProvider.ts:$REPO_ROOT/server/services/aiProvider.ts" \
    "contract-auth-patch:contractAuth.js:$REPO_ROOT/server/utils/contractAuth.js"; do
    CM_NAME="${cm_spec%%:*}"
    cm_rest="${cm_spec#*:}"
    CM_KEY="${cm_rest%%:*}"
    CM_FILE="${cm_rest#*:}"
    if [[ -f "$CM_FILE" ]]; then
      kubectl create configmap "$CM_NAME" -n "$NAMESPACE" \
        --from-file="$CM_KEY=$CM_FILE" \
        --dry-run=client -o yaml | kubectl apply -f -
      log_success "ConfigMap: $CM_NAME"
    else
      log_warn "Source file not found for $CM_NAME: $CM_FILE"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Phase 5: Kubernetes Deployments
# ---------------------------------------------------------------------------
if [[ "$SKIP_K8S" == false ]]; then
  log_step "Phase 5: Kubernetes Deployments"

  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    WS_ID=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    DEPLOY_NAME=$(jq -r ".[$i].deploymentName" "$CONFIG_DIR/workspaces.json")
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    AI_PROVIDER=$(jq -r ".[$i].aiProvider" "$CONFIG_DIR/workspaces.json")
    AI_MODEL=$(jq -r ".[$i].aiModel" "$CONFIG_DIR/workspaces.json")
    WS_URL=$(jq -r ".[$i].url" "$CONFIG_DIR/workspaces.json")
    A2A_KEY=$(jq -r ".[$i].a2aApiKey" "$CONFIG_DIR/workspaces.json")
    WS_ROLE=$(jq -r ".[$i].role" "$CONFIG_DIR/workspaces.json")
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")

    log_info "Deploying $WS_NAME ($DEPLOY_NAME)..."

    # Build the DATABASE_URL for Cloud SQL via internal proxy sidecar (with password)
    DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"

    # Build orchestrator-specific env block (RT_BRIDGES, RT_CONTRACTS, OPENAI_API_KEY)
    ORCH_ENV=""
    if [[ "$WS_ROLE" == "orchestrator" ]]; then
      BRIDGES_JSON=$(jq -c '.' "$CONFIG_DIR/bridges.json")
      CONTRACTS_JSON=$(jq -c '.' "$CONFIG_DIR/contracts.json")
      ORCH_ENV="
            - name: RT_BRIDGES
              value: '${BRIDGES_JSON}'
            - name: RT_CONTRACTS
              value: '${CONTRACTS_JSON}'
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: roundtable-secret
                  key: openai-api-key"
    fi

    # Create or update the deployment
    kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEPLOY_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: roundtable-workspace
    workspace-id: "${WS_ID}"
    workspace-role: "${WS_ROLE}"
    org: "${ORG_SLUG}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DEPLOY_NAME}
  template:
    metadata:
      labels:
        app: ${DEPLOY_NAME}
        workspace-id: "${WS_ID}"
        workspace-role: "${WS_ROLE}"
    spec:
      containers:
        - name: workspace
          image: ${DOCKER_IMAGE}
          ports:
            - containerPort: 3000
          env:
            - name: WORKSPACE_ID
              value: "${WS_ID}"
            - name: WORKSPACE_NAME
              value: "${WS_NAME}"
            - name: WS_ID
              value: "${WS_ID}"
            - name: WS_NAME
              value: "${WS_NAME}"
            - name: WORKSPACE_ROLE
              value: "${WS_ROLE}"
            - name: DOMAIN_TYPE
              value: "${DOMAIN_TYPE}"
            - name: DATABASE_URL
              value: "${DATABASE_URL}"
            - name: AI_PROVIDER
              value: "${AI_PROVIDER}"
            - name: AI_MODEL
              value: "${AI_MODEL}"
            - name: REDIS_URL
              value: "${REDIS_URL}"
            - name: A2A_API_KEY
              value: "${A2A_KEY}"
            - name: A2A_SERVER_ENABLED
              value: "true"
            - name: ORG_ID
              value: "${ORG_ID}"
            - name: ORG_SLUG
              value: "${ORG_SLUG}"
            - name: FIREBASE_PROJECT_ID
              value: "${GCP_PROJECT}"
            - name: GCP_PROJECT
              value: "${GCP_PROJECT}"
            - name: NODE_ENV
              value: "production"
            - name: WORKSPACE_URL
              value: "${WS_URL}"
            - name: RT_DASHBOARD_URL
              value: "https://pendragon-demo.roundtable.foxtrotcommunications.net"
            - name: CONTROL_PLANE_URL
              value: "https://roundtable.foxtrotcommunications.net"
            - name: MONTHLY_TOKEN_CREDIT
              value: "Infinity"
            - name: PORT
              value: "3000"
            - name: SESSION_SECRET
              valueFrom:
                secretKeyRef:
                  name: roundtable-secret
                  key: session-secret
            - name: API_KEY_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: roundtable-secret
                  key: api-key-encryption-key
            - name: ORG_MASTER_SECRET
              valueFrom:
                secretKeyRef:
                  name: roundtable-secret
                  key: org-master-secret${ORCH_ENV}
          volumeMounts:
            - name: a2a-patch
              mountPath: /app/server/a2a/server.ts
              subPath: server.ts
            - name: intent-bridge-patch
              mountPath: /app/server/tools/intentBridge.ts
              subPath: intentBridge.ts
            - name: contract-auth-patch
              mountPath: /app/server/utils/contractAuth.js
              subPath: contractAuth.js
            - name: aiprovider-patch
              mountPath: /app/server/services/aiProvider.ts
              subPath: aiProvider.ts
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30
        # Cloud SQL Auth Proxy sidecar
        - name: cloud-sql-proxy
          image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.15.2
          args:
            - "--structured-logs"
            - "--auto-iam-authn"
            - "${GCP_PROJECT}:us-central1:${CLOUD_SQL_INSTANCE}"
          securityContext:
            runAsNonRoot: true
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
      volumes:
        - name: a2a-patch
          configMap:
            name: a2a-server-patch
        - name: intent-bridge-patch
          configMap:
            name: intent-bridge-patch
        - name: contract-auth-patch
          configMap:
            name: contract-auth-patch
        - name: aiprovider-patch
          configMap:
            name: aiprovider-patch
---
apiVersion: v1
kind: Service
metadata:
  name: ${DEPLOY_NAME}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: ${DEPLOY_NAME}
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
EOF

    log_success "Deployed: $WS_NAME → $DEPLOY_NAME"
  done
fi

# ---------------------------------------------------------------------------
# Phase 5.5: Ingress
# ---------------------------------------------------------------------------
if [[ "$SKIP_K8S" == false ]]; then
  log_step "Phase 5.5: Ingress"

  # Build rules array from workspaces.json
  INGRESS_RULES=""
  INGRESS_HOSTS=""
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    WS_ID=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
    DEPLOY_NAME=$(jq -r ".[$i].deploymentName" "$CONFIG_DIR/workspaces.json")
    HOST=$(echo "$WS_ID" | tr '[:upper:]' '[:lower:]').${ORG_SLUG}.ws.roundtable.foxtrotcommunications.net
    INGRESS_RULES+="
    - host: ${HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${DEPLOY_NAME}
                port:
                  number: 80"
    INGRESS_HOSTS+="
        - ${HOST}"
  done

  kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rt-ingress-${ORG_SLUG}
  namespace: ${NAMESPACE}
  labels:
    managed-by: roundtable-control-plane
    roundtable-org: ${ORG_SLUG}
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
spec:
  ingressClassName: nginx
  tls:
    - secretName: roundtable-ws-${ORG_SLUG}-tls
      hosts:
        - "*.${ORG_SLUG}.ws.roundtable.foxtrotcommunications.net"${INGRESS_HOSTS}
  rules:${INGRESS_RULES}
EOF
  log_success "Ingress created with $(echo $WORKSPACE_COUNT) host rules"
fi

# ---------------------------------------------------------------------------
# Phase 5.75: BigQuery & Tracing
# ---------------------------------------------------------------------------
log_step "Phase 5.75: BigQuery & Tracing"

# Create dataset (idempotent)
bq mk --project_id="$GCP_PROJECT" --dataset --if_not_exists roundtable_telemetry 2>/dev/null || true
log_success "BigQuery dataset: roundtable_telemetry"

# Create table (idempotent)
bq mk --project_id="$GCP_PROJECT" --table --if_not_exists \
  "roundtable_telemetry.request_traces" \
  "trace_id:STRING,span_id:STRING,parent_span_id:STRING,workspace_id:STRING,workspace_name:STRING,org_id:STRING,operation:STRING,tool_name:STRING,status:STRING,started_at:TIMESTAMP,duration_ms:INTEGER,input_preview:STRING,output_preview:STRING,metadata:STRING" \
  2>/dev/null || true
log_success "BigQuery table: request_traces"

# Grant IAM to GKE service account
GKE_SA="roundtable-gke@${GCP_PROJECT}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:$GKE_SA" \
  --role="roles/bigquery.dataEditor" \
  --quiet 2>/dev/null | tail -1
log_success "BigQuery IAM granted to $GKE_SA"

# ---------------------------------------------------------------------------
# Phase 6: Firestore Seeding
# ---------------------------------------------------------------------------
if [[ "$SKIP_FIRESTORE" == false ]]; then
  log_step "Phase 6: Firestore Seeding"

  if ! command -v node &> /dev/null; then
    log_error "Node.js is required for Firestore seeding"
    exit 1
  fi

  node "$SCRIPT_DIR/seed-firestore.js"
  log_success "Firestore seeded with workspaces, bridges, and contracts"
fi

# ---------------------------------------------------------------------------
# Phase 7: Verification
# ---------------------------------------------------------------------------
log_step "Phase 7: Verification"

"$SCRIPT_DIR/verify.sh" --quiet

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Pendragon Capital demo is ready!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
log_info "Org:       $ORG_SLUG"
log_info "Namespace: $NAMESPACE"
log_info "Project:   $GCP_PROJECT"
echo ""
