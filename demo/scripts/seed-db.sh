#!/bin/bash
# =============================================================================
# Pendragon Demo — Database Seeding Script
# =============================================================================
# Seeds the shared Cloud SQL database with schema, RLS roles, and demo data.
# All workspaces share one database with per-workspace DB roles and RLS.
#
# Modes:
#   ./scripts/seed-db.sh                # Full: schema + roles + seed data + settings sync
#   ./scripts/seed-db.sh --seed-only    # Seed data only (skip schema + roles)
#   ./scripts/seed-db.sh --schema-only  # Schema + roles only (skip seed data)
#   ./scripts/seed-db.sh --sync-settings # Only sync workspace settings (system prompt, etc.)
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
DB_USER="${DB_USER:-roundtable}"    # Admin role (BYPASSRLS)
DB_NAME="${DB_NAME:-roundtable}"    # Single shared database

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
SYNC_SETTINGS_ONLY=false
for arg in "$@"; do
  case $arg in
    --seed-only)       SEED_ONLY=true ;;
    --schema-only)     SCHEMA_ONLY=true ;;
    --sync-settings)   SYNC_SETTINGS_ONLY=true ;;
    --help)
      echo "Usage: $0 [--seed-only] [--schema-only] [--sync-settings]"
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
# Helper: run SQL file against the shared database
# ---------------------------------------------------------------------------
run_sql() {
  local sql_file="$1"
  local description="$2"

  if [[ ! -f "$sql_file" ]]; then
    log_error "SQL file not found: $sql_file"
    return 1
  fi

  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -f "$sql_file" \
    --quiet --no-psqlrc 2>&1 | grep -v "NOTICE" || true
  log_success "$description"
}

# ---------------------------------------------------------------------------
# Read workspace configurations
# ---------------------------------------------------------------------------
WORKSPACE_COUNT=$(jq length "$CONFIG_DIR/workspaces.json")
log_info "Found $WORKSPACE_COUNT workspaces in config"
log_info "Database: $DB_NAME (shared, per-workspace roles + RLS)"

# ---------------------------------------------------------------------------
# Schema Migrations (run once against shared database)
# ---------------------------------------------------------------------------
if [[ "$SEED_ONLY" == false && "$SYNC_SETTINGS_ONLY" == false ]]; then
  log_step "Applying Schema Migrations (shared database: $DB_NAME)"

  run_sql "$SQL_DIR/00-schema-core.sql"         "Core schema (users, workspaces, messages, audit)"
  run_sql "$SQL_DIR/01-schema-plaid.sql"         "Plaid schema (accounts, transactions, liabilities)"
  run_sql "$SQL_DIR/01b-schema-goals.sql"        "Goals schema (domain_goals, goal_snapshots)"
  run_sql "$SQL_DIR/02-schema-realestate.sql"    "Real Estate schema (properties, mortgages)"
  run_sql "$SQL_DIR/03-schema-investments.sql"   "Investments schema (holdings, securities)"
  run_sql "$SQL_DIR/04-schema-demographics.sql"  "Demographics schema (profiles, households)"

  # Admin BYPASSRLS setup. RLS policies themselves are created inline by the
  # schema files above (USING (workspace_id = current_user), FORCE ROW LEVEL).
  log_step "Applying RLS admin setup"
  run_sql "$SQL_DIR/05-roles-rls.sql"            "Admin BYPASSRLS"

  # Per-workspace DB roles. Each role is named after the workspace id so the
  # RLS predicate (workspace_id = current_user) matches the seeded workspace_id.
  # Mirrors setup.sh; makes this script self-sufficient against a fresh DB.
  log_step "Creating Per-Workspace DB Roles"
  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    ROLE_WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    DB_ROLE=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")
    [[ -z "$DB_ROLE" || "$DB_ROLE" == "null" ]] && continue
    DB_ROLE_PASS="demo_${DB_ROLE}"

    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      --quiet --no-psqlrc <<-EOSQL 2>&1 | grep -v "NOTICE" || true
      DO \$\$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_ROLE}') THEN
          CREATE ROLE "${DB_ROLE}" WITH LOGIN PASSWORD '${DB_ROLE_PASS}';
        ELSE
          ALTER ROLE "${DB_ROLE}" WITH LOGIN PASSWORD '${DB_ROLE_PASS}';
        END IF;
      END
      \$\$;
      GRANT CONNECT ON DATABASE ${DB_NAME} TO "${DB_ROLE}";
      GRANT ALL ON SCHEMA public TO "${DB_ROLE}";
      GRANT ALL ON ALL TABLES IN SCHEMA public TO "${DB_ROLE}";
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${DB_ROLE}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${DB_ROLE}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${DB_ROLE}";
EOSQL
    log_success "Role: $DB_ROLE ($ROLE_WS_NAME)"
  done
fi

# ---------------------------------------------------------------------------
# Seed Data (all into the shared database)
# ---------------------------------------------------------------------------
if [[ "$SCHEMA_ONLY" == false && "$SYNC_SETTINGS_ONLY" == false ]]; then
  log_step "Seeding Domain Data"

  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
    DB_ROLE=$(jq -r ".[$i].id" "$CONFIG_DIR/workspaces.json")

    case "$DOMAIN_TYPE" in
      checking)
        run_sql "$SQL_DIR/seed-checking.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      debt)
        run_sql "$SQL_DIR/seed-debt.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      realestate)
        run_sql "$SQL_DIR/seed-realestate.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      investments)
        run_sql "$SQL_DIR/seed-investments.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      retirement)
        run_sql "$SQL_DIR/seed-retirement.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      taxes)
        run_sql "$SQL_DIR/seed-taxes.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      demographics)
        run_sql "$SQL_DIR/seed-demographics.sql" "Seed data ($WS_NAME → role: $DB_ROLE)"
        ;;
      null|"")
        log_info "No seed data for orchestrator: $WS_NAME — skipping"
        ;;
      *)
        log_warn "No seed file found for domain type: $DOMAIN_TYPE ($WS_NAME)"
        ;;
    esac
  done

  # ── Goal Seeds (domain_goals + goal_snapshots) ──
  log_step "Seeding Goals & Snapshots"

  for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
    DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
    WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")

    GOAL_FILE="$SQL_DIR/seed-goals-${DOMAIN_TYPE}.sql"
    if [[ -f "$GOAL_FILE" ]]; then
      run_sql "$GOAL_FILE" "Goals & snapshots ($WS_NAME)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Workspace Settings Sync
# ---------------------------------------------------------------------------
if [[ "$SCHEMA_ONLY" == false ]]; then
  log_step "Syncing Workspace Settings"
  "$SCRIPT_DIR/sync-settings.sh"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log_step "Database Seeding Complete"

echo ""
log_info "All data seeded into shared database: ${CYAN}$DB_NAME${NC}"
log_info "Architecture: per-workspace DB roles + Row Level Security"
echo ""
for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME=$(jq -r ".[$i].name" "$CONFIG_DIR/workspaces.json")
  DB_ROLE=$(jq -r ".[$i].id // \"n/a\"" "$CONFIG_DIR/workspaces.json")
  DOMAIN_TYPE=$(jq -r ".[$i].domainType" "$CONFIG_DIR/workspaces.json")
  echo -e "  ${GREEN}✓${NC} $WS_NAME → role: $DB_ROLE (domain: ${DOMAIN_TYPE:-orchestrator})"
done
echo ""
log_info "Admin access: psql -U roundtable -d $DB_NAME  (BYPASSRLS — sees all data)"
echo ""
