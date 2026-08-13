// server/sockets/index.js — Socket.IO setup with session integration (workspace-based)
const { Server } = require('socket.io');
const { setupWorkspaceHandlers } = require('./workspaceHandler');
const { setupChatHandlers } = require('./chatHandler');
const config = require('../config');
const crypto = require('crypto');

// ── Tenant-bound S2S handshake auth (pooled + dedicated) ──
// Replaces the bare A2A_API_KEY bypass for pooled deployments: the bare key
// has no tenant semantics, so in a pooled process it would be a listener into
// EVERY room. The signed string binds the workspace into the signature:
//   signature = HMAC(bridgeHmacSecret, `socket:${timestamp}:${workspaceId}`)
// 5-minute freshness window, timing-safe comparison.
function verifySocketS2s(auth) {
  const { hmacSignature, hmacTimestamp, workspaceId } = auth || {};
  if (typeof hmacSignature !== 'string' || !hmacSignature) return false;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) return false;
  const ts = parseInt(hmacTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
  const expected = crypto
    .createHmac('sha256', config.bridgeHmacSecret)
    .update(`socket:${hmacTimestamp}:${workspaceId}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmacSignature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Handshake middleware — sets socket.rtWorkspaceId in EVERY accepted branch so
// downstream handlers have exactly one code path (dedicated: config.workspaceId).
function createAuthMiddleware() {
  return (socket, next) => {
    const session = socket.request.session;
    const handshakeAuth = socket.handshake.auth || {};

    if (session && session.userId) {
      if (config.pooledArthur) {
        // Pooled Arthur: the session's SSO-minted tenant binding is REQUIRED —
        // a session without one has no room to join. Fail closed.
        if (!session.workspaceId) {
          return next(new Error('Workspace binding required'));
        }
        socket.rtWorkspaceId = session.workspaceId;
      } else {
        socket.rtWorkspaceId = config.workspaceId;
      }
      socket.userId = session.userId;
      socket.username = session.username;
      return next();
    }

    // Tenant-bound S2S HMAC handshake (e.g. Pendragon API step-log listener)
    if (handshakeAuth.hmacSignature || handshakeAuth.hmacTimestamp) {
      if (verifySocketS2s(handshakeAuth)) {
        socket.rtWorkspaceId = handshakeAuth.workspaceId;
        socket.userId = null;
        socket.username = `s2s-listener-${crypto.randomBytes(2).toString('hex')}`;
        socket.rtS2S = true;
        return next();
      }
      return next(new Error('Authentication required'));
    }

    // Bare A2A API key bypass — dedicated pods only. NOT accepted pooled:
    // the key cannot say WHICH workspace is being listened to.
    if (!config.pooledArthur && process.env.A2A_API_KEY && handshakeAuth.apiKey === process.env.A2A_API_KEY) {
      // Allow server-to-server connections authenticated via A2A API key
      // (e.g. Pendragon demo API streaming step log events)
      socket.userId = null;
      socket.username = `a2a-listener-${crypto.randomBytes(2).toString('hex')}`;
      socket.rtWorkspaceId = config.workspaceId;
      return next();
    }

    // Embed-guest identities are tenant-less — disabled in pooled Arthur.
    if (!config.pooledArthur && config.embedMode) {
      // In embed mode, auto-create guest identity when cookies are blocked
      const adjectives = ['swift', 'bright', 'calm', 'bold', 'keen', 'warm', 'wise', 'fair', 'kind', 'glad'];
      const animals = ['fox', 'owl', 'elk', 'jay', 'bee', 'ant', 'ram', 'cod', 'emu', 'yak'];
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const animal = animals[Math.floor(Math.random() * animals.length)];
      const suffix = crypto.randomBytes(2).toString('hex');
      socket.userId = null;
      socket.username = `${adj}-${animal}-${suffix}`;
      socket.rtWorkspaceId = config.workspaceId;
      return next();
    }

    return next(new Error('Authentication required'));
  };
}

function setupSockets(httpServer, sessionMiddleware) {
  // Derive allowed origins from workspace URL (set by kubernetes provisioning)
  const wsUrl = process.env.WORKSPACE_URL || '';
  const dashboardUrl = process.env.RT_DASHBOARD_URL || '';
  const embedOrigins = (process.env.EMBED_ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  const allowedOrigins = [wsUrl, dashboardUrl, ...embedOrigins].filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      credentials: true,
    },
  });

  // ── Redis adapter for horizontal scaling ──
  // Set REDIS_URL env var to enable (e.g. redis://10.x.x.x:6379)
  // Without Redis, Socket.IO works in-memory (single replica only)
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { Redis } = require('ioredis');
      const pubClient = new Redis(process.env.REDIS_URL);
      const subClient = pubClient.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
      console.log(`[Socket] Redis adapter connected (${process.env.REDIS_URL})`);
    } catch (err) {
      console.warn('[Socket] Redis adapter failed, falling back to in-memory:', err.message);
    }
  }

  // Share Express session with Socket.IO
  io.engine.use(sessionMiddleware);

  io.use(createAuthMiddleware());

  io.on('connection', (socket) => {
    console.log(`[Socket] User connected: ${socket.username} (${socket.id})`);

    setupWorkspaceHandlers(io, socket);
    setupChatHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${socket.username} (${socket.id})`);
    });
  });

  // Re-validate sessions every 5 minutes for long-lived sockets
  const SESSION_RECHECK_MS = 5 * 60 * 1000;
  setInterval(() => {
    for (const [, socket] of io.sockets.sockets) {
      // Tenant-bound S2S sockets authenticated at the handshake — no session to recheck
      if (socket.rtS2S) continue;
      if (!socket.request.session) { socket.disconnect(true); continue; }
      socket.request.session.reload((err) => {
        if (err || !socket.request.session.userId) {
          socket.emit('session-expired', { message: 'Your session has expired. Please log in again.' });
          socket.disconnect(true);
        }
      });
    }
  }, SESSION_RECHECK_MS);

  return io;
}

module.exports = { setupSockets, createAuthMiddleware, verifySocketS2s };
