-- =============================================================================
-- Seed: Checking & Savings accounts and transactions
-- Target database: ws_narv6objpk50ajla6eed
-- =============================================================================

-- Accounts: Primary Checking, High-Yield Savings, Emergency Fund
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_available, currency, workspace_id)
VALUES
  ('acct_chk_001', 'Primary Checking', 'depository', 'checking', '4823', 12847.56, 12347.56, 'USD', 'rt_checking'),
  ('acct_sav_001', 'High-Yield Savings', 'depository', 'savings', '7291', 45230.18, 45230.18, 'USD', 'rt_checking'),
  ('acct_sav_002', 'Emergency Fund', 'depository', 'savings', '3156', 15000.00, 15000.00, 'USD', 'rt_checking')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current, balance_available = EXCLUDED.balance_available;

-- Transactions: ~3 weeks of realistic spending, income, and transfers
INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category, workspace_id)
VALUES
  ('tx_001', 'acct_chk_001', '2026-06-19', 'Whole Foods Market', 'Whole Foods', 87.43, 'Groceries', 'rt_checking'),
  ('tx_002', 'acct_chk_001', '2026-06-18', 'Shell Gas Station', 'Shell', 52.18, 'Gas & Fuel', 'rt_checking'),
  ('tx_003', 'acct_chk_001', '2026-06-18', 'Netflix', 'Netflix', 15.99, 'Entertainment', 'rt_checking'),
  ('tx_004', 'acct_chk_001', '2026-06-17', 'Starbucks', 'Starbucks', 6.45, 'Coffee Shops', 'rt_checking'),
  ('tx_005', 'acct_chk_001', '2026-06-17', 'Amazon.com', 'Amazon', 134.99, 'Shopping', 'rt_checking'),
  ('tx_006', 'acct_chk_001', '2026-06-16', 'Uber', 'Uber', 24.50, 'Transportation', 'rt_checking'),
  ('tx_007', 'acct_chk_001', '2026-06-16', 'Chipotle', 'Chipotle', 12.85, 'Restaurants', 'rt_checking'),
  ('tx_008', 'acct_chk_001', '2026-06-15', 'Payroll - GUSTO PAY', 'Gusto', -8500.00, 'Income', 'rt_checking'),
  ('tx_009', 'acct_chk_001', '2026-06-15', 'Xfinity Internet', 'Comcast', 89.99, 'Internet', 'rt_checking'),
  ('tx_010', 'acct_chk_001', '2026-06-14', 'Target', 'Target', 67.23, 'Shopping', 'rt_checking'),
  ('tx_011', 'acct_chk_001', '2026-06-14', 'Trader Joes', 'Trader Joes', 95.12, 'Groceries', 'rt_checking'),
  ('tx_012', 'acct_chk_001', '2026-06-13', 'Spotify', 'Spotify', 9.99, 'Entertainment', 'rt_checking'),
  ('tx_013', 'acct_chk_001', '2026-06-12', 'CVS Pharmacy', 'CVS', 23.47, 'Health', 'rt_checking'),
  ('tx_014', 'acct_chk_001', '2026-06-11', 'Home Depot', 'Home Depot', 156.78, 'Home Improvement', 'rt_checking'),
  ('tx_015', 'acct_chk_001', '2026-06-10', 'Transfer to Savings', 'Transfer', -500.00, 'Transfer', 'rt_checking'),
  ('tx_016', 'acct_chk_001', '2026-06-09', 'PG&E Utility', 'PG&E', 142.30, 'Utilities', 'rt_checking'),
  ('tx_017', 'acct_chk_001', '2026-06-08', 'DoorDash', 'DoorDash', 35.60, 'Restaurants', 'rt_checking'),
  ('tx_018', 'acct_chk_001', '2026-06-07', 'Apple iCloud', 'Apple', 0.99, 'Digital Services', 'rt_checking'),
  ('tx_019', 'acct_chk_001', '2026-06-06', 'Costco Wholesale', 'Costco', 245.67, 'Groceries', 'rt_checking'),
  ('tx_020', 'acct_chk_001', '2026-06-05', 'Chase Mortgage', 'Chase', 2872.00, 'Mortgage', 'rt_checking'),
  ('tx_021', 'acct_sav_001', '2026-06-15', 'Interest Payment', 'Marcus', -18.42, 'Interest', 'rt_checking'),
  ('tx_022', 'acct_sav_001', '2026-06-10', 'Transfer from Checking', 'Transfer', 500.00, 'Transfer', 'rt_checking'),
  ('tx_023', 'acct_sav_002', '2026-06-15', 'Interest Payment', 'Ally', -6.25, 'Interest', 'rt_checking')
ON CONFLICT (transaction_id) DO NOTHING;
