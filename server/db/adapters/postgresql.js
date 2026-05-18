// server/db/adapters/postgresql.js — PostgreSQL adapter (workspace-based, no rooms)
const { Pool } = require('pg');

class PostgreSQLAdapter {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  async initialize() {
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await this.pool.connect();
    client.release();

    await this._runMigrations();
    console.log('[DB] PostgreSQL adapter initialized');
  }

  async close() {
    if (this.pool) { await this.pool.end(); this.pool = null; }
  }

  // ─── Internal helpers ───────────────────────────
  async _queryOne(sql, params = []) {
    const { rows } = await this.pool.query(sql, params);
    return rows[0] || null;
  }

  async _queryAll(sql, params = []) {
    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  async _execute(sql, params = []) {
    const { rows } = await this.pool.query(sql + ' RETURNING id', params);
    return rows[0] ? rows[0].id : 0;
  }

  async _exec(sql, params = []) {
    await this.pool.query(sql, params);
  }

  async _runMigrations() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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

      CREATE TABLE IF NOT EXISTS user_api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
    `);
    // Idempotent column additions for existing deployments
    await this.pool.query(`
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS enabled_tools TEXT DEFAULT NULL;
    `);
    await this.pool.query(`
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT NULL;
    `);
    await this.pool.query(`
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ollama_host TEXT DEFAULT NULL;
    `);

    // Usage tracking table
    await this.pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_usage_workspace ON workspace_usage(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_workspace_user ON workspace_usage(workspace_id, user_id);
    `);

    console.log('[DB] Migrations complete');

