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
echo -e "  • Cloud SQL databases:  ${YELLOW}$(jq -r '.[].databaseName' "$CONFIG_DIR/workspaces.json" | tr '\n' ', ' | sed 's/,$//')${NC}"
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
# Phase 2: Drop Cloud SQL Databases
# ---------------------------------------------------------------------------
if [[ "$K8S_ONLY" == false ]]; then
  log_step "Phase 2: Dropping Cloud SQL Databases"

  WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

    if gcloud sql databases describe "$DB_NAME" \
      --instance="$CLOUD_SQL_INSTANCE" \
      --project="$GCP_PROJECT" &> /dev/null; then
      gcloud sql databases delete "$DB_NAME" \
        --instance="$CLOUD_SQL_INSTANCE" \
        --project="$GCP_PROJECT" \
        --quiet
      log_success "Dropped database: $DB_NAME ($WS_NAME)"
    else
      log_warn "Database $DB_NAME does not exist ($WS_NAME) — skipping"
    fi
  done
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
