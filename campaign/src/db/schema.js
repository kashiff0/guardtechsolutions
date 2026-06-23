import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../data/gts_campaign.db');

mkdirSync(join(__dirname, '../../data'), { recursive: true });

let _db;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id              TEXT PRIMARY KEY,
      first_name      TEXT NOT NULL,
      last_name       TEXT,
      email           TEXT,
      phone           TEXT,
      company         TEXT,
      title           TEXT,
      vertical        TEXT NOT NULL,
      linkedin_url    TEXT,
      linkedin_name   TEXT,
      location        TEXT,
      about           TEXT,
      source          TEXT DEFAULT 'manual',
      status          TEXT DEFAULT 'discovered',
      campaign_id     TEXT DEFAULT 'cold_outreach',
      sequence_step   INTEGER DEFAULT 0,
      score           INTEGER DEFAULT 50,
      notes           TEXT,
      enriched        INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      last_contacted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS touches (
      id              TEXT PRIMARY KEY,
      lead_id         TEXT NOT NULL REFERENCES leads(id),
      channel         TEXT NOT NULL,
      type            TEXT NOT NULL,
      sequence_step   INTEGER,
      status          TEXT DEFAULT 'sent',
      message_id      TEXT,
      subject         TEXT,
      body            TEXT,
      sent_at         TEXT DEFAULT (datetime('now')),
      opened_at       TEXT,
      replied_at      TEXT,
      error           TEXT,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS campaign_runs (
      id              TEXT PRIMARY KEY,
      started_at      TEXT DEFAULT (datetime('now')),
      completed_at    TEXT,
      leads_processed INTEGER DEFAULT 0,
      emails_sent     INTEGER DEFAULT 0,
      linkedin_sent   INTEGER DEFAULT 0,
      errors          INTEGER DEFAULT 0,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_vertical ON leads(vertical);
    CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_touches_lead ON touches(lead_id);
    CREATE INDEX IF NOT EXISTS idx_touches_status ON touches(status);
  `);
}
