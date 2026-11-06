# 🚒 Dienstplan – Handy-App

Kleine Web-App (PWA), um den Dienstplan der Feuerwehr vom Handy aus zu pflegen:
Termine anlegen, bearbeiten, absagen, verschieben und löschen.

Die App zeigt nur an und schickt Änderungen weiter. Daten und Logik liegen im
Google Sheet und im zugehörigen Apps Script (Sheet → Google Kalender).

```
Handy (diese App, GitHub Pages)  →  Apps Script (Schnittstelle)  →  Google Sheet + Kalender
```

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `app.css`, `app.js` | die App |
| `config.js` | Link zur Apps-Script-Schnittstelle (`…/exec`) |
| `manifest.webmanifest`, `*.png` | Name und Icon für den Startbildschirm |
| `sw.js` | hält die App-Dateien vor (schneller Start, öffnet auch offline) |
| `apps-script/` | Kopie der Apps-Script-Dateien (`Dienstplan-Sync.gs`, `WebApp.gs`). Sie laufen im Apps-Script-Projekt am Sheet, nicht hier |
| `docs/` | Spezifikationen (V1, V2) und Design-Entwürfe |

## Zugang

Jede Person braucht einen eigenen **Zugangscode**. Erstellt und gesperrt werden
die Codes im Google Sheet über das Menü **🚒 Feuerwehr Kalender-Sync → 🔑 Zugangscode erstellen…**.
Die Codes stehen weder in diesem Repository noch im Sheet, sondern in den
Script-Eigenschaften des Apps-Script-Projekts.

In diesem Repository stehen keine Termine, Passwörter oder Codes.

## Änderungen an der App

Nach Änderungen an `index.html`, `app.css`, `app.js` oder `config.js` in `sw.js`
die Versionsnummer (`dienstplan-v1` → `dienstplan-v2`) erhöhen, damit die
Handys die neue Version laden.
