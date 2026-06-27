// src/domains/checking.ts — Checking/savings domain module
// Contains sync logic, tools, and capabilities for transaction-based domains.
// Creates its own ScopedPlaidClient to enforce domain isolation.

import { ScopedPlaidClient } from '../plaid/client.js';
import { withPool } from '../db/pool.js';
import { getSchemaForDomain } from '../db/schemas.js';
import {
  syncAccounts,
  syncTransactions,
  createGetBalancesHandler,
  createGetTransactionsHandler,
} from './shared.js';
import type {
  PlaidPluginConfig,
  ToolRegistry,
  CapabilityRegistry,
} from '../types.js';

// ─── Sync Logic ─────────────────────────────────────────────────────────────

async function syncCheckingData(config: PlaidPluginConfig): Promise<Record<string, unknown>> {
  const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);

  return withPool(config.databaseUrl, async (pool) => {
    // 1. Create domain-scoped tables
    await pool.query(getSchemaForDomain(config.domainType));

    const summary: Record<string, unknown> = { success: true, domain: config.domainType };

    // 2. Sync accounts
    summary.accountsCount = await syncAccounts(plaid, pool, config.accessToken);

    // 3. Sync transactions (cursor-based incremental)
    const txnResult = await syncTransactions(plaid, pool, config.accessToken, config.itemId);
    summary.transactionsAdded = txnResult.added;
    summary.transactionsModified = txnResult.modified;
    summary.transactionsRemoved = txnResult.removed;

    return summary;
  });
}

// ─── Capability Handlers ────────────────────────────────────────────────────

function createSyncDataHandler(config: PlaidPluginConfig) {
  return async (_input: Record<string, unknown>, _ctx: unknown) => {
    return syncCheckingData(config);
  };
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerCheckingTools(registry: ToolRegistry, config: PlaidPluginConfig): void {
  registry.register('plaid_sync', {
    name: 'plaid_sync',
    description: `Sync Plaid ${config.domainType} data (accounts + transactions) to local database`,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      return syncCheckingData(config);
    },
  });
}

// ─── Capability Registration ────────────────────────────────────────────────

export function registerCheckingCapabilities(registry: CapabilityRegistry, config: PlaidPluginConfig): void {
  // 1. Get balances
  registry.register({
    name: 'plaid.getBalances',
    description: 'Get current account balances from local database',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        accounts: {
          type: 'array',
          description: 'Account records with balance fields',
        },
      },
    },
    handler: createGetBalancesHandler(config),
  });

  // 2. Get transactions
  registry.register({
    name: 'plaid.getTransactions',
    description: 'Get recent transactions with optional date and category filters',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        endDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        category: { type: 'string' },
        merchant: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        transactions: { type: 'array' },
        count: { type: 'number' },
      },
    },
    handler: createGetTransactionsHandler(config),
  });

  // 3. Sync data
  registry.register({
    name: 'plaid.syncData',
    description: 'Trigger a Plaid data sync to refresh account and transaction data',
    inputSchema: {
      type: 'object',
      properties: {
        syncType: {
          type: 'string',
          enum: ['all', 'accounts', 'transactions'],
        },
      },
      required: ['syncType'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        domain: { type: 'string' },
        accountsCount: { type: 'number' },
        transactionsAdded: { type: 'number' },
      },
    },
    handler: createSyncDataHandler(config),
  });
}
