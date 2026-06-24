// src/domains/autoGoals.ts — Auto-generate default goals when a domain has none.
// Called after sync completes. Each domain MUST have at least one goal.

import { withPool } from '../db/pool.js';
import type { DomainType, PlaidPluginConfig } from '../types.js';

// ─── Default Goal Templates (per domain type) ──────────────────────────────

interface GoalTemplate {
  goal_type: string;
  name: string;
  description: string;
  target_amount: number | null;
  target_date: string | null;
  monthly_contribution: number | null;
  parameters: Record<string, unknown>;
}

const DEFAULT_GOALS: Record<string, GoalTemplate[]> = {
  checking: [
    {
      goal_type: 'emergency_fund',
      name: 'Emergency Fund',
      description: 'Build an emergency reserve covering 3-6 months of expenses',
      target_amount: null, // Will be computed from observed expenses
      target_date: null,
      monthly_contribution: null,
      parameters: { months_coverage: 3, auto_generated: true },
    },
  ],
  savings: [
    {
      goal_type: 'savings_target',
      name: 'Savings Growth',
      description: 'Grow savings with consistent monthly contributions',
      target_amount: null,
      target_date: null,
      monthly_contribution: null,
      parameters: { auto_generated: true },
    },
  ],
  investments: [
    {
      goal_type: 'portfolio_growth',
      name: 'Portfolio Growth',
      description: 'Grow investment portfolio with 7% assumed annual returns',
      target_amount: null,
      target_date: null,
      monthly_contribution: null,
      parameters: { growth_rate: 0.07, auto_generated: true },
    },
  ],
  retirement: [
    {
      goal_type: 'retirement_readiness',
      name: 'Retirement Readiness',
      description: 'Track progress toward retirement savings goal',
      target_amount: null,
      target_date: null,
      monthly_contribution: null,
      parameters: { growth_rate: 0.07, auto_generated: true },
    },
  ],
  debt: [
    {
      goal_type: 'debt_payoff',
      name: 'Debt Payoff',
      description: 'Pay down outstanding debt balances',
      target_amount: 0,
      target_date: null,
      monthly_contribution: null,
      parameters: { strategy: 'avalanche', auto_generated: true },
    },
  ],
  taxes: [
    {
      goal_type: 'tax_reserve',
      name: 'Tax Reserve',
      description: 'Maintain adequate tax reserves for estimated payments',
      target_amount: null,
      target_date: null,
      monthly_contribution: null,
      parameters: { auto_generated: true },
    },
  ],
  realestate: [
    {
      goal_type: 'equity_growth',
      name: 'Equity Growth',
      description: 'Track home equity growth and mortgage paydown',
      target_amount: null,
      target_date: null,
      monthly_contribution: null,
      parameters: { auto_generated: true },
    },
  ],
};

// ─── Smart Target Computation ──────────────────────────────────────────────

async function computeSmartTarget(
  databaseUrl: string,
  domainType: DomainType,
  template: GoalTemplate,
): Promise<GoalTemplate> {
  const enriched = { ...template };

  return withPool(databaseUrl, async (pool) => {
    switch (domainType) {
      case 'checking':
      case 'savings': {
        // Emergency fund: 3 months of observed expenses
        try {
          const result = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_expenses,
                    COUNT(DISTINCT date_trunc('month', date)) as months
             FROM plaid_transactions
             WHERE date >= NOW() - INTERVAL '3 months' AND pending = false`,
          );
          const months = Math.max(parseFloat(result.rows[0].months) || 1, 1);
          const monthlyExpenses = parseFloat(result.rows[0].total_expenses) / months;
          const coverageMonths = (template.parameters.months_coverage as number) || 3;
          if (monthlyExpenses > 0) {
            enriched.target_amount = Math.round(monthlyExpenses * coverageMonths);
            enriched.description = `Build a ${coverageMonths}-month emergency reserve (~$${enriched.target_amount.toLocaleString()} based on your spending)`;
          }
        } catch { /* Use null target — evaluator will handle */ }
        break;
      }

      case 'debt': {
        // Debt payoff: target is always $0 total debt
        enriched.target_amount = 0;
        try {
          const result = await pool.query(
            `SELECT COALESCE(SUM(balance_current), 0) as total_debt FROM plaid_accounts`,
          );
          const totalDebt = Math.abs(parseFloat(result.rows[0].total_debt) || 0);
          if (totalDebt > 0) {
            enriched.description = `Pay off $${totalDebt.toLocaleString()} in outstanding debt`;
          }
        } catch { /* Use generic description */ }
        break;
      }

      case 'investments':
      case 'retirement': {
        // Growth: set target as 2x current value (stretch goal)
        try {
          const result = await pool.query(
            `SELECT COALESCE(SUM(institution_value), 0) as total_value FROM plaid_holdings`,
          );
          const currentValue = parseFloat(result.rows[0].total_value) || 0;
          if (currentValue > 0) {
            enriched.target_amount = Math.round(currentValue * 2);
            enriched.description = `Grow portfolio to $${enriched.target_amount.toLocaleString()} (2x current value)`;
          }
        } catch { /* Use null target */ }
        break;
      }

      // taxes and realestate use defaults
      default:
        break;
    }

    return enriched;
  });
}

// ─── Exported: Ensure domain has at least one goal ─────────────────────────

/**
 * Check if this domain has any goals. If not, auto-generate sensible defaults.
 * Called after sync completes. Each domain MUST have at least one goal.
 */
export async function ensureDefaultGoals(config: PlaidPluginConfig): Promise<void> {
  const { domainType, databaseUrl } = config;

  try {
    const hasGoals = await withPool(databaseUrl, async (pool) => {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM domain_goals WHERE status = 'active'`,
      );
      return parseInt(result.rows[0].count, 10) > 0;
    });

    if (hasGoals) {
      console.log(`[goals] ${domainType} already has active goals — skipping auto-generation`);
      return;
    }

    // Generate default goals for this domain type
    const templates = DEFAULT_GOALS[domainType] || DEFAULT_GOALS.checking;
    console.log(`[goals] ${domainType} has no goals — auto-generating ${templates.length} default(s)`);

    for (const template of templates) {
      // Enrich template with smart targets from observed data
      const enriched = await computeSmartTarget(databaseUrl, domainType, template);

      await withPool(databaseUrl, async (pool) => {
        const goalId = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await pool.query(
          `INSERT INTO domain_goals
             (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
          [
            goalId,
            enriched.goal_type,
            enriched.name,
            enriched.description,
            enriched.target_amount,
            enriched.target_date,
            enriched.monthly_contribution,
            JSON.stringify(enriched.parameters),
          ],
        );
        console.log(`[goals] Created auto-goal "${enriched.name}" (${goalId}) for ${domainType}`);
      });
    }
  } catch (err: any) {
    // Non-fatal — domain can still function without goals
    console.warn(`[goals] Auto-goal generation failed for ${domainType}: ${err.message}`);
  }
}
