// server/services/workspaceService.js — Workspace business logic (adapter-backed)
const { getAdapter } = require('../db/adapter');
const config = require('../config');

class WorkspaceService {
  get workspaceId() { return config.workspaceId; }

  async ensureWorkspace() {
    const db = getAdapter();
    let ws = await db.getWorkspace(this.workspaceId);
    if (!ws) {
      ws = await db.registerWorkspace(this.workspaceId, config.workspaceName, config.workspaceUrl, null);
    }
    return ws;
  }

  async getWorkspace() {
    return getAdapter().getWorkspace(this.workspaceId);
  }

  async saveMessage(userId, role, content, toolName, toolCallId, sourceWorkspaceId = null) {
    return getAdapter().saveMessage(this.workspaceId, userId, role, content, toolName, toolCallId, sourceWorkspaceId);
  }

  async getConversationHistory(limit) {
    return getAdapter().getConversationHistory(this.workspaceId, limit);
  }

  async getMessages(options) {
    return getAdapter().getMessages(this.workspaceId, options);
  }

  async getUserApiKey(userId, provider) { return getAdapter().getApiKey(userId, provider); }
  async getUserById(userId) { return getAdapter().getUserById(userId); }
}

module.exports = new WorkspaceService();
