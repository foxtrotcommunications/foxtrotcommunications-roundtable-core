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
        ai_model TEXT DEFAULT 'gemini-1.5-flash-002',
        system_prompt TEXT DEFAULT '',
        tools_enabled BOOLEAN DEFAULT true,
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
    if (fields.repos !== undefined) { updates.push(`repos = $${idx++}`); values.push(JSON.stringify(fields.repos)); }
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
}

module.exports = PostgreSQLAdapter;
