-- Investment Domain Schema (Investments, Retirement)
-- Tables for holdings and securities data

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
ALTER TABLE plaid_holdings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_holdings;
CREATE POLICY workspace_isolation ON plaid_holdings
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_holdings FORCE ROW LEVEL SECURITY;

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
ALTER TABLE plaid_securities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON plaid_securities;
CREATE POLICY workspace_isolation ON plaid_securities
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE plaid_securities FORCE ROW LEVEL SECURITY;
