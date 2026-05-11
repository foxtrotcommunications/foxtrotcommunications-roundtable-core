// server/db/helpers.js — SQL.js query helpers (compatible API with better-sqlite3 patterns)
const { getDb, saveDb } = require('./connection');

/**
 * Run a query and return the first matching row as an object, or undefined.
 */
function queryOne(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = undefined;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

/**
 * Run a query and return all matching rows as an array of objects.
 */
function queryAll(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Execute an INSERT/UPDATE/DELETE and return { lastInsertRowid, changes }.
 */
function execute(sql, ...params) {
  const db = getDb();
  db.run(sql, params);
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  const changesRow = queryOne('SELECT changes() as cnt');
  saveDb(); // persist after writes
  return {
    lastInsertRowid: lastId ? lastId.id : 0,
    changes: changesRow ? changesRow.cnt : 0,
  };
}

/**
 * Execute raw SQL (for DDL, multi-statement migrations, etc.)
 */
function execRaw(sql) {
  const db = getDb();
  db.exec(sql);
  saveDb();
}

module.exports = { queryOne, queryAll, execute, execRaw };
