-- Demographics domain schema
CREATE TABLE IF NOT EXISTS user_profile (
  id SERIAL PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS household_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES user_profile(id),
  relationship TEXT NOT NULL,
  name TEXT,
  date_of_birth DATE,
  age_years INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- financial_goals table removed — goals are now managed through the
-- Goals capability service (capability:goals.*), not demographics SQL.
DROP TABLE IF EXISTS financial_goals;

CREATE TABLE IF NOT EXISTS investment_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES user_profile(id),
  risk_tolerance TEXT NOT NULL,
  liquidity_preference TEXT,
  time_horizon TEXT,
  preferred_asset_classes TEXT[],
  avoided_asset_classes TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
