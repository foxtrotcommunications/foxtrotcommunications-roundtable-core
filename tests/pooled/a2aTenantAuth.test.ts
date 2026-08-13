/**
 * requireA2aAuth third method (pooled-arthur-plan Q2, step 9):
 * tenant-bound S2S HMAC via X-Control-Plane-Signature/-Timestamp +
 * X-Rt-Workspace, signed string `a2a:${timestamp}:${workspaceId}` — the
 * trusted-app chat ingress for pooled Arthur, replacing guessable
 * per-workspace keys. Bare x-api-key stays rejected pooled, accepted
 * dedicated.
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  pooledDomainType: null,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  bridgeHmacSecret: 'a2a-test-secret',
  a2aApiKey: 'ded-api-key',
  ai: {},
  vertexai: { project: '', location: '' },
};
jest.mock('../../server/config', () => mockConfig);

// The router module pulls in the whole a2a/tools/protocols surface at load
// time — none of it is under test here, so stub the heavy corners.
jest.mock('../../server/db/adapter', () => ({ getAdapter: jest.fn() }));
jest.mock('../../server/a2a/agentCard', () => ({ generateAgentCard: jest.fn() }));
jest.mock('../../server/a2a/server', () => ({
  processMessage: jest.fn(),
  getTask: jest.fn(),
  cancelTask: jest.fn(),
}));
jest.mock('../../server/tools', () => ({
  getAvailableTools: jest.fn(() => []),
  resolveTools: jest.fn(() => ({})),
}));

import crypto from 'crypto';

const router = require('../../server/routes/a2a');

function getAuthMiddleware() {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post
  );
  if (!layer) throw new Error('Could not find POST /a2a route');
  // stack[0] = requireA2aAuth, stack[1] = the JSON-RPC handler
  return layer.route.stack[0].handle;
}

const SECRET = 'a2a-test-secret';

function s2sSig(timestamp: string, workspaceId: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(`a2a:${timestamp}:${workspaceId}`).digest('hex');
}

function createRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(c: number) { res.statusCode = c; return res; },
    json(b: any) { res.body = b; return res; },
  };
  return res;
}

async function run(headers: Record<string, string>) {
  const req: any = { headers, body: { id: 1 } };
  const res = createRes();
  let nexted = false;
  await getAuthMiddleware()(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

describe('requireA2aAuth — tenant-bound S2S HMAC (pooled Arthur)', () => {
  beforeEach(() => {
    mockConfig.pooledArthur = false;
    mockConfig.pooled = false;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('valid s2s headers → next() with req.rtTenant = { workspaceId }', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.pooled = true;
    const ts = Date.now().toString();
    const out = await run({
      'x-control-plane-signature': s2sSig(ts, 'ws-a'),
      'x-control-plane-timestamp': ts,
      'x-rt-workspace': 'ws-a',
    });
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toEqual({ workspaceId: 'ws-a' });
  });

  it('signature minted for tenant A cannot claim tenant B', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.pooled = true;
    const ts = Date.now().toString();
    const out = await run({
      'x-control-plane-signature': s2sSig(ts, 'ws-a'),
      'x-control-plane-timestamp': ts,
      'x-rt-workspace': 'ws-b',
    });
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });

  it('stale timestamp rejected', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.pooled = true;
    const ts = (Date.now() - 6 * 60 * 1000).toString();
    const out = await run({
      'x-control-plane-signature': s2sSig(ts, 'ws-a'),
      'x-control-plane-timestamp': ts,
      'x-rt-workspace': 'ws-a',
    });
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });

  it('tampered signature rejected', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.pooled = true;
    const ts = Date.now().toString();
    const out = await run({
      'x-control-plane-signature': 'f'.repeat(64),
      'x-control-plane-timestamp': ts,
      'x-rt-workspace': 'ws-a',
    });
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });

  it('bare x-api-key stays REJECTED pooled', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.pooled = true;
    const out = await run({ 'x-api-key': 'ded-api-key' });
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });

  it('bare x-api-key stays ACCEPTED dedicated (unchanged behavior)', async () => {
    const out = await run({ 'x-api-key': 'ded-api-key' });
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toBeUndefined();
  });

  it('s2s headers are NOT an auth method on dedicated pods', async () => {
    const ts = Date.now().toString();
    const out = await run({
      'x-control-plane-signature': s2sSig(ts, 'ded-ws'),
      'x-control-plane-timestamp': ts,
      'x-rt-workspace': 'ded-ws',
    });
    expect(out.nexted).toBe(false);
    expect(out.res.statusCode).toBe(401);
  });
});
