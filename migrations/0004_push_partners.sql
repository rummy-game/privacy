-- Benachrichtigungen (Push) und gemerkte Spielpartner mit Einladungen ohne Code
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_account ON push_tokens (account_id);

CREATE TABLE IF NOT EXISTS partners (
  account_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (account_id, partner_id)
);

CREATE TABLE IF NOT EXISTS invites (
  game_id TEXT NOT NULL,
  to_account TEXT NOT NULL,
  from_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, to_account)
);
CREATE INDEX IF NOT EXISTS invites_to ON invites (to_account);
