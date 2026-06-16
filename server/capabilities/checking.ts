// DEPRECATED: This file has been replaced by @pendragon/tools-plaid
// It will be removed in a future release.
// server/capabilities/checking.ts — ICE capabilities for checking/savings domains
// Exposes plaid.getBalances, plaid.getTransactions, plaid.syncData as typed
// workspace capabilities backed by the local plaid_* tables.

import pg from 'pg';
import type { CapabilityRegistry, CapabilityHandler } from '../protocols/capabilityRegistry.js';

const { Pool } = pg;

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: databaseUrl });
}

// ─── plaid.getBalances ──────────────────────────────────────────────────────

const getBalancesHandler: CapabilityHandler = async (_input, _ctx) => {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT account_id, name, type, subtype,
              balance_available, balance_current, balance_limit,
              currency, synced_at
       FROM plaid_accounts
       ORDER BY name`,
    );
    return { accounts: rows };
  } finally {
    await pool.end();
  }
};

// ─── plaid.getTransactions ──────────────────────────────────────────────────

const getTransactionsHandler: CapabilityHandler = async (input, _ctx) => {
  const pool = createPool();
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (input.startDate) {
      conditions.push(`date >= $${paramIdx++}`);
      params.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`date <= $${paramIdx++}`);
      params.push(input.endDate);
    }
    if (input.category) {
      conditions.push(`category ILIKE $${paramIdx++}`);
      params.push(`%${input.category}%`);
    }
    if (input.merchant) {
      conditions.push(`merchant_name ILIKE $${paramIdx++}`);
      params.push(`%${input.merchant}%`);
    }

    const limit = typeof input.limit === 'number' && input.limit > 0
      ? Math.min(input.limit, 500)
      : 50;

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const sql = `SELECT transaction_id, account_id, amount, date, name,
                        merchant_name, category, payment_channel, pending, synced_at
                 FROM plaid_transactions
                 ${whereClause}
                 ORDER BY date DESC
                 LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    return { transactions: rows, count: rows.length };
  } finally {
    await pool.end();
  }
};

// ─── plaid.syncData ─────────────────────────────────────────────────────────

const syncDataHandler: CapabilityHandler = async (input, ctx) => {
  const syncType = (input.syncType as string) || 'all';

  // Prefer the execution context's tool executor if available
  if (ctx.executionCtx && typeof (ctx.executionCtx as any).executeTool === 'function') {
    return await (ctx.executionCtx as any).executeTool('plaid_sync', { syncType });
  }

  // Fallback: import and execute the plaid_sync tool directly
  const { default: plaidSyncTool } = await import('../tools/plaidSync.js');
  return await plaidSyncTool.execute({ syncType });
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerCheckingCapabilities(registry: CapabilityRegistry): void {
  // 1. Get balances
  registry.register(
    {
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
    },
    getBalancesHandler,
  );

  // 2. Get transactions
  registry.register(
    {
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
    },
    getTransactionsHandler,
  );

  // 3. Sync data
  registry.register(
    {
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
          synced: { type: 'string' },
          accountsCount: { type: 'number' },
          transactionsCount: { type: 'number' },
        },
      },
    },
    syncDataHandler,
  );
}
