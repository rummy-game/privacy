-- Ratenbegrenzung: Zähler je Fenster; der Schlüssel ist ein Prüfwert aus Adresse und Tag, nie die Adresse selbst
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
