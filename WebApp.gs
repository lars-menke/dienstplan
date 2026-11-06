/******************************************************
 * Dienstplan – Schnittstelle für die Handy-App (PWA)
 *
 * Gehört ins SELBE Apps-Script-Projekt wie Dienstplan-Sync.gs.
 * Die App selbst liegt auf GitHub Pages und schickt ihre Anfragen
 * hierher. Die ganze Logik (Status, Folgetermine, Sync) bleibt hier.
 *
 * Schutz: Jede Anfrage braucht einen persönlichen Zugangscode.
 * Codes werden im Sheet-Menü erstellt und gesperrt und liegen in den
 * Script-Eigenschaften (nicht im Code, nicht im Sheet).
 *
 * Bereitstellung: Web-App, "Ausführen als: Ich", "Zugriff: Jeder".
 ******************************************************/

const WEBAPP = {
  // Adresse der App auf GitHub Pages (für die Anmelde-Links)
  APP_URL: 'https://lars-menke.github.io/dienstplan/',

  COL_GEAENDERT: 'Letzte Änderung',
  PROP_CODES: 'ZUGANGSCODES',
};

/* =========================
   EINSTIEG
   ========================= */

function doGet() {
  return json_({ ok: true, info: 'Dienstplan-Schnittstelle. Bitte die App verwenden.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Ungültige Anfrage.' });
  }

  try {
    const user = authenticate_(req.code);
    const result = handleAction_(req.action, req.data || {}, user);
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    if (!err.isAuth) Logger.log(`FEHLER App (${req.action}): ${errMsg_(err)}`);
    return json_({ ok: false, error: errMsg_(err), auth: !!err.isAuth });
  }
}

