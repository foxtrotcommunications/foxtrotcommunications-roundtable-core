// server/tools/utils/domainDb.ts — Shared connection pool for domain-side financial tools
// Uses a singleton pool per process to avoid connection churn.
// All domain tools (getFinancialSnapshot, getTransactions, etc.) import this.
//
// NOTE: This is the server-side (CJS) copy. The @pendragon/tools-plaid package
// (maintained in the pendragon repo) has its own pool singleton (ESM) in its
// src/db/pool.ts.
// Both use max: 3 connections so even in the worst case we cap at 6 connections
// for domain work (vs. the previous 10+).

const { Pool } = require('pg');

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
      max: 3,              // max concurrent connections (reduced from 5)
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
 * Gracefully close the pool (call on process shutdown).
 */
async function endPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    console.log('[DomainDB] Pool closed');
  }
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

export { getPool, query, endPool };
