/**
 * Pooled Arthur SSO branch (pooled-arthur-plan Q1a).
 * Pooled: the JWT's workspace_id claim IS the tenant binding — required,
 * must name a known workspace row, and lands on req.session.workspaceId.
 * Password/demo auth is refused (403 'SSO required').
 * Dedicated: the old equality check, byte-identical behavior.
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  ssoJwtSecret: 'sso-test-secret',
  sessionSecret: 'sess-secret',
  bridgeHmacSecret: 'bridge-secret',
  embedMode: false,
};
jest.mock('../../server/config', () => mockConfig);

const mockGetWorkspace = jest.fn();
const mockUpsertUserBySsoId = jest.fn();
jest.mock('../../server/db/adapter', () => ({
  getAdapter: () => ({
    getWorkspace: mockGetWorkspace,
    upsertUserBySsoId: mockUpsertUserBySsoId,
    getUserByUsername: jest.fn(),
    getUserById: jest.fn(),
    createUser: jest.fn(),
    audit: jest.fn().mockResolvedValue(undefined),
  }),
}));

import crypto from 'crypto';

const router = require('../../server/routes/auth');

function getHandler(path: string, method: 'get' | 'post') {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} handler`);
  // Last handler in the stack (skips route-level middleware like requireAuth)
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mintToken(payload: Record<string, unknown>, secret = 'sso-test-secret'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

interface MockRes {
  statusCode: number;
  body: any;
  redirectedTo: string | null;
  status: (c: number) => MockRes;
  json: (b: any) => MockRes;
  redirect: (d: string) => MockRes;
}

function createRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    redirectedTo: null,
    status(c: number) { res.statusCode = c; return res; },
    json(b: any) { res.body = b; return res; },
    redirect(d: string) { res.redirectedTo = d; return res; },
  };
  return res;
}

function ssoReq(token: string) {
  return { query: { token }, session: {} as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.pooledArthur = false;
  mockUpsertUserBySsoId.mockResolvedValue({ id: 7, username: 'user@example.com', display_name: 'User' });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('pooled Arthur: password/demo auth refused', () => {
  it.each(['/login', '/register', '/demo'])('%s returns 403 SSO required when pooledArthur', async (path) => {
    mockConfig.pooledArthur = true;
    const res = createRes();
    await getHandler(path, 'post')({ body: {}, session: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('SSO required');
  });

  it('/login is NOT SSO-gated when dedicated', async () => {
    const res = createRes();
    await getHandler('/login', 'post')({ body: {}, session: {} }, res);
    expect(res.statusCode).toBe(400); // missing credentials — old validation, not the SSO gate
    expect(res.body.error).not.toBe('SSO required');
  });
});

describe('pooled Arthur: /sso workspace claim', () => {
  it('binds the session to the claimed workspace when its row exists', async () => {
    mockConfig.pooledArthur = true;
    mockGetWorkspace.mockResolvedValue({ id: 'ws-a', name: 'Arthur' });
    const token = mintToken({ sub: 'sso-1', email: 'user@example.com', workspace_id: 'ws-a', exp: Date.now() / 1000 + 60 });
    const req = ssoReq(token);
    const res = createRes();
    await getHandler('/sso', 'get')(req, res);

    expect(mockGetWorkspace).toHaveBeenCalledWith('ws-a');
    expect(res.redirectedTo).toBe('/');
    expect(req.session.workspaceId).toBe('ws-a');
    expect(req.session.userId).toBe(7);
  });

  it('fails closed when the workspace claim is missing', async () => {
    mockConfig.pooledArthur = true;
    const token = mintToken({ sub: 'sso-1', email: 'user@example.com', exp: Date.now() / 1000 + 60 });
    const res = createRes();
    await getHandler('/sso', 'get')(ssoReq(token), res);
    expect(res.statusCode).toBe(403);
    expect(mockUpsertUserBySsoId).not.toHaveBeenCalled();
  });

  it('fails closed when the claimed workspace has no row', async () => {
    mockConfig.pooledArthur = true;
    mockGetWorkspace.mockResolvedValue(null);
    const token = mintToken({ sub: 'sso-1', email: 'user@example.com', workspace_id: 'ws-ghost', exp: Date.now() / 1000 + 60 });
    const res = createRes();
    await getHandler('/sso', 'get')(ssoReq(token), res);
    expect(res.statusCode).toBe(403);
    expect(mockUpsertUserBySsoId).not.toHaveBeenCalled();
  });

  it('still rejects a bad signature when pooled', async () => {
    mockConfig.pooledArthur = true;
    const token = mintToken({ sub: 'sso-1', workspace_id: 'ws-a', exp: Date.now() / 1000 + 60 }, 'wrong-secret');
    const res = createRes();
    await getHandler('/sso', 'get')(ssoReq(token), res);
    expect(res.statusCode).toBe(401);
  });
});

describe('dedicated: /sso equality check unchanged', () => {
  it('rejects a token minted for another workspace', async () => {
    const token = mintToken({ sub: 'sso-1', email: 'user@example.com', workspace_id: 'other-ws', exp: Date.now() / 1000 + 60 });
    const res = createRes();
    await getHandler('/sso', 'get')(ssoReq(token), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not valid for this workspace/);
    // Dedicated never reads a workspace row for the claim
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it('accepts a matching claim and does NOT set session.workspaceId', async () => {
    const token = mintToken({ sub: 'sso-1', email: 'user@example.com', workspace_id: 'ded-ws', exp: Date.now() / 1000 + 60 });
    const req = ssoReq(token);
    const res = createRes();
    await getHandler('/sso', 'get')(req, res);
    expect(res.redirectedTo).toBe('/');
    expect(req.session.userId).toBe(7);
    expect(req.session.workspaceId).toBeUndefined();
  });
});
