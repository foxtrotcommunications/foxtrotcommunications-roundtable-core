/**
 * requireHmac accepts the per-workspace bridge key (upgrade plan 5.0).
 *
 * The control plane delivers RT_WS_BRIDGE_KEY = HKDF(orgMaster, "bridge:{wsId}")
 * to each dedicated pod (3.2). A request tenant-bound to THIS workspace may
 * be signed with that key or with the fleet BRIDGE_HMAC_SECRET; the
 * per-workspace key is tried first. It is never accepted for another
 * tenant's claim or for an unbound request, and a failed first attempt must
 * not consume the v2 nonce.
 */

const mockConfig: any = {
  bridgeHmacSecret: 'fleet-secret',
  workspaceId: 'ws-self',
  pooled: false,
};
jest.mock('../../server/config', () => mockConfig);

import crypto from 'crypto';
const { requireHmac, verifyS2sRequest, candidateSecrets } = require('../../server/middleware/requireHmac');
const s2s = require('../../server/utils/s2sSig');

const PER_WS = crypto.randomBytes(32).toString('hex');

function runMw(mw: any, headers: Record<string, string>, rawBody?: string) {
  return new Promise<{ req: any; statusCode: number; body: any; nexted: boolean }>((resolve) => {
    const req: any = { headers, rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody) };
    const res: any = {
      statusCode: 0,
      status(c: number) { res.statusCode = c; return res; },
      json(b: any) { resolve({ req, statusCode: res.statusCode, body: b, nexted: false }); return res; },
    };
    mw(req, res, () => resolve({ req, statusCode: 200, body: null, nexted: true }));
  });
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

beforeEach(() => {
  process.env.RT_WS_BRIDGE_KEY = PER_WS;
  mockConfig.pooled = false;
  mockConfig.bridgeHmacSecret = 'fleet-secret';
});
afterAll(() => { delete process.env.RT_WS_BRIDGE_KEY; });

describe('candidateSecrets', () => {
  it('per-workspace key first, then fleet, for a claim of this workspace', () => {
    expect(candidateSecrets('ws-self')).toEqual([PER_WS, 'fleet-secret']);
  });
  it('fleet only for another tenant or no tenant', () => {
    expect(candidateSecrets('ws-other')).toEqual(['fleet-secret']);
    expect(candidateSecrets(undefined)).toEqual(['fleet-secret']);
  });
  it('fleet only on a pooled service (no per-workspace identity)', () => {
    mockConfig.pooled = true;
    expect(candidateSecrets('ws-self')).toEqual(['fleet-secret']);
  });
  it('fleet secret can be retired: with it unset, only the per-workspace key remains', () => {
    mockConfig.bridgeHmacSecret = '';
    expect(candidateSecrets('ws-self')).toEqual([PER_WS]);
    expect(candidateSecrets('ws-other')).toEqual([]);
  });
  it('an explicit override replaces the list', () => {
    expect(candidateSecrets('ws-self', 'x')).toEqual(['x']);
  });
});

describe('requireHmac with RT_WS_BRIDGE_KEY', () => {
  it('v2 signed with the per-workspace key, bound to this workspace → accepted', async () => {
    const body = '{"a":1}';
    const { headers } = s2s.signPathV2({ secret: PER_WS, routePath: 'sync', body, tenantWsId: 'ws-self' });
    const out = await runMw(requireHmac('sync'), lower(headers), body);
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toEqual({ workspaceId: 'ws-self' });
  });

  it('v2 signed with the fleet secret still accepted (additive)', async () => {
    const body = '{"a":1}';
    const { headers } = s2s.signPathV2({ secret: 'fleet-secret', routePath: 'sync', body, tenantWsId: 'ws-self' });
    const out = await runMw(requireHmac('sync'), lower(headers), body);
    expect(out.nexted).toBe(true);
  });

  it('a failed per-workspace attempt does not burn the nonce for the fleet attempt', async () => {
    // Same nonce, signed with the fleet secret: the per-ws attempt fails on
    // signature (before nonce consumption), the fleet attempt succeeds.
    const body = '{"a":2}';
    const nonce = s2s.newNonce();
    const { headers } = s2s.signPathV2({ secret: 'fleet-secret', routePath: 'sync', body, tenantWsId: 'ws-self', nonce });
    const out = await runMw(requireHmac('sync'), lower(headers), body);
    expect(out.nexted).toBe(true);
    // And a true replay of that nonce is still rejected.
    const again = await runMw(requireHmac('sync'), lower(headers), body);
    expect(again.nexted).toBe(false);
    expect(again.body.error).toMatch(/Replay/);
  });

  it('per-workspace key is NOT accepted for a claim of another tenant', async () => {
    const body = '{"a":3}';
    const { headers } = s2s.signPathV2({ secret: PER_WS, routePath: 'sync', body, tenantWsId: 'ws-other' });
    const out = await runMw(requireHmac('sync'), lower(headers), body);
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toBe('Invalid HMAC signature');
  });

  it('per-workspace key is NOT accepted for an unbound request', async () => {
    const body = '{"a":4}';
    const { headers } = s2s.signPathV2({ secret: PER_WS, routePath: 'sync', body });
    const out = await runMw(requireHmac('sync'), lower(headers), body);
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
  });

  it('v1 with the per-workspace key, bound to this workspace → accepted while RT_HMAC_ACCEPT_V1', async () => {
    const t = Date.now().toString();
    const out = await runMw(requireHmac('sync'), {
      'x-control-plane-signature': crypto.createHmac('sha256', PER_WS).update(`sync:${t}:ws-self`).digest('hex'),
      'x-control-plane-timestamp': t,
      'x-rt-workspace': 'ws-self',
    });
    expect(out.nexted).toBe(true);
  });

  it('verifyS2sRequest (embedded verifiers) follows the same candidate order', async () => {
    const body = '{"tool":"x"}';
    const { headers } = s2s.signPathV2({ secret: PER_WS, routePath: 'tools/execute', body, tenantWsId: 'ws-self' });
    const ok = await verifyS2sRequest({ headers: lower(headers), rawBody: Buffer.from(body) }, 'tools/execute');
    expect(ok.ok).toBe(true);
    expect(ok.tenantWsId).toBe('ws-self');
    const bad = s2s.signPathV2({ secret: PER_WS, routePath: 'tools/execute', body, tenantWsId: 'ws-other' });
    const r = await verifyS2sRequest({ headers: lower(bad.headers), rawBody: Buffer.from(body) }, 'tools/execute');
    expect(r.ok).toBe(false);
  });
});
