# Dienstplan AchtzehnZwo – Spezifikation Version 3 (Ergänzung)

> **Stand:** 08.11.2026 · ergänzt `docs/PWA-Spezifikation.md`.
> Alles, was hier nicht geändert wird, gilt weiter.
> **Kern von V3:** Das Google Sheet ist nicht mehr der Datenspeicher. **Der Google Kalender ist der Master.** Die App liest und schreibt über Apps Script direkt in den Kalender. Das Sheet bleibt als **nächtliches Backup** in derselben Datei.

---

## 1. Überblick

| | bis V2 | ab V3 |
|---|---|---|
| Datenspeicher | Sheet `DataSheet` | **Google Kalender** (+ private Zusatzfelder je Termin) |
| Weg einer Änderung | App → Apps Script → Sheet → Sync (alle 15 Min.) → Kalender | App → Apps Script → **Kalender, sofort** |
| Kategorien | Blatt `Categories` | **Script-Eigenschaften** |
| Zugangscodes | Script-Eigenschaften | unverändert |
| Sheet | Master | **Backup**, nachts überschrieben, geschützt |
| Termin-Kennung in der API | `row` (+ `eventId`) | **nur `eventId`** |
| Löschen | Status GELÖSCHT im Sheet | **echtes Löschen im Kalender** + sofortiger Eintrag im Blatt `Gelöscht` |
| 15-Minuten-Sync, `LastSyncHash`, „Kompletter Sync“ | vorhanden | **entfällt** |

**Was sich für die Mannschaft ändert:** nichts. Gleicher Kalender, gleiche Darstellung (Präfixe ❌/↪️, Farben, Zeile „Kategorie: …“), gleiche Zugangscodes. Nur der Marker `#Dienstplan 2026` am Ende jeder Beschreibung fällt weg, siehe 2.3.

**Schreibrechte im Google Kalender:** nur Lars (Besitzer, unter dem das Script läuft). Alle anderen haben nur Lesezugriff. Lars richtet das selbst in den Kalendereinstellungen ein, es ist nicht Teil des Codes.

---

## 2. Datenmodell im Kalender

### 2.1 Was im Termin selbst steht (sichtbar)
Unverändert zu V2, gebaut von `buildEventResource_`:
- **Titel:** Betreff, bei Status mit Präfix (`❌ ABGESAGT: …`, `↪️ VERSCHOBEN auf …: …`)
- **Farbe:** `colorId` der Kategorie; Abgesagt = Graphit (8), Verschoben = Mandarine (6)
- **Beschreibung:** `Kategorie: …`, danach Status-Hinweis, danach die eigentliche Beschreibung
- **Ort, Beginn/Ende, ganztägig, Wiederholung (RRULE)**

### 2.2 Private Zusatzfelder (`extendedProperties.private`, unsichtbar)

| Schlüssel | Beispiel | Bedeutung |
|---|---|---|
| `dp` | `3` | Kennzeichen „von der Dienstplan-App verwaltet“ + Schema-Version |
| `subject` | `Übungsdienst: Atemschutz` | Betreff **ohne** Status-Präfix |
| `desc` | `PA und Maske mitbringen.` | Beschreibung **ohne** Kategorie-Zeile und Status-Hinweis |
| `cat` | `Übung` | Kategorie-Name (leer = keine) |
| `status` | `AKTIV` · `ABGESAGT` · `VERSCHOBEN` | Status |
| `movedTo` | `<eventId>` | beim verschobenen Termin: ID des Folgetermins |
| `movedToText` | `2026-11-13T19:30` | Zieldatum/-zeit für Titel/Hinweis |
| `movedFrom` | `<eventId>` | beim Folgetermin: ID des Ursprungs |
| `changed` | `05.11.2026 18:12 · Lars` | „Letzte Änderung“ |

- Grenze bei Google: höchstens 1024 Zeichen pro Wert. Bei längeren Beschreibungen gilt: `desc` weglassen und die Beschreibung aus dem sichtbaren Text rekonstruieren (2.4).
- Titel und Beschreibung werden **immer aus den Zusatzfeldern neu gebaut**. So bleibt die Darstellung einheitlich.

