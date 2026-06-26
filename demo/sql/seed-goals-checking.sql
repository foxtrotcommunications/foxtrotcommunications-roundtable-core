-- =============================================================================
-- Seed: Goals & Snapshots — Checking & Savings
-- Target database: ws_narv6objpk50ajla6eed
-- =============================================================================
-- Accounts seeded: Primary Checking ($12,848), High-Yield Savings ($45,230),
--                  Emergency Fund ($15,000)
-- Total balance: $73,078
-- =============================================================================

-- Goal 1: Emergency Fund — 3 months of expenses (~$4,450/mo = $13,350)
-- Current: $15,000 in dedicated Emergency Fund account → 100% (exceeded)
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status)
VALUES (
  'goal_demo_chk_emergency',
  'emergency_fund',
  'Emergency Fund',
  'Maintain 3-month emergency reserve covering ~$4,450/mo in expenses',
  13350,
  NULL,
  500,
  '{"months_coverage": 3, "demo_seed": true}',
  'active'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details)
VALUES (
  'goal_demo_chk_emergency',
  15000,
  100.0,
  true,
  NULL,
  '{"source": "demo_seed", "account": "Emergency Fund", "monthlyExpenses": 4450}'
);

-- Goal 2: Family Vacation Fund — saving toward a $8,000 trip
-- Current: $3,200 set aside (portion of High-Yield Savings) → 40%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status)
VALUES (
  'goal_demo_chk_vacation',
  'savings_target',
  'Family Vacation Fund',
  'Save for a family vacation — target $8,000 by December 2026',
  8000,
  '2026-12-15',
  500,
  '{"demo_seed": true}',
  'active'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details)
VALUES (
  'goal_demo_chk_vacation',
  3200,
  40.0,
  true,
  '2026-12-01',
  '{"source": "demo_seed", "savingsRate": 500}'
);
