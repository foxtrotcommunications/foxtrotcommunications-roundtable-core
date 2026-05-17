// server/db/adapters/sqlite.js — SQLite adapter for local development (no PostgreSQL required)
// Data persists to disk at ./data/roundtable.db but is NOT suitable for production.
// For production, set DATABASE_URL to point at PostgreSQL.

const path = require('path');
const fs = require('fs');

class SQLiteAdapter {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    const Database = require('better-sqlite3');

    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);

    // Performance pragmas for dev use
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this._runMigrations();
    console.log('[DB] SQLite adapter initialized (dev mode)');
    console.log(`[DB] Database file: ${path.resolve(this.dbPath)}`);
  }

  async close() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ─── Internal helpers ───────────────────────────

  _queryOne(sql, params = []) {
    return this.db.prepare(sql).get(...params) || null;
  }

  _queryAll(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  _run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  _runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        ai_provider TEXT DEFAULT 'vertexai',
        ai_model TEXT DEFAULT 'gemini-2.5-flash',
        system_prompt TEXT DEFAULT '',
        tools_enabled INTEGER DEFAULT 1,
        enabled_tools TEXT DEFAULT NULL,
        data_sources TEXT DEFAULT NULL,
        ollama_host TEXT DEFAULT NULL,
        repos TEXT DEFAULT '[]',
        status TEXT DEFAULT 'active',
        created_by INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        source_workspace_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

      CREATE TABLE IF NOT EXISTS workspace_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        tool_names TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_usage_workspace ON workspace_usage(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_workspace_user ON workspace_usage(workspace_id, user_id);
    `);
    console.log('[DB] Migrations complete');
  }

  // ─── Users ──────────────────────────────────────

  async createUser(username, displayName, passwordHash) {
    const result = this._run(
      'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)',
      [username, displayName, passwordHash]
    );
    return this._queryOne('SELECT id, username, display_name, created_at FROM users WHERE id = ?', [result.lastInsertRowid]);
  }

  async getUserById(id) {
    return this._queryOne('SELECT id, username, display_name, created_at FROM users WHERE id = ?', [id]);
  }

  async getUserByUsername(username) {
    return this._queryOne('SELECT * FROM users WHERE username = ?', [username]);
  }

  // ─── Workspaces ─────────────────────────────────

  async registerWorkspace(id, name, url, createdBy) {
    this._run(`
      INSERT INTO workspaces (id, name, url, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        url = excluded.url,
        status = 'active',
        last_active = CURRENT_TIMESTAMP
    `, [id, name, url, createdBy]);
    return this.getWorkspace(id);
  }

  async getWorkspace(id) {
    const row = this._queryOne('SELECT * FROM workspaces WHERE id = ?', [id]);
    if (row) row.tools_enabled = !!row.tools_enabled; // SQLite stores booleans as 0/1
    return row;
  }

  async getAllWorkspaces() {
    return this._queryAll('SELECT * FROM workspaces ORDER BY last_active DESC');
  }

  async getActiveWorkspaces() {
    return this._queryAll("SELECT * FROM workspaces WHERE status = 'active' ORDER BY last_active DESC");
  }

  async updateWorkspaceHeartbeat(id) {
    this._run('UPDATE workspaces SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }

  async updateWorkspaceStatus(id, status) {
    this._run('UPDATE workspaces SET status = ? WHERE id = ?', [status, id]);
  }

  async updateWorkspace(id, fields) {
    const updates = []; const values = [];
    if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
    if (fields.aiProvider !== undefined) { updates.push('ai_provider = ?'); values.push(fields.aiProvider); }
    if (fields.aiModel !== undefined) { updates.push('ai_model = ?'); values.push(fields.aiModel); }
    if (fields.systemPrompt !== undefined) { updates.push('system_prompt = ?'); values.push(fields.systemPrompt); }
    if (fields.toolsEnabled !== undefined) { updates.push('tools_enabled = ?'); values.push(fields.toolsEnabled ? 1 : 0); }
    if (fields.enabledTools !== undefined) {
      updates.push('enabled_tools = ?');
      values.push(fields.enabledTools === null ? null : JSON.stringify(fields.enabledTools));
    }
    if (fields.repos !== undefined) { updates.push('repos = ?'); values.push(JSON.stringify(fields.repos)); }
    if (fields.dataSources !== undefined) {
      updates.push('data_sources = ?');
      values.push(fields.dataSources === null ? null : JSON.stringify(fields.dataSources));
    }
    if (fields.ollamaHost !== undefined) {
      updates.push('ollama_host = ?');
      values.push(fields.ollamaHost || null);
    }
    if (updates.length === 0) return this.getWorkspace(id);
    values.push(id);
    this._run(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`, values);
    return this.getWorkspace(id);
  }

  // ─── Messages ───────────────────────────────────

  async saveMessage(workspaceId, userId, role, content, toolName = null, toolCallId = null, sourceWorkspaceId = null) {
    const result = this._run(
      'INSERT INTO messages (workspace_id, user_id, role, content, tool_name, tool_call_id, source_workspace_id) VALUES (?,?,?,?,?,?,?)',
      [workspaceId, userId, role, content, toolName, toolCallId, sourceWorkspaceId]
    );
    return this._queryOne(`
      SELECT m.*, u.username, u.display_name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
    `, [result.lastInsertRowid]);
  }

  async getMessages(workspaceId, options = {}) {
    const limit = Math.min(options.limit || 50, 200);
    if (options.before) {
      const rows = this._queryAll(`
        SELECT m.*, u.username, u.display_name FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.id < ? ORDER BY m.created_at DESC LIMIT ?
      `, [workspaceId, options.before, limit]);
      return rows.reverse();
    }
    const rows = this._queryAll(`
      SELECT m.*, u.username, u.display_name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY m.created_at DESC LIMIT ?
    `, [workspaceId, limit]);
    return rows.reverse();
  }

  async getConversationHistory(workspaceId, limit = 50) {
    return this.getMessages(workspaceId, { limit });
  }

  // ─── API Keys ───────────────────────────────────

  async saveApiKey(userId, provider, apiKey) {
    this._run('DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?', [userId, provider]);
    this._run('INSERT INTO user_api_keys (user_id, provider, api_key) VALUES (?,?,?)', [userId, provider, apiKey]);
  }

  async getApiKey(userId, provider) {
    const row = this._queryOne('SELECT api_key FROM user_api_keys WHERE user_id = ? AND provider = ?', [userId, provider]);
    return row ? row.api_key : null;
  }

  async getApiKeys(userId) {
    return this._queryAll(
      "SELECT id, provider, SUBSTR(api_key, 1, 8) || '...' as key_preview, created_at FROM user_api_keys WHERE user_id = ?",
      [userId]
    );
  }

  async deleteApiKey(id, userId) {
    this._run('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  }

  // ─── Usage Tracking ─────────────────────────────
  async recordUsage(workspaceId, userId, provider, model, promptTokens, completionTokens, totalTokens, toolCalls, toolNames) {
    this._run(
      `INSERT INTO workspace_usage (workspace_id, user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, tool_calls, tool_names)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      WHERE workspace_id = ?
        AND created_at >= datetime('now', '-' || ? || ' days')
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
      WHERE wu.workspace_id = ?
        AND wu.created_at >= datetime('now', '-' || ? || ' days')
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
      WHERE workspace_id = ?
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY provider, model
      ORDER BY total_tokens DESC
    `, [workspaceId, periodDays]);
  }
}

module.exports = SQLiteAdapter;
