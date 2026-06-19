// src/index.ts — Plugin entry point for @pendragon/tools-plaid
// This is what roundtable-core imports to register Plaid tools + capabilities
// into a workspace based on its domain type.

import type { DomainType, ToolRegistry, CapabilityRegistry, PlaidPluginConfig } from './types.js';
import { registerCheckingTools, registerCheckingCapabilities } from './domains/checking.js';
import { registerInvestmentTools, registerInvestmentCapabilities } from './domains/investments.js';
import { registerDebtTools, registerDebtCapabilities } from './domains/debt.js';
import { registerRealEstateTools, registerRealEstateCapabilities } from './domains/realEstate.js';

export { ScopedPlaidClient } from './plaid/client.js';
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
  realestate:  { tools: registerRealEstateTools, capabilities: registerRealEstateCapabilities },
};

// ─── Allowed Operations (static mapping — no runtime client needed) ─────────

const DOMAIN_ALLOWED_OPS: Record<string, string[]> = {
  checking:    ['accountsGet', 'transactionsSync'],
  savings:     ['accountsGet', 'transactionsSync'],
  investments: ['accountsGet', 'investmentsHoldingsGet'],
  retirement:  ['accountsGet', 'investmentsHoldingsGet'],
  debt:        ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
  taxes:       ['accountsGet', 'transactionsSync'],
  realestate:  ['accountsGet', 'transactionsSync', 'liabilitiesGet'],
};

// ─── Domain → Capabilities Mapping ──────────────────────────────────────────

const DOMAIN_CAPS: Record<string, string[]> = {
  checking:    ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData'],
  savings:     ['plaid.getBalances', 'plaid.getTransactions', 'plaid.syncData'],
  investments: ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData'],
  retirement:  ['plaid.getHoldings', 'plaid.getSecurities', 'plaid.getPortfolioSummary', 'plaid.syncData'],
  debt:        ['plaid.getLiabilities', 'plaid.getDebtSummary', 'plaid.getCreditUtilization', 'plaid.syncData'],
  realestate:  ['property.getPropertySummary', 'property.getMortgageDetails', 'property.getEquityAnalysis'],
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
    console.log(`[pendragon-plaid] Registered tools + capabilities for domain: ${config.domainType}`);
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
  const connectionsJson = process.env.RT_CONNECTIONS;
  if (!connectionsJson) return;

  try {
    const connections = JSON.parse(connectionsJson);
    const plaidConn = connections.find((c: Record<string, unknown>) => c.type === 'plaid');
    if (!plaidConn) return;

    const prefix = (plaidConn.envPrefix as string) || 'PLAID';
    const config: PlaidPluginConfig = {
      domainType: (process.env[`${prefix}_DOMAIN_TYPE`] || (plaidConn.domainType as string) || 'checking') as DomainType,
      accessToken: process.env[`${prefix}_ACCESS_TOKEN`] || '',
      clientId: process.env[`${prefix}_CLIENT_ID`] || process.env.PLAID_CLIENT_ID || '',
      secret: process.env[`${prefix}_PLAID_SECRET`] || process.env.PLAID_SECRET || '',
      env: (process.env[`${prefix}_PLAID_ENV`] || process.env.PLAID_ENV || 'sandbox') as 'sandbox' | 'production',
      itemId: process.env[`${prefix}_ITEM_ID`],
      databaseUrl: process.env.DATABASE_URL || '',
    };

    if (!config.accessToken || !config.clientId || !config.secret) {
      console.warn('[pendragon-plaid] Missing Plaid credentials, skipping registration');
      return;
    }

    pendragonPlaid.register(toolRegistry, capabilityRegistry, config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pendragon-plaid] Failed to parse RT_CONNECTIONS:', message);
  }
}
