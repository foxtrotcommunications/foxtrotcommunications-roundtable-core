// @ts-nocheck
// server/tools/getSpendingByMerchant.ts — Group spending by merchant with chart-ready output
import { query } from './utils/domainDb';
import type { Tool } from '../types';

const tool: Tool = {
  name: 'get_spending_by_merchant',
  description:
    'Aggregate spending from plaid_transactions grouped by merchant_name. ' +
    'Returns each merchant with total spent, transaction count, and average amount, ' +
    'plus chart-ready labels/values. Positive amounts = debits/spending. Defaults to top 10.',
  parameters: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Optional Plaid account ID to filter by',
      },
      start_date: {
        type: 'string',
        description: 'Optional start date (YYYY-MM-DD) inclusive',
      },
      end_date: {
        type: 'string',
        description: 'Optional end date (YYYY-MM-DD) inclusive',
      },
      top_n: {
        type: 'number',
        description: 'Number of top merchants to return (default: 10)',
      },
    },
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const { account_id, start_date, end_date, top_n = 10 } = args;

      const conditions: string[] = ['amount > 0'];
      const params: any[] = [];
      let idx = 1;

      if (account_id) {
        conditions.push(`account_id = $${idx++}`);
        params.push(account_id);
      }
      if (start_date) {
        conditions.push(`date >= $${idx++}`);
        params.push(start_date);
      }
      if (end_date) {
        conditions.push(`date <= $${idx++}`);
        params.push(end_date);
      }

      const whereClause = conditions.join(' AND ');
      params.push(top_n);

      const sql = `
        SELECT
          COALESCE(merchant_name, name, 'Unknown') AS merchant,
          SUM(amount)   AS total,
          COUNT(*)      AS count,
          AVG(amount)   AS avg_amount,
          MIN(date)     AS first_seen,
          MAX(date)     AS last_seen
        FROM plaid_transactions
        WHERE ${whereClause}
        GROUP BY COALESCE(merchant_name, name, 'Unknown')
        ORDER BY total DESC
        LIMIT $${idx}
      `;

      const result = await query(sql, params);

      // Also get the grand total (unfiltered by top_n) for context
      const totalSql = `
        SELECT SUM(amount) AS grand_total
        FROM plaid_transactions
        WHERE ${whereClause}
      `;
      // Use only the filter params (not the LIMIT param)
      const totalResult = await query(totalSql, params.slice(0, -1));
      const grandTotal = parseFloat(totalResult.rows[0]?.grand_total || '0');

      const merchants = result.rows.map((r: any) => ({
        merchant: r.merchant,
        total: parseFloat(parseFloat(r.total).toFixed(2)),
        count: parseInt(r.count, 10),
        avg_amount: parseFloat(parseFloat(r.avg_amount).toFixed(2)),
        pct_of_total:
          grandTotal > 0
            ? parseFloat(((parseFloat(r.total) / grandTotal) * 100).toFixed(1))
            : 0,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
      }));

      // Provenance metadata
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts');
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
      const transactionsScanned = merchants.reduce((sum: number, m: any) => sum + m.count, 0);

      return {
        merchants,
        grand_total: parseFloat(grandTotal.toFixed(2)),
        showing: merchants.length,
        chart: {
          labels: merchants.map((m: any) => m.merchant),
          values: merchants.map((m: any) => m.total),
        },
        filters: { account_id, start_date, end_date, top_n },
        metadata: {
          accounts_analyzed: accountsAnalyzed,
          transactions_scanned: transactionsScanned,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: err.message, executionMs: Date.now() - start };
    }
  },
};

export default tool;
