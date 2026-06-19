// src/provenance.ts — Shared provenance helpers for Plaid domain modules
// Provides per-account and aggregate provenance metadata used by all domains.
/**
 * Check which accounts have transaction history in the local DB.
 */
export async function checkTransactionHistory(pool, accountIds) {
    if (accountIds.length === 0)
        return {};
    const { rows } = await pool.query(`SELECT DISTINCT account_id FROM plaid_transactions WHERE account_id = ANY($1)`, [accountIds]);
    const withHistory = new Set(rows.map((r) => r.account_id));
    return Object.fromEntries(accountIds.map(id => [id, withHistory.has(id)]));
}
/**
 * Build per-account provenance from account rows and transaction history map.
 */
export function buildAccountProvenance(rows, historyMap) {
    return rows.map(r => ({
        account_id: r.account_id,
        current_balance: Math.abs(r.balance_current ?? r.current_balance ?? 0),
        current_balance_verified: true, // All Plaid-synced balances are verified
        historical_series_verified: historyMap[r.account_id] ?? false,
    }));
}
/**
 * Aggregate provenance from per-account data.
 */
export function aggregateProvenance(accounts, lastSynced) {
    const totalBalance = accounts.reduce((s, a) => s + a.current_balance, 0);
    const balanceVerified = accounts
        .filter(a => a.current_balance_verified)
        .reduce((s, a) => s + a.current_balance, 0);
    const historicalVerified = accounts
        .filter(a => a.historical_series_verified)
        .reduce((s, a) => s + a.current_balance, 0);
    return {
        accounts,
        total_balance: totalBalance,
        balance_verified: balanceVerified,
        historical_verified: historicalVerified,
        last_synced: lastSynced || null,
        data_source: 'plaid_api',
    };
}
//# sourceMappingURL=provenance.js.map