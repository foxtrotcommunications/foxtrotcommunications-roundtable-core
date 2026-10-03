// tests/integration/coreRls.test.ts — Row-Level Security on core tables (3.4)
//
// Real Postgres. Proves the two-policy pattern from server/db/rls.js
// (applied by migrations/005 and by the postgresql.js boot bootstrap):
//
//   - a workspace role (dedicated pod shape, rt_<ws>, NOBYPASSRLS) sees only
//     the rows whose tenant column equals its own role name, on every one
//     of workspaces / messages / user_api_keys / workspace_usage / audit_log,
//     and cannot write another tenant's rows;
//   - a pooled service role (one NOBYPASSRLS role, app.workspace_id pinned
//     per transaction) sees exactly the pinned tenant and NOTHING when
//     unpinned;
//   - user_api_keys.workspace_id is filled from the tenant by default;
//   - a non-owner role booting the adapter does not fail on the owner-only
//     DDL (the schema is managed by migrations).
//
// Skipped without DATABASE_URL (the CI job sets it).

const DATABASE_URL = process.env.DATABASE_URL || '';
const describeDb = DATABASE_URL ? describe : describe.skip;

import { Pool } from 'pg';
const PostgreSQLAdapter = require('../../server/db/adapters/postgresql');
const { CORE_RLS_TABLES, applyCoreRls } = require('../../server/db/rls');

const SUFFIX = Date.now().toString(36);
const WS_A = `rt_rlsa_${SUFFIX}`;
const WS_B = `rt_rlsb_${SUFFIX}`;
const POOLED = `rt_rlspool_${SUFFIX}`;
const PASSWORD = 'rls-test-pw';

function roleUrl(role: string): string {
  const u = new URL(DATABASE_URL);
  u.username = role;
  u.password = PASSWORD;
  return u.toString();
}

