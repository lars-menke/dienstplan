/******************************************************
 * Dienstplan V3 – Google Kalender ist Master
 * (docs/PWA-Spezifikation-V3.md, Etappe 1 und 2)
 *
 * Gehört ins SELBE Apps-Script-Projekt wie WebApp.gs und Dienstplan-Sync.gs.
 *
 * Datenquelle umschalten (Script-Eigenschaft DATENQUELLE):
 *   sheet    = bisheriges Verhalten (Sheet ist Master, 15-Minuten-Sync)
 *   calendar = V3 (App liest und schreibt direkt im Kalender)
 *
 * Im Apps-Script-Editor (Funktionen ohne Parameter, direkt startbar):
 *   migrateToCalendarV3Probelauf()  nur Protokoll, ändert nichts
 *   migrateToCalendarV3()           Umstellung (bei Zeitlimit einfach erneut starten)
 *   setDataSourceCalendar()         auf Kalender umschalten (entfernt 15-Min-Trigger)
 *   setDataSourceSheet()            Rückweg (legt 15-Min-Trigger wieder an)
 *   showDataSource()                zeigt die aktuelle Datenquelle
 *
 * Backup (Etappe 2, Kapitel 5):
 *   enableNightlyBackup()           täglicher Trigger gegen 03:00 Uhr → backupToSheet
 *   disableNightlyBackup()          Trigger entfernen
 *   backupToSheet()                 Backup sofort (auch im Menü „Dienstplan“)
 *   restoreFromBackup()             Menü „Termin aus Backup wiederherstellen…“
 ******************************************************/

const V3 = {
  SCHEMA: '3',
  PROP_SOURCE: 'DATENQUELLE',
  PROP_CATEGORIES: 'KATEGORIEN_V3',
  PROP_RENAMES: 'KATEGORIEN_V3_UMBENENNUNGEN', // alt (klein) → neu, bis der Kalender nachgezogen ist

  CACHE_KEY: 'dpv3data',
  CACHE_SECONDS: 300,          // so alt darf die Liste werden, dann werden die Änderungen nachgeholt
  CACHE_KEEP_SECONDS: 6 * 3600, // so lange bleibt die Liste gespeichert (Höchstwert von Google)
  FULL_READ_MS: 6 * 3600 * 1000, // spätestens dann wird wieder komplett gelesen
  LIST_FIELDS: 'nextPageToken,items(id,status,summary,description,location,start,end,colorId,recurrence,recurringEventId,eventType,extendedProperties)',
  CACHE_CHUNK_CHARS: 40000, // < 90 KB auch bei Umlauten (UTF-8)

  MAX_RUNTIME_MS: 5 * 60 * 1000,
  MAX_BULK: 100,
  MAX_PRIVATE_VALUE: 1024,

  DELETED_SHEET: 'Gelöscht',
  BACKUP_PREFIX: 'Backup vom ',
  BACKUP_HANDLER: 'backupToSheet',
  PROTECT_DESC: 'Dienstplan – nur das Script schreibt hier (V3 Kapitel 5.2)',
  // Aufbau von DataSheet im Sheet-Modus (Rückweg)
  SHEET_HEADERS: ['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event',
    'Description', 'Location', 'Category', 'Status', 'Verschoben auf', 'Folgetermin-ID', 'EventId',
    'LastSyncHash', 'Letzte Änderung', 'Recurrence'],
  BACKUP_HEADERS: ['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event',
    'Description', 'Location', 'Category', 'Status', 'Verschoben auf', 'Recurrence', 'EventId',
    'Letzte Änderung', 'Folgetermin-ID'],

  MSG_CALENDAR_DOWN: 'Google Kalender hat gerade nicht geantwortet. Bitte gleich nochmal versuchen.',
  MSG_SYNC_OBSOLETE: 'Nicht mehr nötig – Änderungen stehen sofort im Kalender.',
};

/* =========================
   DATENQUELLE
   ========================= */

function dataSource_() {
  return PropertiesService.getScriptProperties().getProperty(V3.PROP_SOURCE) === 'calendar' ? 'calendar' : 'sheet';
}

function isCalendarMode_() {
  return dataSource_() === 'calendar';
}

/** Alte Sheet-Funktionen (Sync, Import, Cleanup) sind im Kalender-Modus gesperrt. */
function assertSheetMode_(what) {
  if (isCalendarMode_()) {
    throw new Error(`${what} ist abgeschaltet: Der Google Kalender ist jetzt die Datenquelle (DATENQUELLE = calendar). ` +
      'Termine bitte in der App bearbeiten. Rückweg: setDataSourceSheet().');
  }
}

/**
 * Datenquelle umschalten. 'calendar' entfernt den 15-Minuten-Trigger,
 * 'sheet' legt ihn wieder an.
 */
function setDataSource(mode) {
  if (mode !== 'calendar' && mode !== 'sheet') {
    throw new Error("Bitte setDataSource('calendar') oder setDataSource('sheet') – oder setDataSourceCalendar() / setDataSourceSheet().");
  }
  // Rückweg: Enthält DataSheet schon ein Backup, wird es vorher aus dem Kalender
  // im alten Aufbau neu geschrieben – dann stehen auch alle Änderungen aus der Kalender-Zeit drin.
  let rebuilt = false;
  if (mode === 'sheet') {
    const sheet = getSheet_();
    if (v3IsBackupLayout_(sheet)) {
      v3WriteSheetLayout_(sheet);
      rebuilt = true;
    }
    v3Unprotect_(sheet);
    v3Unprotect_(getSs_().getSheetByName(CONFIG.CATEGORY_SHEET_NAME));
  }
  PropertiesService.getScriptProperties().setProperty(V3.PROP_SOURCE, mode);
  v3CacheClear_();
  removeAutoSyncTriggers_();
  let msg;
  if (mode === 'calendar') {
    enableNightlyBackup();
    msg = 'Datenquelle: Google Kalender. Der 15-Minuten-Sync ist entfernt, das nächtliche Backup ist eingerichtet.';
  } else {
    removeBackupTriggers_();
    ScriptApp.newTrigger('syncSheetToCalendar').timeBased().everyMinutes(15).create();
    msg = 'Datenquelle: Sheet (bisheriges Verhalten). Der 15-Minuten-Sync ist wieder eingerichtet, das nächtliche Backup ist aus. ' +
      (rebuilt
        ? 'DataSheet wurde aus dem Kalender neu geschrieben und enthält den aktuellen Stand.'
        : 'Achtung: Das Sheet zeigt den Stand vor der Kalender-Zeit; dort gemachte Änderungen stehen nicht im Sheet.');
  }
  Logger.log(msg);
  return msg;
}

function setDataSourceCalendar() { return setDataSource('calendar'); }
function setDataSourceSheet() { return setDataSource('sheet'); }
function showDataSource() {
  const msg = `Aktuelle Datenquelle: ${dataSource_()}`;
  Logger.log(msg);
  return msg;
}

/* =========================
   API (Datenquelle Kalender)
   ========================= */

/** Aktionen, die im Kalender-Modus von dieser Datei beantwortet werden. */
const V3_ACTIONS = ['getData', 'saveEvent', 'setStatus', 'syncAll', 'saveCategory', 'deleteCategory', 'saveEvents', 'setStatusBulk'];

