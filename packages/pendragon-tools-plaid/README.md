# @pendragon/tools-plaid

Domain-isolated Plaid financial tools for Pendragon workspaces.

## Domain Isolation

Each domain type only gets access to its relevant Plaid APIs:

| Domain | Plaid APIs | Capabilities |
|--------|-----------|--------------|
| `checking` / `savings` | `accountsGet`, `transactionsSync` | `plaid.getBalances`, `plaid.getTransactions`, `plaid.syncData` |
| `investments` / `retirement` | `accountsGet`, `investmentsHoldingsGet` | `plaid.getHoldings`, `plaid.getSecurities`, `plaid.getPortfolioSummary`, `plaid.syncData` |
| `debt` | `accountsGet`, `transactionsSync`, `liabilitiesGet` | `plaid.getBalances`, `plaid.getTransactions`, `plaid.getPayoffSchedule`, `plaid.syncData` |
| `taxes` | `accountsGet`, `transactionsSync` | `plaid.getTaxSummary`, `plaid.getTaxReserve` |
| `realestate` | `accountsGet` | `plaid.getProperties`, `plaid.getEquity`, `plaid.getMortgage` |
| `demographics` | — | Profile and household demographic tools |

Cross-domain API calls throw `DOMAIN_ISOLATION_VIOLATION` errors.

### Amount Normalization

All Plaid amounts are normalized at sync time via `normalizeAmount()`, which negates Plaid's convention (positive = money out) to standard accounting (positive = money in, negative = money out).

### Goals System

- **Auto-goals** — `autoGoals.ts` automatically creates default financial goals (emergency fund, debt payoff, etc.) when a domain workspace has no goals configured
- **Hybrid evaluation** — Per-goal snapshots are evaluated first (fast path), falling back to live domain evaluation when no snapshot exists

## Usage

```typescript
import { pendragonPlaid, registerFromEnv } from '@pendragon/tools-plaid';

// Auto-detect from RT_CONNECTIONS env var
registerFromEnv(toolRegistry, capabilityRegistry);

// Or manual registration
pendragonPlaid.register(toolRegistry, capabilityRegistry, {
  domainType: 'checking',
  accessToken: '...',
  clientId: '...',
  secret: '...',
  env: 'sandbox',
  databaseUrl: 'postgresql://...',
});
```

## Publishing

```bash
npx google-artifactregistry-auth
npm publish
```
