// src/index.ts — Plugin entry point for @pendragon/tools-plaid
// This is what roundtable-core imports to register Plaid tools + capabilities
// into a workspace based on its domain type.
import { registerCheckingTools, registerCheckingCapabilities } from './domains/checking.js';
import { registerInvestmentTools, registerInvestmentCapabilities } from './domains/investments.js';
import { registerDebtTools, registerDebtCapabilities } from './domains/debt.js';
export { ScopedPlaidClient } from './plaid/client.js';
export * from './types.js';
// ─── Domain → Registrars Mapping ────────────────────────────────────────────
const DOMAIN_REGISTRARS = {
    checking: { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
    savings: { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
    investments: { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
    retirement: { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
    debt: { tools: registerDebtTools, capabilities: registerDebtCapabilities },
};
// ─── Allowed Operations (static mapping — no runtime client needed) ─────────
const DOMAIN_ALLOWED_OPS = {
    checking: ['accountsGet', 'transactionsSync'],
    savings: ['accountsGet', 'transactionsSync'],
    investments: ['accountsGet', 'investmentsHoldingsGet'],
    retirement: ['accountsGet', 'investmentsHoldingsGet'],
    debt: ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
    taxes: ['accountsGet', 'transactionsSync'],
    realestate: ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
};
// ─── Domain → Capabilities Mapping ──────────────────────────────────────────
const DOMAIN_CAPS = {
    checking: ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData'],
    savings: ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData'],
    investments: ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData'],
    retirement: ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData'],
    debt: ['plaid.getLiabilities', 'plaid.getDebtSummary', 'plaid.getCreditUtilization', 'plaid.syncData'],
};
// ─── Plugin Object ──────────────────────────────────────────────────────────
export const pendragonPlaid = {
    name: 'pendragon-plaid',
    version: '1.0.0',
    register(toolRegistry, capabilityRegistry, config) {
        const registrar = DOMAIN_REGISTRARS[config.domainType];
        if (!registrar) {
            console.warn(`[pendragon-plaid] No registrar for domain type: ${config.domainType}`);
            return;
        }
        registrar.tools(toolRegistry, config);
        registrar.capabilities(capabilityRegistry, config);
        console.log(`[pendragon-plaid] Registered tools + capabilities for domain: ${config.domainType}`);
    },
    getAllowedOps(domainType) {
        return DOMAIN_ALLOWED_OPS[domainType] || [];
    },
    getCapabilities(domainType) {
        return DOMAIN_CAPS[domainType] || [];
    },
};
// ─── Auto-detect Config from Environment ────────────────────────────────────
export function registerFromEnv(toolRegistry, capabilityRegistry) {
    const connectionsJson = process.env.RT_CONNECTIONS;
    if (!connectionsJson)
        return;
    try {
        const connections = JSON.parse(connectionsJson);
        const plaidConn = connections.find((c) => c.type === 'plaid');
        if (!plaidConn)
            return;
        const prefix = plaidConn.envPrefix || 'PLAID';
        const config = {
            domainType: (process.env[`${prefix}_DOMAIN_TYPE`] || plaidConn.domainType || 'checking'),
            accessToken: process.env[`${prefix}_ACCESS_TOKEN`] || '',
            clientId: process.env[`${prefix}_CLIENT_ID`] || process.env.PLAID_CLIENT_ID || '',
            secret: process.env[`${prefix}_PLAID_SECRET`] || process.env.PLAID_SECRET || '',
            env: (process.env[`${prefix}_PLAID_ENV`] || process.env.PLAID_ENV || 'sandbox'),
            itemId: process.env[`${prefix}_ITEM_ID`],
            databaseUrl: process.env.DATABASE_URL || '',
        };
        if (!config.accessToken || !config.clientId || !config.secret) {
            console.warn('[pendragon-plaid] Missing Plaid credentials, skipping registration');
            return;
        }
        pendragonPlaid.register(toolRegistry, capabilityRegistry, config);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[pendragon-plaid] Failed to parse RT_CONNECTIONS:', message);
    }
}
//# sourceMappingURL=index.js.map