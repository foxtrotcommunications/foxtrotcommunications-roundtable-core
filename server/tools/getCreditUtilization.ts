// @ts-nocheck
// server/tools/getCreditUtilization.ts — Per-card and overall credit utilization
import { query } from './utils/domainDb';
import type { Tool } from '../types';
import { buildProvenance } from './utils/buildProvenance';

const tool: Tool = {
  name: 'get_credit_utilization',
  description:
    'Calculate credit utilization per card and overall. Returns each credit account with ' +
    'balance, limit, and utilization percentage. Also computes the overall utilization ratio ' +
    'across all credit accounts.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const sql = `
        SELECT a.account_id, a.name, a.mask,
               COALESCE(a.balance_current, 0) as balance,
               COALESCE(a.balance_limit, 0) as credit_limit,
               CASE WHEN COALESCE(a.balance_limit, 0) > 0
                 THEN ROUND((COALESCE(a.balance_current, 0) / a.balance_limit * 100)::numeric, 1)
                 ELSE 0
               END as utilization_pct
        FROM plaid_accounts a
        WHERE a.type = 'credit'
        ORDER BY utilization_pct DESC
      `;

      const result = await query(sql);

      const cards = result.rows.map((row: any) => ({
        account_id: row.account_id,
        name: row.name,
        mask: row.mask,
        balance: parseFloat(parseFloat(row.balance).toFixed(2)),
        credit_limit: parseFloat(parseFloat(row.credit_limit).toFixed(2)),
        utilization_pct: parseFloat(parseFloat(row.utilization_pct).toFixed(1)),
      }));

      // Compute overall utilization
      const totalBalance = cards.reduce((sum: number, c: any) => sum + c.balance, 0);
      const totalLimit = cards.reduce((sum: number, c: any) => sum + c.credit_limit, 0);
      const overallUtilization = totalLimit > 0
        ? parseFloat((totalBalance / totalLimit * 100).toFixed(1))
        : 0;

      const metadata = {
        coverage: {
          tool: 'get_credit_utilization',
          accountsAnalyzed: cards.length,
          totalLiabilities: cards.length,
          types: ['credit'],
          hasData: cards.length > 0,
          gaps: [] as string[],
        },
      };
      if (cards.length === 0) metadata.coverage.gaps.push('No credit accounts found — user may not have linked credit cards');

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [...metadata.coverage.gaps];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(false, false);

      return {
        provenance,
        cards,
        overall: {
          total_balance: parseFloat(totalBalance.toFixed(2)),
          total_limit: parseFloat(totalLimit.toFixed(2)),
          utilization_pct: overallUtilization,
        },
        accounts_count: cards.length,
        chart: {
          labels: cards.map((c: any) => c.name || `****${c.mask}`),
          values: cards.map((c: any) => c.utilization_pct),
        },
        metadata: {
          accounts_analyzed: cards.length,
        },
        coverage: {
          institutions_connected: connections.length,
          ...metadata.coverage,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Credit utilization lookup failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
