-- =============================================================================
-- Real Estate Domain Schema
-- Applied to the Real Estate workspace database only.
-- =============================================================================

-- Properties: physical real estate holdings
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  property_type TEXT NOT NULL,
  purchase_date DATE,
  purchase_price NUMERIC,
  current_value NUMERIC,
  bedrooms INTEGER,
  bathrooms NUMERIC,
  square_feet INTEGER,
  lot_size_sqft INTEGER,
  year_built INTEGER,
  status TEXT NOT NULL DEFAULT 'owned',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mortgages: loan details tied to properties
CREATE TABLE IF NOT EXISTS mortgages (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  lender TEXT NOT NULL,
  loan_type TEXT NOT NULL,
  original_amount NUMERIC,
  current_balance NUMERIC,
  interest_rate NUMERIC,
  term_months INTEGER,
  monthly_payment NUMERIC,
  start_date DATE,
  maturity_date DATE,
  escrow_monthly NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Property valuations: historical estimated values from external sources
CREATE TABLE IF NOT EXISTS property_valuations (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  valuation_date DATE NOT NULL,
  estimated_value NUMERIC NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
