// @ts-nocheck
// server/tools/getDebtSummary.ts — Aggregate debt overview across all liabilities
import { query } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';

const tool: Tool = {
  name: 'get_debt_summary',
  description:
    'Get an aggregated debt overview: total debt, minimum payments, average interest rate, ' +
    'highest rate, next payment date, and a breakdown by liability type (credit, student, mortgage).',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      // Total summary
      const summarySql = `
        SELECT
          COUNT(*) as total_accounts,
          COALESCE(SUM(a.balance_current), 0) as total_debt,
          COALESCE(SUM(l.minimum_payment_amount), 0) as total_minimum_payments,
          COALESCE(AVG(l.interest_rate), 0) as avg_interest_rate,
          MAX(l.interest_rate) as highest_rate,
          MIN(l.next_payment_due_date) as next_payment_date
        FROM plaid_liabilities l
        LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
      `;
      const summaryResult = await query(summarySql);
      const s = summaryResult.rows[0] || {};

      const summary = {
        total_accounts: parseInt(s.total_accounts || '0', 10),
        total_debt: parseFloat(parseFloat(s.total_debt || '0').toFixed(2)),
        total_minimum_payments: parseFloat(parseFloat(s.total_minimum_payments || '0').toFixed(2)),
        avg_interest_rate: parseFloat(parseFloat(s.avg_interest_rate || '0').toFixed(2)),
        highest_rate: s.highest_rate != null ? parseFloat(s.highest_rate) : null,
        next_payment_date: s.next_payment_date || null,
      };

      // Breakdown by type
      const breakdownSql = `
        SELECT l.type,
          COUNT(*) as count,
          COALESCE(SUM(a.balance_current), 0) as total_balance,
          COALESCE(AVG(l.interest_rate), 0) as avg_rate
        FROM plaid_liabilities l
        LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
        GROUP BY l.type
        ORDER BY total_balance DESC
      `;
      const breakdownResult = await query(breakdownSql);
      const breakdown = breakdownResult.rows.map((r: any) => ({
        type: r.type,
        count: parseInt(r.count || '0', 10),
        total_balance: parseFloat(parseFloat(r.total_balance || '0').toFixed(2)),
        avg_rate: parseFloat(parseFloat(r.avg_rate || '0').toFixed(2)),
      }));

      const metadata = {
        coverage: {
          tool: 'get_debt_summary',
          accountsAnalyzed: summary.total_accounts,
          totalLiabilities: summary.total_accounts,
          types: breakdown.map((b: any) => b.type),
          hasData: summary.total_accounts > 0,
          gaps: [] as string[],
        },
      };
      if (summary.total_accounts === 0) metadata.coverage.gaps.push('No liabilities found — Plaid may not support liabilities for this institution');

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [...metadata.coverage.gaps];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(false, false);

      return {
        provenance,
        summary,
        breakdown,
        chart: {
          labels: breakdown.map((b: any) => b.type),
          values: breakdown.map((b: any) => b.total_balance),
        },
        metadata: {
          accounts_analyzed: summary.total_accounts,
        },
        coverage: {
          institutions_connected: connections.length,
          ...metadata.coverage,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Debt summary failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
