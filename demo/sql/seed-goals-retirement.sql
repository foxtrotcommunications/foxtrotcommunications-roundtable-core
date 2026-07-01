-- =============================================================================
-- Seed: Goals & Snapshots — Retirement
-- Target database: ws_b0njzex7q4jz3kelyasx
-- =============================================================================
-- Accounts seeded: Vanguard 401(k) ($342,876), Schwab Roth IRA ($68,420)
-- Total retirement: $411,297
-- =============================================================================

-- Goal 1: Retire by 60 — need $1.5M for comfortable retirement
-- Current: $411,297 → 27.4%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_ret_retire60',
  'retirement',
  'Retire by 60',
  'Accumulate $1.5M in retirement accounts for retirement at age 60',
  1500000,
  '2041-03-15',
  2500,
  '{"growth_rate": 0.07, "retirement_age": 60, "demo_seed": true}',
  'active',
  'b0njzeX7q4JZ3KeLyASx'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_ret_retire60',
  411297,
  27.4,
  true,
  '2039-08-01',
  '{"source": "demo_seed", "growthRateAssumption": 0.07, "accounts": ["401k", "Roth IRA"]}',
  'b0njzeX7q4JZ3KeLyASx'
);

-- Goal 2: College Fund — Child 1 (age 12, 6 years to college)
-- $42,000 saved of $120,000 target → 35%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_ret_college1',
  'savings_target',
  'College Fund — Child 1',
  '529 plan for oldest child — 6 years until college enrollment',
  120000,
  '2032-08-01',
  800,
  '{"child": 1, "child_age": 12, "demo_seed": true}',
  'active',
  'b0njzeX7q4JZ3KeLyASx'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_ret_college1',
  42000,
  35.0,
  true,
  '2032-06-01',
  '{"source": "demo_seed", "childAge": 12, "yearsToCollege": 6}',
  'b0njzeX7q4JZ3KeLyASx'
);

-- Goal 3: College Fund — Child 2 (age 9, 9 years to college)
-- $28,000 saved of $120,000 target → 23.3%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_ret_college2',
  'savings_target',
  'College Fund — Child 2',
  '529 plan for middle child — 9 years until college enrollment',
  120000,
  '2035-08-01',
  600,
  '{"child": 2, "child_age": 9, "demo_seed": true}',
  'active',
  'b0njzeX7q4JZ3KeLyASx'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_ret_college2',
  28000,
  23.3,
  true,
  '2035-05-01',
  '{"source": "demo_seed", "childAge": 9, "yearsToCollege": 9}',
  'b0njzeX7q4JZ3KeLyASx'
);

-- Goal 4: College Fund — Child 3 (age 5, 13 years to college)
-- $14,000 saved of $120,000 target → 11.7%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_ret_college3',
  'savings_target',
  'College Fund — Child 3',
  '529 plan for youngest child — 13 years until college enrollment',
  120000,
  '2039-08-01',
  400,
  '{"child": 3, "child_age": 5, "demo_seed": true}',
  'active',
  'b0njzeX7q4JZ3KeLyASx'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  monthly_contribution = EXCLUDED.monthly_contribution,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_ret_college3',
  14000,
  11.7,
  true,
  '2039-04-01',
  '{"source": "demo_seed", "childAge": 5, "yearsToCollege": 13}',
  'b0njzeX7q4JZ3KeLyASx'
);
