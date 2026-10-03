/**
 * One action vocabulary — the 6.5 follow-up for the files Phase 6 could not
 * touch (contractAuth.js, routes/a2a.ts, protocols/*).
 *
 *   - contractAuth re-exports the vocabulary's TRANSPORT_ACTIONS /
 *     MESSAGE_ACTIONS (same object, not a copy).
 *   - `tasks_get` / `tasks_cancel` are transport operations on a task the
 *     caller already created: a contract that does not list them can still
 *     poll and cancel its own task (routes/a2a.ts used to carry a narrower
 *     local list without them; contractAuth.js was the vocabulary).
 *   - intent/discover advertises A2A_METHODS and INTENT_OPS, not a hand-kept
 *     subset.
 *   - intentToken / intentCache / intentExecutor consult the vocabulary.
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
const mockGetTask = jest.fn();
const mockCancelTask = jest.fn();
jest.mock('../../server/a2a/server', () => ({ processMessage: jest.fn(), getTask: mockGetTask, cancelTask: mockCancelTask }));
jest.mock('../../server/tools', () => ({
  getAvailableTools: jest.fn(() => [{ name: 'calculator', description: 'adds' }]),
  resolveTools: jest.fn(() => ({})),
}));
const mockFetchManifest = jest.fn();
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: mockFetchManifest }));
jest.mock('../../server/tenantCredentials', () => ({ getOrgMasterSecret: jest.fn() }));
jest.mock('../../server/services/workspaceService', () => ({}));

import {
  TRANSPORT_ACTIONS, MESSAGE_ACTIONS, INTENT_OPS, A2A_METHODS, ACTION,
} from '../../server/vocab/actions';
const contractAuth = require('../../server/utils/contractAuth');
const { deriveContractKey, signRequestV2, findAndValidateContract } = contractAuth;
import { nonceStore } from '../../server/protocols/nonceStore';
import { validateIntent } from '../../server/protocols/intentToken';
import { intentCache } from '../../server/protocols/intentCache';

const MASTER = 'org-master-secret';
// Grants ONE capability and nothing else — no tasks_get, no tasks_cancel, no '*'.
const NARROW = { contractId: 'ctr_narrow', version: 1, status: 'active', allowedActions: ['capability:plaid.getBalances'] };

const router = require('../../server/routes/a2a');
function postLayer() {
  return router.stack.find((l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post);
}

/** Run the full /a2a POST stack (auth middleware → JSON-RPC handler). */
function post(headers: Record<string, string>, rawBody: string) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { headers, body: JSON.parse(rawBody), rawBody: Buffer.from(rawBody) };
    const res: any = {
      statusCode: 200,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ status: res.statusCode, body: b }); return res; },
    };
    const [auth, handler] = postLayer().route.stack.map((l: any) => l.handle);
    auth(req, res, () => handler(req, res));
  });
}

async function signed(action: string, body: string) {
  const key = await deriveContractKey(MASTER, NARROW.contractId, NARROW.version);
  const s = signRequestV2(key, { contractId: NARROW.contractId, action, body });
  return {
    'x-contract-id': NARROW.contractId,
    'x-contract-action': action,
    ...Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v as string])),
  } as Record<string, string>;
}

const SAVED_MASTER = process.env.ORG_MASTER_SECRET;
beforeEach(() => {
  process.env.ORG_MASTER_SECRET = MASTER;
  mockFetchManifest.mockReset();
  mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [NARROW], RT_BRIDGES: [], orgId: 'org-a' });
  mockGetTask.mockReset();
  mockCancelTask.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED_MASTER === undefined) delete process.env.ORG_MASTER_SECRET; else process.env.ORG_MASTER_SECRET = SAVED_MASTER;
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

describe('contractAuth uses the vocabulary', () => {
  it('re-exports TRANSPORT_ACTIONS / MESSAGE_ACTIONS as the vocabulary objects themselves', () => {
    expect(contractAuth.TRANSPORT_ACTIONS).toBe(TRANSPORT_ACTIONS);
    expect(contractAuth.MESSAGE_ACTIONS).toBe(MESSAGE_ACTIONS);
    expect(TRANSPORT_ACTIONS).toEqual(expect.arrayContaining([ACTION.tasks_get, ACTION.tasks_cancel, ACTION.intent_execute, ACTION.discover]));
  });

  it('findAndValidateContract auto-allows every transport action and nothing else', () => {
    for (const a of TRANSPORT_ACTIONS) {
      expect(findAndValidateContract([NARROW], NARROW.contractId, a).contract).toBe(NARROW);
    }
    for (const a of MESSAGE_ACTIONS) {
      expect(findAndValidateContract([NARROW], NARROW.contractId, a).error).toMatch(/not permitted/);
    }
    expect(findAndValidateContract([NARROW], NARROW.contractId, 'capability:other').error).toMatch(/not permitted/);
  });
});

describe('tasks/get and tasks/cancel are transport: no grant needed to touch your own task', () => {
  it('a contract without tasks_get in allowedActions can poll its own task', async () => {
    mockGetTask.mockReturnValue({ id: 'task-1', status: { state: 'working' } });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tasks/get', params: { id: 'task-1' } });
    const out = await post(await signed(ACTION.tasks_get, body), body);
    expect(out.status).toBe(200);
    expect(out.body.error).toBeUndefined();
    expect(out.body.result).toEqual({ id: 'task-1', status: { state: 'working' } });
    expect(mockGetTask).toHaveBeenCalledWith('task-1', undefined);
  });

  it('a contract without tasks_cancel in allowedActions can cancel its own task', async () => {
    mockCancelTask.mockReturnValue({ id: 'task-2', status: { state: 'canceled' } });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tasks/cancel', params: { id: 'task-2' } });
    const out = await post(await signed(ACTION.tasks_cancel, body), body);
    expect(out.status).toBe(200);
    expect(out.body.result.status.state).toBe('canceled');
  });

  it('the same narrow contract is still refused a message turn it was not granted', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'message/send', params: { message: { role: 'user', parts: [] } } });
    const out = await post(await signed(ACTION.delegate, body), body);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/not permitted/);
  });
});

describe('intent/discover advertises the vocabulary', () => {
  it('returns A2A_METHODS as capabilities and INTENT_OPS as intentOps', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'intent/discover', params: {} });
    const out = await post(await signed(ACTION.discover, body), body);
    expect(out.status).toBe(200);
    expect(out.body.result.capabilities).toEqual([...A2A_METHODS]);
    expect(out.body.result.intentOps).toEqual([...INTENT_OPS]);
    expect(out.body.result.intentOps).toContain('capability'); // the op the old hand-kept list forgot
  });
});

describe('protocols consult the vocabulary', () => {
  it('validateIntent accepts exactly the INTENT_OPS', () => {
    expect(validateIntent({ op: 'bogus' } as any).error).toMatch(new RegExp(INTENT_OPS.join(', ').replace(/\|/g, '\\|')));
    expect(validateIntent({ op: ACTION.discover, scope: 'tools' } as any).valid).toBe(true);
  });

  it('discover is never cacheable', () => {
    const intent = { op: ACTION.discover, scope: 'tools' } as any;
    const result = { version: 1, type: 'intent_result', tokenId: 't', status: 'success', data: {}, executionMs: 0, signature: 's', timestamp: 'now' } as any;
    intentCache.set(intent, result, 60_000, 'vocab-test');
    expect(intentCache.get(intent, 'vocab-test')).toBeNull();
  });
});
