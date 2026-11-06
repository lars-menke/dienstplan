# 🚒 Dienstplan-PWA – Spezifikation & Design-Grundlage

> **Zweck dieses Dokuments:** Vollständige Beschreibung der Dienstplan-App (Stand: Version 1, November 2026) als Grundlage für ein weiterführendes Design.
> Es beschreibt, **was die App heute tut**, **welche Daten und Zustände es gibt**, **wie die Oberfläche aufgebaut ist** und **welche technischen Grenzen ein neues Design einhalten muss**.

---

## Inhalt

1. [Überblick](#1-überblick)
2. [Nutzer & Nutzungssituation](#2-nutzer--nutzungssituation)
3. [Systemarchitektur](#3-systemarchitektur)
4. [Datenmodell](#4-datenmodell)
5. [Status-Logik](#5-status-logik)
6. [Screens & Abläufe](#6-screens--abläufe)
7. [Komponenten](#7-komponenten)
8. [Design-Tokens (aktuell)](#8-design-tokens-aktuell)
9. [Zustände: Laden, Leer, Fehler, Offline](#9-zustände-laden-leer-fehler-offline)
10. [Texte & Tonalität](#10-texte--tonalität)
11. [Schnittstelle (API)](#11-schnittstelle-api)
12. [PWA-Technik](#12-pwa-technik)
13. [Sicherheit & Zugang](#13-sicherheit--zugang)
14. [Barrierefreiheit](#14-barrierefreiheit)
15. [Technische Rahmenbedingungen für das Design](#15-technische-rahmenbedingungen-für-das-design)
16. [Bekannte Schwächen der Version 1](#16-bekannte-schwächen-der-version-1)
17. [Ideen & offene Fragen für das neue Design](#17-ideen--offene-fragen-für-das-neue-design)
18. [Dateien & Zuständigkeiten](#18-dateien--zuständigkeiten)

---

## 1. Überblick

Die **Dienstplan-PWA** ist eine Handy-App, mit der die Termine einer freiwilligen Feuerwehr (Übungsdienste, Besprechungen, Ausbildungen, Versammlungen …) gepflegt werden, ohne am PC vor dem Google Sheet sitzen zu müssen.

**Kernfunktionen**

| Funktion | Beschreibung |
|---|---|
| Termine ansehen | Liste aller kommenden bzw. vergangenen Termine, nach Monaten gruppiert, mit Suche |
| Termin anlegen | Titel, Datum, Uhrzeit oder ganztägig, Ort, Kategorie, Beschreibung |
| Termin bearbeiten | alle Felder änderbar |
| Termin absagen | bleibt im Kalender sichtbar, wird als abgesagt markiert |
| Termin verschieben | alter Termin bleibt markiert stehen, neuer Termin wird automatisch angelegt |
| Termin wieder aktivieren | macht Absage/Verschiebung rückgängig |
| Termin löschen | entfernt den Termin aus dem Kalender |
| Kompletter Sync | gleicht das ganze Sheet mit dem Kalender ab |

**Leitidee:** Das **Google Sheet ist der Master**. Die App ist nur eine komfortable Oberfläche; jede Änderung landet zuerst im Sheet und wird von dort sofort in den Google Kalender übertragen. Wer den Kalender abonniert hat, sieht Änderungen also direkt.

---

## 2. Nutzer & Nutzungssituation

**Nutzer**
- **Hauptnutzer:** Person, die den Dienstplan pflegt (Admin, z. B. Gruppenführer/Ausbilder).
- **Weitere Nutzer:** einzelne Führungskräfte mit eigenem Zugangscode. Alle Nutzer haben aktuell **dieselben Rechte** (es gibt keine Rollen).
- **Nicht-Nutzer:** Die Mannschaft sieht die Termine im **Google Kalender**, nicht in der App.

**Nutzungssituation**
- Fast ausschließlich **Smartphone**, oft unterwegs, einhändig, zwischendurch.
- Typische Aufgaben dauern **unter 30 Sekunden**: „Übungsdienst morgen fällt aus“ → absagen; „Besprechung eine Woche später“ → verschieben.
- Gelegentlich am PC im Browser.
- Deutschsprachig, Zeitzone Europe/Berlin.
- Nutzer sind keine IT-Profis → klare Sprache, keine Fachbegriffe, wenig Optionen pro Schritt.

**Wichtigste Design-Ziele**
1. Häufige Aktionen (absagen, verschieben) in **maximal 3 Taps**.
2. Status eines Termins **auf einen Blick** erkennbar (aktiv / abgesagt / verschoben).
3. Keine versehentlichen Löschungen → Bestätigungen für folgenreiche Aktionen.
4. Klares Feedback, weil jede Speicherung **2–6 Sekunden** dauert (siehe [15](#15-technische-rahmenbedingungen-für-das-design)).

---

## 3. Systemarchitektur

```
┌──────────────────────────┐      HTTPS POST (JSON)      ┌───────────────────────────┐
│  PWA (diese App)         │ ──────────────────────────► │  Google Apps Script       │
│  GitHub Pages            │ ◄────────────────────────── │  (Web-App „Jeder“)        │
│  lars-menke.github.io/   │      JSON-Antwort           │  WebApp.gs + Sync-Script  │
│  dienstplan/             │                             └─────────────┬─────────────┘
└──────────────────────────┘                                           │
        │ localStorage: Zugangscode,                                   │ liest/schreibt
        │ letzte Terminliste                                           ▼
        │ Service Worker: App-Dateien                   ┌───────────────────────────┐
                                                        │  Google Sheet „DataSheet“ │  ← Master
                                                        └─────────────┬─────────────┘
                                                                      │ Sync (sofort pro Zeile
                                                                      │ + alle 15 Min. komplett)
                                                                      ▼
                                                        ┌───────────────────────────┐
                                                        │  Google Kalender          │ ← Mannschaft
                                                        └───────────────────────────┘
```

| Teil | Technik | Ort |
|---|---|---|
| Oberfläche | HTML, CSS, Vanilla-JavaScript, kein Framework, kein Build-Schritt | Repository `lars-menke/dienstplan`, GitHub Pages |
| Schnittstelle | Google Apps Script (`doPost`), Ausführung als Besitzer | Apps-Script-Projekt am Sheet |
| Logik | Status, Folgetermine, Farben, Kalender-Sync | `Dienstplan-Sync.gs` im selben Projekt |
| Daten | Google Sheet, Blatt `DataSheet` (+ optional `Categories`) | Google Drive |
| Ausgabe | Google Kalender (Gruppenkalender) | Google Calendar |

---

## 4. Datenmodell

### 4.1 Termin, wie die App ihn bekommt

Jeder Termin kommt als JSON-Objekt von der Schnittstelle:

| Feld | Typ | Beispiel | Bedeutung |
|---|---|---|---|
| `row` | Zahl | `14` | Zeilennummer im Sheet (interne Referenz) |
| `eventId` | Text | `"a1b2c3…"` | ID des Kalendertermins, leer = noch nicht im Kalender |
| `subject` | Text | `"Übungsdienst: Atemschutz"` | Titel (Pflicht, max. 200 Zeichen) |
| `date` | ISO-Datum | `"2026-11-12"` | Startdatum |
| `endDate` | ISO-Datum | `"2026-11-12"` | Enddatum (= `date` bei eintägigen Terminen) |
| `allDay` | Ja/Nein | `false` | ganztägig |
| `start` | `HH:MM` | `"19:30"` | Beginn (leer bei ganztägig) |
| `end` | `HH:MM` | `"21:30"` | Ende (optional; ohne Ende = 60 Minuten) |
| `location` | Text | `"Feuerwehrhaus"` | Ort (optional) |
| `description` | Text, mehrzeilig | `"PA mitbringen"` | Beschreibung (optional) |
| `category` | Text | `"Übung"` | Kategorie (optional, steuert die Kalenderfarbe) |
| `status` | Text | `"AKTIV"` | siehe [5](#5-status-logik) |
| `recurring` | Ja/Nein | `false` | Serientermin (Wiederholung) |
| `verschobenAuf` | Text | `"19.11.2026, 19:00 Uhr"` | Ziel der Verschiebung (nur bei VERSCHOBEN) |
| `folgetermin` | Ja/Nein | `true` | neuer Termin wurde bereits angelegt |
| `synced` | Ja/Nein | `true` | Termin steht im Kalender |
| `lastChange` | Text | `"06.11.2026 18:12 · Lars"` | letzte Änderung über die App, mit Name |

Zusätzlich liefert jede Antwort:

| Feld | Bedeutung |
|---|---|
| `categories` | Liste der verfügbaren Kategorien (aus Blatt `Categories`), kann leer sein |
| `today` | heutiges Datum laut Server |
| `user` | Name zum verwendeten Zugangscode |
| `message` | Rückmeldung nach einer Änderung, z. B. „Termin abgesagt.“ |
| `warning` | `true`, wenn im Sheet gespeichert, aber der Kalender nicht aktualisiert werden konnte |

### 4.2 Typische Mengen
- **50–300 Termine** pro Jahr, die meisten mit Uhrzeit.
- Titel meist **15–40 Zeichen**, teils länger.
- Beschreibung oft leer, manchmal mehrere Zeilen.
- Kategorien: **0–10** (z. B. Übung, Ausbildung, Einsatz, Versammlung).
- Gelöschte Termine (Status GELÖSCHT) werden der App **nicht** geliefert.

### 4.3 Kategorien → Kalenderfarben
Kategorien werden im Sheet-Blatt `Categories` gepflegt (Spalten `Category`, `ColorId`). Die Farbe gilt **im Google Kalender**; die App zeigt die Kategorie aktuell nur als neutrales Badge.

Verfügbare Google-Kalender-Farben (ColorId): 1 Lavendel · 2 Salbei · 3 Weintraube · 4 Flamingo · 5 Banane · 6 Mandarine · 7 Pfau · 8 Graphit · 9 Heidelbeere · 10 Basilikum · 11 Tomate.

---

## 5. Status-Logik

| Status | Bedeutung | Im Kalender | In der App heute |
|---|---|---|---|
| **AKTIV** | normaler Termin | normal, Kategoriefarbe | rote Datumskachel, normaler Text |
| **ABGESAGT** | fällt aus, bleibt sichtbar | Titel „❌ ABGESAGT: …“, Farbe Graphit (grau), Hinweis in der Beschreibung | graue Datumskachel, Titel durchgestrichen, Badge „Abgesagt“ |
| **VERSCHOBEN** | auf anderes Datum verlegt | am alten Datum: Titel „↪️ VERSCHOBEN auf 19.11. 19:00: …“, Farbe Mandarine (orange) | orange Datumskachel, Badge „Verschoben → 19.11.2026, 19:00 Uhr“ |
| **LÖSCHEN** | soll entfernt werden (Übergang) | wird gelöscht | Badge „Wird gelöscht“ (nur kurz sichtbar) |
| **GELÖSCHT** | entfernt | nicht mehr vorhanden | nicht sichtbar |

**Übergänge**

```
            Absagen                    Löschen
  AKTIV ─────────────► ABGESAGT ─────────────► GELÖSCHT
    │  ▲                  │                       ▲
    │  └── Wieder ────────┘                       │
    │      aktivieren                             │
    │  Verschieben (+ neues Datum)                │
    └─────────────► VERSCHOBEN ───────────────────┘
                      │  └─► erzeugt automatisch einen NEUEN Termin (AKTIV)
                      └── Wieder aktivieren → AKTIV (neuer Termin bleibt bestehen!)
```

**Besonderheiten, die das Design abbilden muss**
- **Verschieben erzeugt zwei Termine:** den alten (markiert, bleibt am alten Datum sichtbar) und einen neuen (normal). Der neue bekommt in der Beschreibung „(verschoben vom 12.11.2026)“.
- Ohne neue Uhrzeit übernimmt der neue Termin **Uhrzeit und Dauer** des alten.
- Wird ein verschobener Termin **wieder aktiviert**, bleibt der neue Termin bestehen → Nutzer muss ihn ggf. selbst absagen/löschen (wird per Bestätigung erklärt).
- **Serientermine** (`recurring`): Änderungen gelten für die ganze Serie. Einzelne Serientermine lassen sich in V1 nicht getrennt bearbeiten.
- **Absagen ist der Normalfall**, Löschen die Ausnahme (die Mannschaft soll sehen, dass etwas ausfällt).

---

## 6. Screens & Abläufe

### 6.1 Übersicht

```
                 ┌──────────────┐
  Anmelde-Link ─►│  Anmeldung   │◄── Code ungültig / gesperrt / Abmelden
  (#code=…)      └──────┬───────┘
                        │ gültiger Code
                        ▼
                 ┌──────────────┐  Tap auf Karte  ┌──────────────┐
                 │ Terminliste  │ ──────────────► │   Details    │
                 │ (Hauptscreen)│                 └──┬───┬───┬───┘
                 └──┬───────┬───┘                    │   │   │
           „＋ Termin“│     │ „⋯“            Bearbeiten Verschieben Absagen/Löschen/
                    ▼       ▼                    │   │      Wieder aktivieren
             ┌──────────┐ ┌──────────┐           ▼   ▼          ▼
             │ Formular │ │ Weitere  │     ┌──────────┐ ┌──────────┐ ┌──────────────┐
             │  (neu)   │ │ Aktionen │     │ Formular │ │Verschiebe│ │ Bestätigung  │
             └──────────┘ └──────────┘     │(bearb.)  │ │ -Dialog  │ └──────────────┘
                                           └──────────┘ └──────────┘
```

Alle Unter-Screens sind **Bottom Sheets** über der Liste (kein Seitenwechsel, kein Router, kein Zurück-Button des Browsers).

### 6.2 Anmeldung
- Vollflächig in Akzentrot, App-Icon (88 px), Titel „Dienstplan“, kurzer Hinweistext.
- Eingabefeld für den Zugangscode: Monospace, Großbuchstaben, zentriert, Platzhalter `XXXX-XXXX-XXXX-XXXX-XXXX`. Bindestriche und Leerzeichen werden ignoriert.
- Button „Anmelden“ → Ladezustand „Prüfe…“ → bei Erfolg direkt in die Liste.
- Fehlermeldung unter dem Button (z. B. „Zugangscode ungültig oder gesperrt.“).
- **Alternativer Einstieg:** Anmelde-Link `…/dienstplan/#code=XXXX` → Code wird gespeichert, aus der Adresse entfernt, Anmeldung übersprungen.
- **Sonderfall:** Fehlt in `config.js` der Server-Link, zeigt die Anmeldeseite „Die App ist noch nicht eingerichtet …“ ohne Eingabefeld.

### 6.3 Terminliste (Hauptscreen)
**Kopfzeile (fixiert beim Scrollen)**
- Links: „🚒 Dienstplan“ (22 px, fett) + Unterzeile „Feuerwehr Kalender-Sync“.
- Rechts: Icon-Buttons „⋯“ (Weitere Aktionen) und „↻“ (Neu laden), je 42×42 px.
- Darunter: Segment-Umschalter **Kommend | Vergangen** + Suchfeld.
- Optional: gelber Hinweis-Streifen bei veralteten Daten (siehe [9](#9-zustände-laden-leer-fehler-offline)).

**Liste**
- Gruppiert nach Monat: Überschrift in Versalien, z. B. „NOVEMBER 2026“.
- „Kommend“: aufsteigend ab heute (ein Termin gilt als kommend, solange sein Enddatum ≥ heute ist).
- „Vergangen“: absteigend, neueste zuerst.
- Suche filtert live über Titel, Ort, Beschreibung und Kategorie.
- Jede Zeile ist eine **Terminkarte** (siehe [7.1](#71-terminkarte)).

**Floating Action Button** unten rechts: „＋ Termin“ (56 px hoch, Akzentrot).

**Verhalten**
- Beim Start wird sofort die zuletzt gespeicherte Liste gezeigt und im Hintergrund aktualisiert.
- Kommt die App nach mehr als 60 Sekunden aus dem Hintergrund zurück, lädt sie automatisch neu.

### 6.4 Details (Bottom Sheet)
Inhalt von oben nach unten:
1. Titel (20 px, fett) + Badges
2. 📅 Langes Datum („Donnerstag, 12. November 2026“) + Zeitangabe
3. 📍 Ort (falls vorhanden)
4. 📝 Beschreibung, mehrzeilig (falls vorhanden)
5. Info-Kästen je nach Status:
   - VERSCHOBEN: orange „↪️ Verschoben auf **19.11.2026, 19:00 Uhr**. Der neue Termin ist angelegt.“
   - ABGESAGT: grau „❌ Abgesagt. Der Termin bleibt im Kalender sichtbar.“
   - Serie: „🔁 Serientermin – Änderungen gelten für die ganze Serie.“
6. Aktionen:
   - **AKTIV:** [Bearbeiten] (primär, volle Breite) · [Verschieben] [Absagen] (nebeneinander)
   - **ABGESAGT / VERSCHOBEN:** [Wieder aktivieren] (primär) · [Bearbeiten]
   - immer: [Löschen] (Textbutton, Gefahrfarbe)
7. Kleingedruckt: „Letzte Änderung: 06.11.2026 18:12 · Lars“

### 6.5 Formular „Neuer Termin“ / „Termin bearbeiten“
| Feld | Steuerelement | Standard (neu) | Regeln |
|---|---|---|---|
| Titel | Textfeld | leer, Platzhalter „z. B. Übungsdienst“ | Pflicht, Fokus beim Öffnen |
| Ganztägig | Checkbox | aus | blendet die Uhrzeiten aus |
| Datum / Bis | 2 × Datumsfeld nebeneinander | heute / heute | „Bis“ wandert mit, solange der Termin eintägig ist |
| Beginn / Ende | 2 × Uhrzeitfeld nebeneinander | 19:00 / 21:00 | Beginn Pflicht (wenn nicht ganztägig), Ende nach Beginn |
| Ort | Textfeld | leer, „z. B. Feuerwehrhaus“ | optional |
| Kategorie | Auswahlliste | „– keine –“ | nur sichtbar, wenn Kategorien existieren |
| Beschreibung | mehrzeiliges Feld | leer | optional |

Buttons: [Anlegen]/[Speichern] (primär) · [Abbrechen] (zurück zu den Details bzw. schließen).
Bei Serienterminen zusätzlich der Serien-Hinweis.

### 6.6 Verschieben-Dialog
- Titel „Verschieben“, darunter „Dienstbesprechung · bisher 12.11.2026, 19:00 Uhr“.
- Felder: **Neues Datum** (vorbelegt mit altem Datum) + **Uhrzeit** (vorbelegt mit alter Uhrzeit; entfällt bei ganztägigen Terminen).
- Info: „Der alte Termin bleibt als ‚verschoben' im Kalender sichtbar. Der neue Termin wird automatisch angelegt.“
- Falls schon ein Folgetermin existiert: orange Warnung „… Es wird nur die Markierung geändert.“
- Buttons: [Verschieben] (orange) · [Abbrechen].
- Prüfung: Datum Pflicht; identisches Datum + Uhrzeit → „Das ist noch der alte Termin.“

### 6.7 Bestätigungen
Einheitliches Bottom Sheet: Titel, erklärender Satz, [Aktion] (primär) · [Zurück].

| Auslöser | Titel | Text | Button |
|---|---|---|---|
| Absagen | Termin absagen? | „… bleibt im Kalender sichtbar und wird als abgesagt markiert.“ | Absagen |
| Löschen | Termin löschen? | „… wird aus dem Kalender entfernt. Wenn er nur ausfällt, ist ‚Absagen' meist besser – dann sehen es alle.“ | Endgültig löschen |
| Wieder aktivieren (mit Folgetermin) | Wieder aktivieren? | „Der bereits angelegte neue Termin bleibt bestehen …“ | Wieder aktivieren |
| Abmelden | Abmelden? | „Auf diesem Gerät musst du danach den Zugangscode neu eingeben.“ | Abmelden |

Wieder aktivieren **ohne** Folgetermin passiert ohne Bestätigung.

### 6.8 Weitere Aktionen („⋯“)
- „Angemeldet als **Lars**“
- [Alle Termine jetzt synchronisieren]: kompletter Abgleich Sheet → Kalender (kann 10–60 s dauern)
- [Abmelden]
- [Schließen]
- Erklärung: Der komplette Sync ist nur für Änderungen nötig, die direkt im Sheet gemacht wurden.

### 6.9 Rückmeldungen (Toast)
- Unten über dem FAB, 3 s (Erfolg, dunkelgrau) bzw. 6 s (Fehler, dunkelrot).
- Beispiele: „Termin abgesagt.“ · „Termin verschoben – der neue Termin ist angelegt.“ · „Gespeichert.“ · „Termin angelegt.“
- Bei `warning`: Fehler-Optik mit „Im Sheet gespeichert, aber der Kalender konnte nicht aktualisiert werden: …“

---

## 7. Komponenten

### 7.1 Terminkarte
```
┌──────────────────────────────────────────────┐
│ ┌─────┐  Übungsdienst: Atemschutz            │
│ │ FR  │  19:30–21:30 Uhr · Feuerwehrhaus     │
│ │  6  │  [Übung] [🔁 Serie]                  │
│ │ Nov │                                      │
│ └─────┘                                      │
└──────────────────────────────────────────────┘
```
- Ganze Karte ist ein Button (öffnet Details), leichte Verkleinerung beim Antippen.
- **Datumskachel** 52 px breit: Wochentag (11 px, fett, Versalien), Tag (22 px, fett), Monat (11 px). Farbe nach Status (rot/grau/orange).
- **Titel** 16 px, halbfett, bricht um.
- **Metazeile** 14 px, gedämpft: Zeitangabe · Ort.
- **Badges** (12 px, Pillenform): Abgesagt · Verschoben → … · Wird gelöscht · 🔁 Serie · Kategorie · Noch nicht im Kalender.

**Zeitangaben**
| Fall | Anzeige |
|---|---|
| mit Ende | `19:30–21:30 Uhr` |
| ohne Ende | `19:30 Uhr` |
| ganztägig | `Ganztägig` |
| mehrtägig ganztägig | `Ganztägig bis 14.11.` |
| mehrtägig mit Uhrzeit | `19:00–12:00 Uhr (bis 15.11.)` |

### 7.2 Bottom Sheet
- Von unten einfahrend (250 ms, ease-out), max. 90 % Höhe, scrollbar, oben 20 px Radius, Griff-Strich.
- Abgedunkelter Hintergrund (42 % Schwarz); Tap darauf oder Escape schließt (nicht während des Speicherns).
- Max. 640 px breit, zentriert auf großen Bildschirmen.

### 7.3 Buttons
| Variante | Optik | Verwendung |
|---|---|---|
| Primär | Akzentrot, weißer Text | Hauptaktion pro Sheet |
| Warnung | Orange-Hintergrund, orange Text | Verschieben |
| Standard | Fläche 2, Rahmen | Nebenaktionen, Abbrechen |
| Gefahr | nur Text, Gefahrfarbe | Löschen |
| Icon | 42×42, Rahmen | Kopfzeile |
| FAB | 56 px hoch, rot, Schatten | Neuer Termin |

Alle Buttons mindestens **48 px hoch**. Beim Speichern: alle Buttons im Sheet gesperrt, der gedrückte zeigt einen Kreisel + „Wird gespeichert…“.

### 7.4 Formularfelder
46 px hoch, 10 px Radius, Fläche 2, 16 px Schrift (verhindert Zoom auf iOS), Label darüber (13 px, halbfett, gedämpft). Native Datums-/Uhrzeit-Auswahl des Systems.

### 7.5 Info-Kasten
Abgerundeter Kasten (12 px Radius, 14 px Text) in neutral oder orange (Warnung).

---

## 8. Design-Tokens (aktuell)

### 8.1 Farben

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--bg` | `#f3f3f1` | `#111111` | Seitenhintergrund |
| `--surface` | `#ffffff` | `#1c1c1c` | Karten, Sheets |
| `--surface-2` | `#f6f6f4` | `#252525` | Felder, Standard-Buttons |
| `--text` | `#1b1b1b` | `#ededed` | Haupttext |
| `--muted` | `#686868` | `#a3a3a3` | Nebentext |
| `--line` | `#e2e2de` | `#313131` | Rahmen, Trenner |
| `--accent` | `#c62828` | `#ef5350` | Feuerwehrrot: Primär, aktive Termine |
| `--accent-ink` | `#ffffff` | `#ffffff` | Text auf Akzent |
| `--accent-soft` | `#fdecec` | `#3a1c1c` | Datumskachel aktiv |
| `--warn` | `#a74a00` | `#ffb35c` | Verschoben (Text) |
| `--warn-bg` | `#fff1df` | `#3a2914` | Verschoben (Fläche) |
| `--off` | `#7a7a7a` | `#9a9a9a` | Abgesagt (Text) |
| `--off-bg` | `#ececea` | `#2a2a2a` | Abgesagt (Fläche) |
| `--danger` | `#b3261e` | `#f2675f` | Löschen |
| Toast | `#232323` | `#232323` | Erfolgsmeldung |
| Toast Fehler | `#8e1c16` | `#8e1c16` | Fehlermeldung |

Hell/Dunkel folgt automatisch der Systemeinstellung (`prefers-color-scheme`); es gibt keinen manuellen Umschalter.

### 8.2 Typografie
Systemschrift (`-apple-system, Segoe UI, Roboto, …`), keine Webfonts.

| Rolle | Größe | Gewicht |
|---|---|---|
| App-Titel | 22 px | 700 |
| Sheet-Titel | 20 px | 700 |
| Tageszahl (Kachel) | 22 px | 700 |
| Fließtext, Kartentitel, Felder | 16 px | 400 / 600 |
| Metazeile, Info, Segment | 14 px | 400 |
| Labels, Monatsüberschrift | 13 px | 600–700 |
| Badges, Kleingedrucktes | 12 px | 600 / 400 |
| Wochentag/Monat (Kachel) | 11 px | 700 / 400 |
| Zugangscode-Feld | 18 px Monospace | 600 |

### 8.3 Maße
| Element | Wert |
|---|---|
| Seitenrand | 16 px |
| Maximalbreite Inhalt | 680 px (Sheets 640 px) |
| Kartenabstand | 8 px |
| Karten-Innenabstand | 12 px |
| Radien | Karten 14 · Buttons 12 · Felder 10 · Kachel 10 · Sheet 20 · FAB 18 · Badge rund |
| Schatten (hell) | `0 1px 2px rgba(0,0,0,.05), 0 4px 14px rgba(0,0,0,.05)`; im Dunkelmodus keiner |
| Safe Areas | `env(safe-area-inset-*)` oben (Kopfzeile) und unten (FAB, Sheet, Liste) |

### 8.4 Bewegung
Sheet 250 ms `cubic-bezier(.2,.8,.2,1)`, Hintergrund und Toast 200 ms, Karten-Tap `scale(.99)`. Bei „Bewegung reduzieren“ werden die Übergänge abgeschaltet.

### 8.5 Icons
Aktuell **Emojis und Unicode-Zeichen** (🚒 📅 📍 📝 🔁 ❌ ↪️ ⋯ ↻ ＋), keine Icon-Bibliothek. App-Icon: weißer Kreis mit Feuerwehrauto-Emoji auf rotem Grund (192/512/180 px, PNG).

---

## 9. Zustände: Laden, Leer, Fehler, Offline

| Zustand | Wann | Darstellung heute |
|---|---|---|
| Erstes Laden | keine gespeicherte Liste | Kreisel + „Lade Termine…“ mittig |
| Hintergrund-Laden | gespeicherte Liste vorhanden | Liste sofort sichtbar, kein Indikator |
| Leer | keine Termine im Filter | „Keine kommenden Termine.“ / „Keine vergangenen Termine.“ / „Keine Treffer.“ |
| Fehler ohne Daten | Server nicht erreichbar, nichts gespeichert | „⚠️ Keine Verbindung zum Server. Bist du online?“ + [Nochmal versuchen] |
| Veraltet / offline | Laden fehlgeschlagen, alte Liste vorhanden | gelber Streifen „Offline – du siehst den Stand vom 06.11., 18:12.“ |
| Speichern | nach Tap auf eine Aktion | Kreisel im Button, Sheet gesperrt (2–6 s) |
| Speichern fehlgeschlagen | Fehler vom Server | Sheet bleibt offen, roter Toast mit Grund |
| Kalender-Warnung | Sheet ok, Kalender nicht | Sheet schließt, roter Toast mit Erklärung |
| Abgemeldet | Code ungültig/gesperrt | zurück zur Anmeldung mit Meldung |
| Noch nicht im Kalender | Termin ohne `eventId` | Badge „Noch nicht im Kalender“ |

---

## 10. Texte & Tonalität

- **Du-Form**, freundlich, knapp, ohne Technikbegriffe („Kalender“ statt „Sync-Ziel“, „Zugangscode“ statt „Token“).
- Datumsformat **TT.MM.JJJJ**, Uhrzeit **HH:MM Uhr**, Wochentage und Monate deutsch.
- Bestätigungen erklären die **Folge** der Aktion in einem Satz.
- Fehlermeldungen sagen, **was zu tun ist** („Bitte ein neues Datum wählen.“).

Status-Begriffe (verbindlich, müssen zu Sheet und Kalender passen): **Aktiv · Abgesagt · Verschoben · Löschen/Gelöscht**.

---

## 11. Schnittstelle (API)

**Endpunkt:** Apps-Script-Web-App, Link in `config.js` (`API_URL`, endet auf `/exec`).

**Anfrage**
```http
POST <API_URL>
Content-Type: text/plain;charset=utf-8

{ "action": "<aktion>", "code": "<ZUGANGSCODE>", "data": { … } }
```
`text/plain` ist Absicht: Apps Script beantwortet keine CORS-Vorabfragen.

**Aktionen**

| `action` | `data` | Wirkung |
|---|---|---|
| `getData` | – | liefert alle Termine |
| `saveEvent` | `{ ref?, subject, date, endDate, allDay, start, end, location, description, category }` | ohne `ref`: neuer Termin; mit `ref`: bearbeiten |
| `setStatus` | `{ ref, status, newDate?, newTime? }` | `status` = `ABGESAGT` · `VERSCHOBEN` (+ `newDate`, optional `newTime`) · `AKTIV` · `LÖSCHEN` |
| `syncAll` | – | kompletter Abgleich Sheet → Kalender |

`ref` = `{ row, eventId, subject }`. Damit findet der Server die Zeile auch dann wieder, wenn das Sheet inzwischen sortiert wurde.

**Antwort**
```json
{ "ok": true, "message": "Termin abgesagt.", "warning": false,
  "events": [ … ], "categories": [ … ], "today": "2026-11-06", "user": "Lars" }
```
Jede Änderung liefert die **komplette, aktuelle Terminliste** zurück, die App ersetzt ihre Liste damit.

**Fehler**
```json
{ "ok": false, "error": "Zugangscode ungültig oder gesperrt.", "auth": true }
```
`auth: true` → App meldet ab und zeigt die Anmeldung.

---

## 12. PWA-Technik

| Thema | Umsetzung |
|---|---|
| Manifest | `manifest.webmanifest`: Name „Dienstplan Feuerwehr“, Kurzname „Dienstplan“, `display: standalone`, Theme `#c62828`, Icons 192/512 (auch maskable) |
| iOS | `apple-touch-icon.png` (180 px), `apple-mobile-web-app-capable`, Statusleiste `default` |
| Theme-Farbe | hell `#f3f3f1`, dunkel `#111111` (Meta-Tags je Farbschema) |
| Service Worker | `sw.js`: speichert die App-Dateien; Strategie **erst Netz, dann Speicher**; API-Anfragen werden nicht zwischengespeichert |
| Lokaler Speicher | `dienstplan.code` (Zugangscode), `dienstplan.data` (letzte Liste + Zeitpunkt) |
| Aktualisierung | Versionsnummer in `sw.js` erhöhen (`dienstplan-v2` → `v3`), sonst laden Handys alte Dateien |
| Offline | App öffnet und zeigt den letzten Stand; Änderungen sind offline **nicht** möglich (keine Warteschlange) |
| Push-Mitteilungen | nicht vorhanden |

---

## 13. Sicherheit & Zugang

- Die Schnittstelle ist öffentlich erreichbar („Zugriff: Jeder“), beantwortet aber **nur Anfragen mit gültigem Zugangscode**.
- Codes: 20 Zeichen aus 31 eindeutig lesbaren Zeichen (ohne 0/O, 1/I/L), angezeigt als `XXXX-XXXX-XXXX-XXXX-XXXX`.
- Verwaltung im **Sheet-Menü**: „🔑 Zugangscode erstellen…“ (mit Anmelde-Link) und „🔑 Zugangscodes anzeigen / sperren…“. Gespeichert in den Script-Eigenschaften.
- Falsche Codes werden serverseitig um ~0,8 s ausgebremst.
- Im Repository und in der App-Oberfläche stehen **keine** Termine, Codes oder Passwörter.
- Jede Änderung über die App wird im Sheet mit Zeit und Namen vermerkt (Spalte „Letzte Änderung“).
- **Keine Rollen:** Jeder gültige Code darf alles (auch löschen).

---

## 14. Barrierefreiheit

**Vorhanden**
- Echte `<button>`-Elemente, Icon-Buttons mit `aria-label`.
- Segment-Umschalter mit `aria-pressed`, Sheet mit `role="dialog"`, Toast mit `aria-live`.
- Mindestgrößen für Tippziele (42–56 px), 16 px Grundschrift.
- Status nie nur über Farbe: zusätzlich Text-Badge bzw. Durchstreichung.
- Dunkelmodus und reduzierte Bewegung werden berücksichtigt.

**Lücken (für das neue Design)**
- Fokus wird beim Öffnen/Schließen von Sheets nicht gesteuert und nicht im Sheet gehalten.
- Kein sichtbarer Fokusrahmen definiert (Browser-Standard).
- Emojis als Icons werden von Screenreadern vorgelesen.
- Kontraste von `--muted` auf `--surface-2` und von Badges sind nicht systematisch geprüft.

---

## 15. Technische Rahmenbedingungen für das Design

| Rahmenbedingung | Folge fürs Design |
|---|---|
| **Jede Server-Anfrage dauert 2–6 s** (Apps Script) | Ladezustände sind Pflicht; optimistische Anzeige wäre möglich, aber Rückmeldung abwarten |
| Kompletter Sync 10–60 s | Langläufer-Hinweis nötig |
| Server liefert immer die **ganze Liste** | einfache Datenhaltung; keine Teil-Updates nötig |
| Statisches Hosting (GitHub Pages), **kein Build-Schritt** | Vanilla HTML/CSS/JS; Frameworks nur ohne Build (oder Build-Schritt einführen) |
| Keine externen Abhängigkeiten aktuell | Webfonts/Icon-Sets müssten mitgeliefert werden (Offline-Fähigkeit) |
| Native Datums-/Zeitfelder | Aussehen je nach System unterschiedlich; eigene Picker = deutlich mehr Aufwand |
| Keine Push-Mitteilungen, kein Hintergrund-Sync | „Neu“-Hinweise nur beim Öffnen möglich |
| Keine Rollen/Rechte im Backend | Rollen-Design bräuchte Backend-Erweiterung |
| Einzeltermine von Serien nicht bearbeitbar | Design darf das nicht versprechen |
| Status-Begriffe und Präfixe sind im Kalender sichtbar | Änderungen an Begriffen betreffen auch Sheet und Kalender |

---

## 16. Bekannte Schwächen der Version 1

1. **Kein Zurück per Wischgeste/Zurück-Taste:** Sheets schließen sich nicht über die Android-Zurück-Taste oder den Browserverlauf.
2. **Keine Wochen-/Kalenderansicht**, nur Liste.
3. **„Heute“ ist nicht hervorgehoben**, kein Sprung zu heute.
4. **Kategorien ohne Farbe** in der App (nur im Kalender farbig).
5. **Verknüpfung alt ↔ neu bei Verschiebungen** nicht navigierbar (man kann nicht vom alten zum neuen Termin springen).
6. **Kein Rückgängig** nach Absagen/Löschen (nur über „Wieder aktivieren“; Löschen ist endgültig).
7. **Kein Pull-to-Refresh**, nur der ↻-Button.
8. **Emoji-Icons** wirken je nach System unterschiedlich.
9. **Keine Offline-Änderungen.**
10. **Desktop-Ansicht** ist nur eine schmale, zentrierte Handy-Ansicht.

---

## 17. Ideen & offene Fragen für das neue Design

**Ideen (nach Nutzen sortiert)**
- Wischgesten auf Karten (z. B. links = Absagen, rechts = Verschieben) mit Rückgängig-Toast.
- „Heute“/„Diese Woche“-Bereich oben, Sprung-zu-heute.
- Kategoriefarben in der App, passend zu den Google-Kalender-Farben (ColorId 1–11).
- Kompakte Wochen- oder Monatsansicht als zweite Darstellung.
- Schnell-Verschieben: „+1 Woche“, „+2 Wochen“, „anderer Tag“.
- Verlinkung zwischen altem und neuem Termin bei Verschiebungen.
- Vorlagen für wiederkehrende Terminarten (Übungsdienst, Dienstbesprechung … mit Standard-Ort/-Zeit).
- Eigenes Icon-Set (SVG, inline) statt Emojis.
- Zurück-Taste/Wischgeste schließt Sheets.
- Pull-to-Refresh.

**Offene Fragen**
1. Bleibt die Liste die Hauptansicht, oder wird ein Kalender-/Wochenraster ergänzt?
2. Sollen **Rollen** kommen (z. B. „nur lesen“ für weitere Führungskräfte)? → Backend-Änderung.
3. Soll die **Mannschaft** die App künftig auch nutzen (nur lesend)? → andere Zielgruppe, andere Prioritäten.
4. Eigene Markenelemente (Wappen, Ortsname „Wildeshausen“) oder neutral?
5. Feste Farbwelt Feuerwehrrot beibehalten, oder Status-Farben stärker in den Vordergrund?
6. Ist ein Build-Schritt (z. B. für ein Framework oder Icon-Bundling) akzeptabel, oder bleibt es bei „Dateien hochladen, fertig“?

---

## 18. Dateien & Zuständigkeiten

**Repository `lars-menke/dienstplan` (GitHub Pages)**

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst: Anmeldung, Kopfzeile, Liste, FAB, Sheet, Toast |
| `app.css` | gesamtes Styling inkl. Design-Tokens und Dunkelmodus |
| `app.js` | Logik: Anmeldung, API, Liste, Sheets, Formulare, Zustände |
| `config.js` | `API_URL` der Apps-Script-Schnittstelle |
| `manifest.webmanifest` | PWA-Name, Farben, Icons |
| `sw.js` | Service Worker (Cache-Version!) |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon.png` | Icons |
| `docs/PWA-Spezifikation.md` | dieses Dokument |

**Apps-Script-Projekt (am Google Sheet)**

| Datei | Inhalt |
|---|---|
| `Dienstplan-Sync.gs` | Sheet → Kalender-Sync, Status-Logik, Folgetermine, Import, Löschfunktionen, Sheet-Menü |
| `WebApp.gs` | Schnittstelle für die App (`doPost`), Zugangscodes |

**Google Sheet `DataSheet`, relevante Spalten:**
`Subject`, `Start Date`, `Start Time`, `End Date`, `End Time`, `All Day Event`, `Description`, `Location`, `Category` (optional), `Recurrence` (optional), `Status`, `Verschoben auf`, `Folgetermin-ID`, `EventId`, `LastSyncHash`, `Letzte Änderung`.
