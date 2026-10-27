-- Speicherbegrenzung: letzte Nutzung der Konten, Fristende der Partien (für das Aufräumen)
ALTER TABLE accounts ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET last_seen = created_at;
ALTER TABLE games ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS accounts_last_seen ON accounts (last_seen);