### 2.3 Marker
Der Marker `#Dienstplan 2026` (`SYNC_MARKER`) entfällt, das Kennzeichen ist jetzt `dp`. Die Umstellung (Kap. 6) entfernt ihn aus allen Beschreibungen.

### 2.4 Termine ohne Zusatzfelder
Termine, die Lars direkt in Google angelegt hat oder die noch nicht umgestellt sind, zeigt die App trotzdem an. Werte werden so abgeleitet:
- `status`: aus dem Titel-Präfix, sonst `AKTIV`
- `subject`: Titel ohne Präfix
- `cat`: aus der Zeile `Kategorie: …`, sonst aus der Farbe (eindeutige Zuordnung), sonst leer
- `desc`: Beschreibung ohne Kategorie-Zeile, Status-Hinweis und Marker

Beim ersten Speichern aus der App bekommt der Termin dann die Zusatzfelder.

### 2.5 Serien
Wie bisher: **ein Eintrag pro Serie** (Master-Termin mit RRULE). Status-Aktionen gelten für die ganze Serie. Einzelne Ausnahmen (ein Termin der Serie direkt in Google verschoben) zeigt die App nicht gesondert an. Das ist bewusst außerhalb des Umfangs.

---

## 3. Kategorien
- Gespeichert als Script-Eigenschaft `KATEGORIEN_V3`: `[{ "name": "Übung", "colorId": 11 }, …]`
- Die Regeln aus V2 Kap. 4 gelten weiter (reservierte Farben, eindeutige Namen, Löschen nur bei `count = 0`).
- `count` = Zahl der Termine mit dieser Kategorie aus der aktuellen Terminliste.
- **Umbenennen / Farbe ändern:** Die Eigenschaft wird sofort geändert. Die betroffenen Termine werden in einem einmaligen Trigger nach etwa einer Minute neu geschrieben (`scheduleCalendarRefresh_` bleibt erhalten, liest aber aus dem Kalender). Läuft er länger als 5 Minuten, plant er sich selbst für den Rest neu ein.

---

## 4. Schnittstelle (API)

Gleiches Anfrageformat wie bisher (`POST`, `text/plain`, `{ action, code, data }`). Rollen und Rechte wie V2.

| `action` | Änderung in V3 |
|---|---|
| `getData` | liest den Kalender: ab **1. Januar des Vorjahres**, ohne Ende, alle Seiten (`pageToken`), `singleEvents: false`, `showDeleted: false`. Felder je Termin wie bisher, aber **`row` entfällt**. `synced` ist immer `true`, `lastChange` kommt aus `changed`. |
| `saveEvent` | `data.eventId` vorhanden → Termin ändern (`patch`), sonst neu anlegen. Antwort wie bisher. |
| `setStatus` | `ref` ist `{ eventId }`. ABGESAGT/AKTIV ändern Titel, Farbe, Hinweis und `status`. VERSCHOBEN legt den Folgetermin an und verknüpft beide (`movedTo`/`movedFrom`). **LÖSCHEN** (nur Admin) schreibt den Termin zuerst ins Blatt `Gelöscht` (Kap. 5.3) und löscht ihn dann im Kalender. |
| `saveCategory`, `deleteCategory` | auf Script-Eigenschaften umgestellt (Kap. 3) |
| Code-Aktionen | unverändert |
| `syncAll` | **entfällt** (Antwort: `ok: true`, `message: "Nicht mehr nötig – Änderungen stehen sofort im Kalender."`, damit ältere App-Stände nicht abstürzen) |
| **neu** `saveEvents` | Admin/Schreiben: `{ events: [ … ] }`, bis 100 Termine anlegen/ändern in einem Aufruf (für Import und Tabellenansicht). Antwort: `{ ok, created, updated, failed: [{ index, error }] }` |
| **neu** `setStatusBulk` | Admin/Schreiben: `{ eventIds: [ … ], status }`, nur ABGESAGT und AKTIV |

**Tempo:** Das Ergebnis von `getData` wird im `CacheService` (Script-Cache, 5 Minuten) zwischengespeichert, bei Bedarf in Teilen zu je unter 90 KB. Jede schreibende Aktion löscht den Cache. Gleichzeitige Schreibvorgänge laufen über `LockService` wie bisher.

