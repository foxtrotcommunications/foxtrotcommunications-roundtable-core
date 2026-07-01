declare const Pool: typeof import("pg").Pool;
export declare function createPool(databaseUrl: string): InstanceType<typeof Pool>;
export declare function withPool<T>(databaseUrl: string, fn: (pool: InstanceType<typeof Pool>) => Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=pool.d.ts.map