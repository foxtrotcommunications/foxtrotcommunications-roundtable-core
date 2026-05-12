// public/js/settings.js — Workspace settings: AI Agent, Tools, and API Keys
const Settings = {

  // ─── Tool catalog (matches server/tools/index.js) ──────────────
  TOOL_CATALOG: [
    { group: '🌐 Web',   tools: ['web_search', 'read_url'] },
    { group: '💻 Code',  tools: ['run_code', 'shell_exec', 'calculator'] },
    { group: '📁 Files', tools: ['read_file', 'write_file', 'list_files', 'find_file'] },
    { group: '🔀 Git',   tools: ['git_clone', 'git_commit'] },
    { group: '🗄️ Data',  tools: ['query_bigquery', 'query_snowflake', 'query_databricks'] },
  ],

  // Suggested models per provider
  MODEL_HINTS: {
    vertexai:  'gemini-2.0-flash-001 · gemini-1.5-pro-002 · gemini-1.5-flash-002',
    openai:    'gpt-4o · gpt-4o-mini · o1-preview',
    anthropic: 'claude-opus-4-5 · claude-sonnet-4-5 · claude-3-5-haiku-20241022',
    google:    'gemini-2.0-flash-001 · gemini-1.5-pro-002',
  },

  // ─── Init ──────────────────────────────────────────────────────
  init() {
    this._bindTabs();
    this._bindAgentSave();
    this._bindToolsButtons();
    this._bindKeySave();
  },

  // ─── Open modal and load current workspace state ───────────────
  async open() {
    document.getElementById('modal-settings').classList.add('active');
    this._showTab('tab-agent');
    await Promise.all([this.loadWorkspace(), this.loadKeys()]);
  },

  close() {
    document.getElementById('modal-settings').classList.remove('active');
  },

  // ─── Tab switching ─────────────────────────────────────────────
  _bindTabs() {
    document.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._showTab(btn.dataset.tab);
      });
    });
  },

  _showTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.settings-tab-panel').forEach((p) => p.classList.remove('active'));
    const tabBtn = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
    const tabPanel = document.getElementById(tabId);
    if (tabBtn) tabBtn.classList.add('active');
    if (tabPanel) tabPanel.classList.add('active');
  },

  // ─── Load workspace settings ───────────────────────────────────
  async loadWorkspace() {
    try {
      const ws = await API.getWorkspaceInfo();

      // AI Agent tab
      const providerEl = document.getElementById('ws-provider');
      const modelEl = document.getElementById('ws-model');
      const promptEl = document.getElementById('ws-system-prompt');

      if (providerEl && ws.ai_provider) providerEl.value = ws.ai_provider;
      if (modelEl) modelEl.value = ws.ai_model || '';
      if (promptEl) promptEl.value = ws.system_prompt || '';
      this._updateModelHint(ws.ai_provider || 'vertexai');

      // Tools tab
      let enabledTools = null;
      if (ws.enabled_tools) {
        try { enabledTools = JSON.parse(ws.enabled_tools); } catch (_) {}
      }
      this._renderToolsGrid(enabledTools);
    } catch (err) {
      console.error('Failed to load workspace settings:', err);
    }
  },

  // ─── Agent settings ────────────────────────────────────────────
  _bindAgentSave() {
    // Update model hint when provider changes
    const providerEl = document.getElementById('ws-provider');
    if (providerEl) {
      providerEl.addEventListener('change', () => this._updateModelHint(providerEl.value));
    }

    document.getElementById('btn-save-agent')?.addEventListener('click', () => this.saveAgent());
  },

  _updateModelHint(provider) {
    const hint = document.getElementById('ws-model-hint');
    if (hint) hint.textContent = this.MODEL_HINTS[provider] ? `Suggested: ${this.MODEL_HINTS[provider]}` : '';
  },

  async saveAgent() {
    const provider = document.getElementById('ws-provider')?.value;
    const model = document.getElementById('ws-model')?.value?.trim();
    const systemPrompt = document.getElementById('ws-system-prompt')?.value;

    try {
      await API.updateWorkspaceInfo({ aiProvider: provider, aiModel: model, systemPrompt });
      App.showToast('Agent settings saved', 'success');
    } catch (err) {
      App.showToast(err.message || 'Failed to save', 'error');
    }
  },

  // ─── Tools grid ────────────────────────────────────────────────
  _renderToolsGrid(enabledTools) {
    const grid = document.getElementById('tools-grid');
    if (!grid) return;

    // null = all enabled
    const allToolNames = this.TOOL_CATALOG.flatMap((g) => g.tools);
    const enabledSet = enabledTools ? new Set(enabledTools) : new Set(allToolNames);

    grid.innerHTML = this.TOOL_CATALOG.map((group) => `
      <div class="tool-group">
        <div class="tool-group-label">${group.group}</div>
        ${group.tools.map((toolName) => {
          const label = toolName.replace(/_/g, ' ');
          const checked = enabledSet.has(toolName) ? 'checked' : '';
          return `
            <label class="tool-toggle">
              <input type="checkbox" class="tool-checkbox" data-tool="${toolName}" ${checked}>
              <span class="tool-toggle-label">${label}</span>
            </label>`;
        }).join('')}
      </div>
    `).join('');
  },

  _bindToolsButtons() {
    document.getElementById('btn-tools-all')?.addEventListener('click', () => {
      document.querySelectorAll('.tool-checkbox').forEach((cb) => { cb.checked = true; });
    });
    document.getElementById('btn-tools-none')?.addEventListener('click', () => {
      document.querySelectorAll('.tool-checkbox').forEach((cb) => { cb.checked = false; });
    });
    document.getElementById('btn-save-tools')?.addEventListener('click', () => this.saveTools());
  },

  async saveTools() {
    const allToolNames = this.TOOL_CATALOG.flatMap((g) => g.tools);
    const checked = [...document.querySelectorAll('.tool-checkbox:checked')].map((cb) => cb.dataset.tool);

    // If all tools are checked, save null (means "all enabled") to keep it clean
    const enabledTools = checked.length === allToolNames.length ? null : checked;

    try {
      await API.updateWorkspaceInfo({ enabledTools });
      App.showToast('Tool settings saved', 'success');
    } catch (err) {
      App.showToast(err.message || 'Failed to save', 'error');
    }
  },

  // ─── API Keys ──────────────────────────────────────────────────
  _bindKeySave() {
    document.getElementById('btn-save-key')?.addEventListener('click', () => this.saveKey());
  },

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
