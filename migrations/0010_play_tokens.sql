-- Gekaufte Play-Abos: jeder Kauf-Token (als Prüfwert) gehört genau einem Konto
CREATE TABLE IF NOT EXISTS play_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL
);
