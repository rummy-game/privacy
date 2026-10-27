# Moderation: Blockieren, Melden, Sperren

Stand 27.10.2026. Migration `0005_moderation.sql` (Tabellen `blocks`, `reports`, `bans`).

## Für Spieler (in der App)
- **Blockieren** (in der Partnerliste oder im Spiel über ⋮ → „Mitspieler melden oder blockieren“): gilt in beide Richtungen. Der andere kann dich nicht mehr einladen und nicht in deine Spiele (und du nicht in seine); die Partnerschaft endet, offene Einladungen verschwinden. Wer beitreten will, sieht nur „kein offenes Spiel“. Unter „Online spielen“ → „Blockierte Spieler“ lässt sich das aufheben.
- **Melden**: nur mit festem Grund (Anzeigename, Verhalten, Sonstiges), kein Freitext. Gemeldet werden Konto-Kennung, Name zum Zeitpunkt der Meldung, Grund und Partie-Kennung. Höchstens 20 Meldungen je Konto und Tag; Meldungen werden nach 90 Tagen gelöscht.

## Für den Betreiber
Optional bei jeder Meldung eine Mail: Secret/Variable `REPORT_TO` im Pages-Projekt (Adresse; der Versand läuft über Brevo wie die Codes).

Die Aufrufe brauchen den Header `X-Maintenance` mit dem Wert des Secrets `MAINTENANCE_TOKEN`:

```bash
# Meldungen ansehen (JSON, neueste zuerst, `count` = Meldungen gegen dasselbe Konto)
curl -s https://rummy-game-6ke.pages.dev/api/admin/reports -H "X-Maintenance: $TOKEN"

# Konto sperren: Daten wie beim Löschen entfernen, Adresse (nur als Prüfwert) kann sich nicht neu anmelden
curl -s -X POST https://rummy-game-6ke.pages.dev/api/admin/ban -H "X-Maintenance: $TOKEN" -d $'account KONTO-ID\nreason name'

# Sperre einer Adresse aufheben
curl -s -X POST https://rummy-game-6ke.pages.dev/api/admin/unban -H "X-Maintenance: $TOKEN" -d $'email name@example.com'

# Meldung erledigt (löschen)
curl -s -X POST https://rummy-game-6ke.pages.dev/api/admin/dismiss -H "X-Maintenance: $TOKEN" -d $'report 12'
```

## Grenzen
- Eine Sperre bindet sich an die E-Mail-Adresse. Adress-Aliase (zum Beispiel `name+x@gmail.com`) oder weitere Adressen umgehen sie; ganz schließen lässt sich das nicht.
- Anzeigenamen werden nicht automatisch gefiltert (nur Form und „KI“-Präfix); Moderation läuft über Meldungen.
- Der Kotlin-Entwicklungsserver (`server/`) kennt diese Endpunkte nicht.
