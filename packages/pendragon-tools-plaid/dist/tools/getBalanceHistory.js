// @ts-nocheck
// server/tools/getBalanceHistory.ts — Reconstruct balance history from transactions
// Walks backward from current balance, applying transaction deltas per period
import { query } from './utils/domainDb.js';
import { buildProvenance } from './utils/buildProvenance.js';
const tool = {
    name: 'get_balance_history',
    description: 'Reconstruct balance history for an account by applying transactions backward from the current balance. Returns chart-ready data with labels and values. Supports daily, weekly, or monthly granularity.',
    parameters: {
        type: 'object',
        properties: {
            account_id: {
                type: 'string',
                description: 'The account ID to get balance history for.',
            },
            start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format. Default: 60 days ago.',
            },
            end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format. Default: today.',
            },
            granularity: {
                type: 'string',
                enum: ['daily', 'weekly', 'monthly'],
                description: 'Time granularity for data points. Default: daily.',
            },
        },
        required: ['account_id'],
    },
    async execute(args, _workspaceConfig = {}) {
        const start = Date.now();
        try {
            const { account_id } = args;
            const granularity = args.granularity || 'daily';
            // Default date range: 60 days ago → today
            const today = new Date();
            const defaultStart = new Date(today);
            defaultStart.setDate(defaultStart.getDate() - 60);
            const startDate = args.start_date || defaultStart.toISOString().split('T')[0];
            const endDate = args.end_date || today.toISOString().split('T')[0];
            // ── 1. Get current balance ────────────────────────────────
            const acctResult = await query('SELECT balance_current, name, synced_at FROM plaid_accounts WHERE account_id = $1', [account_id]);
            if (acctResult.rows.length === 0) {
                return { error: `Account not found: ${account_id}`, executionMs: Date.now() - start };
            }
            const currentBalance = parseFloat(acctResult.rows[0].balance_current) || 0;
            const accountName = acctResult.rows[0].name;
            // ── 2. Get transactions in the period, ordered by date desc ──
            // Plaid convention: positive = debit (money out), negative = credit (money in)
            // To walk backward: subtract the transaction amount to "undo" it
            const truncExpr = granularity === 'weekly' ? "date_trunc('week', date)::date"
                : granularity === 'monthly' ? "date_trunc('month', date)::date"
                    : 'date';
            const txnSql = `
        SELECT
          ${truncExpr} AS period,
          SUM(amount) AS net_amount
        FROM plaid_transactions
        WHERE account_id = $1
          AND date >= $2::date
          AND date <= $3::date
          AND pending = false
        GROUP BY period
        ORDER BY period DESC
      `;
            const txnResult = await query(txnSql, [account_id, startDate, endDate]);
            // ── 3. Walk backward from current balance ─────────────────
            // Start at today's balance and subtract each period's net to get earlier balances
            // net_amount positive = money spent (balance decreased), negative = money received (balance increased)
            // "Undoing" a period: balance_before = balance_after - net_amount
            //   - If net > 0 (spent money), undoing adds it back → balance was higher before
            //   - If net < 0 (received money), undoing removes it → balance was lower before
            const periodMap = new Map();
            for (const row of txnResult.rows) {
                const key = row.period instanceof Date
                    ? row.period.toISOString().split('T')[0]
                    : String(row.period);
                periodMap.set(key, parseFloat(row.net_amount) || 0);
            }
            // Generate all period labels in range
            const labels = [];
            const d = new Date(startDate);
            const end = new Date(endDate);
            while (d <= end) {
                labels.push(d.toISOString().split('T')[0]);
                if (granularity === 'monthly') {
                    d.setMonth(d.getMonth() + 1);
                }
                else if (granularity === 'weekly') {
                    d.setDate(d.getDate() + 7);
                }
                else {
                    d.setDate(d.getDate() + 1);
                }
            }
            // Build values: walk backward from end
            // endBalance is currentBalance, then subtract each period's transactions going backward
            const values = new Array(labels.length);
            let runningBalance = currentBalance;
            // Process from newest to oldest
            for (let i = labels.length - 1; i >= 0; i--) {
                values[i] = Math.round(runningBalance * 100) / 100;
                const periodNet = periodMap.get(labels[i]) || 0;
                // Undo this period's transactions to get the prior period's ending balance
                runningBalance = runningBalance - periodNet;
            }
            const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
            const coverageGaps = [];
            if (connections.length <= 1)
                coverageGaps.push('Only 1 institution connected — results may be incomplete');
            coverageGaps.push('Balance estimated by applying transactions backward — may not reflect pending items');
            const provenance = await buildProvenance(true, true);
            return {
                provenance,
                account_id,
                account_name: accountName,
                start_date: startDate,
                end_date: endDate,
                granularity,
                data_points: labels.length,
                history: labels.map((label, i) => ({ date: label, balance: values[i] })),
                chart: { labels, values },
                methodology: 'estimated',
                note: 'Balance estimated by applying transactions backward from current balance. May not reflect pending items, corrections, or transfers.',
                metadata: {
                    accounts_analyzed: 1,
                    transactions_scanned: txnResult.rows.length,
                },
                coverage: {
                    institutions_connected: connections.length,
                    gaps: coverageGaps,
                },
                executionMs: Date.now() - start,
            };
        }
        catch (err) {
            return { error: `Balance history failed: ${err.message}`, executionMs: Date.now() - start };
        }
    },
};
export default tool;
//# sourceMappingURL=getBalanceHistory.js.map