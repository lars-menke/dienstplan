/******************************************************
 * Feuerwehr Dienstplan Sync – Version 2
 *
 * Grundprinzip: Google Sheet ist Master (Sheet -> Kalender)
 * - Anlegen / Aktualisieren / Löschen über die Calendar API
 * - sendUpdates: "none" (keine E-Mails)
 * - Marker in der Beschreibung: CONFIG.SYNC_MARKER
 * - Wiederholung (RRULE) optional über Spalte "Recurrence"
 * - Farben optional über Spalte "Category" + Blatt "Categories"
 *
 * Status (Spalte "Status", Dropdown):
 *   AKTIV       normaler Termin
 *   ABGESAGT    Termin bleibt sichtbar, Titel "❌ ABGESAGT: …", grau
 *   VERSCHOBEN  Termin bleibt am alten Datum, Titel "↪️ VERSCHOBEN auf …",
 *               orange. Ist "Verschoben auf" ausgefüllt, legt das Script
 *               automatisch eine neue Zeile + neuen Termin an.
 *   LÖSCHEN     Termin wird aus dem Kalender entfernt
 *   GELÖSCHT    wird vom Script gesetzt, Zeile wird danach ignoriert
 *
 * Kalender -> Liste:
 *   Menüpunkt "Kalender-Termine in Liste übernehmen" holt Termine, die im
 *   Kalender stehen, aber nicht in der Liste, als neue Zeilen ins Sheet.
 *
 * WICHTIG: Termine nie durch Löschen der Zeile entfernen, sondern über den
 * Status LÖSCHEN. Sonst holt der Import sie wieder zurück.
 *
 * Löschen-Menü:
 *   Cleanup:     löscht NUR Termine, die nicht aus dem Sheet stammen
 *   Hard Delete: löscht ALLE Termine ab Datum (inkl. Sheet) – mit Warnung
 ******************************************************/

const CONFIG = {
  // optional: ID der Tabelle (aus der URL). Nur nötig, falls die Web-App
  // die Tabelle nicht automatisch findet.
  SPREADSHEET_ID: '',

  SHEET_NAME: 'DataSheet',
  CATEGORY_SHEET_NAME: 'Categories',

  CALENDAR_ID: 'h68a5magn9ev8p44gupmarv68g@group.calendar.google.com',
  TIMEZONE: 'Europe/Berlin',

  // Datenspalten (Import-Format)
  COL_SUBJECT: 'Subject',
  COL_START_DATE: 'Start Date',
  COL_START_TIME: 'Start Time',
  COL_END_DATE: 'End Date',
  COL_END_TIME: 'End Time',
  COL_ALL_DAY: 'All Day Event',
  COL_DESCRIPTION: 'Description',
  COL_LOCATION: 'Location',

  // Spalten, die das Script bei Bedarf selbst anlegt
  COL_EVENT_ID: 'EventId',
  COL_HASH: 'LastSyncHash',
  COL_STATUS: 'Status',
  COL_VERSCHOBEN_AUF: 'Verschoben auf',
  COL_FOLGETERMIN: 'Folgetermin-ID',

  // optional (werden nur beim Import angelegt, wenn nötig)
  COL_RECURRENCE: 'Recurrence',
  COL_CATEGORY: 'Category',

  STATUS: {
    AKTIV: 'AKTIV',
    ABGESAGT: 'ABGESAGT',
    VERSCHOBEN: 'VERSCHOBEN',
    LOESCHEN: 'LÖSCHEN',
    GELOESCHT: 'GELÖSCHT',
  },

  PREFIX_ABGESAGT: '❌ ABGESAGT: ',
  // erste Zeile der Kalenderbeschreibung (V2, Kapitel 4.3)
  CATEGORY_LINE_PREFIX: 'Kategorie: ',
  PREFIX_VERSCHOBEN: '↪️ VERSCHOBEN',

  // Google-Kalender-Farben: 1 Lavendel, 2 Salbei, 3 Weintraube, 4 Flamingo,
  // 5 Banane, 6 Mandarine, 7 Pfau, 8 Graphit, 9 Heidelbeere, 10 Basilikum, 11 Tomate
  COLOR_ABGESAGT: '8',
  COLOR_VERSCHOBEN: '6',

  // Kategorien (V2, Kapitel 4). Mandarine (6) und Graphit (8) sind für
  // "Verschoben" und "Abgesagt" reserviert und nicht wählbar.
  CATEGORY_COLORS: {
    1: 'Lavendel', 2: 'Salbei', 3: 'Weintraube', 4: 'Flamingo', 5: 'Banane',
    7: 'Pfau', 9: 'Heidelbeere', 10: 'Basilikum', 11: 'Tomate',
  },
  // Hintergrundfarben für die Anzeige im Blatt "Categories"
  CATEGORY_COLOR_HEX: {
    1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26',
    7: '#039be5', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
  },
  // Startvorschlag beim ersten Einrichten – im Blatt frei änderbar
  DEFAULT_CATEGORIES: [
    ['Übung', 11],       // Tomate
    ['Besprechung', 7],  // Pfau
    ['Tradition', 5],    // Banane
  ],
  // Erster Startvorschlag (06.11.2026). Steht er noch unverändert und ungenutzt
  // im Blatt, wird er durch DEFAULT_CATEGORIES ersetzt.
  OLD_DEFAULT_CATEGORIES: [
    ['Übungsdienst', 11], ['Gruppendienst', 7], ['Ausbildung', 2],
    ['Besprechung', 1], ['Versammlung', 3], ['Veranstaltung', 5],
  ],

  // Vorschläge anhand des Titels (Groß-/Kleinschreibung egal).
  // Reihenfolge zählt: Die erste passende Kategorie gewinnt.
  // Besprechung steht vor Übung, damit "Gruppenführer-Dienstbesprechung" nicht bei Übung landet.
  CATEGORY_RULES: [
    { category: 'Besprechung', words: ['kommando', 'besprechung', 'gruppenführer', 'sitzung'] },
    { category: 'Übung', words: ['übung', 'uebung', 'gruppe', 'ausbildung', 'atemschutz', 'maschinist', 'funk', 'dienstabend'] },
    { category: 'Tradition', words: ['himmelfahrt', 'gilde', 'jahreshauptversammlung', 'jhv', 'volkstrauertag', 'schützen',
      'umzug', 'kranz', 'weihnacht', 'feier', 'ehrung', 'jubiläum', 'fest', 'schaffermahl', 'kameradschaft'] },
  ],

  DEFAULT_DURATION_MIN: 60,
  SYNC_MARKER: '#Dienstplan 2026',
  // Schutz beim Cleanup: jeder Termin, dessen Beschreibung das enthält
  // (deckt auch Marker anderer Jahre ab, z.B. "#Dienstplan 2027")
  PROTECT_MARKER: '#Dienstplan',

  // Apps Script bricht nach 6 Minuten ab, wir hören vorher sauber auf
  MAX_RUNTIME_MS: 5 * 60 * 1000,
};

const UI_TITLE = 'Feuerwehr Kalender-Sync';

/* =========================
   MENÜ
   ========================= */

function onOpen(e) {
  try {
    SpreadsheetApp.getUi()
      .createMenu('🚒 Feuerwehr Kalender-Sync')
      .addItem('Jetzt synchronisieren', 'syncSheetToCalendar')
      .addItem('📥 Kalender-Termine in Liste übernehmen…', 'menu_importCalendarToSheet')
      .addSeparator()
      .addItem('Sheet einrichten (Spalten, Dropdown, Farben)', 'setupSheet')
      .addItem('🏷️ Kategorien einrichten', 'setupCategories')
      .addItem('🏷️ Kategorien vorschlagen und eintragen…', 'previewCategorySuggestions')
      .addItem('Kalender-IDs anzeigen (Log)', 'showCalendarIds')
      .addSeparator()
      .addItem('⏱ Automatischen Sync einschalten (alle 15 Min.)', 'enableAutoSync')
      .addItem('⏱ Automatischen Sync ausschalten', 'disableAutoSync')
      .addSeparator()
      .addItem('🔑 Zugangscode erstellen…', 'createAccessCode')
      .addItem('🔑 Zugangscodes verwalten…', 'manageAccessCodes')
      .addItem('📱 Link der App-Schnittstelle anzeigen', 'showWebAppUrl')
      .addSeparator()
      .addItem('🧹 Cleanup: NICHT-Sheet-Termine AB Datum löschen…', 'menu_cleanupNonSheetFromDate')
      .addItem('🧹 Cleanup: NICHT-Sheet-Termine VOR Datum löschen…', 'menu_cleanupNonSheetBeforeDate')
      .addSeparator()
      .addItem('🔥 HARD DELETE: ALLE Termine AB Datum löschen…', 'menu_hardDeleteAllFromDate')
      .addToUi();
  } catch (err) {
    // Aufruf ohne UI (z.B. Trigger)
  }
}