describeDb('core tables under two-policy RLS', () => {
  let admin: Pool;
  let userId: number;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    // Admin boot: creates the schema (fresh test DB) and applies the RLS
    // pattern — same code path a dedicated pod runs on startup, here as the
    // owner so every statement actually executes.
    const adapter = new PostgreSQLAdapter(DATABASE_URL);
    await adapter.initialize();
    await adapter._runMigrations();
    await adapter.close();

    for (const role of [WS_A, WS_B, POOLED]) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}' NOBYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    }

    const u = await admin.query(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, 'RLS', 'x') RETURNING id`,
      [`rls_user_${SUFFIX}`],
    );
    userId = u.rows[0].id;

    for (const ws of [WS_A, WS_B]) {
      await admin.query(`INSERT INTO workspaces (id, name) VALUES ($1, $1)`, [ws]);
      await admin.query(`INSERT INTO messages (workspace_id, user_id, role, content) VALUES ($1, $2, 'user', 'hello from ' || $1)`, [ws, userId]);
      await admin.query(`INSERT INTO workspace_usage (workspace_id, user_id, provider, model, total_tokens) VALUES ($1, $2, 'openai', 'gpt', 10)`, [ws, userId]);
      await admin.query(`INSERT INTO audit_log (workspace_id, user_id, event_type) VALUES ($1, $2, 'test')`, [ws, userId]);
      await admin.query(`INSERT INTO user_api_keys (user_id, provider, api_key, workspace_id) VALUES ($1, 'p_' || $2, 'enc', $2)`, [userId, ws]);
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await admin.query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [WS_A, WS_B]); // cascades
      await admin.query(`DELETE FROM user_api_keys WHERE user_id = $1`, [userId]);
      await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
      for (const role of [WS_A, WS_B, POOLED]) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await admin.end();
    }
  });

  it('every core table has both policies and FORCE RLS', async () => {
    for (const { table } of CORE_RLS_TABLES) {
      const cls = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
      expect(cls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await admin.query(`SELECT policyname FROM pg_policies WHERE tablename = $1 ORDER BY policyname`, [table]);
      expect(pol.rows.map((r) => r.policyname)).toEqual(['tenant_context', 'workspace_isolation']);
    }
  });

  it('applying the pattern again is a no-op (idempotent)', async () => {
    await expect(applyCoreRls(admin)).resolves.toEqual({ skipped: 0 });
  });

  it('the admin (BYPASSRLS) role still sees both tenants', async () => {
    const r = await admin.query(`SELECT count(*)::int AS n FROM messages WHERE workspace_id IN ($1, $2)`, [WS_A, WS_B]);
    expect(r.rows[0].n).toBe(2);
  });

  describe('dedicated shape: workspace role == tenant', () => {
    let a: Pool;
    beforeAll(() => { a = new Pool({ connectionString: roleUrl(WS_A), max: 1 }); });
    afterAll(() => a.end());

    it('sees only its own rows on every core table', async () => {
      const ws = await a.query(`SELECT id FROM workspaces ORDER BY id`);
      expect(ws.rows.map((r) => r.id)).toEqual([WS_A]);
      for (const table of ['messages', 'workspace_usage', 'audit_log', 'user_api_keys']) {
        const r = await a.query(`SELECT DISTINCT workspace_id FROM ${table}`);
        expect(r.rows.map((x) => x.workspace_id)).toEqual([WS_A]);
      }
      // Even naming the other tenant explicitly yields nothing
      const other = await a.query(`SELECT * FROM messages WHERE workspace_id = $1`, [WS_B]);
      expect(other.rowCount).toBe(0);
    });

    it('cannot insert, update or delete another tenant\'s rows', async () => {
      await expect(
        a.query(`INSERT INTO messages (workspace_id, role, content) VALUES ($1, 'user', 'smuggled')`, [WS_B]),
      ).rejects.toThrow(/row-level security/);
      const upd = await a.query(`UPDATE workspaces SET name = 'owned' WHERE id = $1`, [WS_B]);
      expect(upd.rowCount).toBe(0);
      const del = await a.query(`DELETE FROM audit_log WHERE workspace_id = $1`, [WS_B]);
      expect(del.rowCount).toBe(0);
      const still = await admin.query(`SELECT name FROM workspaces WHERE id = $1`, [WS_B]);
      expect(still.rows[0].name).toBe(WS_B);
    });

    it('can write its own rows, and user_api_keys.workspace_id defaults to its role', async () => {
      await a.query(`INSERT INTO messages (workspace_id, role, content) VALUES ($1, 'assistant', 'mine')`, [WS_A]);
      await a.query(`INSERT INTO user_api_keys (user_id, provider, api_key) VALUES ($1, 'defaulted', 'enc')`, [userId]);
      const k = await a.query(`SELECT workspace_id FROM user_api_keys WHERE user_id = $1 AND provider = 'defaulted'`, [userId]);
      expect(k.rows[0].workspace_id).toBe(WS_A);
      // ...and the other tenant cannot see that key
      const b = new Pool({ connectionString: roleUrl(WS_B), max: 1 });
      try {
        const r = await b.query(`SELECT * FROM user_api_keys WHERE user_id = $1 AND provider = 'defaulted'`, [userId]);
        expect(r.rowCount).toBe(0);
      } finally { await b.end(); }
    });

    it('the adapter, connected as the workspace role, boots (owner-only DDL skipped) and reads only its tenant', async () => {
      const adapter = new PostgreSQLAdapter(roleUrl(WS_A));
      await adapter.initialize();
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await expect(adapter._runMigrations()).resolves.toBeUndefined();
        expect(log.mock.calls.some((c) => /Boot DDL skipped|RLS bootstrap/.test(String(c[0])))).toBe(true);
        expect(await adapter.getWorkspace(WS_A)).toMatchObject({ id: WS_A });
        expect(await adapter.getWorkspace(WS_B)).toBeNull();
        const all = await adapter.getAllWorkspaces();
        expect(all.map((w: any) => w.id)).toEqual([WS_A]);
        const hist = await adapter.getConversationHistory(WS_B, 10);
        expect(hist).toEqual([]);
      } finally {
        log.mockRestore();
        await adapter.close();
      }
    });
  });

  describe('pooled shape: one role, tenant pinned per transaction', () => {
    let p: Pool;
    beforeAll(() => { p = new Pool({ connectionString: roleUrl(POOLED), max: 1 }); });
    afterAll(() => p.end());

    async function pinned<T>(ws: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        if (ws !== null) await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
        const r = await c.query(sql, params);
        await c.query('COMMIT');
        return r.rows as T[];
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    }

    it('unpinned: nothing on any core table (fail closed)', async () => {
      for (const { table } of CORE_RLS_TABLES) {
        const rows = await pinned(null, `SELECT * FROM ${table}`);
        expect(rows).toEqual([]);
      }
    });

    it('pinned to A: exactly A, and a write for B is refused', async () => {
      const ws = await pinned<{ id: string }>(WS_A, `SELECT id FROM workspaces`);
      expect(ws.map((r) => r.id)).toEqual([WS_A]);
      const msgs = await pinned<{ workspace_id: string }>(WS_A, `SELECT DISTINCT workspace_id FROM messages`);
      expect(msgs.map((r) => r.workspace_id)).toEqual([WS_A]);
      await expect(
        pinned(WS_A, `INSERT INTO messages (workspace_id, role, content) VALUES ($1, 'user', 'cross')`, [WS_B]),
      ).rejects.toThrow(/row-level security/);
    });

    it('the pooled adapter (tenantPinned) scopes workspace, message and api-key access by tenant', async () => {
      const adapter = new PostgreSQLAdapter(roleUrl(POOLED), { tenantPinned: true });
      await adapter.initialize();
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await adapter._runMigrations();
        expect(await adapter.getWorkspace(WS_A)).toMatchObject({ id: WS_A });
        expect(await adapter.getWorkspace(WS_B)).toMatchObject({ id: WS_B });
        expect((await adapter.getConversationHistory(WS_A, 10)).every((m: any) => m.workspace_id === WS_A)).toBe(true);
        // API keys: written under tenant A are invisible under tenant B
        await adapter.saveApiKey(userId, 'pooled_p', 'sk-pooled-secret', WS_A);
        expect(await adapter.getApiKey(userId, 'pooled_p', WS_A)).toBe('sk-pooled-secret');
        expect(await adapter.getApiKey(userId, 'pooled_p', WS_B)).toBeNull();
        // An unpinned api-key read is an error, never a cross-tenant answer
        await expect(adapter.getApiKey(userId, 'pooled_p')).rejects.toThrow(/requires a workspace id/);
      } finally {
        log.mockRestore();
        await adapter.close();
      }
    });
  });
});
