/**
 * message/send through allowedActions + the delegated tool profile
 * (upgrade plan 1.5).
 *
 *   - A contract-authenticated message/send must be signed with a message
 *     action (message | delegate | message_send) that the contract grants.
 *     `capability:x` being allowed does not entitle a caller to a chat turn.
 *   - Delegated turns (contract message/send; relayed bridge delegations)
 *     run under workspaceConfig.toolProfile = 'delegated'.
 *   - The trusted app's own ingress (no contract) keeps the normal profile.
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  pooledDomainType: null,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  bridgeHmacSecret: 'bridge-secret',
  a2aApiKey: 'key',
  ai: { openai: 'k' },
  vertexai: { project: '', location: '' },
};
jest.mock('../../server/config', () => mockConfig);

const mockGetWorkspace = jest.fn();
jest.mock('../../server/db/adapter', () => ({ getAdapter: () => ({ getWorkspace: mockGetWorkspace }) }));
jest.mock('../../server/a2a/agentCard', () => ({ generateAgentCard: jest.fn() }));
const mockProcessMessage = jest.fn();
jest.mock('../../server/a2a/server', () => ({ processMessage: mockProcessMessage, getTask: jest.fn(), cancelTask: jest.fn() }));
jest.mock('../../server/tools', () => ({ getAvailableTools: jest.fn(() => []), resolveTools: jest.fn(() => ({})) }));
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: jest.fn() }));

// bridgeReceive dependencies
const mockStreamCompletion = jest.fn();
jest.mock('../../server/services/aiProvider', () => ({ streamCompletion: mockStreamCompletion }));
const mockSvc = {
  saveMessage: jest.fn().mockResolvedValue({ id: 1 }),
  getWorkspace: jest.fn().mockResolvedValue({ name: 'Dedicated WS', enabled_tools: null }),
  scoped: jest.fn(),
};
jest.mock('../../server/services/workspaceService', () => mockSvc);

import crypto from 'crypto';

const a2aRouter = require('../../server/routes/a2a');
function rpcHandler() {
  const layer = a2aRouter.stack.find((l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post);
  return layer.route.stack[1].handle; // [0] = requireA2aAuth, [1] = JSON-RPC handler
}

function sendMessage(opts: { contract?: any; action?: string }) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.action) headers['x-contract-action'] = opts.action;
    const req: any = {
      headers,
      body: { jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } } },
    };
    if (opts.contract) req.contract = opts.contract;
    const res: any = {
      statusCode: 200,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ status: res.statusCode, body: b }); return res; },
    };
    rpcHandler()(req, res);
  });
}

beforeEach(() => {
  mockGetWorkspace.mockReset();
  mockGetWorkspace.mockResolvedValue({ id: 'ded-ws', name: 'Dedicated WS', ai_provider: 'openai', ai_model: 'gpt-4o-mini', enabled_tools: null });
  mockProcessMessage.mockReset();
  mockProcessMessage.mockResolvedValue({ id: 'task', status: { state: 'completed' } });
  mockStreamCompletion.mockReset();
  delete process.env.RT_CONNECTIONS;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('message/send — contract action gate', () => {
  const grantsDelegate = { contractId: 'c-del', status: 'active', allowedActions: ['delegate'] };
  const grantsCapOnly = { contractId: 'c-cap', status: 'active', allowedActions: ['capability:plaid.getBalances'] };

  it('runs a delegated turn when the signed action is granted, under the delegated profile', async () => {
    const out = await sendMessage({ contract: grantsDelegate, action: 'delegate' });
    expect(out.status).toBe(200);
    expect(out.body.result).toBeDefined();
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    const call = mockProcessMessage.mock.calls[0][0];
    expect(call.workspaceConfig.toolProfile).toBe('delegated');
  });

  it("refuses a message/send signed with a non-message action, even one the contract grants", async () => {
    const out = await sendMessage({ contract: grantsCapOnly, action: 'capability:plaid.getBalances' });
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/requires a message action/);
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  it('refuses the header-less default (message_send) when the contract grants no message action', async () => {
    const out = await sendMessage({ contract: grantsCapOnly });
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/not granted by contract/);
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  it("'message' satisfies the header-less default; '*' satisfies everything", async () => {
    let out = await sendMessage({ contract: { contractId: 'c-msg', status: 'active', allowedActions: ['message'] } });
    expect(out.status).toBe(200);
    out = await sendMessage({ contract: { contractId: 'c-star', status: 'active', allowedActions: ['*'] }, action: 'delegate' });
    expect(out.status).toBe(200);
  });

  it("refuses 'message' signed against a contract that only grants 'delegate'", async () => {
    const out = await sendMessage({ contract: grantsDelegate, action: 'message' });
    expect(out.status).toBe(403);
  });

  it('the trusted-app ingress (no contract) keeps the normal tool profile', async () => {
    const out = await sendMessage({});
    expect(out.status).toBe(200);
    expect(mockProcessMessage.mock.calls[0][0].workspaceConfig.toolProfile).toBeUndefined();
  });
});

describe('bridge delegation runs under the delegated profile', () => {
  const SECRET = 'bridge-secret';
  const receive = () => {
    const r = require('../../server/routes/bridgeReceive');
    const layer = r.stack.find((l: any) => l.route && l.route.path === '/receive');
    return layer.route.stack[0].handle;
  };

  it('processDelegation passes toolProfile=delegated to streamCompletion', async () => {
    const { fetchManifest } = require('../../server/utils/fetchManifest');
    const contractId = 'c-bridge';
    const allowed = ['delegate'];
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [{ contractId, status: 'active', allowedActions: allowed }], RT_BRIDGES: [] });
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    mockStreamCompletion.mockImplementation(async function* () { yield { type: 'done', fullText: 'done' }; });

    const taskId = 't-del';
    const timestamp = Date.now().toString();
    const action = 'delegate';
    const body = {
      taskId, contractId, action, timestamp,
      content: 'summarize',
      sourceWorkspace: { id: 'src', name: 'Source' },
      contractToken: crypto.createHmac('sha256', SECRET).update(`${contractId}:${[...allowed].sort().join(',')}`).digest('hex'),
      signature: crypto.createHmac('sha256', SECRET).update(`${taskId}:${timestamp}:${contractId}:${action}`).digest('hex'),
    };
    const out = await new Promise<{ status: number; body: any }>((resolve) => {
      const res: any = {
        statusCode: 200,
        status(c: number) { res.statusCode = c; return res; },
        json(b: any) { resolve({ status: res.statusCode, body: b }); return res; },
      };
      receive()({ headers: {}, body }, res);
    });
    expect(out.status).toBe(200);
    expect(out.body.action).toBe('delegation_started');

    // The delegation runs after the response; give it a few ticks.
    for (let i = 0; i < 20 && mockStreamCompletion.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mockStreamCompletion).toHaveBeenCalledTimes(1);
    const workspaceConfig = mockStreamCompletion.mock.calls[0][7];
    expect(workspaceConfig.toolProfile).toBe('delegated');
  });
});
