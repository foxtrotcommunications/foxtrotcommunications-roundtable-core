CREATE TABLE IF NOT EXISTS debts (
  id SERIAL PRIMARY KEY,
  creditor VARCHAR(200) NOT NULL,
  debt_type VARCHAR(50) NOT NULL,
  original_balance DECIMAL(12,2),
  current_balance DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(5,4) NOT NULL,
  minimum_payment DECIMAL(10,2) NOT NULL,
  origination_date DATE,
  due_day INTEGER,
  is_fixed_rate BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS debt_payments (
  id SERIAL PRIMARY KEY,
  debt_id INTEGER REFERENCES debts(id),
  date DATE NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  principal DECIMAL(10,2),
  interest DECIMAL(10,2),
  extra_payment DECIMAL(10,2) DEFAULT 0,
  remaining_balance DECIMAL(12,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payoff_plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  strategy VARCHAR(20) NOT NULL,
  extra_monthly DECIMAL(10,2) DEFAULT 0,
  projected_payoff_date DATE,
  total_interest DECIMAL(12,2),
  total_paid DECIMAL(14,2),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
