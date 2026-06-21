// @ts-nocheck
// server/tools/getCashflow.ts — Cashflow analysis over time (daily/weekly/monthly)
import { query } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';

const tool: Tool = {
  name: 'get_cashflow',
  description:
    'Compute cashflow over time from plaid_transactions. For each period (daily/weekly/monthly): ' +
    'income = abs(sum of negative amounts), spending = sum of positive amounts, net = income - spending. ' +
    'Returns periods array and multi-series chart-ready data.',
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
      granularity: {
        type: 'string',
        description: 'Time granularity: daily, weekly, or monthly (default: monthly)',
        enum: ['daily', 'weekly', 'monthly'],
      },
    },
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const { account_id, start_date, end_date, granularity = 'monthly' } = args;

      const conditions: string[] = [];
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

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      // Build the date-truncation expression based on granularity
      let dateTrunc: string;
      switch (granularity) {
        case 'daily':
          dateTrunc = "TO_CHAR(date, 'YYYY-MM-DD')";
          break;
        case 'weekly':
          dateTrunc = "TO_CHAR(DATE_TRUNC('week', date), 'YYYY-MM-DD')";
          break;
        case 'monthly':
        default:
          dateTrunc = "TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM')";
          break;
      }

      const sql = `
        SELECT
          ${dateTrunc} AS period,
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS spending,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS income
        FROM plaid_transactions
        ${whereClause}
        GROUP BY ${dateTrunc}
        ORDER BY period
      `;

      const result = await query(sql, params);

      let totalIncome = 0;
      let totalSpending = 0;

      const periods = result.rows.map((r: any) => {
        const income = parseFloat(parseFloat(r.income).toFixed(2));
        const spending = parseFloat(parseFloat(r.spending).toFixed(2));
        const net = parseFloat((income - spending).toFixed(2));
        totalIncome += income;
        totalSpending += spending;
        return {
          period: r.period,
          income,
          spending,
          net,
        };
      });

      totalIncome = parseFloat(totalIncome.toFixed(2));
      totalSpending = parseFloat(totalSpending.toFixed(2));
      const totalNet = parseFloat((totalIncome - totalSpending).toFixed(2));

      // Provenance metadata
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts');
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
      const txnCountSql = `SELECT COUNT(*)::int AS cnt FROM plaid_transactions ${whereClause}`;
      const txnCountResult = await query(txnCountSql, params);
      const transactionsScanned = txnCountResult.rows[0]?.cnt || 0;

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');
      coverageGaps.push('Income reflects only visible credit transactions');

      const provenance = await buildProvenance(true, true);

      return {
        provenance,
        periods,
        summary: {
          total_income: totalIncome,
          total_spending: totalSpending,
          total_net: totalNet,
          period_count: periods.length,
          avg_monthly_net:
            granularity === 'monthly' && periods.length > 0
              ? parseFloat((totalNet / periods.length).toFixed(2))
              : null,
        },
        chart: {
          labels: periods.map((p: any) => p.period),
          income_values: periods.map((p: any) => p.income),
          spending_values: periods.map((p: any) => p.spending),
          net_values: periods.map((p: any) => p.net),
        },
        granularity,
        filters: { account_id, start_date, end_date },
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
