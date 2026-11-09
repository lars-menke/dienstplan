/******************************************************
 * Dienstplan AchtzehnZwo – Konfiguration, Sheet-Menü, Hilfsfunktionen
 * (docs/PWA-Spezifikation-V3.md)
 *
 * Seit V3 ist der Google Kalender die Datenquelle: Die App liest und
 * schreibt direkt im Kalender (Kalender.gs). Das Sheet ist nur noch
 * Backup (nachts, DataSheet + Categories), Papierkorb (Blatt „Gelöscht“)
 * und Notfall-Menü für Zugangscodes.
 *
 * Der Dateiname ist historisch (früher: Sheet → Kalender-Sync) und bleibt,
 * damit im Apps-Script-Editor nur Inhalte ersetzt werden müssen.
 ******************************************************/

const CONFIG = {
  // optional: ID der Tabelle (aus der URL). Nur nötig, falls die Web-App
  // die Tabelle nicht automatisch findet.
  SPREADSHEET_ID: '',

  SHEET_NAME: 'DataSheet',
  CATEGORY_SHEET_NAME: 'Categories',

  CALENDAR_ID: 'h68a5magn9ev8p44gupmarv68g@group.calendar.google.com',
  TIMEZONE: 'Europe/Berlin',

  // Spalten im Backup / Blatt „Gelöscht“ (zum Wiederherstellen)
  COL_SUBJECT: 'Subject',
  COL_START_DATE: 'Start Date',
  COL_START_TIME: 'Start Time',
  COL_END_DATE: 'End Date',
  COL_END_TIME: 'End Time',
  COL_ALL_DAY: 'All Day Event',
  COL_DESCRIPTION: 'Description',
  COL_LOCATION: 'Location',
  COL_EVENT_ID: 'EventId',
  COL_STATUS: 'Status',
  COL_VERSCHOBEN_AUF: 'Verschoben auf',
  COL_FOLGETERMIN: 'Folgetermin-ID',
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
  PREFIX_VERSCHOBEN: '↪️ VERSCHOBEN',
  // erste Zeile der Kalenderbeschreibung (V2, Kapitel 4.3)
  CATEGORY_LINE_PREFIX: 'Kategorie: ',

  // Google-Kalender-Farben: 1 Lavendel, 2 Salbei, 3 Weintraube, 4 Flamingo,
  // 5 Banane, 6 Mandarine, 7 Pfau, 8 Graphit, 9 Heidelbeere, 10 Basilikum, 11 Tomate
  COLOR_ABGESAGT: '8',
  COLOR_VERSCHOBEN: '6',

  // Kategorien: Mandarine (6) und Graphit (8) sind für „Verschoben“ und „Abgesagt“ reserviert
  CATEGORY_COLORS: {
    1: 'Lavendel', 2: 'Salbei', 3: 'Weintraube', 4: 'Flamingo', 5: 'Banane',
    7: 'Pfau', 9: 'Heidelbeere', 10: 'Basilikum', 11: 'Tomate',
  },
  // Hintergrundfarben für das Blatt „Categories“ im Backup
  CATEGORY_COLOR_HEX: {
    1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26',
    7: '#039be5', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
  },

  DEFAULT_DURATION_MIN: 60,

  // Apps Script bricht nach 6 Minuten ab, wir hören vorher sauber auf
  MAX_RUNTIME_MS: 5 * 60 * 1000,
};

const UI_TITLE = 'Dienstplan';

/* =========================
   MENÜ (V3 Kapitel 5.2)
   ========================= */

