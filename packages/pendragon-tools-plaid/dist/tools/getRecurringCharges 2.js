// @ts-nocheck
// server/tools/getRecurringCharges.ts — Smart recurring charge detection
// Handles price changes (Netflix $15.49 → $15.99 → $16.32) by using
// date-gap cadence detection + amount std-deviation tolerance.
import { query } from './utils/domainDb.js';
import { buildProvenance } from './utils/buildProvenance.js';
/** Detect cadence from median gap in days */
function detectCadence(medianGap) {
    if (medianGap >= 5 && medianGap <= 9)
        return 'weekly';
    if (medianGap >= 12 && medianGap <= 16)
        return 'biweekly';
    if (medianGap >= 25 && medianGap <= 35)
        return 'monthly';
    if (medianGap >= 350 && medianGap <= 380)
        return 'annual';
    return null;
}
/** Approximate days for a cadence */
function cadenceDays(cadence) {
    switch (cadence) {
        case 'weekly': return 7;
        case 'biweekly': return 14;
        case 'monthly': return 30;
        case 'annual': return 365;
        default: return 30;
    }
}
/** Compute the median of a sorted numeric array */
function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
/** Standard deviation */
function stdDev(values, mean) {
    if (values.length < 2)
        return 0;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}
const tool = {
    name: 'get_recurring_charges',
    description: 'Detect recurring charges from plaid_transactions using cadence-based analysis. ' +
        'Handles price changes by tolerating amount std deviation < 30% of mean. ' +
        'Detects weekly, biweekly, monthly, and annual cadences from date gaps.',
    parameters: {
        type: 'object',
        properties: {
            account_id: {
                type: 'string',
                description: 'Optional Plaid account ID to filter by',
            },
            min_occurrences: {
                type: 'number',
                description: 'Minimum number of occurrences to qualify as recurring (default: 2)',
            },
        },
    },
    async execute(args, _workspaceConfig = {}) {
        const start = Date.now();
        try {
            const { account_id, min_occurrences = 2 } = args;
            // Pull all debit (positive amount) transactions with date + amount + merchant
            const conditions = ['amount > 0'];
            const params = [];
            let idx = 1;
            if (account_id) {
                conditions.push(`account_id = $${idx++}`);
                params.push(account_id);
            }
            const sql = `
        SELECT
          COALESCE(merchant_name, name) AS merchant,
          amount,
          date
        FROM plaid_transactions
        WHERE ${conditions.join(' AND ')}
          AND COALESCE(merchant_name, name) IS NOT NULL
        ORDER BY COALESCE(merchant_name, name), date
      `;
            const result = await query(sql, params);
            // Step 1: Normalize and group by merchant
            const groups = {};
            for (const row of result.rows) {
                const normalized = row.merchant.toLowerCase().trim();
                if (!groups[normalized]) {
                    groups[normalized] = { amounts: [], dates: [] };
                }
                groups[normalized].amounts.push(parseFloat(row.amount));
                groups[normalized].dates.push(row.date);
            }
            // Provenance metadata
            const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts');
            const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
            const transactionsScanned = result.rows.length;
            // Step 2: Analyze each group
            const recurring = [];
            for (const [merchant, data] of Object.entries(groups)) {
                if (data.amounts.length < min_occurrences)
                    continue;
                // Sort dates chronologically
                const sortedDates = data.dates
                    .map((d) => new Date(d))
                    .sort((a, b) => a.getTime() - b.getTime());
                // Calculate gaps between consecutive transactions (in days)
                const gaps = [];
                for (let i = 1; i < sortedDates.length; i++) {
                    const diffMs = sortedDates[i].getTime() - sortedDates[i - 1].getTime();
                    gaps.push(diffMs / (1000 * 60 * 60 * 24));
                }
                if (gaps.length === 0)
                    continue;
                // Detect cadence from median gap
                const medianGap = median(gaps);
                const cadence = detectCadence(medianGap);
                if (!cadence)
                    continue; // no recognizable cadence
                // Amount tolerance: std dev must be < 30% of mean
                const meanAmount = data.amounts.reduce((s, v) => s + v, 0) / data.amounts.length;
                const amountStdDev = stdDev(data.amounts, meanAmount);
                const tolerance = meanAmount > 0 ? amountStdDev / meanAmount : 1;
                if (tolerance >= 0.3)
                    continue; // too much amount variance
                // Compute next expected date
                const lastDate = sortedDates[sortedDates.length - 1];
                const nextExpected = new Date(lastDate);
                nextExpected.setDate(nextExpected.getDate() + cadenceDays(cadence));
                recurring.push({
                    merchant,
                    avg_amount: parseFloat(meanAmount.toFixed(2)),
                    min_amount: parseFloat(Math.min(...data.amounts).toFixed(2)),
                    max_amount: parseFloat(Math.max(...data.amounts).toFixed(2)),
                    amount_std_dev: parseFloat(amountStdDev.toFixed(2)),
                    frequency: cadence,
                    median_gap_days: parseFloat(medianGap.toFixed(1)),
                    occurrences: data.amounts.length,
                    last_date: lastDate.toISOString().split('T')[0],
                    next_expected: nextExpected.toISOString().split('T')[0],
                });
            }
            // Sort by average amount descending
            recurring.sort((a, b) => b.avg_amount - a.avg_amount);
            const totalMonthly = recurring
                .filter((r) => r.frequency === 'monthly')
                .reduce((s, r) => s + r.avg_amount, 0);
            const totalAnnualEstimate = recurring.reduce((s, r) => {
                switch (r.frequency) {
                    case 'weekly': return s + r.avg_amount * 52;
                    case 'biweekly': return s + r.avg_amount * 26;
                    case 'monthly': return s + r.avg_amount * 12;
                    case 'annual': return s + r.avg_amount;
                    default: return s;
                }
            }, 0);
            const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
            const coverageGaps = [];
            if (connections.length <= 1)
                coverageGaps.push('Only 1 institution connected — results may be incomplete');
            coverageGaps.push('Recurring detection based on transaction history — actual subscriptions may differ');
            const provenance = await buildProvenance(true, true);
            return {
                provenance,
                recurring,
                summary: {
                    total_recurring_found: recurring.length,
                    total_monthly_cost: parseFloat(totalMonthly.toFixed(2)),
                    estimated_annual_cost: parseFloat(totalAnnualEstimate.toFixed(2)),
                    by_frequency: {
                        weekly: recurring.filter((r) => r.frequency === 'weekly').length,
                        biweekly: recurring.filter((r) => r.frequency === 'biweekly').length,
                        monthly: recurring.filter((r) => r.frequency === 'monthly').length,
                        annual: recurring.filter((r) => r.frequency === 'annual').length,
                    },
                },
                filters: { account_id, min_occurrences },
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
        }
        catch (err) {
            return { error: err.message, executionMs: Date.now() - start };
        }
    },
};
export default tool;
//# sourceMappingURL=getRecurringCharges%202.js.map