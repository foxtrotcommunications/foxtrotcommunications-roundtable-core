# Pendragon Capital — Data Architecture

## Overview

Pendragon Capital is a multi-strategy hedge fund operating four sub-funds
through a shared technology infrastructure managed by Roundtable.

## Funds

| Fund | Strategy | AUM | Key Focus |
|------|----------|-----|-----------|
| Excalibur Fund | Multi-Strategy | ~$2.8B | Cross-asset execution and order routing |
| Arthur Equity Fund | Quant Equities | ~$1.5B | Systematic equity alpha |
| Macro Alpha Fund | Global Macro | ~$950M | Rates, FX, commodities, global themes |
| Gawain Risk Parity | Risk Parity | ~$620M | Cross-asset hedging and portfolio overlay |

## Data Governance

Each workspace operates within a **scoped BigQuery dataset** containing
only the views relevant to its role. This is an application-level data
governance model — workspaces can only see and query their own data.

To access data outside your scope, use **Bridge** connections to request
information from the appropriate workspace. Bridges are governed by
**Contracts** that define what actions are permitted between workspaces.

## Discovering Your Data

To see what tables are available in your dataset, query:

```sql
SELECT table_name
FROM `YOUR_DATASET.INFORMATION_SCHEMA.TABLES`
```

To see columns for a specific table:

```sql
SELECT column_name, data_type, description
FROM `YOUR_DATASET.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'your_table'
```

Your dataset name is configured in your workspace's `data_sources` setting.

## Asset Classes

Pendragon trades across multiple asset classes:

- **Equities** — US large-cap stocks (AAPL, MSFT, GOOGL, AMZN, etc.)
- **Futures** — Index futures (ES, NQ), commodities (CL, GC), treasuries (ZB)
- **FX** — Major pairs (EURUSD, GBPUSD, USDJPY)
- **Crypto** — BTC, ETH

## Key Contacts

- **Risk**: Gawain Risk workspace — cross-fund VaR, exposure, leverage
- **Compliance**: Galahad Compliance workspace — trade audits, violations
- **Research**: Merlin Research workspace — alpha signals, market analysis
- **Execution**: Excalibur Execution workspace — order routing, trade history
- **Data**: Data Platform workspace — raw market data feeds
