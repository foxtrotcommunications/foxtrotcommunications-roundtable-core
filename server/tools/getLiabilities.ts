// @ts-nocheck
// server/tools/getLiabilities.ts — Get all liabilities with account details
import { query } from './utils/domainDb';
import type { Tool } from '../types';

const tool: Tool = {
  name: 'get_liabilities',
  description:
    'Get all liabilities (credit cards, student loans, mortgages) with account details. ' +
    'Returns balances, interest rates, payment info, and next due dates. ' +
    'Optionally filter by liability type.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Optional. Filter by liability type.',
        enum: ['credit', 'student', 'mortgage'],
      },
    },
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const { type: liabilityType } = args;

      let sql: string;
      let params: any[];

      if (liabilityType) {
        sql = `
          SELECT l.liability_id, l.account_id, l.type, l.last_payment_amount,
                 l.last_payment_date, l.next_payment_due_date, l.minimum_payment_amount,
                 l.interest_rate, l.principal_balance, l.synced_at,
                 a.name AS account_name, a.mask, a.subtype,
                 a.balance_current, a.balance_limit
          FROM plaid_liabilities l
          LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
          WHERE l.type = $1
          ORDER BY l.principal_balance DESC NULLS LAST
        `;
        params = [liabilityType];
      } else {
        sql = `
          SELECT l.liability_id, l.account_id, l.type, l.last_payment_amount,
                 l.last_payment_date, l.next_payment_due_date, l.minimum_payment_amount,
                 l.interest_rate, l.principal_balance, l.synced_at,
                 a.name AS account_name, a.mask, a.subtype,
                 a.balance_current, a.balance_limit
          FROM plaid_liabilities l
          LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
          ORDER BY l.principal_balance DESC NULLS LAST
        `;
        params = [];
      }

      const result = await query(sql, params);

      const rows = result.rows.map((row: any) => ({
        liability_id: row.liability_id,
        account_id: row.account_id,
        type: row.type,
        account_name: row.account_name,
        mask: row.mask,
        subtype: row.subtype,
        last_payment_amount: row.last_payment_amount != null ? parseFloat(row.last_payment_amount) : null,
        last_payment_date: row.last_payment_date,
        next_payment_due_date: row.next_payment_due_date,
        minimum_payment_amount: row.minimum_payment_amount != null ? parseFloat(row.minimum_payment_amount) : null,
        interest_rate: row.interest_rate != null ? parseFloat(row.interest_rate) : null,
        principal_balance: row.principal_balance != null ? parseFloat(row.principal_balance) : null,
        balance_current: row.balance_current != null ? parseFloat(row.balance_current) : null,
        balance_limit: row.balance_limit != null ? parseFloat(row.balance_limit) : null,
        synced_at: row.synced_at ? new Date(row.synced_at).toISOString() : null,
      }));

      const metadata = {
        coverage: {
          tool: 'get_liabilities',
          accountsAnalyzed: rows.length,
          totalLiabilities: rows.length,
          types: [...new Set(rows.map((r: any) => r.type))],
          hasData: rows.length > 0,
          gaps: [] as string[],
        },
      };
      if (rows.length === 0) metadata.coverage.gaps.push('No liabilities found — Plaid may not support liabilities for this institution');

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [...metadata.coverage.gaps];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      return {
        liabilities: rows,
        total_liabilities: rows.length,
        filters: { type: liabilityType || null },
        metadata: {
          accounts_analyzed: rows.length,
        },
        coverage: {
          institutions_connected: connections.length,
          ...metadata.coverage,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Liabilities lookup failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
