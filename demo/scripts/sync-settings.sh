#!/bin/bash
# =============================================================================
# Pendragon Demo — Workspace Settings Sync
# =============================================================================
# Pushes workspace settings from config/workspaces.json into each workspace's
# PostgreSQL database. This is the canonical way to update system prompts,
# AI provider, AI model, and other workspace metadata for the demo.
#
# Connectivity: Uses kubectl port-forward through each pod's cloud-sql-proxy
# sidecar — no local Cloud SQL Proxy required.
#
# What gets synced:
#   - system_prompt   (from workspaces.json → systemPrompt)
#   - ai_provider     (from workspaces.json → aiProvider)
#   - ai_model        (from workspaces.json → aiModel)
#   - name            (from workspaces.json → name)
#   - url             (from workspaces.json → url)
#
# Prerequisites:
#   - kubectl configured for the target GKE cluster
#   - psql available on PATH
#   - jq available on PATH
#
# Usage:
#   ./scripts/sync-settings.sh                      # Sync all settings
#   ./scripts/sync-settings.sh --dry-run             # Preview what would be synced
#   ./scripts/sync-settings.sh --prompt-only         # Sync only system_prompt
#   ./scripts/sync-settings.sh --workspace Arthur    # Sync a single workspace
#   DB_PORT=5435 DB_USER=roundtable ./scripts/sync-settings.sh --direct  # Use direct psql (Cloud SQL Proxy)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEMO_DIR/config"

NAMESPACE=$(jq -r '.clusterNamespace' "$CONFIG_DIR/org.json")

# Direct mode (legacy) — connect to a running Cloud SQL Proxy
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-roundtable}"
DB_PASS="${DB_PASS:-yXmA7986!}"

# kubectl port-forward local port (random high port to avoid conflicts)
PF_PORT="${PF_PORT:-5435}"

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

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------
DRY_RUN=false
PROMPT_ONLY=false
DIRECT_MODE=false
TARGET_WS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)      DRY_RUN=true; shift ;;
    --prompt-only)  PROMPT_ONLY=true; shift ;;
    --direct)       DIRECT_MODE=true; shift ;;
    --workspace)    TARGET_WS="$2"; shift 2 ;;
    --help)
      echo "Usage: $0 [--dry-run] [--prompt-only] [--direct] [--workspace <name>]"
      echo ""
      echo "Options:"
      echo "  --dry-run       Preview SQL without executing"
      echo "  --prompt-only   Only sync system_prompt field"
      echo "  --direct        Use direct psql connection (requires Cloud SQL Proxy on DB_PORT)"
      echo "  --workspace     Sync a single workspace by name (e.g., 'Arthur')"
      echo ""
      echo "Environment variables (for --direct mode):"
      echo "  DB_HOST  (default: 127.0.0.1)"
      echo "  DB_PORT  (default: 5432)"
      echo "  DB_USER  (default: roundtable)"
      echo "  DB_PASS  (default: from config)"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
log_step "Preflight Checks"

for cmd in jq psql; do
  if ! command -v "$cmd" &> /dev/null; then
    log_error "Required command not found: $cmd"
    exit 1
  fi
done

if [[ "$DRY_RUN" == false && "$DIRECT_MODE" == false ]]; then
  if ! command -v kubectl &> /dev/null; then
    log_error "kubectl not found. Install it or use --direct mode with Cloud SQL Proxy."
    exit 1
  fi
  log_success "kubectl available"
fi

if [[ "$DRY_RUN" == false && "$DIRECT_MODE" == true ]]; then
  if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" &> /dev/null; then
    log_error "Cannot connect to PostgreSQL at $DB_HOST:$DB_PORT"
    log_error "Ensure Cloud SQL Proxy is running, or remove --direct to use kubectl port-forward"
    exit 1
  fi
  log_success "PostgreSQL connection verified (direct mode)"
fi

log_success "Preflight complete"

