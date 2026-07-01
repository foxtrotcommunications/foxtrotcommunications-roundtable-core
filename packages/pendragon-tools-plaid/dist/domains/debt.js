// src/domains/debt.ts — Debt management domain module
// Contains sync logic, tools, and capabilities for debt-based domains.
// Syncs accounts, transactions, AND liabilities from Plaid.
// Shared sync/query handlers imported from shared.ts; debt-specific
// handlers (liabilities, debt summary, credit utilization) defined here.
import { ScopedPlaidClient } from '../plaid/client.js';
import { withPool } from '../db/pool.js';
import { getSchemaForDomain } from '../db/schemas.js';
import { syncAccounts, syncTransactions, createGetBalancesHandler, createGetTransactionsHandler, } from './shared.js';
// ─── Sync Logic ─────────────────────────────────────────────────────────────
async function syncDebtData(config) {
    const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);
    return withPool(config.databaseUrl, async (pool) => {
        await pool.query(getSchemaForDomain(config.domainType));
        const summary = { success: true, domain: config.domainType };
        // 1. Sync accounts (shared)
        summary.accountsCount = await syncAccounts(plaid, pool, config.accessToken);
        // 2. Sync transactions (shared, cursor-based incremental)
        const txnResult = await syncTransactions(plaid, pool, config.accessToken, config.itemId);
        summary.transactionsAdded = txnResult.added;
        summary.transactionsModified = txnResult.modified;
        summary.transactionsRemoved = txnResult.removed;
        // 3. Sync liabilities (debt-specific)
        try {
            const liabRes = await plaid.liabilitiesGet(config.accessToken);
            const liabilities = liabRes.data.liabilities;
            let liabilityCount = 0;
            if (liabilities.credit) {
                for (const cc of liabilities.credit) {
                    const primaryApr = cc.aprs?.find((a) => a.apr_type === 'purchase_apr');
                    await pool.query(`INSERT INTO plaid_liabilities
               (liability_id, account_id, type, last_payment_amount, last_payment_date,
                next_payment_due_date, minimum_payment_amount, interest_rate, principal_balance, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
             ON CONFLICT (liability_id) DO UPDATE SET
               last_payment_amount = EXCLUDED.last_payment_amount,
               last_payment_date = EXCLUDED.last_payment_date,
               next_payment_due_date = EXCLUDED.next_payment_due_date,
               minimum_payment_amount = EXCLUDED.minimum_payment_amount,
               interest_rate = EXCLUDED.interest_rate,
               principal_balance = EXCLUDED.principal_balance,
               synced_at = NOW()`, [
                        cc.account_id, cc.account_id, 'credit',
                        cc.last_payment_amount ?? null, cc.last_payment_date ?? null,
                        cc.next_payment_due_date ?? null, cc.minimum_payment_amount ?? null,
                        primaryApr?.apr_percentage ?? null, cc.last_statement_balance ?? null,
                    ]);
                    liabilityCount++;
                }
            }
            if (liabilities.student) {
                for (const sl of liabilities.student) {
                    await pool.query(`INSERT INTO plaid_liabilities
               (liability_id, account_id, type, last_payment_amount, last_payment_date,
                next_payment_due_date, minimum_payment_amount, interest_rate, principal_balance, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
             ON CONFLICT (liability_id) DO UPDATE SET
               last_payment_amount = EXCLUDED.last_payment_amount,
               last_payment_date = EXCLUDED.last_payment_date,
               next_payment_due_date = EXCLUDED.next_payment_due_date,
               minimum_payment_amount = EXCLUDED.minimum_payment_amount,
               interest_rate = EXCLUDED.interest_rate,
               principal_balance = EXCLUDED.principal_balance,
               synced_at = NOW()`, [
                        sl.account_id, sl.account_id, 'student',
                        sl.last_payment_amount ?? null, sl.last_payment_date ?? null,
                        sl.next_payment_due_date ?? null, sl.minimum_payment_amount ?? null,
                        sl.interest_rate_percentage ?? null, sl.outstanding_interest_amount ?? null,
                    ]);
                    liabilityCount++;
                }
            }
            if (liabilities.mortgage) {
                for (const mtg of liabilities.mortgage) {
                    await pool.query(`INSERT INTO plaid_liabilities
               (liability_id, account_id, type, last_payment_amount, last_payment_date,
                next_payment_due_date, minimum_payment_amount, interest_rate, principal_balance, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
             ON CONFLICT (liability_id) DO UPDATE SET
               last_payment_amount = EXCLUDED.last_payment_amount,
               last_payment_date = EXCLUDED.last_payment_date,
               next_payment_due_date = EXCLUDED.next_payment_due_date,
               minimum_payment_amount = EXCLUDED.minimum_payment_amount,
               interest_rate = EXCLUDED.interest_rate,
               principal_balance = EXCLUDED.principal_balance,
               synced_at = NOW()`, [
                        mtg.account_id, mtg.account_id, 'mortgage',
                        mtg.last_payment_amount ?? null, mtg.last_payment_date ?? null,
                        mtg.next_payment_due_date ?? null, null,
                        mtg.interest_rate?.percentage ?? null, mtg.past_due_amount ?? null,
                    ]);
                    liabilityCount++;
                }
            }
            summary.liabilityCount = liabilityCount;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[debt-sync] liabilitiesGet failed (may be unsupported): ${msg}`);
            summary.liabilityError = msg;
        }
        return summary;
    });
}
// ─── Debt-Specific Capability Handlers ──────────────────────────────────────
function createGetLiabilitiesHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT l.*, a.name AS account_name, a.mask, a.subtype,
                a.balance_current, a.balance_limit
         FROM plaid_liabilities l
         LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
         ORDER BY l.principal_balance DESC`);
            return { liabilities: rows };
        });
    };
}
function createGetDebtSummaryHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const totalsResult = await pool.query(`SELECT
           COUNT(*) as total_accounts,
           COALESCE(SUM(a.balance_current), 0) as total_balance,
           COALESCE(SUM(l.minimum_payment_amount), 0) as total_minimum_payments,
           COALESCE(AVG(l.interest_rate), 0) as avg_interest_rate,
           MIN(l.next_payment_due_date) as next_payment_date
         FROM plaid_liabilities l
         LEFT JOIN plaid_accounts a ON a.account_id = l.account_id`);
            const { total_accounts, total_balance, total_minimum_payments, avg_interest_rate, next_payment_date } = totalsResult.rows[0];
            const breakdownResult = await pool.query(`SELECT l.type,
                COUNT(*) AS count,
                COALESCE(SUM(a.balance_current), 0) AS total_balance,
                COALESCE(AVG(l.interest_rate), 0) AS avg_rate
         FROM plaid_liabilities l
         LEFT JOIN plaid_accounts a ON a.account_id = l.account_id
         GROUP BY l.type
         ORDER BY total_balance DESC`);
            return {
                totalAccounts: parseInt(total_accounts, 10) || 0,
                totalBalance: parseFloat(total_balance) || 0,
                totalMinimumPayments: parseFloat(total_minimum_payments) || 0,
                avgInterestRate: parseFloat(avg_interest_rate) || 0,
                nextPaymentDate: next_payment_date,
                byType: breakdownResult.rows.map((row) => ({
                    type: row.type || 'unknown',
                    count: parseInt(row.count, 10) || 0,
                    totalBalance: parseFloat(row.total_balance) || 0,
                    avgRate: parseFloat(row.avg_rate) || 0,
                })),
            };
        });
    };
}
function createGetCreditUtilizationHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT a.account_id, a.name, a.mask,
                a.balance_current, a.balance_limit,
                CASE WHEN a.balance_limit > 0
                  THEN ROUND((a.balance_current / a.balance_limit * 100)::numeric, 1)
                  ELSE 0
                END as utilization_pct
         FROM plaid_accounts a
         WHERE a.type = 'credit'
         ORDER BY utilization_pct DESC`);
            return { accounts: rows };
        });
    };
}
function createSyncDataHandler(config) {
    return async (_input, _ctx) => {
        return syncDebtData(config);
    };
}
// ─── Tool Registration ──────────────────────────────────────────────────────
export function registerDebtTools(registry, config) {
    registry.register('plaid_sync', {
        name: 'plaid_sync',
        description: 'Sync debt data from Plaid into this workspace\'s database. ' +
            'Fetches accounts, transactions, and liabilities from the connected Plaid account and stores them in local PostgreSQL tables. ' +
            'Call this tool when you need to refresh or initially load debt data.',
        parameters: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    description: 'What to sync.',
                    enum: ['all', 'accounts', 'liabilities'],
                },
            },
            required: ['syncType'],
        },
        async execute(_args, _workspaceConfig) {
            return syncDebtData(config);
        },
    });
}
// ─── Capability Registration ────────────────────────────────────────────────
export function registerDebtCapabilities(registry, config) {
    // 1. Get balances (shared handler — credit card and loan account balances)
    registry.register({
        name: 'plaid.getBalances',
        description: 'Get current debt account balances (credit cards, loans) from local database',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                accounts: {
                    type: 'array',
                    description: 'Debt account records with balance fields',
                },
            },
        },
        handler: createGetBalancesHandler(config),
    });
    // 2. Get transactions (shared handler — itemized credit card charges by merchant/category)
    registry.register({
        name: 'plaid.getTransactions',
        description: 'Get credit card and loan transactions with optional date, category, and merchant filters. Use this to see itemized credit card charges.',
        inputSchema: {
            type: 'object',
            properties: {
                startDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
                endDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
                category: { type: 'string' },
                merchant: { type: 'string' },
                limit: { type: 'number', default: 50 },
            },
        },
        outputSchema: {
            type: 'object',
            properties: {
                transactions: { type: 'array' },
                count: { type: 'number' },
            },
        },
        handler: createGetTransactionsHandler(config),
    });
    // 3. Get liabilities (debt-specific)
    registry.register({
        name: 'plaid.getLiabilities',
        description: 'Get liability details joined with account information',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                liabilities: {
                    type: 'array',
                    description: 'Liabilities enriched with account details',
                },
            },
        },
        handler: createGetLiabilitiesHandler(config),
    });
    // 4. Get debt summary (debt-specific)
    registry.register({
        name: 'plaid.getDebtSummary',
        description: 'Get aggregate debt summary with totals and breakdown by type',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                totalAccounts: { type: 'number' },
                totalBalance: { type: 'number' },
                totalMinimumPayments: { type: 'number' },
                avgInterestRate: { type: 'number' },
                nextPaymentDate: { type: 'string' },
                byType: {
                    type: 'array',
                    description: 'Breakdown by liability type with balance and rate',
                },
            },
        },
        handler: createGetDebtSummaryHandler(config),
    });
    // 5. Credit utilization (debt-specific)
    registry.register({
        name: 'plaid.getCreditUtilization',
        description: 'Get credit utilization percentage for all credit accounts',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                accounts: {
                    type: 'array',
                    description: 'Credit accounts with utilization percentages',
                },
            },
        },
        handler: createGetCreditUtilizationHandler(config),
    });
    // 6. Sync data (debt-specific — includes liabilities)
    registry.register({
        name: 'plaid.syncData',
        description: 'Trigger a Plaid data sync to refresh debt accounts, transactions, and liabilities',
        inputSchema: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    enum: ['all', 'accounts', 'liabilities'],
                },
            },
            required: ['syncType'],
        },
        outputSchema: {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                domain: { type: 'string' },
                accountsCount: { type: 'number' },
                transactionsAdded: { type: 'number' },
                liabilityCount: { type: 'number' },
            },
        },
        handler: createSyncDataHandler(config),
    });
}
//# sourceMappingURL=debt.js.map