'use strict';
// قاعدة البيانات: SQLite المدمجة في Node.js (ملف واحد، من غير أي سيرفر منفصل)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'merkel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS distributors (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  area          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batches (
  id             INTEGER PRIMARY KEY,
  distributor_id INTEGER NOT NULL REFERENCES distributors(id),
  count          INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id             INTEGER PRIMARY KEY,
  phone          TEXT NOT NULL,
  distributor_id INTEGER NOT NULL REFERENCES distributors(id),
  status         TEXT NOT NULL DEFAULT 'pending_distributor',
  created_at     TEXT NOT NULL,
  dist_at        TEXT,
  dist_note      TEXT,
  admin_at       TEXT,
  admin_note     TEXT,
  rejected_by    TEXT,
  delivered_at   TEXT
);
CREATE TABLE IF NOT EXISTS codes (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  distributor_id INTEGER NOT NULL REFERENCES distributors(id),
  batch_id       INTEGER REFERENCES batches(id),
  status         TEXT NOT NULL DEFAULT 'new',   -- new | claimed | in_request
  phone          TEXT,
  entered_by     TEXT,                          -- craftsman | distributor
  claimed_at     TEXT,
  request_id     INTEGER REFERENCES requests(id)
);
CREATE TABLE IF NOT EXISTS craftsmen (
  phone      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY,
  phone         TEXT NOT NULL,
  request_id    INTEGER REFERENCES requests(id),
  file          TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT,
  size          INTEGER,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  csrf       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_phone  ON codes(phone, status);
CREATE INDEX IF NOT EXISTS idx_codes_dist   ON codes(distributor_id, status);
CREATE INDEX IF NOT EXISTS idx_codes_batch  ON codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_req_dist     ON requests(distributor_id, status);
CREATE INDEX IF NOT EXISTS idx_req_phone    ON requests(phone);
CREATE INDEX IF NOT EXISTS idx_inv_req      ON invoices(request_id);
CREATE INDEX IF NOT EXISTS idx_inv_phone    ON invoices(phone);
`);

const DEFAULT_SETTINGS = {
  coupon_value: '6000',
  per_prize: '5',
  prize_name: 'شنيور',
  campaign_end: '',
  site_url: ''
};
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  out.coupon_value_n = Math.max(1, parseInt(out.coupon_value, 10) || 6000);
  out.per_prize_n = Math.min(50, Math.max(1, parseInt(out.per_prize, 10) || 5));
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// تنفيذ مجموعة عمليات كوحدة واحدة (يا كلها يا ولا حاجة)
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

const now = () => new Date().toISOString();

module.exports = { db, tx, now, getSettings, setSetting, DATA_DIR, UPLOAD_DIR };
