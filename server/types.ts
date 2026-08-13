// server/types.ts — Shared type definitions for the Roundtable server

// ─── AI Provider Types ─────────────────────────────────────

export type AIProviderName = 'openai' | 'anthropic' | 'google' | 'vertexai' | 'ollama';

export interface StreamEventTextDelta {
  type: 'text-delta';
  content: string;
}

export interface StreamEventToolCall {
  type: 'tool-call';
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface StreamEventToolResult {
  type: 'tool-result';
  name: string;
  callId: string;
  result: Record<string, unknown>;
}

export interface StreamEventUsage {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamEventDone {
  type: 'done';
  fullText: string;
}

export interface StreamEventError {
  type: 'error';
  error: string;
}

export interface StreamEventProgress {
  type: 'progress';
  step: string;
  label: string;
  state: 'active' | 'completed' | 'pending';
  parent?: string;
  durationMs?: number;
}

export type StreamEvent =
  | StreamEventTextDelta
  | StreamEventToolCall
  | StreamEventToolResult
  | StreamEventUsage
  | StreamEventDone
  | StreamEventError
  | StreamEventProgress;

// ─── Tool Types ────────────────────────────────────────────

export interface ToolParameters {
  type: 'object';
  properties: Record<string, {
    type: string;
    items?: { type: string };
    description?: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  alwaysEnabled?: boolean;
  execute: (args: Record<string, unknown>, workspaceConfig?: WorkspaceConfig) => Promise<Record<string, unknown>>;
}

// ─── Workspace Types ───────────────────────────────────────

export interface DataSources {
  bigquery?: {
    project?: string;
    dataProject?: string;
    datasets?: Record<string, string>;
    schema?: Record<string, string>;
  };
  snowflake?: Record<string, unknown>;
  databricks?: Record<string, unknown>;
}

export interface WorkspaceConfig {
  dataSources?: DataSources;
  ollamaHost?: string;
  model?: string;
  mcpServers?: McpServerConfig[];
  a2aAgents?: A2aAgentConfig[];
  workspaceId?: string;
  workspaceName?: string;
  /** Pooled runtime: the executing tenant — sender tools resolve manifests
   *  and org master secrets from this instead of process env. */
  tenant?: { workspaceId: string; orgId?: string | null };
  traceContext?: {
    traceId: string;
    spanId: string;
    sampled?: boolean;
  };
  /** @internal — tracing parent span, not persisted */
  _llmSpan?: any;
  _onProgress?: (step: string, label: string, state: 'active' | 'completed' | 'pending', opts?: { parent?: string; durationMs?: number }) => void;
}

export interface McpServerConfig {
  name: string;
  url: string;
  apiKey?: string;
}

export interface A2aAgentConfig {
  name: string;
  url: string;
  apiKey?: string;
}

export interface Workspace {
  id: string;
  name: string;
  url?: string;
  ai_provider?: AIProviderName;
  ai_model?: string;
  system_prompt?: string;
  tools_enabled?: boolean;
  enabled_tools?: string;
  data_sources?: string | DataSources;
  ollama_host?: string;
  allowed_providers?: string;
  repos?: string;
  status?: string;
  created_by?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Message {
  id: number;
  workspace_id: string;
  user_id: number | null;
  source_workspace_id?: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
  created_at: string;
  username?: string;
  display_name?: string;
}

export interface User {
  id: number;
  username: string;
  display_name?: string;
  email?: string;
  sso_id?: string;
}

export interface UsageRecord {
  workspace_id: string;
  user_id: number;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  tool_calls: number;
  tool_names: string[];
}

export interface Insight {
  id: number;
  workspace_id: string;
  user_id: number;
  title: string;
  content: string;
  source_message_id: number | null;
  category: 'kpi' | 'risk' | 'opportunity' | 'decision' | 'general';
  pinned_at: string;
  username?: string;
  display_name?: string;
}

// ─── Config Types ──────────────────────────────────────────

export interface AppConfig {
  port: number;
  sessionSecret: string;
  ssoJwtSecret: string;
  bridgeHmacSecret: string;
  databaseUrl: string;
  /** Pooled runtime: domain type this service pools (null = dedicated pod). */
  pooledDomainType: string | null;
  /** Pooled Arthur: the orchestrator as one multi-tenant chat service. */
  pooledArthur: boolean;
  /** Either pooled mode — this process serves many logical workspaces. */
  pooled: boolean;
  workspaceId: string;
  workspaceName: string;
  workspaceUrl: string;
  platformOrg: string;
  aiProvider?: string;
  aiModel?: string;
  systemPrompt?: string;
  embedMode: boolean;
  demoMode: boolean;
  sessionIdleMinutes: number;
  allowedProviders: string | null;
  ai: {
    openai: string;
    anthropic: string;
    google: string;
  };
  vertexai: {
    project: string;
    location: string;
  };
  ollama: {
    host: string;
  };
  googleSearch: {
    apiKey: string;
    engineId: string;
  };
  snowflake: {
    account: string;
    username: string;
    warehouse: string;
    database: string;
    schema: string;
  };
  databricks: {
    host: string;
    httpPath: string;
    catalog: string;
    schema: string;
  };
  mcpServerEnabled: boolean;
  a2aServerEnabled: boolean;
  mcpApiKey: string;
  a2aApiKey: string;
}

// ─── Database Adapter Interface ────────────────────────────

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  registerWorkspace(id: string, name: string, url: string, createdBy: number | null): Promise<Workspace>;
  saveMessage(workspaceId: string, userId: number | null, role: string, content: string, toolName?: string | null, toolCallId?: string | null, sourceWorkspaceId?: string | null, guestUsername?: string | null, guestDisplayName?: string | null): Promise<Message>;
  getConversationHistory(workspaceId: string, limit: number): Promise<Message[]>;
  getMessages(workspaceId: string, options?: { limit?: number; before?: number }): Promise<{ messages: Message[]; hasMore: boolean }>;
  getApiKey(userId: number, provider: string): Promise<string>;
  getUserById(userId: number): Promise<User | null>;
  recordUsage(workspaceId: string, userId: number, provider: string, model: string, promptTokens: number, completionTokens: number, totalTokens: number, toolCalls: number, toolNames: string[]): Promise<void>;
  getMonthlyTokens(workspaceId: string): Promise<number>;
  getInsights(workspaceId: string): Promise<Insight[]>;
  addInsight(workspaceId: string, userId: number, title: string, content: string, sourceMessageId: number | null, category: string): Promise<Insight>;
  deleteInsight(insightId: number, workspaceId: string): Promise<void>;
  audit(workspaceId: string, userId: number | null, username: string, eventType: string, eventName: string, eventDetail: Record<string, unknown>, ipAddress?: string | null): Promise<void>;
  getAuditLog(workspaceId: string, options?: { limit?: number; eventType?: string; before?: number }): Promise<{ entries: unknown[]; hasMore: boolean }>;
}

// ─── OpenAI/Anthropic/Google Stream Types ──────────────────

export interface OpenAIToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AnthropicToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface GoogleFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GoogleUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

// ─── Socket.IO Augmentation ────────────────────────────────

import type { Socket } from 'socket.io';

export interface RoundtableSocket extends Socket {
  userId: number;
  username: string;
  /** Tenant binding set by the handshake middleware in every accepted branch
   *  (dedicated: config.workspaceId) — downstream has ONE code path. */
  rtWorkspaceId?: string;
  /** Set for tenant-bound S2S HMAC handshake sockets (no session to recheck). */
  rtS2S?: boolean;
  isGenerating?: boolean;
  abortController?: AbortController | null;
}

// ─── Chat Message Format ───────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

// ─── Bridge Request ────────────────────────────────────────────────

/**
 * Payload sent by the control plane to a workspace's POST /api/bridge/receive.
 *
 * Signature covers: HMAC-SHA256("taskId:timestamp:contractId:action")
 * — binding the specific action and contract into the request so replaying a
 * signature for a different action or contract is cryptographically infeasible.
 *
 * contractToken = HMAC-SHA256("contractId:sortedAllowedActions")
 * — the workspace re-derives this from its local RT_CONTRACTS manifest and
 * compares it to detect any in-transit tampering of the allowedActions claim.
 */
export interface BridgeRequest {
  taskId: string;
  bridgeId: string;
  /** Present when a contract governs this bridge direction. */
  contractId?: string;
  /** HMAC("contractId:sortedAllowedActions"). Workspace verifies against local manifest. */
  contractToken?: string;
  action: 'message' | 'delegate' | 'result';
  content: string;
  sourceWorkspace: { id: string; name: string; orgId?: string };
  timestamp: string;
  /** HMAC("taskId:timestamp:contractId:action"). Proves control-plane origin. */
  signature: string;
}
