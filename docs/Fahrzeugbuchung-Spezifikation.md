# Fahrzeugbuchung – Spezifikation (V4)

Stand: 24.11.2026 · Ergänzung zu `PWA-Spezifikation.md` (Dienstplan V3)

Die App bekommt einen zweiten Bereich **„Fahrzeuge“**: Belegung der Fahrzeuge ansehen, Fahrzeuge anfragen, Anfragen durch Admins bestätigen. Wie beim Dienstplan ist ein **Google Kalender der Master** – hier der vorhandene Kalender **„Fahrzeuge 18-2“**.

---

## 1. Ziele

1. Alle sehen auf einen Blick, welches Fahrzeug wann belegt ist.
2. Wer einen Buchungs-Code hat, fragt Fahrzeuge in der App an – strukturiert statt Freitext, mit sofortiger Prüfung auf Doppelbelegung.
3. Admins bestätigen oder lehnen Anfragen ab.
4. Später: Buchen **nur noch über die App** (Schreibrechte im Kalender entziehen).

## 2. Ausgangslage (Kalender „Fahrzeuge 18-2“, Auswertung Aug 2026 – Feb 2027)

- Ein gemeinsamer Kalender für alle Fahrzeuge, Eigentümer ist das Konto, unter dem das Backend läuft; mehrere Konten tragen direkt ein.
- Fahrzeug steht **vorne im Titel**, uneinheitlich geschrieben (`MTW - …`, `MTW Lehrgang …`, `Pritsche- …`, `JF - MTW …`), oft **mehrere Fahrzeuge** (`LF & GW-P`, `TLF / GW-P`, `LF/ GW-L & ELW`).
- Zweck und Ansprechpartner im Titel (`ASP: Name`); Beschreibung, Ort, Farbe kaum genutzt.
- Stundenweise, ganztägig und mehrtägig; viele Serien (Lehrgänge).

## 3. Fahrzeuge

**Buchbar** (feste Liste, Reihenfolge = Anzeige):

| Kürzel | Erkannte Schreibweisen im Titel |
|---|---|
| HLF | HLF |
| LF | LF |
| TLF | TLF |
| DLK | DLK, DL |
| RW | RW |
| MTW | MTW |
| ELW | ELW |
| KdoW | KdoW, KDOW, KDW |
| GW-P | GW-P, GWP, GW P, **Pritsche** |
| GW-L | GW-L, GWL, GW L |
| JF-Bus | JF-Bus, JF Bus |

**Ignoriert** (vorerst): Anhänger, Bootanhänger – werden im Titel erkannt und übergangen; Einträge nur mit Anhänger erscheinen nicht. „JF“ allein (ohne „Bus“) ist kein Fahrzeug, sondern Teil des Zwecks (Jugendfeuerwehr).

Die Liste liegt im Backend (`FAHRZEUGE`), Änderungen nur per Code-Änderung (selten).

## 4. Datenmodell

### 4.1 Buchung (wie die App sie bekommt)

```
{ id, start, end, allDay,          // wie Dienstplan-Termin
  vehicles: ['MTW','GW-P'],        // buchbare Kürzel
  purpose:  'Lehrgang FTZ',        // Zweck
  contact:  'Name',                // Ansprechpartner (ASP)
  state:    'requested' | 'confirmed' | 'rejected',
  requestedBy, decidedBy, decidedAt, reason,
  recurring: bool, source: 'app' | 'google' }
```

### 4.2 Im Kalender

- Von der App geschrieben: `extendedProperties.private` = `{ fz: '1', vehicles: 'MTW,GW-P', purpose, contact, state, requestedBy, decidedBy, decidedAt, reason }`.
- **Titel** wird daraus erzeugt, damit der Kalender lesbar bleibt:
  - bestätigt: `MTW + GW-P · Lehrgang FTZ`
  - angefragt: `Angefragt: MTW + GW-P · Lehrgang FTZ`
  - Beschreibung: `Reserviert durch: Name`, darunter nur der Stand: `Bestätigt von … am TT.MM.JJJJ` · `Noch nicht bestätigt` · `Abgelehnt von … am …: Grund`
  - abgelehnt: `Abgelehnt: …`, Termin auf „frei“ (`transparency: transparent`)
