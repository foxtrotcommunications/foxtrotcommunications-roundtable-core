-- =============================================================================
-- Seed: Goals & Snapshots — Debt Management
-- Target database: ws_jmdsbwmzzqelanlijcgq
-- =============================================================================
-- Accounts seeded: Chase Sapphire Reserve ($4,236), Amex Gold ($1,892),
--                  Navient Student Loan ($28,450)
-- Total debt: $34,578
-- =============================================================================

-- Goal 1: Debt Payoff — eliminate all outstanding debt
-- Total debt is $34,578. Assuming ~$5,000 already paid down from ~$40,000
-- original balances → 15% progress
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_debt_payoff',
  'debt',
  'Debt Payoff',
  'Pay off all outstanding credit card and student loan debt ($34,578 remaining)',
  0,
  '2029-06-01',
  985,
  '{"strategy": "avalanche", "demo_seed": true}',
  'active',
  'jmdsbwMzZqelAnliJcGQ'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

-- Baseline snapshot (original debt) — needed for progress calculation
INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_debt_payoff',
  40000,
  0.0,
  false,
  '2029-08-01',
  '{"source": "demo_seed_baseline", "originalDebt": 40000}',
  'jmdsbwMzZqelAnliJcGQ'
);

-- Current snapshot
INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_debt_payoff',
  34578,
  13.6,
  false,
  '2029-08-01',
  '{"source": "demo_seed", "totalDebt": 34578, "avgRate": 15.66, "monthlyPayment": 985}',
  'jmdsbwMzZqelAnliJcGQ'
);

-- Goal 2: Improve Credit Score
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_debt_credit',
  'credit_score',
  'Improve Credit Score',
  'Raise credit score from 712 to 780+ through debt reduction and on-time payments',
  780,
  '2027-06-01',
  NULL,
  '{"current_score": 712, "demo_seed": true}',
  'active',
  'jmdsbwMzZqelAnliJcGQ'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_debt_credit',
  712,
  71.2,
  true,
  '2027-03-01',
  '{"source": "demo_seed", "currentScore": 712, "targetScore": 780, "utilizationPct": 12.3}',
  'jmdsbwMzZqelAnliJcGQ'
);
