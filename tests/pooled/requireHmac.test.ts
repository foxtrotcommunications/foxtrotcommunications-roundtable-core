/**
 * Shared S2S HMAC middleware — the tenant-binding matrix.
 * Old shape (no header) must behave exactly like server/index.js's inline
 * copy; the X-Rt-Workspace header binds the tenant into the signature.
 */

jest.mock('../../server/config', () => ({
  bridgeHmacSecret: 'test-bridge-secret',
  workspaceId: 'test-workspace',
}));

import crypto from 'crypto';

const { requireHmac } = require('../../server/middleware/requireHmac');

const SECRET = 'test-bridge-secret';

function sig(signedString: string) {
  return crypto.createHmac('sha256', SECRET).update(signedString).digest('hex');
}

function run(mw: any, headers: Record<string, string>) {
  const req: any = { headers };
  let statusCode = 0;
  let body: any = null;
  let nexted = false;
  const res: any = {
    status(c: number) { statusCode = c; return this; },
    json(b: any) { body = b; return this; },
  };
  mw(req, res, () => { nexted = true; });
  return { req, statusCode, body, nexted };
}

describe('requireHmac', () => {
  const ts = () => Date.now().toString();

  it('old shape passes without a tenant header (dedicated compat)', () => {
    const t = ts();
    const out = run(requireHmac('sync'), {
      'x-control-plane-signature': sig(`sync:${t}`),
      'x-control-plane-timestamp': t,
    });
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toBeUndefined();
  });

  it('tenant shape passes and attaches req.rtTenant', () => {
    const t = ts();
    const out = run(requireHmac('sync'), {
      'x-control-plane-signature': sig(`sync:${t}:ws-a`),
      'x-control-plane-timestamp': t,
      'x-rt-workspace': 'ws-a',
    });
    expect(out.nexted).toBe(true);
    expect(out.req.rtTenant).toEqual({ workspaceId: 'ws-a' });
  });

  it('rejects a signature minted for a different tenant', () => {
    const t = ts();
    const out = run(requireHmac('sync'), {
      'x-control-plane-signature': sig(`sync:${t}:ws-a`),
      'x-control-plane-timestamp': t,
      'x-rt-workspace': 'ws-b',
    });
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
  });

  it('rejects old-shape signature sent with a tenant header (no downgrade)', () => {
    const t = ts();
    const out = run(requireHmac('sync'), {
      'x-control-plane-signature': sig(`sync:${t}`),
      'x-control-plane-timestamp': t,
      'x-rt-workspace': 'ws-a',
    });
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
  });

  it('tenantRequired rejects headerless requests', () => {
    const t = ts();
    const out = run(requireHmac('sync', { tenantRequired: true }), {
      'x-control-plane-signature': sig(`sync:${t}`),
      'x-control-plane-timestamp': t,
    });
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
    expect(out.body.error).toContain('X-Rt-Workspace');
  });

  it('rejects stale timestamps', () => {
    const old = (Date.now() - 6 * 60 * 1000).toString();
    const out = run(requireHmac('sync'), {
      'x-control-plane-signature': sig(`sync:${old}`),
      'x-control-plane-timestamp': old,
    });
    expect(out.nexted).toBe(false);
    expect(out.statusCode).toBe(401);
  });
});
