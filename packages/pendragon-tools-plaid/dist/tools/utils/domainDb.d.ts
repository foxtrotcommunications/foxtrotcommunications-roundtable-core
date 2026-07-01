/**
 * Get or create the shared database pool.
 * Uses DATABASE_URL from the environment (set per-workspace by the operator).
 */
declare function getPool(): any;
/**
 * Gracefully close the pool (call on process shutdown).
 */
declare function endPool(): Promise<void>;
/**
 * Execute a parameterized query against the domain's Cloud SQL.
 * Returns { rows, rowCount, executionMs }.
 */
declare function query(sql: string, params?: any[]): Promise<{
    rows: any[];
    rowCount: number;
    executionMs: number;
}>;
export { getPool, query, endPool };
//# sourceMappingURL=domainDb.d.ts.map