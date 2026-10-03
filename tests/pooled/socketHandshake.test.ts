/**
 * Socket handshake tenant binding (pooled-arthur-plan Q1).
 * Every accepted branch must set socket.rtWorkspaceId (dedicated:
 * config.workspaceId — ONE downstream code path). Pooled requires the
 * session's SSO-minted workspace binding; the s2s HMAC handshake binds the
 * tenant into the signature; the bare A2A_API_KEY bypass is dedicated-only.
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  bridgeHmacSecret: 'sock-test-secret',
  embedMode: false,
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/sockets/workspaceHandler', () => ({
  setupWorkspaceHandlers: jest.fn(),
  touchActivity: jest.fn(),
  getLastActivityAt: jest.fn(() => 0),
  presence: new Map(),
}));
jest.mock('../../server/sockets/chatHandler', () => ({ setupChatHandlers: jest.fn() }));

import crypto from 'crypto';

const { createAuthMiddleware, verifySocketS2s } = require('../../server/sockets/index');

const SECRET = 'sock-test-secret';

function s2sSig(timestamp: string, workspaceId: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(`socket:${timestamp}:${workspaceId}`).digest('hex');
}

function fakeSocket({ session, auth }: { session?: any; auth?: any }) {
  return {
    request: { session },
    handshake: { auth: auth || {} },
  } as any;
}

// The s2s branch verifies asynchronously (v2 consumes a nonce), so the
// middleware may call next() on a later tick; every other branch is sync.
async function run(socket: any): Promise<{ err: any; accepted: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('middleware did not call next()')), 2000);
    createAuthMiddleware()(socket, (e?: any) => { clearTimeout(timer); resolve({ err: e, accepted: !e }); });
  });
}

const s2s = require('../../server/utils/s2sSig');
/** Exactly what Pendragon's createSocketHmacAuth emits since 1.3 (v2). */
function s2sAuthV2(workspaceId: string, { secret = SECRET, nonce = s2s.newNonce(), timestamp = Date.now().toString() } = {}) {
  const signature = s2s.hmacHex(secret, s2s.v2SignedString({
    routePath: 'socket', timestamp, nonce, bodyHash: s2s.EMPTY_SHA256, tenantWsId: workspaceId,
  }));
  return { hmacSignature: signature, hmacTimestamp: timestamp, hmacNonce: nonce, hmacSigV: '2', workspaceId };
}

beforeEach(() => {
  mockConfig.pooledArthur = false;
  mockConfig.embedMode = false;
  delete process.env.A2A_API_KEY;
});

afterEach(() => {
  delete process.env.A2A_API_KEY;
});

