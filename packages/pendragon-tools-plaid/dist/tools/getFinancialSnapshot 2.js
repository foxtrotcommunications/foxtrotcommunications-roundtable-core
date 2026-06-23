// @ts-nocheck
// server/tools/getFinancialSnapshot.ts — Complete financial summary in a single call
// Combines account balances + 30-day transaction analysis into one response
import { query } from './utils/domainDb.js';
import { buildProvenance } from './utils/buildProvenance.js';
const tool = {
    name: 'get_financial_snapshot',
    description: 'Get a complete financial snapshot in one call. Returns total accounts, balances by type, monthly income/spending/cashflow (last 30 days), top 5 spending categories with percentages, data freshness, and metadata. No parameters required.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    async execute(_args, _workspaceConfig = {}) {
        const start = Date.now();
        try {
            const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
            if (wsName.includes('realestate') || wsName.includes('property')) {
                const propResult = await query('SELECT COUNT(*)::int AS cnt, COALESCE(SUM(current_value), 0) AS val FROM properties');
                const mortResult = await query('SELECT COUNT(*)::int AS cnt, COALESCE(SUM(current_balance), 0) AS bal FROM mortgages');
                const propertyVal = parseFloat(propResult.rows[0]?.val) || 0;
                const mortgageBal = parseFloat(mortResult.rows[0]?.bal) || 0;
                const totalAccounts = (propResult.rows[0]?.cnt || 0) + (mortResult.rows[0]?.cnt || 0);
                const provenance = await buildProvenance(true, true);
                return {
                    provenance,
                    summary: {
                        total_accounts: totalAccounts,
                        total_balance: propertyVal - mortgageBal, // Net equity
                        balance_by_type: {
                            property: propertyVal,
                            mortgage: -mortgageBal
                        },
                    },
                    monthly: {
                        period: 'last 30 days',
                        income: 0,
                        spending: 0,
                        net_cashflow: 0,
                        top_spending_categories: [],
                    },
                    metadata: {
                        last_sync: new Date().toISOString(),
                        data_freshness: 'just now',
                        accounts_analyzed: totalAccounts,
                        transactions_scanned: 0,
                    },
                    coverage: {
                        institutions_connected: 1,
                        accounts_visible: totalAccounts,
                        has_payroll_pattern: false,
                        income_sources_identified: 0,
                        unclassified_large_charges: 0,
                        explanation_pct: 100,
                        visible: ['Property equity', 'Mortgage balances'],
                        gaps: ['No transaction data in real estate domain'],
                    },
                    executionMs: Date.now() - start,
                };
            }
            // ── 1. Account aggregation ──────────────────────────────────
            const accountsSql = `
        SELECT
          (SELECT COUNT(*)::int FROM plaid_accounts) AS total_accounts,
          (SELECT COALESCE(SUM(balance_current), 0) FROM plaid_accounts) AS total_balance,
          (SELECT MAX(synced_at) FROM plaid_accounts) AS last_sync,
          COALESCE(
            (SELECT json_object_agg(COALESCE(type, 'unknown'), type_bal)
             FROM (SELECT type, SUM(balance_current) AS type_bal FROM plaid_accounts GROUP BY type) t),
            '{}'::json
          ) AS balance_by_type
      `;
            // ── 2. 30-day transaction analysis ──────────────────────────
            const txnSql = `
        WITH last30 AS (
          SELECT amount, category, name, merchant_name
          FROM plaid_transactions
          WHERE date >= CURRENT_DATE - INTERVAL '30 days'
            AND pending = false
        ),
        spending AS (
          SELECT
            COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)  AS total_spending,
            COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS total_income,
            COUNT(*)::int AS transactions_scanned
          FROM last30
        ),
        top_cats AS (
          SELECT
            COALESCE(category, 'Uncategorized') AS category,
            SUM(amount) AS cat_total
          FROM last30
          WHERE amount > 0
          GROUP BY category
          ORDER BY cat_total DESC
          LIMIT 5
        )
        SELECT
          s.total_spending,
          s.total_income,
          s.total_income - s.total_spending AS net_cashflow,
          s.transactions_scanned,
          COALESCE(
            json_agg(
              json_build_object(
                'category', tc.category,
                'amount', tc.cat_total,
                'percentage', CASE WHEN s.total_spending > 0
                  THEN ROUND((tc.cat_total / s.total_spending * 100)::numeric, 1)
                  ELSE 0 END
              )
            ) FILTER (WHERE tc.category IS NOT NULL),
            '[]'::json
          ) AS top_categories
        FROM spending s
        LEFT JOIN top_cats tc ON true
        GROUP BY s.total_spending, s.total_income, s.transactions_scanned
      `;
            // Run both queries concurrently
            const [acctResult, txnResult] = await Promise.all([
                query(accountsSql),
                query(txnSql),
            ]);
            // ── Parse account data ──────────────────────────────────────
            // The aggregation query may return unexpected shape if there are no accounts,
            // so we also run a simpler fallback.
            let totalAccounts = 0;
            let totalBalance = 0;
            let balanceByType = {};
            let lastSync = null;
            if (acctResult.rows.length > 0) {
                const row = acctResult.rows[0];
                totalAccounts = row.total_accounts || 0;
                totalBalance = parseFloat(row.total_balance) || 0;
                balanceByType = row.balance_by_type || {};
                lastSync = row.last_sync ? new Date(row.last_sync).toISOString() : null;
            }
            // If the complex query returns nulls, fall back to simpler queries
            if (totalAccounts === 0) {
                const simpleCounts = await query('SELECT COUNT(*)::int AS cnt, COALESCE(SUM(balance_current),0) AS bal, MAX(synced_at) AS sync FROM plaid_accounts');
                if (simpleCounts.rows.length > 0) {
                    totalAccounts = simpleCounts.rows[0].cnt;
                    totalBalance = parseFloat(simpleCounts.rows[0].bal) || 0;
                    lastSync = simpleCounts.rows[0].sync ? new Date(simpleCounts.rows[0].sync).toISOString() : null;
                }
                const typeRows = await query('SELECT COALESCE(type, \'unknown\') AS type, SUM(balance_current) AS bal FROM plaid_accounts GROUP BY type');
                balanceByType = {};
                for (const r of typeRows.rows) {
                    balanceByType[r.type] = parseFloat(r.bal) || 0;
                }
            }
            // Coerce balance_by_type values to numbers
            for (const key of Object.keys(balanceByType)) {
                balanceByType[key] = parseFloat(balanceByType[key]) || 0;
            }
            // ── Parse transaction data ──────────────────────────────────
            let totalSpending = 0;
            let totalIncome = 0;
            let netCashflow = 0;
            let transactionsScanned = 0;
            let topCategories = [];
            if (txnResult.rows.length > 0) {
                const row = txnResult.rows[0];
                totalSpending = parseFloat(row.total_spending) || 0;
                totalIncome = parseFloat(row.total_income) || 0;
                netCashflow = parseFloat(row.net_cashflow) || 0;
                transactionsScanned = row.transactions_scanned || 0;
                topCategories = Array.isArray(row.top_categories) ? row.top_categories : [];
                // Coerce amounts to numbers
                topCategories = topCategories.map((c) => ({
                    category: c.category,
                    amount: parseFloat(c.amount) || 0,
                    percentage: parseFloat(c.percentage) || 0,
                }));
            }
            // ── Data freshness ──────────────────────────────────────────
            let dataFreshness = 'unknown';
            if (lastSync) {
                const diffMs = Date.now() - new Date(lastSync).getTime();
                const diffMins = Math.floor(diffMs / 60_000);
                if (diffMins < 1)
                    dataFreshness = 'just now';
                else if (diffMins < 60)
                    dataFreshness = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                else if (diffMins < 1440) {
                    const hrs = Math.floor(diffMins / 60);
                    dataFreshness = `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
                }
                else {
                    const days = Math.floor(diffMins / 1440);
                    dataFreshness = `${days} day${days === 1 ? '' : 's'} ago`;
                }
            }
            // ── Coverage analysis ──────────────────────────────────────
            const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
            // Payroll detection — recurring credits >$500 with consistent timing
            const payrollCheck = await query(`
        SELECT COUNT(*)::int AS cnt FROM (
          SELECT merchant_name
          FROM plaid_transactions
          WHERE amount < 0 AND ABS(amount) > 500
            AND date >= CURRENT_DATE - INTERVAL '90 days'
          GROUP BY merchant_name
          HAVING COUNT(*) >= 2
        ) t
      `);
            const hasPayroll = payrollCheck.rows[0]?.cnt > 0;
            // Unclassified large charges
            const unclassifiedCheck = await query(`
        SELECT COUNT(*)::int AS cnt FROM plaid_transactions
        WHERE amount > 200 AND (category IS NULL OR category = 'Uncategorized')
          AND date >= CURRENT_DATE - INTERVAL '30 days'
      `);
            const unclassifiedCount = unclassifiedCheck.rows[0]?.cnt || 0;
            // Income sources
            const incomeSourcesCheck = await query(`
        SELECT COUNT(DISTINCT COALESCE(merchant_name, name))::int AS cnt
        FROM plaid_transactions
        WHERE amount < 0 AND date >= CURRENT_DATE - INTERVAL '30 days'
      `);
            // Explainability — % of spending with categories
            const explainCheck = await query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE category IS NOT NULL AND category != 'Uncategorized')::int AS explained
        FROM plaid_transactions
        WHERE amount > 0 AND date >= CURRENT_DATE - INTERVAL '30 days'
      `);
            const totalTxns = explainCheck.rows[0]?.total || 0;
            const explainedTxns = explainCheck.rows[0]?.explained || 0;
            const explanationPct = totalTxns > 0 ? Math.round((explainedTxns / totalTxns) * 100) : 0;
            // Build gaps
            const coverageGaps = [];
            if (!hasPayroll)
                coverageGaps.push('No payroll deposit pattern detected in visible accounts');
            if (connections.length <= 1)
                coverageGaps.push('Only 1 financial institution connected');
            if (unclassifiedCount > 0)
                coverageGaps.push(`${unclassifiedCount} charges over $200 are uncategorized`);
            coverageGaps.push('Income reflects only visible credit transactions');
            // Visible evidence
            const coverageVisible = [
                `${totalAccounts} accounts`,
                `${transactionsScanned} transactions (30 days)`,
                'Current balances',
            ];
            if (hasPayroll)
                coverageVisible.push('Payroll deposit pattern');
            const provenance = await buildProvenance(true, true);
            return {
                provenance,
                summary: {
                    total_accounts: totalAccounts,
                    total_balance: totalBalance,
                    balance_by_type: balanceByType,
                },
                monthly: {
                    period: 'last 30 days',
                    income: totalIncome,
                    spending: totalSpending,
                    net_cashflow: netCashflow,
                    top_spending_categories: topCategories,
                },
                metadata: {
                    last_sync: lastSync,
                    data_freshness: dataFreshness,
                    accounts_analyzed: totalAccounts,
                    transactions_scanned: transactionsScanned,
                },
                coverage: {
                    institutions_connected: connections.length,
                    accounts_visible: totalAccounts,
                    has_payroll_pattern: hasPayroll,
                    income_sources_identified: incomeSourcesCheck.rows[0]?.cnt || 0,
                    unclassified_large_charges: unclassifiedCount,
                    explanation_pct: explanationPct,
                    visible: coverageVisible,
                    gaps: coverageGaps,
                },
                executionMs: Date.now() - start,
            };
        }
        catch (err) {
            return { error: `Financial snapshot failed: ${err.message}`, executionMs: Date.now() - start };
        }
    },
};
export default tool;
//# sourceMappingURL=getFinancialSnapshot%202.js.map