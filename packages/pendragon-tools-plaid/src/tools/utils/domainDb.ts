// server/tools/utils/domainDb.ts — Shared connection pool for domain-side financial tools
// Uses a singleton pool per process to avoid connection churn.
// All domain tools (getFinancialSnapshot, getTransactions, etc.) import this.

import pg from 'pg';
const { Pool } = pg;

let _pool: any = null;

/**
 * Get or create the shared database pool.
 * Uses DATABASE_URL from the environment (set per-workspace by the operator).
 */
function getPool(): any {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL not set — domain financial tools require a PostgreSQL database');
    }
    _pool = new Pool({
      connectionString,
      max: 5,              // max concurrent connections
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', (err: Error) => {
      console.error('[DomainDB] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * Execute a parameterized query against the domain's Cloud SQL.
 * Returns { rows, rowCount, executionMs }.
 */
async function query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number; executionMs: number }> {
  const pool = getPool();
  const start = Date.now();
  const result = await pool.query(sql, params);
  return {
    rows: result.rows,
    rowCount: result.rowCount || result.rows.length,
    executionMs: Date.now() - start,
  };
}

export { getPool, query };
