// server/db/adapter.js — Database adapter factory (PostgreSQL)
const config = require('../config');

let adapter = null;

async function initAdapter() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required. Set it in .env or environment variables.');
  }

  const PostgreSQLAdapter = require('./adapters/postgresql');
  adapter = new PostgreSQLAdapter(config.databaseUrl);
  await adapter.initialize();
  return adapter;
}

function getAdapter() {
  if (!adapter) throw new Error('Database adapter not initialized. Call initAdapter() first.');
  return adapter;
}

module.exports = { initAdapter, getAdapter };