- **Ohne** `fz`-Kennung (direkt in Google eingetragen) liest der **Titel-Parser** die Fahrzeuge vom Titelanfang (Schreibweisen aus Abschnitt 3, Trenner `&`, `/`, `+`, `,`, `und`), `ASP: …` als Ansprechpartner, den Rest als Zweck; Zustand = bestätigt. Nicht erkannte Einträge → **„nicht zugeordnet“**.
- Keine Gäste, `sendUpdates: none` (wie Dienstplan).
- Kalender-ID: wird beim ersten Zugriff über den Namen „Fahrzeuge 18-2“ in der Kalenderliste gefunden und in der Skript-Eigenschaft `FAHRZEUG_KALENDER` gespeichert (nicht im Repo).

## 5. Rollen

| | Ansehen | Anfragen | Eigene Anfrage ändern/zurückziehen | Bestätigen/Ablehnen | Alles ändern/löschen |
|---|---|---|---|---|---|
| alle Codes (auch Mannschaft) | ✓ | | | | |
| Code mit **„Fahrzeuge buchen“** | ✓ | ✓ | ✓ (solange angefragt) | | |
| Admin | ✓ | ✓ (gilt sofort als bestätigt) | ✓ | ✓ | ✓ |

- „Fahrzeuge buchen“ ist eine **zusätzliche Berechtigung je Zugangscode** (Häkchen in der Code-Verwaltung), unabhängig von Lesen/Schreiben. Für einzelne Personen gibt es damit einen eigenen Code, der zum Dienstplan nur Lesen erlaubt.
- „Eigene“ = `requestedBy` entspricht dem Namen des Codes.

## 6. Regeln

- **Pflichtfelder:** Datum, Zeit (Beginn/Ende oder ganztägig), mindestens ein Fahrzeug, Zweck, „Reserviert durch“ (Feld `contact`; in alten Google-Titeln als „ASP …“).
- **Konfliktprüfung im Backend** unter Sperre: ein Fahrzeug darf sich zeitlich nicht mit einer **bestätigten oder angefragten** Buchung überschneiden (abgelehnte zählen nicht; Ende = Beginn ist keine Überschneidung). Bei Serien wird jedes Vorkommen im nächsten Jahr geprüft.
- Konflikt → Speichern abgelehnt mit Hinweis „MTW ist am 12.12. 18:00–23:00 belegt: Lehrgang FTZ (reserviert durch …)“. **Doppelbuchungen sind nie möglich, auch nicht für Admins** – jedes Fahrzeug gibt es nur einmal. Wer Vorrang hat, ändert oder löscht zuerst die andere Buchung.
- Bereits doppelt belegte Einträge (direkt in Google eingetragen) zeigt die App mit „Doppelt belegt“ an.
- Bestätigen prüft erneut (Google-Einträge können inzwischen dazugekommen sein).
- Ablehnen mit optionalem Grund; abgelehnte Buchungen bleiben bis zu ihrem Datum sichtbar (für die anfragende Person), danach entfernt das nächtliche Aufräumen sie.

## 7. Screens

### 7.1 Bereich „Fahrzeuge“
Umschalter oben: **Dienstplan | Fahrzeuge**.

- **Belegung (Standard):** Tagesliste ab heute, je Tag die Buchungen als Karten (Fahrzeug-Chips, Zeit, Zweck, ASP, Zustand). Angefragt = gestrichelt, abgelehnt = durchgestrichen/blass.
- **Fahrzeug-Filter:** Chips je Fahrzeug („Nur MTW“).
- **Zeitleiste (Tablet/Laptop):** Zeilen = Fahrzeuge, Spalten = Tage einer Woche, Balken = Buchungen; freie Zeiten auf einen Blick.
- **„Nicht zugeordnet“** (nur Admin): Einträge, die der Parser nicht versteht, mit „Fahrzeuge zuordnen“.

