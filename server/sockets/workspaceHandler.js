// server/sockets/workspaceHandler.js — Workspace presence, typing, and cursor tracking
const workspaceService = require('../services/workspaceService');
const config = require('../config');

// Online users, keyed `${wsId}:${userId}` — a pooled process serves many
// workspaces, and a userId-only key would let one tenant's presence entry
// shadow (and broadcast into) another's. Dedicated pods have exactly one
// wsId prefix (config.workspaceId), preserving old behavior.
const presence = new Map(); // `${wsId}:${userId}` → { wsId, userId, socketId, username, displayName, activity, cursorMessageId }

// Track last meaningful user activity (chat, typing, scrolling, cursor moves)
// per workspace. Exported so the health endpoint can report it to the
// dashboard idle checker, and so pooled Arthur's heartbeat can report
// per-tenant liveness. No-arg reads/touches default to config.workspaceId
// (dedicated pods keep the old single-workspace semantics).
const lastActivityByWs = new Map(); // wsId → timestamp ms
const bootTime = Date.now();

function touchActivity(wsId) {
  lastActivityByWs.set(wsId || config.workspaceId, Date.now());
}

function getLastActivityAt(wsId) {
  return lastActivityByWs.get(wsId || config.workspaceId) || bootTime;
}

function setupWorkspaceHandlers(io, socket) {
  const wsId = socket.rtWorkspaceId || config.workspaceId;
  const wsChannel = `ws:${wsId}`;
  const presenceKey = `${wsId}:${socket.userId}`;

  // Auto-join workspace channel on connect
  socket.join(wsChannel);

  // Register presence
  (async () => {
    const user = await workspaceService.getUserById(socket.userId);
    presence.set(presenceKey, {
      wsId,
      userId: socket.userId,
      socketId: socket.id,
      username: socket.username,
      displayName: user ? user.display_name : socket.username,
      activity: 'idle',
      cursorMessageId: null,
    });
    broadcastPresence(io, wsId);
    console.log(`[Workspace] ${socket.username} joined workspace ${wsId}`);
  })();

  // ─── Activity & Cursor Tracking ───────────────────
  socket.on('typing-start', () => {
    updateActivity(io, socket, 'composing');
  });

  socket.on('typing-stop', () => {
    updateActivity(io, socket, 'reading');
  });

  socket.on('cursor-position', ({ messageId }) => {
    if (presence.has(presenceKey)) {
      presence.get(presenceKey).cursorMessageId = messageId;
      socket.to(wsChannel).emit('cursor-update', {
        userId: socket.userId,
        username: socket.username,
        displayName: presence.get(presenceKey).displayName,
        messageId,
      });
    }
  });

  socket.on('user-scrolling', () => {
    updateActivity(io, socket, 'reading');
  });

  // ─── Disconnect Cleanup ───────────────────────────
  socket.on('disconnect', () => {
    presence.delete(presenceKey);
    broadcastPresence(io, wsId);
  });
}

function updateActivity(io, socket, activity) {
  const wsId = socket.rtWorkspaceId || config.workspaceId;
  const presenceKey = `${wsId}:${socket.userId}`;
  if (presence.has(presenceKey)) {
    presence.get(presenceKey).activity = activity;
    touchActivity(wsId);
    broadcastPresence(io, wsId);
  }
}

function broadcastPresence(io, wsId) {
  const targetWs = wsId || config.workspaceId;
  const wsChannel = `ws:${targetWs}`;
  io.to(wsChannel).emit('presence-update', {
    users: Array.from(presence.values()).filter((u) => u.wsId === targetWs),
  });
}

module.exports = { setupWorkspaceHandlers, presence, getLastActivityAt, touchActivity };