describe('session branch', () => {
  it('dedicated: binds socket.rtWorkspaceId = config.workspaceId', async () => {
    const socket = fakeSocket({ session: { userId: 5, username: 'brady' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBe(5);
  });

  it('pooled: binds socket.rtWorkspaceId from session.workspaceId', async () => {
    mockConfig.pooledArthur = true;
    const socket = fakeSocket({ session: { userId: 5, username: 'brady', workspaceId: 'ws-a' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ws-a');
  });

  it('pooled: rejects a session WITHOUT a workspace binding (fail closed)', async () => {
    mockConfig.pooledArthur = true;
    const socket = fakeSocket({ session: { userId: 5, username: 'brady' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(false);
    expect(socket.rtWorkspaceId).toBeUndefined();
  });
});

describe('s2s tenant-bound HMAC handshake', () => {
  it('accepts a valid handshake and binds the signed tenant', async () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ws-a');
    expect(socket.userId).toBeNull();
    expect(socket.rtS2S).toBe(true);
  });

  it('also works dedicated (tenant-bound is strictly stronger than the bare key)', async () => {
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ded-ws'), hmacTimestamp: ts, workspaceId: 'ded-ws' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
  });

  it('rejects a stale timestamp (>5 min)', async () => {
    mockConfig.pooledArthur = true;
    const ts = (Date.now() - 6 * 60 * 1000).toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    expect((await run(socket)).accepted).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: 'f'.repeat(64), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    expect((await run(socket)).accepted).toBe(false);
  });

  it('rejects a signature minted for a different tenant (no swap)', async () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-b' } });
    expect((await run(socket)).accepted).toBe(false);
    expect(socket.rtWorkspaceId).toBeUndefined();
  });

  it('a failed s2s attempt never falls through to the API-key bypass', async () => {
    process.env.A2A_API_KEY = 'listen-key';
    const ts = Date.now().toString();
    const socket = fakeSocket({
      auth: { hmacSignature: 'f'.repeat(64), hmacTimestamp: ts, workspaceId: 'ws-a', apiKey: 'listen-key' },
    });
    expect((await run(socket)).accepted).toBe(false);
  });

  it('verifySocketS2s helper: valid true, missing fields false', async () => {
    const ts = Date.now().toString();
    expect(await verifySocketS2s({ hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' })).toBe(true);
    expect(await verifySocketS2s({ hmacTimestamp: ts, workspaceId: 'ws-a' })).toBe(false);
    expect(await verifySocketS2s({ hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: '' })).toBe(false);
    expect(await verifySocketS2s(undefined)).toBe(false);
  });

  describe('v2 handshake (Pendragon createSocketHmacAuth shape)', () => {
    afterEach(() => { delete process.env.RT_HMAC_ACCEPT_V1; });

    it('accepted and bound to the signed workspace', async () => {
      const socket = fakeSocket({ auth: s2sAuthV2('ws-a') });
      const r = await run(socket);
      expect(r.accepted).toBe(true);
      expect(socket.rtWorkspaceId).toBe('ws-a');
      expect(socket.rtS2S).toBe(true);
    });

    it('workspaceId swapped after signing → rejected (tenant is in the string)', async () => {
      const auth = { ...s2sAuthV2('ws-a'), workspaceId: 'ws-b' };
      expect((await run(fakeSocket({ auth }))).accepted).toBe(false);
    });

    it('nonce replay → rejected the second time', async () => {
      const auth = s2sAuthV2('ws-a');
      expect((await run(fakeSocket({ auth }))).accepted).toBe(true);
      expect((await run(fakeSocket({ auth }))).accepted).toBe(false);
    });

    it('malformed or missing nonce → rejected', async () => {
      const auth = { ...s2sAuthV2('ws-a'), hmacNonce: 'nope' };
      expect((await run(fakeSocket({ auth }))).accepted).toBe(false);
      const { hmacNonce: _n, ...noNonce } = s2sAuthV2('ws-a');
      expect((await run(fakeSocket({ auth: noNonce }))).accepted).toBe(false);
    });

    it('unknown hmacSigV → rejected', async () => {
      const auth = { ...s2sAuthV2('ws-a'), hmacSigV: '3' };
      expect((await run(fakeSocket({ auth }))).accepted).toBe(false);
    });

    it('v1 refused once RT_HMAC_ACCEPT_V1=false; v2 still accepted', async () => {
      process.env.RT_HMAC_ACCEPT_V1 = 'false';
      const ts = Date.now().toString();
      const v1 = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' } });
      expect((await run(v1)).accepted).toBe(false);
      expect((await run(fakeSocket({ auth: s2sAuthV2('ws-a') }))).accepted).toBe(true);
    });
  });
});

describe('bare A2A_API_KEY bypass', () => {
  it('accepted dedicated — bound to config.workspaceId', async () => {
    process.env.A2A_API_KEY = 'listen-key';
    const socket = fakeSocket({ auth: { apiKey: 'listen-key' } });
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBeNull();
  });

  it('REJECTED pooled — a tenant-less key would be a listener into every room', async () => {
    mockConfig.pooledArthur = true;
    process.env.A2A_API_KEY = 'listen-key';
    const socket = fakeSocket({ auth: { apiKey: 'listen-key' } });
    expect((await run(socket)).accepted).toBe(false);
  });
});

describe('embed-guest branch', () => {
  it('accepted dedicated in embed mode', async () => {
    mockConfig.embedMode = true;
    const socket = fakeSocket({});
    const out = (await run(socket));
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBeNull();
  });

  it('disabled pooled even with embed mode on', async () => {
    mockConfig.pooledArthur = true;
    mockConfig.embedMode = true;
    const socket = fakeSocket({});
    expect((await run(socket)).accepted).toBe(false);
  });
});

describe('no credentials at all', () => {
  it('rejects', async () => {
    expect((await run(fakeSocket({}))).accepted).toBe(false);
  });
});
