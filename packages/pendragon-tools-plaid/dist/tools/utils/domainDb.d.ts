/**
 * Get or create the shared database pool.
 * Uses DATABASE_URL from the environment (set per-workspace by the operator).
 */
declare function getPool(): any;
/**
 * Execute a parameterized query against the domain's Cloud SQL.
 * Returns { rows, rowCount, executionMs }.
 */
declare function query(sql: string, params?: any[]): Promise<{
    rows: any[];
    rowCount: number;
    executionMs: number;
}>;
export { getPool, query };
//# sourceMappingURL=domainDb.d.ts.map