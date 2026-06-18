// src/db/pool.ts — Database pool helpers
// Uses `import pg from 'pg'` pattern for ESM compatibility.
import pg from 'pg';
const { Pool } = pg;
export function createPool(databaseUrl) {
    return new Pool({
        connectionString: databaseUrl,
        max: 3,
        idleTimeoutMillis: 10000,
    });
}
export async function withPool(databaseUrl, fn) {
    const pool = createPool(databaseUrl);
    try {
        return await fn(pool);
    }
    finally {
        await pool.end();
    }
}
//# sourceMappingURL=pool.js.map