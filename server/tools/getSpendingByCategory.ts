// @ts-nocheck
// server/tools/getSpendingByCategory.ts — Group spending by category with chart-ready output
import { query } from './utils/domainDb';
import type { Tool } from '../types';

const tool: Tool = {
  name: 'get_spending_by_category',
  description:
    'Aggregate spending from plaid_transactions grouped by category. ' +
    'Returns each category with total, count, average, and percentage of total spend, ' +
    'plus chart-ready labels/values arrays. Positive amounts = debits/spending.',
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
        description: 'Optional number of top categories to return (default: all)',
      },
    },
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const { account_id, start_date, end_date, top_n } = args;

      // Build parameterized query
      const conditions: string[] = ['amount > 0']; // positive = spending
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
      const limitClause = top_n ? `LIMIT $${idx++}` : '';
      if (top_n) params.push(top_n);

      const sql = `
        SELECT
          COALESCE(category, 'Uncategorized') AS category,
          SUM(amount)   AS total,
          COUNT(*)      AS count,
          AVG(amount)   AS avg_amount
        FROM plaid_transactions
        WHERE ${whereClause}
        GROUP BY COALESCE(category, 'Uncategorized')
        ORDER BY total DESC
        ${limitClause}
      `;

      const result = await query(sql, params);

      // Calculate grand total for percentage computation
      const grandTotal = result.rows.reduce(
        (sum: number, r: any) => sum + parseFloat(r.total),
        0,
      );

      const categories = result.rows.map((r: any) => ({
        category: r.category,
        total: parseFloat(parseFloat(r.total).toFixed(2)),
        count: parseInt(r.count, 10),
        avg_amount: parseFloat(parseFloat(r.avg_amount).toFixed(2)),
        pct_of_total:
          grandTotal > 0
            ? parseFloat(((parseFloat(r.total) / grandTotal) * 100).toFixed(1))
            : 0,
      }));

      return {
        categories,
        grand_total: parseFloat(grandTotal.toFixed(2)),
        category_count: categories.length,
        chart: {
          labels: categories.map((c: any) => c.category),
          values: categories.map((c: any) => c.total),
        },
        filters: { account_id, start_date, end_date, top_n },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: err.message, executionMs: Date.now() - start };
    }
  },
};

export default tool;
