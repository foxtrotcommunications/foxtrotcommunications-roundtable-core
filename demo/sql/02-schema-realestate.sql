-- =============================================================================
-- Real Estate Domain Schema
-- Applied to the Real Estate workspace database only.
-- =============================================================================

-- Properties: physical real estate holdings
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_properties_address UNIQUE (address, city, state, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_properties_ws ON properties(workspace_id);
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON properties;
CREATE POLICY workspace_isolation ON properties
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE properties FORCE ROW LEVEL SECURITY;

-- Mortgages: loan details tied to properties
CREATE TABLE IF NOT EXISTS mortgages (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
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

-- Mortgages must be unique per property+lender+workspace. Without this, the
-- seed's ON CONFLICT DO NOTHING is a no-op (no conflict target exists) and
-- every seed re-run silently duplicates all mortgage rows — doubling reported
-- mortgage debt and breaking equity/net-worth analysis. Dedupe defensively
-- (keep lowest id), then add the constraint, idempotently.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_mortgages_property_lender') THEN
    DELETE FROM mortgages a USING mortgages b
      WHERE a.property_id = b.property_id AND a.lender = b.lender
        AND a.workspace_id = b.workspace_id AND a.id > b.id;
    ALTER TABLE mortgages
      ADD CONSTRAINT uq_mortgages_property_lender UNIQUE (property_id, lender, workspace_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mortgages_ws ON mortgages(workspace_id);
ALTER TABLE mortgages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON mortgages;
CREATE POLICY workspace_isolation ON mortgages
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE mortgages FORCE ROW LEVEL SECURITY;

-- Property valuations: historical estimated values from external sources
CREATE TABLE IF NOT EXISTS property_valuations (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  valuation_date DATE NOT NULL,
  estimated_value NUMERIC NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Same idempotency guard as mortgages: valuations were also silently
-- duplicated on every seed re-run (18 rows for 9 valuations observed live).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_valuations_property_date') THEN
    DELETE FROM property_valuations a USING property_valuations b
      WHERE a.property_id = b.property_id AND a.valuation_date = b.valuation_date
        AND a.workspace_id = b.workspace_id AND a.id > b.id;
    ALTER TABLE property_valuations
      ADD CONSTRAINT uq_valuations_property_date UNIQUE (property_id, valuation_date, workspace_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_property_valuations_ws ON property_valuations(workspace_id);
ALTER TABLE property_valuations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON property_valuations;
CREATE POLICY workspace_isolation ON property_valuations
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE property_valuations FORCE ROW LEVEL SECURITY;
