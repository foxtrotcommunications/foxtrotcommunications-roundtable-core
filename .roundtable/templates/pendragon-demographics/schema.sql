-- Demographics schema — user profile, household, and investment preferences
-- Unlike other Pendragon domains, demographics is user-entered data, not Plaid data.

CREATE TABLE IF NOT EXISTS user_profile (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100),
  date_of_birth DATE,
  gender VARCHAR(20),
  state_of_residence VARCHAR(2),
  filing_status VARCHAR(30),
  education VARCHAR(50),
  employment_status VARCHAR(30),
  annual_income_estimate DECIMAL(12,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS household_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES user_profile(id),
  relationship VARCHAR(30) NOT NULL,
  name VARCHAR(100),
  date_of_birth DATE,
  age_years INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES user_profile(id),
  risk_tolerance VARCHAR(20) DEFAULT 'moderate',
  liquidity_preference VARCHAR(20) DEFAULT 'moderate',
  time_horizon VARCHAR(30),
  preferred_asset_classes TEXT[],
  avoided_asset_classes TEXT[],
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