function showCalendarIds() {
  const cals = CalendarApp.getAllCalendars();
  const lines = cals.map(c => `${c.getName()}  =>  ${c.getId()}`);
  Logger.log(`Gefundene Kalender:\n${lines.join('\n')}`);
  toast_('Kalender-IDs im Ausführungsprotokoll (Logger).', 10);
}

/* =========================
   SHEET EINRICHTEN
   ========================= */

function setupSheet() {
  const sheet = getSheet_();
  const map = ensureRequiredColumns_();
  applyStatusDropdown_(sheet, map);
  applyConditionalFormatting_(sheet, map);
  const catIdx = map[CONFIG.COL_CATEGORY.toLowerCase()];
  if (catIdx != null) applyCategoryDropdown_(sheet, catIdx + 1);
  toast_('Sheet eingerichtet: Spalten geprüft, Status-Dropdown und Farben gesetzt.', 10);
}

/**
 * - prüft die Pflicht-Header
 * - legt fehlende Spalten rechts an (Recurrence/Category nicht)
 * - leerer Status -> AKTIV, alte englische Werte -> deutsch
 */
function ensureRequiredColumns_() {
  const sheet = getSheet_();

  let map = getHeaderMap_(sheet);
  const required = [CONFIG.COL_SUBJECT, CONFIG.COL_START_DATE, CONFIG.COL_END_DATE, CONFIG.COL_ALL_DAY];
  const missing = required.filter(k => map[k.toLowerCase()] == null);
  if (missing.length) throw new Error(`Fehlende Pflicht-Header im Sheet: ${missing.join(', ')}`);

  [
    CONFIG.COL_START_TIME, CONFIG.COL_END_TIME, CONFIG.COL_DESCRIPTION, CONFIG.COL_LOCATION,
    CONFIG.COL_EVENT_ID, CONFIG.COL_HASH, CONFIG.COL_STATUS,
    CONFIG.COL_VERSCHOBEN_AUF, CONFIG.COL_FOLGETERMIN,
  ].forEach(name => ensureColumn_(sheet, name));

  map = getHeaderMap_(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const statusIdx = map[CONFIG.COL_STATUS.toLowerCase()];
    const subjectIdx = map[CONFIG.COL_SUBJECT.toLowerCase()];
    const subjects = sheet.getRange(2, subjectIdx + 1, lastRow - 1, 1).getValues();
    const range = sheet.getRange(2, statusIdx + 1, lastRow - 1, 1);
    const vals = range.getValues();
    let changed = false;

    for (let i = 0; i < vals.length; i++) {
      const raw = (vals[i][0] || '').toString().trim();
      let next = raw;
      if (!raw) {
        if ((subjects[i][0] || '').toString().trim()) next = CONFIG.STATUS.AKTIV;
      } else {
        const norm = normalizeStatus_(raw);
        if (norm) next = norm;
      }
      if (next !== raw) { vals[i][0] = next; changed = true; }
    }
    if (changed) range.setValues(vals);
  }

  return map;
}

/**
 * Menü „🏷️ Kategorien einrichten“ – bereitet die Einführung der Kategorien vor:
 *  1. Blatt "Categories" anlegen (Category · ColorId · Farbe) mit Startvorschlag,
 *     Auswahlliste für die Farbe und farbiger Vorschau. Ein vorhandenes Blatt
 *     wird nicht überschrieben, nur Kopfzeile und Formatierung ergänzt.
 *  2. Spalte "Category" in DataSheet anlegen, mit Auswahlliste aus dem Blatt "Categories".
 * Mehrfaches Ausführen schadet nicht.
 */
