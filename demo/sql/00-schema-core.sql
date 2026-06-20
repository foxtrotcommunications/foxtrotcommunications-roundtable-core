-- =============================================================================
-- Core Roundtable Schema (all workspaces)
-- Applied to every workspace database in the Pendragon demo.
-- =============================================================================

-- Users table: local auth and SSO-linked accounts
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  email TEXT,
  sso_id TEXT
);

-- Workspaces table: workspace metadata stored locally in each DB
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  ai_provider TEXT,
  ai_model TEXT,
  system_prompt TEXT,
  tools_enabled BOOLEAN DEFAULT true,
  enabled_tools TEXT,
  repos TEXT,
  status TEXT DEFAULT 'active',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  data_sources JSONB,
  ollama_host TEXT,
  allowed_providers TEXT
);

-- Messages table: conversation history per workspace
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER,
  source_workspace_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_call_id TEXT,
  guest_username TEXT,
  guest_display_name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log: tracks security-relevant events
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER,
  username TEXT,
  event_type TEXT NOT NULL,
  event_name TEXT,
  event_detail JSONB,
  ip_address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Workspace usage: token and tool-call accounting
CREATE TABLE IF NOT EXISTS workspace_usage (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  tool_names TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User API keys: per-user provider credentials
CREATE TABLE IF NOT EXISTS user_api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
