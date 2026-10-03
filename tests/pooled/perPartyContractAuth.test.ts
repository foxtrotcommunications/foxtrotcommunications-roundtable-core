/**
 * Per-party contract identity on the wire (upgrade plan 5.1).
 *
 * requireA2aAuth + intent/execute with X-Contract-Sender / token.sender:
 *   - the sender's party key verifies (dedicated via RT_CONTRACT_KEYS,
 *     pooled via the tenant-keyed Secret Manager fetch);
 *   - a signature under the WRONG party's key is rejected;
 *   - a sender that is not a party, or is the receiving workspace itself,
 *     is rejected even with a valid key;
 *   - a legacy (org-key, no sender) request/token is accepted while
 *     RT_ACCEPT_ORG_KEY !== 'false' (logged once a minute) and 401 after;
 *   - the pooled fetch is keyed by (tenant, contract, sender).
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  pooledDomainType: null,
  workspaceId: 'wsB',
  workspaceName: 'B',
  bridgeHmacSecret: 'bridge-secret',
  a2aApiKey: '',
  ai: {},
  vertexai: { project: '', location: '' },
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/db/adapter', () => ({
  getAdapter: () => ({ getWorkspace: jest.fn().mockResolvedValue({ id: 'wsB', name: 'B', enabled_tools: null }) }),
}));
jest.mock('../../server/a2a/agentCard', () => ({ generateAgentCard: jest.fn() }));
jest.mock('../../server/a2a/server', () => ({ processMessage: jest.fn(), getTask: jest.fn(), cancelTask: jest.fn() }));
jest.mock('../../server/tools', () => ({ getAvailableTools: jest.fn(() => []), resolveTools: jest.fn(() => ({})) }));
const mockFetchManifest = jest.fn();
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: mockFetchManifest }));
const mockGetOrgMasterSecret = jest.fn();
const mockGetContractPartyKey = jest.fn();
jest.mock('../../server/tenantCredentials', () => ({
  getOrgMasterSecret: mockGetOrgMasterSecret,
  getContractPartyKey: mockGetContractPartyKey,
}));
jest.mock('../../server/services/workspaceService', () => ({}));
jest.mock('../../server/pooled/tenantContext', () => ({ buildTenantContext: jest.fn().mockResolvedValue({ workspaceId: 'wsB' }) }));
const mockExecuteIntentToken = jest.fn();
jest.mock('../../server/protocols/intentExecutor', () => {
  const actual = jest.requireActual('../../server/protocols/intentExecutor');
  return { ...actual, executeIntentToken: (...a: any[]) => mockExecuteIntentToken(...a) };
});

import type { CapabilityIntent } from '../../server/protocols/intentToken';
import { buildIntentToken } from '../../server/protocols/intentTokenCodec';
import { nonceStore } from '../../server/protocols/nonceStore';
const { signRequestV2, deriveContractKey } = require('../../server/utils/contractAuth');
const { derivePartyKey } = require('../../server/utils/contractKeys');

const MASTER = 'test-master';
const CONTRACT = {
  contractId: 'ctr_1', version: 1, status: 'active', allowedActions: ['*'],
  parties: ['wsA', 'wsB'], counterparty: { wsId: 'wsA', name: 'A' },
};
const KEY_A = derivePartyKey(MASTER, 'ctr_1', 1, 'wsA');
const KEY_B = derivePartyKey(MASTER, 'ctr_1', 1, 'wsB');
const ENV_KEYS_FOR_B = {
  ctr_1: { version: 1, party: 'wsB', key: KEY_B.toString('hex'), keys: { wsA: KEY_A.toString('hex'), wsB: KEY_B.toString('hex') } },
};
const intent: CapabilityIntent = { op: 'capability', name: 'x.y', input: {} };

const router = require('../../server/routes/a2a');
const postLayer = () => router.stack.find((l: any) => l.route && l.route.path === '/a2a' && l.route.methods.post);
const authMw = () => postLayer().route.stack[0].handle;
const rpcHandler = () => postLayer().route.stack[1].handle;

function runAuth(headers: Record<string, string>, rawBody: string) {
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
/** Full pipeline: auth middleware then the JSON-RPC handler. */
async function callIntent(headers: Record<string, string>, token: any) {
  const rawBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
  const a = await runAuth(headers, rawBody);
  if (!a.nexted) return { stage: 'auth', status: a.status, body: a.body };
  return new Promise<{ stage: string; status: number; body: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ stage: 'rpc', status: res.statusCode, body: b }); return res; },
    };
    rpcHandler()(a.req, res);
  });
}