function setupCategories() {
  const ss = getSs_();
  let catSheet = ss.getSheetByName(CONFIG.CATEGORY_SHEET_NAME);
  const isNew = !catSheet;
  if (isNew) catSheet = ss.insertSheet(CONFIG.CATEGORY_SHEET_NAME);

  // Kopfzeile
  catSheet.getRange(1, 1, 1, 3).setValues([['Category', 'ColorId', 'Farbe']]).setFontWeight('bold');
  catSheet.setFrozenRows(1);

  // Startvorschlag nur bei leerem Blatt
  if (catSheet.getLastRow() < 2) {
    const rows = CONFIG.DEFAULT_CATEGORIES.map(([name, id]) => [name, id]);
    catSheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  const maxRows = Math.max(catSheet.getMaxRows(), 50);
  if (catSheet.getMaxRows() < maxRows) catSheet.insertRowsAfter(catSheet.getMaxRows(), maxRows - catSheet.getMaxRows());
  const body = maxRows - 1;

  // ColorId: nur erlaubte Farben (ohne 6 und 8)
  const ids = Object.keys(CONFIG.CATEGORY_COLORS);
  catSheet.getRange(2, 2, body, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(ids, true)
      .setAllowInvalid(false)
      .setHelpText(ids.map(id => `${id} = ${CONFIG.CATEGORY_COLORS[id]}`).join(', ') +
        '. Mandarine (6) und Graphit (8) sind für „Verschoben“ und „Abgesagt“ reserviert.')
      .build()
  );

  // Farbe: Name aus der ColorId (einfache Formel je Zeile) + farbiger Hintergrund.
  // Das Trennzeichen hängt von der Sheet-Sprache ab (Deutsch ";" – Englisch ","),
  // sonst zeigt das Sheet #ERROR!.
  const sep = formulaSeparator_(ss);
  const choices = [];
  for (let id = 1; id <= 11; id++) choices.push(`"${CONFIG.CATEGORY_COLORS[id] || 'reserviert'}"`);
  const formulas = [];
  for (let r = 2; r <= maxRows; r++) {
    formulas.push([`=IF(B${r}=""${sep}""${sep}IFERROR(CHOOSE(VALUE(B${r})${sep}${choices.join(sep)})${sep}"nicht erlaubt"))`]);
  }
  catSheet.getRange(2, 3, body, 1).setFormulas(formulas);
  const colorRange = catSheet.getRange(2, 3, body, 1);
  const otherRules = catSheet.getConditionalFormatRules().filter(r => {
    const rs = r.getRanges();
    return !(rs.length === 1 && rs[0].getA1Notation() === colorRange.getA1Notation());
  });
  const colorRules = ids.map(id => SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=IFERROR(VALUE($B2)=${id},FALSE)`)
    .setBackground(CONFIG.CATEGORY_COLOR_HEX[id])
    .setFontColor(['5'].includes(id) ? '#1b1b1b' : '#ffffff')
    .setRanges([colorRange])
    .build());
  catSheet.setConditionalFormatRules(otherRules.concat(colorRules));
  catSheet.setColumnWidth(1, 180);
  catSheet.setColumnWidth(3, 120);

  // DataSheet: Spalte Category mit Auswahlliste
  const sheet = getSheet_();
  const catIdx = ensureColumn_(sheet, CONFIG.COL_CATEGORY);
  applyCategoryDropdown_(sheet, catIdx + 1);

  toast_(
    isNew
      ? 'Kategorien eingerichtet: Blatt „Categories“ mit Startvorschlag angelegt, Spalte „Category“ mit Auswahlliste ergänzt.'
      : 'Kategorien geprüft: Blatt „Categories“ formatiert, Spalte „Category“ mit Auswahlliste ergänzt.',
    12
  );
}

/* =========================
   KATEGORIEN VORSCHLAGEN (anhand des Titels)
   ========================= */

/**
 * Sorgt dafür, dass Blatt "Categories" und Spalte "Category" da sind und alle
 * Kategorien aus CATEGORY_RULES im Blatt stehen. Ersetzt den ersten
 * Startvorschlag, wenn er noch unverändert und ungenutzt ist.
 */
function ensureCategoryBasics_() {
  const ss = getSs_();
  if (!ss.getSheetByName(CONFIG.CATEGORY_SHEET_NAME) || getHeaderMap_(getSheet_())[CONFIG.COL_CATEGORY.toLowerCase()] == null) {
    setupCategories();
  }
  const catSheet = ss.getSheetByName(CONFIG.CATEGORY_SHEET_NAME);
  const last = catSheet.getLastRow();
  const current = last >= 2
    ? catSheet.getRange(2, 1, last - 1, 2).getValues().filter(r => String(r[0]).trim())
    : [];

  // alter Startvorschlag unverändert + von keinem Termin genutzt → ersetzen
  const sig = rows => rows.map(r => `${String(r[0]).trim()}|${String(r[1]).trim()}`).join(';');
  const dataSheet = getSheet_();
  const catCol = getHeaderMap_(dataSheet)[CONFIG.COL_CATEGORY.toLowerCase()];
  const unused = catCol == null || !dataSheet.getDataRange().getValues().slice(1)
    .some(row => String(row[catCol] || '').trim());
  if (current.length && sig(current) === sig(CONFIG.OLD_DEFAULT_CATEGORIES) && unused) {
    catSheet.getRange(2, 1, last - 1, 2).clearContent();
    catSheet.getRange(2, 1, CONFIG.DEFAULT_CATEGORIES.length, 2).setValues(CONFIG.DEFAULT_CATEGORIES.map(r => r.slice()));
    current.length = 0;
    CONFIG.DEFAULT_CATEGORIES.forEach(r => current.push(r));
  }

  // fehlende Kategorien aus den Regeln ergänzen
  const have = new Set(current.map(r => String(r[0]).trim().toLowerCase()));
  const missing = CONFIG.CATEGORY_RULES
    .map(rule => rule.category)
    .filter(name => !have.has(name.toLowerCase()))
    .map(name => {
      const def = CONFIG.DEFAULT_CATEGORIES.find(d => d[0] === name);
      return [name, def ? def[1] : ''];
    });
  if (missing.length) {
    const start = Math.max(catSheet.getLastRow(), 1) + 1;
    catSheet.getRange(start, 1, missing.length, 2).setValues(missing);
  }
}

/** Kategorie-Vorschlag für einen Titel oder '' */
function suggestCategory_(subject) {
  const t = (subject || '').toString().toLowerCase();
  const rule = CONFIG.CATEGORY_RULES.find(r => r.words.some(w => t.includes(w)));
  return rule ? rule.category : '';
}

/** Vorschläge für alle Termine ohne Kategorie (Status ≠ GELÖSCHT). */
function computeCategorySuggestions_() {
  const sheet = getSheet_();
  const map = getHeaderMap_(sheet);
  const catIdx = map[CONFIG.COL_CATEGORY.toLowerCase()];
  const values = sheet.getDataRange().getValues();
  const result = { matches: [], unmatched: {}, perCategory: {}, alreadySet: 0, catIdx };

  for (let i = 1; i < values.length; i++) {
    const rec = rowToRecord_(values[i], map);
    if (!rec.subject) continue;
    if (normalizeStatus_(rec.status) === CONFIG.STATUS.GELOESCHT) continue;
    if (rec.category) { result.alreadySet++; continue; }

    const cat = suggestCategory_(rec.subject);
    if (cat) {
      result.matches.push({ row: i + 1, category: cat });
      const pc = result.perCategory[cat] = result.perCategory[cat] || { count: 0, titles: {} };
      pc.count++;
      pc.titles[rec.subject] = (pc.titles[rec.subject] || 0) + 1;
    } else {
      result.unmatched[rec.subject] = (result.unmatched[rec.subject] || 0) + 1;
    }
  }
  return result;
}

/** Menü „🏷️ Kategorien vorschlagen und eintragen…“: Vorschau mit Knopf zum Eintragen. */
function previewCategorySuggestions() {
  ensureCategoryBasics_();
  const r = computeCategorySuggestions_();
  const list = titles => Object.entries(titles)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))
    .map(([t, n]) => `<li>${escapeHtml_(t)}${n > 1 ? ` <span class="n">× ${n}</span>` : ''}</li>`)
    .join('');

  const blocks = CONFIG.CATEGORY_RULES.map(rule => {
    const pc = r.perCategory[rule.category];
    return `<h3>${escapeHtml_(rule.category)} <span class="n">${pc ? pc.count : 0} Termine</span></h3>` +
      (pc ? `<ul>${list(pc.titles)}</ul>` : '<p class="n">keine Treffer</p>');
  }).join('');
  const unmatchedCount = Object.values(r.unmatched).reduce((a, b) => a + b, 0);

  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; color: #1b1b1b; margin: 0; }
      h3 { margin: 14px 0 4px; font-size: 14px; }
      ul { margin: 0; padding-left: 18px; columns: 2; }
      li { margin: 1px 0; break-inside: avoid; }
      .n { color: #777; font-weight: normal; font-size: 12px; }
      .box { max-height: 300px; overflow: auto; border: 1px solid #ddd; border-radius: 6px; padding: 4px 10px 10px; }
      .sum { margin-bottom: 8px; }
      #msg { margin-top: 10px; font-weight: bold; }
      button { padding: 8px 14px; margin-top: 10px; }
    </style>
    <div class="sum">
      <b>${r.matches.length}</b> Termine bekommen einen Vorschlag,
      <b>${unmatchedCount}</b> bleiben ohne Kategorie,
      <b>${r.alreadySet}</b> haben schon eine.
    </div>
    <div class="box">
      ${blocks}
      <h3>Ohne Treffer <span class="n">${unmatchedCount} Termine – bleiben leer</span></h3>
      ${unmatchedCount ? `<ul>${list(r.unmatched)}</ul>` : '<p class="n">keine</p>'}
    </div>
    <p class="n">Eingetragen wird nur bei Terminen ohne Kategorie. Bereits gesetzte Kategorien bleiben unverändert.
      Der Kalender wird beim nächsten Sync aktualisiert (Farbe + Zeile „Kategorie: …“).</p>
    <button id="go" ${r.matches.length ? '' : 'disabled'}>${r.matches.length} Vorschläge eintragen</button>
    <div id="msg"></div>
    <script>
      document.getElementById('go').onclick = function () {
        var b = this; b.disabled = true; b.textContent = 'Wird eingetragen…';
        google.script.run
          .withSuccessHandler(function (m) { b.textContent = 'Erledigt'; document.getElementById('msg').textContent = m; })
          .withFailureHandler(function (e) { b.disabled = false; b.textContent = 'Nochmal versuchen'; document.getElementById('msg').textContent = e.message; })
          .applyCategorySuggestions();
      };
    </script>`).setWidth(640).setHeight(560);

  SpreadsheetApp.getUi().showModalDialog(html, '🏷️ Kategorien vorschlagen');
}

/** Trägt die Vorschläge ein (vom Dialog aufgerufen). Rechnet frisch, schreibt die Spalte in einem Rutsch. */
function applyCategorySuggestions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Gerade läuft ein Sync. Bitte gleich nochmal versuchen.');
  try {
    ensureCategoryBasics_();
    const r = computeCategorySuggestions_();
    if (!r.matches.length) return 'Keine Termine zum Eintragen gefunden.';

    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();
    const range = sheet.getRange(2, r.catIdx + 1, lastRow - 1, 1);
    const vals = range.getValues();
    r.matches.forEach(m => { vals[m.row - 2][0] = m.category; });
    range.setValues(vals);

    const parts = Object.entries(r.perCategory).map(([c, pc]) => `${c}: ${pc.count}`).join(', ');
    const msg = `${r.matches.length} Kategorien eingetragen (${parts}). Der Kalender wird beim nächsten Sync aktualisiert.`;
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Argument-Trennzeichen für Formeln: "," in Sprachen mit Dezimalpunkt
 * (Englisch, Japanisch, Chinesisch …), sonst ";" (Deutsch, Französisch …).
 */
function formulaSeparator_(ss) {
  const locale = (ss.getSpreadsheetLocale() || 'de_DE').toLowerCase();
  return /^(en|ja|zh|ko|th|he|iw|hi|ms|fil|tl)(_|$)/.test(locale) ? ',' : ';';
}

/** Auswahlliste für die Spalte Category: Werte aus Categories!A2:A (leer erlaubt). */
function applyCategoryDropdown_(sheet, col) {
  const catSheet = getSs_().getSheetByName(CONFIG.CATEGORY_SHEET_NAME);
  if (!catSheet || !col) return;
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  sheet.getRange(2, col, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(catSheet.getRange('A2:A'), true)
      .setAllowInvalid(false)
      .setHelpText('Kategorie aus dem Blatt „Categories“ wählen oder leer lassen.')
      .build()
  );
}

/** Legt eine Spalte rechts neben dem letzten Header an, falls sie fehlt. Gibt den 0-basierten Index zurück. */
function ensureColumn_(sheet, name) {
  const maxCols = sheet.getMaxColumns();
  const headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0]
    .map(h => (h || '').toString().trim().toLowerCase());

  const idx = headers.indexOf(name.toLowerCase());
  if (idx !== -1) return idx;

  let last = -1;
  for (let c = headers.length - 1; c >= 0; c--) {
    if (headers[c]) { last = c; break; }
  }
  const col = last + 2; // 1-basiert
  if (col > maxCols) sheet.insertColumnsAfter(maxCols, col - maxCols);
  sheet.getRange(1, col).setValue(name);
  return col - 1;
}

function applyStatusDropdown_(sheet, map) {
  const col = map[CONFIG.COL_STATUS.toLowerCase()] + 1;
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.values(CONFIG.STATUS), true)
    .setAllowInvalid(false)
    .setHelpText(
      'AKTIV = normal | ABGESAGT = bleibt sichtbar, als abgesagt markiert | ' +
      'VERSCHOBEN = "Verschoben auf" ausfüllen, neuer Termin wird automatisch angelegt | ' +
      'LÖSCHEN = Termin wird aus dem Kalender entfernt | GELÖSCHT setzt das Script selbst'
    )
    .build();

  sheet.getRange(2, col, rows, 1).setDataValidation(rule);
}

