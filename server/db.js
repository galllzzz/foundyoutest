import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT NOT NULL,
  alias               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description         TEXT NOT NULL DEFAULT '',
  interests           TEXT NOT NULL DEFAULT '[]',
  role                TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  suspended_until     TEXT,
  status_reason       TEXT,
  email_verified_at   TEXT,
  terms_accepted_at   TEXT NOT NULL,
  terms_version       TEXT NOT NULL,
  age_confirmed_at    TEXT NOT NULL,
  share_profile       INTEGER NOT NULL DEFAULT 1,
  email_updates       INTEGER NOT NULL DEFAULT 0,
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  created_at          TEXT NOT NULL DEFAULT (${NOW}),
  last_seen_at        TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                 -- sha256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (${NOW}),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS queue (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_queue_joined ON queue(joined_at);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  user_a      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_b      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at  TEXT NOT NULL DEFAULT (${NOW}),
  ended_at    TEXT,
  ended_by    INTEGER,
  end_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_ended ON rooms(ended_at);
CREATE INDEX IF NOT EXISTS idx_rooms_a ON rooms(user_a);
CREATE INDEX IF NOT EXISTS idx_rooms_b ON rooms(user_b);
-- A person can only ever sit in one live room (the trigger below covers the a/b cross case).
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_a ON rooms(user_a) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_b ON rooms(user_b) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);

CREATE TABLE IF NOT EXISTS blocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_snapshot TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id         TEXT,
  reporter_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_alias  TEXT NOT NULL,
  reported_alias  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  details         TEXT NOT NULL DEFAULT '',
  evidence        TEXT NOT NULL DEFAULT '[]',    -- snapshot of the last messages at report time
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  resolution      TEXT,
  admin_note      TEXT,
  resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_alias     TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_user_id  INTEGER,
  target_alias    TEXT,
  details         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_log(created_at);

CREATE TABLE IF NOT EXISTS daily_activity (
  day      TEXT NOT NULL,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  message     TEXT NOT NULL,
  handled     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (${NOW})
);

-- ---------------------------------------------------------------------------
-- Rules enforced by the database itself, so they hold no matter which code path
-- (or future service) writes the data.
-- ---------------------------------------------------------------------------

-- A new live room: no self-matches, nobody already in a live room, no blocked pairs.
CREATE TRIGGER IF NOT EXISTS trg_rooms_guard BEFORE INSERT ON rooms
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'self_match') WHERE NEW.user_a = NEW.user_b;
  SELECT RAISE(ABORT, 'already_in_room') WHERE EXISTS (
    SELECT 1 FROM rooms WHERE status = 'active'
      AND (user_a IN (NEW.user_a, NEW.user_b) OR user_b IN (NEW.user_a, NEW.user_b)));
  SELECT RAISE(ABORT, 'blocked') WHERE EXISTS (
    SELECT 1 FROM blocks
     WHERE (blocker_id = NEW.user_a AND blocked_id = NEW.user_b)
        OR (blocker_id = NEW.user_b AND blocked_id = NEW.user_a));
END;

-- An ended room can never be re-opened.
CREATE TRIGGER IF NOT EXISTS trg_rooms_no_reopen BEFORE UPDATE OF status ON rooms
WHEN OLD.status = 'ended' AND NEW.status <> 'ended'
BEGIN
  SELECT RAISE(ABORT, 'room_closed');
END;

-- Messages: only members, only while the room is live.
CREATE TRIGGER IF NOT EXISTS trg_messages_guard BEFORE INSERT ON messages
BEGIN
  SELECT RAISE(ABORT, 'room_closed') WHERE NOT EXISTS (
    SELECT 1 FROM rooms WHERE id = NEW.room_id AND status = 'active');
  SELECT RAISE(ABORT, 'not_member') WHERE NOT EXISTS (
    SELECT 1 FROM rooms WHERE id = NEW.room_id AND (user_a = NEW.sender_id OR user_b = NEW.sender_id));
END;