function handleActionV3_(action, data, user) {
  switch (action) {
    case 'getData':
      // fresh: von Hand aktualisiert (Herunterziehen/Knopf) → direkt aus dem Kalender lesen
      return withAdminInfo_(v3GetAppData_(user.name, !!(data && data.fresh)), user);
    case 'saveEvent': return v3SaveEvent_(data, user.name);
    case 'setStatus': return v3SetStatus_(data, user.name);
    case 'syncAll': return Object.assign({ message: V3.MSG_SYNC_OBSOLETE }, v3GetAppData_(user.name));
    case 'saveCategory': return withAdminInfo_(v3SaveCategory_(data, user.name), user);
    case 'deleteCategory': return withAdminInfo_(v3DeleteCategory_(data, user.name), user);
    case 'saveEvents': return v3SaveEvents_(data, user.name);
    case 'setStatusBulk': return v3SetStatusBulk_(data, user.name);
    default: throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

/* --- Lesen --- */

/**
 * Terminliste für die App. Gelesen wird so wenig wie möglich:
 * - Zwischenspeicher jünger als 5 Minuten → direkt daraus
 * - älter, oder von Hand aktualisiert (fresh) → nur die seit dem letzten Lesen
 *   geänderten Termine aus dem Kalender holen (updatedMin, ein schneller Aufruf)
 * - kein Zwischenspeicher oder letztes komplettes Lesen > 6 Stunden → alles lesen
 */
function v3GetAppData_(userName, fresh) {
  let data = v3CacheGet_();
  const now = Date.now();
  if (data && (!data.fullAt || !data.listedAt || now - data.fullAt > V3.FULL_READ_MS)) data = null;
  if (data && (fresh || now - data.listedAt > V3.CACHE_SECONDS * 1000)) {
    data = v3CatchUp_(data);
    if (data) v3CachePut_(data);
  }
  if (!data) {
    const started = Date.now();
    const cats = v3Categories_();
    data = v3MergeEvents_({ events: [] }, v3ListEvents_({ forApp: true }), [], cats);
    data.fullAt = started;
    data.listedAt = started;
    v3CachePut_(data);
  }
  const out = Object.assign({}, data, { today: dateToIso_(new Date()), user: userName });
  delete out.listedAt;
  delete out.fullAt;
  return out;
}

/** Holt nur die Änderungen seit dem letzten Lesen nach. null → bitte komplett lesen. */
function v3CatchUp_(data) {
  const started = Date.now();
  let items;
  try {
    // 2 Minuten Puffer gegen Uhrzeit-Unterschiede; doppelt Geholtes schadet nicht
    items = v3ListEvents_({ forApp: true, updatedMin: new Date(data.listedAt - 2 * 60 * 1000).toISOString(), raw: true });
  } catch (e) {
    Logger.log('Nachholen fehlgeschlagen, lese komplett: ' + errMsg_(e));
    return null;
  }
  const changed = [];
  const removed = [];
  items.forEach(ev => {
    if (ev.recurringEventId) return; // Ausnahmen einer Serie: wie beim kompletten Lesen ignorieren
    if (ev.status === 'cancelled' || (ev.eventType || 'default').toLowerCase() !== 'default') removed.push(ev.id);
    else changed.push(ev);
  });
  const out = v3MergeEvents_(data, changed, removed, v3Categories_());
  out.listedAt = started;
  return out;
}

/** Termine in die gespeicherte Liste einarbeiten, sortieren, Kategorien zählen. */
function v3MergeEvents_(data, changed, removedIds, cats) {
  const drop = {};
  (removedIds || []).forEach(id => { drop[id] = true; });
  const fresh = {};
  (changed || []).forEach(ev => {
    if (!ev || !ev.id) return;
    if (ev.status === 'cancelled') { drop[ev.id] = true; return; }
    fresh[ev.id] = v3ToApp_(ev, v3Fields_(ev, cats));
  });
  const events = (data.events || []).filter(e => !drop[e.eventId] && !fresh[e.eventId]);
  Object.keys(fresh).forEach(id => { if (!drop[id]) events.push(fresh[id]); });
  events.sort((a, b) => (a.date + (a.start || '00:00')).localeCompare(b.date + (b.start || '00:00')));
  const usage = {};
  events.forEach(e => {
    const k = (e.category || '').toLowerCase();
    if (k) usage[k] = (usage[k] || 0) + 1;
  });
  return Object.assign({}, data, {
    events,
    categoryList: cats.list.map(c => ({ name: c.name, colorId: c.colorId, count: usage[c.name.toLowerCase()] || 0 })),
  });
}

/**
 * Nach dem Schreiben: die geschriebenen Termine direkt in die gespeicherte Liste
 * übernehmen statt den Kalender neu zu lesen.
 * changed: geänderte/neue Kalendertermine (Antwort von insert/update), removedIds: gelöschte IDs.
 */
function v3AppDataAfterWrite_(userName, changed, removedIds, cats) {
  const data = v3CacheGet_();
  if (data && data.fullAt && data.listedAt) v3CachePut_(v3MergeEvents_(data, changed, removedIds, cats || v3Categories_()));
  return v3GetAppData_(userName);
}

/**
 * Alle Termine ab 1. Januar des Vorjahres, ein Eintrag pro Serie.
 * opts.forApp: nur die Felder, die die App braucht (deutlich weniger Daten)
 * opts.updatedMin: nur seit diesem Zeitpunkt geänderte (inkl. gelöschte) Termine
 * opts.raw: ungefiltert zurückgeben (gelöschte, Ausnahmen, Sondertypen inklusive)
 */
function v3ListEvents_(opts) {
  opts = opts || {};
  const timeMin = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
  const out = [];
  let pageToken;
  do {
    const params = {
      timeMin,
      singleEvents: false,
      showDeleted: !!opts.updatedMin,
      maxResults: 2500,
      pageToken,
    };
    if (opts.forApp) params.fields = V3.LIST_FIELDS;
    if (opts.updatedMin) params.updatedMin = opts.updatedMin;
    const resp = v3Cal_(() => Calendar.Events.list(CONFIG.CALENDAR_ID, params));
    (resp.items || []).forEach(ev => {
      if (opts.raw) { out.push(ev); return; }
      if (ev.status === 'cancelled') return;
      if (ev.recurringEventId) return; // einzelne Ausnahmen einer Serie: bewusst nicht gesondert (V3 2.5)
      if ((ev.eventType || 'default').toLowerCase() !== 'default') return;
      out.push(ev);
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/* --- Schreiben --- */

function v3SaveEvent_(data, userName) {
  return withWebLock_(() => {
    const input = validateEventInput_(data);
    const id = data.eventId || (data.ref && data.ref.eventId) || '';
    const cats = v3Categories_();
    const result = v3SaveOne_(id, input, cats, userName);
    return Object.assign({ message: result.kind === 'created' ? 'Termin angelegt.' : 'Gespeichert.', warning: false },
      v3AppDataAfterWrite_(userName, [result.ev], [], cats));
  });
}

/** Einen Termin anlegen (ohne id) oder ändern. → { kind: 'created'|'updated', ev } */
function v3SaveOne_(id, input, cats, userName) {
  const values = {
    subject: input.subject,
    desc: input.description,
    cat: input.category,
    location: input.location,
    date: input.date,
    endDate: input.endDate,
    allDay: input.allDay,
    start: input.start,
    end: input.end,
    changed: v3Stamp_(userName),
  };
  if (id) {
    const ev = v3GetEvent_(id);
    if (!ev) throw new Error('Termin nicht gefunden – er wurde inzwischen gelöscht. Bitte neu laden.');
    const f = Object.assign(v3Fields_(ev, cats), values);
    return { kind: 'updated', ev: v3Update_(ev, f, cats) };
  }
  const f = Object.assign({
    status: CONFIG.STATUS.AKTIV, movedTo: '', movedToText: '', movedFrom: '', recurrence: '',
  }, values);
  return { kind: 'created', ev: v3Insert_(f, cats) };
}

function v3SetStatus_(data, userName) {
  return withWebLock_(() => {
    const S = CONFIG.STATUS;
    const status = normalizeStatus_(data.status);
    const id = (data.ref && data.ref.eventId) || data.eventId;
    const ev = v3GetEvent_(id);
    if (!ev) throw new Error('Termin nicht gefunden – er wurde inzwischen gelöscht. Bitte neu laden.');
    const cats = v3Categories_();
    const f = v3Fields_(ev, cats);
    const stamp = v3Stamp_(userName);
    const changed = [];
    const removed = [];
    let message;

    switch (status) {
      case S.ABGESAGT:
        Object.assign(f, { status: S.ABGESAGT, changed: stamp });
        changed.push(v3Update_(ev, f, cats));
        message = 'Termin abgesagt.';
        break;

      case S.AKTIV:
        // Folgetermin-Verknüpfung bleibt erhalten (der neue Termin besteht weiter)
        Object.assign(f, { status: S.AKTIV, movedToText: '', changed: stamp });
        changed.push(v3Update_(ev, f, cats));
        message = 'Termin ist wieder aktiv.';
        break;

      case S.VERSCHOBEN: {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.newDate || '')) throw new Error('Bitte ein neues Datum wählen.');
        const newTime = /^\d{2}:\d{2}$/.test(data.newTime || '') ? data.newTime : '';
        const target = newTime ? `${data.newDate}T${newTime}` : data.newDate;
        if (f.movedTo && v3GetEvent_(f.movedTo)) {
          Object.assign(f, { status: S.VERSCHOBEN, movedToText: target, changed: stamp });
          changed.push(v3Update_(ev, f, cats));
          message = 'Als verschoben markiert (neuer Termin war schon angelegt).';
        } else {
          const follow = v3FollowUpFields_(f, data.newDate, newTime, ev.id, stamp);
          const created = v3Insert_(follow, cats);
          Object.assign(f, { status: S.VERSCHOBEN, movedTo: created.id, movedToText: target, changed: stamp });
          changed.push(created, v3Update_(ev, f, cats));
          message = 'Termin verschoben – der neue Termin ist angelegt.';
        }
        break;
      }

      case S.LOESCHEN:
        // erst sichern (V3 5.3), dann löschen
        v3WriteDeleted_(ev, f, userName);
        v3Cal_(() => Calendar.Events.remove(CONFIG.CALENDAR_ID, ev.id, { sendUpdates: 'none' }));
        removed.push(ev.id);
        message = 'Termin gelöscht.';
        break;

      default:
        throw new Error(`Unbekannter Status: ${data.status}`);
    }

    return Object.assign({ message, warning: false }, v3AppDataAfterWrite_(userName, changed, removed, cats));
  });
}

/** { events: [...] } – bis 100 Termine anlegen/ändern (Import, Tabellenansicht). */
function v3SaveEvents_(data, userName) {
  const items = Array.isArray(data.events) ? data.events : [];
  if (!items.length) throw new Error('Keine Termine übergeben.');
  if (items.length > V3.MAX_BULK) throw new Error(`Höchstens ${V3.MAX_BULK} Termine pro Aufruf.`);
  return withWebLock_(() => {
    const t0 = Date.now();
    const cats = v3Categories_();
    let created = 0;
    let updated = 0;
    const failed = [];
    const changedEvents = [];
    items.forEach((item, index) => {
      if (Date.now() - t0 > V3.MAX_RUNTIME_MS) {
        failed.push({ index, error: 'Zeitlimit erreicht – bitte diesen Termin erneut senden.' });
        return;
      }
      try {
        const input = validateEventInput_(item || {});
        const r = v3SaveOne_((item && item.eventId) || '', input, cats, userName);
        changedEvents.push(r.ev);
        if (r.kind === 'created') created++; else updated++;
      } catch (e) {
        failed.push({ index, error: errMsg_(e) });
      }
    });
    const message = `${created} angelegt, ${updated} geändert${failed.length ? `, ${failed.length} Fehler` : ''}.`;
    return Object.assign({ created, updated, failed, message, warning: failed.length > 0 },
      v3AppDataAfterWrite_(userName, changedEvents, [], cats));
  });
}

/** { eventIds: [...], status } – nur ABGESAGT und AKTIV. */
function v3SetStatusBulk_(data, userName) {
  const S = CONFIG.STATUS;
  const status = normalizeStatus_(data.status);
  if (status !== S.ABGESAGT && status !== S.AKTIV) throw new Error('Mehrfach geht nur „Absagen“ und „Wieder aktivieren“.');
  const ids = Array.isArray(data.eventIds) ? data.eventIds : [];
  if (!ids.length) throw new Error('Keine Termine übergeben.');
  if (ids.length > V3.MAX_BULK) throw new Error(`Höchstens ${V3.MAX_BULK} Termine pro Aufruf.`);
  return withWebLock_(() => {
    const t0 = Date.now();
    const cats = v3Categories_();
    const stamp = v3Stamp_(userName);
    let updated = 0;
    const failed = [];
    const changedEvents = [];
    ids.forEach((id, index) => {
      if (Date.now() - t0 > V3.MAX_RUNTIME_MS) { failed.push({ index, error: 'Zeitlimit erreicht.' }); return; }
      try {
        const ev = v3GetEvent_(id);
        if (!ev) throw new Error('Termin nicht gefunden.');
        const f = v3Fields_(ev, cats);
        f.status = status;
        f.changed = stamp;
        if (status === S.AKTIV) f.movedToText = '';
        changedEvents.push(v3Update_(ev, f, cats));
        updated++;
      } catch (e) {
        failed.push({ index, error: errMsg_(e) });
      }
    });
    const word = status === S.ABGESAGT ? 'abgesagt' : 'wieder aktiv';
    const message = `${updated} ${updated === 1 ? 'Termin' : 'Termine'} ${word}${failed.length ? `, ${failed.length} Fehler` : ''}.`;
    return Object.assign({ updated, failed, message, warning: failed.length > 0 },
      v3AppDataAfterWrite_(userName, changedEvents, [], cats));
  });
}

/* =========================
   KATEGORIEN (V3 Kapitel 3)
   ========================= */

/** [{ name, colorId }] aus KATEGORIEN_V3; vor der Umstellung aus dem Blatt Categories. */
function v3LoadCategoryList_() {
  const raw = PropertiesService.getScriptProperties().getProperty(V3.PROP_CATEGORIES);
  if (raw == null) return loadCategories_().list.map(c => ({ name: c.name, colorId: Number(c.colorId) || c.colorId }));
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    throw new Error('Kategorien sind beschädigt (Script-Eigenschaft KATEGORIEN_V3).');
  }
}

function v3SaveCategoryList_(list) {
  PropertiesService.getScriptProperties().setProperty(V3.PROP_CATEGORIES, JSON.stringify(list));
}

/** Gleiche Struktur wie loadCategories_(): byName, byColor, canonical, names, list. */
function v3Categories_(list) {
  // renames: einmal lesen statt pro Termin (Script-Eigenschaften sind langsam)
  const result = { byName: {}, byColor: {}, canonical: {}, names: [], list: [], renames: v3Renames_() };
  const colorCount = {};
  (list || v3LoadCategoryList_()).forEach(c => {
    const name = String(c.name || '').trim();
    const colorId = String(c.colorId || '').trim();
    if (!name) return;
    result.byName[name.toLowerCase()] = colorId;
    result.canonical[name.toLowerCase()] = name;
    result.names.push(name);
    result.list.push({ name, colorId: Number(colorId) || colorId });
    if (colorId) {
      colorCount[colorId] = (colorCount[colorId] || 0) + 1;
      result.byColor[colorId] = colorCount[colorId] === 1 ? name : null; // nur eindeutige Farben zählen
    }
  });
  return result;
}

function v3Renames_() {
  const raw = PropertiesService.getScriptProperties().getProperty(V3.PROP_RENAMES);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function v3SaveCategory_(data, userName) {
  return withWebLock_(() => {
    const name = (data.name || '').toString().trim();
    const colorId = String(data.colorId || '').trim();
    const oldName = (data.oldName || '').toString().trim();
    if (!name) throw new Error('Bitte einen Namen eingeben.');
    if (name.length > MAX_CATEGORY_NAME) throw new Error(`Der Name ist zu lang (höchstens ${MAX_CATEGORY_NAME} Zeichen).`);
    if (RESERVED_COLORS.includes(colorId)) throw new Error('Mandarine und Graphit sind für „Verschoben“ und „Abgesagt“ reserviert.');
    if (!CONFIG.CATEGORY_COLORS[colorId]) throw new Error('Bitte eine Farbe wählen.');

    const list = v3LoadCategoryList_();
    const existing = oldName ? list.find(c => c.name.toLowerCase() === oldName.toLowerCase()) : null;
    if (oldName && !existing) throw new Error('Diese Kategorie gibt es nicht mehr. Bitte neu laden.');
    if (list.some(c => c !== existing && c.name.toLowerCase() === name.toLowerCase())) throw new Error('Diese Kategorie gibt es schon.');

    let message;
    if (existing) {
      const used = v3CategoryUsage_()[existing.name.toLowerCase()] || 0;
      const renamed = existing.name !== name;
      const recolored = String(existing.colorId) !== colorId;
      if (renamed) {
        const renames = v3Renames_();
        Object.keys(renames).forEach(k => { if (renames[k].toLowerCase() === existing.name.toLowerCase()) renames[k] = name; });
        renames[existing.name.toLowerCase()] = name;
        PropertiesService.getScriptProperties().setProperty(V3.PROP_RENAMES, JSON.stringify(renames));
      }
      existing.name = name;
      existing.colorId = Number(colorId);
      v3SaveCategoryList_(list);
      if ((renamed || recolored) && used > 0) {
        scheduleCalendarRefresh_();
        message = 'Gespeichert. Der Kalender wird in den nächsten Minuten aktualisiert.';
      } else {
        message = 'Gespeichert.';
      }
    } else {
      list.push({ name, colorId: Number(colorId) });
      v3SaveCategoryList_(list);
      message = 'Kategorie angelegt.';
    }
    v3CacheClear_();
    return Object.assign({ message }, v3GetAppData_(userName));
  });
}

function v3DeleteCategory_(data, userName) {
  return withWebLock_(() => {
    const name = (data.name || '').toString().trim();
    const list = v3LoadCategoryList_();
    const idx = list.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error('Diese Kategorie gibt es nicht mehr. Bitte neu laden.');
    const count = v3CategoryUsage_()[name.toLowerCase()] || 0;
    if (count > 0) throw new Error(`Wird von ${count} ${count === 1 ? 'Termin' : 'Terminen'} genutzt – erst die Termine umstellen.`);
    const removed = list.splice(idx, 1)[0];
    v3SaveCategoryList_(list);
    v3CacheClear_();
    return Object.assign({ message: `Kategorie „${removed.name}“ gelöscht.` }, v3GetAppData_(userName));
  });
}

function v3CategoryUsage_() {
  const usage = {};
  v3GetAppData_('').events.forEach(e => {
    const k = (e.category || '').toLowerCase();
    if (k) usage[k] = (usage[k] || 0) + 1;
  });
  return usage;
}

/**
 * Vom einmaligen Trigger aufgerufen (runScheduledRefresh): schreibt Termine neu,
 * deren Kategorie umbenannt wurde oder deren Kategoriefarbe sich geändert hat.
 * Nach 5 Minuten plant er sich für den Rest selbst neu ein.
 */
function v3RefreshCalendar_() {
  const t0 = Date.now();
  const cats = v3Categories_();
  let updated = 0;
  let done = true;
  for (const ev of v3ListEvents_()) {
    if (Date.now() - t0 > V3.MAX_RUNTIME_MS) { done = false; break; }
    const f = v3Fields_(ev, cats); // Umbenennungen sind hier schon angewendet
    if (!f.cat) continue;
    const res = v3Resource_(f, cats);
    const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
    const needs = priv.cat !== f.cat || String(ev.colorId || '') !== String(res.colorId || '');
    if (!needs) continue;
    try {
      v3Update_(ev, f, cats);
      updated++;
    } catch (e) {
      Logger.log(`Nachziehen fehlgeschlagen (${ev.id}): ${errMsg_(e)}`);
    }
  }
  if (done) PropertiesService.getScriptProperties().deleteProperty(V3.PROP_RENAMES);
  else scheduleCalendarRefresh_();
  v3CacheClear_();
  Logger.log(`Kalender nachgezogen: ${updated} Termine${done ? '' : ' – Rest folgt im nächsten Lauf'}.`);
}

/* =========================
   TERMIN ↔ ZUSATZFELDER (V3 Kapitel 2)
   ========================= */

/**
 * Felder eines Kalendertermins: aus den privaten Zusatzfeldern,
 * sonst aus Titel/Beschreibung/Farbe abgeleitet (V3 2.4).
 */
function v3Fields_(ev, cats) {
  const S = CONFIG.STATUS;
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const times = v3Times_(ev);
  const rrule = (ev.recurrence || []).find(l => /^RRULE:/i.test(l)) || '';
  const base = Object.assign({ location: ev.location || '', recurrence: rrule }, times);
  const renames = cats.renames || {};
  const mapCat = name => {
    if (!name) return '';
    const renamed = renames[name.toLowerCase()];
    const n = renamed || name;
    return (cats.canonical && cats.canonical[n.toLowerCase()]) || n;
  };

  if (priv.dp) {
    return Object.assign(base, {
      managed: true,
      subject: priv.subject || v3SplitTitle_(ev.summary || '').subject,
      desc: priv.desc != null ? priv.desc : v3DeriveDesc_(ev.description || '').rest,
      cat: mapCat(priv.cat || ''),
      status: normalizeStatus_(priv.status) || S.AKTIV,
      movedTo: priv.movedTo || '',
      movedToText: priv.movedToText || '',
      movedFrom: priv.movedFrom || '',
      changed: priv.changed || '',
    });
  }

  // Ableitung für Termine ohne Zusatzfelder
  const title = v3SplitTitle_(ev.summary || '');
  const parts = v3DeriveDesc_(ev.description || '');
  let cat = parts.category ? mapCat(parts.category) : '';
  if (!cat && ev.colorId && cats.byColor && cats.byColor[String(ev.colorId)]) cat = cats.byColor[String(ev.colorId)];
  return Object.assign(base, {
    managed: false,
    subject: title.subject,
    desc: parts.rest,
    cat,
    status: title.status,
    movedTo: '',
    movedToText: '',
    movedFrom: '',
    changed: '',
  });
}

/** Titel ohne Status-Präfix + Status aus dem Präfix. */
function v3SplitTitle_(summary) {
  const S = CONFIG.STATUS;
  const s = String(summary || '');
  if (s.startsWith(CONFIG.PREFIX_ABGESAGT)) return { status: S.ABGESAGT, subject: s.slice(CONFIG.PREFIX_ABGESAGT.length).trim() };
  if (s.startsWith(CONFIG.PREFIX_VERSCHOBEN)) {
    const i = s.indexOf(': ', CONFIG.PREFIX_VERSCHOBEN.length);
    return { status: S.VERSCHOBEN, subject: (i === -1 ? s.slice(CONFIG.PREFIX_VERSCHOBEN.length) : s.slice(i + 2)).trim() };
  }
  return { status: S.AKTIV, subject: s.trim() };
}

/** Beschreibung ohne Marker, Kategorie-Zeile und Status-Hinweis. → { category, rest } */
function v3DeriveDesc_(description) {
  const parts = stripCategoryLine_(stripMarker_(description || ''));
  let rest = parts.rest;
  const first = rest.split(/\n\s*\n/)[0] || '';
  if (/^❌ Dieser Termin wurde abgesagt\./.test(first) || /^↪️ Dieser Termin wurde verschoben/.test(first)) {
    rest = rest.slice(first.length).replace(/^\s+/, '');
  }
  return { category: parts.category, rest: rest.trim() };
}

/** Datum/Uhrzeit eines Termins in Europe/Berlin. */
function v3Times_(ev) {
  const fmt = (d, f) => Utilities.formatDate(d, CONFIG.TIMEZONE, f);
  if (ev.start && ev.start.date) {
    const date = ev.start.date;
    const endExcl = ev.end && ev.end.date ? ev.end.date : date;
    let endDate = dateToIso_(new Date(isoToDate_(endExcl).getTime() - 86400000));
    if (endDate < date) endDate = date;
    return { allDay: true, date, endDate, start: '', end: '' };
  }
  const s = new Date(ev.start.dateTime);
  const e = new Date((ev.end && ev.end.dateTime) || ev.start.dateTime);
  return { allDay: false, date: fmt(s, 'yyyy-MM-dd'), endDate: fmt(e, 'yyyy-MM-dd'), start: fmt(s, 'HH:mm'), end: fmt(e, 'HH:mm') };
}

/** Termin im Format der App (V3 Kapitel 4: ohne row, synced immer true). */
function v3ToApp_(ev, f) {
  const v = f.movedToText ? parseVerschobenAuf_(f.movedToText) : null;
  return {
    eventId: ev.id,
    subject: f.subject || '(ohne Titel)',
    date: f.date,
    endDate: f.endDate,
    allDay: f.allDay,
    start: f.start,
    end: f.end,
    location: f.location,
    description: f.desc,
    category: f.cat,
    status: f.status,
    recurring: !!(ev.recurrence && ev.recurrence.length),
    verschobenAuf: v ? formatVerschoben_(v, false) : '',
    folgetermin: !!f.movedTo,
    synced: true,
    lastChange: f.changed,
  };
}

/** Sichtbarer Termin (wie bisher über buildEventResource_, ohne Marker) + private Zusatzfelder. */
function v3Resource_(f, cats) {
  const rec = {
    subject: f.subject,
    description: f.desc,
    location: f.location,
    category: f.cat,
    recurrence: f.recurrence,
    startDate: isoToDate_(f.date),
    endDate: isoToDate_(f.endDate || f.date),
    startTime: f.allDay ? '' : f.start,
    endTime: f.allDay ? '' : f.end,
    allDay: !!f.allDay,
  };
  const t = buildEventTimes_(rec);
  const moved = f.status === CONFIG.STATUS.VERSCHOBEN && f.movedToText ? parseVerschobenAuf_(f.movedToText) : null;
  const res = buildEventResource_(rec, t.start, t.end, t.isAllDay, cats, f.status, moved, { noMarker: true });
  const cat = categoryInfo_(rec, cats);

  const priv = {
    dp: V3.SCHEMA,
    subject: f.subject || '',
    desc: f.desc || '',
    cat: cat.name || '',
    status: f.status || CONFIG.STATUS.AKTIV,
    movedTo: f.movedTo || '',
    movedToText: f.movedToText || '',
    movedFrom: f.movedFrom || '',
    changed: f.changed || '',
  };
  // Google erlaubt höchstens 1024 Zeichen pro Wert; lange Beschreibungen werden aus dem sichtbaren Text rekonstruiert
  Object.keys(priv).forEach(k => {
    if (String(priv[k]).length > V3.MAX_PRIVATE_VALUE) {
      if (k === 'desc') delete priv[k];
      else priv[k] = String(priv[k]).slice(0, V3.MAX_PRIVATE_VALUE);
    }
  });
  res.extendedProperties = { private: priv };
  return res;
}

function v3Insert_(f, cats) {
  return v3Cal_(() => Calendar.Events.insert(v3Resource_(f, cats), CONFIG.CALENDAR_ID, { sendUpdates: 'none' }));
}

/** Vollständig aktualisieren; Erinnerungen, Teilnehmer, EXDATE usw. bleiben erhalten. */
function v3Update_(existing, f, cats) {
  const payload = v3Resource_(f, cats);
  const merged = mergeForUpdate_(existing, payload);
  const shared = existing.extendedProperties && existing.extendedProperties.shared;
  merged.extendedProperties = shared ? { shared, private: payload.extendedProperties.private } : { private: payload.extendedProperties.private };
  return v3Cal_(() => Calendar.Events.update(merged, CONFIG.CALENDAR_ID, existing.id, { sendUpdates: 'none' }));
}

/** Termin holen; null, wenn es ihn nicht (mehr) gibt. */
function v3GetEvent_(id) {
  if (!id) return null;
  try {
    const ev = Calendar.Events.get(CONFIG.CALENDAR_ID, id);
    return ev && ev.status !== 'cancelled' ? ev : null;
  } catch (e) {
    if (isGoneError_(e)) return null;
    return v3Cal_(() => { throw e; });
  }
}

/** Kalender-Aufruf; Fehler/Zeitüberschreitung von Google → verständliche Meldung (V3 Kapitel 4). */
function v3Cal_(fn) {
  try {
    return fn();
  } catch (e) {
    const msg = errMsg_(e);
    if (/API call to calendar|calendar\.events|Service invoked|timed out|Zeitüberschreitung|Backend Error|Internal error|Rate Limit|unavailable|Exceeded/i.test(msg)) {
      Logger.log('Kalender-Fehler: ' + msg);
      throw new Error(V3.MSG_CALENDAR_DOWN);
    }
    throw e;
  }
}

/** Folgetermin beim Verschieben: gleiche Dauer, gleiche Daten, Verknüpfung movedFrom. */
function v3FollowUpFields_(f, newDate, newTime, originId, stamp) {
  const vom = `(verschoben vom ${Utilities.formatDate(isoToDate_(f.date), CONFIG.TIMEZONE, 'dd.MM.yyyy')})`;
  const baseDesc = (f.desc || '').replace(/^\(verschoben vom \d{2}\.\d{2}\.\d{4}\)\s*/, '');
  const out = {
    subject: f.subject, cat: f.cat, location: f.location, recurrence: '',
    desc: baseDesc ? `${vom}\n\n${baseDesc}` : vom,
    status: CONFIG.STATUS.AKTIV, movedTo: '', movedToText: '', movedFrom: originId, changed: stamp,
  };
  const days = Math.round((isoToDate_(f.endDate || f.date) - isoToDate_(f.date)) / 86400000);
  if (f.allDay) {
    return Object.assign(out, { allDay: true, date: newDate, endDate: dateToIso_(new Date(isoToDate_(newDate).getTime() + days * 86400000)), start: '', end: '' });
  }
  const mins = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const startMin = mins(newTime) != null ? mins(newTime) : mins(f.start);
  const oldStart = mins(f.start);
  const oldEnd = mins(f.end);
  const duration = oldStart != null && oldEnd != null ? oldEnd - oldStart + days * 1440 : CONFIG.DEFAULT_DURATION_MIN;
  const [y, m, d] = newDate.split('-').map(Number);
  const s = new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
  const e = new Date(s.getTime() + Math.max(duration, 1) * 60000);
  const fmt = (dt, p) => Utilities.formatDate(dt, CONFIG.TIMEZONE, p);
  return Object.assign(out, { allDay: false, date: fmt(s, 'yyyy-MM-dd'), endDate: fmt(e, 'yyyy-MM-dd'), start: fmt(s, 'HH:mm'), end: fmt(e, 'HH:mm') });
}

function v3Stamp_(userName) {
  return `${Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd.MM.yyyy HH:mm')} · ${userName || 'App'}`;
}

/* =========================
   BLATT „Gelöscht“ (V3 Kapitel 5.3)
   ========================= */

function v3BackupRow_(ev, f) {
  const v = f.movedToText ? parseVerschobenAuf_(f.movedToText) : null;
  return [
    f.subject, isoToDate_(f.date), f.allDay ? '' : f.start, isoToDate_(f.endDate || f.date), f.allDay ? '' : f.end, !!f.allDay,
    f.desc, f.location, f.cat, f.status, v ? formatVerschoben_(v, false) : '', f.recurrence, ev.id, f.changed, f.movedTo,
  ];
}

function v3WriteDeleted_(ev, f, userName) {
  const ss = getSs_();
  const headers = V3.BACKUP_HEADERS.concat(['Gelöscht am', 'Gelöscht von']);
  let sheet = ss.getSheetByName(V3.DELETED_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(V3.DELETED_SHEET);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    v3Protect_(sheet);
  }
  sheet.appendRow(v3BackupRow_(ev, f).concat([
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd.MM.yyyy HH:mm'),
    userName || '',
  ]));
}

/* =========================
   CACHE (V3 Kapitel 4: Script-Cache, 5 Minuten, Teile < 90 KB)
   ========================= */

function v3CachePut_(data) {
  try {
    const json = JSON.stringify(data);
    const n = Math.ceil(json.length / V3.CACHE_CHUNK_CHARS) || 1;
    const obj = {};
    for (let i = 0; i < n; i++) obj[`${V3.CACHE_KEY}_${i}`] = json.slice(i * V3.CACHE_CHUNK_CHARS, (i + 1) * V3.CACHE_CHUNK_CHARS);
    obj[`${V3.CACHE_KEY}_n`] = String(n);
    CacheService.getScriptCache().putAll(obj, V3.CACHE_KEEP_SECONDS);
  } catch (e) {
    Logger.log('Cache nicht gespeichert: ' + errMsg_(e));
  }
}

function v3CacheGet_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(`${V3.CACHE_KEY}_n`));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(`${V3.CACHE_KEY}_${i}`);
    const parts = cache.getAll(keys);
    if (keys.some(k => parts[k] == null)) return null;
    return JSON.parse(keys.map(k => parts[k]).join(''));
  } catch (e) {
    return null;
  }
}

function v3CacheClear_() {
  try { CacheService.getScriptCache().remove(`${V3.CACHE_KEY}_n`); } catch (e) { /* egal */ }
}

/* =========================
   UMSTELLUNG (V3 Kapitel 6)
   ========================= */

/** Probelauf: nur Protokoll, keine Änderung. */
function migrateToCalendarV3Probelauf() {
  return migrateToCalendarV3(true);
}

/**
 * Einmalige Umstellung Sheet → Kalender.
 * 1. Kategorien → KATEGORIEN_V3
 * 2. Sheet-Zeilen mit EventId (Status ≠ GELÖSCHT): Zusatzfelder setzen, Titel/Beschreibung neu bauen, Marker entfernen
 * 3. Folgetermin-ID → movedTo / movedFrom
 * 4. Zeilen ohne EventId oder ohne Kalendertermin → nur Protokoll
 * Bricht nach 5 Minuten sauber ab; erneut starten überspringt schon umgestellte Termine (dp = 3).
 */
function migrateToCalendarV3(dryRun) {
  dryRun = dryRun === true;
  const t0 = Date.now();
  const S = CONFIG.STATUS;
  const log = [];
  const say = m => { log.push(m); Logger.log(m); };
  checkTimezone_();
  say(dryRun ? '=== PROBELAUF – es wird nichts geändert ===' : '=== UMSTELLUNG auf Kalender (V3) ===');

  // 1. Kategorien
  const props = PropertiesService.getScriptProperties();
  const sheetCats = loadCategories_().list.map(c => ({ name: c.name, colorId: Number(c.colorId) || c.colorId }));
  const existingRaw = props.getProperty(V3.PROP_CATEGORIES);
  let catList = existingRaw ? JSON.parse(existingRaw) : [];
  const missingCats = sheetCats.filter(c => !catList.some(x => x.name.toLowerCase() === c.name.toLowerCase()));
  catList = catList.concat(missingCats);
  say(`Kategorien: ${sheetCats.map(c => `${c.name} (${c.colorId})`).join(', ') || 'keine'}` +
    (existingRaw ? ` – in KATEGORIEN_V3 schon vorhanden, ergänzt: ${missingCats.length}` : ''));
  if (!dryRun) v3SaveCategoryList_(catList);
  const cats = v3Categories_(catList);

  // 2./3. Sheet-Zeilen
  const sheet = getSheet_();
  if (v3IsBackupLayout_(sheet)) {
    throw new Error('DataSheet enthält schon ein Backup aus dem Kalender – die Umstellung ist bereits erfolgt.');
  }
  const map = getHeaderMap_(sheet);
  const changedIdx = map[WEBAPP.COL_GEAENDERT.toLowerCase()];
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const rec = rowToRecord_(values[i], map);
    if (!rec.subject) continue;
    const status = normalizeStatus_(rec.status) || S.AKTIV;
    if (status === S.GELOESCHT || status === S.LOESCHEN) continue;
    rows.push({ rowIndex: i + 1, rec, status, changed: changedIdx != null ? String(values[i][changedIdx] || '') : '' });
  }
  const isEventId = id => !!id && !/^Zeile\s/i.test(id);
  const movedFrom = {}; // Folgetermin-ID → EventId des Ursprungs
  rows.forEach(r => { if (isEventId(r.rec.folgeterminId) && r.rec.eventId) movedFrom[r.rec.folgeterminId] = r.rec.eventId; });

  const stats = { converted: 0, already: 0, noId: [], missing: [], errors: [] };
  const label = r => `Zeile ${r.rowIndex}: ${r.rec.subject} (${r.rec.startDate instanceof Date ? Utilities.formatDate(r.rec.startDate, CONFIG.TIMEZONE, 'dd.MM.yyyy') : r.rec.startDate})`;
  let aborted = false;

  for (const r of rows) {
    if (Date.now() - t0 > V3.MAX_RUNTIME_MS) { aborted = true; break; }
    if (!r.rec.eventId) { stats.noId.push(label(r)); continue; }
    let ev;
    try {
      ev = v3GetEvent_(r.rec.eventId);
    } catch (e) {
      stats.errors.push(`${label(r)} – ${errMsg_(e)}`);
      continue;
    }
    if (!ev) { stats.missing.push(label(r)); continue; }
    const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
    if (priv.dp === V3.SCHEMA) { stats.already++; continue; }

    try {
      const f = v3FieldsFromRow_(r, movedFrom, isEventId);
      if (dryRun) {
        const preview = v3Resource_(f, cats);
        if (stats.converted < 15) say(`würde umstellen: ${label(r)} → „${preview.summary}“`);
      } else {
        v3Update_(ev, f, cats);
      }
      stats.converted++;
    } catch (e) {
      stats.errors.push(`${label(r)} – ${errMsg_(e)}`);
    }
  }

  // 4./5. Protokoll
  say(`${dryRun ? 'Würde umstellen' : 'Umgestellt'}: ${stats.converted}`);
  say(`Schon umgestellt (übersprungen): ${stats.already}`);
  say(`Ohne EventId (nichts angelegt): ${stats.noId.length}${stats.noId.length ? '\n  ' + stats.noId.join('\n  ') : ''}`);
  say(`Termin fehlt im Kalender (nichts angelegt): ${stats.missing.length}${stats.missing.length ? '\n  ' + stats.missing.join('\n  ') : ''}`);
  say(`Fehler: ${stats.errors.length}${stats.errors.length ? '\n  ' + stats.errors.join('\n  ') : ''}`);
  if (aborted) say('⏱ Zeitlimit nach 5 Minuten – bitte migrateToCalendarV3() einfach erneut starten, es geht dort weiter.');
  else if (!dryRun) say('Fertig. Nächster Schritt: setDataSourceCalendar().');
  if (!dryRun) v3CacheClear_();
  return log.join('\n');
}

