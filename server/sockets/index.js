// server/sockets/index.js — Socket.IO setup with session integration (workspace-based)
const { Server } = require('socket.io');
const { setupWorkspaceHandlers } = require('./workspaceHandler');
const { setupChatHandlers } = require('./chatHandler');
const config = require('../config');
const crypto = require('crypto');

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

  io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.userId) {
      socket.userId = session.userId;
      socket.username = session.username;
      next();
    } else if (process.env.A2A_API_KEY && socket.handshake.auth?.apiKey === process.env.A2A_API_KEY) {
      // Allow server-to-server connections authenticated via A2A API key
      // (e.g. Pendragon demo API streaming step log events)
      socket.userId = null;
      socket.username = `a2a-listener-${crypto.randomBytes(2).toString('hex')}`;
      next();
    } else if (config.embedMode) {
      // In embed mode, auto-create guest identity when cookies are blocked
      const adjectives = ['swift', 'bright', 'calm', 'bold', 'keen', 'warm', 'wise', 'fair', 'kind', 'glad'];
      const animals = ['fox', 'owl', 'elk', 'jay', 'bee', 'ant', 'ram', 'cod', 'emu', 'yak'];
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const animal = animals[Math.floor(Math.random() * animals.length)];
      const suffix = crypto.randomBytes(2).toString('hex');
      socket.userId = null;
      socket.username = `${adj}-${animal}-${suffix}`;
      next();
    } else {
      next(new Error('Authentication required'));
    }
  });

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

module.exports = { setupSockets };
