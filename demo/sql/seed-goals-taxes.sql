-- =============================================================================
-- Seed: Goals & Snapshots — Taxes
-- Target database: ws_4x5oqpzsa29iljirhmac
-- =============================================================================
-- Accounts seeded: Tax Savings ($8,500), HSA ($4,236)
-- Total balance: $12,736
-- Estimated annual tax obligation: ~$15,360 (4 × $3,200 federal + 4 × $640 state)
-- =============================================================================

-- Goal: Tax Reserve — maintain adequate reserves for quarterly estimated payments
-- Current: $12,736 of $15,000 target → 84.9%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status)
VALUES (
  'goal_demo_tax_reserve',
  'tax_reserve',
  'Tax Reserve',
  'Maintain adequate reserves for quarterly estimated tax payments (federal + state)',
  15000,
  NULL,
  600,
  '{"quarterly_federal": 3200, "quarterly_state": 640, "demo_seed": true}',
  'active'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details)
VALUES (
  'goal_demo_tax_reserve',
  12736,
  84.9,
  true,
  NULL,
  '{"source": "demo_seed", "taxSavings": 8500, "hsa": 4236, "quarterlyObligation": 3840}'
);
