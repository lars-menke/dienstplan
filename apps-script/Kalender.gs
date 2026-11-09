/******************************************************
 * Dienstplan V3 – Google Kalender ist Master
 * (docs/PWA-Spezifikation-V3.md, Etappe 1)
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
 ******************************************************/

const V3 = {
  SCHEMA: '3',
  PROP_SOURCE: 'DATENQUELLE',
  PROP_CATEGORIES: 'KATEGORIEN_V3',
  PROP_RENAMES: 'KATEGORIEN_V3_UMBENENNUNGEN', // alt (klein) → neu, bis der Kalender nachgezogen ist

  CACHE_KEY: 'dpv3data',
  CACHE_SECONDS: 300,
  CACHE_CHUNK_CHARS: 40000, // < 90 KB auch bei Umlauten (UTF-8)

  MAX_RUNTIME_MS: 5 * 60 * 1000,
  MAX_BULK: 100,
  MAX_PRIVATE_VALUE: 1024,

  DELETED_SHEET: 'Gelöscht',
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
  PropertiesService.getScriptProperties().setProperty(V3.PROP_SOURCE, mode);
  v3CacheClear_();
  removeAutoSyncTriggers_();
  let msg;
  if (mode === 'calendar') {
    msg = 'Datenquelle: Google Kalender. Der 15-Minuten-Sync ist entfernt.';
  } else {
    ScriptApp.newTrigger('syncSheetToCalendar').timeBased().everyMinutes(15).create();
    msg = 'Datenquelle: Sheet (bisheriges Verhalten). Der 15-Minuten-Sync ist wieder eingerichtet. ' +
      'Achtung: Das Sheet zeigt den Stand vor der Kalender-Zeit; dort gemachte Änderungen stehen nicht im Sheet.';
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
      if (data && data.fresh) v3CacheClear_();
      return withAdminInfo_(v3GetAppData_(user.name), user);
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

function v3GetAppData_(userName) {
  let data = v3CacheGet_();
  // nach dem Speichern wird der Zwischenspeicher nur angepasst – spätestens nach 5 Minuten neu lesen
  if (data && (!data.listedAt || Date.now() - data.listedAt > V3.CACHE_SECONDS * 1000)) data = null;
  if (!data) {
    const cats = v3Categories_();
    const events = v3ListEvents_().map(ev => v3ToApp_(ev, v3Fields_(ev, cats)));
    events.sort((a, b) => (a.date + (a.start || '00:00')).localeCompare(b.date + (b.start || '00:00')));
    const usage = {};
    events.forEach(e => {
      const k = (e.category || '').toLowerCase();
      if (k) usage[k] = (usage[k] || 0) + 1;
    });
    data = {
      listedAt: Date.now(),
      events,
      categoryList: cats.list.map(c => ({ name: c.name, colorId: c.colorId, count: usage[c.name.toLowerCase()] || 0 })),
    };
    v3CachePut_(data);
  }
  const out = Object.assign({}, data, { today: dateToIso_(new Date()), user: userName });
  delete out.listedAt;
  return out;
}

/**
 * Nach dem Schreiben: Zwischenspeicher gezielt anpassen statt den ganzen Kalender
 * neu zu lesen (spart den langsamsten Aufruf). Ist der Zwischenspeicher leer oder
 * älter als 4 Minuten, wird wie gewohnt alles neu gelesen – so tauchen direkt in
 * Google gemachte Änderungen spätestens nach ein paar Minuten auf.
 * changed: geänderte/neue Kalendertermine (Antwort von insert/update), removedIds: gelöschte IDs.
 */
function v3AppDataAfterWrite_(userName, changed, removedIds, cats) {
  const data = v3CacheGet_();
  if (!data || !data.listedAt || Date.now() - data.listedAt > 4 * 60 * 1000) {
    v3CacheClear_();
    return v3GetAppData_(userName);
  }
  cats = cats || v3Categories_();
  const drop = {};
  (removedIds || []).forEach(id => { drop[id] = true; });
  const fresh = {};
  (changed || []).forEach(ev => {
    if (!ev || !ev.id) return;
    if (ev.status === 'cancelled') { drop[ev.id] = true; return; }
    fresh[ev.id] = v3ToApp_(ev, v3Fields_(ev, cats));
  });
  const events = data.events.filter(e => !drop[e.eventId] && !fresh[e.eventId]);
  Object.keys(fresh).forEach(id => { if (!drop[id]) events.push(fresh[id]); });
  events.sort((a, b) => (a.date + (a.start || '00:00')).localeCompare(b.date + (b.start || '00:00')));
  const usage = {};
  events.forEach(e => {
    const k = (e.category || '').toLowerCase();
    if (k) usage[k] = (usage[k] || 0) + 1;
  });
  data.events = events;
  data.categoryList = cats.list.map(c => ({ name: c.name, colorId: c.colorId, count: usage[c.name.toLowerCase()] || 0 }));
  v3CachePut_(data);
  return v3GetAppData_(userName);
}

/** Alle Termine ab 1. Januar des Vorjahres, ein Eintrag pro Serie. */
function v3ListEvents_() {
  const timeMin = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
  const out = [];
  let pageToken;
  do {
    const resp = v3Cal_(() => Calendar.Events.list(CONFIG.CALENDAR_ID, {
      timeMin,
      singleEvents: false,
      showDeleted: false,
      maxResults: 2500,
      pageToken,
    }));
    (resp.items || []).forEach(ev => {
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
    CacheService.getScriptCache().putAll(obj, V3.CACHE_SECONDS);
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
