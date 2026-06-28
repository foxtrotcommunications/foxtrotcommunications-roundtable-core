-- Seed: Retirement — 401(k) and Roth IRA accounts
-- Workspace: Retirement (hN3cLzV9sT6wMgXa4bKi)

-- Retirement accounts
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_available, currency)
VALUES
  ('acct_ret_001', 'Vanguard 401(k)',    'investment', '401k',     '5501', 342876.45, NULL, 'USD'),
  ('acct_ret_002', 'Schwab Roth IRA',    'investment', 'roth',     '7723', 68420.30,  NULL, 'USD')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current;

-- Securities — target-date and index funds typical of retirement accounts
INSERT INTO plaid_securities (security_id, ticker_symbol, name, type, close_price, currency)
VALUES
  ('sec_vfiax',  'VFIAX',  'Vanguard 500 Index Admiral',         'mutual fund', 523.40, 'USD'),
  ('sec_vbtlx',  'VBTLX',  'Vanguard Total Bond Mkt Admiral',    'mutual fund',  10.85, 'USD'),
  ('sec_vtiax',  'VTIAX',  'Vanguard Total Intl Stock Admiral',   'mutual fund',  33.72, 'USD'),
  ('sec_vttvx',  'VTTVX',  'Vanguard Target Retirement 2035',    'mutual fund',  22.18, 'USD'),
  ('sec_swppx',  'SWPPX',  'Schwab S&P 500 Index Fund',          'mutual fund',  83.95, 'USD'),
  ('sec_swisx',  'SWISX',  'Schwab International Index Fund',     'mutual fund',  24.60, 'USD'),
  ('sec_swagx',  'SWAGX',  'Schwab US Aggregate Bond Index',      'mutual fund',  10.22, 'USD')
ON CONFLICT (security_id) DO UPDATE SET close_price = EXCLUDED.close_price;

-- Holdings — 401(k): target-date fund + index mix
INSERT INTO plaid_holdings (account_id, security_id, quantity, institution_price, institution_value, cost_basis, synced_at)
VALUES
  ('acct_ret_001', 'sec_vttvx',  8200.00,  22.18, 181876.00, 148000.00, NOW()),
  ('acct_ret_001', 'sec_vfiax',   180.00, 523.40,  94212.00,  72000.00, NOW()),
  ('acct_ret_001', 'sec_vbtlx',  3200.00,  10.85,  34720.00,  35000.00, NOW()),
  ('acct_ret_001', 'sec_vtiax',   950.00,  33.72,  32034.00,  28500.00, NOW()),
  -- Roth IRA: growth-oriented
  ('acct_ret_002', 'sec_swppx',   450.00,  83.95,  37777.50,  31500.00, NOW()),
  ('acct_ret_002', 'sec_swisx',   680.00,  24.60,  16728.00,  15000.00, NOW()),
  ('acct_ret_002', 'sec_swagx',  1360.00,  10.22,  13899.20,  14000.00, NOW())
ON CONFLICT (account_id, security_id) DO UPDATE SET
  quantity = EXCLUDED.quantity,
  institution_price = EXCLUDED.institution_price,
  institution_value = EXCLUDED.institution_value,
  cost_basis = EXCLUDED.cost_basis,
  synced_at = NOW();

-- Sync state
INSERT INTO plaid_sync_state (item_id, cursor, last_sync_at)
VALUES ('item_retirement_demo', 'cursor_ret_demo', NOW())
ON CONFLICT (item_id) DO NOTHING;
