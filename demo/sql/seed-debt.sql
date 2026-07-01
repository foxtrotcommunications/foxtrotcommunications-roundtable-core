-- =============================================================================
-- Seed: Debt Management accounts, liabilities, and transactions
-- Target database: ws_jmdsbwmzzqelanlijcgq
-- =============================================================================

-- Accounts: Chase Sapphire Reserve, Amex Gold, Navient Student Loan
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_limit, currency, workspace_id)
VALUES
  ('acct_cc_001', 'Chase Sapphire Reserve', 'credit', 'credit card', '9012', 4235.67, 25000.00, 'USD', 'jmdsbwMzZqelAnliJcGQ'),
  ('acct_cc_002', 'Amex Gold', 'credit', 'credit card', '3456', 1892.34, 15000.00, 'USD', 'jmdsbwMzZqelAnliJcGQ'),
  ('acct_loan_001', 'Navient Student Loan', 'loan', 'student', '6789', 28450.00, NULL, 'USD', 'jmdsbwMzZqelAnliJcGQ')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current;

-- Liabilities: credit card balances and student loan details
INSERT INTO plaid_liabilities (liability_id, account_id, type, principal_balance, interest_rate, minimum_payment_amount, last_payment_date, last_payment_amount, workspace_id)
VALUES
  ('lib_cc_001', 'acct_cc_001', 'credit', 4235.67, 21.49, 125.00, '2026-06-01', 500.00, 'jmdsbwMzZqelAnliJcGQ'),
  ('lib_cc_002', 'acct_cc_002', 'credit', 1892.34, 19.99, 75.00, '2026-06-01', 200.00, 'jmdsbwMzZqelAnliJcGQ'),
  ('lib_loan_001', 'acct_loan_001', 'student', 28450.00, 5.50, 285.00, '2026-06-01', 285.00, 'jmdsbwMzZqelAnliJcGQ')
ON CONFLICT (liability_id) DO NOTHING;

-- Transactions: recent credit card charges and payments
INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category, workspace_id)
VALUES
  ('dtx_001', 'acct_cc_001', '2026-06-18', 'Amazon Prime', 'Amazon', 14.99, 'Subscription', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_002', 'acct_cc_001', '2026-06-17', 'Uber Eats', 'Uber Eats', 32.45, 'Restaurants', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_003', 'acct_cc_001', '2026-06-15', 'Delta Airlines', 'Delta', 342.00, 'Travel', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_004', 'acct_cc_001', '2026-06-12', 'Hilton Hotels', 'Hilton', 189.00, 'Travel', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_005', 'acct_cc_001', '2026-06-01', 'Payment - Thank You', 'Chase', -500.00, 'Payment', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_006', 'acct_cc_002', '2026-06-16', 'Sephora', 'Sephora', 67.89, 'Shopping', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_007', 'acct_cc_002', '2026-06-13', 'Grubhub', 'Grubhub', 28.50, 'Restaurants', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_008', 'acct_cc_002', '2026-06-01', 'Payment - Thank You', 'Amex', -200.00, 'Payment', 'jmdsbwMzZqelAnliJcGQ'),
  ('dtx_009', 'acct_loan_001', '2026-06-01', 'Student Loan Payment', 'Navient', -285.00, 'Payment', 'jmdsbwMzZqelAnliJcGQ')
ON CONFLICT (transaction_id) DO NOTHING;