**Fehlerfall Kalender:** Antwortet Google mit einem Fehler oder einer Zeitüberschreitung, kommt `{ ok: false, error: "Google Kalender hat gerade nicht geantwortet. Bitte gleich nochmal versuchen." }`. Die App zeigt das als Toast.

---

## 5. Sheet als Backup (gleiche Datei wie bisher)

### 5.1 Nächtliches Backup
- Zeitgesteuerter Trigger täglich gegen **03:00 Uhr** (`backupToSheet`).
- Blatt **`DataSheet`**: Zeile 1 ist der Hinweis `Backup vom 09.11.2026, 03:00 – Änderungen hier haben keine Wirkung. Termine bitte in der App bearbeiten.` Ab Zeile 2 folgen Kopfzeile und alle Termine, in den bekannten Spalten (Subject, Start Date, Start Time, End Date, End Time, All Day Event, Description, Location, Category, Status, Verschoben auf, Recurrence, EventId, Letzte Änderung) plus `Folgetermin-ID`. Die Spalte `LastSyncHash` entfällt.
- Blatt **`Categories`**: aktuelle Kategorien (Name, ColorId, Farbname).
  *Umsetzung:* Spaltenköpfe bleiben `Category · ColorId · Farbe` wie bisher, damit der Rückweg (`setDataSourceSheet`) das Blatt weiter lesen kann. Der Rückweg schreibt `DataSheet` vorher aus dem Kalender im alten Aufbau neu (Kopfzeile in Zeile 1).
- **Keine** Zugangscodes im Sheet.
- Ältere Stände über „Datei → Versionsverlauf“, keine eigenen Kopien.

### 5.2 Schutz
- `DataSheet`, `Categories` und `Gelöscht` werden geschützt, sodass nur Lars bzw. das Script schreiben darf (`Protection`, Bearbeiter = Eigentümer).
- Die bisherigen Menüpunkte für Sync, Import und Bereinigen werden entfernt oder ausgeblendet. Die Funktionen für Zugangscodes bleiben als Notfallweg.

### 5.3 Blatt `Gelöscht`
- Jeder Löschvorgang (Kap. 4, LÖSCHEN) hängt **vor** dem Löschen eine Zeile an: alle Spalten wie im Backup plus `Gelöscht am` und `Gelöscht von`.
- Damit ist auch ein Termin wiederherstellbar, der nach dem letzten nächtlichen Backup angelegt und gelöscht wurde.

### 5.4 Menü „Termin wiederherstellen“
- Menüpunkt im Sheet: **Dienstplan → Termin aus Backup wiederherstellen…**
- Lars markiert eine Zeile in `Gelöscht` oder `DataSheet` und ruft den Menüpunkt auf.
- Das Script prüft, ob die EventId noch im Kalender existiert. Wenn ja, meldet es „Dieser Termin ist noch im Kalender.“ und tut nichts. Wenn nein, legt es den Termin mit allen Zusatzfeldern neu an. Die neue EventId wird in der Zeile vermerkt.

---

## 6. Umstellung (einmalig)

Funktion **`migrateToCalendarV3()`** im Apps-Script-Editor, mit Probelauf `migrateToCalendarV3(true)` (nur Protokoll, keine Änderung):

1. Kategorien aus Blatt `Categories` → Script-Eigenschaft `KATEGORIEN_V3`
2. Für jede Sheet-Zeile mit EventId und Status ≠ GELÖSCHT: Termin im Kalender holen, Zusatzfelder (Kap. 2.2) aus der Zeile setzen, Titel und Beschreibung neu bauen, **Marker entfernen**.
3. Folgetermin-Verknüpfungen (`Folgetermin-ID`) in `movedTo`/`movedFrom` übertragen.
4. Zeilen ohne EventId oder mit fehlendem Termin im Kalender → im Protokoll auflisten, **nichts automatisch anlegen**.
5. Protokoll: Anzahl umgestellt, übersprungen, Fehler.
6. Bricht nach 5 Minuten sauber ab und lässt sich erneut starten. Schon umgestellte Termine (`dp = 3`) werden übersprungen.