function handleAction_(action, data, user) {
  checkTimezone_();
  switch (action) {
    case 'getData': return getAppData_(user);
    case 'saveEvent': return saveEvent_(data, user);
    case 'setStatus': return setStatus_(data, user);
    case 'syncAll': return syncAll_(user);
    default: throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================
   ZUGANGSCODES
   ========================= */

function loadCodes_() {
  const raw = PropertiesService.getScriptProperties().getProperty(WEBAPP.PROP_CODES);
  try {
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveCodes_(codes) {
  PropertiesService.getScriptProperties().setProperty(WEBAPP.PROP_CODES, JSON.stringify(codes));
}

/** Gibt den Namen zum Code zurück oder wirft einen Anmeldefehler. */
function authenticate_(code) {
  const clean = normalizeCode_(code);
  const entry = clean ? loadCodes_().find(c => c.code === clean) : null;
  if (!entry) {
    Utilities.sleep(800); // bremst Durchprobieren
    const err = new Error('Zugangscode ungültig oder gesperrt.');
    err.isAuth = true;
    throw err;
  }
  return entry.name;
}

function normalizeCode_(code) {
  return (code || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 20 Zeichen ohne verwechselbare Zeichen (kein 0/O, 1/I/L) ≈ 100 Bit Zufall */
function generateCode_() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Date.now()
  );
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[(bytes[i] + 256) % alphabet.length];
  return out;
}

function formatCode_(code) {
  return code.match(/.{1,4}/g).join('-');
}

/* --- Menü: Codes verwalten --- */

function createAccessCode() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('🔑 Zugangscode erstellen', 'Für wen ist der Code? (Name, erscheint bei „Letzte Änderung“)', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const name = resp.getResponseText().trim();
  if (!name) { ui.alert('Bitte einen Namen eingeben.'); return; }

  const codes = loadCodes_();
  if (codes.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    ui.alert(`Für „${name}“ gibt es schon einen Code. Erst sperren, dann neu erstellen.`);
    return;
  }

  const code = generateCode_();
  codes.push({ name, code, created: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd.MM.yyyy') });
  saveCodes_(codes);
  showCodeDialog_(name, code);
}

function manageAccessCodes() {
  const ui = SpreadsheetApp.getUi();
  const codes = loadCodes_();
  if (!codes.length) {
    ui.alert('Noch keine Zugangscodes. Über „Zugangscode erstellen…“ anlegen.');
    return;
  }

  const list = codes.map(c => `• ${c.name} (seit ${c.created})`).join('\n');
  const resp = ui.prompt(
    '🔑 Zugangscodes',
    `Aktive Codes:\n${list}\n\nZum Sperren den Namen eingeben (oder Abbrechen):`,
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const name = resp.getResponseText().trim().toLowerCase();
  const rest = codes.filter(c => c.name.toLowerCase() !== name);
  if (rest.length === codes.length) { ui.alert('Kein Code mit diesem Namen gefunden.'); return; }

  saveCodes_(rest);
  ui.alert('Gesperrt. Die App fragt auf diesem Gerät beim nächsten Öffnen nach einem neuen Code.');
}

function showCodeDialog_(name, code) {
  const pretty = formatCode_(code);
  const link = `${WEBAPP.APP_URL}#code=${code}`;
  const html = HtmlService.createHtmlOutput(`
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
      <p>Zugangscode für <b>${escapeHtml_(name)}</b>:</p>
      <p style="font:600 22px monospace;letter-spacing:2px;background:#f3f3f3;padding:10px;border-radius:8px;text-align:center">${pretty}</p>
      <p><b>Am einfachsten:</b> diesen Link aufs Handy schicken. Wer ihn öffnet, ist direkt angemeldet:</p>
      <input id="l" value="${escapeHtml_(link)}" readonly style="width:100%;padding:8px;font-size:13px" onclick="this.select()">
      <p><button onclick="var i=document.getElementById('l');i.select();document.execCommand('copy');this.textContent='Kopiert ✓'">Link kopieren</button></p>
      <p style="color:#a00">Der Code wird nur jetzt angezeigt. Link nur an diese eine Person geben – er funktioniert wie ein Passwort.</p>
    </div>`).setWidth(460).setHeight(400);
  SpreadsheetApp.getUi().showModalDialog(html, '🔑 Zugangscode erstellt');
}

/* =========================
   AKTIONEN
   ========================= */

/** Neuer Termin (data.ref leer) oder Termin bearbeiten. */
function saveEvent_(data, user) {
  return mutate_(user, ({ sheet, map }) => {
    const f = validateEventInput_(data);
    const C = CONFIG;

    if (f.category) {
      ensureColumn_(sheet, C.COL_CATEGORY);
      map = getHeaderMap_(sheet);
    }

    const cells = {
      [C.COL_SUBJECT]: f.subject,
      [C.COL_START_DATE]: isoToDate_(f.date),
      [C.COL_END_DATE]: isoToDate_(f.endDate),
      [C.COL_ALL_DAY]: f.allDay,
      [C.COL_START_TIME]: f.allDay ? '' : f.start,
      [C.COL_END_TIME]: f.allDay ? '' : f.end,
      [C.COL_LOCATION]: f.location,
      [C.COL_DESCRIPTION]: f.description,
    };
    if (map[C.COL_CATEGORY.toLowerCase()] != null) cells[C.COL_CATEGORY] = f.category;

    let rowIndex;
    if (data.ref) {
      rowIndex = locateRow_(sheet, map, data.ref);
      writeCells_(sheet, rowIndex, map, cells);
    } else {
      const row = new Array(sheet.getLastColumn()).fill('');
      cells[C.COL_STATUS] = C.STATUS.AKTIV;
      for (const [name, val] of Object.entries(cells)) {
        const i = map[name.toLowerCase()];
        if (i != null) row[i] = val;
      }
      rowIndex = appendRows_(sheet, [row]);
    }

    stamp_(sheet, map, rowIndex, user);
    return syncAndReport_(sheet, map, rowIndex, data.ref ? 'Gespeichert.' : 'Termin angelegt.');
  });
}

/** Status ändern: ABGESAGT, VERSCHOBEN (mit neuem Datum), AKTIV, LÖSCHEN */
function setStatus_(data, user) {
  return mutate_(user, ({ sheet, map }) => {
    const S = CONFIG.STATUS;
    const rowIndex = locateRow_(sheet, map, data.ref);
    const row = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rec = rowToRecord_(row, map);
    const cells = { [CONFIG.COL_STATUS]: data.status };
    let message;

    switch (data.status) {
      case S.ABGESAGT:
        message = 'Termin abgesagt.';
        break;

      case S.VERSCHOBEN: {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.newDate || '')) throw new Error('Bitte ein neues Datum wählen.');
        const [y, m, d] = data.newDate.split('-').map(Number);
        const t = /^(\d{2}):(\d{2})$/.exec(data.newTime || '');
        cells[CONFIG.COL_VERSCHOBEN_AUF] = t ? new Date(y, m - 1, d, +t[1], +t[2]) : new Date(y, m - 1, d);
        message = rec.folgeterminId
          ? 'Als verschoben markiert (neuer Termin war schon angelegt).'
          : 'Termin verschoben – der neue Termin ist angelegt.';
        break;
      }

      case S.AKTIV:
        cells[CONFIG.COL_VERSCHOBEN_AUF] = '';
        message = 'Termin ist wieder aktiv.';
        break;

      case S.LOESCHEN:
        message = 'Termin gelöscht.';
        break;

      default:
        throw new Error(`Unbekannter Status: ${data.status}`);
    }

    writeCells_(sheet, rowIndex, map, cells);
    stamp_(sheet, map, rowIndex, user);
    return syncAndReport_(sheet, map, rowIndex, message);
  });
}

function syncAll_(user) {
  return withWebLock_(() => {
    const msg = syncSheetToCalendar_();
    return Object.assign({ message: msg }, getAppData_(user));
  });
}

/* =========================
   ABLAUF
   ========================= */

function mutate_(user, fn) {
  return withWebLock_(() => {
    const sheet = getSheet_();
    ensureRequiredColumns_();
    ensureColumn_(sheet, WEBAPP.COL_GEAENDERT);
    const map = getHeaderMap_(sheet);
    const result = fn({ sheet, map });
    return Object.assign(result, getAppData_(user));
  });
}

function withWebLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Gerade läuft schon ein Sync. Bitte in ein paar Sekunden nochmal versuchen.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Überträgt nur diese eine Zeile (schnell) und baut die Rückmeldung. */
function syncAndReport_(sheet, map, rowIndex, message) {
  try {
    syncOneRow_(sheet, map, rowIndex);
    return { message, warning: false };
  } catch (e) {
    Logger.log(`FEHLER App Zeile ${rowIndex}: ${errMsg_(e)}`);
    return {
      message: `Im Sheet gespeichert, aber der Kalender konnte nicht aktualisiert werden: ${errMsg_(e)}`,
      warning: true,
    };
  }
}

function syncOneRow_(sheet, map, rowIndex) {
  const row = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rec = rowToRecord_(row, map);

  // nur den einen Termin laden statt den ganzen Kalender
  const calEvents = new Map();
  if (rec.eventId) {
    try {
      const ev = Calendar.Events.get(CONFIG.CALENDAR_ID, rec.eventId);
      if (ev && ev.status !== 'cancelled') calEvents.set(ev.id, ev);
    } catch (e) {
      if (!isGoneError_(e)) throw e;
    }
  }

  const ctx = {
    sheet,
    map,
    categories: loadCategories_(),
    calEvents,
    stats: { created: 0, updated: 0, deleted: 0, followUps: 0, skipped: 0, errors: 0 },
  };
  syncRow_(ctx, rowIndex, row);
  return ctx.stats;
}

/**
 * Findet die Zeile wieder, auch wenn das Sheet inzwischen sortiert wurde.
 * ref = { row, eventId, subject } aus der App.
 */
function locateRow_(sheet, map, ref) {
  if (!ref) throw new Error('Kein Termin angegeben.');
  const lastRow = sheet.getLastRow();
  const idIdx = map[CONFIG.COL_EVENT_ID.toLowerCase()];
  const subjIdx = map[CONFIG.COL_SUBJECT.toLowerCase()];

  if (ref.row >= 2 && ref.row <= lastRow) {
    const vals = sheet.getRange(ref.row, 1, 1, sheet.getLastColumn()).getValues()[0];
    const id = (vals[idIdx] || '').toString().trim();
    const subj = (vals[subjIdx] || '').toString().trim();
    if (ref.eventId ? id === ref.eventId : subj === ref.subject) return ref.row;
  }

  if (ref.eventId && lastRow >= 2) {
    const ids = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if ((ids[i][0] || '').toString().trim() === ref.eventId) return i + 2;
    }
  }

  throw new Error('Termin nicht gefunden – die Liste wurde inzwischen geändert. Bitte neu laden.');
}

function stamp_(sheet, map, rowIndex, user) {
  const when = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd.MM.yyyy HH:mm');
  writeCells_(sheet, rowIndex, map, { [WEBAPP.COL_GEAENDERT]: `${when} · ${user || 'App'}` });
}

/* =========================
   DATEN FÜR DIE APP
   ========================= */

function getAppData_(user) {
  const sheet = getSheet_();
  const map = ensureRequiredColumns_();
  const values = sheet.getDataRange().getValues();
  const changedIdx = map[WEBAPP.COL_GEAENDERT.toLowerCase()];
  const events = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rec = rowToRecord_(row, map);
    if (!rec.subject) continue;

    const status = normalizeStatus_(rec.status) || rec.status;
    if (status === CONFIG.STATUS.GELOESCHT) continue;

    const sd = parseDate_(rec.startDate);
    if (!sd) continue;
    const ed = parseDate_(rec.endDate) || sd;
    const v = parseVerschobenAuf_(rec.verschobenAuf);

    events.push({
      row: i + 1,
      eventId: rec.eventId,
      subject: rec.subject,
      date: dateToIso_(sd),
      endDate: dateToIso_(ed < sd ? sd : ed),
      allDay: rec.allDay,
      start: rec.allDay ? '' : timeToStr_(rec.startTime),
      end: rec.allDay ? '' : timeToStr_(rec.endTime),
      location: rec.location.trim(),
      description: rec.description.trim(),
      category: rec.category,
      status,
      recurring: !!rec.recurrence,
      verschobenAuf: v ? formatVerschoben_(v, false) : '',
      folgetermin: !!rec.folgeterminId,
      synced: !!rec.eventId,
      lastChange: changedIdx != null ? (row[changedIdx] || '').toString() : '',
    });
  }

  events.sort((a, b) => (a.date + (a.start || '00:00')).localeCompare(b.date + (b.start || '00:00')));

  return {
    events,
    categories: loadCategories_().names,
    today: dateToIso_(new Date()),
    user,
  };
}

function validateEventInput_(d) {
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^\d{2}:\d{2}$/;

  const subject = (d.subject || '').toString().trim();
  if (!subject) throw new Error('Bitte einen Titel eingeben.');
  if (subject.length > 200) throw new Error('Der Titel ist zu lang.');

  const date = (d.date || '').toString();
  if (!isoRe.test(date)) throw new Error('Bitte ein gültiges Datum wählen.');
  let endDate = isoRe.test(d.endDate || '') ? d.endDate : date;
  if (endDate < date) endDate = date;

  const allDay = !!d.allDay;
  const start = (d.start || '').toString();
  const end = (d.end || '').toString();
  if (!allDay) {
    if (!timeRe.test(start)) throw new Error('Bitte eine Beginn-Uhrzeit eingeben.');
    if (end && !timeRe.test(end)) throw new Error('Die End-Uhrzeit ist ungültig.');
    if (end && endDate === date && end <= start) throw new Error('Das Ende liegt vor dem Beginn.');
  }

  return {
    subject,
    date,
    endDate,
    allDay,
    start: allDay ? '' : start,
    end: allDay ? '' : end,
    location: (d.location || '').toString().trim(),
    description: (d.description || '').toString().trim(),
    category: (d.category || '').toString().trim(),
  };
}

/* =========================
   KLEINE HELFER
   ========================= */

function dateToIso_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function isoToDate_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function timeToStr_(v) {
  const pad = n => String(n).padStart(2, '0');
  if (isDate_(v)) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  const m = /^(\d{1,2}):(\d{2})/.exec((v || '').toString().trim());
  return m ? `${pad(m[1])}:${m[2]}` : '';
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
