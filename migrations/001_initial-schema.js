// 001_initial-schema.js — Baseline migration extracted from postgresql.js _runMigrations()

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT DEFAULT NULL,
      sso_id TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_id ON users(sso_id) WHERE sso_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email  ON users(email)  WHERE email  IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT,
      ai_provider TEXT DEFAULT 'vertexai',
      ai_model TEXT DEFAULT 'gemini-2.5-flash',
      system_prompt TEXT DEFAULT '',
      tools_enabled BOOLEAN DEFAULT true,
      enabled_tools TEXT DEFAULT NULL,
      repos TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      data_sources JSONB DEFAULT NULL,
      ollama_host TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      source_workspace_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_call_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS user_api_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS workspace_usage (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      tool_names TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_usage_workspace      ON workspace_usage(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_workspace_user  ON workspace_usage(workspace_id, user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS workspace_usage CASCADE;
    DROP TABLE IF EXISTS user_api_keys   CASCADE;
    DROP TABLE IF EXISTS messages         CASCADE;
    DROP TABLE IF EXISTS workspaces       CASCADE;
    DROP TABLE IF EXISTS users            CASCADE;
  `);
};
