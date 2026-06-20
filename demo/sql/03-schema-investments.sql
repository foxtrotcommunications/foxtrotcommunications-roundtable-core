-- Investment Domain Schema (Investments, Retirement)
-- Tables for holdings and securities data

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
