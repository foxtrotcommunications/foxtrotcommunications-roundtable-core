-- =============================================================================
-- Seed: Real Estate properties, mortgages, and valuations
-- Target database: ws_qy339asobmooibkdw9mh
--
-- NOTE: The realEstate.ts domain module auto-seeds this data on startup
-- if the properties table is empty. This file is for manual seeding.
-- =============================================================================

-- Properties: 3 holdings across IL, DC, and OR
INSERT INTO properties (address, city, state, zip, property_type, purchase_date, purchase_price, current_value, bedrooms, bathrooms, square_feet, lot_size_sqft, year_built, status)
VALUES
  ('742 Evergreen Terrace', 'Springfield', 'IL', '62704', 'single_family', '2019-06-15', 285000, 425000, 4, 2.5, 2400, 8500, 1987, 'owned'),
  ('1600 Pennsylvania Ave', 'Georgetown', 'DC', '20500', 'townhouse', '2021-03-01', 650000, 785000, 3, 2.0, 1800, 3200, 1942, 'owned'),
  ('221B Baker St', 'Portland', 'OR', '97205', 'condo', '2023-09-10', 340000, 355000, 2, 1.0, 1100, 0, 2018, 'owned')
ON CONFLICT DO NOTHING;

-- Mortgages: one per property, varying rates and terms
INSERT INTO mortgages (property_id, lender, loan_type, original_amount, current_balance, interest_rate, term_months, monthly_payment, start_date, maturity_date, escrow_monthly)
VALUES
  (1, 'Wells Fargo', 'conventional', 228000, 189500, 3.875, 360, 1072, '2019-06-15', '2049-06-15', 285),
  (2, 'Chase', 'conventional', 520000, 478200, 5.250, 360, 2872, '2021-03-01', '2051-03-01', 410),
  (3, 'US Bank', 'conventional', 272000, 258700, 6.750, 360, 1764, '2023-09-10', '2053-09-10', 195)
ON CONFLICT DO NOTHING;

-- Valuations: semi-annual estimates from Zillow and Redfin
INSERT INTO property_valuations (property_id, valuation_date, estimated_value, source)
VALUES
  (1, '2024-01-15', 395000, 'zillow'),
  (1, '2024-06-15', 410000, 'zillow'),
  (1, '2025-01-15', 425000, 'zillow'),
  (2, '2024-01-15', 740000, 'redfin'),
  (2, '2024-06-15', 760000, 'redfin'),
  (2, '2025-01-15', 785000, 'redfin'),
  (3, '2024-01-15', 342000, 'zillow'),
  (3, '2024-06-15', 348000, 'zillow'),
  (3, '2025-01-15', 355000, 'zillow')
ON CONFLICT DO NOTHING;