/** Felder aus einer Sheet-Zeile (Umstellung). */
function v3FieldsFromRow_(r, movedFromMap, isEventId) {
  const rec = r.rec;
  const sd = parseDate_(rec.startDate);
  if (!sd) throw new Error('Start Date fehlt/ungültig');
  const ed = parseDate_(rec.endDate) || sd;
  const v = parseVerschobenAuf_(rec.verschobenAuf);
  const pad = n => String(n).padStart(2, '0');
  const movedToText = v ? `${dateToIso_(v.date)}${v.hasTime ? `T${pad(v.hours)}:${pad(v.minutes)}` : ''}` : '';
  return {
    subject: rec.subject,
    desc: stripCategoryLine_(rec.description || '').rest,
    cat: rec.category,
    location: (rec.location || '').trim(),
    recurrence: rec.recurrence,
    allDay: !!rec.allDay,
    date: dateToIso_(sd),
    endDate: dateToIso_(ed < sd ? sd : ed),
    start: rec.allDay ? '' : timeToStr_(rec.startTime),
    end: rec.allDay ? '' : timeToStr_(rec.endTime),
    status: r.status,
    movedTo: isEventId(rec.folgeterminId) ? rec.folgeterminId : '',
    movedToText: r.status === CONFIG.STATUS.VERSCHOBEN ? movedToText : '',
    movedFrom: movedFromMap[rec.eventId] || '',
    changed: r.changed,
  };
}

