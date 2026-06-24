// src/db/schemas.ts — Domain-scoped DDL
// Each domain type ONLY creates the tables it needs (strict isolation).

import type { DomainType } from '../types.js';

// ─── Common Tables (all domains) ────────────────────────────────────────────

const COMMON_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_accounts (
  account_id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id SERIAL PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  cursor TEXT,
  last_sync_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// ─── Transaction Tables (checking, savings, debt, taxes, realestate) ────────

const TRANSACTION_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
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
`;

// ─── Investment Tables (investments, retirement) ────────────────────────────

const INVESTMENT_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_holdings (
  holding_id SERIAL PRIMARY KEY,
  account_id TEXT,
  security_id TEXT,
  quantity NUMERIC,
  institution_price NUMERIC,
  institution_value NUMERIC,
  cost_basis NUMERIC,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plaid_securities (
  security_id TEXT PRIMARY KEY,
  ticker_symbol TEXT,
  name TEXT,
  type TEXT,
  close_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// ─── Liability Tables (debt, realestate) ────────────────────────────────────

const LIABILITY_TABLES = `
CREATE TABLE IF NOT EXISTS plaid_liabilities (
  liability_id TEXT PRIMARY KEY,
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
`;

// ─── Goal Tables (all domains) ──────────────────────────────────────────────

const GOAL_TABLES = `
CREATE TABLE IF NOT EXISTS domain_goals (
  id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS goal_snapshots (
  id SERIAL PRIMARY KEY,
  goal_id TEXT REFERENCES domain_goals(id) ON DELETE CASCADE,
  current_value REAL,
  progress_pct REAL,
  on_track BOOLEAN,
  projected_date TEXT,
  details JSONB DEFAULT '{}',
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);
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
  demographics: GOAL_TABLES,  // Demographics uses its own schema (04-schema-demographics.sql), only needs goal tables
};

export function getSchemaForDomain(domainType: DomainType): string {
  const schema = DOMAIN_SCHEMAS[domainType];
  if (!schema) {
    throw new Error(`Unknown domain type: ${domainType}`);
  }
  return schema;
}
