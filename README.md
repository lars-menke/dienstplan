# 🚒 Dienstplan – Handy-App

Web-App (PWA), um den Dienstplan der Feuerwehr vom Handy aus zu pflegen und anzusehen:
Liste und Wochenansicht, Termine anlegen, bearbeiten, absagen, verschieben – mit Rollen
(Lesen · Schreiben · Admin), Kategorien und Verwaltung der Zugangscodes.

Die App zeigt an und schickt Änderungen weiter. Daten und Logik liegen im Google Sheet
und im zugehörigen Apps Script (Sheet → Google Kalender).

```
Handy (diese App, GitHub Pages)  →  Apps Script (Schnittstelle)  →  Google Sheet + Kalender
```

**App:** https://lars-menke.github.io/dienstplan/

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `app.css`, `app.js`, `icons.js` | die App |
| `config.js` | Link zur Apps-Script-Schnittstelle (`…/exec`) und Vorlagen für neue Termine |
| `manifest.webmanifest`, `*.png` | Name und Icon für den Startbildschirm |
| `sw.js` | Service Worker (schneller Start, öffnet auch offline) |
| `beta/` | nur noch Weiterleitung der früheren Testversion (kann später gelöscht werden) |
| `apps-script/` | Kopie der Apps-Script-Dateien; sie laufen im Apps-Script-Projekt am Sheet |
| `docs/PWA-Spezifikation.md` | vollständige Spezifikation (Funktionen, Design, API, Betrieb) |
| `docs/design/` | Design-Artboards (Referenz) |

## Zugang

Jede Person braucht einen **Zugangscode** mit Rolle. Admins verwalten die Codes in der App
(„Weitere Aktionen → Verwaltung → Zugangscodes“) oder im Sheet-Menü. Gespeichert wird nur
ein Fingerabdruck (Hash) in den Script-Eigenschaften.

In diesem Repository stehen keine Termine, Passwörter oder Codes.

## Änderungen

- **App:** nach Änderungen an `index.html`, `app.css`, `app.js`, `icons.js` oder `config.js`
  in `sw.js` die Cache-Version erhöhen (z. B. `dienstplan-v5` → `dienstplan-v6`).
- **Schnittstelle:** `apps-script/*.gs` ins Apps-Script-Projekt kopieren, speichern, dann
  *Bereitstellungen verwalten → bestehende Bereitstellung → Stift → Neue Version → Bereitstellen*.
  Die `/exec`-Adresse zeigt im Browser die bereitgestellte `version`.
