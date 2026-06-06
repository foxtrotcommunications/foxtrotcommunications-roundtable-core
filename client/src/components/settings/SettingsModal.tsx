import { useState, useEffect } from 'react';
import * as api from '../../api';
import type { DataSources, ApiKeyInfo } from '../../types/workspace';
import ThemeToggle from '../common/ThemeToggle';

const TOOL_CATALOG = [
  { group: '🌐 Web', tools: ['web_search', 'read_url'] },
  { group: '💻 Code', tools: ['run_code', 'shell_exec', 'calculator'] },
  { group: '📁 Files', tools: ['read_file', 'write_file', 'list_files', 'find_file'] },
  { group: '🔀 Git', tools: ['git_clone', 'git_commit', 'git_pull'] },
  { group: '🗄️ Data', tools: ['query_bigquery', 'query_snowflake', 'query_databricks', 'trigger_synthea_pipeline'] },
];

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  vertexai: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'o3-mini', label: 'o3-mini' },
  ],
  anthropic: [
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  google: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  ],
  ollama: [
    { value: 'llama3.1:8b', label: 'Llama 3.1 8B' },
    { value: 'llama3.1:70b', label: 'Llama 3.1 70B' },
    { value: 'qwen2:7b', label: 'Qwen 2 7B' },
    { value: 'mistral:7b', label: 'Mistral 7B' },
    { value: 'codellama:13b', label: 'Code Llama 13B' },
  ],
};

interface Props {
  onClose: () => void;
  onSaved: () => void;
  addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

export default function SettingsModal({ onClose, onSaved, addToast }: Props) {
  const [tab, setTab] = useState('appearance');
  // Appearance state
  const [showToolCalls, setShowToolCalls] = useState(() => localStorage.getItem('rt-show-tool-calls') === 'true');
  // Agent state
  const [provider, setProvider] = useState('vertexai');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [ollamaHost, setOllamaHost] = useState('');
  const [ollamaModels, setOllamaModels] = useState<{ value: string; label: string }[]>([]);
  const [allowedProviders, setAllowedProviders] = useState<string[] | null>(null);

  // Tools state
  const allTools = TOOL_CATALOG.flatMap(g => g.tools);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set(allTools));

  // Data sources state
  const [ds, setDs] = useState<DataSources>({});

