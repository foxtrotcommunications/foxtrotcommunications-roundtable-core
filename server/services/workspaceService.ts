// server/services/workspaceService.ts — Workspace business logic (adapter-backed)
import type { DatabaseAdapter, Workspace, Message, User } from '../types';

const { getAdapter } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
const config = require('../config') as import('../types').AppConfig;

class WorkspaceService {
  get workspaceId(): string { return config.workspaceId; }

  async ensureWorkspace(): Promise<Workspace> {
    const db: DatabaseAdapter = getAdapter();
    let ws: Workspace | null = await db.getWorkspace(this.workspaceId);
    if (!ws) {
      ws = await db.registerWorkspace(this.workspaceId, config.workspaceName, config.workspaceUrl, null);
    }
    return ws;
  }

  async getWorkspace(): Promise<Workspace | null> {
    return getAdapter().getWorkspace(this.workspaceId);
  }

  async saveMessage(userId: number | null, role: string, content: string, toolName?: string | null, toolCallId?: string | null, sourceWorkspaceId?: string | null, guestUsername?: string | null, guestDisplayName?: string | null): Promise<Message> {
    return getAdapter().saveMessage(this.workspaceId, userId, role, content, toolName, toolCallId, sourceWorkspaceId, guestUsername, guestDisplayName);
  }

  async getConversationHistory(limit: number): Promise<Message[]> {
    return getAdapter().getConversationHistory(this.workspaceId, limit);
  }

  async getMessages(options?: { limit?: number; before?: number }): Promise<{ messages: Message[]; hasMore: boolean }> {
    return getAdapter().getMessages(this.workspaceId, options);
  }

  async getUserApiKey(userId: number, provider: string): Promise<string> { return getAdapter().getApiKey(userId, provider); }
  async getUserById(userId: number): Promise<User | null> { return getAdapter().getUserById(userId); }
}

module.exports = new WorkspaceService();
