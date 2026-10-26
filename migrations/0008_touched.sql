-- Letzte Änderung einer Partie: Partien ohne Zugfrist werden nach langer Ruhe gelöscht
ALTER TABLE games ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0;
UPDATE games SET touched_at = created_at;
