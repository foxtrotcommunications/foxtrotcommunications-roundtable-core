-- =============================================================================
-- Seed: Checking & Savings accounts and transactions
-- Target database: ws_narv6objpk50ajla6eed
-- =============================================================================

-- Accounts: Primary Checking, High-Yield Savings, Emergency Fund
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_available, currency, workspace_id)
VALUES
  ('acct_chk_001', 'Primary Checking', 'depository', 'checking', '4823', 12847.56, 12347.56, 'USD', 'Narv6OBjpk50aJla6eED'),
  ('acct_sav_001', 'High-Yield Savings', 'depository', 'savings', '7291', 45230.18, 45230.18, 'USD', 'Narv6OBjpk50aJla6eED'),
  ('acct_sav_002', 'Emergency Fund', 'depository', 'savings', '3156', 15000.00, 15000.00, 'USD', 'Narv6OBjpk50aJla6eED')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current, balance_available = EXCLUDED.balance_available;

-- Transactions: ~3 weeks of realistic spending, income, and transfers
INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category, workspace_id)
VALUES
  ('tx_001', 'acct_chk_001', '2026-06-19', 'Whole Foods Market', 'Whole Foods', 87.43, 'Groceries', 'Narv6OBjpk50aJla6eED'),
  ('tx_002', 'acct_chk_001', '2026-06-18', 'Shell Gas Station', 'Shell', 52.18, 'Gas & Fuel', 'Narv6OBjpk50aJla6eED'),
  ('tx_003', 'acct_chk_001', '2026-06-18', 'Netflix', 'Netflix', 15.99, 'Entertainment', 'Narv6OBjpk50aJla6eED'),
  ('tx_004', 'acct_chk_001', '2026-06-17', 'Starbucks', 'Starbucks', 6.45, 'Coffee Shops', 'Narv6OBjpk50aJla6eED'),
  ('tx_005', 'acct_chk_001', '2026-06-17', 'Amazon.com', 'Amazon', 134.99, 'Shopping', 'Narv6OBjpk50aJla6eED'),
  ('tx_006', 'acct_chk_001', '2026-06-16', 'Uber', 'Uber', 24.50, 'Transportation', 'Narv6OBjpk50aJla6eED'),
  ('tx_007', 'acct_chk_001', '2026-06-16', 'Chipotle', 'Chipotle', 12.85, 'Restaurants', 'Narv6OBjpk50aJla6eED'),
  ('tx_008', 'acct_chk_001', '2026-06-15', 'Payroll - GUSTO PAY', 'Gusto', -8500.00, 'Income', 'Narv6OBjpk50aJla6eED'),
  ('tx_009', 'acct_chk_001', '2026-06-15', 'Xfinity Internet', 'Comcast', 89.99, 'Internet', 'Narv6OBjpk50aJla6eED'),
  ('tx_010', 'acct_chk_001', '2026-06-14', 'Target', 'Target', 67.23, 'Shopping', 'Narv6OBjpk50aJla6eED'),
  ('tx_011', 'acct_chk_001', '2026-06-14', 'Trader Joes', 'Trader Joes', 95.12, 'Groceries', 'Narv6OBjpk50aJla6eED'),
  ('tx_012', 'acct_chk_001', '2026-06-13', 'Spotify', 'Spotify', 9.99, 'Entertainment', 'Narv6OBjpk50aJla6eED'),
  ('tx_013', 'acct_chk_001', '2026-06-12', 'CVS Pharmacy', 'CVS', 23.47, 'Health', 'Narv6OBjpk50aJla6eED'),
  ('tx_014', 'acct_chk_001', '2026-06-11', 'Home Depot', 'Home Depot', 156.78, 'Home Improvement', 'Narv6OBjpk50aJla6eED'),
  ('tx_015', 'acct_chk_001', '2026-06-10', 'Transfer to Savings', 'Transfer', -500.00, 'Transfer', 'Narv6OBjpk50aJla6eED'),
  ('tx_016', 'acct_chk_001', '2026-06-09', 'PG&E Utility', 'PG&E', 142.30, 'Utilities', 'Narv6OBjpk50aJla6eED'),
  ('tx_017', 'acct_chk_001', '2026-06-08', 'DoorDash', 'DoorDash', 35.60, 'Restaurants', 'Narv6OBjpk50aJla6eED'),
  ('tx_018', 'acct_chk_001', '2026-06-07', 'Apple iCloud', 'Apple', 0.99, 'Digital Services', 'Narv6OBjpk50aJla6eED'),
  ('tx_019', 'acct_chk_001', '2026-06-06', 'Costco Wholesale', 'Costco', 245.67, 'Groceries', 'Narv6OBjpk50aJla6eED'),
  ('tx_020', 'acct_chk_001', '2026-06-05', 'Chase Mortgage', 'Chase', 2872.00, 'Mortgage', 'Narv6OBjpk50aJla6eED'),
  ('tx_021', 'acct_sav_001', '2026-06-15', 'Interest Payment', 'Marcus', -18.42, 'Interest', 'Narv6OBjpk50aJla6eED'),
  ('tx_022', 'acct_sav_001', '2026-06-10', 'Transfer from Checking', 'Transfer', 500.00, 'Transfer', 'Narv6OBjpk50aJla6eED'),
  ('tx_023', 'acct_sav_002', '2026-06-15', 'Interest Payment', 'Ally', -6.25, 'Interest', 'Narv6OBjpk50aJla6eED')
ON CONFLICT (transaction_id) DO NOTHING;
