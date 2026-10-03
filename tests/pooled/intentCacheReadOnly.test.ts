/**
 * Intent cache serves only read-only work (upgrade plan 1.6): a tool or
 * capability without `readOnly: true` is assumed side-effecting and is
 * re-executed every time; a readOnly query is served from cache on repeat.
 */

jest.mock('../../server/config', () => ({
  pooled: false, pooledArthur: false, pooledDomainType: null,
  workspaceId: 'ws-cache', workspaceName: 'cache', bridgeHmacSecret: 's', ai: {},
  vertexai: { project: '', location: '' }, googleSearch: { apiKey: '', engineId: '' },
  snowflake: {}, databricks: {}, ollama: { host: '' },
}));

const MASTER = 'cache-master';

describe('intent cache — read-only only', () => {
  // Fresh module graph with the REAL executor and a registry that marks
  // readOnly explicitly.
  function loadExecutor() {
    let mod: any;
    jest.isolateModules(() => {
      jest.doMock('../../server/tools/index', () => ({
        tools: {
          query_bigquery: { name: 'query_bigquery', readOnly: true },
          write_file: { name: 'write_file' },
        },
        getDynamicTools: () => ({}),
        executeTool: jest.fn().mockResolvedValue({ ok: true }),
        resolveTools: jest.fn().mockReturnValue({ query_bigquery: { readOnly: true }, write_file: {} }),
        getAvailableTools: jest.fn().mockReturnValue([]),
      }));
      mod = {
        exec: require('../../server/protocols/intentExecutor'),
        tools: require('../../server/tools/index'),
        cache: require('../../server/protocols/intentCache').intentCache,
        caps: require('../../server/protocols/capabilityRegistry').capabilityRegistry,
        codec: require('../../server/protocols/intentTokenCodec'),
        auth: require('../../server/utils/contractAuth'),
      };
    });
    return mod;
  }

  it('isIntentCacheable: readOnly tools and readOnly capabilities only', () => {
    const { exec, caps } = loadExecutor();
    expect(exec.isIntentCacheable({ op: 'query', tool: 'query_bigquery', params: {}, responseFormat: 'json' })).toBe(true);
    expect(exec.isIntentCacheable({ op: 'tool_call', tool: 'write_file', args: {} })).toBe(false);
    expect(exec.isIntentCacheable({ op: 'tool_call', tool: 'nope', args: {} })).toBe(false);
    expect(exec.isIntentCacheable({ op: 'discover', scope: 'tools' })).toBe(false);
    expect(exec.isIntentCacheable({ op: 'aggregate', steps: [], reduce: 'concat' })).toBe(false);
    caps.register({ name: 'test.readonlyCap', description: 'r', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, readOnly: true }, async () => ({}));
    caps.register({ name: 'test.writeCap', description: 'w', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, async () => ({}));
    expect(exec.isIntentCacheable({ op: 'capability', name: 'test.readonlyCap', input: {} })).toBe(true);
    expect(exec.isIntentCacheable({ op: 'capability', name: 'test.writeCap', input: {} })).toBe(false);
    expect(exec.isIntentCacheable({ op: 'capability', name: 'test.missing', input: {} })).toBe(false);
  });

  it('a read-only query is served from cache on repeat; a side-effecting tool_call is re-executed', async () => {
    const { exec, tools, cache, codec, auth } = loadExecutor();
    cache.clear();
    const ctx = {
      contractKey: await auth.deriveContractKey(MASTER, 'ctr-cache', 1),
      contract: { contractId: 'ctr-cache', allowedActions: ['*'], status: 'active' },
      workspaceConfig: { workspaceId: 'ws-cache' },
      enabledToolNames: null,
    };
    const q = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT cache_probe FROM t' }, responseFormat: 'json_table' };
    const t1 = await codec.buildIntentToken(q, 'ctr-cache', 1, MASTER, { encrypt: false });
    const t2 = await codec.buildIntentToken(q, 'ctr-cache', 1, MASTER, { encrypt: false });
    const r1 = await exec.executeIntentToken(t1, ctx);
    const r2 = await exec.executeIntentToken(t2, ctx);
    expect(r1.status).toBe('success');
    expect(r1.cached).toBeUndefined();
    expect(r2.cached).toBe(true);
    expect(tools.executeTool).toHaveBeenCalledTimes(1);

    tools.executeTool.mockClear();
    const w = { op: 'tool_call', tool: 'write_file', args: { path: '/p', content: 'x' } };
    const w1 = await codec.buildIntentToken(w, 'ctr-cache', 1, MASTER, { encrypt: false });
    const w2 = await codec.buildIntentToken(w, 'ctr-cache', 1, MASTER, { encrypt: false });
    const s1 = await exec.executeIntentToken(w1, ctx);
    const s2 = await exec.executeIntentToken(w2, ctx);
    expect(s1.status).toBe('success');
    expect(s2.status).toBe('success');
    expect(s2.cached).toBeUndefined();
    expect(tools.executeTool).toHaveBeenCalledTimes(2);
  });
});