  // MCP Servers state
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; url: string; apiKey?: string }>>([]);
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const [newMcpKey, setNewMcpKey] = useState('');

  // A2A Agents state
  const [a2aAgents, setA2aAgents] = useState<Array<{ name: string; url: string; apiKey?: string }>>([]);
  const [newA2aName, setNewA2aName] = useState('');
  const [newA2aUrl, setNewA2aUrl] = useState('');
  const [newA2aKey, setNewA2aKey] = useState('');

  // Keys state
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [keyProvider, setKeyProvider] = useState('openai');
  const [keyValue, setKeyValue] = useState('');

  useEffect(() => {
    api.getWorkspaceInfo().then(workspace => {
      setProvider(workspace.ai_provider || 'vertexai');
      setModel(workspace.ai_model || '');
      setSystemPrompt(workspace.system_prompt || '');
      setOllamaHost(workspace.ollama_host || '');

      // Parse allowed providers restriction
      if (workspace.allowed_providers) {
        try {
          const parsed = JSON.parse(workspace.allowed_providers);
          if (Array.isArray(parsed) && parsed.length > 0) setAllowedProviders(parsed);
        } catch { /* unrestricted */ }
      }

      // Parse enabled tools
      if (workspace.enabled_tools) {
        try {
          const parsed = JSON.parse(workspace.enabled_tools);
          if (Array.isArray(parsed)) setEnabledTools(new Set(parsed));
        } catch { /* use all */ }
      }

      // Parse data sources
      if (workspace.data_sources) {
        try {
          const parsed = typeof workspace.data_sources === 'string' ? JSON.parse(workspace.data_sources) : workspace.data_sources;
          setDs(parsed);
          // Load MCP servers and A2A agents from data_sources
          if (parsed.mcp_servers && Array.isArray(parsed.mcp_servers)) setMcpServers(parsed.mcp_servers);
          if (parsed.a2a_agents && Array.isArray(parsed.a2a_agents)) setA2aAgents(parsed.a2a_agents);
        } catch { /* empty */ }
      }
    });
    api.getKeys().then(setKeys).catch(() => {});
  }, []);

  const saveAgent = async () => {
    try {
      await api.updateWorkspaceInfo({
        aiProvider: provider,
        aiModel: model,
        systemPrompt,
        ollamaHost: provider === 'ollama' ? (ollamaHost || null) : null,
      });
      onSaved();
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed to save', 'error'); }
  };

  const saveTools = async () => {
    const checked = Array.from(enabledTools);
    const value = checked.length === allTools.length ? null : checked;
    try {
      await api.updateWorkspaceInfo({ enabledTools: value });
      onSaved();
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed to save', 'error'); }
  };

  const saveDataSources = async () => {
    const clean = { ...ds };
    if (clean.bigquery && !Object.values(clean.bigquery).some(Boolean)) delete clean.bigquery;
    if (clean.snowflake && !Object.values(clean.snowflake).some(Boolean)) delete clean.snowflake;
    if (clean.databricks && !Object.values(clean.databricks).some(Boolean)) delete clean.databricks;
    try {
      await api.updateWorkspaceInfo({ dataSources: clean });
      onSaved();
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed to save', 'error'); }
  };

  const saveMcpServers = async () => {
    try {
      const updated = { ...ds, mcp_servers: mcpServers };
      await api.updateWorkspaceInfo({ dataSources: updated });
      setDs(updated);
      addToast(`Saved ${mcpServers.length} MCP server(s)`, 'success');
      onSaved();
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed to save', 'error'); }
  };

  const addMcpServer = () => {
    if (!newMcpName.trim() || !newMcpUrl.trim()) return;
    setMcpServers(prev => [...prev, { name: newMcpName.trim(), url: newMcpUrl.trim(), ...(newMcpKey ? { apiKey: newMcpKey } : {}) }]);
    setNewMcpName(''); setNewMcpUrl(''); setNewMcpKey('');
  };

  const removeMcpServer = (idx: number) => setMcpServers(prev => prev.filter((_, i) => i !== idx));

  const saveA2aAgents = async () => {
    try {
      const updated = { ...ds, a2a_agents: a2aAgents };
      await api.updateWorkspaceInfo({ dataSources: updated });
      setDs(updated);
      addToast(`Saved ${a2aAgents.length} A2A agent(s)`, 'success');
      onSaved();
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed to save', 'error'); }
  };

  const addA2aAgent = () => {
    if (!newA2aName.trim() || !newA2aUrl.trim()) return;
    setA2aAgents(prev => [...prev, { name: newA2aName.trim(), url: newA2aUrl.trim(), ...(newA2aKey ? { apiKey: newA2aKey } : {}) }]);
    setNewA2aName(''); setNewA2aUrl(''); setNewA2aKey('');
  };

  const removeA2aAgent = (idx: number) => setA2aAgents(prev => prev.filter((_, i) => i !== idx));

  const saveKey = async () => {
    if (!keyValue) return;
    try {
      await api.saveKey(keyProvider, keyValue);
      setKeyValue('');
      api.getKeys().then(setKeys);
      addToast('API key saved', 'success');
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed', 'error'); }
  };

  const deleteKey = async (id: number) => {
    try {
      await api.deleteKey(id);
      api.getKeys().then(setKeys);
      addToast('Key removed', 'success');
    } catch (err: unknown) { addToast(err instanceof Error ? err.message : 'Failed', 'error'); }
  };

  const toggleTool = (name: string) => {
    setEnabledTools(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const tabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'agent', label: 'AI Agent' },
    { id: 'tools', label: 'Tools' },
    { id: 'data', label: 'Data Sources' },
    { id: 'mcp', label: 'MCP Servers' },
    { id: 'a2a', label: 'A2A Agents' },
    { id: 'keys', label: 'API Keys' },
  ];

  return (
    <div className="modal-overlay active" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>Workspace Settings</h3>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          {tabs.map(t => (
            <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {tab === 'appearance' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">Customize the look and feel of your workspace.</p>
            <div className="form-group">
              <label>Color Scheme</label>
              <ThemeToggle />
            </div>
            <div className="form-group" style={{ marginTop: 20 }}>
              <label>Chat Display</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, fontWeight: 400, marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={showToolCalls}
                  onChange={e => {
                    const val = e.target.checked;
                    setShowToolCalls(val);
                    localStorage.setItem('rt-show-tool-calls', String(val));
                    window.dispatchEvent(new Event('rt-settings-changed'));
                  }}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)' }}
                />
                Show intermediate stages
              </label>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block', marginLeft: 26 }}>
                When enabled, tool calls (BigQuery queries, file reads, etc.) are shown inline during AI responses.
              </span>
            </div>
          </div>
        )}

        {/* Agent Tab */}
        {tab === 'agent' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">Configure the AI provider, model, and system prompt for this workspace.</p>
            <div className="form-group">
              <label>Provider</label>
              {(() => {
                const allProviderList = [
                  { value: 'vertexai', label: 'Vertex AI (Google Cloud)' },
                  { value: 'google', label: 'Google AI Studio' },
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'ollama', label: 'Ollama (OpenAI-compatible)' },
                ];
                const providers = allowedProviders
                  ? allProviderList.filter(p => allowedProviders.includes(p.value))
                  : allProviderList;
                return (
                  <>
                    <select value={provider} onChange={e => setProvider(e.target.value)}>
                      {providers.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    {allowedProviders && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        🔒 Provider restricted by workspace administrator
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
            {provider === 'ollama' && (
              <div className="form-group">
                <label>Ollama Host URL</label>
                <input
                  value={ollamaHost}
                  onChange={e => {
                    setOllamaHost(e.target.value);
                    // Fetch models from the new host
                    const host = e.target.value.replace(/\/+$/, '') || 'http://localhost:11434';
                    fetch(`${host}/api/tags`)
                      .then(r => r.json())
                      .then(data => {
                        if (data.models && Array.isArray(data.models)) {
                          setOllamaModels(data.models.map((m: { name: string }) => ({ value: m.name, label: m.name })));
                        }
                      })
                      .catch(() => setOllamaModels([]));
                  }}
                  placeholder="http://localhost:11434"
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  URL of your Ollama instance. Leave blank to use server default.
                </span>
              </div>
            )}
            <div className="form-group">
              <label>Model</label>
              {(() => {
                const baseOptions = provider === 'ollama' && ollamaModels.length > 0
                  ? ollamaModels
                  : (MODEL_OPTIONS[provider] || []);
                const isKnownModel = baseOptions.some(o => o.value === model);
                return (
                  <>
                    <select
                      value={isKnownModel ? model : '__custom__'}
                      onChange={e => {
                        if (e.target.value === '__custom__') {
                          setModel('');
                        } else {
                          setModel(e.target.value);
                        }
                      }}
                    >
                      {baseOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}{provider !== 'ollama' ? ` (${o.value})` : ''}</option>
                      ))}
                      <option value="__custom__">Custom model…</option>
                    </select>
                    {(!isKnownModel || model === '') && (
                      <input
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        placeholder="Enter custom model ID…"
                        style={{ marginTop: 8 }}
                      />
                    )}
                  </>
                );
              })()}
            </div>
            <div className="form-group">
              <label>System Prompt</label>
              <textarea rows={4} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="Optional custom instructions..." />
            </div>
            <div className="modal-actions"><button className="btn btn-primary btn-sm" onClick={saveAgent}>Save Agent Settings</button></div>
          </div>
        )}

        {/* Tools Tab */}
        {tab === 'tools' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">Enable or disable specific tools the AI can use.</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setEnabledTools(new Set(allTools))}>All</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEnabledTools(new Set())}>None</button>
            </div>
            <div className="tools-grid">
              {TOOL_CATALOG.map(group => (
                <div key={group.group} className="tool-group">
                  <div className="tool-group-label">{group.group}</div>
                  {group.tools.map(name => (
                    <label key={name} className="tool-toggle">
                      <input type="checkbox" className="tool-checkbox" checked={enabledTools.has(name)} onChange={() => toggleTool(name)} />
                      <span className="tool-toggle-label">{name.replace(/_/g, ' ')}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="modal-actions"><button className="btn btn-primary btn-sm" onClick={saveTools}>Save Tool Settings</button></div>
          </div>
        )}

        {/* Data Sources Tab */}
        {tab === 'data' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">Configure data warehouse connections for the AI query tools.</p>
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>BigQuery</h4>
            <div className="form-group"><label>Billing Project</label><input value={ds.bigquery?.project || ''} onChange={e => setDs(prev => ({ ...prev, bigquery: { ...prev.bigquery, project: e.target.value } }))} /></div>
            <div className="form-group"><label>Location</label><input value={ds.bigquery?.location || ''} onChange={e => setDs(prev => ({ ...prev, bigquery: { ...prev.bigquery, location: e.target.value } }))} placeholder="us-central1" /></div>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '16px 0' }} />
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Snowflake</h4>
            <div className="form-group"><label>Account</label><input value={ds.snowflake?.account || ''} onChange={e => setDs(prev => ({ ...prev, snowflake: { ...prev.snowflake, account: e.target.value } }))} /></div>
            <div className="form-group"><label>Username</label><input value={ds.snowflake?.username || ''} onChange={e => setDs(prev => ({ ...prev, snowflake: { ...prev.snowflake, username: e.target.value } }))} /></div>
            <div className="form-group"><label>Password</label><input type="password" value={ds.snowflake?.password || ''} onChange={e => setDs(prev => ({ ...prev, snowflake: { ...prev.snowflake, password: e.target.value } }))} /></div>
            <div className="form-group"><label>Warehouse</label><input value={ds.snowflake?.warehouse || ''} onChange={e => setDs(prev => ({ ...prev, snowflake: { ...prev.snowflake, warehouse: e.target.value } }))} /></div>
            <div className="form-group"><label>Database</label><input value={ds.snowflake?.database || ''} onChange={e => setDs(prev => ({ ...prev, snowflake: { ...prev.snowflake, database: e.target.value } }))} /></div>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '16px 0' }} />
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Databricks</h4>
            <div className="form-group"><label>Host</label><input value={ds.databricks?.host || ''} onChange={e => setDs(prev => ({ ...prev, databricks: { ...prev.databricks, host: e.target.value } }))} /></div>
            <div className="form-group"><label>Token</label><input type="password" value={ds.databricks?.token || ''} onChange={e => setDs(prev => ({ ...prev, databricks: { ...prev.databricks, token: e.target.value } }))} /></div>
            <div className="form-group"><label>HTTP Path</label><input value={ds.databricks?.httpPath || ''} onChange={e => setDs(prev => ({ ...prev, databricks: { ...prev.databricks, httpPath: e.target.value } }))} /></div>
            <div className="modal-actions"><button className="btn btn-primary btn-sm" onClick={saveDataSources}>Save Data Sources</button></div>
          </div>
        )}

        {/* API Keys Tab */}
        {tab === 'keys' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">Add API keys for AI providers. Keys are stored per-user.</p>
            <div className="form-group">
              <label>Provider</label>
              <select value={keyProvider} onChange={e => setKeyProvider(e.target.value)}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google AI Studio</option>
              </select>
            </div>
            <div className="form-group">
              <label>API Key</label>
              <input type="password" value={keyValue} onChange={e => setKeyValue(e.target.value)} placeholder="sk-..." />
            </div>
            <button className="btn btn-primary btn-sm" onClick={saveKey} style={{ marginBottom: 20 }}>Save Key</button>

            <div>
              {keys.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No API keys configured yet.</p>
              ) : keys.map(k => (
                <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{k.provider}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{k.key_preview}</span>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => deleteKey(k.id)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MCP Servers Tab */}
        {tab === 'mcp' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">
              Connect to external MCP (Model Context Protocol) servers to give your AI access to additional tools.
              Tools from connected servers appear automatically in your workspace.
            </p>

            {mcpServers.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {mcpServers.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 16 }}>🔌</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{s.url}</div>
                    </div>
                    {s.apiKey && <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>🔑 key</span>}
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => removeMcpServer(i)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 8 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Server Name</label>
                <input value={newMcpName} onChange={e => setNewMcpName(e.target.value)} placeholder="my-tools" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Server URL</label>
                <input value={newMcpUrl} onChange={e => setNewMcpUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>API Key <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <input type="password" value={newMcpKey} onChange={e => setNewMcpKey(e.target.value)} placeholder="Bearer token for auth" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={addMcpServer} disabled={!newMcpName.trim() || !newMcpUrl.trim()}>+ Add Server</button>
              <button className="btn btn-primary btn-sm" onClick={saveMcpServers}>Save MCP Servers</button>
            </div>
          </div>
        )}

        {/* A2A Agents Tab */}
        {tab === 'a2a' && (
          <div className="settings-tab-panel active">
            <p className="settings-desc">
              Register external A2A (Agent-to-Agent) agents that your workspace AI can delegate tasks to.
              Use the <code style={{ fontSize: 12, padding: '1px 4px', background: 'var(--bg-tertiary)', borderRadius: 3 }}>call_agent</code> tool to communicate with them.
            </p>

            {a2aAgents.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {a2aAgents.map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 16 }}>🤖</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{a.url}</div>
                    </div>
                    {a.apiKey && <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>🔑 key</span>}
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => removeA2aAgent(i)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 8 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Agent Name</label>
                <input value={newA2aName} onChange={e => setNewA2aName(e.target.value)} placeholder="research-agent" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Agent URL</label>
                <input value={newA2aUrl} onChange={e => setNewA2aUrl(e.target.value)} placeholder="https://agent.example.com" />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>API Key <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <input type="password" value={newA2aKey} onChange={e => setNewA2aKey(e.target.value)} placeholder="x-api-key value" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={addA2aAgent} disabled={!newA2aName.trim() || !newA2aUrl.trim()}>+ Add Agent</button>
              <button className="btn btn-primary btn-sm" onClick={saveA2aAgents}>Save A2A Agents</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
