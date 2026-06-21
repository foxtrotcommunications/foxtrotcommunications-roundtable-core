// src/plaid/client.ts — Domain-scoped Plaid client
// Enforces domain isolation at the API level: each domain type ONLY
// gets access to its relevant Plaid operations.

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { DomainType } from '../types.js';

// ─── Domain → Allowed Operations ────────────────────────────────────────────

const DOMAIN_ALLOWED_OPS: Record<DomainType, Set<string>> = {
  checking:    new Set(['accountsGet', 'transactionsSync']),
  savings:     new Set(['accountsGet', 'transactionsSync']),
  investments: new Set(['accountsGet', 'investmentsHoldingsGet']),
  retirement:  new Set(['accountsGet', 'investmentsHoldingsGet']),
  debt:        new Set(['accountsGet', 'transactionsSync', 'liabilitiesGet']),
  taxes:       new Set(['accountsGet', 'transactionsSync']),
  realestate:  new Set(['accountsGet', 'transactionsSync', 'liabilitiesGet']),
};

// ─── ScopedPlaidClient ──────────────────────────────────────────────────────

export class ScopedPlaidClient {
  private client: PlaidApi;
  private domainType: DomainType;
  private allowedOps: Set<string>;

  constructor(clientId: string, secret: string, env: string, domainType: DomainType) {
    const config = new Configuration({
      basePath: env === 'production' ? PlaidEnvironments.production : PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    });
    this.client = new PlaidApi(config);
    this.domainType = domainType;
    this.allowedOps = DOMAIN_ALLOWED_OPS[domainType] || new Set();
  }

  private assertAllowed(op: string): void {
    if (!this.allowedOps.has(op)) {
      throw new Error(
        `DOMAIN_ISOLATION_VIOLATION: Operation '${op}' is not permitted for domain type '${this.domainType}'. ` +
        `Allowed operations: [${[...this.allowedOps].join(', ')}]`,
      );
    }
  }

  getAllowedOps(): string[] {
    return [...this.allowedOps];
  }

  async accountsGet(accessToken: string) {
    this.assertAllowed('accountsGet');
    return this.client.accountsGet({ access_token: accessToken });
  }

  async transactionsSync(accessToken: string, cursor?: string) {
    this.assertAllowed('transactionsSync');
    return this.client.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
    });
  }

  async investmentsHoldingsGet(accessToken: string) {
    this.assertAllowed('investmentsHoldingsGet');
    return this.client.investmentsHoldingsGet({ access_token: accessToken });
  }

  async liabilitiesGet(accessToken: string) {
    this.assertAllowed('liabilitiesGet');
    return this.client.liabilitiesGet({ access_token: accessToken });
  }
}
