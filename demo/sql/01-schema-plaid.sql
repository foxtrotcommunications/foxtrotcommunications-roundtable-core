-- =============================================================================
-- Plaid Domain Schema (Checking & Savings, Debt Management)
-- Applied to workspace databases that use Plaid-based domain modules.
-- =============================================================================

-- Plaid accounts: bank accounts, credit cards, loans synced from Plaid
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
ALTER TABLE plaid_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_accounts;
CREATE POLICY workspace_isolation ON plaid_accounts
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_accounts FORCE ROW LEVEL SECURITY;

-- Plaid transactions: individual transactions synced from Plaid
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
  pending BOOLEAN DEFAULT false,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plaid_transactions_ws ON plaid_transactions(workspace_id);
ALTER TABLE plaid_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_transactions;
CREATE POLICY workspace_isolation ON plaid_transactions
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_transactions FORCE ROW LEVEL SECURITY;

-- Plaid liabilities: credit card balances, student loans, mortgages
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
ALTER TABLE plaid_liabilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_liabilities;
CREATE POLICY workspace_isolation ON plaid_liabilities
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_liabilities FORCE ROW LEVEL SECURITY;

-- Plaid sync state: cursor tracking for incremental transaction sync
CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  item_id TEXT UNIQUE NOT NULL,
  cursor TEXT,
  last_sync_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plaid_sync_state_ws ON plaid_sync_state(workspace_id);
ALTER TABLE plaid_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_sync_state;
CREATE POLICY workspace_isolation ON plaid_sync_state
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_sync_state FORCE ROW LEVEL SECURITY;