# ---------------------------------------------------------------------------
# Helper: run_psql <db_name> <deploy_name> <sql>
# Handles connection via kubectl port-forward or direct
# ---------------------------------------------------------------------------
run_psql() {
  local db_name="$1"
  local deploy_name="$2"
  local sql="$3"

  if [[ "$DIRECT_MODE" == true ]]; then
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db_name" \
      --quiet --no-psqlrc -c "$sql" 2>&1
  else
    # Start kubectl port-forward in background
    kubectl port-forward -n "$NAMESPACE" "deploy/$deploy_name" "$PF_PORT:5432" &>/dev/null &
    local PF_PID=$!

    # Wait for port-forward to be ready
    local retries=0
    while ! pg_isready -h 127.0.0.1 -p "$PF_PORT" -q 2>/dev/null; do
      retries=$((retries + 1))
      if [[ $retries -ge 20 ]]; then
        kill "$PF_PID" 2>/dev/null || true
        wait "$PF_PID" 2>/dev/null || true
        return 1
      fi
      sleep 0.3
    done

    # Run the SQL
    local result
    result=$(PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PF_PORT" -U "$DB_USER" -d "$db_name" \
      --quiet --no-psqlrc -c "$sql" 2>&1)
    local rc=$?

    # Kill the port-forward
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true

    if [[ $rc -ne 0 ]]; then
      echo "$result"
      return 1
    fi
    echo "$result"
    return 0
  fi
}

# ---------------------------------------------------------------------------
# Sync workspace settings
# ---------------------------------------------------------------------------
log_step "Syncing Workspace Settings"

WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
SYNCED=0
SKIPPED=0
ERRORS=0

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_ID=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  DEPLOY_NAME=$(jq -r ".[$i].deploymentName" "$CONFIG_DIR/workspaces.json")
  AI_PROVIDER=$(jq -r ".[$i].aiProvider" "$CONFIG_DIR/workspaces.json")
  AI_MODEL=$(jq -r ".[$i].aiModel" "$CONFIG_DIR/workspaces.json")
  WS_URL=$(jq -r ".[$i].url" "$CONFIG_DIR/workspaces.json")

  # Read systemPrompt (may be null for domain workspaces)
  SYSTEM_PROMPT=$(jq -r ".[$i].systemPrompt // \"\"" "$CONFIG_DIR/workspaces.json")

  # Filter by workspace name if --workspace was specified
  if [[ -n "$TARGET_WS" && "$WS_NAME" != "$TARGET_WS" ]]; then
    continue
  fi

  echo ""
  log_info "── $WS_NAME ($WS_ID) ──"
  log_info "  Database: ${DB_SHARED_NAME:-roundtable} (shared)"
  log_info "  Deploy:   $DEPLOY_NAME"
  log_info "  Provider: $AI_PROVIDER / $AI_MODEL"

  if [[ -n "$SYSTEM_PROMPT" ]]; then
    PROMPT_LEN=${#SYSTEM_PROMPT}
    log_info "  System prompt: ${PROMPT_LEN} chars"
  else
    log_info "  System prompt: (none)"
  fi

  if [[ "$DRY_RUN" == true ]]; then
    if [[ "$PROMPT_ONLY" == true ]]; then
      log_info "  [DRY RUN] Would update system_prompt for $WS_NAME"
    else
      log_info "  [DRY RUN] Would sync all settings for $WS_NAME"
    fi
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Build the SQL statement
  if [[ "$PROMPT_ONLY" == true ]]; then
    SQL="INSERT INTO workspaces (id, name, system_prompt, status, created_at, last_active)
         VALUES ('$WS_ID', '$WS_NAME', \$\$${SYSTEM_PROMPT}\$\$, 'active', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           system_prompt = EXCLUDED.system_prompt;"
  else
    SQL="INSERT INTO workspaces (id, name, url, ai_provider, ai_model, system_prompt, status, created_at, last_active)
         VALUES ('$WS_ID', '$WS_NAME', '$WS_URL', '$AI_PROVIDER', '$AI_MODEL', \$\$${SYSTEM_PROMPT}\$\$, 'active', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           url = EXCLUDED.url,
           ai_provider = EXCLUDED.ai_provider,
           ai_model = EXCLUDED.ai_model,
           system_prompt = EXCLUDED.system_prompt;"
  fi

  # Execute — use shared database name instead of per-workspace databases
  if run_psql "${DB_SHARED_NAME:-roundtable}" "$DEPLOY_NAME" "$SQL"; then
    if [[ "$PROMPT_ONLY" == true ]]; then
      log_success "  system_prompt synced → $WS_NAME"
    else
      log_success "  All settings synced → $WS_NAME"
    fi
    SYNCED=$((SYNCED + 1))
  else
    log_error "  Failed to sync settings for $WS_NAME"
    ERRORS=$((ERRORS + 1))
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log_step "Settings Sync Complete"

echo ""
if [[ "$DRY_RUN" == true ]]; then
  log_info "DRY RUN — no changes were made"
fi
log_info "Synced:  $SYNCED"
log_info "Skipped: $SKIPPED"
if [[ $ERRORS -gt 0 ]]; then
  log_error "Errors:  $ERRORS"
  exit 1
fi
echo ""
