// tests/integration/bridgeReceive.test.ts — Bridge communication integration tests
//
// Tests the POST /api/bridge/receive endpoint for HMAC signature verification,
// timestamp freshness, contract enforcement, and input validation.
//
// Mocks: workspaceService (DB), config module
// Real:  crypto (HMAC-SHA256, timingSafeEqual)

const crypto = require('crypto');

// ─── Mock Dependencies ────────────────────────────────────────────

// Mock workspaceService before requiring the router
jest.mock('../../server/services/workspaceService', () => ({
  saveMessage: jest.fn().mockResolvedValue({
    id: 1,
    role: 'user',
    content: 'test message',
    created_at: new Date().toISOString(),
  }),
  getWorkspace: jest.fn().mockResolvedValue({
    ai_provider: 'vertexai',
    ai_model: 'gemini-2.5-flash',
    tools_enabled: true,
  }),
}));

// Mock config — provide a known HMAC secret
jest.mock('../../server/config', () => ({
  bridgeHmacSecret: 'test-bridge-secret',
  workspaceId: 'test-workspace',
  workspaceName: 'Test Workspace',
}));

// ─── Test Helpers ─────────────────────────────────────────────────

const BRIDGE_SECRET = 'test-bridge-secret';

function makeSignature(taskId: string, timestamp: string, contractId: string, action: string): string {
  return crypto
    .createHmac('sha256', BRIDGE_SECRET)
    .update(`${taskId}:${timestamp}:${contractId}:${action}`)
    .digest('hex');
}

function makeContractToken(contractId: string, allowedActions: string[]): string {
  const sorted = [...allowedActions].sort().join(',');
  return crypto
    .createHmac('sha256', BRIDGE_SECRET)
    .update(`${contractId}:${sorted}`)
    .digest('hex');
}

function makeValidRequest(overrides: Record<string, unknown> = {}) {
  const taskId = 'task-abc-123';
  const timestamp = Date.now().toString();
  const action = 'message';
  const contractId = 'test-contract';
  const allowedActions = ['message', 'delegate'];
  const contractToken = makeContractToken(contractId, allowedActions);

  return {
    taskId,
    bridgeId: 'bridge-001',
    contractId,
    contractToken,
    action,
    content: 'Hello from remote workspace',
    sourceWorkspace: { id: 'remote-ws', name: 'Remote Workspace' },
    timestamp,
    signature: makeSignature(taskId, timestamp, contractId, action),
    ...overrides,
  };
}

// ─── Express Mocking ──────────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  body: any;
  status: (code: number) => MockResponse;
  json: (data: any) => MockResponse;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// ─── Import Router ────────────────────────────────────────────────

// We need to test the route handler directly. Express Router exports a
// middleware; we'll extract the handler from the router stack.
const router = require('../../server/routes/bridgeReceive');

function getReceiveHandler() {
  // Express Router stores routes in router.stack
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === '/receive' && l.route.methods.post
  );
  if (!layer) throw new Error('Could not find POST /receive handler in router');
  return layer.route.stack[0].handle;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Bridge Receive — HMAC Authentication', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getReceiveHandler();
  });

  beforeEach(() => {
    // Reset RT_CONTRACTS env var to empty before each test
    delete process.env.RT_CONTRACTS;
    // Suppress console output in tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should accept a valid HMAC signature', async () => {
    // Set up RT_CONTRACTS so contract enforcement passes
    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId: 'test-contract', allowedActions: ['message', 'delegate'] },
    ]);
    const body = makeValidRequest();
    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should reject a missing signature with 401', async () => {
    const body = makeValidRequest();
    delete (body as any).signature;

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Invalid bridge signature/);
  });

  it('should reject an invalid signature with 401', async () => {
    const body = makeValidRequest();
    body.signature = 'a'.repeat(64); // wrong HMAC

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Invalid bridge signature/);
  });

  it('should reject an expired timestamp (>5 min old) with 401', async () => {
    const taskId = 'task-expired';
    const timestamp = (Date.now() - 6 * 60 * 1000).toString(); // 6 minutes ago
    const action = 'message';
    const contractId = 'test-contract';

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions: ['message', 'delegate'] },
    ]);

    const body = makeValidRequest({
      taskId,
      timestamp,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/timestamp expired/);
  });

  it('should accept a timestamp within the 5-minute window', async () => {
    const taskId = 'task-recent';
    const timestamp = (Date.now() - 4 * 60 * 1000).toString(); // 4 min ago
    const action = 'message';
    const contractId = 'test-contract';
    const allowedActions = ['message', 'delegate'];
    const contractToken = makeContractToken(contractId, allowedActions);

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions },
    ]);

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      contractToken,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Bridge Receive — Contract Enforcement', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getReceiveHandler();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RT_CONTRACTS;
    jest.restoreAllMocks();
  });

  it('should reject when contractId is provided but not in local manifest', async () => {
    process.env.RT_CONTRACTS = JSON.stringify([]);

    const taskId = 'task-no-manifest';
    const timestamp = Date.now().toString();
    const contractId = 'unknown-contract';
    const action = 'message';

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      action,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('should reject when action is not in contract allowedActions', async () => {
    const contractId = 'contract-restricted';
    const allowedActions = ['message']; // 'delegate' not allowed

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions },
    ]);

    const taskId = 'task-forbidden-action';
    const timestamp = Date.now().toString();
    const action = 'delegate'; // not in allowedActions
    const contractToken = makeContractToken(contractId, allowedActions);

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      contractToken,
      action,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACTION_NOT_PERMITTED');
  });

  it('should accept when action IS in contract allowedActions', async () => {
    const contractId = 'contract-allowed';
    const allowedActions = ['message', 'delegate'];

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions },
    ]);

    const taskId = 'task-ok';
    const timestamp = Date.now().toString();
    const action = 'message';
    const contractToken = makeContractToken(contractId, allowedActions);

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      contractToken,
      action,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should reject when contractToken is invalid (tampered allowedActions)', async () => {
    const contractId = 'contract-tampered';
    const realActions = ['message'];

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions: realActions },
    ]);

    const taskId = 'task-tampered';
    const timestamp = Date.now().toString();
    const action = 'message';
    // Build a token from DIFFERENT actions than what's in the manifest
    const fakeToken = makeContractToken(contractId, ['message', 'delegate', 'admin']);

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      contractToken: fakeToken,
      action,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CONTRACT_TOKEN_INVALID');
  });

  it('should reject when contractToken is missing', async () => {
    const contractId = 'contract-no-token';
    const allowedActions = ['message'];

    process.env.RT_CONTRACTS = JSON.stringify([
      { contractId, allowedActions },
    ]);

    const taskId = 'task-no-token';
    const timestamp = Date.now().toString();
    const action = 'message';

    const body = makeValidRequest({
      taskId,
      timestamp,
      contractId,
      contractToken: undefined,
      action,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CONTRACT_TOKEN_INVALID');
  });
});

describe('Bridge Receive — Unknown Actions', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getReceiveHandler();
  });

  beforeEach(() => {
    delete process.env.RT_CONTRACTS;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 403 for an unknown action without contract', async () => {
    const taskId = 'task-unknown-action';
    const timestamp = Date.now().toString();
    const action = 'unknown_action';
    const contractId = '';

    const body = makeValidRequest({
      taskId,
      timestamp,
      action,
      contractId,
      contractToken: undefined,
      signature: makeSignature(taskId, timestamp, contractId, action),
    });

    const res = createMockRes();
    await handler({ body }, res);

    // Without a contract, the enforcement gate rejects before reaching action dispatch
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NO_CONTRACT');
  });
});
