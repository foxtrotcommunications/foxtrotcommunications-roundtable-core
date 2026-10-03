/**
 * S2S signature v2 (SIGNING_SPEC.md) — test vectors, the dual-accept
 * verifier (requireHmac), the contract-keyed verifier (contractAuth), the
 * nonce namespace, and the outbound signers' header shape.
 */

jest.mock('../../server/config', () => ({
  bridgeHmacSecret: 'test-secret',
  workspaceId: 'test-workspace',
  pooled: false,
  pooledArthur: false,
}));

import crypto from 'crypto';

const s2s = require('../../server/utils/s2sSig');
const { requireHmac, verifyS2sRequest } = require('../../server/middleware/requireHmac');
const { signRequestV2, verifyContractRequest, signRequest } = require('../../server/utils/contractAuth');
import { nonceStore } from '../../server/protocols/nonceStore';

const SECRET = 'test-secret';
const TS = '1790000000000';
const NONCE = '0123456789abcdef0123456789abcdef';
const BODY = '{"a":1}';
const BODY_HASH = '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862';

const ENV_KEYS = ['RT_HMAC_ACCEPT_V1', 'RT_HMAC_EMIT_V2'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

// ─── Spec test vectors ─────────────────────────────────────────────────────

describe('SIGNING_SPEC test vectors', () => {
  it('bodyHashOf: {"a":1} and the empty body', () => {
    expect(s2s.bodyHashOf(BODY)).toBe(BODY_HASH);
    expect(s2s.bodyHashOf(Buffer.from(BODY))).toBe(BODY_HASH);
    expect(s2s.bodyHashOf('')).toBe(s2s.EMPTY_SHA256);
    expect(s2s.bodyHashOf(undefined)).toBe(s2s.EMPTY_SHA256);
    expect(s2s.bodyHashOf(Buffer.alloc(0))).toBe(s2s.EMPTY_SHA256);
    expect(s2s.EMPTY_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('vector 1: tenant-bound sync with body', () => {
    const str = s2s.v2SignedString({ routePath: 'sync', timestamp: TS, nonce: NONCE, bodyHash: BODY_HASH, tenantWsId: 'wsA' });
    expect(str).toBe(`v2:sync:${TS}:${NONCE}:${BODY_HASH}:wsA`);
    expect(s2s.hmacHex(SECRET, str)).toBe('2ef663c422d4b534569bccc480656af5aac3a66e945a9f4983276578d4d1a010');
  });

  it('vector 2: empty body, no tenant', () => {
    const str = s2s.v2SignedString({ routePath: 'sync', timestamp: TS, nonce: NONCE, bodyHash: s2s.EMPTY_SHA256 });
    expect(str).toBe(`v2:sync:${TS}:${NONCE}:${s2s.EMPTY_SHA256}`);
    expect(s2s.hmacHex(SECRET, str)).toBe('d25d9af1b0ed7c95676de54a562608dc1c9b7f5c04df5a4da23f4f591754c2c3');
  });

  it('vector 3: contract-keyed, tenant-bound', () => {
    const str = s2s.v2ContractSignedString({ contractId: 'ctr_1', timestamp: TS, action: 'intent_execute', nonce: NONCE, bodyHash: BODY_HASH, tenantWsId: 'wsA' });
    expect(str).toBe(`v2:ctr_1:${TS}:intent_execute:${NONCE}:${BODY_HASH}:wsA`);
    expect(s2s.hmacHex(SECRET, str)).toBe('8d4a35651abad17b568e48be38d17b07f404ccc464914ecb7ff25e478ad252f5');
  });

  it('signers reproduce the vectors header-for-header', () => {
    const p = s2s.signPathV2({ secret: SECRET, routePath: 'sync', body: BODY, tenantWsId: 'wsA', timestamp: TS, nonce: NONCE });
    expect(p.headers).toEqual({
      'x-control-plane-signature': '2ef663c422d4b534569bccc480656af5aac3a66e945a9f4983276578d4d1a010',
      'x-control-plane-timestamp': TS,
      'x-rt-nonce': NONCE,
      'x-rt-sig-v': '2',
      'x-rt-workspace': 'wsA',
    });
    const c = signRequestV2(Buffer.from(SECRET), { contractId: 'ctr_1', action: 'intent_execute', body: BODY, tenantWsId: 'wsA', timestamp: TS, nonce: NONCE });
    expect(c.headers['X-Contract-Signature']).toBe('8d4a35651abad17b568e48be38d17b07f404ccc464914ecb7ff25e478ad252f5');
    expect(c.headers['X-Rt-Nonce']).toBe(NONCE);
    expect(c.headers['X-Rt-Sig-V']).toBe('2');
  });

  it('newNonce is 32 lowercase hex and isNonce enforces it', () => {
    const n = s2s.newNonce();
    expect(s2s.isNonce(n)).toBe(true);
    expect(s2s.isNonce(n.toUpperCase())).toBe(false);
    expect(s2s.isNonce(n.slice(1))).toBe(false);
    expect(s2s.isNonce(undefined)).toBe(false);
  });
});

// ─── requireHmac: dual accept ──────────────────────────────────────────────

function sigV1(signedString: string) {
  return crypto.createHmac('sha256', SECRET).update(signedString).digest('hex');
}

async function runMw(mw: any, headers: Record<string, string>, rawBody?: string) {
  const req: any = { headers, rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody) };
  let statusCode = 0;
  let body: any = null;
  let nexted = false;
  const res: any = {
    status(c: number) { statusCode = c; return this; },
    json(b: any) { body = b; return this; },
  };
  await new Promise<void>((resolve) => {
    res.json = (b: any) => { body = b; resolve(); return res; };
    mw(req, res, () => { nexted = true; resolve(); });
  });
  return { req, statusCode, body, nexted };
}

function v2Headers(routePath: string, body: string, tenantWsId?: string, overrides: Record<string, string> = {}) {
  const p = s2s.signPathV2({ secret: SECRET, routePath, body, tenantWsId });
  return { ...p.headers, ...overrides };
}

describe('requireHmac — v2', () => {
  it('accepts a valid v2 signature with body hash + nonce and attaches the tenant', async () => {
    const out = await runMw(requireHmac('sync'), v2Headers('sync', BODY, 'ws-a'), BODY);
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toEqual({ workspaceId: 'ws-a' });
  });

  it('accepts a v2 signature over an empty body (GET-style)', async () => {
    const out = await runMw(requireHmac('manifest'), v2Headers('manifest', ''));
    expect(out.nexted).toBe(true);
  });

  it('rejects when the body differs from the one signed', async () => {
    const out = await runMw(requireHmac('sync'), v2Headers('sync', BODY, 'ws-a'), '{"a":2}');
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toMatch(/Invalid HMAC signature/);
  });

  it('rejects a replayed nonce', async () => {
    const h = v2Headers('sync', BODY, 'ws-a');
    const first = await runMw(requireHmac('sync'), h, BODY);
    expect(first.nexted).toBe(true);
    const second = await runMw(requireHmac('sync'), h, BODY);
    expect(second.nexted).toBe(false);
    expect(second.statusCode).toBe(401);
    expect(second.body.error).toMatch(/Replay/);
  });

  it('rejects a missing or malformed nonce', async () => {
    const h = v2Headers('sync', BODY);
    delete (h as any)['x-rt-nonce'];
    let out = await runMw(requireHmac('sync'), h, BODY);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toMatch(/Nonce/);
    out = await runMw(requireHmac('sync'), v2Headers('sync', BODY, undefined, { 'x-rt-nonce': 'ZZ' }), BODY);
    expect(out.statusCode).toBe(401);
  });

  it('rejects a stale v2 timestamp', async () => {
    const old = (Date.now() - 6 * 60 * 1000).toString();
    const p = s2s.signPathV2({ secret: SECRET, routePath: 'sync', body: BODY, timestamp: old });
    const out = await runMw(requireHmac('sync'), p.headers, BODY);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toMatch(/expired/);
  });

  it('rejects a v2 signature minted for another tenant or route', async () => {
    let out = await runMw(requireHmac('sync'), v2Headers('sync', BODY, 'ws-a', { 'x-rt-workspace': 'ws-b' }), BODY);
    expect(out.statusCode).toBe(401);
    out = await runMw(requireHmac('watches'), v2Headers('sync', BODY, 'ws-a'), BODY);
    expect(out.statusCode).toBe(401);
  });

  it('rejects any other X-Rt-Sig-V', async () => {
    const out = await runMw(requireHmac('sync'), v2Headers('sync', BODY, undefined, { 'x-rt-sig-v': '3' }), BODY);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toMatch(/Unsupported X-Rt-Sig-V/);
  });

  it('tenantRequired still applies to v2', async () => {
    const out = await runMw(requireHmac('sync', { tenantRequired: true }), v2Headers('sync', BODY), BODY);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toContain('X-Rt-Workspace');
  });
});

describe('requireHmac — v1 under RT_HMAC_ACCEPT_V1', () => {
  it('accepts v1 by default and logs the deprecation once a minute per route', async () => {
    const t = Date.now().toString();
    const h = { 'x-control-plane-signature': sigV1(`v1route:${t}`), 'x-control-plane-timestamp': t };
    const out = await runMw(requireHmac('v1route'), h);
    expect(out.nexted).toBe(true);
    const warn = console.warn as jest.Mock;
    const deprecations = () => warn.mock.calls.filter((c) => /v1 signature accepted \(deprecated\) route=v1route/.test(String(c[0]))).length;
    expect(deprecations()).toBe(1);
    await runMw(requireHmac('v1route'), h);
    expect(deprecations()).toBe(1);
  });

  it('refuses v1 with the spec error once RT_HMAC_ACCEPT_V1=false', async () => {
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    const t = Date.now().toString();
    const out = await runMw(requireHmac('sync'), { 'x-control-plane-signature': sigV1(`sync:${t}`), 'x-control-plane-timestamp': t });
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
    expect(out.body).toEqual({ error: 'HMAC v1 no longer accepted' });
    // v2 still works
    const ok = await runMw(requireHmac('sync'), v2Headers('sync', BODY), BODY);
    expect(ok.nexted).toBe(true);
  });

  it('verifyS2sRequest exposes the same decision for embedded verifiers', async () => {
    const v2 = await verifyS2sRequest({ headers: v2Headers('tools/execute', BODY), rawBody: Buffer.from(BODY) }, 'tools/execute');
    expect(v2).toMatchObject({ ok: true, version: 2 });
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    const t = Date.now().toString();
    const v1 = await verifyS2sRequest({ headers: { 'x-control-plane-signature': sigV1(`x:${t}`), 'x-control-plane-timestamp': t } }, 'x');
    expect(v1).toMatchObject({ ok: false, status: 401, error: 'HMAC v1 no longer accepted' });
  });
});

// ─── contractAuth: v2 contract-keyed ───────────────────────────────────────

describe('verifyContractRequest', () => {
  const key = crypto.randomBytes(32);

  it('accepts a v2 contract signature, rejects body/tenant/action drift and replay', async () => {
    const signed = signRequestV2(key, { contractId: 'c1', action: 'intent_execute', body: BODY, tenantWsId: 'ws-a' });
    const headers = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v as string]));
    const base = { headers, rawBody: Buffer.from(BODY), contractId: 'c1', action: 'intent_execute', tenantWsId: 'ws-a' };

    expect(await verifyContractRequest(key, { ...base, rawBody: Buffer.from('{"a":2}') })).toMatchObject({ valid: false, version: 2 });
    expect(await verifyContractRequest(key, { ...base, tenantWsId: 'ws-b' })).toMatchObject({ valid: false });
    expect(await verifyContractRequest(key, { ...base, action: 'message_send' })).toMatchObject({ valid: false });
    expect(await verifyContractRequest(key, { ...base, contractId: 'c2' })).toMatchObject({ valid: false });

    expect(await verifyContractRequest(key, base)).toEqual({ valid: true, version: 2 });
    expect(await verifyContractRequest(key, base)).toMatchObject({ valid: false, error: expect.stringMatching(/Replay/) });
  });

  it('accepts v1 while the flag allows and refuses it after', async () => {
    const ts = Date.now().toString();
    const headers = { 'x-contract-signature': signRequest(key, 'c1', ts, 'message_send'), 'x-contract-timestamp': ts };
    expect(await verifyContractRequest(key, { headers, contractId: 'c1', action: 'message_send' })).toEqual({ valid: true, version: 1 });
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    expect(await verifyContractRequest(key, { headers, contractId: 'c1', action: 'message_send' }))
      .toMatchObject({ valid: false, error: 'HMAC v1 no longer accepted' });
  });

  it('rejects an unknown version and a missing nonce', async () => {
    const signed = signRequestV2(key, { contractId: 'c1', action: 'a', body: '' });
    const headers: Record<string, string> = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v as string]));
    expect(await verifyContractRequest(key, { headers: { ...headers, 'x-rt-sig-v': '9' }, contractId: 'c1', action: 'a' })).toMatchObject({ valid: false });
    const { 'x-rt-nonce': _n, ...noNonce } = headers;
    expect(await verifyContractRequest(key, { headers: noNonce, contractId: 'c1', action: 'a' })).toMatchObject({ valid: false, error: expect.stringMatching(/Nonce/) });
  });
});

