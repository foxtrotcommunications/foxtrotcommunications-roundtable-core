CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  ticker VARCHAR(10) NOT NULL,
  name VARCHAR(200),
  asset_class VARCHAR(50) DEFAULT 'equity',
  sector VARCHAR(100),
  shares DECIMAL(15,6) NOT NULL,
  avg_cost DECIMAL(12,4) NOT NULL,
  current_price DECIMAL(12,4),
  last_updated TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  action VARCHAR(10) NOT NULL,
  shares DECIMAL(15,6) NOT NULL,
  price DECIMAL(12,4) NOT NULL,
  fees DECIMAL(8,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_data (
  id SERIAL PRIMARY KEY,
  ticker VARCHAR(10) NOT NULL,
  date DATE NOT NULL,
  open DECIMAL(12,4),
  high DECIMAL(12,4),
  low DECIMAL(12,4),
  close DECIMAL(12,4) NOT NULL,
  volume BIGINT,
  UNIQUE(ticker, date)
);
