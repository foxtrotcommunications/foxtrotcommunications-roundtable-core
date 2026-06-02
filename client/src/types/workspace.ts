// Type definitions for workspace and settings

export interface Workspace {
  id: string;
  name: string;
  url?: string;
  ai_provider: string;
  ai_model: string;
  system_prompt: string;
  tools_enabled: boolean;
  enabled_tools: string | null;
  repos: string;
  data_sources: DataSources | string | null;
  ollama_host?: string | null;
  allowed_providers?: string | null;
  status: string;
  version?: string;
  created_at: string;
  last_active: string;
}

export interface DataSources {
  bigquery?: {
    project?: string;
    location?: string;
    dataProject?: string;
    datasets?: Record<string, string>;
  };
  snowflake?: {
    account?: string;
    username?: string;
    password?: string;
    warehouse?: string;
    database?: string;
  };
  databricks?: {
    host?: string;
    token?: string;
    httpPath?: string;
  };
}

export interface User {
  id: number;
  username: string;
  displayName: string;
}

export interface ApiKeyInfo {
  id: number;
  provider: string;
  key_preview: string;
}

export interface PresenceUser {
  userId: number;
  username: string;
  displayName: string;
  activity?: 'active' | 'composing' | 'idle';
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
