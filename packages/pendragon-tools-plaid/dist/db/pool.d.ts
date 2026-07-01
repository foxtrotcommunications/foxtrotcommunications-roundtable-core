declare const Pool: typeof import("pg").Pool;
/**
 * Get or create a shared pool for the given databaseUrl.
 * Pools are cached for the lifetime of the process and shared across
 * all capability handlers (getBalances, getTransactions, syncData, goals, etc.).
 */
export declare function getOrCreatePool(databaseUrl: string): InstanceType<typeof Pool>;
/**
 * Run a function with a shared pool for the given databaseUrl.
 * The pool is reused across calls — NOT created/destroyed per invocation.
 * This is the primary API used by all domain modules (checking, debt, goals, etc.).
 */
export declare function withPool<T>(databaseUrl: string, fn: (pool: InstanceType<typeof Pool>) => Promise<T>): Promise<T>;
/**
 * Gracefully close all cached pools (call on process shutdown).
 */
export declare function endAllPools(): Promise<void>;
export declare function createPool(databaseUrl: string): InstanceType<typeof Pool>;
export {};
//# sourceMappingURL=pool.d.ts.map