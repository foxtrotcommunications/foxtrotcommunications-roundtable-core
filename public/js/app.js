// public/js/app.js — Main app initialization (workspace-based)
const App = {
  currentUser: null,
  workspace: null,

  async init() {
    try {
      this.currentUser = await API.me();
    } catch {
      window.location.href = '/';
      return;
    }

    // Load workspace info
    try {
      this.workspace = await API.getWorkspaceInfo();
    } catch (e) {
      console.warn('[App] Could not load workspace info:', e.message);
    }

    // Set workspace header
    const wsName = document.getElementById('chat-workspace-name');
    const wsMeta = document.getElementById('chat-workspace-meta');
    if (wsName) wsName.textContent = (this.workspace && this.workspace.name) || 'Roundtable';
    if (wsMeta && this.workspace) {
      wsMeta.textContent = `${this.workspace.ai_provider || 'vertexai'} · ${this.workspace.ai_model || 'gemini-2.5-flash'}`;
    }

    Chat.init();
    if (typeof CodePanel !== 'undefined') CodePanel.init();
    Settings.init();
    Socket.connect();
    this.bindEvents();

    // Load message history
    await Chat.loadHistory();

    // Focus input
    document.getElementById('chat-input')?.focus();
  },

  bindEvents() {
    // Settings
    document.getElementById('btn-settings')?.addEventListener('click', () => Settings.open());
    document.getElementById('btn-close-settings')?.addEventListener('click', () => Settings.close());

    // Chat input
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');

    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea + typing broadcast
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
      if (chatInput.value.trim()) {
        Socket.sendTypingStart();
      }
    });

    chatSend?.addEventListener('click', () => this.sendMessage());

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });
  },

  sendMessage() {
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content || Chat.isStreaming) return;

    Socket.sendMessage(content);
    input.value = '';
    input.style.height = 'auto';
  },

  openModal(id) {
    document.getElementById(id)?.classList.add('active');
  },

  closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
