#!/bin/bash
# =============================================================================
# Pendragon Demo — Verification Script
# =============================================================================
# Checks that the entire Pendragon demo is correctly deployed:
#   1. All workspace pods are running in Kubernetes
#   2. All databases exist and have the expected tables
#   3. Seed data is present in each domain database
#   4. Workspace health endpoints respond
#   5. Firestore documents exist
#   6. ConfigMaps are applied (a2a-server, intent-bridge, contract-auth, aiprovider)
#   7. Ingress exists and has correct host rules
#   8. BigQuery telemetry table exists
#
# Usage:
#   ./scripts/verify.sh           # Full output
#   ./scripts/verify.sh --quiet   # Summary only (used by setup.sh)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEMO_DIR/config"

NAMESPACE=$(jq -r '.clusterNamespace' "$CONFIG_DIR/org.json")
GCP_PROJECT=$(jq -r '.gcpProject' "$CONFIG_DIR/org.json")
ORG_ID=$(jq -r '.orgId' "$CONFIG_DIR/org.json")

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-roundtable}"

# CLI flags
QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

# ---------------------------------------------------------------------------
# Colors & helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

check_pass() {
  PASS=$((PASS + 1))
  [[ "$QUIET" == false ]] && echo -e "  ${GREEN}✓${NC} $1"
}

check_fail() {
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}✗${NC} $1"
}

check_warn() {
  WARN=$((WARN + 1))
  [[ "$QUIET" == false ]] && echo -e "  ${YELLOW}⚠${NC} $1"
}

log_step() {
  [[ "$QUIET" == false ]] && echo -e "\n${CYAN}━━━ $1 ━━━${NC}"
}

# ---------------------------------------------------------------------------
# Check 1: Kubernetes Pods
# ---------------------------------------------------------------------------
log_step "Check 1: Kubernetes Pods"

WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DEPLOY_NAME=$(jq -r ".[$i].deploymentName" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

  # Check if deployment exists and has ready replicas
  READY=$(kubectl get deployment "$DEPLOY_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")

  if [[ "$READY" -ge 1 ]]; then
    check_pass "$WS_NAME ($DEPLOY_NAME): $READY replica(s) ready"
  else
    # Check if deployment exists at all
    if kubectl get deployment "$DEPLOY_NAME" -n "$NAMESPACE" &> /dev/null; then
      check_fail "$WS_NAME ($DEPLOY_NAME): 0 ready replicas"
    else
      check_fail "$WS_NAME ($DEPLOY_NAME): deployment not found"
    fi
  fi
done

# ---------------------------------------------------------------------------
# Check 2: Database Tables
# ---------------------------------------------------------------------------
log_step "Check 2: Database Tables"

# Helper: check if a table exists in a database
table_exists() {
  local db="$1"
  local table="$2"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" \
    -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '$table');" 2>/dev/null
}

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")

  # Core tables (all workspaces)
  for table in users messages workspaces audit_log workspace_usage; do
    RESULT=$(table_exists "$DB_NAME" "$table" || echo "f")
    if [[ "$RESULT" == "t" ]]; then
      check_pass "$WS_NAME: table '$table' exists"
    else
      check_fail "$WS_NAME: table '$table' missing"
    fi
  done

  # Domain-specific tables
  case "$DOMAIN_TYPE" in
    checking|debt)
      for table in plaid_accounts plaid_transactions plaid_liabilities; do
        RESULT=$(table_exists "$DB_NAME" "$table" || echo "f")
        if [[ "$RESULT" == "t" ]]; then
          check_pass "$WS_NAME: table '$table' exists"
        else
          check_fail "$WS_NAME: table '$table' missing"
        fi
      done
      ;;
    realestate)
      for table in properties mortgages property_valuations; do
        RESULT=$(table_exists "$DB_NAME" "$table" || echo "f")
        if [[ "$RESULT" == "t" ]]; then
          check_pass "$WS_NAME: table '$table' exists"
        else
          check_fail "$WS_NAME: table '$table' missing"
        fi
      done
      ;;
    investments|retirement)
      for table in plaid_holdings plaid_securities; do
        RESULT=$(table_exists "$DB_NAME" "$table" || echo "f")
        if [[ "$RESULT" == "t" ]]; then
          check_pass "$WS_NAME: table '$table' exists"
        else
          check_fail "$WS_NAME: table '$table' missing"
        fi
      done
      ;;
    taxes)
      for table in plaid_accounts plaid_transactions; do
        RESULT=$(table_exists "$DB_NAME" "$table" || echo "f")
        if [[ "$RESULT" == "t" ]]; then
          check_pass "$WS_NAME: table '$table' exists"
        else
          check_fail "$WS_NAME: table '$table' missing"
        fi
      done
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Check 3: Seed Data
# ---------------------------------------------------------------------------
log_step "Check 3: Seed Data"

