// @ts-nocheck
// server/tools/getSpendingByCategory.ts — Group spending by category with chart-ready output
import { query, getWorkspaceId } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';
import { buildDomainFilter, hasDomainPolicy } from './utils/getDomainPolicy.js';

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
    const wsId = getWorkspaceId();
    try {
      const { account_id, start_date, end_date, top_n } = args;

      // Build parameterized query
      const conditions: string[] = ['t.workspace_id = $1', 't.amount > 0']; // positive = spending
      const params: any[] = [wsId];
      let idx = 2;

      if (account_id) {
        conditions.push(`t.account_id = $${idx++}`);
        params.push(account_id);
      }
      if (start_date) {
        conditions.push(`t.date >= $${idx++}`);
        params.push(start_date);
      }
      if (end_date) {
        conditions.push(`t.date <= $${idx++}`);
        params.push(end_date);
      }

      const domainFilter = buildDomainFilter(idx);
      if (domainFilter.clause) {
        params.push(...domainFilter.params);
      }

      const limitClause = top_n ? `LIMIT $${idx + domainFilter.params.length}` : '';
      if (top_n) params.push(top_n);

      const sql = `
        SELECT
          COALESCE(t.category, 'Uncategorized') AS category,
          SUM(t.amount)   AS total,
          COUNT(*)      AS count,
          AVG(t.amount)   AS avg_amount
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
        WHERE ${whereClause}
        GROUP BY COALESCE(t.category, 'Uncategorized')
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

      // Provenance metadata
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts WHERE workspace_id = $1', [wsId]);
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
      const transactionsScanned = categories.reduce((sum: number, c: any) => sum + c.count, 0);

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(true, true);

      return {
        provenance,
        categories,
        grand_total: parseFloat(grandTotal.toFixed(2)),
        category_count: categories.length,
        chart: {
          labels: categories.map((c: any) => c.category),
          values: categories.map((c: any) => c.total),
        },
        filters: { account_id, start_date, end_date, top_n },
        metadata: {
          accounts_analyzed: accountsAnalyzed,
          transactions_scanned: transactionsScanned,
        },
        coverage: {
          institutions_connected: connections.length,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: err.message, executionMs: Date.now() - start };
    }
  },
};

export default tool;
