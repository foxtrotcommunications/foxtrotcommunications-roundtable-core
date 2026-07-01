-- Demographics seed data
INSERT INTO user_profile (id, display_name, date_of_birth, gender, state_of_residence, filing_status, education, employment_status, workspace_id)
VALUES (1, 'Demo User', '1991-03-15', 'male', 'IL', 'married_filing_jointly', 'bachelors_degree', 'employed_full_time', 'rt_demographics')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  date_of_birth = EXCLUDED.date_of_birth,
  gender = EXCLUDED.gender,
  state_of_residence = EXCLUDED.state_of_residence,
  filing_status = EXCLUDED.filing_status,
  education = EXCLUDED.education,
  employment_status = EXCLUDED.employment_status;

DELETE FROM household_members WHERE user_id = 1;
INSERT INTO household_members (user_id, relationship, name, date_of_birth, age_years, workspace_id) VALUES
  (1, 'spouse', 'Spouse', '1992-07-20', 33, 'rt_demographics'),
  (1, 'child', 'Child 1', '2021-04-10', 5, 'rt_demographics'),
  (1, 'child', 'Child 2', '2023-02-15', 3, 'rt_demographics'),
  (1, 'child', 'Child 3', '2025-06-01', 1, 'rt_demographics');

-- Note: financial_goals seed data removed — goals are now managed through
-- the Goals capability service (capability:goals.*), not demographics SQL.

DELETE FROM investment_preferences WHERE user_id = 1;
INSERT INTO investment_preferences (user_id, risk_tolerance, liquidity_preference, time_horizon, preferred_asset_classes, avoided_asset_classes, notes, workspace_id)
VALUES (1, 'conservative', 'high', 'long_term',
  ARRAY['bonds', 'index_funds', 'money_market', 'treasury'],
  ARRAY['crypto', 'options', 'leveraged_etfs', 'penny_stocks'],
  'Risk averse. Prefers liquidity and capital preservation over aggressive growth. With 3 young children, emergency reserves and stability are priorities.', 'rt_demographics');
