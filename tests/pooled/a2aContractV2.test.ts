/**
 * requireA2aAuth contract path with v2 signatures (SIGNING_SPEC.md):
 * the headers an upgraded intent_bridge/bridge_workspace emit are accepted,
 * body drift and replay are rejected, v1 keeps working until
 * RT_HMAC_ACCEPT_V1=false, and the pooled tenant binding carries over.
 *
 * Also covers bridgeReceive's v2 header path (routePath 'bridge/receive').
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  pooledDomainType: null,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  bridgeHmacSecret: 'a2a-test-secret',
  a2aApiKey: '',
  ai: {},
  vertexai: { project: '', location: '' },
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/db/adapter', () => ({ getAdapter: jest.fn() }));
jest.mock('../../server/a2a/agentCard', () => ({ generateAgentCard: jest.fn() }));
jest.mock('../../server/a2a/server', () => ({ processMessage: jest.fn(), getTask: jest.fn(), cancelTask: jest.fn() }));
jest.mock('../../server/tools', () => ({ getAvailableTools: jest.fn(() => []), resolveTools: jest.fn(() => ({})) }));
const mockFetchManifest = jest.fn();
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: mockFetchManifest }));
const mockGetOrgMasterSecret = jest.fn();
jest.mock('../../server/tenantCredentials', () => ({ getOrgMasterSecret: mockGetOrgMasterSecret }));
jest.mock('../../server/services/workspaceService', () => ({}));

import crypto from 'crypto';
const { deriveContractKey, signRequest, signRequestV2 } = require('../../server/utils/contractAuth');
const s2s = require('../../server/utils/s2sSig');
import { nonceStore } from '../../server/protocols/nonceStore';

const MASTER = 'org-master-secret';
const CONTRACT = { contractId: 'ctr_v2', version: 1, status: 'active', allowedActions: ['*'] };
const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token: { x: 1 } } });

const router = require('../../server/routes/a2a');
function authMw() {
  const layer = router.stack.find((l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post);
  return layer.route.stack[0].handle;
}

function run(headers: Record<string, string>, rawBody: string = BODY) {
  return new Promise<{ req: any; status: number; body: any; nexted: boolean }>((resolve) => {
    const req: any = { headers, body: JSON.parse(rawBody), rawBody: Buffer.from(rawBody) };
    const res: any = {
      statusCode: 200,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ req, status: res.statusCode, body: b, nexted: false }); return res; },
    };
    authMw()(req, res, () => resolve({ req, status: 200, body: null, nexted: true }));
  });
}

async function v2Headers(opts: { tenantWsId?: string; body?: string; action?: string } = {}) {
  const key = await deriveContractKey(MASTER, CONTRACT.contractId, CONTRACT.version);
  const action = opts.action || 'intent_execute';
  const signed = signRequestV2(key, { contractId: CONTRACT.contractId, action, body: opts.body ?? BODY, tenantWsId: opts.tenantWsId });
  const h: Record<string, string> = {
    'x-contract-id': CONTRACT.contractId,
    'x-contract-action': action,
    ...Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v as string])),
  };
  if (opts.tenantWsId) h['x-rt-tenant'] = opts.tenantWsId;
  return h;
}

const SAVED = process.env.RT_HMAC_ACCEPT_V1;
const SAVED_MASTER = process.env.ORG_MASTER_SECRET;
beforeEach(() => {
  delete process.env.RT_HMAC_ACCEPT_V1;
  process.env.ORG_MASTER_SECRET = MASTER;
  mockConfig.pooled = false; mockConfig.pooledArthur = false; mockConfig.pooledDomainType = null;
  mockFetchManifest.mockReset();
  mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [CONTRACT], RT_BRIDGES: [], orgId: 'org-a' });
  mockGetOrgMasterSecret.mockReset();
  mockGetOrgMasterSecret.mockResolvedValue(MASTER);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.RT_HMAC_ACCEPT_V1; else process.env.RT_HMAC_ACCEPT_V1 = SAVED;
  if (SAVED_MASTER === undefined) delete process.env.ORG_MASTER_SECRET; else process.env.ORG_MASTER_SECRET = SAVED_MASTER;
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

describe('requireA2aAuth — contract v2 (dedicated)', () => {
  it('accepts a v2 contract signature and attaches req.contract', async () => {
    const out = await run(await v2Headers());
    expect(out.nexted).toBe(true);
    expect(out.req.contract.contractId).toBe('ctr_v2');
  });

  it('rejects when the body was altered after signing', async () => {
    const out = await run(await v2Headers(), BODY.replace('"x":1', '"x":2'));
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
    expect(out.body.error.message).toMatch(/Contract signature invalid/);
  });

  it('rejects a replay of the same signed request', async () => {
    const h = await v2Headers();
    expect((await run(h)).nexted).toBe(true);
    const again = await run(h);
    expect(again.nexted).toBe(false);
    expect(again.status).toBe(401);
    expect(again.body.error.message).toMatch(/Replay/);
  });

  it('still accepts v1 by default and refuses it under RT_HMAC_ACCEPT_V1=false', async () => {
    const key = await deriveContractKey(MASTER, CONTRACT.contractId, 1);
    const ts = Date.now().toString();
    const v1 = {
      'x-contract-id': CONTRACT.contractId,
      'x-contract-action': 'intent_execute',
      'x-contract-timestamp': ts,
      'x-contract-signature': signRequest(key, CONTRACT.contractId, ts, 'intent_execute'),
    };
    expect((await run(v1)).nexted).toBe(true);
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    const out = await run(v1);
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
    expect(out.body.error.message).toMatch(/v1 no longer accepted/);
    expect((await run(await v2Headers())).nexted).toBe(true);
  });
});

describe('requireA2aAuth — contract v2 (pooled, tenant-bound)', () => {
  beforeEach(() => { mockConfig.pooled = true; mockConfig.pooledDomainType = 'checking'; });

  it('accepts when the tenant in the signature matches X-Rt-Tenant', async () => {
    const out = await run(await v2Headers({ tenantWsId: 'ws-a' }));
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant.workspaceId).toBe('ws-a');
    expect(mockFetchManifest).toHaveBeenCalledWith('ws-a');
  });

  it('rejects a signature minted for tenant A presented as tenant B', async () => {
    const h = await v2Headers({ tenantWsId: 'ws-a' });
    h['x-rt-tenant'] = 'ws-b';
    const out = await run(h);
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });
});

describe('bridgeReceive — v2 header path', () => {
  const receive = () => {
    const r = require('../../server/routes/bridgeReceive');
    const layer = r.stack.find((l: any) => l.route && l.route.path === '/receive');
    return layer.route.stack[0].handle;
  };
  const SECRET = 'a2a-test-secret';

  function call(headers: Record<string, string>, bodyObj: any, rawBody = JSON.stringify(bodyObj)) {
    return new Promise<{ status: number; body: any }>((resolve) => {
      const res: any = {
        statusCode: 200,
        status(c: number) { res.statusCode = c; return res; },
        json(b: any) { resolve({ status: res.statusCode, body: b }); return res; },
      };
      receive()({ headers, body: bodyObj, rawBody: Buffer.from(rawBody) }, res);
    });
  }

  const payload = { taskId: 't1', contractId: 'nope', action: 'message', content: 'hi', sourceWorkspace: { name: 'src' }, timestamp: Date.now().toString() };

  it('a valid v2 signature gets past auth (then fails on the unknown contract, proving auth ran)', async () => {
    const raw = JSON.stringify(payload);
    const h = s2s.signPathV2({ secret: SECRET, routePath: 'bridge/receive', body: raw }).headers;
    mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [], RT_BRIDGES: [] });
    const out = await call(h, payload, raw);
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('a v2 signature over a different body is rejected before anything else', async () => {
    const raw = JSON.stringify(payload);
    const h = s2s.signPathV2({ secret: SECRET, routePath: 'bridge/receive', body: raw }).headers;
    const out = await call(h, { ...payload, content: 'tampered' }, JSON.stringify({ ...payload, content: 'tampered' }));
    expect(out.status).toBe(401);
    expect(out.body.error).toMatch(/Invalid HMAC signature/);
  });

  it('v1 body signature is refused once RT_HMAC_ACCEPT_V1=false', async () => {
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    const sig = crypto.createHmac('sha256', SECRET).update(`${payload.taskId}:${payload.timestamp}:${payload.contractId}:${payload.action}`).digest('hex');
    const out = await call({}, { ...payload, signature: sig });
    expect(out.status).toBe(401);
    expect(out.body.error).toBe('HMAC v1 no longer accepted');
  });
});
