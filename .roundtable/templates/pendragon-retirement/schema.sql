CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  account_type VARCHAR(50) NOT NULL,
  provider VARCHAR(200),
  balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  as_of DATE,
  owner VARCHAR(100),
  beneficiary VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id),
  date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  source VARCHAR(50) DEFAULT 'employee',
  tax_year INTEGER NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projections (
  id SERIAL PRIMARY KEY,
  scenario_name VARCHAR(100) NOT NULL,
  current_age INTEGER NOT NULL,
  retirement_age INTEGER NOT NULL,
  current_savings DECIMAL(14,2) NOT NULL,
  annual_contribution DECIMAL(12,2) NOT NULL,
  expected_return DECIMAL(5,4) NOT NULL,
  inflation_rate DECIMAL(5,4) DEFAULT 0.03,
  projected_balance DECIMAL(14,2),
  annual_withdrawal DECIMAL(12,2),
  success_probability DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW()
);
