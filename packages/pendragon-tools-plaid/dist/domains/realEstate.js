// src/domains/realEstate.ts — Real estate domain module
// Contains property capabilities that query Cloud SQL for property data.
// Unlike checking/debt, this domain doesn't use Plaid — it uses a dedicated
// property schema seeded with property data.
import { withPool } from '../db/pool.js';
// ─── Schema ─────────────────────────────────────────────────────────────────
const PROPERTY_SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  property_type TEXT NOT NULL DEFAULT 'single_family',
  purchase_date DATE,
  purchase_price NUMERIC(12,2),
  current_value NUMERIC(12,2),
  bedrooms INTEGER,
  bathrooms NUMERIC(3,1),
  square_feet INTEGER,
  lot_size_sqft INTEGER,
  year_built INTEGER,
  status TEXT NOT NULL DEFAULT 'owned',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mortgages (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  lender TEXT NOT NULL,
  loan_type TEXT NOT NULL DEFAULT 'conventional',
  original_amount NUMERIC(12,2),
  current_balance NUMERIC(12,2),
  interest_rate NUMERIC(5,3),
  term_months INTEGER DEFAULT 360,
  monthly_payment NUMERIC(10,2),
  start_date DATE,
  maturity_date DATE,
  escrow_monthly NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS property_valuations (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  valuation_date DATE NOT NULL,
  estimated_value NUMERIC(12,2) NOT NULL,
  source TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;
// ─── Seed Data ──────────────────────────────────────────────────────────────
const SEED_DATA = `
INSERT INTO properties (address, city, state, zip, property_type, purchase_date, purchase_price, current_value, bedrooms, bathrooms, square_feet, lot_size_sqft, year_built, status)
SELECT * FROM (VALUES
  ('742 Evergreen Terrace', 'Springfield', 'IL', '62704', 'single_family', '2019-06-15'::date, 285000.00, 425000.00, 4, 2.5, 2400, 8500, 1987, 'owned'),
  ('1600 Pennsylvania Ave', 'Georgetown', 'DC', '20500', 'townhouse', '2021-03-01'::date, 650000.00, 785000.00, 3, 2.0, 1800, 3200, 1942, 'owned'),
  ('221B Baker St', 'Portland', 'OR', '97205', 'condo', '2023-09-10'::date, 340000.00, 355000.00, 2, 1.0, 1100, 0, 2018, 'owned')
) AS v(address, city, state, zip, property_type, purchase_date, purchase_price, current_value, bedrooms, bathrooms, square_feet, lot_size_sqft, year_built, status)
WHERE NOT EXISTS (SELECT 1 FROM properties LIMIT 1);

INSERT INTO mortgages (property_id, lender, loan_type, original_amount, current_balance, interest_rate, term_months, monthly_payment, start_date, maturity_date, escrow_monthly)
SELECT * FROM (VALUES
  (1, 'Wells Fargo', 'conventional', 228000.00, 189500.00, 3.875, 360, 1072.00, '2019-06-15'::date, '2049-06-15'::date, 285.00),
  (2, 'Chase', 'conventional', 520000.00, 478200.00, 5.250, 360, 2872.00, '2021-03-01'::date, '2051-03-01'::date, 410.00),
  (3, 'US Bank', 'conventional', 272000.00, 258700.00, 6.750, 360, 1764.00, '2023-09-10'::date, '2053-09-10'::date, 195.00)
) AS v(property_id, lender, loan_type, original_amount, current_balance, interest_rate, term_months, monthly_payment, start_date, maturity_date, escrow_monthly)
WHERE NOT EXISTS (SELECT 1 FROM mortgages LIMIT 1);

INSERT INTO property_valuations (property_id, valuation_date, estimated_value, source)
SELECT * FROM (VALUES
  (1, '2024-01-15'::date, 395000.00, 'zillow'),
  (1, '2024-06-15'::date, 410000.00, 'zillow'),
  (1, '2025-01-15'::date, 425000.00, 'zillow'),
  (2, '2024-01-15'::date, 740000.00, 'redfin'),
  (2, '2024-06-15'::date, 760000.00, 'redfin'),
  (2, '2025-01-15'::date, 785000.00, 'redfin'),
  (3, '2024-01-15'::date, 342000.00, 'zillow'),
  (3, '2024-06-15'::date, 348000.00, 'zillow'),
  (3, '2025-01-15'::date, 355000.00, 'zillow')
) AS v(property_id, valuation_date, estimated_value, source)
WHERE NOT EXISTS (SELECT 1 FROM property_valuations LIMIT 1);
`;
// ─── Capability Handlers ────────────────────────────────────────────────────
function makeGetPropertySummary(databaseUrl) {
    return async (_input) => {
        return withPool(databaseUrl, async (pool) => {
            // Ensure schema and seed data exist
            await pool.query(PROPERTY_SCHEMA);
            await pool.query(SEED_DATA);
            const result = await pool.query(`
        SELECT p.id, p.address, p.city, p.state, p.zip, p.property_type,
               p.purchase_date, p.purchase_price, p.current_value,
               p.bedrooms, p.bathrooms, p.square_feet, p.year_built, p.status,
               m.lender, m.current_balance as mortgage_balance, m.interest_rate,
               m.monthly_payment,
               (p.current_value - COALESCE(m.current_balance, 0)) as equity
        FROM properties p
        LEFT JOIN mortgages m ON m.property_id = p.id
        WHERE p.status = 'owned'
        ORDER BY p.current_value DESC
      `);
            return {
                properties: result.rows,
                totalValue: result.rows.reduce((s, r) => s + parseFloat(r.current_value || 0), 0),
                totalEquity: result.rows.reduce((s, r) => s + parseFloat(r.equity || 0), 0),
                totalMortgageBalance: result.rows.reduce((s, r) => s + parseFloat(r.mortgage_balance || 0), 0),
                propertyCount: result.rows.length,
            };
        });
    };
}
function makeGetMortgageDetails(databaseUrl) {
    return async (input) => {
        return withPool(databaseUrl, async (pool) => {
            await pool.query(PROPERTY_SCHEMA);
            await pool.query(SEED_DATA);
            const propertyId = input.propertyId;
            const query = propertyId
                ? `SELECT m.*, p.address, p.city, p.state
           FROM mortgages m JOIN properties p ON p.id = m.property_id
           WHERE m.property_id = $1`
                : `SELECT m.*, p.address, p.city, p.state
           FROM mortgages m JOIN properties p ON p.id = m.property_id
           ORDER BY m.current_balance DESC`;
            const result = propertyId
                ? await pool.query(query, [propertyId])
                : await pool.query(query);
            return {
                mortgages: result.rows,
                totalBalance: result.rows.reduce((s, r) => s + parseFloat(r.current_balance || 0), 0),
                totalMonthlyPayment: result.rows.reduce((s, r) => s + parseFloat(r.monthly_payment || 0), 0),
                weightedAvgRate: result.rows.length > 0
                    ? result.rows.reduce((s, r) => s + parseFloat(r.interest_rate) * parseFloat(r.current_balance), 0) /
                        result.rows.reduce((s, r) => s + parseFloat(r.current_balance || 0), 0)
                    : 0,
            };
        });
    };
}
function makeGetEquityAnalysis(databaseUrl) {
    return async (_input) => {
        return withPool(databaseUrl, async (pool) => {
            await pool.query(PROPERTY_SCHEMA);
            await pool.query(SEED_DATA);
            const result = await pool.query(`
        SELECT p.id, p.address, p.city, p.state, p.purchase_price, p.current_value,
               m.original_amount, m.current_balance, m.interest_rate,
               (p.current_value - COALESCE(m.current_balance, 0)) as equity,
               ROUND(((p.current_value - COALESCE(m.current_balance, 0))::numeric / p.current_value * 100), 1) as equity_pct,
               (p.current_value - p.purchase_price) as appreciation,
               ROUND(((p.current_value - p.purchase_price)::numeric / p.purchase_price * 100), 1) as appreciation_pct
        FROM properties p
        LEFT JOIN mortgages m ON m.property_id = p.id
        WHERE p.status = 'owned'
        ORDER BY equity DESC
      `);
            const totalValue = result.rows.reduce((s, r) => s + parseFloat(r.current_value || 0), 0);
            const totalEquity = result.rows.reduce((s, r) => s + parseFloat(r.equity || 0), 0);
            const totalPurchasePrice = result.rows.reduce((s, r) => s + parseFloat(r.purchase_price || 0), 0);
            return {
                properties: result.rows,
                portfolio: {
                    totalValue,
                    totalEquity,
                    overallEquityPct: totalValue > 0 ? Math.round(totalEquity / totalValue * 1000) / 10 : 0,
                    totalAppreciation: totalValue - totalPurchasePrice,
                    totalAppreciationPct: totalPurchasePrice > 0 ? Math.round((totalValue - totalPurchasePrice) / totalPurchasePrice * 1000) / 10 : 0,
                },
            };
        });
    };
}
// ─── Registration ───────────────────────────────────────────────────────────
export function registerRealEstateTools(_registry, _config) {
    // Real estate domain doesn't expose direct tools — it uses capabilities via ICE
}
export function registerRealEstateCapabilities(registry, config) {
    const databaseUrl = config.databaseUrl;
    registry.register({
        name: 'property.getPropertySummary',
        description: 'Get a summary of all owned properties including valuations, mortgage balances, and equity',
        inputSchema: { type: 'object', properties: {}, required: [] },
        outputSchema: { type: 'object', properties: { properties: { type: 'array' }, totalValue: { type: 'number' }, totalEquity: { type: 'number' } } },
        handler: makeGetPropertySummary(databaseUrl),
    });
    registry.register({
        name: 'property.getMortgageDetails',
        description: 'Get detailed mortgage information for all properties or a specific property',
        inputSchema: { type: 'object', properties: { propertyId: { type: 'number', description: 'Optional property ID to filter by' } } },
        outputSchema: { type: 'object', properties: { mortgages: { type: 'array' }, totalBalance: { type: 'number' } } },
        handler: makeGetMortgageDetails(databaseUrl),
    });
    registry.register({
        name: 'property.getEquityAnalysis',
        description: 'Analyze equity position across all owned properties with appreciation tracking',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { properties: { type: 'array' }, portfolio: { type: 'object' } } },
        handler: makeGetEquityAnalysis(databaseUrl),
    });
    console.log(`[realEstate] Registered 3 property capabilities`);
}
//# sourceMappingURL=realEstate.js.map