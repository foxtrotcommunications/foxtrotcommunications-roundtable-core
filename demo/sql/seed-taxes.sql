-- Seed: Taxes — Tax-related accounts and deductible transactions
-- Workspace: Taxes (eR8fDyU1kP4qJnZm7wCo)

-- Tax-related accounts
INSERT INTO plaid_accounts (account_id, name, type, subtype, mask, balance_current, balance_available, currency)
VALUES
  ('acct_tax_001', 'Tax Savings Account',  'depository', 'savings',  '9941', 8500.00, 8500.00, 'USD'),
  ('acct_tax_002', 'HSA - Fidelity',       'depository', 'savings',  '6612', 4235.80, 4235.80, 'USD')
ON CONFLICT (account_id) DO UPDATE SET balance_current = EXCLUDED.balance_current;

-- Tax-relevant transactions (deductible expenses, estimated payments, etc.)
INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category)
VALUES
  -- Estimated tax payments
  ('ttx_001', 'acct_tax_001', '2026-04-15', 'IRS - Q1 Estimated Tax',        'IRS',              3200.00, 'Tax Payment'),
  ('ttx_002', 'acct_tax_001', '2026-06-15', 'IRS - Q2 Estimated Tax',        'IRS',              3200.00, 'Tax Payment'),
  ('ttx_003', 'acct_tax_001', '2026-04-15', 'IL Dept of Revenue - Q1',       'IL DOR',            640.00, 'State Tax Payment'),
  ('ttx_004', 'acct_tax_001', '2026-06-15', 'IL Dept of Revenue - Q2',       'IL DOR',            640.00, 'State Tax Payment'),
  -- Charitable donations (deductible)
  ('ttx_005', 'acct_tax_001', '2026-03-20', 'Red Cross Donation',            'Red Cross',         500.00, 'Charitable Donation'),
  ('ttx_006', 'acct_tax_001', '2026-05-10', 'Habitat for Humanity',          'Habitat',           250.00, 'Charitable Donation'),
  ('ttx_007', 'acct_tax_001', '2026-06-01', 'Local Food Bank',               'Food Bank',         100.00, 'Charitable Donation'),
  -- HSA contributions and medical expenses
  ('ttx_008', 'acct_tax_002', '2026-01-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_009', 'acct_tax_002', '2026-02-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_010', 'acct_tax_002', '2026-03-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_011', 'acct_tax_002', '2026-04-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_012', 'acct_tax_002', '2026-05-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_013', 'acct_tax_002', '2026-06-15', 'HSA Contribution - Payroll',    'Employer',        -375.00, 'HSA Contribution'),
  ('ttx_014', 'acct_tax_002', '2026-02-20', 'Dr. Smith - Copay',            'Dr. Smith',          40.00, 'Medical'),
  ('ttx_015', 'acct_tax_002', '2026-04-08', 'CVS Pharmacy - Prescription',  'CVS',                28.50, 'Medical'),
  ('ttx_016', 'acct_tax_002', '2026-05-22', 'Vision Center - Eye Exam',     'LensCrafters',      185.00, 'Medical'),
  -- Property tax (deductible)
  ('ttx_017', 'acct_tax_001', '2026-03-01', 'Springfield Property Tax H1',   'Springfield IL',   3420.00, 'Property Tax'),
  ('ttx_018', 'acct_tax_001', '2026-06-10', 'Mortgage Interest - Wells',     'Wells Fargo',      3048.00, 'Mortgage Interest')
ON CONFLICT (transaction_id) DO NOTHING;

-- Sync state
INSERT INTO plaid_sync_state (item_id, cursor, last_sync_at)
VALUES ('item_taxes_demo', 'cursor_tax_demo', NOW())
ON CONFLICT (item_id) DO NOTHING;