const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 't' } });
function headersSignedBy(key: Buffer, opts: { sender?: string; tenant?: string; body?: string; action?: string } = {}) {
  const action = opts.action || 'intent_execute';
  const signed = signRequestV2(key, { contractId: 'ctr_1', action, body: opts.body ?? BODY, tenantWsId: opts.tenant });
  const h: Record<string, string> = {
    'x-contract-id': 'ctr_1',
    'x-contract-action': action,
    ...Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v as string])),
  };
  if (opts.sender) h['x-contract-sender'] = opts.sender;
  if (opts.tenant) h['x-rt-tenant'] = opts.tenant;
  return h;
}

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.RT_ACCEPT_ORG_KEY;
  delete process.env.RT_CONTRACT_KEYS;
  process.env.ORG_MASTER_SECRET = MASTER;
  mockConfig.pooled = false; mockConfig.pooledArthur = false;
  mockFetchManifest.mockReset();
  mockFetchManifest.mockResolvedValue({ RT_CONTRACTS: [CONTRACT], RT_BRIDGES: [], orgId: 'org-1' });
  mockGetOrgMasterSecret.mockReset();
  mockGetOrgMasterSecret.mockResolvedValue(MASTER);
  mockGetContractPartyKey.mockReset();
  mockExecuteIntentToken.mockReset();
  mockExecuteIntentToken.mockResolvedValue({ status: 'success', executionMs: 1, data: { ok: true } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ['RT_ACCEPT_ORG_KEY', 'RT_CONTRACT_KEYS', 'ORG_MASTER_SECRET']) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
  }
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

describe('request signatures — dedicated pod wsB holding RT_CONTRACT_KEYS', () => {
  beforeEach(() => { process.env.RT_CONTRACT_KEYS = JSON.stringify(ENV_KEYS_FOR_B); });

  it('wsA signs with key(C, wsA) + X-Contract-Sender: wsA → accepted, key attached', async () => {
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsA' }), BODY);
    expect(out.nexted).toBe(true);
    expect(out.req.contractSender).toBe('wsA');
    expect(out.req.contractKeyKind).toBe('party');
    expect(out.req.contractKey.equals(KEY_A)).toBe(true);
  });

  it('signed with the WRONG party key (wsB) while claiming to be wsA → 401', async () => {
    const out = await runAuth(headersSignedBy(KEY_B, { sender: 'wsA' }), BODY);
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
    expect(out.body.error.message).toMatch(/signature invalid/);
  });

  it('a sender that is not a party → 403 even before any key lookup', async () => {
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsZ' }), BODY);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/not a party/);
  });

  it('a sender that is the receiving workspace itself → 403', async () => {
    const out = await runAuth(headersSignedBy(KEY_B, { sender: 'wsB' }), BODY);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/receiving workspace itself/);
  });

  it('a sender with no key in RT_CONTRACT_KEYS → 401 (no org-key fallback for a named sender)', async () => {
    process.env.RT_CONTRACT_KEYS = JSON.stringify({ ctr_1: { version: 1, party: 'wsB', key: KEY_B.toString('hex') } });
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsA' }), BODY);
    expect(out.status).toBe(401);
    expect(out.body.error.message).toMatch(/No party key for sender wsA/);
  });

  it('legacy (no sender, org key) → accepted by default and logged once a minute', async () => {
    const orgKey = await deriveContractKey(MASTER, 'ctr_1', 1);
    const warn = console.warn as jest.Mock;
    const out = await runAuth(headersSignedBy(orgKey), BODY);
    expect(out.nexted).toBe(true);
    expect(out.req.contractKeyKind).toBe('org');
    await runAuth(headersSignedBy(orgKey), BODY);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /org-key request accepted \(deprecated\) contract=ctr_1/.test(l));
    expect(lines.length).toBe(1);
  });

  it('legacy (no sender) → 401 under RT_ACCEPT_ORG_KEY=false, without touching the master', async () => {
    process.env.RT_ACCEPT_ORG_KEY = 'false';
    delete process.env.ORG_MASTER_SECRET;
    const orgKey = await deriveContractKey(MASTER, 'ctr_1', 1);
    const out = await runAuth(headersSignedBy(orgKey), BODY);
    expect(out.status).toBe(401);
    expect(out.body.error.message).toMatch(/RT_ACCEPT_ORG_KEY=false/);
  });

  it('per-party requests work with NO ORG_MASTER_SECRET on the pod', async () => {
    delete process.env.ORG_MASTER_SECRET;
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsA' }), BODY);
    expect(out.nexted).toBe(true);
  });
});

