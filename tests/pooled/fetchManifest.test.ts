/**
 * Manifest fails closed (upgrade plan 1.1).
 *
 *   - A 200 with empty RT_CONTRACTS means NO contracts: env vars never
 *     resurrect an array the control plane returned empty.
 *   - Env fallback only before the first successful fetch, only for the
 *     process's own workspace, loudly.
 *   - Last-known-good is served for at most RT_MANIFEST_STALE_MAX_MS, then
 *     the tenant degrades to an empty manifest and manifestHealth() flags it;
 *     recovery is immediate on the next good fetch.
 *   - RT_MANIFEST_FAIL_CLOSED=false restores the legacy merge.
 */

jest.mock('../../server/config', () => ({
  bridgeHmacSecret: 'test-bridge-secret',
  workspaceId: 'own-ws',
  pooled: false,
}));

const ENV_KEYS = ['RT_CONTRACTS', 'RT_BRIDGES', 'RT_MCP_SERVERS', 'RT_A2A_AGENTS', 'RT_MANIFEST_FAIL_CLOSED', 'RT_MANIFEST_STALE_MAX_MS', 'CONTROL_PLANE_URL'];
const saved: Record<string, string | undefined> = {};

const ENV_CONTRACT = { contractId: 'env-c', status: 'active', allowedActions: ['*'] };
const CP_CONTRACT = { contractId: 'cp-c', status: 'active', allowedActions: ['*'] };

let fetchMock: jest.Mock;
let nowSpy: jest.SpyInstance;
let now = 1_800_000_000_000;

function ok(body: any) {
  return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => body });
}
function fail(status = 503) {
  return Promise.resolve({ ok: false, status, statusText: 'Service Unavailable', json: async () => ({}) });
}

function load() {
  let mod: any;
  jest.isolateModules(() => { mod = require('../../server/utils/fetchManifest'); });
  return mod as { fetchManifest: (ws?: string) => Promise<any>; manifestHealth: () => any; resetManifestCache: () => void };
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CONTROL_PLANE_URL = 'http://cp.test';
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  now = 1_800_000_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  nowSpy.mockRestore();
  jest.restoreAllMocks();
});

describe('fetchManifest — a 200 is the truth', () => {
  it('an empty RT_CONTRACTS on a 200 stays empty even with RT_CONTRACTS in env', async () => {
    process.env.RT_CONTRACTS = JSON.stringify([ENV_CONTRACT]);
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [], RT_BRIDGES: [] }));
    const { fetchManifest } = load();
    const m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([]);
    expect(m.RT_BRIDGES).toEqual([]);
  });

  it('legacy switch RT_MANIFEST_FAIL_CLOSED=false restores the per-array env merge', async () => {
    process.env.RT_MANIFEST_FAIL_CLOSED = 'false';
    process.env.RT_CONTRACTS = JSON.stringify([ENV_CONTRACT]);
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [], RT_BRIDGES: [] }));
    const { fetchManifest } = load();
    const m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([ENV_CONTRACT]);
  });

  it('returns the control plane contracts and caches them for 5s', async () => {
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT] }));
    const { fetchManifest } = load();
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([CP_CONTRACT]);
    now += 1000;
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([CP_CONTRACT]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchManifest — env fallback is first-boot, own-workspace only', () => {
  it('uses env before the first successful fetch for the own workspace', async () => {
    process.env.RT_CONTRACTS = JSON.stringify([ENV_CONTRACT]);
    fetchMock.mockReturnValueOnce(fail(503));
    const { fetchManifest } = load();
    const m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([ENV_CONTRACT]);
    expect((console.error as jest.Mock).mock.calls.some((c) => /FALLING BACK TO ENV/.test(String(c[0])))).toBe(true);
  });

  it('never hands another tenant the env contracts', async () => {
    process.env.RT_CONTRACTS = JSON.stringify([ENV_CONTRACT]);
    fetchMock.mockReturnValueOnce(fail(503));
    const { fetchManifest } = load();
    const m = await fetchManifest('other-ws');
    expect(m.RT_CONTRACTS).toEqual([]);
  });

  it('after one success, env is never consulted again', async () => {
    process.env.RT_CONTRACTS = JSON.stringify([ENV_CONTRACT]);
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT] }));
    const { fetchManifest } = load();
    await fetchManifest();
    now += 6000;
    fetchMock.mockReturnValueOnce(fail(500));
    const m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([CP_CONTRACT]); // last known good, not env
  });
});

