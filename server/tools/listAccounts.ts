// @ts-nocheck
// server/tools/listAccounts.ts — List all linked financial accounts with balances
import { query } from './utils/domainDb';
import type { Tool } from '../types';

const tool: Tool = {
  name: 'list_accounts',
  description:
    'List all linked financial accounts. Returns account name, type, subtype, mask, balances (available, current, limit), currency, and last sync time. No parameters required.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const sql = `
        SELECT
          account_id,
          name,
          mask,
          type,
          subtype,
          balance_available,
          balance_current,
          balance_limit,
          currency,
          synced_at
        FROM plaid_accounts
        ORDER BY type, name
      `;

      const result = await query(sql);

      const accounts = result.rows.map((row: any) => ({
        account_id: row.account_id,
        name: row.name,
        mask: row.mask,
        type: row.type,
        subtype: row.subtype,
        balance_available: row.balance_available != null ? parseFloat(row.balance_available) : null,
        balance_current: row.balance_current != null ? parseFloat(row.balance_current) : null,
        balance_limit: row.balance_limit != null ? parseFloat(row.balance_limit) : null,
        currency: row.currency,
        synced_at: row.synced_at ? new Date(row.synced_at).toISOString() : null,
      }));

      return {
        accounts,
        total_accounts: accounts.length,
        metadata: {
          accounts_analyzed: accounts.length,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Failed to list accounts: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
