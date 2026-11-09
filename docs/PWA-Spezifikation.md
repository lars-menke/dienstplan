# 🚒 Dienstplan AchtzehnZwo – PWA-Spezifikation

> **Stand:** 09.11.2026 · Version 3 (Google Kalender ist Master) · Schnittstelle 6.0 · Tabellenansicht · Serien
> Diese Datei fasst Version 1, die Ergänzung „Version 2“ und die Ergänzung „Version 3“ zusammen und beschreibt den **heutigen Stand** der App. Sie ist die Grundlage für Weiterentwicklung und Design. Herleitung, Umstellung und Notfall-Rückweg von V3 stehen weiter in `docs/PWA-Spezifikation-V3.md`.
> **Design-Vorlage:** Canvas „Dienstplan – neues Design“ (Claude Design). Die Artboards liegen als Referenz-Markup unter `docs/design/` (`*.dc.html`, `*-Dunkel.dc.html` = dunkle Variante).

---

## Inhalt

1. [Überblick](#1-überblick)
2. [Nutzer & Nutzungssituation](#2-nutzer--nutzungssituation)
3. [Systemarchitektur](#3-systemarchitektur)
4. [Rollen & Rechte](#4-rollen--rechte)
5. [Zugangscodes](#5-zugangscodes)
6. [Datenmodell](#6-datenmodell)
7. [Status-Logik](#7-status-logik)
8. [Kategorien – App und Kalender](#8-kategorien--app-und-kalender)
9. [Screens & Abläufe](#9-screens--abläufe)
10. [Gesten](#10-gesten)
11. [Darstellung: Hell, Dunkel, Systemeinstellung](#11-darstellung-hell-dunkel-systemeinstellung)
12. [Design-Tokens](#12-design-tokens)
13. [Komponenten](#13-komponenten)
14. [Zustände: Laden, Leer, Fehler, Offline](#14-zustände-laden-leer-fehler-offline)
15. [Texte & Tonalität](#15-texte--tonalität)
16. [Schnittstelle (API)](#16-schnittstelle-api)
17. [Sheet: Backup, Wiederherstellen, Menü](#17-sheet-backup-wiederherstellen-menü)
18. [PWA-Technik](#18-pwa-technik)
19. [Sicherheit](#19-sicherheit)
20. [Barrierefreiheit](#20-barrierefreiheit)
21. [Technische Rahmenbedingungen](#21-technische-rahmenbedingungen)
22. [Bereitstellung & Betrieb](#22-bereitstellung--betrieb)
23. [Bekannte Grenzen & offene Punkte](#23-bekannte-grenzen--offene-punkte)
24. [Dateien](#24-dateien)
25. [Historie](#25-historie)

---

## 1. Überblick

Die **Dienstplan-PWA** ist eine Handy-App, mit der die Termine einer freiwilligen Feuerwehr (Übungsdienste, Besprechungen, Traditionstermine …) gepflegt werden – unterwegs am Handy, am Laptop auch als Tabelle.

**Leitidee (seit V3):** Der **Google Kalender ist der Master.** Die App liest und schreibt über Apps Script direkt im Kalender; jede Änderung steht sofort dort, wo die Mannschaft sie sieht. Was die App zusätzlich braucht (Status, Kategorie, Verknüpfung verschobener Termine, letzte Änderung), liegt unsichtbar in privaten Zusatzfeldern des Termins. Das Google Sheet ist nur noch **nächtliches Backup** und Papierkorb (Blatt „Gelöscht“).

| Funktion | Kurzbeschreibung |
|---|---|
| Termine ansehen | Liste (gruppiert: Heute, Diese Woche, Später, Monate), Wochenansicht, Tabelle (Laptop/Tablet) |
| Termin anlegen / bearbeiten | mit Vorlagen, Kategorie-Chips und Wiederholung (z. B. „jeden Monat am 1. Samstag“) |
| Absagen | Termin bleibt sichtbar, als abgesagt markiert (auch per Wischen, mit Rückgängig) |
| Verschieben | alter Termin bleibt markiert, neuer wird automatisch angelegt (Schnellwahl +1/+2 Wochen) |
| Wieder aktivieren | macht Absage/Verschiebung rückgängig |
| Löschen | sichert den Termin im Blatt „Gelöscht“ und entfernt ihn aus dem Kalender (nur Admin) |
| Tabelle | direkt in der Zelle bearbeiten, Mehrfachauswahl, Sortieren, Filtern (Schreiben/Admin, ab 768 px) |
| Kategorien verwalten | Name und Kalenderfarbe (nur Admin) |
| Termine importieren | Excel, CSV oder ICS mit Vorschau und Dubletten-Prüfung (nur Admin) |
| Zugangscodes verwalten | persönliche Codes mit Rolle, Mannschafts-Code (nur Admin) |
| Backup und Wiederherstellen | nachts ins Sheet; gelöschte Termine per Menü zurückholen |

---

## 2. Nutzer & Nutzungssituation

| Nutzer | Rolle | Typische Aufgaben |
|---|---|---|
| Person, die den Dienstplan pflegt | Admin | alles, inkl. Verwaltung |
| Führungskräfte (Gruppenführer, Ausbilder) | Schreiben | Termine anlegen, absagen, verschieben |
| Mannschaft | Lesen (gemeinsamer Mannschafts-Code) | Termine ansehen |

**Nutzungssituation:** fast nur Smartphone, unterwegs, einhändig, Aufgaben unter 30 Sekunden. Deutschsprachig, Zeitzone Europe/Berlin. Nutzer sind keine IT-Profis.

**Design-Ziele**
1. Häufige Aktionen (absagen, verschieben) in höchstens 3 Taps bzw. einer Wischgeste.
2. Status eines Termins auf einen Blick (aktiv / abgesagt / verschoben) – nie nur über Farbe.
3. Keine versehentlichen Löschungen: Bestätigungen, Rückgängig, Löschen nur für Admins.
4. Klares Feedback, weil jede Speicherung 2–6 Sekunden dauert.
5. Was die Rolle nicht darf, wird gar nicht erst angeboten.

---

## 3. Systemarchitektur

```
┌──────────────────────────┐   HTTPS POST (JSON, text/plain)   ┌───────────────────────────┐
│  PWA                     │ ────────────────────────────────► │  Google Apps Script        │
│  GitHub Pages            │ ◄──────────────────────────────── │  Web-App „Jeder“           │
│  lars-menke.github.io/   │          JSON-Antwort             │  WebApp.gs (Schnittstelle) │
│  dienstplan/             │                                   │  Kalender.gs (Logik)       │
└──────────────────────────┘                                   └──────┬──────────────┬─────┘
   localStorage: Code, Liste,                          liest/schreibt │              │ nachts 03:00,
   Darstellung, Ansicht                                       sofort  ▼              ▼ beim Löschen
   Service Worker: App-Dateien               ┌───────────────────────────┐   ┌───────────────────────────┐
                                             │ Google Kalender            │   │ Google Sheet (Backup)      │
                                             │ Termine + Zusatzfelder     │   │ DataSheet · Categories ·   │
                                             │ ← Master, Mannschaft       │   │ Gelöscht (geschützt)       │
                                             └───────────────────────────┘   └───────────────────────────┘
   Script-Eigenschaften: Zugangscodes (nur Hash), Kategorien (KATEGORIEN_V3). Script-Cache: Terminliste.
```

| Teil | Technik | Ort |
|---|---|---|
| Oberfläche | HTML, CSS, Vanilla-JavaScript, kein Framework, kein Build | Repository `lars-menke/dienstplan`, GitHub Pages |
| Schnittstelle | Apps Script `doPost`, ausgeführt als Besitzer | `apps-script/WebApp.gs` (Kopie im Repo) |
| Logik | Termine und Kategorien im Kalender, Backup, Wiederherstellen | `apps-script/Kalender.gs`, Hilfsfunktionen in `apps-script/Dienstplan-Sync.gs` |
| Daten | Google Kalender (Gruppenkalender) mit `extendedProperties.private` | Google Calendar (Advanced Service Calendar v3) |
| Einstellungen | Kategorien, Zugangscodes | Script-Eigenschaften des Apps-Script-Projekts |
| Backup | Google Sheet, Blätter `DataSheet`, `Categories`, `Gelöscht` | Google Drive (gebunden an das Script) |

**Schreibrechte im Google Kalender** hat nur der Besitzer (unter dem das Script läuft); alle anderen haben Lesezugriff. Das wird in den Kalendereinstellungen eingerichtet, nicht im Code.

---

## 4. Rollen & Rechte

| Aktion | Lesen | Schreiben | Admin |
|---|:-:|:-:|:-:|
| Liste, Woche, Details ansehen | ✓ | ✓ | ✓ |
| Termin anlegen, bearbeiten | | ✓ | ✓ |
| Absagen, verschieben, wieder aktivieren | | ✓ | ✓ |
| **Löschen** | | | ✓ |
| Kategorien verwalten | | | ✓ |
| Zugangscodes verwalten | | | ✓ |
| Tabellenansicht, Mehrfachaktionen | | ✓ | ✓ (Löschen nur Admin) |
| Darstellung umschalten | ✓ | ✓ | ✓ |

**Regeln**
- Die Rolle hängt am Zugangscode.
- **Der Server prüft die Rolle bei jeder Anfrage** (die Schnittstelle ist öffentlich erreichbar). Die App blendet zusätzlich aus, was nicht erlaubt ist.
- Unerlaubte Aktion → `{ "ok": false, "error": "Dafür fehlen dir die Rechte.", "forbidden": true }`; die App zeigt einen Toast und meldet **nicht** ab.

**Was die App je Rolle zeigt**

| Element | Lesen | Schreiben | Admin |
|---|---|---|---|
| FAB „+ Termin“ | – | ✓ | ✓ |
| Detail-Sheet | Infos, Hinweis „Du kannst Termine ansehen …“, [Schließen] | Absagen, Verschieben, Bearbeiten | + [Löschen] |
| Wischgesten auf Karten | – | ✓ | ✓ |
| Umschalter „Tabelle“ | – | ✓ (ab 768 px) | ✓ (ab 768 px) |
| „Weitere Aktionen“ | Name, Darstellung, Abmelden | wie Lesen | + Kennzeichen ADMIN, Verwaltung |

---

## 5. Zugangscodes

### 5.1 Datenmodell (Script-Eigenschaft `ZUGANGSCODES_V2`)

| Feld | Beispiel | Bedeutung |
|---|---|---|
| `id` | `c_8f3a…` | interne ID |
| `name` | `Gruppenführer 1` | erscheint bei „Letzte Änderung“ |
| `role` | `admin` · `write` · `read` | Rolle |
| `team` | `true` | Mannschafts-Code (gemeinsam, Rolle immer `read`), höchstens einer |
| `hash` | SHA-256 (hex) des normalisierten Codes | der Code selbst wird **nicht** gespeichert |
| `hint` | `K7QM…H2XP` | erste und letzte 4 Zeichen, nur zur Anzeige |
| `blocked` | `false` / ISO-Zeit | gesperrt seit |
| `created`, `lastUsed` | ISO-Zeit | `lastUsed` höchstens stündlich geschrieben |

- Format: 20 Zeichen aus 31 eindeutig lesbaren Zeichen (ohne 0/O, 1/I/L), angezeigt als `XXXX-XXXX-XXXX-XXXX-XXXX`.
- Der **vollständige Code ist nur direkt nach dem Erstellen sichtbar** (auch der Link). Danach nur noch der Hinweis.
- Anmelde-Link: `https://lars-menke.github.io/dienstplan/#code=XXXXXXXXXXXXXXXXXXXX` – meldet beim Öffnen direkt an; der Code wird aus der Adresse entfernt.

### 5.2 Schutzregeln
- Den **eigenen Code** kann man weder sperren, herabstufen noch löschen.
- Der **letzte aktive Admin** bleibt immer Admin (nicht sperr-, herabstuf- oder löschbar).
- Gesperrte Codes werden wie ungültige behandelt (`auth: true`).
- Falsche Codes werden serverseitig um ca. 0,8 s ausgebremst.

### 5.3 Mannschafts-Code
- Gemeinsamer Lese-Code für die Mannschaft. **Neu erzeugen** macht den alten sofort ungültig und liefert neuen Code samt Link (mit Bestätigung).
- Wird nicht gesperrt, sondern neu erzeugt oder gelöscht.
- Weil nur der Hash gespeichert ist, gibt es den Link **nur direkt nach dem Erzeugen**; die Karte weist darauf hin.

---

## 6. Datenmodell

### 6.1 Termin (wie die App ihn bekommt)

| Feld | Typ | Beispiel | Bedeutung |
|---|---|---|---|
| `eventId` | Text | `"a1b2…"` | ID des Kalendertermins – **einzige Kennung** in der API |
| `subject` | Text | `"Übungsdienst: Atemschutz"` | Titel ohne Status-Präfix (Pflicht, max. 200 Zeichen) |
| `date`, `endDate` | ISO-Datum | `"2026-11-12"` | Beginn, Ende (= `date` bei eintägig) |
| `allDay` | Ja/Nein | `false` | ganztägig |
| `start`, `end` | `HH:MM` | `"19:30"` | Uhrzeiten (leer bei ganztägig; ohne Ende = 60 Min.) |
| `location` | Text | `"Feuerwehrhaus"` | Ort |
| `description` | Text | `"PA mitbringen"` | Beschreibung ohne Kategorie-Zeile und Status-Hinweis |
| `category` | Text | `"Übung"` | Kategorie (siehe Kapitel 8) |
| `status` | Text | `"AKTIV"` | siehe Kapitel 7 |
| `recurring` | Ja/Nein | `false` | Serientermin |
| `recurrence` | Text | `"RRULE:FREQ=MONTHLY;BYDAY=1SA"` | Wiederholungsregel (leer = keine) |
| `verschobenAuf` | Text | `"19.11.2026, 19:00 Uhr"` | Ziel der Verschiebung |
| `folgetermin` | Ja/Nein | `true` | neuer Termin bereits angelegt |
| `synced` | Ja/Nein | `true` | immer `true` (Termine stehen direkt im Kalender) |
| `lastChange` | Text | `"06.11.2026 18:12 · Lars"` | letzte Änderung über die App mit Name; sonst Zeit von Google, ggf. „· direkt im Kalender“ |

Geliefert werden alle Termine ab **1. Januar des Vorjahres**, ein Eintrag pro Serie. Typische Mengen: 150–300 Termine/Jahr, 3 Kategorien.

### 6.2 Termin im Kalender
**Sichtbar** (für die Mannschaft, gebaut von `buildEventResource_`): Titel mit Status-Präfix (`❌ ABGESAGT: …`, `↪️ VERSCHOBEN auf 19.11. 19:00: …`), Farbe der Kategorie bzw. des Status, Beschreibung (`Kategorie: …`, Status-Hinweis, eigentliche Beschreibung), Ort, Zeiten, Wiederholung (RRULE; Ausnahmen wie EXDATE aus Google bleiben beim Ändern erhalten).

**Private Zusatzfelder** (`extendedProperties.private`, unsichtbar):

| Schlüssel | Beispiel | Bedeutung |
|---|---|---|
| `dp` | `3` | „von der Dienstplan-App verwaltet“ + Schema-Version |
| `subject` | `Übungsdienst: Atemschutz` | Betreff ohne Status-Präfix |
| `desc` | `PA und Maske mitbringen.` | Beschreibung ohne Kategorie-Zeile und Status-Hinweis (entfällt bei über 1024 Zeichen) |
| `cat` | `Übung` | Kategorie-Name (leer = keine) |
| `status` | `AKTIV` · `ABGESAGT` · `VERSCHOBEN` | Status |
| `movedTo` / `movedToText` | `<eventId>` / `2026-11-13T19:30` | beim verschobenen Termin: Folgetermin und Ziel |
| `movedFrom` | `<eventId>` | beim Folgetermin: Ursprung |
| `changed` | `05.11.2026 18:12 · Lars` | letzte Änderung über die App |
| `sync` | ISO-Zeit | wann das Script zuletzt geschrieben hat (spätere Änderung kam direkt aus Google) |

Titel und Beschreibung werden **immer aus den Zusatzfeldern neu gebaut**.

**Termine ohne Zusatzfelder** (direkt in Google angelegt) zeigt die App trotzdem: Status aus dem Titel-Präfix, Betreff ohne Präfix, Kategorie aus der Zeile `Kategorie: …` oder einer eindeutigen Farbe, Beschreibung ohne Kategorie-Zeile, Status-Hinweis und alte Markierung „#Dienstplan 2026“. Beim ersten Speichern aus der App bekommen sie die Zusatzfelder.

**Serien:** ein Eintrag pro Serie; Status-Aktionen und Änderungen gelten für die ganze Serie. Einzelne, direkt in Google geänderte Termine einer Serie zeigt die App nicht gesondert.

### 6.3 Sheet (nur Backup)
Siehe Kapitel 17: `DataSheet` (nachts alle Termine), `Categories` (Kategorien), `Gelöscht` (jeder gelöschte Termin sofort). Änderungen im Sheet haben **keine Wirkung** auf Kalender oder App.

---

## 7. Status-Logik

| Status | Bedeutung | Im Kalender | In der App |
|---|---|---|---|
| **AKTIV** | normaler Termin | Kategoriefarbe | rote/gelbe Datumskachel, Badge „● Aktiv“ im Detail |
| **ABGESAGT** | fällt aus, bleibt sichtbar | „❌ ABGESAGT: …“, Graphit (8), Hinweis in der Beschreibung | graue Kachel, Titel durchgestrichen, Badge „Abgesagt“ |
| **VERSCHOBEN** | verlegt | „↪️ VERSCHOBEN auf 19.11. 19:00: …“, Mandarine (6) | orange Kachel, Badge „Verschoben auf Di 17.11.“ |
| **LÖSCHEN** | Aktion (nur Admin) | wird zuerst im Blatt „Gelöscht“ gesichert, dann aus dem Kalender entfernt | verschwindet aus der Liste |

```
            Absagen (auch Wischen ←)          Löschen (Admin)
  AKTIV ─────────────────────► ABGESAGT ───────────────────► gelöscht (Blatt „Gelöscht“)
    │  ▲                          │                             ▲
    │  └── Wieder aktivieren / Rückgängig                       │
    │  Verschieben (+ neues Datum, auch Wischen →)              │
    └────────────────────► VERSCHOBEN ──────────────────────────┘
                              └─► legt automatisch einen NEUEN Termin (AKTIV) an
```

- Der neue Termin bekommt in der Beschreibung „(verschoben vom 12.11.2026)“; ohne neue Uhrzeit übernimmt er Uhrzeit und Dauer. Beide Termine sind über `movedTo`/`movedFrom` verknüpft.
- Wieder aktivieren eines verschobenen Termins: Der neue Termin bleibt bestehen (Hinweis per Bestätigung).
- Serientermine: Änderungen gelten für die ganze Serie.
- Absagen ist der Normalfall, Löschen die Ausnahme.

---

## 8. Kategorien – App und Kalender

### 8.1 Speicherort und Bestand
Script-Eigenschaft **`KATEGORIEN_V3`**: `[{ "name": "Übung", "colorId": 11 }, …]`. Gepflegt wird nur in der App (Verwaltung → Kategorien). Das Blatt `Categories` ist eine Kopie im nächtlichen Backup.

**Festgelegte Kategorien (bewusst nur drei):**

| Kategorie | Farbe | Beispiele |
|---|---|---|
| Übung | Tomate (11) | 1. Gruppe, Übungsdienst, Atemschutz, Maschinist |
| Besprechung | Pfau (7) | Ortskommando, Stadtkommando, Gruppenführer-Dienstbesprechung |
| Tradition | Banane (5) | Himmelfahrt, Gildefest, Jahreshauptversammlung, Volkstrauertag |

Termine ohne passende Kategorie bleiben ohne; nachtragen geht schnell in der Tabelle („Kategorie setzen…“ für mehrere Termine).

### 8.2 Farben
Erlaubt sind die Google-Kalender-Farben; **Mandarine (6) und Graphit (8) sind reserviert** für „Verschoben“ und „Abgesagt“.

| ColorId | Name | Hex (Hell) | Punkt im Dunkelmodus |
|---|---|---|---|
| 1 | Lavendel | `#7986cb` | `#7986cb` |
| 2 | Salbei | `#33b679` | `#33b679` |
| 3 | Weintraube | `#8e24aa` | `#8e24aa` |
| 4 | Flamingo | `#e67c73` | `#e67c73` |
| 5 | Banane | `#f6bf26` | `#f6bf26` |
| 6 | Mandarine | `#f4511e` | – reserviert – |
| 7 | Pfau | `#039be5` | `#039be5` |
| 8 | Graphit | `#616161` | – reserviert – |
| 9 | Heidelbeere | `#3f51b5` | `#7986cb` |
| 10 | Basilikum | `#0b8043` | `#33b679` |
| 11 | Tomate | `#d50000` | `#ff5a4f` |

In der Farbauswahl stehen immer die echten Google-Farben; nur die Punkte in Liste und Woche werden im Dunkelmodus aufgehellt.

### 8.3 Kategorie im Kalender
1. **Terminfarbe** = ColorId (nur in Google Kalender sichtbar; Apple Kalender/iCal-Abos zeigen keine Farben).
2. **Erste Zeile der Beschreibung:** `Kategorie: Übung`, Leerzeile, dann Status-Hinweis und Beschreibung. Sie entsteht beim Schreiben in den Kalender; maßgeblich ist das Zusatzfeld `cat`.
3. Der Titel bleibt ohne Kategorie.

### 8.4 Ändern, Umbenennen, Löschen
- **Neu:** Name Pflicht, eindeutig (Groß/Klein egal), max. 40 Zeichen; Farbe Pflicht.
- **Farbe ändern / Umbenennen:** Die Kategorienliste ändert sich sofort; die App zeigt den neuen Namen gleich (Umbenennungen liegen bis zum Nachziehen in `KATEGORIEN_V3_UMBENENNUNGEN`). Die betroffenen Kalendertermine schreibt ein **einmaliger Trigger nach ca. 1 Minute** neu (`runScheduledRefresh`); läuft er länger als 5 Minuten, plant er sich für den Rest neu ein. Meldung: „Gespeichert. Der Kalender wird in den nächsten Minuten aktualisiert.“
- **Löschen:** nur wenn kein Termin sie nutzt, sonst „Wird von 12 Terminen genutzt – erst die Termine umstellen.“

---

## 9. Screens & Abläufe

Unter-Screens sind **Bottom Sheets** über der Liste; die Verwaltung (Kategorien, Zugangscodes) sind eigene **Seiten** mit Zurück-Knopf. Sheets und Seiten legen einen Eintrag im Browser-Verlauf an und schließen mit der Zurück-Taste (siehe Kapitel 10).

### 9.1 Anmeldung (`Anmeldung`)
Rote Vollfläche, unabhängig vom Theme. Logo (Kalender mit Haken), Titel als Logo-Schriftzug (Kapitel 12.1: Kicker „DIENSTPLAN“ 18 px, `#ffe1e1`, Sperrung .32em; darunter „AchtzehnZwo“ 40 px, weiß, Abstand 2 px), darunter „Alle Termine der Feuerwehr Wildeshausen auf einen Blick.“, Feld „Zugangscode“ (Monospace, Großbuchstaben, Bindestriche egal), [Anmelden]. Fehlermeldung unter dem Knopf. Alternativ Anmelde-Link `#code=…`.

### 9.2 Terminliste (`Main`)
- **Kopfzeile:** Logo, Titel als Logo-Schriftzug (Kicker „DIENSTPLAN“ 11 px, `--muted`, Sperrung .28em; „AchtzehnZwo“ 22 px in `--accent-text` – hell Feuerwehrrot, dunkel Signalgelb; bis 360 px Breite 19 px), darunter Sync-Stand (12 px) („✓ Im Kalender · Stand 08:31“ bzw. „Wird gespeichert…“ / „Offline · Stand …“), Knöpfe ↻ (neu laden, zeigt auch Ziehen-zum-Aktualisieren) und ⋯ (Weitere Aktionen).
- Umschalter **Liste | Woche | Tabelle** (gemerkt in `dienstplan.view`; Tabelle nur Schreiben/Admin ab 768 px, Kapitel 9.11) und Knopf **Heute**.
- Suchfeld (Titel, Ort, Beschreibung, Kategorie; durchsucht auch vergangene Termine).
- Gelber Offline-Streifen bei veraltetem Stand.
- Liste: Textknopf **„Vergangene Termine“** (klappt vergangene Monate oberhalb auf), einmaliger Wisch-Hinweis (Schreiben/Admin), Gruppen **HEUTE** (Akzent-Etikett + Datum), **DIESE WOCHE**, **SPÄTER IM <MONAT>**, danach Monate.
- Karte von heute: Akzentrahmen, volle Akzent-Datumskachel.
- Badges: Kategorie mit Farbpunkt, Serie, „Verschoben auf …“, „vom … verschoben“ (Folgetermin).
- FAB „+ Termin“ (Schreiben/Admin).

### 9.3 Wochenansicht (`Woche`)
- Wochennavigation ‹ › mit „9.–15. November“ und „KW 46 · nächste Woche“ (diese/letzte Woche, in/vor n Wochen).
- Tagesstreifen Mo–So mit bis zu 3 Punkten (Kategorie- bzw. Statusfarbe); gewählter Tag mit Akzent gefüllt, heute in Akzentfarbe.
- Darunter alle 7 Tage: „Kein Termin“ oder kompakte Karten („Zeit · Ort“ bzw. „· Verschoben auf …“ / „· Abgesagt“). Tippen öffnet Details.
- Startet mit der Woche von heute; „Heute“ springt zurück; Tag antippen springt zum Tag.
- „+ Termin“ übernimmt den gewählten Tag als Datum.
- Waagerechtes Wischen wechselt die Woche (Kapitel 10).

### 9.4 Details (`Details`, `DetailsLesen`)
- Oben Status-Badge („● Aktiv“, „Abgesagt“ …), Kategorie, Serie; Titel 22 px; Schließen-Knopf.
- Fakten: Datum („Heute · Freitag, 6. November 2026“), Uhrzeit, Ort, Beschreibung; Hinweis-Kästen (Serie, abgesagt, verschoben auf …).
- **Schreiben/Admin, AKTIV:** Kacheln **Absagen** | **Verschieben** (72 px), **Bearbeiten** (primär), unten „Letzte Änderung …“ und [Löschen] (nur Admin).
- **ABGESAGT/VERSCHOBEN:** [Wieder aktivieren] (primär), [Bearbeiten].
- **Lesen:** Hinweis „Du kannst Termine ansehen. Änderungen macht, wer den Dienstplan pflegt.“, [Schließen], „Letzte Änderung …“.

### 9.5 Verschieben (`Verschieben`)
Schnellwahl **+1 Woche** (vorgewählt, mit Zieldatum) · **+2 Wochen** · **Anderer Tag**; Felder neues Datum und Uhrzeit; **Vorschau** „Alter Termin bleibt sichtbar – als ‚Verschoben auf 13.11.‘“ / „Neuer Termin wird angelegt – 19:30–21:30 Uhr · Ort“; Hauptknopf „Auf Fr 13.11. verschieben“. Hinweis, falls schon ein Folgetermin existiert.

### 9.6 Neuer Termin / Bearbeiten (`Formular`)
- **Vorlagen** (nur bei „Neuer Termin“) als Chips, fest in `config.js` → `TEMPLATES`:

  | Vorlage | Titel-Anfang | Zeit | Ort | Kategorie |
  |---|---|---|---|---|
  | Übungsdienst | „Übungsdienst: “ | 19:30–21:30 | Feuerwehrhaus | Übung |
  | Gruppendienst | „Gruppendienst: “ | 09:00–12:00 | Feuerwehrhaus | Ausbildung* |
  | Besprechung | „Besprechung: “ | 19:00 | Schulungsraum | Besprechung |
  | Leer | – | 19:00–21:00 | – | – |

  \* Gibt es die Kategorie nicht (mehr), bleibt sie leer.
- Titel, Schalter „Ganztägig“, Datum/Bis, Beginn/Ende, **Wiederholung**, Ort, **Kategorie als Farb-Chips** (aus `categoryList`, plus „Keine“), Beschreibung.
- **Wiederholung** (Baukasten, ergibt eine RRULE): Keine · Täglich · Wöchentlich (Wochentage Mo–So wählbar, mehrere) · Monatlich („am 1./2./3./4./letzten <Wochentag>“, auch mehrere wie „2. + 4. Dienstag“, oder „am Tag X“) · Jährlich – jeweils „alle n …“. Ende: ohne · endet am Datum · endet nach n Terminen. Darunter eine Vorschau in Klartext („Jeden Monat am 1. Samstag“). Passt das Startdatum nicht zur Regel, wird es auf den ersten passenden Tag gelegt („Erster Termin: Sa 05.12.2026 (Datum wird angepasst)“). Regeln, die im Google Kalender anders eingestellt wurden, bleiben als „Eigene Regel (aus Google Kalender)“ unverändert, solange nichts anderes gewählt wird.
- [Abbrechen] und [Anlegen]/[Speichern] fest am unteren Rand.

### 9.7 Weitere Aktionen (`Aktionen`)
Avatar mit Initiale, „Angemeldet als **Lars**“ (+ „ADMIN“); **Darstellung** Hell · Dunkel · Systemeinstellung („Gilt nur auf diesem Gerät.“); **Verwaltung** (Admin): Kategorien (Anzahl) ›, Zugangscodes (Anzahl) ›; [Abmelden] mit Bestätigung.

### 9.8 Kategorien (`Kategorien`, `KategorieBearbeiten`)
Seite: Liste mit Farbkreis, Name, „Tomate · 38 Termine“ bzw. „nicht genutzt“; gestrichelter Knopf [Kategorie hinzufügen]; Info-Kasten (Farbe + Beschreibungszeile).
Sheet: Name; Farbraster (6 Spalten, Auswahl mit Ring + Haken; Mandarine/Graphit gestrichelt und gesperrt); Hinweis zu betroffenen Terminen; [Abbrechen] [Speichern]; [Löschen] deaktiviert, solange genutzt.

### 9.9 Zugangscodes (`Zugangscodes`, `CodeNeu`)
- **Mannschaft:** Badge „Lesen“, Hinweis `K7QM-····-····-····-H2XP`, „Gemeinsamer Code · zuletzt genutzt …“, Hinweis zum Link, [Neu erzeugen] (mit Bestätigung) und [Bearbeiten] (Name, Löschen). Ohne Mannschafts-Code: [Mannschafts-Code erzeugen].
- **Persönliche Codes:** Name (durchgestrichen, wenn gesperrt), „Dieses Gerät“ / „zuletzt genutzt …“ / „gesperrt am …“, Rollen-Badge (Admin dunkel bzw. gelb, Schreiben blau, Lesen/Gesperrt grau).
- Antippen: Name, Rolle, [Speichern], [Sperren]/[Entsperren], [Löschen] (mit Bestätigung); beim eigenen Code nur Name.
- FAB „+ Code“: „Für wen?“, Rolle mit Erklärung, Hinweis „nur einmal vollständig angezeigt“, [Code erstellen].
- Nach dem Erstellen/Erzeugen: Code groß in Monospace, [Link teilen] (`navigator.share`, sonst Kopieren), [Fertig].

### 9.10 Bestätigungen
Einheitliches Sheet: Titel, ein erklärender Satz, [Aktion] (primär), [Zurück]. Für: Absagen (aus Details), Löschen (einzeln und mehrere aus der Tabelle), Wieder aktivieren mit Folgetermin, Abmelden, Kategorie löschen, Code sperren/löschen, Mannschafts-Code neu erzeugen/löschen.

### 9.11 Tabellenansicht (`Tabelle`, Schreiben/Admin, ab 768 px)
- Dritter Eintrag im Umschalter; auf schmalen Geräten und für Lesen ausgeblendet (wird das Fenster schmaler, springt die App zur Liste). Inhalt bis 1240 px breit; die Tabelle scrollt in sich, die Kopfzeile bleibt stehen.
- Spalten: ☐ · Datum · Beginn · Ende · Titel · Serie · Ort · Kategorie · Status · Letzte Änderung.
- **Direkt bearbeiten:** Klick in Titel, Ort, Datum, Beginn, Ende oder Kategorie macht die Zelle zum Eingabefeld (Kategorie als Auswahl). Enter oder Verlassen speichert über `saveEvent`, Esc bricht ab. Während des Speicherns Kreisel in der Zeile; bei Fehler alter Wert mit rotem Rahmen und Toast. Beginn ändern verschiebt das Ende mit (Dauer bleibt), Datum ändern behält die Länge mehrtägiger Termine. Speichern läuft nacheinander.
- Datum/Zeit einer Serie, Zeiten ganztägiger Termine und die Spalte **Serie** öffnen das normale Formular (Serie: direkt bei „Wiederholung“). Status und „Letzte Änderung“ öffnen die Details.
- **Mehrfachauswahl:** Kästchen, Shift+Klick (Bereich), „Alle“ im Kopf. Aktionsleiste unten (statt „+ Termin“): „Absagen (n)“, „Wieder aktivieren (n)“ (`setStatusBulk`), „Kategorie setzen…“ (`saveEvents`, in Paketen zu 50), „Löschen (n)“ (nur Admin, mit Bestätigung, nacheinander über `setStatus`), „Auswahl aufheben“.
- **Sortieren** per Spaltenkopf (zweiter Klick dreht um, `aria-sort`); **Filter** Zeitraum („Ab heute“ – laufende Serien immer dabei – / „Alle“), Kategorie (inkl. „Ohne“), Status; Suche wie in der Liste.
- **Tastatur:** Pfeile wechseln die Zelle (Roving-Tabindex, `role="grid"`), Pos1/Ende, Strg+Pos1/Ende, Bild auf/ab, Enter oder F2 bearbeitet, Leertaste wählt die Zeile, Esc hebt die Auswahl auf.
- Heute-Zeile in Akzent-Hintergrund, vergangene Termine gedämpft, Abgesagt durchgestrichen. Hell/Dunkel über die Tokens aus Kapitel 12.


### 9.12 Termine importieren (`Import`, Admin)
Weitere Aktionen → Verwaltung → **Termine importieren** öffnet eine Seite mit vier Schritten (Anzeige 1 Datei · 2 Spalten · 3 Vorschau · 4 Import):
1. **Datei** wählen oder hineinziehen: `.xlsx`, `.xls`, `.csv`, `.ics`. Gelesen wird nur im Browser. Excel mit mehreren Blättern: Blatt wählen.
2. **Spalten zuordnen:** Titel und Datum Pflicht; Beginn, Enddatum, Ende, Ganztägig, Ort, Beschreibung, Kategorie, Wiederholung optional. Übliche Namen (Subject/Betreff/Titel, Start Date/Datum, Beginn/Uhrzeit, Ort/Location …) werden automatisch zugeordnet, die Zuordnung wird gemerkt (`dienstplan.importMap`). Neben jeder Auswahl steht der Wert aus der ersten Zeile. Das bisherige Excel-Format und ICS-Dateien überspringen diesen Schritt.
3. **Vorschau** als Tabelle: ✓ neu · ⚠ möglicherweise doppelt (gleiches Datum, gleicher Beginn bzw. beide ganztägig, ähnlicher Titel – gegen den Kalender und frühere Zeilen der Datei; standardmäßig abgewählt) · ✗ Fehler mit Grund (nicht wählbar). Knöpfe „Nur neue“, „Alle wählbaren“, „Keine“. Unbekannte Kategorien: je Kategorie „neu anlegen“ (Farbe wählbar, Vorschlag: noch freie Farbe) oder „ohne Kategorie“.
4. **Import:** neue Kategorien anlegen, dann Termine in Paketen zu 50 über `saveEvents`, mit Fortschrittsbalken; Zusammenfassung „32 angelegt, 3 übersprungen, 1 Fehler“ mit Fehlerliste; [Weitere Datei] · [Fertig].

Datumsformate `TT.MM.JJJJ` (auch `T.M.JJ`), `JJJJ-MM-TT`, Excel-Seriennummern, Datum mit Uhrzeit in einer Zelle; Zeiten `HH:MM`, `HH.MM`, „19 Uhr“, Excel-Bruchteile. Ohne Uhrzeit = ganztägig, ohne Ende = +60 Minuten. Excel liest SheetJS (`vendor/xlsx.full.min.js`, erst bei Bedarf geladen), CSV und ICS eigener Code. Beispieldatei: `docs/beispiele/import-beispiel.csv`.

---

## 10. Gesten

| Geste | Wo | Wirkung | Regeln |
|---|---|---|---|
| Karte **nach links** wischen | Liste, Schreiben/Admin, aktive Termine | sofort **Absagen**, Toast „Termin abgesagt.“ mit **[Rückgängig]** (6 s → `setStatus AKTIV`) | Schwelle 35 % der Kartenbreite; Karte zeigt „Wird abgesagt…“, Kopf „Wird gespeichert…“ |
| Karte **nach rechts** wischen | wie oben | **Verschieben**-Dialog | – |
| Waagerecht wischen | Wochenansicht (Streifen und Tagesliste) | Woche vor/zurück | ab 60 px; Inhalt folgt dem Finger, federt sonst zurück |
| **Nach unten ziehen** | ganz oben in Liste und Woche | neu laden | Inhalt rutscht mit (45 % Widerstand); auslösen erst ab ≈ 210 px Fingerweg **und** 0,25 s Halten; schnelles Wischen löst nie aus; Anzeige am ↻-Knopf (hell → voll gefärbt → dreht beim Laden) |
| Sheet nach unten ziehen | alle Sheets | schließen | ab ca. 25 % der Sheet-Höhe bzw. 140 px |
| Zurück-Taste / Zurück-Geste | Android, Browser | schließt Sheet bzw. Verwaltungsseite | History API (`pushState`/`popstate`); während des Speicherns bleibt das Sheet offen |

- Achsensperre bei 10 px: senkrechtes Scrollen wird nie blockiert.
- Karten-Wischen gibt es nur in der Liste (in der Woche wechselt Wischen die Woche) und nicht für Lesen.
- **Bewegung reduzieren:** selbstlaufende Animationen aus, Gesten bleiben.
- iPhone-App vom Startbildschirm hat keine System-Zurück-Geste → dort Sheet nach unten ziehen.

---

## 11. Darstellung: Hell, Dunkel, Systemeinstellung
- In „Weitere Aktionen“ → Darstellung; gespeichert in `localStorage` `dienstplan.theme` = `light` · `dark` · (fehlt = `system`). Gilt nur auf diesem Gerät.
- `data-theme="light|dark"` am `<html>`; bei System entscheidet `prefers-color-scheme` (mit Listener). `theme-color` wird passend gesetzt.
- Ein kleines Inline-Script im `<head>` setzt das Theme **vor dem ersten Rendern** (kein Aufblitzen).
- Dunkelmodus: **Nachtblau mit Signalgelb**. Die Anmeldung bleibt immer rot.

---

## 12. Design-Tokens

Schrift: Systemschrift (`Inter` wird genutzt, falls installiert; nicht mitgeliefert). Maße und Radien siehe Kapitel 13.

### 12.1 Titel „Dienstplan AchtzehnZwo“ (Logo-Schriftzug)

Der Titel ist ein zweizeiliger Schriftzug – auf der Anmeldung und in der Kopfzeile gleich aufgebaut. **Nur hier** werden eigene Schriften verwendet; der Rest der App bleibt bei der Systemschrift.

```html
<h1 aria-label="Dienstplan AchtzehnZwo">
  <span class="title-kicker" aria-hidden="true">Dienstplan</span>
  <span class="title-script" aria-hidden="true">AchtzehnZwo</span>
</h1>
```

| Teil | Schrift | Anmeldung | Kopfzeile |
|---|---|---|---|
| Kicker „DIENSTPLAN“ | Barlow Condensed 600, Versalien, gesperrt | 18 px, Sperrung .32em, `#ffe1e1` | 11 px, Sperrung .28em, `--muted`, Zeilenhöhe 1.2 |
| Schriftzug „AchtzehnZwo“ | Permanent Marker 400, kein Umbruch | 40 px, Zeilenhöhe 1.2, weiß | 22 px (≤ 360 px Breite: 19 px), Zeilenhöhe 1.15, `--accent-text` |

- „AchtzehnZwo“ in einem Wort, A und Z groß.
- Schriften liegen in `fonts/` (`permanent-marker.woff2` – Apache 2.0, `barlow-condensed-600.woff2` – SIL OFL; Lizenztexte daneben), eingebunden per `@font-face` mit `font-display: swap`, im Service Worker für offline zwischengespeichert.
- Screenreader lesen „Dienstplan AchtzehnZwo“ (`aria-label`), die Einzelteile sind `aria-hidden`.
- Name: `<title>` und Manifest-`name` „Dienstplan AchtzehnZwo“; `short_name` und `apple-mobile-web-app-title` bleiben „Dienstplan“ (unter dem Homescreen-Icon würde Längeres abgeschnitten).

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--bg` | `#f4f3f0` | `#0b1530` | Seitenhintergrund |
| `--surface` | `#ffffff` | `#141f40` | Karten, Sheets |
| `--surface-2` | `#f6f6f4` | `#1a2650` | Felder, Standard-Buttons |
| `--chip` / `--chip-ink` | `#f1f0ec` / `#3d3d3d` | `#1d2a55` / `#d4dae9` | Badges, Info-Kästen |
| `--segment` | `#e9e8e3` | `#18234a` | Segment-Umschalter |
| `--text` | `#1b1b1b` | `#eef1f8` | Haupttext |
| `--text-2` | `#4a4a4a` | `#c3cbe0` | Abschnittsüberschriften, Labels |
| `--muted` | `#5f5f5f` | `#a7b2cf` | Nebentext |
| `--line` / `--line-strong` | `#e4e2dd` / `#d6d4ce` | `#263463` / `#33447a` | Rahmen |
| `--accent` | `#c62828` | `#e8ff2b` | Feuerwehrrot / Signalgelb |
| `--accent-ink` | `#ffffff` | `#0b1530` | Text auf Akzent |
| `--accent-soft` / `-line` | `#fdecec` / `#f3c9c9` | `#2c3414` / `#5a661d` | Datumskachel, Heute-Knopf |
| `--accent-text` | `#b71c1c` | `#e8ff2b` | Akzent als Text |
| `--today-line` | `#ef9a9a` | `#e8ff2b` | Rahmen der heutigen Karte |
| `--focus` | `#c62828` | `#e8ff2b` | Fokusrahmen |
| `--warn` / `--warn-bg` / `--warn-line` | `#9a4300` / `#fff1df` / `#f5cf9f` | `#ffaa5c` / `#3a2a14` / `#6e4a1e` | Verschoben |
| `--warn-solid` / `-ink` | `#a74a00` / `#ffffff` | `#ff9a3c` / `#0b1530` | Verschieben-Button, Wisch-Hintergrund |
| `--off` / `--off-bg` / `--off-title` | `#616161` / `#ececea` / `#6b6b6b` | `#9aa5c4` / `#1b2547` / `#8d98b8` | Abgesagt |
| `--danger` | `#b3261e` | `#ff7b72` | Löschen |
| `--ok` / `--ok-bg` / `--ok-ink` | `#2e7d32` / `#e8f5e9` / `#1b5e20` | `#5fd38a` / `#123a26` / `#8fe3a8` | „Im Kalender“, „Aktiv“ |
| `--toast` | `#232323` | `#233166` | Toast |
| `--offline-bg` / `-ink` | `#fff6d6` / `#5c4a00` | `#2f2c0e` / `#f2e58a` | Offline-Streifen |
| `--role-admin-bg` / `-ink` | `#1b1b1b` / `#ffffff` | `#e8ff2b` / `#0b1530` | Badge Admin |
| `--role-write-bg` / `-ink` | `#e3f2fd` / `#0d47a1` | `#16305e` / `#9cc4ff` | Badge Schreiben |
| `--swipe-cancel` | `#5a5a5a` | `#3b4a7a` | Wisch-Hintergrund Absagen |
| `--undo-ink` | `#ffcdd2` | `#e8ff2b` | „Rückgängig“ im Toast |

Alle Text-/Hintergrund-Paare erreichen mindestens **4,5:1**.

**Datumskachel nach Status:** Aktiv = `--accent-soft` + `--accent-text`; Heute = volle Akzentfläche + Akzentrahmen; Verschoben = `--warn-bg` + `--warn`; Abgesagt = `--off-bg` + `--off`, Titel durchgestrichen.

**Icons:** Inline-SVG (`icons.js`), 24er-Raster, 2 px Strich, `currentColor`, `aria-hidden` an dekorativen Icons, `aria-label` an Icon-Buttons. Vorhanden: Kalender, Kalender-Haken, Haken, Neu laden, Mehr, Suche, Chevrons, Serie, Pfeil rechts, Kreuz, Plus, Ort, Notiz, Verbot, Stift, Sonne, Mond, Handy, Info, Schlüssel, Kategorien, Teilen, Auge, WLAN-aus, Abmelden.

---

## 13. Komponenten

| Komponente | Maße / Verhalten |
|---|---|
| Terminkarte | Kachel 52 px (Wochentag 11 px, Tag 22 px, Monat 11 px), Titel 16 px/600, Meta 14 px, Badges 24 px hoch; Radius 14 px |
| Wochenkarte | kompakt: Meta 12 px/700, Titel 15 px/600, Radius 12 px |
| Tagesstreifen | 7 Spalten, Knöpfe 62 px hoch, Punkte 6 px |
| Bottom Sheet | max. 92 % Höhe, Radius 20 px oben, Griff, Fokus wandert hinein und zurück, Fokusfalle, Escape/Zurück/nach unten ziehen schließt |
| Seite (Verwaltung) | eigene Kopfzeile mit Zurück-Knopf, Untertitel „Nur für Admins“ |
| Buttons | primär (Akzent), Warnung (Verschieben), Standard, Text/Gefahr, Kacheln 72 px, Icon 44×44, FAB 56 px; alle ≥ 44 px |
| Formularfelder | 46 px, Radius 10 px, 16 px Schrift, Fokus mit 2-px-Rahmen in Akzentfarbe |
| Schalter | 46×28 px, Rolle `switch` |
| Chips | Kategorie: 40 px, Radius 10, Farbpunkt; Vorlage: Pille, Auswahl in Akzent |
| Toast | unten, 3 s (Erfolg) bzw. 6 s (Fehler, Rückgängig), optional mit Aktionsknopf |

Seitenrand 16 px, Inhalt max. 680 px breit (Sheets 640 px).

---

## 14. Zustände: Laden, Leer, Fehler, Offline

| Zustand | Darstellung |
|---|---|
| Erstes Laden | Kreisel + „Lade Termine…“ |
| Hintergrund-Laden | gespeicherte Liste sofort sichtbar, ↻ dreht sich |
| Leer | „Keine kommenden Termine.“ / „Keine Treffer.“ / Woche: „Kein Termin“ je Tag |
| Fehler ohne Daten | Hinweis + [Nochmal versuchen] |
| Offline / veraltet | gelber Streifen „Offline – du siehst den Stand von 08:31. Änderungen gehen erst wieder mit Verbindung.“, Kopf „Offline · Stand …“ |
| Speichern | Kreisel im Button bzw. auf der Karte, Sheet gesperrt, Kopf „Wird gespeichert…“ |
| Speichern fehlgeschlagen | Sheet bleibt offen, roter Toast |
| Kalender antwortet nicht | Toast „Google Kalender hat gerade nicht geantwortet. Bitte gleich nochmal versuchen.“ |
| Keine Rechte | Toast „Dafür fehlen dir die Rechte.“, Anzeige wird angepasst |
| Abgemeldet | Code ungültig/gesperrt → Anmeldung mit Meldung |

---

## 15. Texte & Tonalität
Du-Form, freundlich, knapp, keine Technikbegriffe („Zugangscode“ statt „Token“). Datum TT.MM.JJJJ, Uhrzeit HH:MM Uhr. Bestätigungen erklären die Folge in einem Satz; Fehlermeldungen sagen, was zu tun ist. Status-Begriffe (verbindlich, auch im Kalender und im Backup): **Aktiv · Abgesagt · Verschoben · Löschen/Gelöscht**.

---

## 16. Schnittstelle (API)

**Endpunkt:** Apps-Script-Web-App, Link in `config.js` (`API_URL`, endet auf `/exec`). `GET` liefert `{ ok, info, version }` – damit lässt sich prüfen, welche Version bereitgestellt ist.

**Anfrage**
```http
POST <API_URL>
Content-Type: text/plain;charset=utf-8

{ "action": "<aktion>", "code": "<ZUGANGSCODE>", "data": { … } }
```
`text/plain` vermeidet die CORS-Vorabfrage, die Apps Script nicht beantwortet.

**Jede Antwort** enthält `ok`, bei erfolgreicher Anmeldung zusätzlich `role` (`admin`·`write`·`read`), `userName` und `user` (= Name).

| `action` | Rolle | `data` | Antwort / Wirkung |
|---|---|---|---|
| `getData` | Lesen | `{ fresh? }` | `events`, `categoryList: [{ name, colorId, count }]`, `today`; für Admins `codeCount`. `fresh: true` (Herunterziehen, ↻) holt Änderungen sofort aus dem Kalender |
| `saveEvent` | Schreiben | `{ eventId?, subject, date, endDate, allDay, start, end, location, description, category, recurrence? }` | ohne `eventId` neu, sonst ändern. `recurrence`: RRULE; fehlt das Feld, bleibt die Wiederholung, `''` entfernt sie. Wie `getData` + `message` |
| `saveEvents` | Schreiben | `{ events: [ … ] }` (je wie `saveEvent`, bis 100) | `created`, `updated`, `failed: [{ index, error }]` + Liste |
| `setStatus` | Schreiben, **LÖSCHEN nur Admin** | `{ ref: { eventId }, status, newDate?, newTime? }` | `ABGESAGT` · `VERSCHOBEN` (+`newDate`, optional `newTime`; legt den Folgetermin an) · `AKTIV` · `LÖSCHEN` (erst Blatt „Gelöscht“, dann Kalender) |
| `setStatusBulk` | Schreiben | `{ eventIds: [ … ], status }` (bis 100) | nur `ABGESAGT` und `AKTIV`; `updated`, `failed` + Liste |
| `saveCategory` | Admin | `{ oldName?, name, colorId }` | anlegen bzw. ändern/umbenennen (Kapitel 8.4); wie `getData` + `message` |
| `deleteCategory` | Admin | `{ name }` | löschen, wenn `count = 0` |
| `syncAll` | Admin | – | nur noch für ältere App-Stände: `message: "Nicht mehr nötig – Änderungen stehen sofort im Kalender."` |
| `listCodes` | Admin | – | `codes: [{ id, name, role, team, hint, blocked, created, lastUsed, self }]`, `codeCount` |
| `createCode` | Admin | `{ name, role }` | `code`, `link` (nur in dieser Antwort) + Liste |
| `updateCode` | Admin | `{ id, name?, role?, blocked? }` | ändern, sperren, entsperren (Schutzregeln Kapitel 5.2) |
| `deleteCode` | Admin | `{ id }` | Code endgültig entfernen (nicht der eigene, nicht der letzte Admin) |
| `rotateTeamCode` | Admin | – | neuer Mannschafts-Code, alter sofort ungültig → `code`, `link`; legt einen an, falls keiner existiert |

Änderungen an Terminen liefern die komplette aktuelle Liste zurück. Schreibende Aktionen laufen über `LockService` nacheinander.

**Tempo:** Die Terminliste liegt im Script-Cache (bis 6 Stunden, in Teilen unter 90 KB). Ist sie älter als 5 Minuten oder kommt `fresh`, holt der Server nur die seit dem letzten Lesen geänderten bzw. gelöschten Termine (`updatedMin`, ein schneller Aufruf); komplett gelesen wird nur ohne Cache oder nach 6 Stunden – und dann nur mit den Feldern, die die App braucht. Nach dem Speichern werden die geschriebenen Termine direkt in die gespeicherte Liste übernommen. Anfragen der App öffnen die Tabelle nicht (Zeitzone wird nur am Script geprüft).

**Fehler**

| Fall | Antwort | App-Verhalten |
|---|---|---|
| Code ungültig/gesperrt | `{ ok:false, error, auth:true }` | abmelden, Anmeldung zeigen |
| Rolle reicht nicht | `{ ok:false, error:"Dafür fehlen dir die Rechte.", forbidden:true }` | Toast, kein Abmelden |
| Validierung | `{ ok:false, error:"Diese Kategorie gibt es schon." }` | Toast, Sheet bleibt offen |
| Google Kalender antwortet nicht | `{ ok:false, error:"Google Kalender hat gerade nicht geantwortet. Bitte gleich nochmal versuchen." }` | Toast |

---

## 17. Sheet: Backup, Wiederherstellen, Menü

Das Sheet (dieselbe Datei wie früher) ist seit V3 **nur noch Rückfallebene**:

- **Nächtliches Backup** (`backupToSheet`, Trigger täglich gegen 03:00 Uhr, eingerichtet mit `enableNightlyBackup()`): Blatt **`DataSheet`** – Zeile 1 Hinweis „Backup vom 09.11.2026, 03:00 – Änderungen hier haben keine Wirkung. Termine bitte in der App bearbeiten.“, Zeile 2 Kopfzeile, darunter alle Termine mit `Subject`, `Start Date`, `Start Time`, `End Date`, `End Time`, `All Day Event`, `Description`, `Location`, `Category`, `Status`, `Verschoben auf`, `Recurrence`, `EventId`, `Letzte Änderung`, `Folgetermin-ID`. Blatt **`Categories`**: `Category`, `ColorId`, `Farbe` (mit Farbvorschau). Keine Zugangscodes im Sheet. Ältere Stände über „Datei → Versionsverlauf“.
- **Blatt `Gelöscht`:** Jeder Löschvorgang hängt **vor** dem Löschen eine Zeile an (Spalten wie im Backup plus `Gelöscht am`, `Gelöscht von`). So ist auch ein Termin wiederherstellbar, der nach dem letzten Backup angelegt und gelöscht wurde.
- **Schutz:** `DataSheet`, `Categories` und `Gelöscht` sind geschützt – nur der Eigentümer (und damit das Script) darf schreiben.
- **Wiederherstellen:** Zeile in `Gelöscht` oder `DataSheet` markieren → Menü „Termin aus Backup wiederherstellen…“. Steht der Termin noch im Kalender: „Dieser Termin ist noch im Kalender.“ Sonst wird er mit allen Zusatzfeldern neu angelegt; Verknüpfungen verschobener Termine zeigen auf den neuen Termin; die neue EventId wird in der Zeile vermerkt.

**Sheet-Menü „📅 Dienstplan“:** Termin aus Backup wiederherstellen… · Backup jetzt erstellen · 🔑 Zugangscode erstellen… (mit Rolle) · 🔑 Zugangscodes verwalten… (Übersicht, Rolle, sperren, entsperren, gesperrte löschen) · 📱 Link der App-Schnittstelle anzeigen. Der frühere Sheet-Sync (15-Minuten-Sync, Import, Cleanup, Hard Delete, Sheet einrichten, Kategorien-Vorschläge) ist seit Schnittstelle 6.0 entfernt.

**Editor-Funktionen:** `enableNightlyBackup()` / `disableNightlyBackup()` · `backupToSheet()` · `aufraeumenEtappe3()` (einmalig nach dem Update auf 6.0: alte Trigger und Eigenschaft `DATENQUELLE` entfernen) · `migrateCodesV2()` (alte Klartext-Codes → Hash-Modell; erledigt) · `setAdmin(name)` (Code zum Admin machen).

---

## 18. PWA-Technik

| Thema | Umsetzung |
|---|---|
| Manifest | `manifest.webmanifest`: „Dienstplan AchtzehnZwo“ / „Dienstplan“, `standalone`, Theme `#c62828`, Icons 192/512 (`any`) und `icon-maskable-512.png` (`maskable`, mit mehr Rand für Android) |
| App-Icon | Kalender mit Haken, weiß auf Feuerwehrrot `#c62828` – dasselbe Zeichen wie das Logo auf der Anmeldung; Dateien `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180 px), `favicon.png` (64 px) |
| iOS | `apple-touch-icon.png` (180 px), `apple-mobile-web-app-capable` |
| Service Worker | `sw.js`, Cache `dienstplan-v12` (inkl. `table.js`, `import.js` und Schriften in `fonts/`; der Excel-Leser in `vendor/` wird erst beim Import geladen); erst Netz, dann Speicher; API-Anfragen laufen durch; entfernt beim Aktivieren alte Caches (auch `dienstplan-beta-*`) |
| Lokaler Speicher | `dienstplan.code` (Zugangscode), `dienstplan.data` (letzte Liste), `dienstplan.theme`, `dienstplan.view` (`list`/`week`/`table`), `dienstplan.swipeHintSeen` |
| Aktualisierung | nach Änderungen an App-Dateien die Cache-Version in `sw.js` erhöhen |
| Offline | App öffnet mit letztem Stand; Änderungen offline nicht möglich |
| Aufräumen Beta | `beta/sw.js` meldet sich selbst ab und löscht den Beta-Cache; `beta/index.html` leitet (mit `#code=…`) zur App weiter; die App entfernt beim Start Beta-Registrierungen und -Daten. Beide Dateien können nach einigen Wochen gelöscht werden. |

---

## 19. Sicherheit
- Schnittstelle öffentlich erreichbar („Zugriff: Jeder“), beantwortet aber nur Anfragen mit gültigem Code; Rolle wird bei jeder Anfrage geprüft.
- Codes nur als SHA-256-Hash in den Script-Eigenschaften; vollständiger Code nur einmal sichtbar.
- Im Repository stehen keine Termine, Codes oder Passwörter. Öffentlich sichtbar sind der Schnittstellen-Link (`config.js`) und die Kalender-ID im Script – beide ohne Code bzw. Kalenderfreigabe wertlos.
- Jede Änderung über die App wird am Termin mit Zeit und Namen vermerkt („Letzte Änderung“, Zusatzfeld `changed`); gelöschte Termine stehen mit Zeit und Namen im Blatt „Gelöscht“.
- Im Google Kalender darf nur der Besitzer schreiben; die Mannschaft hat Lesezugriff.

---

## 20. Barrierefreiheit
- Echte Buttons, `aria-label` an Icon-Buttons und Karten (Titel, Datum, Zeit, Status), `aria-pressed` an Umschaltern und Chips, `role="dialog"` + `aria-modal` an Sheets, `aria-live` für Toast und Sync-Stand.
- Fokus wandert ins Sheet (Titel bzw. erstes Feld) und beim Schließen zurück zur auslösenden Karte; Fokusfalle im Sheet; Hintergrund `inert`.
- Sichtbarer Fokusrahmen (3 px) in Akzentfarbe.
- Kontraste ≥ 4,5:1 in Hell und Dunkel; Status nie nur über Farbe.
- Tippziele ≥ 44 px; 16 px Grundschrift (kein Zoom auf iOS).
- „Bewegung reduzieren“ wird berücksichtigt.
- Wischgesten haben immer einen Weg ohne Geste (Details, Pfeile, ↻).

---

## 21. Technische Rahmenbedingungen

| Rahmenbedingung | Folge |
|---|---|
| Jede Anfrage 2–3 s (Apps Script + Kalender) | Ladezustände Pflicht |
| Script-Laufzeit max. 6 Min. | Nachziehen nach Kategorie-Änderung und Mehrfachaktionen hören nach 5 Min. sauber auf |
| Server liefert immer die ganze Liste | einfache Datenhaltung |
| Statisches Hosting ohne Build | Vanilla HTML/CSS/JS; keine externen Abhängigkeiten |
| Keine Push-Mitteilungen | Neues nur beim Öffnen/Aktualisieren |
| Einzeltermine von Serien nicht bearbeitbar | Hinweis „gilt für die ganze Serie“ |
| Status-Präfixe im Kalender sichtbar | Begriffe nur gemeinsam mit der Ableitung (Kapitel 6.2) ändern |
| Zusatzfelder max. 1024 Zeichen je Wert | lange Beschreibungen werden aus dem sichtbaren Text gelesen |

---

## 22. Bereitstellung & Betrieb
- **App:** Änderungen ins Repository `lars-menke/dienstplan` (Branch `main`); GitHub Pages veröffentlicht nach 1–2 Minuten. Cache-Version in `sw.js` erhöhen.
- **Schnittstelle:** die drei Dateien `apps-script/WebApp.gs`, `Kalender.gs`, `Dienstplan-Sync.gs` ins Apps-Script-Projekt kopieren (Advanced Service „Google Calendar API“ v3 muss aktiv sein), speichern, dann **Bereitstellungen verwalten → bestehende Bereitstellung → Stift → Version „Neue Version“ → Bereitstellen** (sonst ändert sich die `/exec`-URL bzw. die alte Version bleibt aktiv). Kontrolle: `GET` auf die `/exec`-Adresse zeigt `version`.
- **Reihenfolge bei inkompatiblen Änderungen:** erst die App veröffentlichen, dann die Schnittstelle bereitstellen.

---

## 23. Bekannte Grenzen & offene Punkte
1. **Vorlagen** stehen fest in `config.js`; Pflege im Sheet bzw. in der App wäre möglich.
2. **Schrift:** Für den Titel werden Permanent Marker und Barlow Condensed mitgeliefert; für den Rest bleibt es bei der Systemschrift (Inter nur, falls installiert).
3. **Akzentfarbe:** Feuerwehrrot (Hell) / Signalgelb (Dunkel) – bewusst so entschieden.
4. **Mannschafts-Code verteilen:** Weg festlegen (z. B. WhatsApp-Community).
5. Termine ohne Kategorie lassen sich in der Tabelle gesammelt zuordnen („Kategorie setzen…“).
8. **Offen aus V3:** automatische Bereitstellung per `clasp` (Etappe 6, optional) – siehe `PWA-Spezifikation-V3.md`.
6. Vorlage „Gruppendienst“ verweist auf die nicht vorhandene Kategorie „Ausbildung“.
7. Keine Offline-Änderungen, keine Push-Mitteilungen.

---

## 24. Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst, Theme-Script im `<head>` |
| `app.css` | Styling, Design-Tokens Hell/Dunkel |
| `app.js` | gesamte Logik (Anmeldung, API, Liste, Woche, Sheets, Gesten, Verwaltung) |
| `table.js` | Tabellenansicht (Kapitel 9.11), wird vor `app.js` geladen |
| `import.js` | Termine importieren (Kapitel 9.12), wird vor `app.js` geladen |
| `vendor/` | SheetJS `xlsx.full.min.js` 0.20.3 (Apache-2.0, Lizenz und Herkunft in `vendor/README.md`), nur für den Excel-Import |
| `docs/beispiele/` | Beispieldatei für den Import |
| `icons.js` | Inline-SVG-Icons |
| `config.js` | `API_URL`, `TEMPLATES` |
| `manifest.webmanifest`, `*.png` | Name und App-Icon (Kalender mit Haken) |
| `sw.js` | Service Worker |
| `fonts/` | Titel-Schriften (Permanent Marker, Barlow Condensed 600) mit Lizenzen |
| `beta/` | nur noch Weiterleitung + Aufräum-Service-Worker der früheren Testversion |
| `apps-script/Dienstplan-Sync.gs` | Konfiguration, Sheet-Menü, Hilfsfunktionen (Titel/Beschreibung bauen, Datum) |
| `apps-script/Kalender.gs` | Termine und Kategorien im Google Kalender, Backup, Wiederherstellen |
| `apps-script/WebApp.gs` | Schnittstelle, Rollen, Zugangscodes |
| `docs/PWA-Spezifikation.md` | dieses Dokument |
| `docs/PWA-Spezifikation-V3.md` | Herleitung V3, Umstellung, Etappen, Notfall-Rückweg |
| `docs/design/` | Design-Artboards (Referenz) |

---

## 25. Historie

| Datum | Stand |
|---|---|
| 05.11.2026 | Version 1: PWA auf GitHub Pages, Apps-Script-Schnittstelle, persönliche Codes, alle Rechte gleich |
| 06.11.2026 | Spezifikation V2 als Ergänzung; Etappe 1: Rollen, Hash-Codes, `categoryList`, Kategorie im Kalender; Code-Übersicht im Sheet; Kategorien Übung/Besprechung/Tradition |
| 07.11.2026 | Etappen 2–4 als Testversion unter `beta/`: neues Design, Hell/Dunkel, Verwaltung in der App, Wochenansicht, Vorlagen |
| 08.11.2026 | Etappe 5: Wischgesten, Zurück-Taste, Ziehen zum Aktualisieren; Codes in der App löschen |
| 08.11.2026 | Etappe 6: neue Oberfläche freigegeben, `beta/` abgebaut, Feld `categories` entfernt (Schnittstelle 4.0), Spezifikationen zusammengeführt |
| 08.11.2026 | Anmeldung entschlackt (neuer Satz, Hinweis entfernt), neues App-Icon „Kalender mit Haken“, Cache `dienstplan-v5` |
| 08.11.2026 | Titel „Dienstplan AchtzehnZwo“ als Logo-Schriftzug (Permanent Marker + Barlow Condensed), Cache `dienstplan-v6` |
| 09.11.2026 | V3 Etappe 1: Google Kalender ist Master, Zusatzfelder, Kategorien in Script-Eigenschaften, Umstellung mit Schalter `DATENQUELLE` (Schnittstelle 5.0); danach schnelleres Laden (Cache, nur Änderungen nachholen) |
| 09.11.2026 | V3 Etappe 2: nächtliches Backup, Blattschutz, Blatt „Gelöscht“, Wiederherstellen, Menü „📅 Dienstplan“ (5.1) |
| 09.11.2026 | V3 Etappe 4: Tabellenansicht, Wiederholungen im Formular (n-ter Wochentag, Ende), „Letzte Änderung“ immer gefüllt (5.2, Cache bis `dienstplan-v11`) |
| 09.11.2026 | V3 Etappe 3: alter Sheet-Weg, 15-Minuten-Sync, Marker und `LastSyncHash` entfernt, Schalter `DATENQUELLE` entfällt; V3 in diese Spezifikation eingearbeitet (6.0) |
| 09.11.2026 | V3 Etappe 5: Termine importieren (Excel/CSV/ICS, SheetJS 0.20.3 in `vendor/`), Cache `dienstplan-v12` |
