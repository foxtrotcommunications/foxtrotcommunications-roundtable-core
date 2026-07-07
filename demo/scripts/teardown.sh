#!/bin/bash
# =============================================================================
# Pendragon Demo — Teardown Script
# =============================================================================
# Completely removes the Pendragon Capital demo:
#   1. Deletes the Kubernetes namespace (and all resources within it)
#   2. Drops all Cloud SQL databases
#   3. Deletes all Firestore documents (org, workspaces, bridges, contracts)
#
# ⚠️  THIS IS DESTRUCTIVE AND IRREVERSIBLE ⚠️
#
# Usage:
#   ./scripts/teardown.sh              # Interactive (prompts for confirmation)
#   ./scripts/teardown.sh --confirm    # Skip confirmation (for CI/CD)
#   ./scripts/teardown.sh --k8s-only   # Only delete Kubernetes resources
#   ./scripts/teardown.sh --db-only    # Only drop databases
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEMO_DIR/config"

ORG_ID=$(jq -r '.orgId' "$CONFIG_DIR/org.json")
ORG_SLUG=$(jq -r '.orgSlug' "$CONFIG_DIR/org.json")
GCP_PROJECT=$(jq -r '.gcpProject' "$CONFIG_DIR/org.json")
NAMESPACE=$(jq -r '.clusterNamespace' "$CONFIG_DIR/org.json")
CLOUD_SQL_INSTANCE="roundtable-public-pg"

# ---------------------------------------------------------------------------
# Colors & helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()    { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Parse CLI flags
AUTO_CONFIRM=false
K8S_ONLY=false
DB_ONLY=false

for arg in "$@"; do
  case $arg in
    --confirm)  AUTO_CONFIRM=true ;;
    --k8s-only) K8S_ONLY=true ;;
    --db-only)  DB_ONLY=true ;;
    --help)
      echo "Usage: $0 [--confirm] [--k8s-only] [--db-only]"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
echo ""
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${RED}  ⚠️  DESTRUCTIVE OPERATION — Pendragon Demo Teardown${NC}"
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "This will permanently delete:"
echo -e "  • Kubernetes namespace: ${YELLOW}$NAMESPACE${NC}"
echo -e "  • Per-workspace DB roles: ${YELLOW}$(jq -r '.[].id // empty' "$CONFIG_DIR/workspaces.json" | grep -v '^$' | tr '\n' ', ' | sed 's/,$//')${NC}"
echo -e "  • Demo data in shared database: ${YELLOW}roundtable${NC}"
echo -e "  • Firestore documents:  ${YELLOW}organizations/$ORG_ID/**${NC}"
echo ""

if [[ "$AUTO_CONFIRM" == false ]]; then
  read -p "Type 'pendragon-demo' to confirm teardown: " CONFIRM
  if [[ "$CONFIRM" != "pendragon-demo" ]]; then
    log_error "Teardown cancelled."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Phase 1: Delete Kubernetes Namespace
# ---------------------------------------------------------------------------
if [[ "$DB_ONLY" == false ]]; then
  log_step "Phase 1: Deleting Kubernetes Namespace"

  if kubectl get namespace "$NAMESPACE" &> /dev/null; then
    kubectl delete namespace "$NAMESPACE" --wait=false
    log_success "Namespace deletion initiated: $NAMESPACE"
    log_info "Kubernetes will clean up all resources in the background"
  else
    log_warn "Namespace $NAMESPACE does not exist — skipping"
  fi
fi

