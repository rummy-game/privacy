-- Gesamtstand gegen einzelne Mitspieler (Siege, Niederlagen, Remis), je Konto und Gegner
CREATE TABLE IF NOT EXISTS records (
  account_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, opponent_id)
);
