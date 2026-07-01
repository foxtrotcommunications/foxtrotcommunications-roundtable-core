// src/db/schemas.ts — Domain-scoped DDL
// Each domain type ONLY creates the tables it needs (strict isolation).
// All tables include workspace_id for multi-tenant isolation.

import type { DomainType } from '../types.js';

// ─── Common Tables (all domains) ────────────────────────────────────────────

const COMMON_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_accounts (
  account_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  balance_available NUMERIC,
  balance_current NUMERIC,
  balance_limit NUMERIC,
  currency TEXT DEFAULT 'USD',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_accounts_ws ON plaid_accounts(workspace_id);

CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  item_id TEXT UNIQUE NOT NULL,
  cursor TEXT,
  last_sync_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_sync_state_ws ON plaid_sync_state(workspace_id);

CREATE TABLE IF NOT EXISTS domain_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_amount REAL,
  target_date TEXT,
  monthly_contribution REAL,
  parameters JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_goals_ws ON domain_goals(workspace_id);

CREATE TABLE IF NOT EXISTS goal_snapshots (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_id TEXT REFERENCES domain_goals(id) ON DELETE CASCADE,
  current_value REAL,
  progress_pct REAL,
  on_track BOOLEAN,
  projected_date TEXT,
  details JSONB DEFAULT '{}',
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goal_snapshots_ws ON goal_snapshots(workspace_id);
`;

// ─── Transaction Tables (checking, savings, debt, taxes, realestate) ────────

const TRANSACTION_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT,
  amount NUMERIC,
  date DATE,
  name TEXT,
  merchant_name TEXT,
  category TEXT,
  payment_channel TEXT,
  pending BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_transactions_ws ON plaid_transactions(workspace_id);
`;

// ─── Investment Tables (investments, retirement) ────────────────────────────

const INVESTMENT_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_holdings (
  holding_id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT,
  security_id TEXT,
  quantity NUMERIC,
  institution_price NUMERIC,
  institution_value NUMERIC,
  cost_basis NUMERIC,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, security_id)
);
CREATE INDEX IF NOT EXISTS idx_plaid_holdings_ws ON plaid_holdings(workspace_id);

CREATE TABLE IF NOT EXISTS plaid_securities (
  security_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticker_symbol TEXT,
  name TEXT,
  type TEXT,
  close_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_securities_ws ON plaid_securities(workspace_id);
`;

// ─── Liability Tables (debt, realestate) ────────────────────────────────────

const LIABILITY_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_liabilities (
  liability_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT,
  type TEXT,
  last_payment_amount NUMERIC,
  last_payment_date DATE,
  next_payment_due_date DATE,
  minimum_payment_amount NUMERIC,
  interest_rate NUMERIC,
  principal_balance NUMERIC,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_liabilities_ws ON plaid_liabilities(workspace_id);
`;

// ─── Goal Tables (all domains) ──────────────────────────────────────────────

const GOAL_TABLES = `
CREATE TABLE IF NOT EXISTS domain_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_amount REAL,
  target_date TEXT,
  monthly_contribution REAL,
  parameters JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_goals_ws ON domain_goals(workspace_id);

CREATE TABLE IF NOT EXISTS goal_snapshots (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_id TEXT REFERENCES domain_goals(id) ON DELETE CASCADE,
  current_value REAL,
  progress_pct REAL,
  on_track BOOLEAN,
  projected_date TEXT,
  details JSONB DEFAULT '{}',
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goal_snapshots_ws ON goal_snapshots(workspace_id);
`;
// ─── Demographics Tables ────────────────────────────────────────────────────

const DEMOGRAPHICS_TABLES = `
CREATE TABLE IF NOT EXISTS user_profile (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  date_of_birth DATE,
  gender TEXT,
  state_of_residence TEXT,
  filing_status TEXT,
  education TEXT,
  employment_status TEXT,
  annual_income_estimate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_profile_ws ON user_profile(workspace_id);

CREATE TABLE IF NOT EXISTS household_members (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER REFERENCES user_profile(id),
  relationship TEXT NOT NULL,
  name TEXT,
  date_of_birth DATE,
  age_years INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_household_members_ws ON household_members(workspace_id);

CREATE TABLE IF NOT EXISTS investment_preferences (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER REFERENCES user_profile(id),
  risk_tolerance TEXT NOT NULL,
  liquidity_preference TEXT,
  time_horizon TEXT,
  preferred_asset_classes TEXT[],
  avoided_asset_classes TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_investment_preferences_ws ON investment_preferences(workspace_id);
`;

// ─── Domain → Tables Mapping (strict isolation) ────────────────────────────

const DOMAIN_SCHEMAS: Record<DomainType, string> = {
  checking:    COMMON_TABLES + TRANSACTION_TABLES + GOAL_TABLES,
  savings:     COMMON_TABLES + TRANSACTION_TABLES + GOAL_TABLES,
  investments: COMMON_TABLES + INVESTMENT_TABLES + GOAL_TABLES,
  retirement:  COMMON_TABLES + INVESTMENT_TABLES + GOAL_TABLES,
  debt:        COMMON_TABLES + TRANSACTION_TABLES + LIABILITY_TABLES + GOAL_TABLES,
  taxes:       COMMON_TABLES + TRANSACTION_TABLES + GOAL_TABLES,
  realestate:  COMMON_TABLES + TRANSACTION_TABLES + LIABILITY_TABLES + GOAL_TABLES,
  demographics: DEMOGRAPHICS_TABLES,
};

export function getSchemaForDomain(domainType: DomainType): string {
  const schema = DOMAIN_SCHEMAS[domainType];
  if (!schema) {
    throw new Error(`Unknown domain type: ${domainType}`);
  }
  return schema;
}

// ─── Migration for Existing Tables ──────────────────────────────────────────
// Adds workspace_id column to tables that predate tenant isolation.
// Enables Row Level Security with per-workspace-role policies.
// Safe to run multiple times (all statements are idempotent).

const MIGRATION_TABLES = [
  'plaid_accounts', 'plaid_transactions', 'plaid_sync_state',
  'plaid_holdings', 'plaid_securities', 'plaid_liabilities',
  'domain_goals', 'goal_snapshots',
  'user_profile', 'household_members', 'investment_preferences',
];

/**
 * Generate migration SQL to:
 *   1. Add workspace_id column to existing tables (backfill NULLs)
 *   2. Enable Row Level Security with per-workspace-role policies
 *
 * RLS policy logic:
 *   USING (workspace_id = current_user)
 *
 *   - Each workspace connects as its own DB role (e.g., rt_checking)
 *   - workspace_id column stores the role name (e.g., 'rt_checking')
 *   - Postgres matches workspace_id against the connection's role
 *   - The `roundtable` admin role has BYPASSRLS — sees all data
 *   - No session variables needed — identity is in the connection
 *
 * Safe to run on both new and existing databases.
 * Must be run as the `roundtable` owner role (which has BYPASSRLS).
 */
export function getMigrationSQL(workspaceId: string): string {
  // Simple escaping for safety, though workspaceId is alphanumeric
  const escapedWsId = workspaceId.replace(/'/g, "''");
  
  const statements = MIGRATION_TABLES.map(table => `
    -- Workspace ID column
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    UPDATE ${table} SET workspace_id = '${escapedWsId}' WHERE workspace_id IS NULL;
    ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_${table}_ws ON ${table}(workspace_id);

    -- Row Level Security (per-workspace-role isolation)
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = 'workspace_isolation'
      ) THEN
        EXECUTE 'CREATE POLICY workspace_isolation ON ${table}
          USING (workspace_id = current_user)
          WITH CHECK (workspace_id = current_user)';
      END IF;
    END $$;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  `).join('\n');

  return statements;
}


