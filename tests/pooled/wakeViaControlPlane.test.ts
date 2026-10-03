/**
 * Peer wake goes through the control plane (upgrade plan 3.1 follow-up).
 *
 *   - utils/wakeWorkspace POSTs /api/internal/workspaces/:target/wake with a
 *     v2 signature: routePath 'wake', tenant-bound to the REQUESTING
 *     workspace, body hashed, fleet BRIDGE_HMAC_SECRET; legacy X-Bridge-*
 *     headers alongside. The control plane's verifier (CP
 *     api/routes/internal.ts) accepts exactly this.
 *   - Response mapping: 2xx → 'scaled'; 404 target-not-found → 'not_found'
 *     (stale bridge); 403 NOT_LINKED / 5xx / network → 'failed'.
 *   - requester === target and a missing requester never leave the pod.
 *   - RT_LEGACY_INPOD_WAKE=true routes to the in-pod k8s PATCH instead
 *     (default false: no PATCH, no SA token read).
 *   - intent_bridge and bridge_workspace no longer contain a Kubernetes
 *     PATCH; both call the shared helper.
 */

import fs from 'fs';
import path from 'path';

const mockConfig: any = {
  pooled: false,
  pooledArthur: false,
  workspaceId: 'ws-requester',
  bridgeHmacSecret: 'fleet-secret',
};
jest.mock('../../server/config', () => mockConfig);

const s2s = require('../../server/utils/s2sSig');
import { wakeWorkspace, legacyInPodWakeEnabled } from '../../server/utils/wakeWorkspace';
import { nonceStore } from '../../server/protocols/nonceStore';

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.RT_LEGACY_INPOD_WAKE;
  delete process.env.RT_HMAC_EMIT_V2;
  process.env.CONTROL_PLANE_URL = 'https://cp.test';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...SAVED };
  jest.restoreAllMocks();
});
afterAll(() => nonceStore.destroy());

type Call = { url: string; init: RequestInit };
function fetchStub(status: number, body: any, calls: Call[]) {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** Verify the captured request the way the control plane does. */
async function verifyLikeCp(call: Call, target: string) {
  const headers = call.init.headers as Record<string, string>;
  const rawBody = Buffer.from(String(call.init.body));
  const v = await s2s.verifyPathV2({
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody,
    routePath: 'wake',
    tenantWsId: headers[s2s.TENANT_WS_HEADER],
    secret: 'fleet-secret',
  });
  return { v, headers, url: call.url, target };
}

describe('wakeWorkspace → control plane', () => {
  it('POSTs a v2-signed wake, tenant-bound to the requester, target in the URL', async () => {
    const calls: Call[] = [];
    const out = await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', source: 'intent_bridge', fetchImpl: fetchStub(200, { status: 'scaled', workspaceId: 'ws-target' }, calls) });
    expect(out).toBe('scaled');
    expect(calls).toHaveLength(1);
    const { v, headers, url } = await verifyLikeCp(calls[0], 'ws-target');
    expect(url).toBe('https://cp.test/api/internal/workspaces/ws-target/wake');
    expect(calls[0].init.method).toBe('POST');
    expect(headers[s2s.SIGV_HEADER]).toBe('2');
    expect(headers[s2s.TENANT_WS_HEADER]).toBe('ws-requester');
    expect(v).toEqual({ ok: true });
    // Legacy headers ride alongside for a v1-only control plane.
    expect(headers['X-Bridge-WsId']).toBe('ws-requester');
    expect(headers['X-Bridge-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it("'already_running' is success too", async () => {
    const calls: Call[] = [];
    expect(await wakeWorkspace('ws-pooled', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, { status: 'already_running' }, calls) })).toBe('scaled');
  });

  it('a signature the control plane cannot verify is not what we send: body drift breaks it', async () => {
    const calls: Call[] = [];
    await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, calls) });
    const headers = calls[0].init.headers as Record<string, string>;
    const v = await s2s.verifyPathV2({
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      rawBody: Buffer.from('{"tampered":true}'),
      routePath: 'wake', tenantWsId: 'ws-requester', secret: 'fleet-secret',
    });
    expect(v.ok).toBe(false);
  });

  it('maps a 404 target-not-found to not_found (stale bridge) and other refusals to failed', async () => {
    expect(await wakeWorkspace('ws-gone', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(404, { error: 'Target workspace not found in this organization' }, []) })).toBe('not_found');
    expect(await wakeWorkspace('ws-gone', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(404, { error: 'Target deployment not found', status: 'not_found' }, []) })).toBe('not_found');
    expect(await wakeWorkspace('ws-x', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(404, { error: 'Requesting workspace not found' }, []) })).toBe('failed');
    expect(await wakeWorkspace('ws-x', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(403, { error: 'No active bridge or contract between these workspaces', code: 'NOT_LINKED' }, []) })).toBe('failed');
    expect(await wakeWorkspace('ws-x', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(500, { error: 'Wake failed' }, []) })).toBe('failed');
    expect(await wakeWorkspace('ws-x', { requesterWsId: 'ws-requester', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any })).toBe('failed');
  });

  it('never asks the control plane to wake the requester itself, or without a requester', async () => {
    const calls: Call[] = [];
    expect(await wakeWorkspace('ws-requester', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, calls) })).toBe('failed');
    expect(await wakeWorkspace('ws-target', { requesterWsId: '', fetchImpl: fetchStub(200, {}, calls) })).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('RT_HMAC_EMIT_V2=false strips the v2 headers but keeps the legacy X-Bridge-* ones', async () => {
    process.env.RT_HMAC_EMIT_V2 = 'false';
    const calls: Call[] = [];
    await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, calls) });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[s2s.SIGV_HEADER]).toBeUndefined();
    expect(headers['X-Bridge-WsId']).toBe('ws-requester');
  });
});

