/**
 * intent/execute contract consistency (upgrade plan 1.6):
 *   - X-Contract-Id (what auth authorized) must equal token.contractId;
 *   - token.contractVersion must equal the manifest contract's version;
 *   (the read-only intent cache rule is in intentCacheReadOnly.test.ts).
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  pooledDomainType: null,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  bridgeHmacSecret: 'bridge-secret',
  a2aApiKey: 'key',
  ai: {},
  vertexai: { project: '', location: '' },
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/db/adapter', () => ({
  getAdapter: () => ({ getWorkspace: jest.fn().mockResolvedValue({ id: 'ded-ws', name: 'WS', enabled_tools: null }) }),
}));
jest.mock('../../server/a2a/agentCard', () => ({ generateAgentCard: jest.fn() }));
jest.mock('../../server/a2a/server', () => ({ processMessage: jest.fn(), getTask: jest.fn(), cancelTask: jest.fn() }));
const mockFetchManifest = jest.fn();
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: mockFetchManifest }));
const mockExecuteIntentToken = jest.fn();
jest.mock('../../server/protocols/intentExecutor', () => {
  const actual = jest.requireActual('../../server/protocols/intentExecutor');
  return { ...actual, executeIntentToken: (...a: any[]) => mockExecuteIntentToken(...a) };
});

import type { QueryIntent } from '../../server/protocols/intentToken';
import { buildIntentToken } from '../../server/protocols/intentTokenCodec';
import { nonceStore } from '../../server/protocols/nonceStore';

const MASTER = 'consistency-master';
const CONTRACT = { contractId: 'ctr-a', version: 2, status: 'active', allowedActions: ['*'] };
const OTHER = { contractId: 'ctr-b', version: 1, status: 'active', allowedActions: ['*'] };
const intent: QueryIntent = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT 1' }, responseFormat: 'json_table' };

const router = require('../../server/routes/a2a');
function rpcHandler() {
  const layer = router.stack.find((l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post);
  return layer.route.stack[1].handle;
}
function call(headers: Record<string, string>, token: any) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { headers, contract: CONTRACT, body: { jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } } };
    const res: any = {
      statusCode: 200,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ status: res.statusCode, body: b }); return res; },
    };
    rpcHandler()(req, res);
  });
}

const SAVED_MASTER = process.env.ORG_MASTER_SECRET;
beforeEach(() => {
  process.env.ORG_MASTER_SECRET = MASTER;
  mockFetchManifest.mockReset();
  mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [CONTRACT, OTHER], RT_BRIDGES: [] });
  mockExecuteIntentToken.mockReset();
  mockExecuteIntentToken.mockResolvedValue({ status: 'success', executionMs: 1, data: { ok: true } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED_MASTER === undefined) delete process.env.ORG_MASTER_SECRET; else process.env.ORG_MASTER_SECRET = SAVED_MASTER;
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

describe('intent/execute — header contract == token contract', () => {
  it('executes when the header names the token contract and the version matches the manifest', async () => {
    const token = await buildIntentToken(intent, 'ctr-a', 2, MASTER, { encrypt: false });
    const out = await call({ 'x-contract-id': 'ctr-a' }, token);
    expect(out.body.error).toBeUndefined();
    expect(mockExecuteIntentToken).toHaveBeenCalledTimes(1);
  });

  it('rejects a token minted under a different contract than the one authenticated', async () => {
    const token = await buildIntentToken(intent, 'ctr-b', 1, MASTER, { encrypt: false });
    const out = await call({ 'x-contract-id': 'ctr-a' }, token);
    expect(out.body.error.message).toMatch(/does not match the authenticated contract/);
    expect(mockExecuteIntentToken).not.toHaveBeenCalled();
  });

  it('rejects a token whose contractVersion is not the manifest version (rotated key)', async () => {
    const stale = await buildIntentToken(intent, 'ctr-a', 1, MASTER, { encrypt: false }); // manifest says 2
    const out = await call({ 'x-contract-id': 'ctr-a' }, stale);
    expect(out.body.error.message).toMatch(/contractVersion 1 does not match manifest version 2/);
    expect(mockExecuteIntentToken).not.toHaveBeenCalled();
  });
});
