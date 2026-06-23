// src/index.ts — Plugin entry point for @pendragon/tools-plaid
// This is what roundtable-core imports to register Plaid tools + capabilities
// into a workspace based on its domain type.
import { registerCheckingTools, registerCheckingCapabilities } from './domains/checking.js';
import { registerInvestmentTools, registerInvestmentCapabilities } from './domains/investments.js';
import { registerDebtTools, registerDebtCapabilities } from './domains/debt.js';
import { registerRealEstateTools, registerRealEstateCapabilities } from './domains/realEstate.js';
import { registerDemographicsTools, registerDemographicsCapabilities } from './domains/demographics.js';
import { financialTools } from './tools/index.js';
export { ScopedPlaidClient } from './plaid/client.js';
export * from './types.js';
// ─── Domain → Registrars Mapping ────────────────────────────────────────────
const DOMAIN_REGISTRARS = {
    checking: { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
    savings: { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
    investments: { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
    retirement: { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
    debt: { tools: registerDebtTools, capabilities: registerDebtCapabilities },
    realestate: { tools: registerRealEstateTools, capabilities: registerRealEstateCapabilities },
    demographics: { tools: registerDemographicsTools, capabilities: registerDemographicsCapabilities },
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
    realestate: ['property.getPropertySummary', 'property.getMortgageDetails', 'property.getEquityAnalysis'],
    demographics: ['demographics.getUserProfile', 'demographics.getHousehold', 'demographics.getFinancialGoals', 'demographics.getInvestmentPreferences'],
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
    // Always register generic financial tools if DB is present
    if (process.env.DATABASE_URL) {
        for (const [name, tool] of Object.entries(financialTools)) {
            toolRegistry.register(name, tool);
        }
    }
    // Determine domain type from env
    // Priority: DOMAIN_TYPE env > PLAID_DOMAIN_TYPE env > RT_CONNECTIONS > WS_NAME heuristic > default 'checking'
    const connectionsJson = process.env.RT_CONNECTIONS;
    let domainType = process.env.DOMAIN_TYPE || process.env.PLAID_DOMAIN_TYPE || '';
    if (!domainType && connectionsJson) {
        try {
            const connections = JSON.parse(connectionsJson);
            const plaidConn = connections.find((c) => c.type === 'plaid');
            if (plaidConn) {
                domainType = plaidConn.domainType || '';
            }
        }
        catch (e) { }
    }
    if (!domainType) {
        const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
        if (wsName.includes('realestate') || wsName.includes('property')) {
            domainType = 'realestate';
        }
        else if (wsName.includes('debt')) {
            domainType = 'debt';
        }
        else if (wsName.includes('investments') || wsName.includes('retirement')) {
            domainType = 'investments';
        }
        else if (wsName.includes('demographics')) {
            domainType = 'demographics';
        }
    }
    if (!domainType) {
        domainType = 'checking';
    }
    const config = {
        domainType: domainType,
        accessToken: process.env.PLAID_ACCESS_TOKEN || '',
        clientId: process.env.PLAID_CLIENT_ID || '',
        secret: process.env.PLAID_SECRET || '',
        env: (process.env.PLAID_ENV || 'sandbox'),
        databaseUrl: process.env.DATABASE_URL || '',
    };
    pendragonPlaid.register(toolRegistry, capabilityRegistry, config);
}
//# sourceMappingURL=index.js.map