# Helper: count rows in a table
row_count() {
  local db="$1"
  local table="$2"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" \
    -tAc "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "0"
}

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")

  case "$DOMAIN_TYPE" in
    checking)
      COUNT=$(row_count "$DB_NAME" "plaid_accounts")
      if [[ "$COUNT" -ge 3 ]]; then
        check_pass "$WS_NAME: $COUNT accounts seeded"
      else
        check_fail "$WS_NAME: expected ≥3 accounts, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "plaid_transactions")
      if [[ "$COUNT" -ge 20 ]]; then
        check_pass "$WS_NAME: $COUNT transactions seeded"
      else
        check_fail "$WS_NAME: expected ≥20 transactions, found $COUNT"
      fi
      ;;
    debt)
      COUNT=$(row_count "$DB_NAME" "plaid_accounts")
      if [[ "$COUNT" -ge 3 ]]; then
        check_pass "$WS_NAME: $COUNT accounts seeded"
      else
        check_fail "$WS_NAME: expected ≥3 accounts, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "plaid_liabilities")
      if [[ "$COUNT" -ge 3 ]]; then
        check_pass "$WS_NAME: $COUNT liabilities seeded"
      else
        check_fail "$WS_NAME: expected ≥3 liabilities, found $COUNT"
      fi
      ;;
    realestate)
      COUNT=$(row_count "$DB_NAME" "properties")
      if [[ "$COUNT" -ge 3 ]]; then
        check_pass "$WS_NAME: $COUNT properties seeded"
      else
        check_fail "$WS_NAME: expected ≥3 properties, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "mortgages")
      if [[ "$COUNT" -ge 3 ]]; then
        check_pass "$WS_NAME: $COUNT mortgages seeded"
      else
        check_fail "$WS_NAME: expected ≥3 mortgages, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "property_valuations")
      if [[ "$COUNT" -ge 9 ]]; then
        check_pass "$WS_NAME: $COUNT valuations seeded"
      else
        check_fail "$WS_NAME: expected ≥9 valuations, found $COUNT"
      fi
      ;;
    investments)
      COUNT=$(row_count "$DB_NAME" "plaid_holdings")
      if [[ "$COUNT" -ge 10 ]]; then
        check_pass "$WS_NAME: $COUNT holdings seeded"
      else
        check_fail "$WS_NAME: expected ≥10 holdings, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "plaid_securities")
      if [[ "$COUNT" -ge 10 ]]; then
        check_pass "$WS_NAME: $COUNT securities seeded"
      else
        check_fail "$WS_NAME: expected ≥10 securities, found $COUNT"
      fi
      ;;
    retirement)
      COUNT=$(row_count "$DB_NAME" "plaid_holdings")
      if [[ "$COUNT" -ge 7 ]]; then
        check_pass "$WS_NAME: $COUNT holdings seeded"
      else
        check_fail "$WS_NAME: expected ≥7 holdings, found $COUNT"
      fi
      COUNT=$(row_count "$DB_NAME" "plaid_securities")
      if [[ "$COUNT" -ge 7 ]]; then
        check_pass "$WS_NAME: $COUNT securities seeded"
      else
        check_fail "$WS_NAME: expected ≥7 securities, found $COUNT"
      fi
      ;;
    taxes)
      COUNT=$(row_count "$DB_NAME" "plaid_transactions")
      if [[ "$COUNT" -ge 18 ]]; then
        check_pass "$WS_NAME: $COUNT transactions seeded"
      else
        check_fail "$WS_NAME: expected ≥18 transactions, found $COUNT"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Check 4: Workspace Health Endpoints
