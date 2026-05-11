// server/db/connection.js — SQLite connection via sql.js (pure JS, no native deps)
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('../config');

let db = null;
let dbReady = null;

async function initDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Ensure data directory exists
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing DB or create new
  if (fs.existsSync(config.dbPath)) {
    const buffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

function closeDb() {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}

// Auto-save every 30 seconds
setInterval(() => {
  if (db) saveDb();
}, 30000);

// Save on exit
process.on('exit', () => closeDb());
process.on('SIGINT', () => { closeDb(); process.exit(); });
process.on('SIGTERM', () => { closeDb(); process.exit(); });

module.exports = { initDb, getDb, saveDb, closeDb };