function applyConditionalFormatting_(sheet, map) {
  const letter = colLetter_(map[CONFIG.COL_STATUS.toLowerCase()] + 1);
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), sheet.getMaxColumns());
  const S = CONFIG.STATUS;

  // eigene Regeln aus früheren Läufen entfernen, fremde Regeln behalten
  const ours = /^=\$[A-Z]+2="(ABGESAGT|VERSCHOBEN|LÖSCHEN|GELÖSCHT)"$/;
  const rules = sheet.getConditionalFormatRules().filter(rule => {
    const c = rule.getBooleanCondition();
    if (!c || c.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
    return !ours.test((c.getCriteriaValues()[0] || '').toString());
  });

  const mk = (status, style) => style(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$${letter}2="${status}"`)
      .setRanges([range])
  ).build();

  rules.push(
    mk(S.ABGESAGT, b => b.setFontColor('#9e9e9e').setStrikethrough(true).setBackground('#eeeeee')),
    mk(S.VERSCHOBEN, b => b.setBackground('#ffe0b2')),
    mk(S.LOESCHEN, b => b.setBackground('#ffcdd2')),
    mk(S.GELOESCHT, b => b.setFontColor('#bdbdbd').setStrikethrough(true))
  );

  sheet.setConditionalFormatRules(rules);
}

/* =========================
   SYNC (Sheet -> Kalender)
   ========================= */

function syncSheetToCalendar() {
  withLock_(syncSheetToCalendar_);
}

function syncSheetToCalendar_() {
  const t0 = Date.now();
  checkTimezone_();

  const sheet = getSheet_();
  const map = ensureRequiredColumns_();

  const ctx = {
    sheet,
    map,
    categories: loadCategories_(),
    calEvents: loadCalendarEventMap_(), // alle Termine einmal laden -> Existenzprüfung ohne Extra-Abfragen
    stats: { created: 0, updated: 0, deleted: 0, followUps: 0, skipped: 0, errors: 0 },
  };

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    toast_('Keine Datenzeilen gefunden (nur Header).', 8);
    return;
  }

  let aborted = false;
  for (let i = 1; i < values.length; i++) {
    if (Date.now() - t0 > CONFIG.MAX_RUNTIME_MS) { aborted = true; break; }
    const rowIndex = i + 1;
    try {
      syncRow_(ctx, rowIndex, values[i]);
    } catch (e) {
      ctx.stats.errors++;
      Logger.log(`FEHLER Zeile ${rowIndex}: ${errMsg_(e)}`);
    }
  }

  const s = ctx.stats;
  let msg = `Sync fertig. Neu: ${s.created}, Aktualisiert: ${s.updated}, Gelöscht: ${s.deleted}, ` +
    `Folgetermine angelegt: ${s.followUps}, Übersprungen: ${s.skipped}, Fehler: ${s.errors}`;
  if (aborted) msg = '⏱ Zeitlimit erreicht – bitte nochmal starten, der Sync macht dort weiter. ' + msg;
  Logger.log(msg);
  toast_(msg, 15);
  return msg;
}

function syncRow_(ctx, rowIndex, row) {
  const S = CONFIG.STATUS;
  const rec = rowToRecord_(row, ctx.map);

  const status = normalizeStatus_(rec.status);
  if (!status) throw new Error(`Unbekannter Status "${rec.status}"`);

  if (status === S.GELOESCHT) { ctx.stats.skipped++; return; }

  // LÖSCHEN wird auch ohne Titel ausgeführt
  if (status === S.LOESCHEN) { deleteRowEvent_(ctx, rowIndex, rec); return; }

  if (!rec.subject) { ctx.stats.skipped++; return; }

  let verschobenAuf = null;
  if (status === S.VERSCHOBEN && rec.verschobenAuf !== '') {
    verschobenAuf = parseVerschobenAuf_(rec.verschobenAuf);
    if (!verschobenAuf) {
      throw new Error(`"${CONFIG.COL_VERSCHOBEN_AUF}" nicht lesbar: "${rec.verschobenAuf}" (erwartet z.B. 12.03.2026 oder 12.03.2026 19:00)`);
    }
  }

  upsertEvent_(ctx, rowIndex, rec, status, verschobenAuf);

  if (status === S.VERSCHOBEN && verschobenAuf && !rec.folgeterminId) {
    createFollowUp_(ctx, rowIndex, row, rec, verschobenAuf);
  }
}

function deleteRowEvent_(ctx, rowIndex, rec) {
  if (rec.eventId) {
    try {
      Calendar.Events.remove(CONFIG.CALENDAR_ID, rec.eventId, { sendUpdates: 'none' });
      ctx.stats.deleted++;
    } catch (err) {
      if (!isGoneError_(err)) throw err;
      Logger.log(`INFO Zeile ${rowIndex}: Termin war bereits gelöscht (${rec.eventId}).`);
    }
    ctx.calEvents.delete(rec.eventId);
  }

  writeCells_(ctx.sheet, rowIndex, ctx.map, {
    [CONFIG.COL_EVENT_ID]: '',
    [CONFIG.COL_HASH]: '',
    [CONFIG.COL_STATUS]: CONFIG.STATUS.GELOESCHT,
  });
}

/** Legt den Termin an oder aktualisiert ihn. Gibt die EventId zurück. */
function upsertEvent_(ctx, rowIndex, rec, status, verschobenAuf) {
  const { start, end, isAllDay } = buildEventTimes_(rec);
  const payload = buildEventResource_(rec, start, end, isAllDay, ctx.categories, status, verschobenAuf);
  const newHash = computeHash_(hashInput_(payload, isAllDay, categoryInfo_(rec, ctx.categories)));
  const existing = rec.eventId ? ctx.calEvents.get(rec.eventId) : null;

  // unverändert und im Kalender vorhanden -> nichts tun
  if (existing && rec.lastSyncHash === newHash) {
    ctx.stats.skipped++;
    return rec.eventId;
  }

  // fehlt im Kalender (neu oder dort gelöscht) -> anlegen
  if (!existing) {
    const created = Calendar.Events.insert(payload, CONFIG.CALENDAR_ID, { sendUpdates: 'none' });
    ctx.calEvents.set(created.id, created);
    writeCells_(ctx.sheet, rowIndex, ctx.map, {
      [CONFIG.COL_EVENT_ID]: created.id,
      [CONFIG.COL_HASH]: newHash,
    });
    if (rec.eventId) Logger.log(`INFO Zeile ${rowIndex}: Termin fehlte im Kalender und wurde neu angelegt.`);
    ctx.stats.created++;
    return created.id;
  }

  // vorhanden, aber geändert -> komplett aktualisieren
  const merged = mergeForUpdate_(existing, payload);
  const updated = Calendar.Events.update(merged, CONFIG.CALENDAR_ID, rec.eventId, { sendUpdates: 'none' });
  ctx.calEvents.set(updated.id, updated);
  writeCells_(ctx.sheet, rowIndex, ctx.map, { [CONFIG.COL_HASH]: newHash });
  ctx.stats.updated++;
  return rec.eventId;
}

/**
 * Übernimmt den bestehenden Termin (Erinnerungen etc. bleiben erhalten)
 * und überschreibt die Felder aus dem Sheet. Farbe/Wiederholung werden
 * entfernt, wenn sie im Sheet geleert wurden.
 */
function mergeForUpdate_(existing, payload) {
  const merged = Object.assign({}, existing, payload);

  if (!payload.colorId) delete merged.colorId;

  if (payload.recurrence) {
    // EXDATE/RDATE (z.B. einzeln gelöschte Serientermine) behalten
    const extra = (existing.recurrence || []).filter(l => !/^RRULE:/i.test(l));
    merged.recurrence = payload.recurrence.concat(extra);
  } else {
    delete merged.recurrence;
  }
  return merged;
}

/**
 * VERSCHOBEN: neue Zeile am Ende anlegen (Kopie mit neuem Datum)
 * und sofort im Kalender eintragen.
 */
function createFollowUp_(ctx, rowIndex, row, rec, v) {
  const m = ctx.map;
  const { start, end, isAllDay } = buildEventTimes_(rec);

  const newRow = row.slice();
  const set = (name, val) => {
    const i = m[name.toLowerCase()];
    if (i != null) newRow[i] = val;
  };

  if (isAllDay) {
    const days = Math.round((end.getTime() - start.getTime()) / 86400000); // Ende ist exklusiv
    const newStart = v.date;
    const newEnd = new Date(newStart.getFullYear(), newStart.getMonth(), newStart.getDate() + days - 1);
    set(CONFIG.COL_START_DATE, newStart);
    set(CONFIG.COL_END_DATE, newEnd);
  } else {
    const h = v.hasTime ? v.hours : start.getHours();
    const mi = v.hasTime ? v.minutes : start.getMinutes();
    const newStart = new Date(v.date.getFullYear(), v.date.getMonth(), v.date.getDate(), h, mi, 0, 0);
    const newEnd = new Date(newStart.getTime() + (end.getTime() - start.getTime()));
    set(CONFIG.COL_START_DATE, dateOnly_(newStart));
    set(CONFIG.COL_START_TIME, formatTime_(newStart));
    set(CONFIG.COL_END_DATE, dateOnly_(newEnd));
    set(CONFIG.COL_END_TIME, formatTime_(newEnd));
  }

  const hinweis = `(verschoben vom ${Utilities.formatDate(start, CONFIG.TIMEZONE, 'dd.MM.yyyy')})`;
  const desc = (rec.description || '').trim();
  set(CONFIG.COL_DESCRIPTION, desc ? `${hinweis}\n\n${desc}` : hinweis);

  set(CONFIG.COL_STATUS, CONFIG.STATUS.AKTIV);
  set(CONFIG.COL_EVENT_ID, '');
  set(CONFIG.COL_HASH, '');
  set(CONFIG.COL_VERSCHOBEN_AUF, '');
  set(CONFIG.COL_FOLGETERMIN, '');
  if (rec.recurrence) {
    set(CONFIG.COL_RECURRENCE, '');
    Logger.log(`INFO Zeile ${rowIndex}: Folgetermin ohne Wiederholung angelegt (Serie wurde verschoben).`);
  }

  const newRowIndex = appendRows_(ctx.sheet, [newRow]);

  // sofort vermerken, damit bei einem Fehler keine zweite Kopie entsteht
  writeCells_(ctx.sheet, rowIndex, m, { [CONFIG.COL_FOLGETERMIN]: `Zeile ${newRowIndex}` });

  const newRec = rowToRecord_(newRow, m);
  const newId = upsertEvent_(ctx, newRowIndex, newRec, CONFIG.STATUS.AKTIV, null);
  writeCells_(ctx.sheet, rowIndex, m, { [CONFIG.COL_FOLGETERMIN]: newId });

  ctx.stats.followUps++;
  Logger.log(`Zeile ${rowIndex}: Folgetermin in Zeile ${newRowIndex} angelegt (${newId}).`);
}

/* =========================
   IMPORT (Kalender -> Liste)
   ========================= */

function menu_importCalendarToSheet() {
  checkTimezone_();
  const ui = SpreadsheetApp.getUi();

  const from = promptDate_(ui, '📥 Kalender → Liste', 'Termine übernehmen, die im Kalender stehen, aber nicht in der Liste.\n\nVon-Datum (TT.MM.JJJJ), z.B. 01.01.2026:');
  if (!from) return;
  const to = promptDate_(ui, '📥 Kalender → Liste', 'Bis-Datum einschließlich (TT.MM.JJJJ), z.B. 31.12.2026:');
  if (!to) return;
  if (to < from) { ui.alert('Bis-Datum liegt vor dem Von-Datum.'); return; }

  const dryRun = askYesNo_(ui, 'Trockenlauf?', 'JA = nur zählen/loggen (DRY RUN)\nNEIN = wirklich übernehmen');

  withLock_(() => importCalendarToSheet_(from, to, dryRun));
}

function importCalendarToSheet_(from, to, dryRun) {
  const t0 = Date.now();
  const sheet = getSheet_();
  let map = ensureRequiredColumns_();
  const categories = loadCategories_();
  const sheetIds = getSheetEventIdSet_(sheet, map);

  const timeMin = from.toISOString();
  const timeMax = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString();

  const candidates = [];
  let skippedSpecial = 0, alreadyInSheet = 0, seriesExceptions = 0;
  let pageToken;

  do {
    const resp = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin, timeMax,
      singleEvents: false, // Serien als ein Eintrag
      showDeleted: false,
      maxResults: 2500,
      pageToken,
    });

    for (const ev of (resp.items || [])) {
      if (ev.status === 'cancelled') continue;
      const type = (ev.eventType || 'default').toString().toLowerCase();
      if (type !== 'default') { skippedSpecial++; continue; }
      if (sheetIds.has(ev.id)) { alreadyInSheet++; continue; }
      // einzeln geänderte Termine einer Serie gehören zur Serie
      if (ev.recurringEventId) { seriesExceptions++; continue; }
      candidates.push(ev);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  candidates.sort((a, b) => eventStartMs_(a) - eventStartMs_(b));

  const label = `${Utilities.formatDate(from, CONFIG.TIMEZONE, 'dd.MM.yyyy')} – ${Utilities.formatDate(to, CONFIG.TIMEZONE, 'dd.MM.yyyy')}`;

  if (dryRun) {
    candidates.forEach(ev => Logger.log('[DRY RUN] Würde übernehmen: ' + buildEventInfo_(ev)));
    const msg = `DRY RUN Import (${label}): ${candidates.length} Termine würden übernommen. ` +
      `Schon in Liste: ${alreadyInSheet}. Special übersprungen: ${skippedSpecial}.`;
    Logger.log(msg);
    toast_(msg, 15);
    return;
  }

  if (!candidates.length) {
    toast_(`Import (${label}): Keine fehlenden Termine gefunden.`, 10);
    return;
  }

  // Spalte Recurrence wird gebraucht, sonst würde eine Serie beim nächsten Sync zum Einzeltermin
  if (candidates.some(ev => (ev.recurrence || []).length)) {
    ensureColumn_(sheet, CONFIG.COL_RECURRENCE);
    map = getHeaderMap_(sheet);
  }

  const width = sheet.getLastColumn();
  const idx = name => map[name.toLowerCase()];
  const newRows = [];
  let errors = 0, aborted = false;

  for (const ev of candidates) {
    if (Date.now() - t0 > CONFIG.MAX_RUNTIME_MS) { aborted = true; break; }
    try {
      const row = eventToRow_(ev, map, width, categories.byColor);

      // Hash so berechnen, wie der Sync es tun würde -> nächster Sync ändert nichts
      const rec = rowToRecord_(row, map);
      const { start, end, isAllDay } = buildEventTimes_(rec);
      const payload = buildEventResource_(rec, start, end, isAllDay, categories, CONFIG.STATUS.AKTIV, null);

      // Marker setzen: ab jetzt gehört der Termin zur Liste
      if ((ev.description || '') !== payload.description) {
        Calendar.Events.patch({ description: payload.description }, CONFIG.CALENDAR_ID, ev.id, { sendUpdates: 'none' });
      }

      row[idx(CONFIG.COL_EVENT_ID)] = ev.id;
      row[idx(CONFIG.COL_HASH)] = computeHash_(hashInput_(payload, isAllDay, categoryInfo_(rec, categories)));
      row[idx(CONFIG.COL_STATUS)] = CONFIG.STATUS.AKTIV;
      newRows.push(row);
      Logger.log('Übernommen: ' + buildEventInfo_(ev));
    } catch (e) {
      errors++;
      Logger.log(`FEHLER beim Übernehmen: ${buildEventInfo_(ev)} | ${errMsg_(e)}`);
    }
  }

  if (newRows.length) appendRows_(sheet, newRows);

  let msg = `Import fertig (${label}): ${newRows.length} Termine in die Liste übernommen. ` +
    `Schon in Liste: ${alreadyInSheet}. Special übersprungen: ${skippedSpecial}. Fehler: ${errors}.`;
  if (aborted) msg = '⏱ Zeitlimit erreicht – bitte nochmal starten. ' + msg;
  Logger.log(msg);
  toast_(msg, 15);
}

function eventToRow_(ev, map, width, colorToCategory) {
  const row = new Array(width).fill('');
  const set = (name, val) => {
    const i = map[name.toLowerCase()];
    if (i != null) row[i] = val;
  };

  set(CONFIG.COL_SUBJECT, ev.summary || '(ohne Titel)');

  const allDay = !!(ev.start && ev.start.date);
  set(CONFIG.COL_ALL_DAY, allDay);

  if (allDay) {
    const s = parseIsoDate_(ev.start.date);
    const endExcl = parseIsoDate_(ev.end.date);
    let e = new Date(endExcl.getFullYear(), endExcl.getMonth(), endExcl.getDate() - 1);
    if (e < s) e = s;
    set(CONFIG.COL_START_DATE, s);
    set(CONFIG.COL_END_DATE, e);
  } else {
    const s = new Date(ev.start.dateTime);
    const e = new Date(ev.end.dateTime);
    set(CONFIG.COL_START_DATE, dateOnly_(s));
    set(CONFIG.COL_START_TIME, formatTime_(s));
    set(CONFIG.COL_END_DATE, dateOnly_(e));
    set(CONFIG.COL_END_TIME, formatTime_(e));
  }

  const descParts = stripCategoryLine_(stripMarker_(ev.description || ''));
  set(CONFIG.COL_DESCRIPTION, descParts.rest);
  set(CONFIG.COL_LOCATION, ev.location || '');

  const rrule = (ev.recurrence || []).find(l => /^RRULE:/i.test(l));
  if (rrule) set(CONFIG.COL_RECURRENCE, rrule);

  if (descParts.category) set(CONFIG.COL_CATEGORY, descParts.category);
  else if (ev.colorId && colorToCategory[ev.colorId]) set(CONFIG.COL_CATEGORY, colorToCategory[ev.colorId]);

  return row;
}

/* =========================
   LÖSCHEN A: CLEANUP (nur NICHT-Sheet-Termine)
   ========================= */

function menu_cleanupNonSheetFromDate() {
  const input = promptDeleteParams_(
    'Cleanup: NICHT-Sheet-Termine AB Datum löschen',
    'Löscht nur Termine, die NICHT vom Sheet stammen (Altlasten).'
  );
  if (!input) return;
  withLock_(() => cleanupNonSheetByRange_('from', input.pivotDate, input.filterText, input.dryRun, input.skipSpecialTypes));
}

function menu_cleanupNonSheetBeforeDate() {
  const input = promptDeleteParams_(
    'Cleanup: NICHT-Sheet-Termine VOR Datum löschen',
    'Löscht nur Termine, die NICHT vom Sheet stammen (Altlasten).'
  );
  if (!input) return;
  withLock_(() => cleanupNonSheetByRange_('before', input.pivotDate, input.filterText, input.dryRun, input.skipSpecialTypes));
}

function cleanupNonSheetByRange_(mode, pivotDate, filterText, dryRun, skipSpecialTypes) {
  Calendar.Calendars.get(CONFIG.CALENDAR_ID);

  const sheet = getSheet_();
  const sheetEventIds = getSheetEventIdSet_(sheet, ensureRequiredColumns_());
  const marker = CONFIG.PROTECT_MARKER.toLowerCase();
  const needle = (filterText || '').toLowerCase();

  const timeMin = (mode === 'from') ? pivotDate.toISOString() : new Date(2000, 0, 1).toISOString();
  const timeMax = (mode === 'from') ? new Date(2100, 0, 1).toISOString() : pivotDate.toISOString();

  let pageToken;
  let candidates = 0, deleted = 0, protectedCount = 0, skippedSpecial = 0, errors = 0;

  do {
    const resp = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin, timeMax,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
      showDeleted: false,
      orderBy: 'startTime',
    });

    for (const ev of (resp.items || [])) {
      const evType = (ev.eventType || '').toString().toLowerCase();
      if (skipSpecialTypes && evType && evType !== 'default') { skippedSpecial++; continue; }

      const title = (ev.summary || '').toLowerCase();
      const desc = (ev.description || '').toLowerCase();
      const loc = (ev.location || '').toLowerCase();

      // Sheet-Termine schützen (auch einzelne Termine einer Sheet-Serie)
      if (sheetEventIds.has(ev.id) || (ev.recurringEventId && sheetEventIds.has(ev.recurringEventId))) {
        protectedCount++; continue;
      }
      if (desc.includes(marker)) { protectedCount++; continue; }

      if (needle && !(title.includes(needle) || desc.includes(needle) || loc.includes(needle))) continue;

      candidates++;
      const info = buildEventInfo_(ev);
      try {
        if (dryRun) {
          Logger.log('[DRY RUN] Würde löschen (NICHT-Sheet): ' + info);
        } else {
          Calendar.Events.remove(CONFIG.CALENDAR_ID, ev.id, { sendUpdates: 'none' });
          deleted++;
          Logger.log('Gelöscht (NICHT-Sheet): ' + info);
        }
      } catch (err) {
        errors++;
        Logger.log(`FEHLER beim Löschen: ${info} | ${errMsg_(err)}`);
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  const label = `${mode === 'from' ? 'ab' : 'vor'} ${Utilities.formatDate(pivotDate, CONFIG.TIMEZONE, 'dd.MM.yyyy')}`;
  const msg = dryRun
    ? `DRY RUN Cleanup: ${candidates} NICHT-Sheet-Termine würden gelöscht (${label}). Geschützt: ${protectedCount}. Special übersprungen: ${skippedSpecial}. Fehler: ${errors}.`
    : `Cleanup fertig: ${deleted}/${candidates} NICHT-Sheet-Termine gelöscht (${label}). Geschützt: ${protectedCount}. Special übersprungen: ${skippedSpecial}. Fehler: ${errors}.`;

  Logger.log(msg);
  toast_(msg, 14);
}

/* =========================
   LÖSCHEN B: HARD DELETE (alle Termine ab Datum)
   ========================= */

function menu_hardDeleteAllFromDate() {
  const ui = SpreadsheetApp.getUi();

  const pivot = promptDate_(
    ui,
    '🔥 HARD DELETE: ALLE Termine AB Datum löschen',
    'ACHTUNG: Löscht ALLE Termine ab Datum (auch Sheet-Termine).\n\nDatum (TT.MM.JJJJ), z.B. 01.01.2026:'
  );
  if (!pivot) return;

  if (!askYesNo_(ui, 'Letzte Warnung', 'Willst du wirklich ALLE Termine ab Datum löschen?\nDas ist nicht rückgängig zu machen.')) return;

  const skipSpecialTypes = askYesNo_(ui, 'Special-Termine überspringen?',
    'JA = Geburtstage/Feiertage etc. überspringen (empfohlen)\nNEIN = versuchen alles zu löschen (kann Fehler werfen)');
  const dryRun = askYesNo_(ui, 'Trockenlauf?', 'JA = nur zählen/loggen (DRY RUN)\nNEIN = wirklich löschen');

  withLock_(() => hardDeleteAllFromDate_(pivot, dryRun, skipSpecialTypes));
}

function hardDeleteAllFromDate_(pivotDate, dryRun, skipSpecialTypes) {
  Calendar.Calendars.get(CONFIG.CALENDAR_ID);

  const timeMin = pivotDate.toISOString();
  const timeMax = new Date(2100, 0, 1).toISOString();

  let pageToken;
  let candidates = 0, deleted = 0, skippedSpecial = 0, errors = 0;

  do {
    const resp = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin, timeMax,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
      showDeleted: false,
      orderBy: 'startTime',
    });

    for (const ev of (resp.items || [])) {
      const evType = (ev.eventType || '').toString().toLowerCase();
      if (skipSpecialTypes && evType && evType !== 'default') { skippedSpecial++; continue; }

      candidates++;
      const info = buildEventInfo_(ev);
      try {
        if (dryRun) {
          Logger.log('[DRY RUN] Würde löschen: ' + info);
        } else {
          Calendar.Events.remove(CONFIG.CALENDAR_ID, ev.id, { sendUpdates: 'none' });
          deleted++;
          Logger.log('Gelöscht: ' + info);
        }
      } catch (err) {
        errors++;
        Logger.log(`FEHLER beim Löschen: ${info} | ${errMsg_(err)}`);
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  const label = `ab ${Utilities.formatDate(pivotDate, CONFIG.TIMEZONE, 'dd.MM.yyyy')}`;
  const msg = dryRun
    ? `DRY RUN HardDelete: ${candidates} Termine würden gelöscht (${label}). Special übersprungen: ${skippedSpecial}. Fehler: ${errors}.`
    : `HardDelete fertig: ${deleted}/${candidates} Termine gelöscht (${label}). Special übersprungen: ${skippedSpecial}. Fehler: ${errors}.`;

  Logger.log(msg);
  toast_(msg, 14);
}

/* =========================
   DIALOGE
   ========================= */

function promptDeleteParams_(title, hint) {
  const ui = SpreadsheetApp.getUi();

  const pivotDate = promptDate_(ui, title, `${hint}\n\nDatum (TT.MM.JJJJ), z.B. 01.01.2026:`);
  if (!pivotDate) return null;

  const filterResp = ui.prompt(
    'Optionaler Filter',
    'Nur löschen, wenn Text vorkommt (Titel/Beschreibung/Ort).\nLeer lassen = kein Filter.',
    ui.ButtonSet.OK_CANCEL
  );
  if (filterResp.getSelectedButton() !== ui.Button.OK) return null;
  const filterText = filterResp.getResponseText().trim();

  const skipSpecialTypes = askYesNo_(ui, 'Special-Termine überspringen?',
    'JA = Geburtstage/Feiertage etc. überspringen (empfohlen)\nNEIN = auch diese versuchen (kann Fehler werfen)');
  const dryRun = askYesNo_(ui, 'Trockenlauf?', 'JA = nur zählen/loggen (DRY RUN)\nNEIN = wirklich löschen');

  return { pivotDate, filterText, dryRun, skipSpecialTypes };
}

/** Fragt ein Datum ab. Akzeptiert TT.MM.JJJJ und JJJJ-MM-TT. */
function promptDate_(ui, title, text) {
  const resp = ui.prompt(title, text, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;

  const s = resp.getResponseText().trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  ui.alert('Ungültiges Datum. Bitte TT.MM.JJJJ verwenden, z.B. 01.01.2026.');
  return null;
}

function askYesNo_(ui, title, text) {
  return ui.alert(title, text, ui.ButtonSet.YES_NO) === ui.Button.YES;
}

/* =========================
   HILFSFUNKTIONEN (Ablauf)
   ========================= */

/** Verhindert, dass zwei Vorgänge gleichzeitig laufen (z.B. Trigger + manueller Sync). */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    toast_('Es läuft gerade schon ein Vorgang. Bitte kurz warten und erneut starten.', 10);
    return;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Script und Tabelle müssen in derselben Zeitzone laufen, sonst verrutschen Uhrzeiten. */
function checkTimezone_() {
  const scriptTz = Session.getScriptTimeZone();
  const sheetTz = getSs_().getSpreadsheetTimeZone();
  const problems = [];
  if (scriptTz !== CONFIG.TIMEZONE) problems.push(`Script-Projekt steht auf ${scriptTz} (Apps Script → Projekteinstellungen → Zeitzone)`);
  if (sheetTz !== CONFIG.TIMEZONE) problems.push(`Tabelle steht auf ${sheetTz} (Datei → Einstellungen → Zeitzone)`);
  if (problems.length) {
    throw new Error(`Zeitzone muss ${CONFIG.TIMEZONE} sein:\n- ${problems.join('\n- ')}`);
  }
}

function toast_(msg, seconds) {
  try {
    getSs_().toast(msg, UI_TITLE, seconds);
  } catch (e) {
    // kein Sheet-Fenster offen (Trigger, Web-App)
  }
}

/** Die Tabelle – auch dann, wenn das Script aus der Web-App oder einem Trigger läuft. */
function getSs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  throw new Error('Tabelle nicht gefunden. Bitte CONFIG.SPREADSHEET_ID eintragen.');
}

/* =========================
   AUTOMATISCHER SYNC + WEB-APP-LINK
   ========================= */

function enableAutoSync() {
  removeAutoSyncTriggers_();
  ScriptApp.newTrigger('syncSheetToCalendar').timeBased().everyMinutes(15).create();
  toast_('Automatischer Sync ist eingeschaltet: alle 15 Minuten.', 10);
}

function disableAutoSync() {
  const n = removeAutoSyncTriggers_();
  toast_(n ? 'Automatischer Sync ist ausgeschaltet.' : 'Automatischer Sync war nicht eingeschaltet.', 10);
}

function removeAutoSyncTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncSheetToCalendar') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

function showWebAppUrl() {
  const ui = SpreadsheetApp.getUi();
  const url = ScriptApp.getService().getUrl();
  ui.alert(
    '📱 App-Schnittstelle',
    url
      ? `Diesen Link in der Datei config.js der App eintragen:\n\n${url}`
      : 'Die Schnittstelle ist noch nicht bereitgestellt.\n\nIm Apps-Script-Editor: Bereitstellen → Neue Bereitstellung → Typ „Web-App“, Ausführen als „Ich“, Zugriff „Jeder“.',
    ui.ButtonSet.OK
  );
}

function errMsg_(e) {
  return (e && e.message) ? e.message : String(e);
}

function isGoneError_(err) {
  const msg = errMsg_(err);
  return msg.includes('Resource has been deleted') || msg.includes('Not Found') || msg.includes('404') || msg.includes('410');
}

/* =========================
   HILFSFUNKTIONEN (Sheet)
   ========================= */

function getSheet_() {
  const sheet = getSs_().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Tabellenblatt nicht gefunden: ${CONFIG.SHEET_NAME}`);
  return sheet;
}

