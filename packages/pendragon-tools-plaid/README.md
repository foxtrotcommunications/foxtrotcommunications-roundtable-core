# @pendragon/tools-plaid

Domain-isolated Plaid financial tools for Pendragon workspaces.

## Domain Isolation

Each domain type only gets access to its relevant Plaid APIs:

| Domain | Plaid APIs | Capabilities |
|--------|-----------|--------------|
| `checking` / `savings` | `accountsGet`, `transactionsSync` | `plaid.getBalances`, `plaid.getTransactions` |
| `investments` / `retirement` | `accountsGet`, `investmentsHoldingsGet` | `plaid.getHoldings`, `plaid.getSecurities`, `plaid.getPortfolioSummary` |
| `debt` | `accountsGet`, `transactionsSync`, `liabilitiesGet` | TBD |

Cross-domain API calls throw `DOMAIN_ISOLATION_VIOLATION` errors.

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
