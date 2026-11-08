const Database = require('better-sqlite3');
const { readFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');
const { runMigrations } = require('./schema-migrations');

let db = null;

/**
 * Resolve the database file location.
 * QUANDARY_DB_PATH lets tests use ':memory:' and lets deployments keep data outside the repo.
 */
function resolveDbPath() {
  const fromEnv = process.env.QUANDARY_DB_PATH;
  if (fromEnv) return fromEnv;
  return join(__dirname, 'quandary.db');
}

/**
 * Initialize the database connection and schema
 * @returns {Database} The database instance
 */
function initializeDatabase() {
  if (db) {
    return db;
  }

  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') {
    try { mkdirSync(dirname(dbPath), { recursive: true }); } catch (_) { /* exists */ }
  }

  db = new Database(dbPath);

  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    // WAL lets readers (player/GM polling) proceed while writes happen
    try { db.pragma('journal_mode = WAL'); } catch (_) { /* not fatal */ }
  }
  db.pragma('synchronous = NORMAL');

  const schema = readFileSync(join(__dirname, 'init.sql'), 'utf-8');
  db.exec(schema);

  runMigrations(db);

  return db;
}

/**
 * Get the database instance, initializing if necessary
 * @returns {Database} The database instance
 */
function getDatabase() {
  if (!db) {
    return initializeDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initializeDatabase,
  getDatabase,
  closeDatabase
};