    // SSO columns — idempotent additions for existing deployments
    await this.pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL;`);
    await this.pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_id TEXT DEFAULT NULL;`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_id ON users(sso_id) WHERE sso_id IS NOT NULL;`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;`);

    console.log('[DB] Migrations complete');
  }

  // ─── Users ──────────────────────────────────────

  async createUser(username, displayName, passwordHash) {
    const id = await this._execute(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3)',
      [username, displayName, passwordHash]
    );
    return this._queryOne('SELECT id, username, display_name, created_at FROM users WHERE id = $1', [id]);
  }

  async getUserById(id) {
    return this._queryOne('SELECT id, username, display_name, created_at FROM users WHERE id = $1', [id]);
  }

  async getUserByUsername(username) {
    return this._queryOne('SELECT * FROM users WHERE username = $1', [username]);
  }

  async getUserByEmail(email) {
    return this._queryOne('SELECT * FROM users WHERE email = $1', [email]);
  }

  /**
   * Upsert a user from an SSO token. Creates the user if they don't exist,
   * or updates display_name/email if they do. Returns the user row.
   */
  async upsertUserBySsoId(ssoId, email, displayName) {
    // Try to find by sso_id first (most stable)
    let user = await this._queryOne('SELECT * FROM users WHERE sso_id = $1', [ssoId]);
    if (user) {
      // Update display name and email in case they changed
      await this._exec(
        'UPDATE users SET display_name = $1, email = $2 WHERE sso_id = $3',
        [displayName, email, ssoId]
      );
      return this._queryOne('SELECT id, username, display_name, email, sso_id FROM users WHERE sso_id = $1', [ssoId]);
    }
    // Try by email (covers re-connections before sso_id was stored)
    user = await this._queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (user) {
      await this._exec(
        'UPDATE users SET sso_id = $1, display_name = $2 WHERE email = $3',
        [ssoId, displayName, email]
      );
      return this._queryOne('SELECT id, username, display_name, email, sso_id FROM users WHERE email = $1', [email]);
    }
    // New SSO user — generate a unique username from email prefix
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    let username = base;
    let attempt = 0;
    while (await this._queryOne('SELECT id FROM users WHERE username = $1', [username])) {
      username = `${base}${++attempt}`;
    }
    const id = await this._execute(
      'INSERT INTO users (username, display_name, password_hash, email, sso_id) VALUES ($1, $2, $3, $4, $5)',
      [username, displayName, '', email, ssoId]
    );
    return this._queryOne('SELECT id, username, display_name, email, sso_id FROM users WHERE id = $1', [id]);
  }

  // ─── Workspaces ─────────────────────────────────
  async registerWorkspace(id, name, url, createdBy) {
    await this._exec(`
      INSERT INTO workspaces (id, name, url, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        url = EXCLUDED.url,
        status = 'active',
        last_active = CURRENT_TIMESTAMP
    `, [id, name, url, createdBy]);
    return this.getWorkspace(id);
  }

  async getWorkspace(id) {
    return this._queryOne('SELECT * FROM workspaces WHERE id = $1', [id]);
  }

  async getAllWorkspaces() {
    return this._queryAll('SELECT * FROM workspaces ORDER BY last_active DESC');
  }

  async getActiveWorkspaces() {
    return this._queryAll("SELECT * FROM workspaces WHERE status = 'active' ORDER BY last_active DESC");
  }

  async updateWorkspaceHeartbeat(id) {
    await this._exec('UPDATE workspaces SET last_active = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }

  async updateWorkspaceStatus(id, status) {
    await this._exec('UPDATE workspaces SET status = $1 WHERE id = $2', [status, id]);
  }

  async updateWorkspace(id, fields) {
    const updates = []; const values = [];
    let idx = 1;
    if (fields.name !== undefined) { updates.push(`name = $${idx++}`); values.push(fields.name); }
    if (fields.aiProvider !== undefined) { updates.push(`ai_provider = $${idx++}`); values.push(fields.aiProvider); }
    if (fields.aiModel !== undefined) { updates.push(`ai_model = $${idx++}`); values.push(fields.aiModel); }
    if (fields.systemPrompt !== undefined) { updates.push(`system_prompt = $${idx++}`); values.push(fields.systemPrompt); }
    if (fields.toolsEnabled !== undefined) { updates.push(`tools_enabled = $${idx++}`); values.push(fields.toolsEnabled); }
    // enabledTools: array of tool names, or null to re-enable all
    if (fields.enabledTools !== undefined) {
      updates.push(`enabled_tools = $${idx++}`);
      values.push(fields.enabledTools === null ? null : JSON.stringify(fields.enabledTools));
    }
    if (fields.repos !== undefined) { updates.push(`repos = $${idx++}`); values.push(JSON.stringify(fields.repos)); }
    if (fields.dataSources !== undefined) {
      updates.push(`data_sources = $${idx++}`);
      values.push(fields.dataSources === null ? null : JSON.stringify(fields.dataSources));
    }
    if (fields.ollamaHost !== undefined) {
      updates.push(`ollama_host = $${idx++}`);
      values.push(fields.ollamaHost || null);
    }
    if (updates.length === 0) return this.getWorkspace(id);
    values.push(id);
    await this._exec(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    return this.getWorkspace(id);
  }

  // ─── Messages ───────────────────────────────────
  async saveMessage(workspaceId, userId, role, content, toolName = null, toolCallId = null, sourceWorkspaceId = null) {
    const id = await this._execute(
      'INSERT INTO messages (workspace_id, user_id, role, content, tool_name, tool_call_id, source_workspace_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [workspaceId, userId, role, content, toolName, toolCallId, sourceWorkspaceId]
    );
    return this._queryOne(`
      SELECT m.*, u.username, u.display_name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.id = $1
    `, [id]);
  }

  async getMessages(workspaceId, options = {}) {
    const limit = Math.min(options.limit || 50, 200);
    if (options.before) {
      const rows = await this._queryAll(`
        SELECT m.*, u.username, u.display_name FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.id < $2 ORDER BY m.created_at DESC LIMIT $3
      `, [workspaceId, options.before, limit]);
      return rows.reverse();
    }
    const rows = await this._queryAll(`
      SELECT m.*, u.username, u.display_name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY m.created_at DESC LIMIT $2
    `, [workspaceId, limit]);
    return rows.reverse();
  }

  async getConversationHistory(workspaceId, limit = 50) {
    return this.getMessages(workspaceId, { limit });
  }

  // ─── API Keys ───────────────────────────────────
  async saveApiKey(userId, provider, apiKey) {
    await this._exec('DELETE FROM user_api_keys WHERE user_id = $1 AND provider = $2', [userId, provider]);
    await this._exec('INSERT INTO user_api_keys (user_id, provider, api_key) VALUES ($1,$2,$3)', [userId, provider, apiKey]);
  }

  async getApiKey(userId, provider) {
    const row = await this._queryOne('SELECT api_key FROM user_api_keys WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return row ? row.api_key : null;
  }

  async getApiKeys(userId) {
    return this._queryAll(
      "SELECT id, provider, LEFT(api_key, 8) || '...' as key_preview, created_at FROM user_api_keys WHERE user_id = $1",
      [userId]
    );
  }

  async deleteApiKey(id, userId) {
    await this._exec('DELETE FROM user_api_keys WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  // ─── Usage Tracking ─────────────────────────────
  async recordUsage(workspaceId, userId, provider, model, promptTokens, completionTokens, totalTokens, toolCalls, toolNames) {
    await this._exec(
      `INSERT INTO workspace_usage (workspace_id, user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, tool_calls, tool_names)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [workspaceId, userId, provider, model, promptTokens || 0, completionTokens || 0, totalTokens || 0, toolCalls || 0, JSON.stringify(toolNames || [])]
    );
  }

  async getUsageSummary(workspaceId, periodDays = 30) {
    return this._queryOne(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(tool_calls), 0) as total_tool_calls
      FROM workspace_usage
      WHERE workspace_id = $1
        AND created_at >= NOW() - INTERVAL '1 day' * $2
    `, [workspaceId, periodDays]);
  }

  async getUsageByUser(workspaceId, periodDays = 30) {
    return this._queryAll(`
      SELECT
        u.username, u.display_name,
        COUNT(*) as requests,
        COALESCE(SUM(wu.total_tokens), 0) as total_tokens,
        COALESCE(SUM(wu.tool_calls), 0) as tool_calls
      FROM workspace_usage wu
      LEFT JOIN users u ON u.id = wu.user_id
      WHERE wu.workspace_id = $1
        AND wu.created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY u.id, u.username, u.display_name
      ORDER BY total_tokens DESC
    `, [workspaceId, periodDays]);
  }

  async getUsageByModel(workspaceId, periodDays = 30) {
    return this._queryAll(`
      SELECT
        provider, model,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens
      FROM workspace_usage
      WHERE workspace_id = $1
        AND created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY provider, model
      ORDER BY total_tokens DESC
    `, [workspaceId, periodDays]);
  }

  // ─── Daily spend cap ─────────────────────────────
  /** Returns total tokens used by this workspace since UTC midnight today. */
  async getDailyTokens(workspaceId) {
    const row = await this._queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens
      FROM workspace_usage
      WHERE workspace_id = $1
        AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
    `, [workspaceId]);
    return parseInt(row?.tokens || '0', 10);
  }
}

module.exports = PostgreSQLAdapter;
