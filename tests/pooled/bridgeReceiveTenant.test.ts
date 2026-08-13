/**
 * bridgeReceive tenant extension (pooled-arthur-plan Q5).
 * Old signed string (no X-Rt-Workspace) stays byte-identical for dedicated
 * pods; with the header, the tenant is bound in as a trailing component and
 * everything downstream (manifest gate, saves, channels) scopes to it.
 * pooledArthur REQUIRES the header.
 */

const crypto = require('crypto');

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  bridgeHmacSecret: 'test-bridge-secret',
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
};
jest.mock('../../server/config', () => mockConfig);

const mockScopedSaveMessage = jest.fn();
const mockScopedGetWorkspace = jest.fn();
const mockScoped = jest.fn((wsId: string) => ({
  workspaceId: wsId,
  saveMessage: mockScopedSaveMessage,
  getWorkspace: mockScopedGetWorkspace,
}));
const mockSingletonSaveMessage = jest.fn();
jest.mock('../../server/services/workspaceService', () => ({
  saveMessage: mockSingletonSaveMessage,
  getWorkspace: jest.fn().mockResolvedValue({ ai_provider: 'vertexai', tools_enabled: true }),
  scoped: mockScoped,
}));

const mockFetchManifest = jest.fn();
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: mockFetchManifest }));

const SECRET = 'test-bridge-secret';
const ALLOWED = ['message', 'delegate', 'result'];

function contractToken(contractId: string, allowedActions: string[] = ALLOWED): string {
  const sorted = [...allowedActions].sort().join(',');
  return crypto.createHmac('sha256', SECRET).update(`${contractId}:${sorted}`).digest('hex');
}

function oldSig(taskId: string, ts: string, contractId: string, action: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${taskId}:${ts}:${contractId}:${action}`).digest('hex');
}

function tenantSig(taskId: string, ts: string, contractId: string, action: string, wsId: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${taskId}:${ts}:${contractId}:${action}:${wsId}`).digest('hex');
}

function makeBody(overrides: Record<string, unknown> = {}) {
  const taskId = 'task-1';
  const timestamp = Date.now().toString();
  const contractId = 'contract-1';
  const action = 'result';
  return {
    taskId,
    contractId,
    contractToken: contractToken(contractId),
    action,
    content: 'hello over the bridge',
    sourceWorkspace: { id: 'src-ws', name: 'Source' },
    timestamp,
    signature: oldSig(taskId, timestamp, contractId, action),
    ...overrides,
  };
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

const router = require('../../server/routes/bridgeReceive');

function getReceiveHandler() {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === '/receive' && l.route.methods.post
  );
  if (!layer) throw new Error('Could not find POST /receive handler');
  return layer.route.stack[0].handle;
}

describe('bridgeReceive — tenant signature matrix', () => {
  const handler = getReceiveHandler();

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.pooledArthur = false;
    mockSingletonSaveMessage.mockResolvedValue({ id: 1, role: 'user', content: 'x' });
    mockScopedSaveMessage.mockResolvedValue({ id: 2, role: 'user', content: 'x' });
    mockScopedGetWorkspace.mockResolvedValue({ id: 'ws-a', name: 'Arthur' });
    mockFetchManifest.mockResolvedValue({
      RT_CONTRACTS: [{ contractId: 'contract-1', allowedActions: ALLOWED }],
      orgId: 'org-a',
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dedicated: old signed string, no header — accepted, singleton save', async () => {
    const res = createRes();
    await handler({ body: makeBody() }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSingletonSaveMessage).toHaveBeenCalled();
    expect(mockScoped).not.toHaveBeenCalled();
    // Dedicated manifest fetch is the process's own workspace (no arg)
    expect(mockFetchManifest).toHaveBeenCalledWith(undefined);
  });

  it('tenant header + extended signature — accepted, scoped save + tenant manifest', async () => {
    const taskId = 'task-t';
    const ts = Date.now().toString();
    const body = makeBody({ taskId, timestamp: ts, signature: tenantSig(taskId, ts, 'contract-1', 'result', 'ws-a') });
    const res = createRes();
    await handler({ body, headers: { 'x-rt-workspace': 'ws-a' } }, res);
    expect(res.statusCode).toBe(200);
    expect(mockScoped).toHaveBeenCalledWith('ws-a');
    expect(mockScopedSaveMessage).toHaveBeenCalled();
    expect(mockSingletonSaveMessage).not.toHaveBeenCalled();
    expect(mockFetchManifest).toHaveBeenCalledWith('ws-a');
  });

  it('tenant header + OLD signed string — rejected (no downgrade)', async () => {
    const res = createRes();
    await handler({ body: makeBody(), headers: { 'x-rt-workspace': 'ws-a' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Invalid bridge signature/);
  });

  it('signature minted for tenant A presented with tenant B header — rejected', async () => {
    const taskId = 'task-x';
    const ts = Date.now().toString();
    const body = makeBody({ taskId, timestamp: ts, signature: tenantSig(taskId, ts, 'contract-1', 'result', 'ws-a') });
    const res = createRes();
    await handler({ body, headers: { 'x-rt-workspace': 'ws-b' } }, res);
    expect(res.statusCode).toBe(401);
    expect(mockScoped).not.toHaveBeenCalled();
  });

  it('pooledArthur REQUIRES the tenant header (401 without)', async () => {
    mockConfig.pooledArthur = true;
    const res = createRes();
    await handler({ body: makeBody(), headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/X-Rt-Workspace/);
  });

  it('pooledArthur + header + extended signature — accepted', async () => {
    mockConfig.pooledArthur = true;
    const taskId = 'task-p';
    const ts = Date.now().toString();
    const body = makeBody({ taskId, timestamp: ts, signature: tenantSig(taskId, ts, 'contract-1', 'result', 'ws-a') });
    const res = createRes();
    await handler({ body, headers: { 'x-rt-workspace': 'ws-a' } }, res);
    expect(res.statusCode).toBe(200);
    expect(mockScoped).toHaveBeenCalledWith('ws-a');
  });

  it('tenant contract gate rejects a contract the TENANT manifest does not list', async () => {
    mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [], orgId: 'org-a' });
    const taskId = 'task-nc';
    const ts = Date.now().toString();
    const body = makeBody({ taskId, timestamp: ts, signature: tenantSig(taskId, ts, 'contract-1', 'result', 'ws-a') });
    const res = createRes();
    await handler({ body, headers: { 'x-rt-workspace': 'ws-a' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });
});
