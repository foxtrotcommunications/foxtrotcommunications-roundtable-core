// public/js/api.js — REST API client (workspace-based)
const API = {
  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  // Auth
  login(username, password) { return this.request('POST', '/auth/login', { username, password }); },
  register(username, password, displayName) { return this.request('POST', '/auth/register', { username, password, displayName }); },
  logout() { return this.request('POST', '/auth/logout'); },
  me() { return this.request('GET', '/auth/me'); },
  // Workspace
  getWorkspaceInfo() { return this.request('GET', '/workspace/info'); },
  updateWorkspaceInfo(fields) { return this.request('PATCH', '/workspace/info', fields); },
  getMessages(before) { return this.request('GET', `/messages${before ? `?before=${before}` : ''}`); },
  // Cross-workspace
  getWorkspaces() { return this.request('GET', '/workspaces'); },
  getWorkspaceMessages(id, before) { return this.request('GET', `/workspaces/${id}/messages${before ? `?before=${before}` : ''}`); },
  // Keys
  getKeys() { return this.request('GET', '/keys'); },
  saveKey(provider, apiKey) { return this.request('POST', '/keys', { provider, apiKey }); },
  deleteKey(id) { return this.request('DELETE', `/keys/${id}`); },
};
