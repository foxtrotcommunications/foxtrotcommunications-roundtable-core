// src/plaid/client.ts — Domain-scoped Plaid client
// Enforces domain isolation at the API level: each domain type ONLY
// gets access to its relevant Plaid operations.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
// ─── Domain → Allowed Operations ────────────────────────────────────────────
const DOMAIN_ALLOWED_OPS = {
    checking: new Set(['accountsGet', 'transactionsSync']),
    savings: new Set(['accountsGet', 'transactionsSync']),
    investments: new Set(['accountsGet', 'investmentsHoldingsGet']),
    retirement: new Set(['accountsGet', 'investmentsHoldingsGet']),
    debt: new Set(['accountsGet', 'transactionsSync', 'liabilitiesGet']),
    taxes: new Set(['accountsGet', 'transactionsSync']),
    realestate: new Set(['accountsGet', 'transactionsSync', 'liabilitiesGet']),
    demographics: new Set(), // Demographics does not use Plaid — queries PostgreSQL directly
};
// ─── ScopedPlaidClient ──────────────────────────────────────────────────────
export class ScopedPlaidClient {
    client;
    domainType;
    allowedOps;
    constructor(clientId, secret, env, domainType) {
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
    assertAllowed(op) {
        if (!this.allowedOps.has(op)) {
            throw new Error(`DOMAIN_ISOLATION_VIOLATION: Operation '${op}' is not permitted for domain type '${this.domainType}'. ` +
                `Allowed operations: [${[...this.allowedOps].join(', ')}]`);
        }
    }
    getAllowedOps() {
        return [...this.allowedOps];
    }
    async accountsGet(accessToken) {
        this.assertAllowed('accountsGet');
        return this.client.accountsGet({ access_token: accessToken });
    }
    async transactionsSync(accessToken, cursor) {
        this.assertAllowed('transactionsSync');
        return this.client.transactionsSync({
            access_token: accessToken,
            ...(cursor ? { cursor } : {}),
        });
    }
    async investmentsHoldingsGet(accessToken) {
        this.assertAllowed('investmentsHoldingsGet');
        return this.client.investmentsHoldingsGet({ access_token: accessToken });
    }
    async liabilitiesGet(accessToken) {
        this.assertAllowed('liabilitiesGet');
        return this.client.liabilitiesGet({ access_token: accessToken });
    }
}
//# sourceMappingURL=client%202.js.map