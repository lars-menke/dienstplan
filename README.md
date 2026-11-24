# 🚒 Dienstplan AchtzehnZwo – Handy-App

Web-App (PWA) der Feuerwehr für den **Dienstplan** und die **Fahrzeugbuchung** – auf dem Handy,
Tablet und Laptop. Master sind zwei **Google Kalender**; die App liest und schreibt sie über ein
Apps Script. Das Google Sheet dient nur noch als Backup.

```
App (GitHub Pages)  →  Apps Script (Schnittstelle)  →  Google Kalender (Dienstplan, Fahrzeuge 18-2)
                                                    →  Google Sheet (Backup, Zugangscodes-Menü)
```

**App:** https://lars-menke.github.io/dienstplan/

## Funktionen

**Dienstplan**
- Liste, Wochenansicht und Tabelle (Tabelle für Schreiben/Admin ab Tablet-Breite)
- Termine anlegen, bearbeiten, absagen, verschieben (auch per Wischen), Serien mit freien Regeln
  (z. B. „1. Samstag im Monat“), Kategorien mit Farben
- Entwürfe in einem privaten Kalender – für die Mannschaft erst nach „Freigeben“ sichtbar
- Import aus Excel/CSV/ICS, Export als Excel/CSV (Admin)

**Fahrzeuge**
- Belegung als Liste oder Belegungsplan (Fahrzeuge × Wochentage), Filter je Fahrzeug
- Anfragen mit Prüfung auf Doppelbuchung (Doppelbuchungen sind nie möglich), Bestätigen/Ablehnen durch Admins
- Einträge, die direkt in Google stehen, werden über den Titel erkannt und lassen sich vereinheitlichen

**Für alle**
- „Neu“/„Geändert“ seit dem letzten Besuch: Zähler an den Reitern, Markierung an den Karten,
  Zahl am App-Symbol (wo unterstützt)
- Hell/Dunkel, öffnet auch offline (letzter Stand)

## Rollen und Zugang

Jede Person meldet sich mit einem **Zugangscode** an (Link zum Teilen). Gespeichert wird nur ein
Fingerabdruck (Hash) in den Script-Eigenschaften.

| Rolle | darf |
|---|---|
| Lesen (auch der gemeinsame Mannschafts-Code) | Dienstplan und Fahrzeugbelegung ansehen |
| Schreiben | zusätzlich Termine anlegen, ändern, absagen, verschieben |
| Admin | zusätzlich löschen, Entwürfe freigeben, Import/Export, Kategorien, Zugangscodes, Fahrzeuge bestätigen |
| + „Fahrzeuge buchen“ (Häkchen je Code) | Fahrzeuge anfragen, eigene Anfragen ändern/zurückziehen |

Admins verwalten die Codes in der App unter „Weitere Aktionen → Verwaltung → Zugangscodes“.

In diesem Repository stehen keine Termine, Passwörter, Codes oder Zugangsdaten. Die IDs des
Entwurfs- und des Fahrzeugkalenders liegen nur in den Script-Eigenschaften.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `app.css`, `app.js`, `icons.js` | die App (Dienstplan, Fahrzeuge, Verwaltung) |
| `table.js`, `import.js` | Tabellenansicht; Import/Export |
| `config.js` | Link zur Schnittstelle (`…/exec`) und Vorlagen für neue Termine |
| `sw.js` | Service Worker: holt immer die neueste Fassung, öffnet ohne Netz aus dem Speicher |
| `manifest.webmanifest`, `*.png`, `fonts/` | Startbildschirm-Icon, Schriften (mit Lizenzen) |
| `vendor/` | SheetJS für den Excel-Import (feste Version, Lizenz dabei; wird erst beim Import geladen) |
| `beta/` | nur noch Weiterleitung der früheren Testversion |
| `apps-script/WebApp.gs` | Schnittstelle, Rollen, Zugangscodes |
| `apps-script/Kalender.gs` | Dienstplan im Google Kalender, Entwürfe, Backup ins Sheet |
| `apps-script/Fahrzeuge.gs` | Fahrzeugbuchung im Kalender „Fahrzeuge 18-2“ |
| `apps-script/Dienstplan-Sync.gs` | Konfiguration, Sheet-Menü, Hilfsfunktionen |
| `apps-script/appsscript.json` | Manifest (Zeitzone, Calendar API v3, Web-App) |
| `.github/workflows/apps-script.yml` | stellt das Backend automatisch bereit |
| `docs/PWA-Spezifikation.md` | Hauptspezifikation (Funktionen, Design, API, Betrieb, Historie) |
| `docs/Fahrzeugbuchung-Spezifikation.md` | Fahrzeugbuchung (V4) |
| `docs/PWA-Spezifikation-V3.md` | Herleitung „Kalender als Master“, Notfall-Rückweg |
| `docs/beispiele/`, `docs/design/` | Beispiel-Importdatei, Design-Artboards |

## Änderungen und Bereitstellung

- **App:** Änderungen nach `main` → GitHub Pages veröffentlicht nach 1–2 Minuten. Bei Änderungen an
  App-Dateien die Cache-Version in `sw.js` erhöhen (`dienstplan-vNN`). Auf dem Handy reicht danach
  ein Neustart der App.
- **Backend:** Jeder Push nach `main` mit Änderungen unter `apps-script/` startet die GitHub Action:
  `clasp push` und `clasp deploy` auf die bestehende Bereitstellung (die `/exec`-Adresse bleibt).
  Zum Testen eines Branches: *Actions → Apps Script bereitstellen → Run workflow → Branch wählen*.
  Kontrolle: die `/exec`-Adresse zeigt im Browser die bereitgestellte `version`.
- **Im Apps-Script-Editor nichts direkt ändern** – der nächste Lauf überschreibt es. Neue
  Google-Berechtigungen einmal bestätigen, indem man im Editor eine Funktion ausführt
  (z. B. `backupToSheet`).
- Secrets der Action (GitHub → Settings → Secrets → Actions): `CLASPRC_JSON`, `SCRIPT_ID`.
