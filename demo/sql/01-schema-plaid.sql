-- =============================================================================
-- Plaid Domain Schema (Checking & Savings, Debt Management)
-- Applied to workspace databases that use Plaid-based domain modules.
-- =============================================================================

-- Plaid accounts: bank accounts, credit cards, loans synced from Plaid
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

-- Plaid transactions: individual transactions synced from Plaid
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT,
  amount NUMERIC,
  date DATE,
  name TEXT,
  merchant_name TEXT,
  category TEXT,
  payment_channel TEXT,
  pending BOOLEAN DEFAULT false,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plaid liabilities: credit card balances, student loans, mortgages
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

-- Plaid sync state: cursor tracking for incremental transaction sync
CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id SERIAL PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  cursor TEXT,
  last_sync_at TIMESTAMPTZ DEFAULT NOW()
);
