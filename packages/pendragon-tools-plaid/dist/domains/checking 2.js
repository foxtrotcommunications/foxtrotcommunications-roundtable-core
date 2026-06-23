// src/domains/checking.ts — Checking/savings domain module
// Contains sync logic, tools, and capabilities for transaction-based domains.
// Creates its own ScopedPlaidClient to enforce domain isolation.
import { ScopedPlaidClient } from '../plaid/client.js';
import { withPool } from '../db/pool.js';
import { getSchemaForDomain } from '../db/schemas.js';
// ─── Amount Normalization ───────────────────────────────────────────────────
// Plaid convention: positive = debit (money out), negative = credit (money in).
// Some institutions (and sandbox) return credits with positive amounts.
// This function detects known credit patterns and normalizes the sign.
const CREDIT_PATTERNS = [
    'ach electronic credit',
    'ach credit',
    'direct dep',
    'direct deposit',
    'payroll',
    'gusto pay',
    'adp payroll',
    'intuit payroll',
    'employer',
    'salary',
    'wage',
    'tax refund',
    'irs treas',
];
function normalizeAmount(amount, name) {
    // Only fix positive amounts that look like credits
    if (amount <= 0 || !name)
        return amount;
    const lower = name.toLowerCase();
    for (const pattern of CREDIT_PATTERNS) {
        if (lower.includes(pattern)) {
            return -amount; // Flip to negative (credit)
        }
    }
    return amount;
}
// ─── Sync Logic ─────────────────────────────────────────────────────────────
async function syncCheckingData(config) {
    const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);
    return withPool(config.databaseUrl, async (pool) => {
        // 1. Create domain-scoped tables
        await pool.query(getSchemaForDomain(config.domainType));
        const summary = { success: true, domain: config.domainType };
        // 2. Sync accounts
        const accountsRes = await plaid.accountsGet(config.accessToken);
        const accounts = accountsRes.data.accounts;
        for (const acct of accounts) {
            await pool.query(`INSERT INTO plaid_accounts
           (account_id, name, mask, type, subtype,
            balance_available, balance_current, balance_limit, currency, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           mask = EXCLUDED.mask,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           balance_available = EXCLUDED.balance_available,
           balance_current = EXCLUDED.balance_current,
           balance_limit = EXCLUDED.balance_limit,
           currency = EXCLUDED.currency,
           synced_at = NOW()`, [
                acct.account_id,
                acct.name,
                acct.mask,
                acct.type,
                acct.subtype,
                acct.balances?.available ?? null,
                acct.balances?.current ?? null,
                acct.balances?.limit ?? null,
                acct.balances?.iso_currency_code ?? acct.balances?.unofficial_currency_code ?? null,
            ]);
        }
        summary.accountsCount = accounts.length;
        // 3. Sync transactions (cursor-based incremental)
        let cursor;
        if (config.itemId) {
            const cursorRes = await pool.query(`SELECT cursor FROM plaid_sync_state WHERE item_id = $1`, [config.itemId]);
            if (cursorRes.rows.length > 0 && cursorRes.rows[0].cursor) {
                cursor = cursorRes.rows[0].cursor;
            }
        }
        let addedCount = 0;
        let modifiedCount = 0;
        let removedCount = 0;
        let hasMore = true;
        while (hasMore) {
            const syncRes = await plaid.transactionsSync(config.accessToken, cursor);
            const data = syncRes.data;
            // Insert/update added transactions
            for (const txn of data.added) {
                await pool.query(`INSERT INTO plaid_transactions
             (transaction_id, account_id, amount, date, name,
              merchant_name, category, payment_channel, pending, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
           ON CONFLICT (transaction_id) DO UPDATE SET
             account_id = EXCLUDED.account_id,
             amount = EXCLUDED.amount,
             date = EXCLUDED.date,
             name = EXCLUDED.name,
             merchant_name = EXCLUDED.merchant_name,
             category = EXCLUDED.category,
             payment_channel = EXCLUDED.payment_channel,
             pending = EXCLUDED.pending,
             synced_at = NOW()`, [
                    txn.transaction_id,
                    txn.account_id,
                    normalizeAmount(txn.amount, txn.name),
                    txn.date,
                    txn.name,
                    txn.merchant_name ?? null,
                    txn.category ? txn.category.join(', ') : null,
                    txn.payment_channel,
                    txn.pending,
                ]);
                addedCount++;
            }
            // Update modified transactions
            for (const txn of data.modified) {
                await pool.query(`INSERT INTO plaid_transactions
             (transaction_id, account_id, amount, date, name,
              merchant_name, category, payment_channel, pending, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
           ON CONFLICT (transaction_id) DO UPDATE SET
             account_id = EXCLUDED.account_id,
             amount = EXCLUDED.amount,
             date = EXCLUDED.date,
             name = EXCLUDED.name,
             merchant_name = EXCLUDED.merchant_name,
             category = EXCLUDED.category,
             payment_channel = EXCLUDED.payment_channel,
             pending = EXCLUDED.pending,
             synced_at = NOW()`, [
                    txn.transaction_id,
                    txn.account_id,
                    normalizeAmount(txn.amount, txn.name),
                    txn.date,
                    txn.name,
                    txn.merchant_name ?? null,
                    txn.category ? txn.category.join(', ') : null,
                    txn.payment_channel,
                    txn.pending,
                ]);
                modifiedCount++;
            }
            // Delete removed transactions
            for (const txn of data.removed) {
                await pool.query(`DELETE FROM plaid_transactions WHERE transaction_id = $1`, [txn.transaction_id]);
                removedCount++;
            }
            cursor = data.next_cursor;
            hasMore = data.has_more;
        }
        // Persist cursor for incremental sync
        if (config.itemId && cursor) {
            await pool.query(`INSERT INTO plaid_sync_state (item_id, cursor, last_sync_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (item_id) DO UPDATE SET
           cursor = EXCLUDED.cursor,
           last_sync_at = NOW()`, [config.itemId, cursor]);
        }
        summary.transactionsAdded = addedCount;
        summary.transactionsModified = modifiedCount;
        summary.transactionsRemoved = removedCount;
        return summary;
    });
}
// ─── Capability Handlers ────────────────────────────────────────────────────
function createGetBalancesHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT account_id, name, type, subtype,
                balance_available, balance_current, balance_limit,
                currency, synced_at
         FROM plaid_accounts
         ORDER BY name`);
            return { accounts: rows };
        });
    };
}
function createGetTransactionsHandler(config) {
    return async (input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const conditions = [];
            const params = [];
            let paramIdx = 1;
            if (input.startDate) {
                conditions.push(`date >= $${paramIdx++}`);
                params.push(input.startDate);
            }
            if (input.endDate) {
                conditions.push(`date <= $${paramIdx++}`);
                params.push(input.endDate);
            }
            if (input.category) {
                conditions.push(`category ILIKE $${paramIdx++}`);
                params.push(`%${input.category}%`);
            }
            if (input.merchant) {
                conditions.push(`merchant_name ILIKE $${paramIdx++}`);
                params.push(`%${input.merchant}%`);
            }
            const limit = typeof input.limit === 'number' && input.limit > 0
                ? Math.min(input.limit, 500)
                : 50;
            const whereClause = conditions.length > 0
                ? `WHERE ${conditions.join(' AND ')}`
                : '';
            const sql = `SELECT transaction_id, account_id, amount, date, name,
                          merchant_name, category, payment_channel, pending, synced_at
                   FROM plaid_transactions
                   ${whereClause}
                   ORDER BY date DESC
                   LIMIT $${paramIdx}`;
            params.push(limit);
            const { rows } = await pool.query(sql, params);
            return { transactions: rows, count: rows.length };
        });
    };
}
function createSyncDataHandler(config) {
    return async (_input, _ctx) => {
        return syncCheckingData(config);
    };
}
// ─── Tool Registration ──────────────────────────────────────────────────────
export function registerCheckingTools(registry, config) {
    registry.register('plaid_sync', {
        name: 'plaid_sync',
        description: 'Sync financial data from Plaid into this workspace\'s database. ' +
            'Fetches accounts and transactions from the connected Plaid account and stores them in local PostgreSQL tables. ' +
            'Call this tool when you need to refresh or initially load financial data.',
        parameters: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    description: 'What to sync.',
                    enum: ['all', 'accounts', 'transactions'],
                },
            },
            required: ['syncType'],
        },
        async execute(_args, _workspaceConfig) {
            return syncCheckingData(config);
        },
    });
}
// ─── Capability Registration ────────────────────────────────────────────────
export function registerCheckingCapabilities(registry, config) {
    // 1. Get balances
    registry.register({
        name: 'plaid.getBalances',
        description: 'Get current account balances from local database',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                accounts: {
                    type: 'array',
                    description: 'Account records with balance fields',
                },
            },
        },
        handler: createGetBalancesHandler(config),
    });
    // 2. Get transactions
    registry.register({
        name: 'plaid.getTransactions',
        description: 'Get recent transactions with optional date and category filters',
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
    // 3. Sync data
    registry.register({
        name: 'plaid.syncData',
        description: 'Trigger a Plaid data sync to refresh account and transaction data',
        inputSchema: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    enum: ['all', 'accounts', 'transactions'],
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
            },
        },
        handler: createSyncDataHandler(config),
    });
}
//# sourceMappingURL=checking%202.js.map