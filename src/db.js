import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      description TEXT,
      owner TEXT,
      version_policy TEXT NOT NULL DEFAULT 'additive_compatible',
      policy_json TEXT NOT NULL,
      current_contract_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      status TEXT NOT NULL,
      compatibility TEXT NOT NULL DEFAULT 'baseline',
      changelog TEXT,
      proposal_json TEXT,
      based_on INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      approved_note TEXT,
      UNIQUE(source_id, version)
    );

    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      contract_version TEXT NOT NULL,
      variant TEXT NOT NULL,
      label TEXT,
      mode TEXT NOT NULL DEFAULT 'live',
      origin TEXT NOT NULL DEFAULT 'manual',
      decision TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      normalization_json TEXT,
      meta_json TEXT,
      record_count INTEGER NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      row_index INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'quarantined',
      status TEXT NOT NULL DEFAULT 'pending',
      replay_result_json TEXT,
      replayed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quarantine_id INTEGER NOT NULL REFERENCES quarantine(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL,
      contract_id INTEGER NOT NULL,
      decision TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      field_path TEXT NOT NULL,
      signature TEXT NOT NULL,
      observed_json TEXT,
      record_json TEXT,
      meta_json TEXT,
      note TEXT,
      scope TEXT NOT NULL DEFAULT 'entity',
      max_rows INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batches_source ON batches(source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_quarantine_source ON quarantine(source_id, status);
    CREATE INDEX IF NOT EXISTS idx_exceptions_source ON exceptions(source_id, active);
  `);
  return db;
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

export function get(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function nowIso() {
  return new Date().toISOString();
}
