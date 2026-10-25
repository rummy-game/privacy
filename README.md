# rummy-web

Webseite zur Android-App Rummy (`rp.rummy`): Startseite, Spielregeln, Impressum und Datenschutz, je Deutsch und Englisch. Astro, rein statisch, keine Cookies, keine Fremd-Schriften oder -Skripte.

| Deutsch | Englisch |
|---|---|
| `/` | `/en/` |
| `/spielregeln/` | `/en/rules/` |
| `/impressum/` | `/en/legal-notice/` |
| `/datenschutz/` | `/en/privacy/` |

## Entwicklung

    npm install
    npm run dev      # http://localhost:4321
    npm run build    # nach dist/

## Regeltexte

Die Regeln kommen aus der App, damit beide dasselbe sagen. `src/data/rules.json` wird erzeugt aus den `rules_*`-Strings (Deutsch `values/`, Englisch `values-en/`):

    python tools/extract_rules.py ../rummy/app/src/main/res

Immer neu erzeugen, wenn sich der Regeltext in der App ändert. Die Platzhalter sind mit den Standardwerten gefüllt (14 Startplättchen, 30 Punkte).

## Rechtliches (verbindlich)

- "Rummikub" ist geschützt und darf nirgends vorkommen, auch nicht vergleichend.
- Keine Funktion beschreiben, die die App nicht hat. Die Datenschutzerklärung beschreibt den heutigen Stand: Offline-App ohne Konto, ohne Internet-Berechtigung. **Kommt Online-Mehrspieler oder ein Kauf, muss `Privacy.astro` vorher angepasst werden** (Konto-ID, Anzeigename, Server, Löschung), ebenso Data Safety in der Play Console. Für Play braucht es dann eine Seite zur Konto-Löschung.
- Impressum und Datenschutz enthalten die echte Anschrift (wie bei den anderen Apps).

## Offen vor der Veröffentlichung

- Hosting und Domain festlegen (bei den anderen Apps: `<app>-app`-Organisation mit GitHub Pages bzw. Cloudflare Pages). Danach in `Privacy.astro` Abschnitt 5 den Hosting-Anbieter nennen.
- Die Texte sind Entwürfe nach dem Muster der Geschwister-Apps und nicht anwaltlich geprüft.
- In der App muss ein Link „Impressum" (deutsche Beschriftung) auf `/impressum/` zeigen; der Datenschutz-Link auf `/datenschutz/`.
