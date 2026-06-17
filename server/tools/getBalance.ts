// @ts-nocheck
// server/tools/getBalance.ts — Get current balance for one or all accounts
import { query } from './utils/domainDb';
import type { Tool } from '../types';

const tool: Tool = {
  name: 'get_balance',
  description:
    'Get the current balance for a specific account or all accounts. Returns available, current, and limit balances with last sync time for freshness.',
  parameters: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Optional. Specific account ID to query. Omit to get all account balances.',
      },
    },
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const { account_id } = args;

      let sql: string;
      let params: any[];

      if (account_id) {
        sql = `
          SELECT
            account_id, name, mask, type, subtype,
            balance_available, balance_current, balance_limit,
            currency, synced_at
          FROM plaid_accounts
          WHERE account_id = $1
        `;
        params = [account_id];
      } else {
        sql = `
          SELECT
            account_id, name, mask, type, subtype,
            balance_available, balance_current, balance_limit,
            currency, synced_at
          FROM plaid_accounts
          ORDER BY type, name
        `;
        params = [];
      }

      const result = await query(sql, params);

      if (account_id && result.rows.length === 0) {
        return { error: `Account not found: ${account_id}`, executionMs: Date.now() - start };
      }

      const balances = result.rows.map((row: any) => ({
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

      // Compute totals across returned accounts
      const totalCurrent = balances.reduce((sum: number, b: any) => sum + (b.balance_current || 0), 0);
      const totalAvailable = balances.reduce((sum: number, b: any) => sum + (b.balance_available || 0), 0);

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      return {
        balances: account_id ? balances[0] : balances,
        ...(account_id ? {} : {
          total_current: totalCurrent,
          total_available: totalAvailable,
          accounts_count: balances.length,
        }),
        metadata: {
          accounts_analyzed: balances.length,
        },
        coverage: {
          institutions_connected: connections.length,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Balance lookup failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
