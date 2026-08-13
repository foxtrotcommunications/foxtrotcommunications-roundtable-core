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

function run(socket: any): { err: any; accepted: boolean } {
  let err: any;
  let called = false;
  createAuthMiddleware()(socket, (e?: any) => { called = true; err = e; });
  if (!called) throw new Error('middleware did not call next()');
  return { err, accepted: !err };
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
  it('dedicated: binds socket.rtWorkspaceId = config.workspaceId', () => {
    const socket = fakeSocket({ session: { userId: 5, username: 'brady' } });
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBe(5);
  });

  it('pooled: binds socket.rtWorkspaceId from session.workspaceId', () => {
    mockConfig.pooledArthur = true;
    const socket = fakeSocket({ session: { userId: 5, username: 'brady', workspaceId: 'ws-a' } });
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ws-a');
  });

  it('pooled: rejects a session WITHOUT a workspace binding (fail closed)', () => {
    mockConfig.pooledArthur = true;
    const socket = fakeSocket({ session: { userId: 5, username: 'brady' } });
    const out = run(socket);
    expect(out.accepted).toBe(false);
    expect(socket.rtWorkspaceId).toBeUndefined();
  });
});

describe('s2s tenant-bound HMAC handshake', () => {
  it('accepts a valid handshake and binds the signed tenant', () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ws-a');
    expect(socket.userId).toBeNull();
    expect(socket.rtS2S).toBe(true);
  });

  it('also works dedicated (tenant-bound is strictly stronger than the bare key)', () => {
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ded-ws'), hmacTimestamp: ts, workspaceId: 'ded-ws' } });
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
  });

  it('rejects a stale timestamp (>5 min)', () => {
    mockConfig.pooledArthur = true;
    const ts = (Date.now() - 6 * 60 * 1000).toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    expect(run(socket).accepted).toBe(false);
  });

  it('rejects a tampered signature', () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: 'f'.repeat(64), hmacTimestamp: ts, workspaceId: 'ws-a' } });
    expect(run(socket).accepted).toBe(false);
  });

  it('rejects a signature minted for a different tenant (no swap)', () => {
    mockConfig.pooledArthur = true;
    const ts = Date.now().toString();
    const socket = fakeSocket({ auth: { hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-b' } });
    expect(run(socket).accepted).toBe(false);
    expect(socket.rtWorkspaceId).toBeUndefined();
  });

  it('a failed s2s attempt never falls through to the API-key bypass', () => {
    process.env.A2A_API_KEY = 'listen-key';
    const ts = Date.now().toString();
    const socket = fakeSocket({
      auth: { hmacSignature: 'f'.repeat(64), hmacTimestamp: ts, workspaceId: 'ws-a', apiKey: 'listen-key' },
    });
    expect(run(socket).accepted).toBe(false);
  });

  it('verifySocketS2s helper: valid true, missing fields false', () => {
    const ts = Date.now().toString();
    expect(verifySocketS2s({ hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: 'ws-a' })).toBe(true);
    expect(verifySocketS2s({ hmacTimestamp: ts, workspaceId: 'ws-a' })).toBe(false);
    expect(verifySocketS2s({ hmacSignature: s2sSig(ts, 'ws-a'), hmacTimestamp: ts, workspaceId: '' })).toBe(false);
    expect(verifySocketS2s(undefined)).toBe(false);
  });
});

describe('bare A2A_API_KEY bypass', () => {
  it('accepted dedicated — bound to config.workspaceId', () => {
    process.env.A2A_API_KEY = 'listen-key';
    const socket = fakeSocket({ auth: { apiKey: 'listen-key' } });
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBeNull();
  });

  it('REJECTED pooled — a tenant-less key would be a listener into every room', () => {
    mockConfig.pooledArthur = true;
    process.env.A2A_API_KEY = 'listen-key';
    const socket = fakeSocket({ auth: { apiKey: 'listen-key' } });
    expect(run(socket).accepted).toBe(false);
  });
});

describe('embed-guest branch', () => {
  it('accepted dedicated in embed mode', () => {
    mockConfig.embedMode = true;
    const socket = fakeSocket({});
    const out = run(socket);
    expect(out.accepted).toBe(true);
    expect(socket.rtWorkspaceId).toBe('ded-ws');
    expect(socket.userId).toBeNull();
  });

  it('disabled pooled even with embed mode on', () => {
    mockConfig.pooledArthur = true;
    mockConfig.embedMode = true;
    const socket = fakeSocket({});
    expect(run(socket).accepted).toBe(false);
  });
});

describe('no credentials at all', () => {
  it('rejects', () => {
    expect(run(fakeSocket({})).accepted).toBe(false);
  });
});
