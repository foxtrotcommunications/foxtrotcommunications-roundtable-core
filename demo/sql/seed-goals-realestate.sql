-- =============================================================================
-- Seed: Goals & Snapshots — Real Estate
-- Target database: ws_qy339asobmooibkdw9mh
-- =============================================================================
-- Properties seeded:
--   742 Evergreen Terrace, Springfield IL — value $425K, mortgage $189.5K
--   1600 Pennsylvania Ave, Georgetown DC  — value $785K, mortgage $478.2K
--   221B Baker St, Portland OR            — value $355K, mortgage $258.7K
-- Total property value: $1,565,000
-- Total mortgages: $926,400
-- Total equity: $638,600
-- =============================================================================

-- Goal: Home Equity Growth — grow total equity to $800K
-- Current equity: $638,600 → 79.8%
INSERT INTO domain_goals (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
VALUES (
  'goal_demo_re_equity',
  'equity_growth',
  'Home Equity Growth',
  'Grow total real estate equity to $800,000 through mortgage paydown and appreciation',
  800000,
  '2030-01-01',
  NULL,
  '{"properties": 3, "demo_seed": true}',
  'active',
  'rt_realestate'
) ON CONFLICT (id) DO UPDATE SET
  target_amount = EXCLUDED.target_amount,
  updated_at = NOW();

INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
VALUES (
  'goal_demo_re_equity',
  638600,
  79.8,
  true,
  '2028-06-01',
  '{"source": "demo_seed", "totalPropertyValue": 1565000, "totalMortgages": 926400, "properties": 3}',
  'rt_realestate'
);
