// @ts-nocheck
// server/tools/getIncomeSummary.ts — Summarize income from plaid_transactions
// Plaid convention: negative amount = credit/income
import { query, getWorkspaceId } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';
import { buildDomainFilter, hasDomainPolicy } from './utils/getDomainPolicy.js';

const tool: Tool = {
  name: 'get_income_summary',
  description:
    'Summarize income from plaid_transactions. Filters for negative amounts (Plaid convention: ' +
    'negative = credit/income). Returns individual deposits, total income as a positive number, ' +
    'and average monthly income computed over the date range.',
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
    },
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    const wsId = getWorkspaceId();
    try {
      const { account_id, start_date, end_date } = args;

      const conditions: string[] = ['t.workspace_id = $1', 't.amount < 0']; // negative = income
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

      // Get individual deposits
      const depositsSql = `
        SELECT
          t.transaction_id,
          t.account_id,
          ABS(t.amount) AS amount,
          t.date,
          COALESCE(t.merchant_name, t.name) AS source,
          t.category,
          t.payment_channel
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
        WHERE ${whereClause}
        ORDER BY t.date DESC
      `;
      const depositsResult = await query(depositsSql, params);

      // Get aggregate stats
      const statsSql = `
        SELECT
          SUM(ABS(t.amount))          AS total_income,
          COUNT(*)                  AS deposit_count,
          AVG(ABS(t.amount))          AS avg_deposit,
          MIN(t.date)                 AS earliest_date,
          MAX(t.date)                 AS latest_date
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
        WHERE ${whereClause}
      `;
      const statsResult = await query(statsSql, params);
      const stats = statsResult.rows[0] || {};

      const totalIncome = parseFloat(stats.total_income || '0');
      const earliestDate = stats.earliest_date;
      const latestDate = stats.latest_date;

      // Calculate number of months spanned for avg monthly income
      let monthsSpanned = 1;
      if (earliestDate && latestDate) {
        const d1 = new Date(earliestDate);
        const d2 = new Date(latestDate);
        monthsSpanned = Math.max(
          1,
          (d2.getFullYear() - d1.getFullYear()) * 12 +
            (d2.getMonth() - d1.getMonth()) +
            1,
        );
      }

      // Group income by source for chart
      const bySourceSql = `
        SELECT
          COALESCE(t.merchant_name, t.name, 'Unknown') AS source,
          SUM(ABS(t.amount)) AS total
        FROM plaid_transactions t
        JOIN plaid_accounts a ON t.account_id = a.account_id AND a.workspace_id = t.workspace_id
          ${domainFilter.clause}
        WHERE ${whereClause}
        GROUP BY COALESCE(t.merchant_name, t.name, 'Unknown')
        ORDER BY total DESC
      `;
      const bySourceResult = await query(bySourceSql, params);
      const sources = bySourceResult.rows.map((r: any) => ({
        source: r.source,
        total: parseFloat(parseFloat(r.total).toFixed(2)),
      }));

      // Provenance metadata
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts WHERE workspace_id = $1', [wsId]);
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;

      const deposits = depositsResult.rows.map((r: any) => ({
        transaction_id: r.transaction_id,
        account_id: r.account_id,
        amount: parseFloat(parseFloat(r.amount).toFixed(2)),
        date: r.date,
        source: r.source,
        category: r.category,
        payment_channel: r.payment_channel,
      }));

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');
      coverageGaps.push('Income reflects only visible credit transactions');

      const provenance = await buildProvenance(true, true);

      return {
        provenance,
        deposits,
        total_income: parseFloat(totalIncome.toFixed(2)),
        deposit_count: parseInt(stats.deposit_count || '0', 10),
        avg_deposit: parseFloat(parseFloat(stats.avg_deposit || '0').toFixed(2)),
        avg_monthly_income: parseFloat((totalIncome / monthsSpanned).toFixed(2)),
        months_spanned: monthsSpanned,
        date_range: { earliest: earliestDate, latest: latestDate },
        income_by_source: sources,
        chart: {
          labels: sources.map((s: any) => s.source),
          values: sources.map((s: any) => s.total),
        },
        filters: { account_id, start_date, end_date },
        metadata: {
          accounts_analyzed: accountsAnalyzed,
          transactions_scanned: parseInt(stats.deposit_count || '0', 10),
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