**Umschalten und Rückweg:** Script-Eigenschaft `DATENQUELLE` = `sheet` (bisheriges Verhalten) oder `calendar` (V3). Erst nach erfolgreicher Umstellung auf `calendar` setzen. Gibt es Probleme, wieder auf `sheet` zurückstellen. Bis zur Freigabe bleibt deshalb der alte Sheet-Weg im Code erhalten. Der 15-Minuten-Trigger wird beim Umschalten auf `calendar` entfernt, beim Zurückschalten wieder angelegt.

---

## 7. App-Änderungen (V3)

### 7.1 Etappe 1 (minimal)
- Termine nur noch über `eventId` ansprechen (`ref = { eventId }`). `row` und der Ersatzschlüssel `'r' + row` entfallen.
- „Alle Termine jetzt synchronisieren“ in Weitere Aktionen entfernen.
- Kopfzeile: „Im Kalender · Stand 08:31“ bleibt (Zeitpunkt des letzten Ladens).

### 7.2 Tabellenansicht (Admin und Schreiben, ab ca. 768 px Breite)
- Dritter Eintrag im Umschalter: **Liste | Woche | Tabelle**. Auf schmalen Handys wird „Tabelle“ ausgeblendet.
- Spalten: ☐ · Datum · Beginn · Ende · Titel · Ort · Kategorie · Status · Letzte Änderung.
- **Direkt bearbeiten:** Klick in Titel, Ort, Datum, Zeit oder Kategorie macht die Zelle zum Eingabefeld. Enter oder Verlassen speichert über `saveEvent`, Esc bricht ab. Während des Speicherns zeigt die Zeile einen Kreisel, bei Fehler die alte Zelle mit Fehlerhinweis.
- **Mehrfachauswahl** über Kontrollkästchen oder Shift+Klick. Danach Aktionsleiste: „Absagen (n)“, „Wieder aktivieren (n)“, „Kategorie setzen…“, „Löschen (n)“ (nur Admin, mit Bestätigung). Über `setStatusBulk`/`saveEvents`.
- Sortieren nach Spalte, Filter nach Kategorie/Status, Suche wie in der Liste.
- Tastatur: Pfeiltasten wechseln die Zelle, Enter bearbeitet.
- Serientermine sind markiert. Datum und Zeit einer Serie sind in der Tabelle nicht bearbeitbar, sondern öffnen das normale Formular.
- *Umsetzung (`table.js`):* zusätzlicher Filter **Zeitraum** „Ab heute“ (Standard; laufende Serien immer dabei) / „Alle“. Beginn ändern verschiebt das Ende mit (Dauer bleibt). Zeiten ganztägiger Termine öffnen das Formular. Klick auf Status oder „Letzte Änderung“ öffnet die Details. Löschen mehrerer Termine läuft nacheinander über `setStatus` LÖSCHEN (jeder landet im Blatt `Gelöscht`). Die Tabelle scrollt in sich, die Kopfzeile bleibt stehen. Unter 768 px oder bei Rolle Lesen springt die App zur Liste.
- *Ergänzung nach dem Test:* Spalte **Serie** (z. B. „jede Woche“, „bis 30.06.2027“); Klick öffnet das Formular bei „Wiederholung“. Im Formular **Wiederholung**: Keine · Jede Woche · Alle 2 Wochen · Jeden Monat am n. Wochentag · Jeden Monat am Tag · Jedes Jahr, dazu optional **Letzter Termin** (UNTIL). Regeln, die im Google Kalender anders eingestellt wurden, bleiben unverändert („Eigene Regel“). `saveEvent`/`saveEvents` nehmen `recurrence` (RRULE) an; fehlt das Feld, bleibt die Wiederholung, `''` entfernt sie. Ausnahmen (EXDATE) aus Google bleiben erhalten.
- **Letzte Änderung** ist immer gefüllt: Stempel aus der App („09.11.2026 10:40 · Lars“); fehlt er oder wurde der Termin danach direkt in Google geändert, die Zeit von Google mit „· direkt im Kalender“ (Zusatzfeld `sync` = Zeitpunkt des letzten Script-Schreibens).