describe('intent tokens — dedicated pod wsB', () => {
  beforeEach(() => { process.env.RT_CONTRACT_KEYS = JSON.stringify(ENV_KEYS_FOR_B); });

  it('token signed by wsA with key(C, wsA), sender=wsA → executes', async () => {
    const token = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: false, partyKey: KEY_A, sender: 'wsA' });
    const r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } }) }), token);
    expect(r.stage).toBe('rpc');
    expect(r.body.result?.status).toBe('success');
    expect(mockExecuteIntentToken).toHaveBeenCalledTimes(1);
    expect(mockExecuteIntentToken.mock.calls[0][1].contractKey.equals(KEY_A)).toBe(true);
  });

  it('encrypted per-party token decrypts with the sender key', async () => {
    const token = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: true, partyKey: KEY_A, sender: 'wsA' });
    expect(token.encrypted).toBe(true);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
    const r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', body }), token);
    expect(r.body.result?.status).toBe('success');
    expect(mockExecuteIntentToken.mock.calls[0][0].intent).toEqual(intent);
  });

  it('token claims sender=wsA but was signed with the wsB key → rejected', async () => {
    const forged = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: false, partyKey: KEY_B, sender: 'wsA' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token: forged } });
    const r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', body }), forged);
    expect(r.stage).toBe('rpc');
    expect(r.body.error.message).toMatch(/Invalid token signature/);
    expect(mockExecuteIntentToken).not.toHaveBeenCalled();
  });

  it('token sender ≠ request sender → rejected', async () => {
    const token = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: false, partyKey: KEY_B, sender: 'wsB' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
    const r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', body }), token);
    expect(r.body.error.message).toMatch(/Token sender does not match/);
  });

  it('token sender is the receiver itself → rejected after signature (not a counterparty)', async () => {
    // Request legitimately from wsA; token stamped as wsB (the receiver).
    const token = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: false, partyKey: KEY_B, sender: 'wsB' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
    const orgKey = await deriveContractKey(MASTER, 'ctr_1', 1);
    const r = await callIntent(headersSignedBy(orgKey, { body }), token); // legacy request, no header sender
    expect(r.body.error.message).toMatch(/receiving workspace itself/);
    expect(mockExecuteIntentToken).not.toHaveBeenCalled();
  });

  it('legacy token (no sender) accepted by default, denied under RT_ACCEPT_ORG_KEY=false', async () => {
    const token = await buildIntentToken(intent, 'ctr_1', 1, MASTER, { encrypt: false });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
    const orgKey = await deriveContractKey(MASTER, 'ctr_1', 1);
    let r = await callIntent(headersSignedBy(orgKey, { body }), token);
    expect(r.body.result?.status).toBe('success');

    process.env.RT_ACCEPT_ORG_KEY = 'false';
    const token2 = await buildIntentToken(intent, 'ctr_1', 1, MASTER, { encrypt: false });
    const body2 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token: token2 } });
    // Request itself must be per-party now; the TOKEN is the legacy one.
    r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', body: body2 }), token2);
    expect(r.stage).toBe('rpc');
    expect(r.body.error.message).toMatch(/org-key tokens are no longer accepted/);
  });
});

describe('pooled service — tenant wsB, sender wsA, keys from Secret Manager', () => {
  beforeEach(() => {
    mockConfig.pooled = true; mockConfig.pooledArthur = true;
    mockGetContractPartyKey.mockImplementation(async (_tenant: string, _c: string, party: string) => (
      party === 'wsA' ? { key: KEY_A.toString('hex'), version: 1, contractId: 'ctr_1', party: 'wsA' } : null
    ));
  });

  it('fetches key(C, sender) FOR the claimed tenant and accepts', async () => {
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsA', tenant: 'wsB' }), BODY);
    expect(out.nexted).toBe(true);
    expect(mockGetContractPartyKey).toHaveBeenCalledWith('wsB', 'ctr_1', 'wsA');
    // No org master needed for a per-party request.
    expect(mockGetOrgMasterSecret).not.toHaveBeenCalled();
  });

  it('a sender that is not the counterparty of the tenant is refused by tenant resolution', async () => {
    const out = await runAuth(headersSignedBy(KEY_A, { sender: 'wsZ', tenant: 'wsB' }), BODY);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/not a party/);
    expect(mockGetContractPartyKey).not.toHaveBeenCalled();
  });

  it('a per-party token executes on the pooled path with the tenant-fetched key', async () => {
    const token = await buildIntentToken(intent, 'ctr_1', 1, '', { encrypt: false, partyKey: KEY_A, sender: 'wsA' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'intent/execute', params: { token } });
    const r = await callIntent(headersSignedBy(KEY_A, { sender: 'wsA', tenant: 'wsB', body }), token);
    expect(r.stage).toBe('rpc');
    expect(r.body.result?.status).toBe('success');
    for (const call of mockGetContractPartyKey.mock.calls) expect(call[0]).toBe('wsB');
  });

  it('legacy pooled request still resolves the tenant org master (flag default)', async () => {
    const orgKey = await deriveContractKey(MASTER, 'ctr_1', 1);
    const out = await runAuth(headersSignedBy(orgKey, { tenant: 'wsB' }), BODY);
    expect(out.nexted).toBe(true);
    expect(mockGetOrgMasterSecret).toHaveBeenCalledWith('wsB', 'org-1');
  });
});
