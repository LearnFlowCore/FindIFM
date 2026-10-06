// Инициализация SQLite и безопасное добавление колонок при обновлении версии.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function addCompatibilityMethods(db) {
  db.pragma = statement => db.exec(`PRAGMA ${statement}`);
  db.transaction = operation => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function addMissingColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name));
  for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = addCompatibilityMethods(new DatabaseSync(file));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY, job_id TEXT, url TEXT NOT NULL, url_normalized TEXT,
      domain TEXT, title TEXT, date TEXT, description TEXT, query TEXT,
      search_date TEXT, search_run_date TEXT, status TEXT, snippet_match INTEGER DEFAULT 0,
      category TEXT, text_length INTEGER DEFAULT 0, has_media INTEGER DEFAULT 0,
       evidence TEXT, semantic_score REAL, sentiment TEXT
    );
    CREATE INDEX IF NOT EXISTS results_job ON results(job_id);
    CREATE INDEX IF NOT EXISTS results_url ON results(url_normalized);
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY, job_id TEXT UNIQUE, query TEXT, query_json TEXT,
      extracted_date TEXT, period TEXT, date_from TEXT, date_to TEXT,
      whitelist TEXT, blacklist TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      results_count INTEGER DEFAULT 0, duplicates_count INTEGER DEFAULT 0, status TEXT, error TEXT,
      progress INTEGER DEFAULT 0, message TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT,
      spike_at TEXT, notified_at TEXT, response_at TEXT
    );
    CREATE TABLE IF NOT EXISTS domain_presets (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT DEFAULT 'whitelist', domains TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS task_logs (id INTEGER PRIMARY KEY, job_id TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      level TEXT, event TEXT, message TEXT, context_json TEXT);
    CREATE INDEX IF NOT EXISTS task_logs_job ON task_logs(job_id,id);
  `);
  addMissingColumns(db, 'results', {
    url_normalized: 'TEXT', description: 'TEXT', query: 'TEXT', search_date: 'TEXT',
    search_run_date: 'TEXT', snippet_match: 'INTEGER DEFAULT 0', category: 'TEXT',
     text_length: 'INTEGER DEFAULT 0', has_media: 'INTEGER DEFAULT 0', evidence: 'TEXT', semantic_score: 'REAL', sentiment: 'TEXT',
  });
  addMissingColumns(db, 'search_history', {
    query: 'TEXT', extracted_date: 'TEXT', period: 'TEXT', date_from: 'TEXT', date_to: 'TEXT',
    whitelist: 'TEXT', blacklist: 'TEXT', timestamp: 'TEXT', results_count: 'INTEGER DEFAULT 0',
    duplicates_count: 'INTEGER DEFAULT 0', error: 'TEXT', progress: 'INTEGER DEFAULT 0',
    message: 'TEXT', started_at: 'TEXT', finished_at: 'TEXT', updated_at: 'TEXT',
    spike_at: 'TEXT', notified_at: 'TEXT', response_at: 'TEXT',
  });
  addMissingColumns(db, 'domain_presets', { type: "TEXT DEFAULT 'whitelist'", domains: "TEXT DEFAULT '[]'" });
  return db;
}
module.exports = { openDatabase };
