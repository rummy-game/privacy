-- Anmeldung per E-Mail: bestätigte Adresse am Konto, Geräte-Schlüssel, Bestätigungscodes, Tageszähler für Mails
ALTER TABLE accounts ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_secrets (
  account_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, secret_hash)
);

CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (email, purpose)
);

CREATE TABLE IF NOT EXISTS mail_counter (
  day INTEGER PRIMARY KEY,
  sent INTEGER NOT NULL
);