# ---------------------------------------------------------------------------
# Phase 2: Drop Per-Workspace DB Roles + Clean Data
# ---------------------------------------------------------------------------
if [[ "$K8S_ONLY" == false ]]; then
  log_step "Phase 2: Cleaning Database (Roles + Data)"

  DB_HOST="${DB_HOST:-127.0.0.1}"
  DB_PORT="${DB_PORT:-5432}"
  DB_USER="${DB_USER:-roundtable}"
  DB_NAME="${DB_NAME:-roundtable}"

  # Drop per-workspace roles
  log_info "Dropping per-workspace DB roles..."
  WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    # Roles are named after the workspace id (see setup.sh Phase 2c).
    DB_ROLE=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

    if [[ -n "$DB_ROLE" && "$DB_ROLE" != "null" ]]; then
      # Identifiers are double-quoted: workspace ids are mixed-case, and an
      # unquoted identifier would be folded to lowercase and fail to match.
      psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        --quiet --no-psqlrc -c "
          -- Revoke all privileges first (required before DROP ROLE)
          REVOKE ALL ON ALL TABLES IN SCHEMA public FROM \"${DB_ROLE}\";
          REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM \"${DB_ROLE}\";
          REVOKE USAGE ON SCHEMA public FROM \"${DB_ROLE}\";
          DROP ROLE IF EXISTS \"${DB_ROLE}\";
        " 2>/dev/null && \
        log_success "Dropped role: $DB_ROLE ($WS_NAME)" || \
        log_warn "Could not drop role: $DB_ROLE ($WS_NAME)"
    fi
  done

  # Truncate all demo domain tables (preserving schema)
  log_info "Truncating demo data from shared database..."
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --quiet --no-psqlrc -c "
      TRUNCATE TABLE
        plaid_accounts, plaid_transactions, plaid_liabilities, plaid_sync_state,
        properties, mortgages, property_valuations,
        plaid_holdings, plaid_securities,
        user_profile, household_members, investment_preferences
      CASCADE;
    " 2>/dev/null && \
    log_success "Truncated all domain tables" || \
    log_warn "Some tables may not exist yet — skipping truncation"

  # Also truncate goals if they exist
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --quiet --no-psqlrc -c "
      TRUNCATE TABLE domain_goals, goal_snapshots CASCADE;
    " 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Phase 3: Delete Firestore Documents
# ---------------------------------------------------------------------------
if [[ "$K8S_ONLY" == false && "$DB_ONLY" == false ]]; then
  log_step "Phase 3: Deleting Firestore Documents"

  # Delete subcollections first, then the org document
  delete_firestore_doc() {
    local doc_path="$1"
    local label="$2"

    if gcloud firestore documents delete \
      "projects/$GCP_PROJECT/databases/(default)/documents/$doc_path" \
      --project="$GCP_PROJECT" \
      --quiet &> /dev/null; then
      log_success "Deleted: $label"
    else
      log_warn "Could not delete: $label (may not exist)"
    fi
  }

  # Delete workspace documents
  log_info "Deleting workspace documents..."
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    WS_ID=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    delete_firestore_doc "organizations/$ORG_ID/workspaces/$WS_ID" "Workspace: $WS_NAME"
  done

  # Delete bridge documents
  log_info "Deleting bridge documents..."
  BRIDGE_COUNT=$(jq length "$CONFIG_DIR/bridges.json")
  for i in $(seq 0 $((BRIDGE_COUNT - 1))); do
    BRIDGE_ID=$(jq -r ".[$i].bridgeId" "$CONFIG_DIR/bridges.json")
    delete_firestore_doc "organizations/$ORG_ID/bridges/$BRIDGE_ID" "Bridge: $BRIDGE_ID"
  done

  # Delete contract documents
  log_info "Deleting contract documents..."
  CONTRACT_COUNT=$(jq length "$CONFIG_DIR/contracts.json")
  for i in $(seq 0 $((CONTRACT_COUNT - 1))); do
    CONTRACT_ID=$(jq -r ".[$i].contractId" "$CONFIG_DIR/contracts.json")
    delete_firestore_doc "organizations/$ORG_ID/contracts/$CONTRACT_ID" "Contract: $CONTRACT_ID"
  done

  # Delete the org document itself
  log_info "Deleting organization document..."
  delete_firestore_doc "organizations/$ORG_ID" "Organization: $ORG_SLUG"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Pendragon Capital demo teardown complete.${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
log_info "To rebuild, run: ./scripts/setup.sh"
echo ""