function getHeaderMap_(sheet) {
  const maxCols = sheet.getMaxColumns();
  const row = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
  const map = {};
  row.forEach((h, i) => {
    const name = (h || '').toString().trim();
    if (name) map[name.toLowerCase()] = i;
  });
  return map;
}

function rowToRecord_(row, map) {
  const get = (name) => {
    const idx = map[name.toLowerCase()];
    return (idx == null || row[idx] == null) ? '' : row[idx];
  };
  const str = (name) => (get(name) || '').toString().trim();

  return {
    eventId: str(CONFIG.COL_EVENT_ID),
    lastSyncHash: str(CONFIG.COL_HASH),
    status: str(CONFIG.COL_STATUS),
    verschobenAuf: get(CONFIG.COL_VERSCHOBEN_AUF), // Datum oder Text
    folgeterminId: str(CONFIG.COL_FOLGETERMIN),
    recurrence: str(CONFIG.COL_RECURRENCE),
    category: str(CONFIG.COL_CATEGORY),

    subject: str(CONFIG.COL_SUBJECT),
    startDate: get(CONFIG.COL_START_DATE),
    startTime: get(CONFIG.COL_START_TIME),
    endDate: get(CONFIG.COL_END_DATE),
    endTime: get(CONFIG.COL_END_TIME),
    allDay: parseBoolean_(get(CONFIG.COL_ALL_DAY)),
    description: (get(CONFIG.COL_DESCRIPTION) || '').toString(),
    location: (get(CONFIG.COL_LOCATION) || '').toString(),
  };
}

