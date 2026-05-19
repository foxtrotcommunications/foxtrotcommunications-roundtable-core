// REST API client — typed version of the vanilla api.js

import type { ChatMessage } from './types/message';
import type { Workspace, User, ApiKeyInfo, DataSources } from './types/workspace';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data as T;
}

// Auth
export const login = (username: string, password: string) =>
  request<User>('POST', '/auth/login', { username, password });

export const register = (username: string, password: string, displayName: string) =>
  request<User>('POST', '/auth/register', { username, password, displayName });

export const logout = () => request<void>('POST', '/auth/logout');

export const me = () => request<User>('GET', '/auth/me');

// Workspace
export const getWorkspaceInfo = () => request<Workspace>('GET', '/workspace/info');

export const updateWorkspaceInfo = (fields: {
  aiProvider?: string;
  aiModel?: string;
  systemPrompt?: string;
  enabledTools?: string[] | null;
  dataSources?: DataSources;
  ollamaHost?: string | null;
}) => request<Workspace>('PATCH', '/workspace/info', fields);

// Messages
export const getMessages = (before?: number) =>
  request<ChatMessage[]>('GET', `/messages${before ? `?before=${before}` : ''}`);

// Keys
export const getKeys = () => request<ApiKeyInfo[]>('GET', '/keys');
export const saveKey = (provider: string, apiKey: string) =>
  request<void>('POST', '/keys', { provider, apiKey });
export const deleteKey = (id: number) => request<void>('DELETE', `/keys/${id}`);

// Bridges
export const getBridges = () =>
  request<{ bridgeId: string; targetWsId: string; targetName: string; permissions: string[] }[]>('GET', '/workspace/bridges');
