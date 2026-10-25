# Online-Dienst auf Cloudflare (Pages Functions + D1)

Der Online-Mehrspieler der App läuft in diesem Repo als **Cloudflare Pages Functions** unter `/api/*` mit einer **D1-Datenbank**. Die Webseite (Astro) und der Dienst werden zusammen von Cloudflare Pages ausgeliefert. Die Spielregeln sind eine TypeScript-Fassung des Kotlin-Moduls `core` (`functions/_lib/rules.ts`, `ai.ts`); `test/golden.json` enthält Referenzfälle aus Kotlin (`core/src/test/.../GoldenExportTest.kt` im App-Repo), `npm test` prüft, dass beide Fassungen gleich entscheiden.

## Aufbau

- `functions/api/[[path]].ts`: Einstieg, bindet D1 (`DB`) und das Geheimnis `MAINTENANCE_TOKEN`.
- `functions/_lib/`: `service.ts` (Konten, Partien, Fristen), `store.ts` (Speicher: D1 und Arbeitsspeicher für Tests), `codec.ts` (Textformat, Gegenstück zu `OnlineCodec.kt`), `handler.ts` (HTTP), `rules.ts`, `ai.ts`, `names.ts`.
- `migrations/0001_init.sql`: Tabellen `accounts`, `games`, `game_players`.
- Gleichzeitige Anfragen auf dieselbe Partie sind über eine Versionsnummer abgesichert (optimistische Sperre, bis zu sechs Wiederholungen).
- Zugfristen werden beim Zugriff ausgewertet (die Mitspielenden fragen alle 5 s nach, im eigenen Zug seltener), ein Zeitgeber ist nicht nötig. Aufräumen: `.github/workflows/maintenance.yml` ruft täglich `POST /api/maintenance` auf.
- Computergegner online: Anfänger und Mittel (Schwer/Experte würden den Tischumbau-Solver brauchen und laufen online wie Mittel; die App bietet sie online nicht an).

## Einrichten (einmalig, mit Cloudflare-Konto)

```bash
npm install
npx wrangler login
npx wrangler d1 create rummy --location weur      # Standortwunsch Westeuropa; ID in wrangler.toml eintragen
npx wrangler d1 migrations apply rummy --remote
```

1. In Cloudflare → Workers & Pages → Pages → Projekt aus dem GitHub-Repo `rummy-game/privacy` anlegen. Build-Befehl `npm run build`, Ausgabeordner `dist`. Produktions-Zweig `main`.
2. Im Projekt unter Einstellungen → Bindungen: D1-Datenbank `rummy` als `DB`. Secret `MAINTENANCE_TOKEN` setzen (zufälliger langer Wert).
3. Repo-Secrets in GitHub: `ONLINE_URL` (Adresse des Pages-Projekts) und `MAINTENANCE_TOKEN` (derselbe Wert).
4. Rate Limiting: in Cloudflare unter Sicherheit → WAF eine Regel für `/api/*` anlegen (z. B. 120 Anfragen pro Minute und IP); der Code selbst begrenzt nur die Größe der Anfragen.
5. Die App trägt die Adresse später fest ein (bisher Eingabefeld im Online-Bereich, nur Debug-Fassung).

**CPU-Limit:** Im kostenlosen Workers-Plan sind 10 ms CPU pro Anfrage erlaubt. Eine Anfrage mit KI-Zügen kann darüber liegen (die Suchtiefe ist deshalb auf 30 000 Knoten begrenzt). Im Plan „Workers Paid“ (ab 5 US-$ im Monat) gilt ein Vielfaches. Bei Fehlern „Exceeded CPU“ im Protokoll diesen Plan wählen.

## Lokal testen

```bash
npm test                                    # Regeln gegen Kotlin, Dienst, KI, HTTP
npx wrangler d1 migrations apply rummy --local
npm run build && npx wrangler pages dev dist --port 8788   # echter Dienst mit lokaler D1
```

## Vor dem Einschalten in der App

Datenschutz, Nutzungsbedingungen, Konto-Löschseite und Impressum stehen schon in dieser Fassung (Branch `online-server`). **Erst zusammen mit der App-Fassung veröffentlichen, die den Online-Modus einschaltet**, sonst beschreibt die Seite etwas, das es im Store noch nicht gibt. Außerdem in der Play Console: Data Safety, Altersfreigabe (IARC) mit Nutzerinteraktion und die Adresse der Konto-Löschseite eintragen.

Offen: automatische Löschung inaktiver Konten (steht deshalb nicht in der Datenschutzerklärung), Melden/Blockieren, Push.