/* =========================
   BACKUP INS SHEET (V3 Kapitel 5.1)
   ========================= */

/**
 * Schreibt alle Termine aus dem Kalender nach DataSheet (Zeile 1 Hinweis, Zeile 2 Kopfzeile)
 * und die Kategorien nach Categories. Läuft nachts per Trigger (enableNightlyBackup).
 */
function backupToSheet() {
  if (!isCalendarMode_()) {
    const msg = 'Kein Backup: Datenquelle ist das Sheet (DATENQUELLE = sheet). Dort ist DataSheet selbst der Master.';
    Logger.log(msg);
    toast_(msg, 10);
    return msg;
  }
  const now = new Date();
  const cats = v3Categories_();
  const rows = v3SortedFields_(v3ListEvents_({ forApp: true }), cats).map(x => v3BackupRow_(x.ev, x.f));
  const hint = `${V3.BACKUP_PREFIX}${Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd.MM.yyyy, HH:mm')} – ` +
    'Änderungen hier haben keine Wirkung. Termine bitte in der App bearbeiten.';

  const ss = getSs_();
  const sheet = getSheet_();
  v3WriteTable_(sheet, [[hint], V3.BACKUP_HEADERS].concat(rows), 2);
  sheet.getRange(1, 1).setFontStyle('italic');

  let catSheet = ss.getSheetByName(CONFIG.CATEGORY_SHEET_NAME);
  if (!catSheet) catSheet = ss.insertSheet(CONFIG.CATEGORY_SHEET_NAME);
  v3WriteCategorySheet_(catSheet, cats.list);

  [sheet, catSheet, ss.getSheetByName(V3.DELETED_SHEET)].forEach(v3Protect_);

  const msg = `Backup fertig: ${rows.length} Termine, ${cats.list.length} Kategorien.`;
  Logger.log(msg);
  toast_(msg, 8);
  return msg;
}