-- Users can't queue while in a live room, nor while suspended/banned.
CREATE TRIGGER IF NOT EXISTS trg_queue_guard BEFORE INSERT ON queue
BEGIN
  SELECT RAISE(ABORT, 'already_in_room') WHERE EXISTS (
    SELECT 1 FROM rooms WHERE status = 'active' AND (user_a = NEW.user_id OR user_b = NEW.user_id));
  SELECT RAISE(ABORT, 'not_allowed') WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND status = 'active' AND email_verified_at IS NOT NULL);
END;
`);

// ---------------------------------------------------------------------------
// Platform settings (editable from the admin dashboard)
// ---------------------------------------------------------------------------
export const SETTING_DEFS = {
  registration_open:           { type: 'bool',   def: true,  label: 'Open registration', group: 'Platform' },
  maintenance_mode:            { type: 'bool',   def: false, label: 'Maintenance mode (blocks new matches for non-admins)', group: 'Platform' },
  maintenance_message:         { type: 'string', def: 'Found You is taking a short break. We will be right back.', max: 240, label: 'Maintenance message', group: 'Platform' },
  reconnect_grace_seconds:     { type: 'int',    def: 30,   min: 5, max: 300, label: 'Reconnect grace period (seconds)', group: 'Matching' },
  queue_timeout_seconds:       { type: 'int',    def: 300,  min: 0, max: 3600, label: 'Stop searching after (seconds, 0 = never)', group: 'Matching' },
  rematch_cooldown_seconds:    { type: 'int',    def: 600,  min: 0, max: 86400, label: 'Do not re-match the same two people for (seconds)', group: 'Matching' },
  msg_rate_per_10s:            { type: 'int',    def: 12,   min: 1, max: 100, label: 'Max messages per 10 seconds, per user', group: 'Rate limits' },
  find_rate_per_min:           { type: 'int',    def: 10,   min: 1, max: 60, label: 'Max searches per minute, per user', group: 'Rate limits' },
  message_max_length:          { type: 'int',    def: 1000, min: 100, max: 2000, label: 'Max message length (characters)', group: 'Rate limits' },
  message_retention_days:      { type: 'int',    def: 7,    min: 1, max: 90, label: 'Keep messages of ended chats for (days)', group: 'Retention' },
  report_retention_days:       { type: 'int',    def: 90,   min: 7, max: 365, label: 'Keep resolved reports and evidence for (days)', group: 'Retention' },
};

const cache = new Map();
function parseSetting(key, raw) {
  const d = SETTING_DEFS[key];
  if (raw === undefined || raw === null) return d.def;
  if (d.type === 'bool') return raw === '1' || raw === 'true';
  if (d.type === 'int') { const n = Number(raw); return Number.isFinite(n) ? n : d.def; }
  return String(raw);
}
export function loadSettings() {
  cache.clear();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  for (const k of Object.keys(SETTING_DEFS)) cache.set(k, parseSetting(k, raw[k]));
}
export function getSetting(key) {
  if (!cache.size) loadSettings();
  return cache.get(key);
}
export function allSettings() {
  if (!cache.size) loadSettings();
  return Object.fromEntries(cache);
}
export function validateSettings(input) {
  const clean = {};
  for (const [k, v] of Object.entries(input || {})) {
    const d = SETTING_DEFS[k];
    if (!d) continue;
    if (d.type === 'bool') clean[k] = v === true || v === 'true' || v === 1 || v === '1';
    else if (d.type === 'int') {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < d.min || n > d.max) throw new Error(`${d.label}: enter a number between ${d.min} and ${d.max}.`);
      clean[k] = n;
    } else {
      clean[k] = String(v ?? '').slice(0, d.max || 240);
    }
  }
  return clean;
}
export function saveSettings(clean) {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => {
    for (const [k, v] of Object.entries(clean)) up.run(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  })();
  loadSettings();
}

export function touchActivity(userId) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT OR IGNORE INTO daily_activity(day, user_id) VALUES (?, ?)').run(day, userId);
  db.prepare(`UPDATE users SET last_seen_at = ${NOW} WHERE id = ?`).run(userId);
}
