// src/index.ts — Plugin entry point for @pendragon/tools-plaid
// This is what roundtable-core imports to register Plaid tools + capabilities
// into a workspace based on its domain type.

import type { DomainType, ToolRegistry, CapabilityRegistry, PlaidPluginConfig } from './types.js';
import { registerCheckingTools, registerCheckingCapabilities } from './domains/checking.js';
import { registerInvestmentTools, registerInvestmentCapabilities } from './domains/investments.js';
import { registerDebtTools, registerDebtCapabilities } from './domains/debt.js';
import { registerRealEstateTools, registerRealEstateCapabilities } from './domains/realEstate.js';
import { registerDemographicsTools, registerDemographicsCapabilities } from './domains/demographics.js';
import { registerGoalCapabilities } from './domains/goals.js';
import { ensureDefaultGoals } from './domains/autoGoals.js';
import { financialTools } from './tools/index.js';

export { ScopedPlaidClient } from './plaid/client.js';
export { ensureDefaultGoals } from './domains/autoGoals.js';
export * from './types.js';

// ─── Domain → Registrars Mapping ────────────────────────────────────────────

const DOMAIN_REGISTRARS: Record<string, {
  tools: (registry: ToolRegistry, config: PlaidPluginConfig) => void;
  capabilities: (registry: CapabilityRegistry, config: PlaidPluginConfig) => void;
}> = {
  checking:    { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
  savings:     { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
  investments: { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
  retirement:  { tools: registerInvestmentTools, capabilities: registerInvestmentCapabilities },
  debt:        { tools: registerDebtTools, capabilities: registerDebtCapabilities },
  taxes:       { tools: registerCheckingTools, capabilities: registerCheckingCapabilities },
  realestate:     { tools: registerRealEstateTools, capabilities: registerRealEstateCapabilities },
  demographics:   { tools: registerDemographicsTools, capabilities: registerDemographicsCapabilities },
};

// ─── Allowed Operations (static mapping — no runtime client needed) ─────────

const DOMAIN_ALLOWED_OPS: Record<string, string[]> = {
  checking:     ['accountsGet', 'transactionsSync'],
  savings:      ['accountsGet', 'transactionsSync'],
  investments:  ['accountsGet', 'investmentsHoldingsGet'],
  retirement:   ['accountsGet', 'investmentsHoldingsGet'],
  debt:         ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
  taxes:        ['accountsGet', 'transactionsSync'],
  realestate:   ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
  demographics: [],
};

// ─── Domain → Capabilities Mapping ──────────────────────────────────────────

const GOAL_CAPS = [
  'goals.create', 'goals.list', 'goals.get',
  'goals.update', 'goals.delete', 'goals.evaluateProgress', 'goals.snapshot',
];

const DOMAIN_CAPS: Record<string, string[]> = {
  checking:    ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData', ...GOAL_CAPS],
  savings:     ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData', ...GOAL_CAPS],
  investments: ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData', ...GOAL_CAPS],
  retirement:  ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData', ...GOAL_CAPS],
  debt:        ['plaid.getBalances', 'plaid.getTransactions', 'plaid.getLiabilities', 'plaid.getDebtSummary', 'plaid.getCreditUtilization', 'plaid.syncData', ...GOAL_CAPS],
  taxes:       ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData', ...GOAL_CAPS],
  realestate:  ['property.getPropertySummary', 'property.getMortgageDetails', 'property.getEquityAnalysis', ...GOAL_CAPS],
  demographics:   ['demographics.getUserProfile', 'demographics.getHousehold', 'demographics.getInvestmentPreferences', ...GOAL_CAPS],
};

// ─── Plugin Object ──────────────────────────────────────────────────────────

export const pendragonPlaid = {
  name: 'pendragon-plaid' as const,
  version: '1.0.0',

  register(
    toolRegistry: ToolRegistry,
    capabilityRegistry: CapabilityRegistry,
    config: PlaidPluginConfig,
  ): void {
    const registrar = DOMAIN_REGISTRARS[config.domainType];
    if (!registrar) {
      console.warn(`[pendragon-plaid] No registrar for domain type: ${config.domainType}`);
      return;
    }
    registrar.tools(toolRegistry, config);
    registrar.capabilities(capabilityRegistry, config);
    // Goals are for financial domains only — demographics doesn't get goals
    const hasGoals = config.domainType !== 'demographics';
    if (hasGoals) {
      registerGoalCapabilities(capabilityRegistry, config);
    }
    console.log(`[pendragon-plaid] Registered tools + capabilities${hasGoals ? ' + goals' : ''} for domain: ${config.domainType}`);

    // Ensure domain schema tables exist, then seed default goals (non-blocking)
    // Uses retry loop because Cloud SQL proxy sidecar may not be ready yet
    if (config.databaseUrl) {
      const initSchema = async () => {
        const { getSchemaForDomain } = await import('./db/schemas.js');
        const { withPool: wp } = await import('./db/pool.js');
        const maxRetries = 12;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await wp(config.databaseUrl, async (pool) => {
              await pool.query(getSchemaForDomain(config.domainType as DomainType));
            });
            console.log(`[pendragon-plaid] Schema ensured for domain: ${config.domainType}`);
            if (hasGoals) await ensureDefaultGoals(config);
            return;
          } catch (err: any) {
            if (attempt === maxRetries) {
              console.warn(`[pendragon-plaid] Schema/goal init failed after ${maxRetries} attempts: ${err.message}`);
              return;
            }
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      };
      initSchema();
    }
  },

  getAllowedOps(domainType: DomainType): string[] {
    return DOMAIN_ALLOWED_OPS[domainType] || [];
  },

  getCapabilities(domainType: DomainType): string[] {
    return DOMAIN_CAPS[domainType] || [];
  },
};

// ─── Auto-detect Config from Environment ────────────────────────────────────

export function registerFromEnv(
  toolRegistry: ToolRegistry,
  capabilityRegistry: CapabilityRegistry,
): void {
  // Always register generic financial tools if DB is present
  if (process.env.DATABASE_URL) {
    for (const [name, tool] of Object.entries(financialTools)) {
      toolRegistry.register(name, tool as any);
    }
  }

  // Determine domain type from env
  // Priority: DOMAIN_TYPE env > PLAID_DOMAIN_TYPE env > RT_CONNECTIONS > WS_NAME heuristic > default 'checking'
  const connectionsJson = process.env.RT_CONNECTIONS;
  let domainType: string = process.env.DOMAIN_TYPE || process.env.PLAID_DOMAIN_TYPE || '';
  
  if (!domainType && connectionsJson) {
    try {
      const connections = JSON.parse(connectionsJson);
      const plaidConn = connections.find((c: Record<string, unknown>) => c.type === 'plaid');
      if (plaidConn) {
        domainType = (plaidConn.domainType as string) || '';
      }
    } catch (e) {}
  }

  if (!domainType) {
    const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
    if (wsName.includes('realestate') || wsName.includes('property')) {
      domainType = 'realestate';
    } else if (wsName.includes('debt')) {
      domainType = 'debt';
    } else if (wsName.includes('investments') || wsName.includes('retirement')) {
      domainType = 'investments';
    } else if (wsName.includes('demographics')) {
      domainType = 'demographics';
    }
  }

  if (!domainType) {
    domainType = 'checking';
  }

  const config: PlaidPluginConfig = {
    domainType: domainType as DomainType,
    accessToken: process.env.PLAID_ACCESS_TOKEN || '',
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret: process.env.PLAID_SECRET || '',
    env: (process.env.PLAID_ENV || 'sandbox') as 'sandbox' | 'production',
    databaseUrl: process.env.DATABASE_URL || '',
  };

  pendragonPlaid.register(toolRegistry, capabilityRegistry, config);
}