function getSheetEventIdSet_(sheet, map) {
  const idx = map[CONFIG.COL_EVENT_ID.toLowerCase()];
  const set = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || idx == null) return set;

  const vals = sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues();
  for (const [v] of vals) {
    const id = (v || '').toString().trim();
    if (id) set.add(id);
  }
  return set;
}

function writeCells_(sheet, rowIndex, map, kv) {
  for (const [colName, val] of Object.entries(kv)) {
    const idx = map[colName.toLowerCase()];
    if (idx != null) sheet.getRange(rowIndex, idx + 1).setValue(val);
  }
}

/** Hängt Zeilen unten an (fügt bei Bedarf Zeilen hinzu). Gibt die erste neue Zeilennummer zurück. */
function appendRows_(sheet, rows) {
  const first = sheet.getLastRow() + 1;
  const needed = first + rows.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
  return first;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Status vereinheitlichen. Alte englische Werte werden übersetzt. Unbekannt -> null. */
function normalizeStatus_(v) {
  const S = CONFIG.STATUS;
  const s = (v || '').toString().trim().toUpperCase();
  const aliases = {
    '': S.AKTIV,
    'AKTIV': S.AKTIV,
    'ACTIVE': S.AKTIV,
    'ABGESAGT': S.ABGESAGT,
    'VERSCHOBEN': S.VERSCHOBEN,
    'LÖSCHEN': S.LOESCHEN,
    'LOESCHEN': S.LOESCHEN,
    'CANCELLED': S.LOESCHEN,
    'GELÖSCHT': S.GELOESCHT,
    'GELOESCHT': S.GELOESCHT,
    'CANCELLED_DONE': S.GELOESCHT,
  };
  return Object.prototype.hasOwnProperty.call(aliases, s) ? aliases[s] : null;
}

/* =========================
   HILFSFUNKTIONEN (Kategorien -> Farben)
   ========================= */

/**
 * Kategorien aus dem Blatt "Categories".
 * byName:    kategorie (klein) -> colorId
 * byColor:   colorId -> Kategoriename
 * canonical: kategorie (klein) -> Schreibweise aus dem Blatt
 * names:     alle Kategorienamen (Format der Live-App)
 * list:      [{ name, colorId }]
 */
function loadCategories_() {
  const result = { byName: {}, byColor: {}, canonical: {}, names: [], list: [] };
  const sheet = getSs_().getSheetByName(CONFIG.CATEGORY_SHEET_NAME);
  if (!sheet) return result;

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return result;

  const headers = values[0].map(h => (h || '').toString().trim().toLowerCase());
  const idxCat = headers.indexOf('category');
  const idxCol = headers.indexOf('colorid');
  if (idxCat === -1 || idxCol === -1) return result;

  for (let i = 1; i < values.length; i++) {
    const cat = (values[i][idxCat] || '').toString().trim();
    const colorId = (values[i][idxCol] || '').toString().trim();
    if (!cat || !colorId) continue;
    result.byName[cat.toLowerCase()] = colorId;
    result.canonical[cat.toLowerCase()] = cat;
    result.names.push(cat);
    result.list.push({ name: cat, colorId: parseInt(colorId, 10) || colorId });
    if (!result.byColor[colorId]) result.byColor[colorId] = cat;
  }
  return result;
}

/* =========================
   HILFSFUNKTIONEN (Termin bauen)
   ========================= */

/** Kategorie eines Termins: Name (Schreibweise aus dem Blatt "Categories") und Farbe. */
function categoryInfo_(rec, categories) {
  const raw = (rec.category || '').toString().trim();
  if (!raw) return { name: '', colorId: '' };
  const key = raw.toLowerCase();
  const c = categories || {};
  return {
    name: (c.canonical && c.canonical[key]) || raw,
    colorId: (c.byName && c.byName[key]) || '',
  };
}

function buildEventResource_(rec, start, end, isAllDay, categories, status, verschobenAuf) {
  const S = CONFIG.STATUS;
  const cat = categoryInfo_(rec, categories);
  let summary = rec.subject;
  let note = '';
  let colorId = cat.colorId;

  if (status === S.ABGESAGT) {
    summary = CONFIG.PREFIX_ABGESAGT + summary;
    note = '❌ Dieser Termin wurde abgesagt.';
    colorId = CONFIG.COLOR_ABGESAGT;
  } else if (status === S.VERSCHOBEN) {
    const ziel = verschobenAuf ? ` auf ${formatVerschoben_(verschobenAuf, true)}` : '';
    summary = `${CONFIG.PREFIX_VERSCHOBEN}${ziel}: ${summary}`;
    note = verschobenAuf
      ? `↪️ Dieser Termin wurde verschoben auf ${formatVerschoben_(verschobenAuf, false)}.`
      : '↪️ Dieser Termin wurde verschoben. Neuer Termin folgt.';
    colorId = CONFIG.COLOR_VERSCHOBEN;
  }

  // Reihenfolge im Kalender: Kategorie-Zeile, Status-Hinweis, Beschreibung, Marker
  const parts = [];
  if (cat.name) parts.push(`${CONFIG.CATEGORY_LINE_PREFIX}${cat.name}`);
  if (note) parts.push(note);
  const baseDesc = stripCategoryLine_(rec.description || '').rest;
  if (baseDesc) parts.push(baseDesc);
  const desc = parts.join('\n\n');

  const resource = {
    summary,
    description: appendMarker_(desc, CONFIG.SYNC_MARKER),
    location: rec.location || '',
  };
  if (colorId) resource.colorId = colorId;

  const rule = normalizeRRule_(rec.recurrence);
  if (rule) resource.recurrence = [rule];

  if (isAllDay) {
    resource.start = { date: Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyy-MM-dd') };
    resource.end = { date: Utilities.formatDate(end, CONFIG.TIMEZONE, 'yyyy-MM-dd') }; // exklusiv
  } else {
    resource.start = { dateTime: start.toISOString(), timeZone: CONFIG.TIMEZONE };
    resource.end = { dateTime: end.toISOString(), timeZone: CONFIG.TIMEZONE };
  }

  return resource;
}

function hashInput_(payload, isAllDay, cat) {
  return {
    category: (cat && cat.name) || '',
    categoryColorId: (cat && cat.colorId) || '',
    summary: payload.summary,
    description: payload.description || '',
    location: payload.location || '',
    start: payload.start,
    end: payload.end,
    allDay: isAllDay,
    recurrence: payload.recurrence || [],
    colorId: payload.colorId || '',
  };
}

function normalizeRRule_(cellValue) {
  const s = (cellValue || '').toString().trim();
  if (!s) return '';
  return s.toUpperCase().startsWith('RRULE:') ? s : ('RRULE:' + s);
}

function appendMarker_(description, marker) {
  const d = (description || '').toString();
  if (d.includes(marker)) return d;
  return d.trim() ? `${d.trim()}\n\n${marker}` : marker;
}

function stripMarker_(description) {
  return (description || '').toString().split(CONFIG.SYNC_MARKER).join('').trim();
}

/** Trennt eine führende Zeile "Kategorie: …" ab. → { category, rest } */
function stripCategoryLine_(description) {
  const d = (description || '').toString().trim();
  const prefix = CONFIG.CATEGORY_LINE_PREFIX;
  if (!d.startsWith(prefix)) return { category: '', rest: d };
  const nl = d.indexOf('\n');
  const line = nl === -1 ? d : d.slice(0, nl);
  return {
    category: line.slice(prefix.length).trim(),
    rest: nl === -1 ? '' : d.slice(nl + 1).trim(),
  };
}

function buildEventTimes_(rec) {
  const isAllDay = !!rec.allDay;

  const startDate = parseDate_(rec.startDate);
  if (!startDate) throw new Error('Start Date fehlt/ungültig');
  const endDateRaw = parseDate_(rec.endDate) || startDate;

  if (isAllDay) {
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDateRaw.getFullYear(), endDateRaw.getMonth(), endDateRaw.getDate() + 1); // exklusiv
    return { start, end, isAllDay: true };
  }

  const start = combineDateTime_(startDate, rec.startTime);
  let end = combineDateTime_(endDateRaw, rec.endTime);

  if (!start) throw new Error('Start Time fehlt/ungültig (bei All Day = FALSE)');
  if (!end || end.getTime() <= start.getTime()) {
    end = new Date(start.getTime() + CONFIG.DEFAULT_DURATION_MIN * 60 * 1000);
  }

  return { start, end, isAllDay: false };
}

function buildEventInfo_(ev) {
  const startStr = (ev.start && (ev.start.dateTime || ev.start.date)) || '';
  return `${startStr} | ${ev.summary || '(ohne Titel)'} | ${ev.id}`;
}

function eventStartMs_(ev) {
  if (!ev.start) return 0;
  if (ev.start.dateTime) return new Date(ev.start.dateTime).getTime();
  if (ev.start.date) return parseIsoDate_(ev.start.date).getTime();
  return 0;
}

/* =========================
   HILFSFUNKTIONEN (Calendar API)
   ========================= */

/** Lädt alle (nicht gelöschten) Termine des Kalenders einmalig: id -> Termin. */
function loadCalendarEventMap_() {
  const map = new Map();
  let pageToken;
  do {
    const resp = Calendar.Events.list(CONFIG.CALENDAR_ID, {
      singleEvents: false,
      showDeleted: false,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of (resp.items || [])) {
      if (ev.status !== 'cancelled') map.set(ev.id, ev);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return map;
}

/* =========================
   HILFSFUNKTIONEN (Datum/Zeit/Hash)
   ========================= */

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
}

function dateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatTime_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'HH:mm');
}

function parseIsoDate_(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function parseBoolean_(v) {
  if (typeof v === 'boolean') return v;
  const s = (v || '').toString().trim().toLowerCase();
  return s === 'true' || s === 'wahr' || s === '1' || s === 'yes' || s === 'ja';
}

function parseDate_(v) {
  if (!v) return null;
  if (isDate_(v)) return dateOnly_(v);

  const s = v.toString().trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);

  const d2 = new Date(s);
  if (!isNaN(d2)) return dateOnly_(d2);

  return null;
}

/** "Verschoben auf": Datum-Zelle oder Text wie "12.03.2026", "12.03.2026 19:00", "2026-03-12 19:00" */
function parseVerschobenAuf_(v) {
  if (v === '' || v == null) return null;

  const mk = (y, mo, d, h, mi) => ({
    date: new Date(y, mo, d),
    hasTime: h != null && h !== '',
    hours: h ? +h : 0,
    minutes: mi ? +mi : 0,
  });

  if (isDate_(v)) {
    const hasTime = v.getHours() !== 0 || v.getMinutes() !== 0;
    return mk(v.getFullYear(), v.getMonth(), v.getDate(), hasTime ? v.getHours() : null, hasTime ? v.getMinutes() : null);
  }

  const s = v.toString().trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?(?:\s*Uhr)?$/i);
  if (m) return mk(+m[3], +m[2] - 1, +m[1], m[4], m[5]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{1,2}):(\d{2}))?$/);
  if (m) return mk(+m[1], +m[2] - 1, +m[3], m[4], m[5]);

  return null;
}

function formatVerschoben_(v, short) {
  const datum = Utilities.formatDate(v.date, CONFIG.TIMEZONE, short ? 'dd.MM.' : 'dd.MM.yyyy');
  if (!v.hasTime) return datum;
  const zeit = `${String(v.hours).padStart(2, '0')}:${String(v.minutes).padStart(2, '0')}`;
  return short ? `${datum} ${zeit}` : `${datum}, ${zeit} Uhr`;
}

function combineDateTime_(dateObj, timeVal) {
  if (!dateObj || timeVal === '' || timeVal == null) return null;

  if (isDate_(timeVal)) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(),
      timeVal.getHours(), timeVal.getMinutes(), 0, 0);
  }

  const m = timeVal.toString().trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), +m[1], +m[2], 0, 0);
}

function computeHash_(obj) {
  const json = JSON.stringify(obj);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}
