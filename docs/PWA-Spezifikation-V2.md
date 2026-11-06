# 🚒 Dienstplan-PWA – Spezifikation Version 2 (Ergänzung)

> **Stand:** 06.11.2026 · ergänzt `docs/PWA-Spezifikation.md` (Version 1).
> Alles, was hier nicht geändert wird, gilt weiter wie in Version 1 beschrieben.
> **Design-Vorlage:** Canvas „Dienstplan – neues Design“ (Claude Design). Die Artboards liegen als Referenz-Markup unter `docs/design/` (`*.dc.html`, `*-Dunkel.dc.html` = dunkle Variante).

---

## Inhalt

1. [Was sich ändert (Überblick)](#1-was-sich-ändert-überblick)
2. [Rollen & Rechte](#2-rollen--rechte)
3. [Zugangscodes](#3-zugangscodes)
4. [Kategorien – App, Sheet, Kalender](#4-kategorien--app-sheet-kalender)
5. [Schnittstelle (API) – neu und geändert](#5-schnittstelle-api--neu-und-geändert)
6. [Darstellung: Hell, Dunkel, Systemeinstellung](#6-darstellung-hell-dunkel-systemeinstellung)
7. [Design-Tokens Version 2](#7-design-tokens-version-2)
8. [Screens Version 2](#8-screens-version-2)
9. [Testversion unter `beta/`](#9-testversion-unter-beta)
10. [Etappen](#10-etappen)
11. [Offene Punkte](#11-offene-punkte)

---

## 1. Was sich ändert (Überblick)

| Bereich | Version 1 | Version 2 |
|---|---|---|
| Rechte | jeder Code darf alles | drei Rollen: **Admin · Schreiben · Lesen** |
| Mannschaft | sieht nur den Google Kalender | kann zusätzlich die App mit einem **gemeinsamen Lese-Code** nutzen |
| Zugangscodes | nur im Sheet-Menü | Verwaltung **in der App** (nur Admin) |
| Kategorien | im Sheet gepflegt, in der App nur neutrales Badge | **in der App verwaltet**, gespeichert im Sheet, Farbe in App und Kalender |
| Kategorie im Kalender | nur Terminfarbe | Terminfarbe **und** erste Zeile der Beschreibung |
| Darstellung | folgt dem System | Umschalter **Hell / Dunkel / Systemeinstellung** |
| Dunkelmodus | Grau mit Feuerwehrrot | **Nachtblau mit Signalgelb** |
| Ansichten | nur Liste | **Liste + Wochenansicht** |
| Icons | Emojis | Inline-SVG (Strichicons) |

Die Leitidee bleibt: **Das Google Sheet ist der Master.**

---

## 2. Rollen & Rechte

| Aktion | Lesen | Schreiben | Admin |
|---|:-:|:-:|:-:|
| Liste, Woche, Details ansehen | ✓ | ✓ | ✓ |
| Termin anlegen, bearbeiten | | ✓ | ✓ |
| Absagen, verschieben, wieder aktivieren | | ✓ | ✓ |
| **Löschen** | | | ✓ |
| Kategorien verwalten | | | ✓ |
| Zugangscodes verwalten | | | ✓ |
| Kompletter Sync | | | ✓ |
| Darstellung umschalten | ✓ | ✓ | ✓ |

**Regeln**
- Die Rolle hängt am Zugangscode.
- **Der Server prüft die Rolle bei jeder Anfrage.** Die App blendet nur zusätzlich aus, was nicht erlaubt ist. Grund: Die Schnittstelle ist öffentlich erreichbar.
- Unerlaubte Aktion → Antwort `{ "ok": false, "error": "Dafür fehlen dir die Rechte.", "forbidden": true }`. Die App meldet dann **nicht** ab, sondern zeigt den Fehler als Toast.
- **Umstellung bestehender Codes:** Alle vorhandenen Codes bekommen „Schreiben“. Lars' Code wird „Admin“, und zwar einmalig im Sheet-Menü oder per Script.

**Was die App je Rolle zeigt**

| Element | Lesen | Schreiben | Admin |
|---|---|---|---|
| FAB „+ Termin“ | ausgeblendet | sichtbar | sichtbar |
| Detail-Sheet | nur Infos + [Schließen] + Hinweis „Du kannst Termine ansehen …“ | Absagen, Verschieben, Bearbeiten | wie Schreiben + [Löschen] |
| Wischgesten | aus | an | an |
| „Weitere Aktionen“ | Name, Darstellung, Abmelden | wie Lesen | + Bereich **Verwaltung** (Kategorien, Zugangscodes) + kompletter Sync |
| Rolle neben dem Namen | – | – | Kennzeichen „ADMIN“ |

---

## 3. Zugangscodes

### 3.1 Datenmodell (Script-Eigenschaften)

Ein Eintrag pro Code:

| Feld | Beispiel | Bedeutung |
|---|---|---|
| `id` | `c_8f3a…` | interne ID |
| `name` | `Gruppenführer 1` | erscheint bei „Letzte Änderung“ |
| `role` | `admin` · `write` · `read` | Rolle |
| `team` | `true` | **Mannschafts-Code** (gemeinsam, Rolle immer `read`), höchstens einer |
| `hash` | SHA-256 des normalisierten Codes | der Code selbst wird **nicht** gespeichert |
| `hint` | `K7QM…H2XP` | erste und letzte 4 Zeichen, nur zur Anzeige |
| `blocked` | `false` / Datum | gesperrt seit |
| `created`, `lastUsed` | ISO-Zeit | Anzeige „zuletzt genutzt …“ |

- Codeformat bleibt wie in V1: 20 Zeichen aus 31 eindeutig lesbaren Zeichen, angezeigt als `XXXX-XXXX-XXXX-XXXX-XXXX`.
- Weil nur der Hash gespeichert wird, ist der **vollständige Code nur direkt nach dem Erstellen sichtbar**. Gleich danach zeigt die App den Anmelde-Link zum Teilen an.
- `lastUsed` höchstens einmal pro Stunde schreiben, damit nicht jede Anfrage die Script-Eigenschaften anfasst.
- Das Sheet-Menü „🔑 Zugangscode erstellen…“ bleibt als Notfallweg erhalten und bekommt die Rollenauswahl.
- **Sheet-Menü „🔑 Zugangscodes verwalten…“** (umgesetzt in Etappe 1): Übersicht aller Codes mit Name, Rolle, Status, Code-Hinweis, erstellt und zuletzt genutzt. Dort lassen sich Rollen ändern, Codes sperren und entsperren sowie **gesperrte Codes löschen**. Löschen geht nur bei gesperrten Codes, der letzte aktive Admin kann weder gesperrt noch herabgestuft werden. Den vollständigen Code zeigt auch diese Übersicht nicht, weil er nicht gespeichert ist.

### 3.2 Mannschafts-Code
- Ein gemeinsamer, nicht personalisierter Code mit Rolle `read`.
- **Neu erzeugen** macht den alten Code sofort ungültig und liefert einen neuen Code samt Link. Das ist nötig, wenn der Code in falsche Hände geraten ist. Danach muss der neue Link an alle verteilt werden.
- Sperren einzelner Personen ist beim Mannschafts-Code nicht möglich. Das ist bewusst so gewählt: Leserechte können nichts verändern.

---

## 4. Kategorien – App, Sheet, Kalender

### 4.1 Speicherort
Die Kategorien stehen weiterhin im Blatt **`Categories`** mit den Spalten `Category` und `ColorId`. Die App liest und schreibt nur über die Schnittstelle, und nur Admins dürfen ändern.

### 4.2 Farben
Erlaubt sind die Google-Kalender-Terminfarben. **Mandarine (6) und Graphit (8) sind reserviert** für „Verschoben“ und „Abgesagt“ und lassen sich nicht auswählen.

| ColorId | Name | Hex (Hell) | Hex (Dunkel) |
|---|---|---|---|
| 1 | Lavendel | `#7986cb` | `#7986cb` |
| 2 | Salbei | `#33b679` | `#33b679` |
| 3 | Weintraube | `#8e24aa` | `#8e24aa` |
| 4 | Flamingo | `#e67c73` | `#e67c73` |
| 5 | Banane | `#f6bf26` | `#f6bf26` |
| 6 | Mandarine | `#f4511e` | – reserviert – |
| 7 | Pfau | `#039be5` | `#039be5` |
| 8 | Graphit | `#616161` | – reserviert – |
| 9 | Heidelbeere | `#3f51b5` | `#7986cb`* |
| 10 | Basilikum | `#0b8043` | `#33b679`* |
| 11 | Tomate | `#d50000` | `#ff5a4f`* |

\* Im Dunkelmodus werden die Farbpunkte in Liste und Woche aufgehellt, damit sie auf Nachtblau erkennbar bleiben. In der Farbauswahl (Kategorie bearbeiten) stehen immer die echten Google-Farben.

### 4.3 Wo die Kategorie im Kalender erscheint
1. **Terminfarbe** = `ColorId` der Kategorie, wie bisher. Die Farbe sieht nur, wer den Kalender in Google Kalender selbst nutzt. **Apple Kalender und iCal-Abos zeigen keine Terminfarben.**
2. **Erste Zeile der Beschreibung:** `Kategorie: Übung`, danach eine Leerzeile und die eigentliche Beschreibung. Das ist in jeder Kalender-App sichtbar.
   - Der Sync-Script setzt die Zeile, ersetzt sie bei Änderungen und entfernt sie, wenn ein Termin keine Kategorie hat.
   - Im Sheet steht die Zeile **nicht** in der Spalte `Description`. Sie entsteht erst beim Schreiben in den Kalender.
   - Die Status-Hinweise aus V1 (abgesagt/verschoben) kommen **nach** der Kategorie-Zeile.
3. Der **Titel bleibt ohne Kategorie**, weil dort schon die Status-Präfixe stehen.

### 4.4 Ändern, Umbenennen, Löschen
- **Farbe ändern:** Die neue `ColorId` wird im Blatt `Categories` gespeichert. Alle Termine mit dieser Kategorie müssen danach im Kalender neu eingefärbt werden, siehe 4.5.
- **Umbenennen:** Der Server ändert den Namen in `Categories` **und in allen Zeilen von `DataSheet`**. Danach müssen die betroffenen Termine neu in den Kalender, wegen der Beschreibungszeile.
- **Löschen:** Das geht nur, wenn kein Termin (Status ≠ GELÖSCHT) die Kategorie nutzt. Sonst kommt die Fehlermeldung „Wird von 12 Terminen genutzt – erst die Termine umstellen.“
- **Neu anlegen:** Name ist Pflicht, eindeutig (Groß-/Kleinschreibung egal) und höchstens 40 Zeichen lang. Die Farbe ist Pflicht.

### 4.5 Kalender nachziehen
- `LastSyncHash` muss **Kategorie und ColorId** enthalten. Dann erkennt der normale Sync jede Änderung von selbst.
- Damit Admins nicht bis zu 15 Minuten warten müssen, plant `saveCategory` nach dem Speichern einen einmaligen Sync in etwa einer Minute ein (`ScriptApp.newTrigger(...).timeBased().after(60 * 1000)`). Eine Speichern-Anfrage darf nicht 300 Termine selbst aktualisieren, weil Apps Script nach 6 Minuten abbricht.
- Die App zeigt nach dem Speichern: „Gespeichert. Der Kalender wird in den nächsten Minuten aktualisiert.“

---

## 5. Schnittstelle (API) – neu und geändert

Anfrageformat wie V1: `POST`, `text/plain`, `{ action, code, data }`.

### 5.1 Geändert

| `action` | Änderung |
|---|---|
| alle | Antwort enthält zusätzlich `role` (`admin`·`write`·`read`) und `userName` |
| `getData` | zusätzlich `categoryList: [{ "name": "Übung", "colorId": 11, "count": 38 }]` (`count` = Termine mit Status ≠ GELÖSCHT). `categories` (Liste von Texten) bleibt für die alte App bis Etappe 6 unverändert |
| `saveEvent` | nur `write`/`admin` |
| `setStatus` | `ABGESAGT`, `VERSCHOBEN`, `AKTIV` nur `write`/`admin`; **`LÖSCHEN` nur `admin`** |
| `syncAll` | nur `admin` |

### 5.2 Neu (alle nur `admin`)

| `action` | `data` | Wirkung / Antwort |
|---|---|---|
| `saveCategory` | `{ oldName?, name, colorId }` | ohne `oldName`: neu anlegen; mit: ändern bzw. umbenennen (siehe 4.4). Antwort wie `getData` + `message` |
| `deleteCategory` | `{ name }` | löschen, wenn `count = 0` |
| `listCodes` | – | `{ codes: [{ id, name, role, team, hint, blocked, created, lastUsed }] }` |
| `createCode` | `{ name, role }` | `{ code, link }`, beides **nur in dieser Antwort** |
| `updateCode` | `{ id, name?, role?, blocked? }` | ändern, sperren, entsperren. Den eigenen Code kann man weder sperren noch herabstufen. Der letzte Admin bleibt immer Admin. |
| `rotateTeamCode` | – | neuer Mannschafts-Code, alter sofort ungültig → `{ code, link }`. Gibt es noch keinen, wird einer angelegt. |

### 5.3 Fehler

| Fall | Antwort |
|---|---|
| Code ungültig/gesperrt | wie V1: `auth: true` → App meldet ab |
| Rolle reicht nicht | `forbidden: true` → Toast, **kein** Abmelden |
| Validierung | `ok: false` + verständliche `error`, z. B. „Diese Kategorie gibt es schon.“ |

---

## 6. Darstellung: Hell, Dunkel, Systemeinstellung

- Die Einstellung steht in „Weitere Aktionen“ unter **Darstellung**: Hell · Dunkel · Systemeinstellung („Folgt dem Handy“).
- Gespeichert wird in `localStorage` als `dienstplan.theme` = `light` · `dark` · `system`. **Standard: `system`.**
- Die Wahl gilt nur auf diesem Gerät. Das steht als Hinweis im Sheet.
- Umsetzung: `data-theme="light|dark"` am `<html>`. Bei `system` entscheidet `prefers-color-scheme`, mit Listener für Wechsel zur Laufzeit. Das Meta-Tag `theme-color` wird passend gesetzt.
- Das Theme wird **vor dem ersten Rendern** gesetzt (kleines Inline-Script im `<head>`), damit nichts kurz hell aufblitzt.

---

## 7. Design-Tokens Version 2

Schrift im Entwurf: **Inter** (400/500/600/700). Für die App gibt es zwei Möglichkeiten: Inter als `woff2` mitliefern (offline!) oder bei der Systemschrift bleiben. Größen, Abstände und Radien bleiben wie in V1 (Kapitel 8.2–8.3).

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--bg` | `#f4f3f0` | `#0b1530` | Seitenhintergrund (Dunkel: Nachtblau) |
| `--surface` | `#ffffff` | `#141f40` | Karten, Sheets |
| `--surface-2` | `#f6f6f4` | `#1a2650` | Felder, Standard-Buttons |
| `--chip` | `#f1f0ec` | `#1d2a55` | Badges, Info-Kästen |
| `--segment` | `#e9e8e3` | `#18234a` | Segment-Umschalter |
| `--text` | `#1b1b1b` | `#eef1f8` | Haupttext |
| `--text-2` | `#4a4a4a` | `#c3cbe0` | Überschriften Abschnitte, Labels |
| `--muted` | `#5f5f5f` | `#a7b2cf` | Nebentext |
| `--line` | `#e4e2dd` | `#263463` | Rahmen, Trenner |
| `--accent` | `#c62828` | `#e8ff2b` | Feuerwehrrot / **Signalgelb**: Primär, Heute, Fokus |
| `--accent-ink` | `#ffffff` | `#0b1530` | Text auf Akzent (Dunkel: **dunkle Schrift auf Gelb**) |
| `--accent-soft` | `#fdecec` | `#2c3414` | Datumskachel aktiv, Auswahl |
| `--accent-text` | `#b71c1c` | `#e8ff2b` | Akzent als Textfarbe |
| `--warn` | `#9a4300` | `#ffaa5c` | Verschoben (Text) |
| `--warn-bg` | `#fff1df` | `#3a2a14` | Verschoben (Fläche) |
| `--warn-solid` | `#a74a00` | `#ff9a3c` | Verschieben-Button (Dunkel mit dunkler Schrift) |
| `--off` | `#616161` | `#9aa5c4` | Abgesagt (Text) |
| `--off-bg` | `#ececea` | `#1b2547` | Abgesagt (Fläche) |
| `--danger` | `#b3261e` | `#ff7b72` | Löschen |
| `--ok` | `#2e7d32` | `#5fd38a` | „Im Kalender“-Häkchen |
| `--toast` | `#232323` | `#233166` | Toast-Hintergrund |
| `--offline-bg` / `--offline-ink` | `#fff6d6` / `#5c4a00` | `#2f2c0e` / `#f2e58a` | Offline-Streifen |
| `--role-write-bg` / `-ink` | `#e3f2fd` / `#0d47a1` | `#16305e` / `#9cc4ff` | Rollen-Badge „Schreiben“ |

**Status auf einen Blick (Datumskachel)**

| Status | Hell | Dunkel |
|---|---|---|
| Aktiv | `--accent-soft` + `--accent-text` | Gelb gedämpft + Gelb |
| **Heute** | volle Akzentfläche, Karte mit Akzentrahmen | volles Gelb, dunkle Schrift |
| Verschoben | `--warn-bg` + `--warn` | Braun + Orange |
| Abgesagt | `--off-bg` + `--off`, Titel durchgestrichen | entsprechend |

Status nie nur über Farbe zeigen: Es gibt immer zusätzlich Badge-Text bzw. Durchstreichung, wie in V1.

**Icons:** Inline-SVG mit 2 px Strich, `stroke="currentColor"`, `aria-hidden="true"` an dekorativen Icons und `aria-label` an Icon-Buttons. Gebraucht werden: Kalender, Neu laden, Mehr, Suche, Ort, Notiz, Serie, Pfeil rechts, Kreuz, Haken, Plus, Stift, Verbot (Absagen), Chevron links/rechts/oben, Sonne, Mond, Handy, Info, Schlüssel, Teilen, Auge, WLAN-aus.

---

## 8. Screens Version 2

Die Artboards in `docs/design/` sind die Vorlage. Hier stehen nur die Abweichungen von V1.

### 8.1 Terminliste (`Main`)
- In der Kopfzeile steht unter dem App-Titel der Sync-Stand mit Häkchen: „Im Kalender · Stand 08:31“.
- Der Umschalter heißt jetzt **Liste | Woche** und hat daneben einen Knopf **Heute**, der zum heutigen Tag springt.
- „Vergangene Termine“ ist ein Textknopf ganz oben in der Liste. Er ersetzt den Reiter „Vergangen“.
- Gruppen: **HEUTE** (rotes bzw. gelbes Etikett + Datum), **DIESE WOCHE**, **SPÄTER IM NOVEMBER**, danach Monate.
- Die Karte von heute hat einen Akzentrahmen und eine volle Akzent-Datumskachel.
- Kategorie-Badge mit Farbpunkt, Serie-Badge mit Icon, Verschoben-Badge „Verschoben auf Di 17.11.“ und beim Folgetermin „vom 10.11. verschoben“.

### 8.2 Wochenansicht (`Woche`) – neu
- Kopfzeile wie die Liste, Umschalter auf „Woche“.
- Wochennavigation mit ‹ und ›, Mitte „9.–15. November“ und darunter „KW 46 · nächste Woche“ bzw. „diese Woche“.
- Tagesstreifen Mo–So: Wochentag, Tageszahl, bis zu 3 Punkte in Kategorie- bzw. Statusfarbe. Der gewählte Tag ist mit Akzent gefüllt.
- Darunter alle 7 Tage untereinander. Freie Tage zeigen „Kein Termin“, Termine kompakt mit „Zeit · Ort“, Titel und Status-Optik. Tippen öffnet die Details.
- Startet auf der Woche mit heute. „Heute“ springt zurück.

### 8.3 Details (`Details`, `DetailsLesen`)
- Oben Status-Badge (z. B. „● Aktiv“) und Kategorie, dann Titel (22 px) und ein Schließen-Knopf.
- **Schreiben/Admin:** große Kacheln **Absagen** und **Verschieben** nebeneinander (72 px hoch), darunter **Bearbeiten** (primär), unten „Letzte Änderung …“ und [Löschen] als Textknopf, nur für Admin.
- **Lesen:** Hinweis „Du kannst Termine ansehen. Änderungen macht, wer den Dienstplan pflegt.“, [Schließen] und „Letzte Änderung …“.
- Für ABGESAGT/VERSCHOBEN gelten die Aktionen aus V1 (Wieder aktivieren primär) im neuen Look.

### 8.4 Verschieben
- **Schnell wählen** mit drei Kacheln: **+1 Woche** (mit Zieldatum), **+2 Wochen**, **Anderer Tag**. Vorgewählt ist +1 Woche.
- Felder: neues Datum und Uhrzeit, vorbelegt nach der Schnellwahl.
- **Vorschau:** „Alter Termin bleibt sichtbar – als ‚Verschoben auf 13.11.‘“ und „Neuer Termin wird angelegt – 19:30–21:30 Uhr · Ort“.
- Hauptknopf mit Zieldatum: „Auf Fr 13.11. verschieben“.

### 8.5 Neuer Termin / Bearbeiten
- **Vorlagen** als Chips: Übungsdienst · Gruppendienst · Besprechung · Leer. Sie füllen Titel-Anfang, Uhrzeit, Ort und Kategorie vor. Vorerst sind sie fest in `config.js` hinterlegt, siehe Offene Punkte.
- „Ganztägig“ als Schalter.
- **Kategorie als Farb-Chips** statt Auswahlliste.
- [Abbrechen] und [Anlegen] fest am unteren Rand.

### 8.6 Wischen & Rückgängig
- Karte nach links wischen = **Absagen**, nach rechts = **Verschieben**. Verschieben öffnet den Dialog, Absagen läuft ohne Rückfrage.
- Danach erscheint der Toast „Termin abgesagt.“ mit **[Rückgängig]** für 6 s. Rückgängig ruft `setStatus AKTIV` auf.
- Während des Speicherns zeigt die Karte „Wird abgesagt…“ mit Kreisel und ist leicht ausgegraut. Die Kopfzeile zeigt „Wird gespeichert…“.
- Offline-Streifen: „Offline – du siehst den Stand von 08:31. Änderungen gehen erst wieder mit Verbindung.“
- Nur für Schreiben/Admin.

### 8.7 Weitere Aktionen
- Avatar mit Initiale, „Angemeldet als **Lars**“ und bei Admins das Kennzeichen „ADMIN“.
- **Darstellung** mit drei Radiozeilen: Hell · Dunkel · Systemeinstellung, siehe Kapitel 6.
- **Verwaltung** (nur Admin): Kategorien (Anzahl) ›, Zugangscodes (Anzahl) ›.
- [Alle Termine jetzt synchronisieren] mit Erklärung (nur Admin), unten [Abmelden].

### 8.8 Kategorien / Kategorie bearbeiten
- Eigene Seite mit Zurück-Knopf. Liste mit Farbkreis, Name, „Farbname · 38 Termine“ bzw. „nicht genutzt“.
- [Kategorie hinzufügen] als gestrichelter Knopf. Ein Info-Kasten erklärt Farbe und Beschreibungszeile.
- Bearbeiten-Sheet:
  - Feld Name.
  - Farbraster mit 6 Spalten, die Auswahl hat einen Ring und ein Häkchen. Mandarine und Graphit sind gestrichelt und gesperrt, mit Hinweis.
  - Info, wie viele Termine betroffen sind, und dass der Kalender nachgezogen wird.
  - [Abbrechen] und [Speichern].
  - [Löschen] ist deaktiviert, solange die Kategorie genutzt wird.

### 8.9 Zugangscodes / Neuer Zugangscode
- Oben die Karte **Mannschaft**: Badge „Lesen“, Code-Hinweis `K7QM-····-····-····-H2XP`, „Gemeinsamer Code · zuletzt genutzt heute“, [Link teilen] und [Neu erzeugen] (mit Bestätigung: „Der alte Code funktioniert danach nicht mehr.“).
- **Persönliche Codes:** Name, „zuletzt genutzt …“ und Rollen-Badge (Admin dunkel, Schreiben blau, Gesperrt grau mit durchgestrichenem Namen). Tippen öffnet Rolle ändern / Sperren.
- FAB „+ Code“ öffnet das Sheet: Feld „Für wen?“ (Hinweis: erscheint bei „Letzte Änderung“), Rolle mit Erklärung je Option, Hinweis „Der Code wird nur einmal vollständig angezeigt.“, [Code erstellen].
- Nach dem Erstellen: Code groß in Monospace, [Link teilen] über das Teilen-Menü des Systems (`navigator.share`, sonst Kopieren) und [Fertig].

### 8.10 Anmeldung
Bleibt wie im Entwurf (rote Vollfläche) und unabhängig vom Theme.

---

## 9. Testversion unter `beta/`

- Die neue Oberfläche entsteht in **`beta/`** im selben Repository und läuft unter `lars-menke.github.io/dienstplan/beta/`.
- Schnittstelle, Sheet und Kalender sind dieselben wie live, der Test läuft also **mit echten Daten**.
- `beta/` bekommt einen **eigenen Service Worker** (`beta/sw.js`, Cache-Name `dienstplan-beta-v1`, Scope `./`). Der spezifischere Scope gewinnt gegenüber dem Live-Service-Worker.
- `beta/manifest.webmanifest` mit Name „Dienstplan Beta“, damit man beide nebeneinander auf dem Homescreen unterscheiden kann.
- `localStorage` ist geteilt, weil beide unter derselben Domain laufen. Der Zugangscode gilt also für beide Versionen, und das ist gewollt.
- **Die Live-App bleibt unverändert** bis zur Freigabe. Backend-Änderungen müssen deshalb **abwärtskompatibel** sein: Die alte App darf durch `role`, das neue `categories`-Format usw. nicht kaputtgehen. Siehe Etappe 1.

---

## 10. Etappen

| # | Inhalt | Backend | Ergebnis testbar in |
|---|---|---|---|
| 1 | Rollen und Code-Modell (Migration), `role` in Antworten, Rechteprüfung, `categories` mit `colorId`/`count`, Kategorie-Zeile in der Kalenderbeschreibung, `LastSyncHash` erweitern | ✓ | Live-App (Löschen nur noch für Admin) + Kalender |
| 2 | Neue Oberfläche in `beta/`: Tokens Hell/Dunkel, Theme-Umschalter, SVG-Icons, Liste, Details (rollenabhängig), Verschieben mit Schnellwahl, Formular mit Kategorie-Chips, Weitere Aktionen, Zustände | – | `beta/` |
| 3 | Verwaltung in der App: Kategorien + Zugangscodes, neue API-Aktionen | ✓ | `beta/` |
| 4 | Wochenansicht, Vorlagen | – | `beta/` |
| 5 | Wischgesten + Rückgängig, Sheets per Zurück-Taste/Wischgeste schließen (History API), Pull-to-Refresh | – | `beta/` |
| 6 | Freigabe: `beta/` ersetzt die Live-Oberfläche, Ordner entfernen, Live-Service-Worker-Version erhöhen | – | live |

**Abwärtskompatibilität in Etappe 1:** Die alte App erwartet `categories` als Liste von Texten. Deshalb das neue Format unter einem **neuen Schlüssel** liefern (`categoryList`) und `categories` bis Etappe 6 unverändert lassen.

---

## 11. Offene Punkte

1. **Vorlagen:** fest in `config.js` (Etappe 4) oder später ebenfalls im Sheet und in der App verwaltbar?
2. **Schrift:** Inter mitliefern oder Systemschrift?
3. **Akzentfarbe Hell:** Feuerwehrrot bleibt, im Dunkelmodus ist es Signalgelb. Das ist bewusst so entschieden, bleibt aber für die Testphase offen.
4. **Mannschafts-Code verteilen:** Wer schickt den Link an die Mannschaft, und auf welchem Weg (z. B. die WhatsApp-Community)?
