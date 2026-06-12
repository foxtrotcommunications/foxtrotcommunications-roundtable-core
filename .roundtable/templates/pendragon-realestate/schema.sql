CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  property_type VARCHAR(50) DEFAULT 'primary_residence',
  purchase_date DATE,
  purchase_price DECIMAL(14,2),
  estimated_value DECIMAL(14,2),
  value_as_of DATE,
  lot_size VARCHAR(50),
  square_feet INTEGER,
  year_built INTEGER,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mortgages (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  lender VARCHAR(200),
  loan_type VARCHAR(50) DEFAULT 'fixed',
  original_amount DECIMAL(14,2) NOT NULL,
  current_balance DECIMAL(14,2) NOT NULL,
  interest_rate DECIMAL(5,4) NOT NULL,
  term_months INTEGER NOT NULL,
  start_date DATE NOT NULL,
  monthly_payment DECIMAL(10,2) NOT NULL,
  escrow_amount DECIMAL(10,2) DEFAULT 0,
  pmi_amount DECIMAL(8,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS property_payments (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  mortgage_id INTEGER REFERENCES mortgages(id),
  date DATE NOT NULL,
  total_payment DECIMAL(10,2) NOT NULL,
  principal DECIMAL(10,2),
  interest DECIMAL(10,2),
  escrow DECIMAL(10,2),
  extra_principal DECIMAL(10,2) DEFAULT 0,
  payment_type VARCHAR(50) DEFAULT 'mortgage',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