// ─── nonce namespace ───────────────────────────────────────────────────────

describe('nonceStore.addScoped', () => {
  it('namespaces S2S nonces apart from intent-token nonces', async () => {
    const n = s2s.newNonce();
    expect(await nonceStore.add(n)).toBe(true);            // intent-token namespace (bare)
    expect(await nonceStore.addScoped('s2s', n)).toBe(true); // s2s:<n> is a different key
    expect(await nonceStore.addScoped('s2s', n)).toBe(false);
  });
  it('refuses a namespace that could collide with the separator', async () => {
    await expect(nonceStore.addScoped('a:b', 'x')).rejects.toThrow(/invalid namespace/);
  });
});

// ─── emit switch ───────────────────────────────────────────────────────────

describe('RT_HMAC_EMIT_V2 / RT_HMAC_ACCEPT_V1 defaults', () => {
  it('defaults: emit v2 on, accept v1 on', () => {
    expect(s2s.emitV2()).toBe(true);
    expect(s2s.acceptV1()).toBe(true);
    process.env.RT_HMAC_EMIT_V2 = 'false';
    process.env.RT_HMAC_ACCEPT_V1 = 'false';
    expect(s2s.emitV2()).toBe(false);
    expect(s2s.acceptV1()).toBe(false);
  });
});
