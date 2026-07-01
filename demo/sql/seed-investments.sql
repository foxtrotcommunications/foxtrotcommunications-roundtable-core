-- Seed: Investments — Brokerage account with diversified portfolio
-- Workspace: Investments (pK7mWxR2nQ5vJbYs8dFe)

-- Brokerage account
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_available, currency, workspace_id)
VALUES
  ('acct_inv_001', 'Fidelity Brokerage', 'investment', 'brokerage', '8834', 187432.50, NULL, 'USD', 'rt_investments')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current;

-- Securities held in portfolio
INSERT INTO plaid_securities (security_id, ticker_symbol, name, type, close_price, currency, workspace_id)
VALUES
  ('sec_voo',    'VOO',   'Vanguard S&P 500 ETF',              'etf',            542.18, 'USD', 'rt_investments'),
  ('sec_qqq',    'QQQ',   'Invesco QQQ Trust',                  'etf',            498.75, 'USD', 'rt_investments'),
  ('sec_aapl',   'AAPL',  'Apple Inc.',                         'equity',         234.56, 'USD', 'rt_investments'),
  ('sec_msft',   'MSFT',  'Microsoft Corp.',                    'equity',         467.89, 'USD', 'rt_investments'),
  ('sec_googl',  'GOOGL', 'Alphabet Inc.',                      'equity',         182.34, 'USD', 'rt_investments'),
  ('sec_amzn',   'AMZN',  'Amazon.com Inc.',                    'equity',         198.45, 'USD', 'rt_investments'),
  ('sec_bnd',    'BND',   'Vanguard Total Bond Market ETF',     'etf',             72.30, 'USD', 'rt_investments'),
  ('sec_vxus',   'VXUS',  'Vanguard Total Intl Stock ETF',      'etf',             61.42, 'USD', 'rt_investments'),
  ('sec_schd',   'SCHD',  'Schwab US Dividend Equity ETF',      'etf',             82.15, 'USD', 'rt_investments'),
  ('sec_nvda',   'NVDA',  'NVIDIA Corp.',                       'equity',         135.67, 'USD', 'rt_investments')
ON CONFLICT (security_id) DO UPDATE SET close_price = EXCLUDED.close_price;

-- Holdings — diversified mix of ETFs and individual stocks
INSERT INTO plaid_holdings (account_id, security_id, quantity, institution_price, institution_value, cost_basis, synced_at, workspace_id)
VALUES
  ('acct_inv_001', 'sec_voo',   120.00,  542.18,  65061.60,  52800.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_qqq',    80.00,  498.75,  39900.00,  34400.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_aapl',  100.00,  234.56,  23456.00,  18500.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_msft',   45.00,  467.89,  21055.05,  16200.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_googl',  60.00,  182.34,  10940.40,   9600.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_amzn',   35.00,  198.45,   6945.75,   5950.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_bnd',   100.00,   72.30,   7230.00,   7500.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_vxus',   80.00,   61.42,   4913.60,   4800.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_schd',   50.00,   82.15,   4107.50,   3800.00, NOW(), 'rt_investments'),
  ('acct_inv_001', 'sec_nvda',   28.00,  135.67,   3798.76,   2100.00, NOW(), 'rt_investments')
ON CONFLICT (account_id, security_id) DO UPDATE SET
  quantity = EXCLUDED.quantity,
  institution_price = EXCLUDED.institution_price,
  institution_value = EXCLUDED.institution_value,
  cost_basis = EXCLUDED.cost_basis,
  synced_at = NOW();

-- Sync state
INSERT INTO plaid_sync_state (item_id, cursor, last_sync_at, workspace_id)
VALUES ('item_investments_demo', 'cursor_inv_demo', NOW(), 'rt_investments')
ON CONFLICT (item_id) DO NOTHING;
