// src/db/pool.ts — Database pool helpers
// Uses a singleton pool cache keyed by databaseUrl to avoid connection churn.
// Every capability handler call reuses the same pool for a given database URL.
//
// RLS is enforced via per-workspace database roles (rt_checking, rt_debt, etc.).
// The connection credentials determine tenant scope — no session variables needed.

import pg from 'pg';
const { Pool } = pg;

// Singleton pool cache — one pool per unique databaseUrl
const _pools = new Map<string, InstanceType<typeof Pool>>();

/**
 * Get or create a shared pool for the given databaseUrl.
 * Pools are cached for the lifetime of the process and shared across
 * all capability handlers (getBalances, getTransactions, syncData, goals, etc.).
 */
export function getOrCreatePool(databaseUrl: string): InstanceType<typeof Pool> {
  let pool = _pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 3,                        // 3 concurrent connections per database
      idleTimeoutMillis: 30_000,     // release idle connections after 30s
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err: Error) => {
      console.error('[PlaidPool] Unexpected pool error:', err.message);
    });
    _pools.set(databaseUrl, pool);
    console.log(`[PlaidPool] Created shared pool for ${databaseUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
  }
  return pool;
}

/**
 * Run a function with a shared pool for the given databaseUrl.
 * The pool is reused across calls — NOT created/destroyed per invocation.
 * This is the primary API used by all domain modules (checking, debt, goals, etc.).
 *
 * RLS enforcement: Postgres Row Level Security policies use `current_user`
 * to filter rows. Each workspace connects as its own DB role (rt_checking, etc.),
 * so isolation is enforced at the connection level — no SET LOCAL needed.
 */
export async function withPool<T>(
  databaseUrl: string,
  fn: (pool: InstanceType<typeof Pool>) => Promise<T>,
): Promise<T> {
  const pool = getOrCreatePool(databaseUrl);
  return fn(pool);
}

/**
 * Gracefully close all cached pools (call on process shutdown).
 */
export async function endAllPools(): Promise<void> {
  const entries = [..._pools.entries()];
  _pools.clear();
  for (const [url, pool] of entries) {
    try {
      await pool.end();
      console.log(`[PlaidPool] Closed pool for ${url.replace(/\/\/.*@/, '//<redacted>@')}`);
    } catch (err: any) {
      console.error(`[PlaidPool] Error closing pool: ${err.message}`);
    }
  }
}

// Backward compat — createPool is used by index.ts schema init retry loop.
// Now returns the shared singleton instead of a throwaway pool.
export function createPool(databaseUrl: string): InstanceType<typeof Pool> {
  return getOrCreatePool(databaseUrl);
}