### 7.2 Anfragen (Formular)
Fahrzeuge (Mehrfachauswahl, belegte im gewählten Zeitraum ausgegraut mit Grund), Datum, ganztägig/Zeit, Zweck, ASP (vorbelegt mit Code-Name), optional Wiederholung (gleicher Baukasten wie Dienstplan). Sofortige Vorprüfung beim Ausfüllen, verbindliche Prüfung beim Speichern.

### 7.3 Offene Anfragen (Admin)
Badge mit Anzahl; Liste mit **Bestätigen** / **Ablehnen (Grund)**, Konflikte rot markiert.

### 7.4 Meine Anfragen
Für Buchende: eigene Anfragen mit Zustand, Zurückziehen solange angefragt.

## 8. Schnittstelle (neue Aktionen)

| Aktion | Rolle | Inhalt |
|---|---|---|
| `getVehicles` | alle | `{ from, to }` → `{ vehicles, bookings, unassigned? }` |
| `saveBooking` | buchen | `{ id?, start, end, allDay, vehicles, purpose, contact, recurrence?, force? }` |
| `decideBooking` | admin | `{ id, decision: 'confirm'|'reject', reason? }` |
| `cancelBooking` | buchen (eigene, angefragt) / admin | `{ id }` |
| `assignVehicles` | admin | `{ id, vehicles }` – Einträge aus Google zuordnen |
| `normalizeTitles` | admin | `{ dryRun }` – alte Titel vereinheitlichen (Abschnitt 9) |

## 9. Altbestand vereinheitlichen

Einmalig (Admin, in der App): **Vorschau** aller erkannten Einträge „alter Titel → neuer Titel“ mit Fahrzeugen, Zweck, ASP; Admin korrigiert oder schließt einzelne aus; **Übernehmen** schreibt Titel und `fz`-Kennung. Serien werden als Ganzes geändert. Vorher wird alles ins Backup-Sheet geschrieben. Einträge nur mit Anhänger bleiben unverändert. „Pritsche“ wird dabei zu „GW-P“.

## 10. Etappen

1. **Anzeigen:** Bereich „Fahrzeuge“, Belegung + Filter, Parser, „nicht zugeordnet“. Nur lesend. – umgesetzt als vierte Ansicht „Fahrzeuge“ neben Liste/Woche/Tabelle (Schnittstelle 7.0).
2. **Anfragen & Bestätigen:** Berechtigung „Fahrzeuge buchen“, Formular, Konfliktprüfung, offene Anfragen, meine Anfragen. – umgesetzt (Schnittstelle 7.1):
   - Code-Verwaltung: Schalter „Fahrzeuge buchen“ je persönlichem Code (nicht für den Mannschafts-Code).
   - Formular „Fahrzeug anfragen“ (Admins: „Fahrzeug buchen“): Fahrzeug-Chips mit Punkt für „im Zeitraum belegt“ und Hinweistext, Wiederholung vereinfacht (jede Woche / alle 2 Wochen / jeden Tag, immer mit Enddatum).
   - Filter „Offen · n“ und Hinweisleiste für Admins, „Meine · n“ für Buchende.
   - Details: Bestätigen / Ablehnen (mit Grund) / Bearbeiten / Löschen bzw. Anfrage zurückziehen.
   - Serien: Bestätigen, Ablehnen, Löschen gelten für die ganze Serie; Ändern einer Serie nur im Google Kalender.
   - Admins können auch Einträge aus Google bearbeiten; sie werden dabei ins App-Format übernommen (bestätigt).
   - Farben im Google Kalender: angefragt = Banane, abgelehnt = Graphit (und „frei“), bestätigt = Standardfarbe.
3. **Altbestand vereinheitlichen** (Abschnitt 9) und Zeitleiste.
4. **Nur noch App:** Schreibrechte der anderen Konten im Kalender entziehen (von Hand in Google), Hinweis in der Kalenderbeschreibung.

## 11. Offen

- Benachrichtigung bei neuer Anfrage / Entscheidung (z. B. Mail an Admins) – vorerst nur Badge in der App.
- Kilometerstand/Fahrtenbuch – nicht vorgesehen.
