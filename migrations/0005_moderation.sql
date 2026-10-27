-- Blockieren, Melden und Sperren
CREATE TABLE IF NOT EXISTS blocks (
  account_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (account_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  reported_id TEXT NOT NULL,
  reported_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  game_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_reported ON reports (reported_id);

-- Gesperrte E-Mail-Adressen nur als Prüfwert (SHA-256), damit sich niemand mit derselben Adresse neu anmeldet
CREATE TABLE IF NOT EXISTS bans (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