/** Täglicher Trigger gegen 03:00 Uhr (Google startet ihn irgendwann zwischen 3 und 4 Uhr). */
function enableNightlyBackup() {
  removeBackupTriggers_();
  ScriptApp.newTrigger(V3.BACKUP_HANDLER).timeBased().atHour(3).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  const msg = 'Nächtliches Backup eingerichtet (täglich gegen 03:00 Uhr).';
  Logger.log(msg);
  return msg;
}

function disableNightlyBackup() {
  removeBackupTriggers_();
  const msg = 'Nächtliches Backup ausgeschaltet.';
  Logger.log(msg);
  return msg;
}

function removeBackupTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === V3.BACKUP_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Termine mit ihren Feldern, nach Datum und Beginn sortiert. */
function v3SortedFields_(events, cats) {
  return events
    .map(ev => ({ ev, f: v3Fields_(ev, cats) }))
    .sort((a, b) => (a.f.date + (a.f.start || '00:00')).localeCompare(b.f.date + (b.f.start || '00:00')));
}

/** Blatt komplett ersetzen: Inhalt, Formate, Dropdowns und bedingte Formatierung weg, dann schreiben. */
function v3WriteTable_(sheet, rows, frozenRows) {
  const width = Math.max.apply(null, rows.map(r => r.length));
  const data = rows.map(r => r.concat(new Array(width - r.length).fill('')));
  sheet.clear();
  sheet.clearConditionalFormatRules();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  if (sheet.getMaxRows() < data.length) sheet.insertRowsAfter(sheet.getMaxRows(), data.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  sheet.getRange(1, 1, data.length, width).setValues(data);
  sheet.setFrozenRows(frozenRows);
  sheet.getRange(frozenRows, 1, 1, width).setFontWeight('bold');
}

/** Blatt Categories: gleicher Aufbau wie bisher (Category · ColorId · Farbe), damit der Rückweg passt. */
function v3WriteCategorySheet_(catSheet, list) {
  const rows = list.map(c => [c.name, Number(c.colorId) || c.colorId, CONFIG.CATEGORY_COLORS[c.colorId] || '']);
  v3WriteTable_(catSheet, [['Category', 'ColorId', 'Farbe']].concat(rows), 1);
  if (rows.length) {
    catSheet.getRange(2, 3, rows.length, 1).setBackgrounds(list.map(c => [CONFIG.CATEGORY_COLOR_HEX[c.colorId] || null]));
  }
}

/** true, wenn DataSheet ein Backup enthält (Hinweiszeile in A1). */
function v3IsBackupLayout_(sheet) {
  return String(sheet.getRange(1, 1).getValue() || '').indexOf(V3.BACKUP_PREFIX) === 0;
}

/** Rückweg: DataSheet im alten Aufbau (Kopfzeile in Zeile 1) aus dem Kalender schreiben. */
function v3WriteSheetLayout_(sheet) {
  const cats = v3Categories_();
  const rows = v3SortedFields_(v3ListEvents_({ forApp: true }), cats).map(({ ev, f }) => {
    const b = v3BackupRow_(ev, f); // Subject … Folgetermin-ID in Backup-Reihenfolge
    const by = {};
    V3.BACKUP_HEADERS.forEach((h, i) => { by[h] = b[i]; });
    by.LastSyncHash = ''; // leer → der 15-Minuten-Sync schreibt jeden Termin einmal im alten Format
    return V3.SHEET_HEADERS.map(h => (by[h] == null ? '' : by[h]));
  });
  v3WriteTable_(sheet, [V3.SHEET_HEADERS].concat(rows), 1);
  v3WriteCategorySheet_(getSs_().getSheetByName(CONFIG.CATEGORY_SHEET_NAME) || getSs_().insertSheet(CONFIG.CATEGORY_SHEET_NAME), cats.list);
  try {
    setupSheet(); // Status-Dropdown und Farben wie gewohnt
  } catch (e) {
    Logger.log('Sheet einrichten nach Rückweg: ' + errMsg_(e));
  }
}

/* =========================
   SCHUTZ (V3 Kapitel 5.2)
   ========================= */

/** Nur der Eigentümer (und damit das Script) darf schreiben. */
function v3Protect_(sheet) {
  if (!sheet) return;
  try {
    const type = SpreadsheetApp.ProtectionType.SHEET;
    const p = sheet.getProtections(type).find(x => x.getDescription() === V3.PROTECT_DESC) ||
      sheet.protect().setDescription(V3.PROTECT_DESC);
    // Eigentümer und ausführender Nutzer lassen sich nicht entfernen (Google) – so bleiben nur sie.
    // Ohne Session.getEffectiveUser(), das bräuchte eine zusätzliche Berechtigung (userinfo.email).
    const editors = p.getEditors();
    if (editors.length) p.removeEditors(editors);
    if (p.canDomainEdit()) p.setDomainEdit(false);
  } catch (e) {
    Logger.log(`Schutz für „${sheet.getName()}“ nicht gesetzt: ${errMsg_(e)}`);
  }
}

function v3Unprotect_(sheet) {
  if (!sheet) return;
  try {
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .filter(x => x.getDescription() === V3.PROTECT_DESC)
      .forEach(x => x.remove());
  } catch (e) {
    Logger.log(`Schutz für „${sheet.getName()}“ nicht entfernt: ${errMsg_(e)}`);
  }
}

/* =========================
   WIEDERHERSTELLEN (V3 Kapitel 5.4)
   ========================= */

/** Menü: markierte Zeile in „Gelöscht“ oder „DataSheet“ wieder in den Kalender bringen. */
function restoreFromBackup() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSs_().getActiveSheet();
  try {
    const row = sheet.getActiveRange() ? sheet.getActiveRange().getRow() : 0;
    ui.alert('Termin wiederherstellen', v3RestoreRow_(sheet, row).message, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Termin wiederherstellen', errMsg_(e), ui.ButtonSet.OK);
  }
}

/** → { restored: bool, message, eventId } */
function v3RestoreRow_(sheet, rowIndex) {
  if (!isCalendarMode_()) throw new Error('Wiederherstellen geht nur, wenn der Google Kalender die Datenquelle ist.');
  const name = sheet.getName();
  if (name !== V3.DELETED_SHEET && name !== CONFIG.SHEET_NAME) {
    throw new Error(`Bitte zuerst im Blatt „${V3.DELETED_SHEET}“ oder „${CONFIG.SHEET_NAME}“ eine Terminzeile markieren.`);
  }
  const headerRow = name === CONFIG.SHEET_NAME && v3IsBackupLayout_(sheet) ? 2 : 1;
  if (!rowIndex || rowIndex <= headerRow || rowIndex > sheet.getLastRow()) {
    throw new Error('Bitte eine Terminzeile markieren (nicht die Kopfzeile).');
  }
  const width = sheet.getLastColumn();
  const map = {};
  sheet.getRange(headerRow, 1, 1, width).getValues()[0].forEach((h, i) => {
    const k = String(h || '').trim().toLowerCase();
    if (k && map[k] == null) map[k] = i;
  });
  if (map.eventid == null || map.subject == null) throw new Error('In diesem Blatt fehlen die Spalten „Subject“ oder „EventId“.');
  const rec = rowToRecord_(sheet.getRange(rowIndex, 1, 1, width).getValues()[0], map);
  if (!rec.subject) throw new Error('Die markierte Zeile ist leer.');

  if (rec.eventId && v3GetEvent_(rec.eventId)) {
    return { restored: false, message: 'Dieser Termin ist noch im Kalender.', eventId: rec.eventId };
  }

  return withWebLock_(() => {
    const S = CONFIG.STATUS;
    let status = normalizeStatus_(rec.status) || S.AKTIV;
    if (status === S.LOESCHEN || status === S.GELOESCHT) status = S.AKTIV;
    const oldId = rec.eventId;
    // Verknüpfungen: Ursprung (movedTo = alte ID) und Folgetermin (movedFrom = alte ID)
    const origins = oldId ? v3FindByPrivate_('movedTo', oldId) : [];
    const follows = oldId ? v3FindByPrivate_('movedFrom', oldId) : [];
    const exists = id => !!id && !/^Zeile\s/i.test(id) && !!v3GetEvent_(id);
    const movedFromMap = {};
    if (oldId && origins.length) movedFromMap[oldId] = origins[0].id;

    const f = v3FieldsFromRow_({ rec, status, changed: v3Stamp_('wiederhergestellt') }, movedFromMap, exists);
    const cats = v3Categories_();
    const created = v3Insert_(f, cats);

    origins.concat(follows).forEach(ev => {
      try {
        const g = v3Fields_(ev, cats);
        if (g.movedTo === oldId) g.movedTo = created.id;
        if (g.movedFrom === oldId) g.movedFrom = created.id;
        v3Update_(ev, g, cats);
      } catch (e) {
        Logger.log(`Verknüpfung nicht aktualisiert (${ev.id}): ${errMsg_(e)}`);
      }
    });

    sheet.getRange(rowIndex, map.eventid + 1).setValue(created.id);
    v3CacheClear_();
    const when = Utilities.formatDate(isoToDate_(f.date), CONFIG.TIMEZONE, 'dd.MM.yyyy') + (f.allDay ? '' : `, ${f.start} Uhr`);
    return {
      restored: true,
      eventId: created.id,
      message: `Wiederhergestellt: „${f.subject}“ am ${when}. Die neue EventId steht jetzt in der Zeile.`,
    };
  });
}

/** Termine mit einem bestimmten privaten Zusatzfeld (z. B. movedTo = ID). */
function v3FindByPrivate_(key, value) {
  const resp = v3Cal_(() => Calendar.Events.list(CONFIG.CALENDAR_ID, {
    privateExtendedProperty: `${key}=${value}`,
    singleEvents: false,
    showDeleted: false,
    maxResults: 50,
  }));
  return (resp.items || []).filter(ev => ev.status !== 'cancelled' && !ev.recurringEventId);
}
