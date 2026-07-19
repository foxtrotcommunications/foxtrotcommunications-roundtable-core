// server/protocols/nonceStore.ts — Replay Prevention
//
// Postgres-backed nonce store (multi-tenant Phase-0): the in-memory Map
// forgot every seen nonce on pod restart — a replayed intent token inside
// its freshness window sailed through after any redeploy — and could never
// be shared across replicas. Nonces now live in the workspace database
// (INSERT ... ON CONFLICT DO NOTHING is the atomic seen-check), with the
// old in-memory store kept as an explicit, LOUD fallback when the DB is
// unreachable — degraded replay protection is logged, never silent.

import { Pool } from 'pg';

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS intent_nonces (
  nonce TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT current_user,
  expires_at TIMESTAMPTZ NOT NULL
);
`;

/** In-memory fallback — same semantics as the pre-Phase-0 store. */
class MemoryNonceStore {
  private seen: Map<string, number> = new Map();

  add(nonce: string, ttlMs: number): boolean {
    const now = Date.now();
    const expiry = this.seen.get(nonce);
    if (expiry !== undefined && now <= expiry) return false;
    this.seen.set(nonce, now + ttlMs);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.seen.entries()) {
      if (now > expiry) this.seen.delete(nonce);
    }
  }

  get size(): number { return this.seen.size; }
  clear(): void { this.seen.clear(); }
}

export class NonceStore {
  private pool: Pool | null = null;
  private tableReady = false;
  private memory = new MemoryNonceStore();
  private degradedLogged = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs: number = 60_000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  private async getPool(): Promise<Pool | null> {
    if (this.pool) return this.pool;
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    this.pool = new Pool({ connectionString: url, max: 2 });
    return this.pool;
  }

  private async ensureTable(pool: Pool): Promise<void> {
    if (this.tableReady) return;
    await pool.query(TABLE_SQL);
    // Shared database: the first workspace to boot owns the table; every
    // other workspace still needs to write (no sequence — TEXT PK — so the
    // 2026-07-18 sequence-grant lesson doesn't bite here). Owner-only
    // statements fail for non-owners; that's fine.
    try {
      await pool.query(`GRANT SELECT, INSERT, DELETE ON intent_nonces TO PUBLIC`);
      await pool.query(`ALTER TABLE intent_nonces ENABLE ROW LEVEL SECURITY`);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intent_nonces' AND policyname='workspace_isolation') THEN
          EXECUTE 'CREATE POLICY workspace_isolation ON intent_nonces USING (workspace_id = current_user) WITH CHECK (workspace_id = current_user)';
        END IF;
      END $$`);
      await pool.query(`ALTER TABLE intent_nonces FORCE ROW LEVEL SECURITY`);
    } catch { /* not the owner — table already configured */ }
    this.tableReady = true;
  }

  /**
   * Record a nonce with a TTL. Returns false if the nonce was already seen
   * (replay). Atomic via INSERT ON CONFLICT; survives restarts and is
   * shared across replicas.
   */
  async add(nonce: string, ttlMs: number = 600_000): Promise<boolean> {
    try {
      const pool = await this.getPool();
      if (!pool) throw new Error('DATABASE_URL unset');
      await this.ensureTable(pool);
      const r = await pool.query(
        `INSERT INTO intent_nonces (nonce, expires_at)
         VALUES ($1, now() + make_interval(secs => $2))
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, Math.ceil(ttlMs / 1000)],
      );
      if ((r.rowCount ?? 0) === 1) return true;
      // Conflict: either unexpired (replay) or expired-but-not-yet-cleaned.
      const upd = await pool.query(
        `UPDATE intent_nonces SET expires_at = now() + make_interval(secs => $2)
          WHERE nonce = $1 AND expires_at < now()`,
        [nonce, Math.ceil(ttlMs / 1000)],
      );
      return (upd.rowCount ?? 0) === 1; // refreshed an expired row = not a replay
    } catch (err: any) {
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        console.error(`[nonceStore] DB-backed replay prevention DEGRADED to in-memory: ${err.message}`);
      }
      return this.memory.add(nonce, ttlMs);
    }
  }

  cleanup(): void {
    this.memory.cleanup();
    this.getPool().then((pool) => {
      if (pool && this.tableReady) {
        pool.query(`DELETE FROM intent_nonces WHERE expires_at < now()`).catch(() => {});
      }
    }).catch(() => {});
  }

  /** Approximate size (memory fallback only — kept for metrics compat). */
  get size(): number { return this.memory.size; }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.memory.clear();
    if (this.pool) { this.pool.end().catch(() => {}); this.pool = null; }
  }
}

// Singleton instance shared across the application
export const nonceStore = new NonceStore();
