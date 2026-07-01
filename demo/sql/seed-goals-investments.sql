-- =============================================================================
-- Seed: Goals & Snapshots — Investments
-- Target database: ws_lyjs7zedanzc1fdio3es
-- =============================================================================
-- Accounts seeded: Fidelity Brokerage ($187,433)
-- Holdings: VOO, QQQ, AAPL, MSFT, GOOGL, AMZN, BND, VXUS, SCHD, NVDA
-- =============================================================================

-- Goal: Portfolio Growth — grow brokerage to $350K
-- Current: $187,433 → 53.6%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_inv_growth',
  'portfolio_growth',
  'Portfolio Growth',
  'Grow investment portfolio to $350,000 with 7% assumed annual returns',
  350000,
  '2030-01-01',
  1500,
  '{"growth_rate": 0.07, "demo_seed": true}',
  'active',
  'lYjs7ZeDanzC1FDiO3es'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_inv_growth',
  187433,
  53.6,
  true,
  '2029-04-01',
  '{"source": "demo_seed", "growthRateAssumption": 0.07, "holdings": 10}',
  'lYjs7ZeDanzC1FDiO3es'
);
