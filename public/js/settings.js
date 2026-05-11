// public/js/settings.js — API key management UI
const Settings = {
  async loadKeys() {
    try {
      const keys = await API.getKeys();
      const container = document.getElementById('saved-keys');
      if (!container) return;

      if (keys.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:var(--text-muted);">No API keys configured yet.</p>';
        return;
      }

      container.innerHTML = keys.map((k) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
          <span style="font-size:13px;font-weight:500;flex:1;">${k.provider}</span>
          <span style="font-size:12px;color:var(--text-muted);font-family:monospace;">${k.key_preview}</span>
          <button class="btn btn-ghost btn-sm" onclick="Settings.deleteKey(${k.id})" style="color:var(--error);">✕</button>
        </div>
      `).join('');
    } catch (err) {
      console.error('Failed to load keys:', err);
    }
  },

  async saveKey() {
    const provider = document.getElementById('key-provider').value;
    const apiKey = document.getElementById('key-value').value;
    if (!apiKey) return;

    try {
      await API.saveKey(provider, apiKey);
      document.getElementById('key-value').value = '';
      this.loadKeys();
      App.showToast('API key saved', 'success');
    } catch (err) {
      App.showToast(err.message, 'error');
    }
  },

  async deleteKey(id) {
    try {
      await API.deleteKey(id);
      this.loadKeys();
      App.showToast('API key removed', 'success');
    } catch (err) {
      App.showToast(err.message, 'error');
    }
  },
};
