// server/sockets/workspaceHandler.js — Workspace presence, typing, and cursor tracking
const workspaceService = require('../services/workspaceService');
const config = require('../config');

// Online users in this workspace
const presence = new Map(); // userId → { socketId, username, displayName, activity, cursorMessageId }

// Track last meaningful user activity (chat, typing, scrolling, cursor moves)
// Exported so the health endpoint can report it to the dashboard idle checker
let lastActivityAt = Date.now();

function setupWorkspaceHandlers(io, socket) {
  const wsChannel = `ws:${config.workspaceId}`;

  // Auto-join workspace channel on connect
  socket.join(wsChannel);

  // Register presence
  (async () => {
    const user = await workspaceService.getUserById(socket.userId);
    presence.set(socket.userId, {
      socketId: socket.id,
      username: socket.username,
      displayName: user ? user.display_name : socket.username,
      activity: 'idle',
      cursorMessageId: null,
    });
    broadcastPresence(io);
    console.log(`[Workspace] ${socket.username} joined workspace ${config.workspaceId}`);
  })();

  // ─── Activity & Cursor Tracking ───────────────────
  socket.on('typing-start', () => {
    updateActivity(io, socket, 'composing');
  });

  socket.on('typing-stop', () => {
    updateActivity(io, socket, 'reading');
  });

  socket.on('cursor-position', ({ messageId }) => {
    if (presence.has(socket.userId)) {
      presence.get(socket.userId).cursorMessageId = messageId;
      socket.to(wsChannel).emit('cursor-update', {
        userId: socket.userId,
        username: socket.username,
        displayName: presence.get(socket.userId).displayName,
        messageId,
      });
    }
  });

  socket.on('user-scrolling', () => {
    updateActivity(io, socket, 'reading');
  });

  // ─── Disconnect Cleanup ───────────────────────────
  socket.on('disconnect', () => {
    presence.delete(socket.userId);
    broadcastPresence(io);
  });
}

function updateActivity(io, socket, activity) {
  if (presence.has(socket.userId)) {
    presence.get(socket.userId).activity = activity;
    lastActivityAt = Date.now();
    broadcastPresence(io);
  }
}

function broadcastPresence(io) {
  const wsChannel = `ws:${config.workspaceId}`;
  io.to(wsChannel).emit('presence-update', {
    users: Array.from(presence.values()),
  });
}

module.exports = { setupWorkspaceHandlers, presence, getLastActivityAt: () => lastActivityAt, touchActivity: () => { lastActivityAt = Date.now(); } };
