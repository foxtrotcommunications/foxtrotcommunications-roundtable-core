/**
 * Pooled entrypoint mounts the plugin's attested consent-grant route
 * (upgrade plan 4.2; @pendragon/tools-plaid ≥ 1.66.0 exports `consentRoute`)
 * at /api/consent behind requireHmac('consent', { tenantRequired: true }) +
 * attachTenantConnections — the same shape as every other S2S plugin route.
 *
 * Boots server/pooled/index.js for real (express app captured, listen and
 * the DB adapter stubbed) against a virtual plugin whose consentRoute records
 * what reached it.
 */

import crypto from 'crypto';
import http from 'http';

const captured: { app?: any } = {};
jest.mock('express', () => {
  const actual = jest.requireActual('express');
  const wrapped: any = () => {
    const app = actual();
    app.listen = jest.fn((_port: number, cb?: () => void) => { cb?.(); return { close() {} }; });
    captured.app = app;
    return app;
  };
  return Object.assign(wrapped, actual);
});

const mockConfig: any = {
  pooled: true,
  pooledArthur: false,
  pooledDomainType: 'checking',
  databaseUrl: 'postgresql://pooled@localhost/pooled',
  bridgeHmacSecret: 'fleet-secret',
  workspaceId: 'svc-checking',
  port: 0,
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/db/adapter', () => ({
  initAdapter: jest.fn().mockResolvedValue(undefined),
  getAdapter: jest.fn(() => ({})),
}));
jest.mock('../../server/tenantCredentials', () => ({ credentialCacheStats: () => ({}) }));
jest.mock('../../server/utils/fetchManifest', () => ({ fetchManifest: jest.fn(), manifestHealth: () => ({}) }));
jest.mock('../../server/routes/a2a', () => jest.requireActual('express').Router());

const seen: any[] = [];
jest.mock('@pendragon/tools-plaid', () => {
  const { Router } = jest.requireActual('express');
  const consentRoute = Router();
  consentRoute.post('/', (req: any, res: any) => {
    seen.push({ tenant: req.rtTenant, body: req.body });
    res.json({ ok: true, grant_id: req.body.grant_id });
  });
  const memoryRoute = Router();
  memoryRoute.post('/consent-grants', (_req: any, res: any) => res.json({ via: 'memory' }));
  return { consentRoute, memoryRoute };
}, { virtual: true });

const s2s = require('../../server/utils/s2sSig');

let server: http.Server;
let base: string;
beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  require('../../server/pooled/index.js');
  await new Promise((r) => setImmediate(r)); // let start() run through initAdapter
  expect(captured.app).toBeDefined();
  server = http.createServer(captured.app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  jest.restoreAllMocks();
});

const GRANT = {
  grant_id: 'g_1', workspace_id: 'hh-42', scope: 'goals:write', target_hash: 'abc',
  expires_at_ms: Date.now() + 600_000, signature: 'sig', minted_by: 'pd-api',
};

async function post(path: string, headers: Record<string, string>, body: string) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function v2(routePath: string, body: string, tenantWsId?: string, secret = 'fleet-secret') {
  return s2s.signPathV2({ secret, routePath, body, tenantWsId }).headers as Record<string, string>;
}

describe('pooled /api/consent', () => {
  beforeEach(() => { seen.length = 0; });

  it('is mounted and reaches consentRoute with the HMAC-bound tenant and lazy connections attached', async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/consent', v2('consent', body, 'hh-42'), body);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, grant_id: 'g_1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].tenant.workspaceId).toBe('hh-42');
    expect(typeof seen[0].tenant.resolveConnections).toBe('function');
    expect(seen[0].body.workspace_id).toBe('hh-42');
  });

  it('requires a tenant: a signature without X-Rt-Workspace is refused', async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/consent', v2('consent', body), body);
    expect(out.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("is its own routePath: a request signed for 'memory' does not open /api/consent", async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/consent', v2('memory', body, 'hh-42'), body);
    expect(out.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses the fleet-secret path when the body was altered after signing', async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/consent', v2('consent', body, 'hh-42'), body.replace('"g_1"', '"g_2"'));
    expect(out.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/consent', v2('consent', body, 'hh-42', crypto.randomBytes(8).toString('hex')), body);
    expect(out.status).toBe(401);
  });

  it('the legacy memory mount keeps serving POST /api/memory/consent-grants', async () => {
    const body = JSON.stringify(GRANT);
    const out = await post('/api/memory/consent-grants', v2('memory', body, 'hh-42'), body);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ via: 'memory' });
  });

  it("is listed in the S2S routePath registry as pd->core, tenant 'optional'", () => {
    const fixture = require('./s2sRoutePaths.json');
    const row = fixture.routes.find((r: any) => r.route === 'consent');
    expect(row).toEqual({ route: 'consent', tenantBound: 'optional', direction: 'pd->core' });
  });
});
