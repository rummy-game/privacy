-- Wochenkontingent für Online-Partien und Premium-Berechtigung
CREATE TABLE IF NOT EXISTS usage (
  account_id TEXT NOT NULL,
  week INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, week)
);

-- Premium gilt bis `until` (Epoch-Millisekunden); `source` ist `play` (geprüfter Kauf) oder `admin`
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  source TEXT NOT NULL
);