describe('RT_LEGACY_INPOD_WAKE', () => {
  it('is off by default and the control plane path reads no service-account token', async () => {
    expect(legacyInPodWakeEnabled()).toBe(false);
    const readSpy = jest.spyOn(fs, 'readFileSync');
    const calls: Call[] = [];
    await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, calls) });
    expect(readSpy.mock.calls.some((c) => String(c[0]).includes('serviceaccount'))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('=true takes the in-pod PATCH path and never calls the control plane', async () => {
    process.env.RT_LEGACY_INPOD_WAKE = 'true';
    expect(legacyInPodWakeEnabled()).toBe(true);
    const calls: Call[] = [];
    const inPodPatch = jest.fn(async () => 'scaled' as const);
    const out = await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, calls), inPodPatch });
    expect(out).toBe('scaled');
    expect(inPodPatch).toHaveBeenCalledWith('ws-target', expect.any(String));
    expect(calls).toHaveLength(0);
  });

  it('=true without a mounted SA token fails soft', async () => {
    process.env.RT_LEGACY_INPOD_WAKE = 'true';
    const out = await wakeWorkspace('ws-target', { requesterWsId: 'ws-requester', fetchImpl: fetchStub(200, {}, []) });
    expect(out).toBe('failed');
  });
});

describe('the tools no longer PATCH Kubernetes themselves', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../server', p), 'utf8');
  it.each(['tools/intentBridge.ts', 'tools/bridgeWorkspace.ts'])('%s calls the shared helper and holds no k8s PATCH', (file) => {
    const src = read(file);
    expect(src).toMatch(/from '\.\.\/utils\/wakeWorkspace'/);
    expect(src).toMatch(/wakeWorkspace\(bridge\.targetWsId, \{/);
    expect(src).not.toMatch(/serviceaccount/);
    expect(src).not.toMatch(/apis\/apps\/v1/);
    expect(src).not.toMatch(/method: 'PATCH'/);
  });

  it('the only in-pod PATCH left is the legacy path in utils/wakeWorkspace.ts', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (/\.(ts|js)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const root = path.join(__dirname, '../../server');
    const withPatch = walk(root).filter((p) => /apis\/apps\/v1\/namespaces/.test(fs.readFileSync(p, 'utf8')));
    expect(withPatch.map((p) => path.relative(root, p))).toEqual(['utils/wakeWorkspace.ts']);
  });
});
