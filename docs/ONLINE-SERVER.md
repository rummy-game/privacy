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

## Stand der Einrichtung (25.10.2026)

- Cloudflare-Konto Fsnavivfr@gmail.com, D1-Datenbank `rummy` (Region WEUR, ID in `wrangler.toml`), alle drei Migrationen eingespielt, Pages-Projekt `rummy-game`, Adresse **https://rummy-game-6ke.pages.dev** (Produktions-Zweig `main`, Direkt-Upload mit `wrangler pages deploy dist --project-name rummy-game --branch main`).
- Secret `MAINTENANCE_TOKEN` im Pages-Projekt und als GitHub-Secret (`ONLINE_URL`, `MAINTENANCE_TOKEN`) für `.github/workflows/maintenance.yml`.
- **Offen:** `BREVO_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` (ohne sie meldet `/api/auth/start` „mail"): `wrangler pages secret put BREVO_API_KEY --project-name rummy-game`, Variablen im Dashboard unter Einstellungen → Variablen und Secrets.
- **Interner Test ohne Mailversand:** Secrets `TEST_EMAILS` (Komma-Liste, derzeit `test1@`, `test2@`, `test3@rummy-test.invalid`) und `TEST_CODE` (sechsstellig) im Pages-Projekt: Für diese Adressen gilt der feste Code, es wird nichts verschickt. **Vor dem öffentlichen Start beide Secrets löschen** (`wrangler pages secret delete TEST_CODE --project-name rummy-game`, ebenso `TEST_EMAILS`).
- `wrangler` meldet sich per OAuth an (`npx.cmd wrangler login` im Terminal, vorher `CLOUDFLARE_API_TOKEN` leeren: das Token in der Umgebung gehört zu den anderen Seiten und hat keine D1-Rechte).

## Anmeldung per E-Mail (Branch `feature/email-registration`)

- Registrierung und Anmeldung nur per E-Mail-Code: `POST /api/auth/start` (Adresse, Zweck `login` oder `delete`, Sprache) und `POST /api/auth/verify` (Adresse, sechsstelliger Code). Beim ersten Mal entsteht das Konto zur Adresse, jedes Gerät bekommt einen eigenen Schlüssel (`account_secrets`). Anonyme Konten gibt es nicht mehr (`POST /api/account` antwortet 410). Löschen: in der App oder über einen Code mit Zweck `delete`.
- Grenzen: 30 s Pause zwischen zwei Codes, höchstens 5 Codes je Adresse und Stunde, 5 Fehlversuche je Code, Code gilt 15 Minuten, höchstens 250 Mails pro Tag (Brevo kostenlos: 300).
- Versand über **Brevo** (transaktionale E-Mail, HTTP-Schnittstelle): in Cloudflare die Secrets `BREVO_API_KEY` und die Variablen `MAIL_FROM` (in Brevo bestätigte Absenderadresse) und `MAIL_FROM_NAME` setzen. Ohne diese Angaben meldet der Dienst „mail“ und niemand kann sich anmelden. Auftragsverarbeitung mit Brevo (DPA) im Brevo-Konto bestätigen. Hinweis: Eine Gmail-Adresse als Absender liefert schlecht zu; besser eine eigene Domain mit SPF/DKIM bei Brevo einrichten.
- Migration `0003_email_auth.sql` zusätzlich einspielen (`wrangler d1 migrations apply rummy --remote`).

## Vor dem Einschalten in der App

Datenschutz, Nutzungsbedingungen, Konto-Löschseite und Impressum stehen schon in dieser Fassung (Branch `online-server`). **Erst zusammen mit der App-Fassung veröffentlichen, die den Online-Modus einschaltet**, sonst beschreibt die Seite etwas, das es im Store noch nicht gibt. Außerdem in der Play Console: Data Safety, Altersfreigabe (IARC) mit Nutzerinteraktion und die Adresse der Konto-Löschseite eintragen.

Offen: automatische Löschung inaktiver Konten (steht deshalb nicht in der Datenschutzerklärung), Melden/Blockieren, Push.

## Sicherheit (27.10.2026)
- **Ratenbegrenzung im Code** (Migration `0006_rate_limits.sql`, vor dem Deploy einspielen!): Code-Anfragen höchstens 5 pro Minute und 15 pro Tag je Absenderadresse, Code-Prüfung 10 pro Minute, Beitritt per Code und Namensänderung je 10 pro Minute und Konto; Antwort `429 error ratelimit`. Gespeichert wird nur ein Prüfwert aus Adresse und Tag (nie die Adresse), die Zähler löscht die tägliche Wartung. Gegen allgemeine Überflutung bleibt die WAF-Regel von Cloudflare nötig (Schritt 4 oben).
- **Test-Zugang läuft ab:** `TEST_LOGIN_UNTIL` (31.12.2026, in `service.ts`). Danach gilt der feste Code auch bei gesetzten Secrets nicht mehr, und die Wartung löscht Konten mit Adressen auf `@rummy-test.invalid`. Die Secrets trotzdem vor dem öffentlichen Start löschen.
- **Nur die eigene Adresse bedient die API:** `rummy-game-6ke.pages.dev` und `localhost`; alte Deployment-Adressen (`<hash>.rummy-game-6ke.pages.dev`) und Vorschauen antworten `404`, sobald sie den neuen Code enthalten. Eine eigene Domain per Variable `ALLOWED_HOSTS` (Komma-getrennt) freigeben. Alte Deployments, die noch den alten Code ausliefern, im Pages-Projekt unter „Deployments“ löschen.

## Aufgabe, Frist, Bilanz (26.10.2026)
- **Aufgeben zu zweit** (auch Konto löschen): Die Partie endet als aufgegeben (Ereignis `resigned`), der andere Platz gewinnt, der Computer übernimmt nicht. Bei mehr als zwei Plätzen übernimmt wie bisher ein Computer (sofort bei Aufgabe, nach drei verpassten Fristen).
- **Abgelaufene Frist:** Es wird nur für den Platz gezogen bzw. ausgesetzt. Frist `0` heißt unbegrenzt (nie automatisch ziehen).
- **Aufräumen:** Laufende Partien ohne Zugfrist werden nach 30 Tagen ohne Änderung gelöscht (Spalte `touched_at`, Migration `0008_touched.sql`).
- **Bilanz:** Am Partieende zählt der Dienst Siege, Niederlagen und Remis je Paar von Menschen (Tabelle `records`, Migration `0007_records.sql`, `GET /api/records`).
- **Fristpause (Regel je Partie, Standard: ruht):** Die App meldet beim Verlassen und Zurückkehren (App im Hintergrund, aber auch Zurück zur Liste oder ins Menü und Öffnen einer anderen Partie) `POST games/<id>/presence` (`away 1|0`). Verlässt der Spieler am Zug die App, ruht die Frist (`pausedAt`), bei Rückkehr verschiebt sich das Fristende; kommt der Zug an einen abwesenden Spieler, beginnt die Frist erst mit seiner Rückkehr. Fehlt die Meldung, läuft die Frist weiter. Neues Feld im Befehl `newgame` (neuntes Feld) und in der Sicht (`limit … <Regel> <pausedAt>`). Der Kotlin-Referenzserver kennt die Fristpause nicht.
- **Einspielen:** erst die Migrationen `0007` und `0008` (`npx wrangler d1 migrations apply rummy --remote`), dann deployen.

## Checkliste vor dem öffentlichen Online-Start

- Secrets `TEST_EMAILS` und `TEST_CODE` löschen, Test-Konten entfernen.
- WAF-Regel für `/api/*` anlegen (Schritt 4 oben).
- **Startseite anpassen** (`src/views/Home.astro`, deutsch und englisch: `description` und `privH`/`priv`): Die Aussage „ohne Konto und ohne Netzwerk“ gilt nur für die Spielarten auf dem Gerät. Neu etwa: „Auf dem Gerät ohne Konto und ohne Netzwerk; der Online-Modus ist freiwillig und braucht eine E-Mail-Adresse.“ Erst zusammen mit der App-Fassung veröffentlichen, die den Online-Modus einschaltet; die Berechtigungsaussage („keine Berechtigungen, die du erteilen musst, keine Internetverbindung“) muss ebenfalls angepasst werden.
- Brevo-Absender prüfen (Zustellung an Gmail), ungenutzte Brevo-Schlüssel und zusätzliche Firebase-Dienstkonto-Schlüssel widerrufen.
- Play Console: IARC (Nutzerinteraktion, Anzeigenamen, Melden/Blockieren), Data Safety (Entwurf gespeichert 27.10.2026), Store-Screenshots (Querformat, neue Farben), App-Zugriff-Hinweis.
