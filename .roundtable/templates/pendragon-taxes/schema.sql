CREATE TABLE IF NOT EXISTS income (
  id SERIAL PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  source VARCHAR(200) NOT NULL,
  income_type VARCHAR(50) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  withholding DECIMAL(12,2) DEFAULT 0,
  is_w2 BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deductions (
  id SERIAL PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  amount DECIMAL(12,2) NOT NULL,
  is_itemized BOOLEAN DEFAULT TRUE,
  supporting_doc VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  payment_type VARCHAR(50) NOT NULL,
  quarter INTEGER,
  amount DECIMAL(12,2) NOT NULL,
  date_paid DATE NOT NULL,
  confirmation VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forms (
  id SERIAL PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  form_type VARCHAR(20) NOT NULL,
  issuer VARCHAR(200),
  amount DECIMAL(12,2),
  received_date DATE,
  filed BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
