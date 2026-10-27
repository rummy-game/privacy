-- Online-Mehrspieler: Konten und Partien (Cloudflare D1)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS games_code ON games (code);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (game_id, account_id)
);
CREATE INDEX IF NOT EXISTS game_players_account ON game_players (account_id);
