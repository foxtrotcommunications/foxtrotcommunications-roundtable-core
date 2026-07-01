// @ts-nocheck
// server/tools/getPayoffProjection.ts — Snowball vs avalanche payoff projections
import { query, getWorkspaceId } from './utils/domainDb.js';
import type { Tool } from '../../types.js';
import { buildProvenance } from './utils/buildProvenance.js';

interface Debt {
  account_id: string;
  name: string;
  type: string;
  balance: number;
  interest_rate: number;
  minimum_payment: number;
}

interface PayoffResult {
  total_months: number;
  total_interest_paid: number;
  order: { account_id: string; name: string; months_to_payoff: number; interest_paid: number }[];
}

/**
 * Simulate payoff for an ordered list of debts.
 * Freed-up minimums from paid-off debts roll into the next debt.
 */
function simulatePayoff(debts: Debt[]): PayoffResult {
  if (debts.length === 0) {
    return { total_months: 0, total_interest_paid: 0, order: [] };
  }

  // Clone debts to avoid mutating originals
  const working = debts.map(d => ({
    ...d,
    remaining: d.balance,
    interestAccrued: 0,
    paidOffMonth: 0,
  }));

  let extraPayment = 0; // freed-up minimums from paid debts
  let totalInterest = 0;
  let totalMonths = 0;
  const maxMonths = 360;
  const order: PayoffResult['order'] = [];

  for (let month = 1; month <= maxMonths; month++) {
    let allPaid = true;

    for (const debt of working) {
      if (debt.remaining <= 0) continue;
      allPaid = false;

      // Monthly interest
      const monthlyRate = (debt.interest_rate / 100) / 12;
      const interest = debt.remaining * monthlyRate;
      debt.remaining += interest;
      debt.interestAccrued += interest;
      totalInterest += interest;

      // Payment: minimum + any extra from paid-off debts (only for first unpaid debt)
      let payment = debt.minimum_payment;
      if (debt === working.find(d => d.remaining > 0)) {
        payment += extraPayment;
      }

      // Ensure payment doesn't exceed remaining balance
      payment = Math.min(payment, debt.remaining);
      debt.remaining -= payment;

      // Check if paid off
      if (debt.remaining <= 0.01) {
        debt.remaining = 0;
        debt.paidOffMonth = month;
        extraPayment += debt.minimum_payment;
        order.push({
          account_id: debt.account_id,
          name: debt.name,
          months_to_payoff: month,
          interest_paid: parseFloat(debt.interestAccrued.toFixed(2)),
        });
      }
    }

    totalMonths = month;
    if (allPaid) break;
  }

  return {
    total_months: totalMonths,
    total_interest_paid: parseFloat(totalInterest.toFixed(2)),
    order,
  };
}

const tool: Tool = {
  name: 'get_payoff_projection',
  description:
    'Calculate debt payoff projections using snowball (lowest balance first) and avalanche ' +
    '(highest interest rate first) methods. Returns total months to debt-free, total interest ' +
    'paid, and the order debts are paid off for each strategy.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    const wsId = getWorkspaceId();
    try {
      const sql = `
        SELECT l.account_id, l.type, l.interest_rate, l.minimum_payment_amount,
               a.name, a.balance_current
        FROM plaid_liabilities l
        LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
        WHERE a.balance_current > 0
          AND l.workspace_id = $1
        ORDER BY a.balance_current ASC
      `;

      const result = await query(sql, [wsId]);

      const debts: Debt[] = result.rows.map((row: any) => ({
        account_id: row.account_id,
        name: row.name || 'Unknown Account',
        type: row.type,
        balance: parseFloat(row.balance_current || '0'),
        interest_rate: parseFloat(row.interest_rate || '0'),
        minimum_payment: parseFloat(row.minimum_payment_amount || '0'),
      }));

      // Snowball: sort by balance ascending (already sorted from query)
      const snowballDebts = [...debts].sort((a, b) => a.balance - b.balance);
      const snowball = simulatePayoff(snowballDebts);

      // Avalanche: sort by interest rate descending
      const avalancheDebts = [...debts].sort((a, b) => b.interest_rate - a.interest_rate);
      const avalanche = simulatePayoff(avalancheDebts);

      // Interest savings
      const interestSaved = parseFloat((snowball.total_interest_paid - avalanche.total_interest_paid).toFixed(2));

      const metadata = {
        coverage: {
          tool: 'get_payoff_projection',
          accountsAnalyzed: debts.length,
          totalLiabilities: debts.length,
          types: [...new Set(debts.map(d => d.type))],
          hasData: debts.length > 0,
          gaps: [] as string[],
        },
      };
      if (debts.length === 0) metadata.coverage.gaps.push('No active liabilities with balances found');

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [...metadata.coverage.gaps];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(false, false);

      return {
        provenance,
        debts: debts.map(d => ({
          account_id: d.account_id,
          name: d.name,
          type: d.type,
          balance: parseFloat(d.balance.toFixed(2)),
          interest_rate: d.interest_rate,
          minimum_payment: parseFloat(d.minimum_payment.toFixed(2)),
        })),
        snowball: {
          method: 'snowball',
          description: 'Pay off smallest balance first, roll freed minimums into next debt',
          ...snowball,
        },
        avalanche: {
          method: 'avalanche',
          description: 'Pay off highest interest rate first, roll freed minimums into next debt',
          ...avalanche,
        },
        comparison: {
          avalanche_saves_interest: interestSaved > 0 ? interestSaved : 0,
          snowball_saves_interest: interestSaved < 0 ? Math.abs(interestSaved) : 0,
          recommended: interestSaved > 0 ? 'avalanche' : 'snowball',
        },
        metadata: {
          accounts_analyzed: debts.length,
        },
        coverage: {
          institutions_connected: connections.length,
          ...metadata.coverage,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Payoff projection failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
