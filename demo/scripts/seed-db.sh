#!/bin/bash
# =============================================================================
# Pendragon Demo — Database Seeding Script
# =============================================================================
# Seeds only the Cloud SQL databases without touching Kubernetes or Firestore.
# Useful for resetting demo data or populating a fresh set of databases.
#
# Modes:
#   ./scripts/seed-db.sh              # Full: schema + seed data
#   ./scripts/seed-db.sh --seed-only  # Seed data only (skip schema)
#   ./scripts/seed-db.sh --schema-only # Schema only (skip seed data)
#
# Prerequisites:
#   - Cloud SQL Proxy running on localhost:5432
#   - psql available on PATH
#   - jq available on PATH
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEMO_DIR/config"
SQL_DIR="$DEMO_DIR/sql"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-roundtable}"

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
SEED_ONLY=false
SCHEMA_ONLY=false
for arg in "$@"; do
  case $arg in
    --seed-only)   SEED_ONLY=true ;;
    --schema-only) SCHEMA_ONLY=true ;;
    --help)
      echo "Usage: $0 [--seed-only] [--schema-only]"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

if [[ "$SEED_ONLY" == true && "$SCHEMA_ONLY" == true ]]; then
  log_error "Cannot specify both --seed-only and --schema-only"
  exit 1
fi

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

if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" &> /dev/null; then
  log_error "Cannot connect to PostgreSQL at $DB_HOST:$DB_PORT"
  log_error "Ensure Cloud SQL Proxy is running"
  exit 1
fi
log_success "PostgreSQL connection verified"

# ---------------------------------------------------------------------------
# Helper: run SQL file against a database
# ---------------------------------------------------------------------------
run_sql() {
  local db="$1"
  local sql_file="$2"
  local description="$3"

  if [[ ! -f "$sql_file" ]]; then
    log_error "SQL file not found: $sql_file"
    return 1
  fi

  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" \
    -f "$sql_file" \
    --quiet --no-psqlrc 2>&1 | grep -v "NOTICE" || true
  log_success "$description → $db"
}

# ---------------------------------------------------------------------------
# Read workspace configurations
# ---------------------------------------------------------------------------
WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
log_info "Found $WORKSPACE_COUNT workspaces in config"

# ---------------------------------------------------------------------------
# Schema Migrations
# ---------------------------------------------------------------------------
if [[ "$SEED_ONLY" == false ]]; then
  log_step "Applying Schema Migrations"

  # Core schema → all workspaces
  log_info "Core schema → all workspaces"
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    run_sql "$DB_NAME" "$SQL_DIR/00-schema-core.sql" "Core schema ($WS_NAME)"
  done

  # Plaid schema → checking and debt workspaces
  log_info "Plaid schema → Plaid-based workspaces"
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
    if [[ "$DOMAIN_TYPE" == "checking" || "$DOMAIN_TYPE" == "debt" ]]; then
      DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
      WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
      run_sql "$DB_NAME" "$SQL_DIR/01-schema-plaid.sql" "Plaid schema ($WS_NAME)"
    fi
  done

  # Real estate schema → realestate workspace
  log_info "Real Estate schema → Real Estate workspace"
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
    if [[ "$DOMAIN_TYPE" == "realestate" ]]; then
      DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
      WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
      run_sql "$DB_NAME" "$SQL_DIR/02-schema-realestate.sql" "Real Estate schema ($WS_NAME)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Seed Data
# ---------------------------------------------------------------------------
if [[ "$SCHEMA_ONLY" == false ]]; then
  log_step "Seeding Data"

  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
    DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

    case "$DOMAIN_TYPE" in
      checking)
        run_sql "$DB_NAME" "$SQL_DIR/seed-checking.sql" "Seed data ($WS_NAME)"
        ;;
      debt)
        run_sql "$DB_NAME" "$SQL_DIR/seed-debt.sql" "Seed data ($WS_NAME)"
        ;;
      realestate)
        run_sql "$DB_NAME" "$SQL_DIR/seed-realestate.sql" "Seed data ($WS_NAME)"
        ;;
      null|"")
        log_info "No seed data for orchestrator: $WS_NAME — skipping"
        ;;
      *)
        log_warn "No seed file found for domain type: $DOMAIN_TYPE ($WS_NAME)"
        ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log_step "Database Seeding Complete"

echo ""
log_info "Databases seeded:"
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DB_NAME=$(jq -r ".[$i].databaseName" "$CONFIG_DIR/workspaces.json")
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  echo -e "  ${GREEN}✓${NC} $WS_NAME → $DB_NAME (domain: ${DOMAIN_TYPE:-orchestrator})"
done
echo ""
