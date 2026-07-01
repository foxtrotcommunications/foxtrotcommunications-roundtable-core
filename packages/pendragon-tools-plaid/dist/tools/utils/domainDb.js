// src/tools/utils/domainDb.ts — Shared connection pool for domain-side financial tools
// Delegates to the singleton pool cache in db/pool.ts to avoid duplicate pools.
// All domain tools (getFinancialSnapshot, getTransactions, etc.) import this.
import { getOrCreatePool, endAllPools } from '../../db/pool.js';
/**
 * Get the shared database pool.
 * Uses DATABASE_URL from the environment (set per-workspace by the operator).
 * Returns the same singleton pool used by capability handlers (withPool).
 */
function getPool() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL not set — domain financial tools require a PostgreSQL database');
    }
    return getOrCreatePool(connectionString);
}
/**
 * Gracefully close all pools (call on process shutdown).
 */
async function endPool() {
    await endAllPools();
}
/**
 * Execute a parameterized query against the domain's Cloud SQL.
 * Returns { rows, rowCount, executionMs }.
 */
async function query(sql, params = []) {
    const pool = getPool();
    const start = Date.now();
    const result = await pool.query(sql, params);
    return {
        rows: result.rows,
        rowCount: result.rowCount || result.rows.length,
        executionMs: Date.now() - start,
    };
}
export { getPool, query, endPool };
//# sourceMappingURL=domainDb.js.map