### 7.3 Import (Admin)
- Neuer Punkt unter **Weitere Aktionen → Verwaltung → Termine importieren**.
- Dateien: **.xlsx, .xls, .csv, .ics**. Gelesen wird im Browser: SheetJS (`xlsx.full.min.js`, lokal im Repo unter `vendor/`, erst beim Öffnen des Imports nachgeladen) bzw. ein eigener kleiner ICS-Parser.
- **Schritt 1: Datei wählen.** Bei Excel mit mehreren Blättern: Blatt wählen.
- **Schritt 2: Spalten zuordnen.** Pflicht: Titel, Datum. Optional: Beginn, Ende, ganztägig, Ort, Beschreibung, Kategorie. Spalten mit üblichen Namen (Subject/Betreff/Titel, Start Date/Datum …) werden automatisch zugeordnet. Die Zuordnung wird in `localStorage` gemerkt.
- **Schritt 3: Vorschau** als Tabelle, je Zeile mit einer Markierung:
  - ✓ neu
  - ⚠ möglicherweise doppelt (gleiches Datum + gleicher Beginn + Titel sehr ähnlich zu bestehendem Termin), standardmäßig abgewählt
  - ✗ fehlerhaft (z. B. kein Datum), nicht wählbar, mit Grund
  
  Unbekannte Kategorien zeigt die Vorschau an. Pro Kategorie lässt sich wählen: „neu anlegen“ (Farbe wählen) oder „ohne Kategorie“.
- **Schritt 4: Importieren** in Paketen zu 50 über `saveEvents`, mit Fortschrittsbalken. Am Ende eine Zusammenfassung „32 angelegt, 3 übersprungen, 1 Fehler“ mit Liste der Fehler.
- Datumsformate: `TT.MM.JJJJ`, `JJJJ-MM-TT`, Excel-Seriennummern. Zeiten `HH:MM` oder Excel-Bruchteile. Fehlt die Endzeit: +60 Minuten (`DEFAULT_DURATION_MIN`).
- Das Format aus dem bisherigen Excel-Import (Subject, Start Date, Start Time, End Date, End Time, All Day Event, Recurrence, Description, Location) muss ohne Zuordnung funktionieren.

---

## 8. Code im Repo und Bereitstellung (`clasp`)
- `apps-script/` wird ein clasp-Projekt: `.clasp.json` (mit `scriptId` des bestehenden, an das Sheet gebundenen Projekts, `rootDir: "apps-script"`) und `appsscript.json` (Zeitzone Europe/Berlin, Advanced Service Calendar v3, Web-App-Einstellungen wie bisher).
- GitHub Action `.github/workflows/apps-script.yml`: Bei Push auf `main` mit Änderungen unter `apps-script/` → `clasp push` und `clasp deploy --deploymentId <bestehende ID>`. Die `/exec`-Adresse bleibt gleich.
- Secrets in GitHub: `CLASPRC_JSON` (Inhalt von `~/.clasprc.json` nach einmaligem `clasp login` auf Lars' Rechner) und `DEPLOYMENT_ID`. **Nicht ins Repo.**
- Bis das eingerichtet ist, bleibt der Weg wie bisher: Code im Editor einfügen → Bereitstellungen verwalten → neue Version.

---

## 9. Etappen

| # | Inhalt | Ergebnis |
|---|---|---|
| 1 | Datenschicht Kalender (Kap. 2–4), Umstellung mit Schalter `DATENQUELLE` (Kap. 6), App auf `eventId` (7.1) | App arbeitet direkt mit dem Kalender |
| 2 | Backup ins Sheet, Schutz, Blatt `Gelöscht`, Wiederherstellen (Kap. 5) | Rückfallebene steht |
| 3 | Aufräumen: alten Sheet-Weg, 15-Min-Sync, Marker-Logik und `LastSyncHash` entfernen; Schalter `DATENQUELLE` entfällt | schlanker Code, frühestens 2 Wochen nach Etappe 1 |
| 4 | Tabellenansicht (7.2) | Bearbeiten in der Liste |
| 5 | Import (7.3) | Excel/CSV/ICS direkt in den Kalender |
| 6 | clasp + GitHub Action (Kap. 8), optional | Backend-Code wird automatisch bereitgestellt |

---

## 10. Offene Punkte
1. Tabellenansicht und Import vorher als Entwurf auf dem Design-Canvas abstimmen?
2. Zeitraum der vergangenen Termine in `getData`: reicht „ab 1. Januar des Vorjahres“?
3. Sollen Lesende die Tabellenansicht auch sehen dürfen (ohne Bearbeiten)?
