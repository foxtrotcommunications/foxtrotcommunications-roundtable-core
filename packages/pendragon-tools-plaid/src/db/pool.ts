// src/db/pool.ts — Database pool helpers
// Uses `import pg from 'pg'` pattern for ESM compatibility.

import pg from 'pg';
const { Pool } = pg;

export function createPool(databaseUrl: string): InstanceType<typeof Pool> {
  return new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 10000,
  });
}

export async function withPool<T>(
  databaseUrl: string,
  fn: (pool: InstanceType<typeof Pool>) => Promise<T>,
): Promise<T> {
  const pool = createPool(databaseUrl);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