# ---------------------------------------------------------------------------
log_step "Check 4: Health Endpoints"

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DEPLOY_NAME=$(jq -r ".[$i].deploymentName" "$CONFIG_DIR/workspaces.json")

  # Port-forward briefly and check /health (use kubectl exec instead for speed)
  HEALTH=$(kubectl exec -n "$NAMESPACE" \
    "deploy/$DEPLOY_NAME" -c workspace -- \
    wget -qO- --timeout=5 http://localhost:3000/health 2>/dev/null || echo "unreachable")

  if echo "$HEALTH" | grep -qi "ok\|healthy\|status" &> /dev/null; then
    check_pass "$WS_NAME: health endpoint responding"
  else
    check_warn "$WS_NAME: health endpoint returned: $HEALTH"
  fi
done

# ---------------------------------------------------------------------------
# Check 5: Firestore Documents
# ---------------------------------------------------------------------------
log_step "Check 5: Firestore Documents"

# Use gcloud firestore to check document existence
# (This requires the gcloud CLI with Firestore access)
check_firestore_doc() {
  local collection="$1"
  local doc_id="$2"
  local label="$3"

  # Use the REST API via gcloud for quick checks
  if gcloud firestore documents get \
    "projects/$GCP_PROJECT/databases/(default)/documents/$collection/$doc_id" \
    --project="$GCP_PROJECT" &> /dev/null; then
    check_pass "$label"
  else
    check_fail "$label: Firestore document not found"
  fi
}

# Check org document
check_firestore_doc "organizations" "$ORG_ID" "Organization document"

# Check workspace documents
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_ID=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  check_firestore_doc "organizations/$ORG_ID/workspaces" "$WS_ID" "Workspace: $WS_NAME"
done

# Check bridge documents
BRIDGE_COUNT=$(jq length "$CONFIG_DIR/bridges.json")
for i in $(seq 0 $((BRIDGE_COUNT - 1))); do
  BRIDGE_ID=$(jq -r ".[$i].bridgeId" "$CONFIG_DIR/bridges.json")
  SOURCE=$(jq -r ".[$i].sourceName" "$CONFIG_DIR/bridges.json")
  TARGET=$(jq -r ".[$i].targetName" "$CONFIG_DIR/bridges.json")
  check_firestore_doc "organizations/$ORG_ID/bridges" "$BRIDGE_ID" "Bridge: $SOURCE → $TARGET"
done

# Check contract documents
CONTRACT_COUNT=$(jq length "$CONFIG_DIR/contracts.json")
for i in $(seq 0 $((CONTRACT_COUNT - 1))); do
  CONTRACT_ID=$(jq -r ".[$i].contractId" "$CONFIG_DIR/contracts.json")
  TARGET_NAME=$(jq -r ".[$i].target.name" "$CONFIG_DIR/contracts.json")
  check_firestore_doc "organizations/$ORG_ID/contracts" "$CONTRACT_ID" "Contract: Arthur → $TARGET_NAME"
done

# ---------------------------------------------------------------------------
# Check 6: ConfigMaps
# ---------------------------------------------------------------------------
log_step "Check 6: ConfigMaps"

CONFIGMAPS=("a2a-server-patch" "intent-bridge-patch" "contract-auth-patch" "aiprovider-patch")
for cm in "${CONFIGMAPS[@]}"; do
  if kubectl get configmap "$cm" -n "$NAMESPACE" &> /dev/null; then
    check_pass "ConfigMap '$cm' exists"
  else
    check_fail "ConfigMap '$cm' not found"
  fi
done

# ---------------------------------------------------------------------------
# Check 7: Ingress
# ---------------------------------------------------------------------------
log_step "Check 7: Ingress"

INGRESS_NAME=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$INGRESS_NAME" ]]; then
  check_pass "Ingress '$INGRESS_NAME' exists"
  HOST_COUNT=$(kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.rules[*].host}' 2>/dev/null | wc -w | tr -d ' ')
  if [[ "$HOST_COUNT" -ge "$WORKSPACE_COUNT" ]]; then
    check_pass "Ingress has $HOST_COUNT host rule(s) (≥ $WORKSPACE_COUNT workspaces)"
  else
    check_warn "Ingress has $HOST_COUNT host rule(s), expected ≥ $WORKSPACE_COUNT"
  fi
else
  check_fail "No Ingress found in namespace $NAMESPACE"
fi

# ---------------------------------------------------------------------------
# Check 8: BigQuery Telemetry
# ---------------------------------------------------------------------------
log_step "Check 8: BigQuery Telemetry"

BQ_TABLE="roundtable_telemetry.request_traces"
if bq show --project_id="$GCP_PROJECT" "$BQ_TABLE" &> /dev/null; then
  check_pass "BigQuery table '$BQ_TABLE' exists"
else
  check_fail "BigQuery table '$BQ_TABLE' not found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}━━━ Verification Summary ━━━${NC}"
echo -e "  ${GREEN}Passed:${NC}   $PASS"
echo -e "  ${RED}Failed:${NC}   $FAIL"
echo -e "  ${YELLOW}Warnings:${NC} $WARN"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Some checks failed. Review the output above for details.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed!${NC}"
  exit 0
fi
