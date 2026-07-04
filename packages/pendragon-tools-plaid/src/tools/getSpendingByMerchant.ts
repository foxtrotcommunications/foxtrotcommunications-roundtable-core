// @ts-nocheck
// server/tools/getSpendingByMerchant.ts — Group spending by merchant with chart-ready output
import { query, getWorkspaceId } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';
import { buildDomainFilter, hasDomainPolicy } from './utils/getDomainPolicy.js';

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
    const wsId = getWorkspaceId();
    try {
      const { account_id, start_date, end_date, top_n = 10 } = args;

      const conditions: string[] = ['t.workspace_id = $1', 't.amount > 0'];
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

      const whereClause = conditions.join(' AND ');

      // Domain filter for account type isolation
      const domainFilter = buildDomainFilter(idx);
      if (domainFilter.clause) {
        params.push(...domainFilter.params);
      }
      params.push(top_n);

      const sql = `
        SELECT
          COALESCE(t.merchant_name, t.name, 'Unknown') AS merchant,
          SUM(t.amount)   AS total,
          COUNT(*)      AS count,
          AVG(t.amount)   AS avg_amount,
          MIN(t.date)     AS first_seen,
          MAX(t.date)     AS last_seen
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
        WHERE ${whereClause}
        GROUP BY COALESCE(t.merchant_name, t.name, 'Unknown')
        ORDER BY total DESC
        LIMIT $${idx + domainFilter.params.length}
      `;

      const result = await query(sql, params);

      // Also get the grand total (unfiltered by top_n) for context
      const totalSql = `
        SELECT SUM(t.amount) AS grand_total
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
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
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts WHERE workspace_id = $1', [wsId]);
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
      const transactionsScanned = merchants.reduce((sum: number, m: any) => sum + m.count, 0);

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(true, true);

      return {
        provenance,
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