function onOpen(e) {
  try {
    SpreadsheetApp.getUi()
      .createMenu('📅 Dienstplan')
      .addItem('Termin aus Backup wiederherstellen…', 'restoreFromBackup')
      .addItem('Backup jetzt erstellen', 'backupToSheet')
      .addSeparator()
      .addItem('🔑 Zugangscode erstellen…', 'createAccessCode')
      .addItem('🔑 Zugangscodes verwalten…', 'manageAccessCodes')
      .addItem('📱 Link der App-Schnittstelle anzeigen', 'showWebAppUrl')
      .addToUi();
  } catch (err) {
    // Aufruf ohne UI (z.B. Trigger)
  }
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

/* =========================
   HILFSFUNKTIONEN (Ablauf)
   ========================= */

/** Script (und für Sheet-Vorgänge auch die Tabelle) müssen in Europe/Berlin laufen. */
function checkTimezone_(scriptOnly) {
  const scriptTz = Session.getScriptTimeZone();
  // scriptOnly: Anfragen der App – die Tabelle zu öffnen kostet bei jeder Anfrage Zeit
  const sheetTz = scriptOnly ? CONFIG.TIMEZONE : getSs_().getSpreadsheetTimeZone();
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

function getSheet_() {
  const sheet = getSs_().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Tabellenblatt nicht gefunden: ${CONFIG.SHEET_NAME}`);
  return sheet;
}

function errMsg_(e) {
  return (e && e.message) ? e.message : String(e);
}

function isGoneError_(err) {
  const msg = errMsg_(err);
  return msg.includes('Resource has been deleted') || msg.includes('Not Found') || msg.includes('404') || msg.includes('410');
}

/* =========================
   HILFSFUNKTIONEN (Backup-Zeilen lesen)
   ========================= */

/** Zeile aus DataSheet (Backup) oder „Gelöscht“ → Termindaten. map: Spaltenname (klein) → Index */
function rowToRecord_(row, map) {
  const get = (name) => {
    const idx = map[name.toLowerCase()];
    return (idx == null || row[idx] == null) ? '' : row[idx];
  };
  const str = (name) => (get(name) || '').toString().trim();

  return {
    eventId: str(CONFIG.COL_EVENT_ID),
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
   HILFSFUNKTIONEN (Termin bauen)
   ========================= */

/** Kategorie eines Termins: Name (Schreibweise aus der Kategorienliste) und Farbe. */
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

/** Sichtbarer Teil des Termins: Titel (mit Status-Präfix), Beschreibung, Farbe, Zeiten, Wiederholung. */
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

  // Reihenfolge im Kalender: Kategorie-Zeile, Status-Hinweis, Beschreibung
  const parts = [];
  if (cat.name) parts.push(`${CONFIG.CATEGORY_LINE_PREFIX}${cat.name}`);
  if (note) parts.push(note);
  const baseDesc = stripCategoryLine_(rec.description || '').rest;
  if (baseDesc) parts.push(baseDesc);

  const resource = {
    summary,
    description: parts.join('\n\n'),
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

/**
 * Übernimmt den bestehenden Termin (Erinnerungen, Teilnehmer usw. bleiben erhalten)
 * und überschreibt die Felder aus payload. Farbe/Wiederholung werden entfernt,
 * wenn payload keine hat; Ausnahmen der Serie (EXDATE/RDATE) bleiben.
 */
function mergeForUpdate_(existing, payload) {
  const merged = Object.assign({}, existing, payload);
  if (!payload.colorId) delete merged.colorId;
  if (payload.recurrence) {
    const extra = (existing.recurrence || []).filter(l => !/^RRULE:/i.test(l));
    merged.recurrence = payload.recurrence.concat(extra);
  } else {
    delete merged.recurrence;
  }
  return merged;
}

function normalizeRRule_(value) {
  const s = (value || '').toString().trim();
  if (!s) return '';
  return s.toUpperCase().startsWith('RRULE:') ? s : ('RRULE:' + s);
}

/** Alte Markierung „#Dienstplan 2026“ (aus der Zeit vor V3) aus einer Beschreibung entfernen. */
function stripMarker_(description) {
  return (description || '').toString().replace(/\s*#Dienstplan \d{4}\s*/g, '\n').trim();
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

/** Start/Ende als Date (ganztägig: Ende exklusiv). */
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

/* =========================
   HILFSFUNKTIONEN (Datum/Zeit)
   ========================= */

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
}

function dateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

/** "Verschoben auf": Datum-Zelle oder Text wie "12.03.2026", "12.03.2026 19:00", "2026-03-12T19:00" */
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
