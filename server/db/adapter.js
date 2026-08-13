// server/db/adapter.js — Database adapter factory (PostgreSQL or SQLite)
const config = require('../config');

let adapter = null;

async function initAdapter() {
  if (config.databaseUrl) {
    const PostgreSQLAdapter = require('./adapters/postgresql');
    // Pooled processes pin workspace-scoped statements to the request's
    // tenant (tenant_context RLS); dedicated pods keep plain pool queries.
    adapter = new PostgreSQLAdapter(config.databaseUrl, { tenantPinned: config.pooled });
  } else {
    console.log('[DB] No DATABASE_URL set — using SQLite for local development');
    console.log('[DB] Set DATABASE_URL to use PostgreSQL (required for production)');
    const SQLiteAdapter = require('./adapters/sqlite');
    adapter = new SQLiteAdapter('./data/roundtable.db');
  }
  await adapter.initialize();
  return adapter;
}

function getAdapter() {
  if (!adapter) throw new Error('Database adapter not initialized. Call initAdapter() first.');
  return adapter;
}

function isPostgres() {
  return !!config.databaseUrl;
}

module.exports = { initAdapter, getAdapter, isPostgres };
