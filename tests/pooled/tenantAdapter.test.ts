/**
 * Tenant-pinned adapter path. Non-pinned mode must be byte-identical to the
 * plain pool; pinned mode wraps every workspace-scoped statement in
 * BEGIN + set_config(app.workspace_id) + COMMIT on a single client.
 */

const PostgreSQLAdapter = require('../../server/db/adapters/postgresql');

function fakePool() {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [{ id: 7 }] });
    },
    release: jest.fn(),
  };
  return {
    calls,
    client,
    query: (sql: string, params?: any[]) => {
      calls.push({ sql: `POOL:${sql}`, params });
      return Promise.resolve({ rows: [{ id: 7 }] });
    },
    connect: () => Promise.resolve(client),
  };
}

describe('tenant-pinned adapter', () => {
  it('pinned: wraps statements in a pinned transaction', async () => {
    const adapter = new PostgreSQLAdapter('postgresql://x', { tenantPinned: true });
    const pool = fakePool();
    adapter.pool = pool;
    await adapter.recordUsage('ws-a', 1, 'vertexai', 'm', 1, 2, 3, 0, []);
    const sqls = pool.calls.map(c => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain("set_config('app.workspace_id', $1, true)");
    expect(pool.calls[1].params).toEqual(['ws-a']);
    expect(sqls[2]).toContain('INSERT INTO workspace_usage');
    expect(sqls[3]).toBe('COMMIT');
    expect(pool.client.release).toHaveBeenCalled();
  });

  it('pinned: refuses an empty workspace id', async () => {
    const adapter = new PostgreSQLAdapter('postgresql://x', { tenantPinned: true });
    adapter.pool = fakePool();
    await expect(adapter.getMonthlyTokens('')).rejects.toThrow(/workspace id/);
  });

  it('non-pinned: plain pool queries, no transaction (dedicated invariance)', async () => {
    const adapter = new PostgreSQLAdapter('postgresql://x');
    const pool = fakePool();
    adapter.pool = pool;
    await adapter.recordUsage('ws-a', 1, 'vertexai', 'm', 1, 2, 3, 0, []);
    const sqls = pool.calls.map(c => c.sql);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/^POOL:/);
    expect(sqls[0]).not.toContain('BEGIN');
  });

  it('pinned: rolls back on statement failure', async () => {
    const adapter = new PostgreSQLAdapter('postgresql://x', { tenantPinned: true });
    const calls: string[] = [];
    adapter.pool = {
      connect: () => Promise.resolve({
        query: (sql: string) => {
          calls.push(sql);
          if (sql.includes('INSERT')) return Promise.reject(new Error('boom'));
          return Promise.resolve({ rows: [] });
        },
        release: () => {},
      }),
    };
    await expect(adapter.recordUsage('ws-a', 1, 'p', 'm', 1, 2, 3, 0, [])).rejects.toThrow('boom');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });
});
