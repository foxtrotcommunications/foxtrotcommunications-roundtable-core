-- Demographics domain schema
CREATE TABLE IF NOT EXISTS user_profile (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  gender TEXT,
  state_of_residence TEXT,
  filing_status TEXT,
  education TEXT,
  employment_status TEXT,
  annual_income_estimate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profile_ws ON user_profile(workspace_id);
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON user_profile;
CREATE POLICY workspace_isolation ON user_profile
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE user_profile FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS household_members (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER REFERENCES user_profile(id),
  relationship TEXT NOT NULL,
  name TEXT,
  date_of_birth DATE,
  age_years INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_household_members_ws ON household_members(workspace_id);
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON household_members;
CREATE POLICY workspace_isolation ON household_members
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE household_members FORCE ROW LEVEL SECURITY;

-- financial_goals table removed — goals are now managed through the
-- Goals capability service (capability:goals.*), not demographics SQL.
DROP TABLE IF EXISTS financial_goals;

CREATE TABLE IF NOT EXISTS investment_preferences (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER REFERENCES user_profile(id),
  risk_tolerance TEXT NOT NULL,
  liquidity_preference TEXT,
  time_horizon TEXT,
  preferred_asset_classes TEXT[],
  avoided_asset_classes TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investment_preferences_ws ON investment_preferences(workspace_id);
ALTER TABLE investment_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON investment_preferences;
CREATE POLICY workspace_isolation ON investment_preferences
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE investment_preferences FORCE ROW LEVEL SECURITY;
