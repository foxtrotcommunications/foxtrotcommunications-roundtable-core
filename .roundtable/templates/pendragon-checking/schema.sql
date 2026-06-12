CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  category VARCHAR(50),
  account VARCHAR(100),
  type VARCHAR(20) DEFAULT 'debit',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  id SERIAL PRIMARY KEY,
  account VARCHAR(100) NOT NULL,
  balance DECIMAL(12,2) NOT NULL,
  as_of DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  monthly_limit DECIMAL(12,2) NOT NULL,
  effective_from DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
