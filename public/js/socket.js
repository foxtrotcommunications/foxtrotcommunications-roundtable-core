// public/js/socket.js — Socket.IO client wrapper (workspace-based)
let socket = null;
let typingTimeout = null;

const Socket = {
  connect() {
    socket = io({ withCredentials: true });

    socket.on('connect', () => {
      console.log('[Socket] Connected to workspace');
    });

    socket.on('disconnect', () => console.log('[Socket] Disconnected'));
    socket.on('error-message', (data) => App.showToast(data.error, 'error'));

    // Presence
    socket.on('presence-update', (data) => {
      if (typeof Presence !== 'undefined') Presence.updatePresence(data.users);
    });

    // Cursor tracking from other users
    socket.on('cursor-update', (data) => {
      Chat.showUserCursor(data);
    });

    // Chat events (no roomId filtering needed — single workspace)
    socket.on('new-message', (msg) => {
      Chat.addMessage(msg);
    });
    socket.on('ai-start', () => {
      Chat.showStreaming(true);
    });
    socket.on('ai-chunk', (data) => {
      Chat.appendAIChunk(data.content);
    });
    socket.on('tool-call', (data) => {
      Chat.showToolCall(data);
    });
    socket.on('tool-result', (data) => {
      Chat.showToolResult(data);
    });
    socket.on('ai-error', (data) => {
      Chat.showAIError(data.error);
      Chat.showStreaming(false);
    });
    socket.on('ai-complete', (data) => {
      Chat.finalizeAIResponse();
      Chat.showStreaming(false);
    });

    // Code panel: auto-refresh when workspace changes
    socket.on('workspace-changed', () => {
      if (typeof CodePanel !== 'undefined') CodePanel.refresh();
    });
  },

  sendMessage(content) {
    const activeRepo = (typeof CodePanel !== 'undefined' && CodePanel.currentRepo) || null;
    if (socket) socket.emit('send-message', { content, activeRepo });
  },

  // ─── Activity & Cursor ────────────────────────────
  sendTypingStart() {
    if (socket) socket.emit('typing-start');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => this.sendTypingStop(), 3000);
  },
  sendTypingStop() {
    if (socket) socket.emit('typing-stop');
    clearTimeout(typingTimeout);
  },
  sendCursorPosition(messageId) {
    if (socket) socket.emit('cursor-position', { messageId });
  },
  sendScrolling() {
    if (socket) socket.emit('user-scrolling');
  },
};
