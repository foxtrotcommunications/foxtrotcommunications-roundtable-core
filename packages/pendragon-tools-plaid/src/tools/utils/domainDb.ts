// src/tools/utils/domainDb.ts — Shared connection pool for domain-side financial tools
// Delegates to the singleton pool cache in db/pool.ts to avoid duplicate pools.
// All domain tools (getFinancialSnapshot, getTransactions, etc.) import this.
//
// RLS is enforced via per-workspace database roles (rt_checking, rt_debt, etc.).
// The connection credentials determine tenant scope — no session variables needed.

import { getOrCreatePool, endAllPools } from '../../db/pool.js';

// ─── Workspace ID (tenant isolation) ────────────────────────────────────────
// Every financial query must be scoped to the current workspace.
// Set from the container's environment — same env vars as server/config.ts.
const _workspaceId = process.env.WS_ID || process.env.WORKSPACE_ID || 'default';

/**
 * Get the workspace ID for tenant-scoped queries.
 * All financial tool queries MUST filter by this (application-level defense).
 * Database-level defense is handled by RLS + per-workspace DB roles.
 */
export function getWorkspaceId(): string {
  return _workspaceId;
}

/**
 * Get the shared database pool.
 * Uses DATABASE_URL from the environment (set per-workspace by the operator).
 * Returns the same singleton pool used by capability handlers (withPool).
 */
function getPool(): any {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set — domain financial tools require a PostgreSQL database');
  }
  return getOrCreatePool(connectionString);
}

/**
 * Gracefully close all pools (call on process shutdown).
 */
async function endPool(): Promise<void> {
  await endAllPools();
}

/**
 * Execute a parameterized query against the domain's Cloud SQL.
 * Returns { rows, rowCount, executionMs }.
 *
 * RLS enforcement: Postgres filters rows by current_user (the per-workspace
 * DB role). No SET LOCAL needed — isolation is baked into the connection.
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