describe('fetchManifest — bounded last-known-good + health flag', () => {
  it('serves last-known-good inside the bound, then degrades to zero contracts', async () => {
    process.env.RT_MANIFEST_STALE_MAX_MS = '60000';
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT], RT_BRIDGES: [{ bridgeId: 'b' }] }));
    const { fetchManifest, manifestHealth } = load();
    await fetchManifest();

    now += 30_000;
    fetchMock.mockReturnValueOnce(Promise.reject(new Error('ECONNREFUSED')));
    let m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([CP_CONTRACT]);
    expect(manifestHealth().degraded).toBe(false);
    expect(manifestHealth().stale).toBe(true);
    expect(manifestHealth().workspaces['own-ws'].servingStale).toBe(true);

    now += 31_000; // 61s since last success > 60s bound
    fetchMock.mockReturnValueOnce(fail(502));
    m = await fetchManifest();
    expect(m.RT_CONTRACTS).toEqual([]);
    expect(m.RT_BRIDGES).toEqual([]);
    const h = manifestHealth();
    expect(h.degraded).toBe(true);
    expect(h.workspaces['own-ws'].degraded).toBe(true);
    expect(h.staleMaxMs).toBe(60000);
  });

  it('degraded tenants are retried on the cache cadence, not every call', async () => {
    process.env.RT_MANIFEST_STALE_MAX_MS = '1000';
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT] }));
    const { fetchManifest } = load();
    await fetchManifest();
    now += 6000;
    fetchMock.mockReturnValue(fail(503));
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([]);
    const calls = fetchMock.mock.calls.length;
    now += 1000; // inside the 5s retry window
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('recovers immediately on the next good fetch', async () => {
    process.env.RT_MANIFEST_STALE_MAX_MS = '1000';
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT] }));
    const { fetchManifest, manifestHealth } = load();
    await fetchManifest();
    now += 6000;
    fetchMock.mockReturnValueOnce(fail(503));
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([]);
    expect(manifestHealth().degraded).toBe(true);
    now += 6000;
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT, ENV_CONTRACT] }));
    expect((await fetchManifest()).RT_CONTRACTS).toHaveLength(2);
    expect(manifestHealth().degraded).toBe(false);
    expect(manifestHealth().stale).toBe(false);
  });

  it('legacy switch keeps serving last-known-good without a bound', async () => {
    process.env.RT_MANIFEST_FAIL_CLOSED = 'false';
    process.env.RT_MANIFEST_STALE_MAX_MS = '1000';
    fetchMock.mockReturnValueOnce(ok({ RT_CONTRACTS: [CP_CONTRACT] }));
    const { fetchManifest, manifestHealth } = load();
    await fetchManifest();
    now += 60 * 60 * 1000;
    fetchMock.mockReturnValueOnce(fail(503));
    expect((await fetchManifest()).RT_CONTRACTS).toEqual([CP_CONTRACT]);
    expect(manifestHealth().degraded).toBe(false);
    expect(manifestHealth().failClosed).toBe(false);
  });

  it('keeps tenants independent: one degraded tenant does not touch another', async () => {
    process.env.RT_MANIFEST_STALE_MAX_MS = '1000';
    fetchMock.mockImplementation((url: string) => url.includes('/ws-a/') ? ok({ RT_CONTRACTS: [CP_CONTRACT] }) : fail(503));
    const { fetchManifest, manifestHealth } = load();
    await fetchManifest('ws-a');
    await fetchManifest('ws-b'); // first boot, not own → empty, no LKG
    now += 6000;
    expect((await fetchManifest('ws-a')).RT_CONTRACTS).toEqual([CP_CONTRACT]);
    expect((await fetchManifest('ws-b')).RT_CONTRACTS).toEqual([]);
    const h = manifestHealth();
    expect(h.workspaces['ws-a'].degraded).toBe(false);
    expect(h.workspaces['ws-b'].hasEverFetched).toBe(false);
  });
});
