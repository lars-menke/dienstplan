/******************************************************
 * Fahrzeugbuchung (docs/Fahrzeugbuchung-Spezifikation.md)
 *
 * Gehört ins SELBE Apps-Script-Projekt wie WebApp.gs und Kalender.gs.
 * Master ist der Google Kalender „Fahrzeuge 18-2“. Seine ID wird beim ersten
 * Zugriff über den Namen gefunden und in der Script-Eigenschaft
 * FAHRZEUG_KALENDER gespeichert (steht nicht im Repo).
 *
 * Einträge aus Google werden über den Titel erkannt; Buchungen aus der App
 * tragen ihre Daten in extendedProperties.private (fz = '1').
 ******************************************************/

const FZ = {
  CAL_NAME: 'Fahrzeuge 18-2',
  PROP_CAL: 'FAHRZEUG_KALENDER',
  CACHE_KEY: 'fzdata',
  CACHE_SECONDS: 120,
  CACHE_CHUNK_CHARS: 40000,
  PAST_DAYS: 30,     // so weit zurück wird gelesen
  FUTURE_DAYS: 400,  // so weit voraus
  FIELDS: 'nextPageToken,items(id,status,summary,location,start,end,recurringEventId,eventType,transparency,extendedProperties)',
  MAX_PURPOSE: 120,
  MAX_CONTACT: 60,
  SERIES_CHECK_DAYS: 366, // so weit werden Serien auf Überschneidungen geprüft
  COLOR_REQUESTED: '5',   // Banane – fällt im Google Kalender auf
  COLOR_REJECTED: '8',    // Graphit
};

/**
 * Buchbare Fahrzeuge (Reihenfolge = Anzeige) mit den Schreibweisen, die im Titel erkannt werden.
 * Längere/speziellere Muster zuerst – Treffer werden aus dem Titel entfernt.
 */
const FAHRZEUGE = [
  { id: 'HLF', re: [/\bHLF\b/gi] },
  { id: 'LF', re: [/\bLF\b/gi] },
  { id: 'TLF', re: [/\bTLF\b/gi] },
  { id: 'DLK', re: [/\bDLK\b/gi, /\bDL\b/gi] },
  { id: 'RW', re: [/\bRW\b/gi] },
  { id: 'MTW', re: [/\bMTW\b/gi] },
  { id: 'ELW', re: [/\bELW\b/gi] },
  { id: 'KdoW', re: [/\bK(?:DO|D)W\b/gi] },
  { id: 'GW-P', re: [/\bGW[\s-]?P\b/gi, /\bPritsche\b/gi] },
  { id: 'GW-L', re: [/\bGW[\s-]?L\b/gi] },
  { id: 'JF-Bus', re: [/\bJF[\s-]*Bus\b/gi] },
];

/** Vorerst nicht abgebildet: werden erkannt und übergangen. */
const FZ_IGNORED = [/\b(?:Boots?)?anhänger\b/gi];

/** Erkennungsreihenfolge: JF-Bus vor allem anderen (sonst bliebe „Bus“ im Zweck stehen). */
const FZ_MATCH_ORDER = ['JF-Bus', 'GW-P', 'GW-L', 'HLF', 'TLF', 'LF', 'DLK', 'RW', 'MTW', 'ELW', 'KdoW'];

const FZ_ACTIONS = ['getVehicles', 'saveBooking', 'decideBooking', 'cancelBooking'];

function handleFahrzeuge_(action, data, user) {
  data = data || {};
  switch (action) {
    case 'getVehicles': return fzGetVehicles_(user, !!data.fresh);
    case 'saveBooking': return fzSaveBooking_(data, user);
    case 'decideBooking': return fzDecideBooking_(data, user);
    case 'cancelBooking': return fzCancelBooking_(data, user);
    default: throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

/* =========================
   LESEN
   ========================= */

function fzGetVehicles_(user, fresh) {
  let data = fresh ? null : fzCacheGet_();
  if (!data) {
    data = fzRead_();
    fzCachePut_(data);
  }
  const out = {
    vehicles: FAHRZEUGE.map(v => v.id),
    bookings: data.bookings,
    range: data.range,
    today: dateToIso_(new Date()),
    fzLoadedAt: data.readAt,
  };
  // nicht zugeordnete Einträge: nur Admins (zum Nacharbeiten)
  if (user.role === 'admin') out.unassigned = data.unassigned;
  return out;
}

/** Alle Einträge im Zeitraum, Serien einzeln aufgelöst. */
function fzRead_() {
  const calId = fzCalendarId_();
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - FZ.PAST_DAYS);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + FZ.FUTURE_DAYS);
  const bookings = [];
  const unassigned = [];
  let pageToken;
  do {
    const resp = v3Cal_(() => Calendar.Events.list(calId, {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      fields: FZ.FIELDS,
      pageToken,
    }));
    (resp.items || []).forEach(ev => {
      if (ev.status === 'cancelled') return;
      if ((ev.eventType || 'default').toLowerCase() !== 'default') return;
      const b = fzToBooking_(ev);
      if (b.ignored) return;
      delete b.ignored;
      if (b.vehicles.length) bookings.push(b);
      else unassigned.push(b);
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return { bookings, unassigned, range: { from: dateToIso_(from), to: dateToIso_(to) }, readAt: Date.now() };
}

/** Kalendereintrag → Buchung für die App. */
function fzToBooking_(ev) {
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const t = fzTimes_(ev);
  let info;
  if (priv.fz === '1') {
    const vehicles = String(priv.vehicles || '').split(',').map(s => s.trim()).filter(id => FAHRZEUGE.some(v => v.id === id));
    info = { vehicles, purpose: priv.purpose || '', contact: priv.contact || '', state: priv.state || 'confirmed', source: 'app' };
  } else {
    info = fzParseTitle_(ev.summary);
    info.state = 'confirmed';
    info.source = 'google';
  }
  const ignored = !!info.ignored;
  delete info.ignored;
  return Object.assign({ ignored }, {
    id: ev.id,
    title: ev.summary || '',
    location: ev.location || '',
    recurring: !!ev.recurringEventId,
    seriesId: ev.recurringEventId || '',
    requestedBy: priv.requestedBy || '',
    decidedBy: priv.decidedBy || '',
    reason: priv.reason || '',
  }, t, info);
}

/** Start/Ende als lokale Werte: date, endDate, start, end (HH:mm), allDay. */
function fzTimes_(ev) {
  const tz = CONFIG.TIMEZONE;
  if (ev.start && ev.start.date) {
    const endEx = new Date(ev.end.date + 'T12:00:00Z');
    endEx.setUTCDate(endEx.getUTCDate() - 1); // Ende ist bei Google exklusiv
    return { allDay: true, date: ev.start.date, endDate: endEx.toISOString().slice(0, 10), start: '', end: '' };
  }
  const s = new Date(ev.start.dateTime);
  const e = new Date(ev.end.dateTime);
  const out = {
    allDay: false,
    date: Utilities.formatDate(s, tz, 'yyyy-MM-dd'),
    start: Utilities.formatDate(s, tz, 'HH:mm'),
    endDate: Utilities.formatDate(e, tz, 'yyyy-MM-dd'),
    end: Utilities.formatDate(e, tz, 'HH:mm'),
  };
  // endet um Mitternacht → zählt zum Vortag (24:00)
  if (out.end === '00:00' && out.endDate > out.date) {
    out.endDate = Utilities.formatDate(new Date(e.getTime() - 60000), tz, 'yyyy-MM-dd');
    out.end = '24:00';
  }
  return out;
}

/**
 * Titel aus Google → { vehicles, purpose, contact, ignored }.
 * Fahrzeuge werden überall im Titel gesucht (Schreibweisen aus FAHRZEUGE),
 * „ASP …“ ist der Ansprechpartner, der Rest der Zweck.
 */
function fzParseTitle_(summary) {
  let text = ' ' + String(summary || '') + ' ';
  const found = {};
  FZ_MATCH_ORDER.forEach(id => {
    const def = FAHRZEUGE.find(v => v.id === id);
    def.re.forEach(re => {
      text = text.replace(re, () => { found[id] = true; return ' '; });
    });
  });
  let trailer = false;
  FZ_IGNORED.forEach(re => { text = text.replace(re, () => { trailer = true; return ' '; }); });
  const vehicles = FAHRZEUGE.map(v => v.id).filter(id => found[id]);

  let purpose = text;
  let contact = '';
  const asp = /\bASP\b\s*:?\s*(.*)$/i.exec(text);
  if (asp) {
    contact = fzClean_(asp[1]);
    purpose = text.slice(0, asp.index);
  }
  purpose = fzClean_(purpose);
  return { vehicles, purpose, contact, ignored: !vehicles.length && trailer };
}

/** Leerzeichen zusammenfassen, Trenner am Anfang/Ende und doppelte Trenner entfernen. */
function fzClean_(s) {
  const SEP = '[-–—:/&+,·|]';
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`\\s*(${SEP})(\\s*${SEP})+\\s*`, 'g'), ' $1 ')
    .replace(new RegExp(`^(\\s|${SEP}|\\bund\\b)+`, 'i'), '')
    .replace(new RegExp(`(\\s|${SEP}|\\bund\\b)+$`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ID des Fahrzeugkalenders: aus der Script-Eigenschaft, sonst über den Namen suchen und merken. */
function fzCalendarId_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty(FZ.PROP_CAL);
  if (saved) return saved;
  let pageToken;
  do {
    const resp = v3Cal_(() => Calendar.CalendarList.list({ maxResults: 250, pageToken, fields: 'nextPageToken,items(id,summary,summaryOverride,accessRole)' }));
    const hit = (resp.items || []).find(c => (c.summaryOverride || c.summary || '').trim() === FZ.CAL_NAME);
    if (hit) {
      props.setProperty(FZ.PROP_CAL, hit.id);
      Logger.log(`Fahrzeugkalender gefunden (${hit.accessRole}).`);
      return hit.id;
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  throw new Error(`Der Kalender „${FZ.CAL_NAME}“ wurde nicht gefunden.`);
}

/* =========================
   SCHREIBEN (Etappe 2)
   ========================= */

function fzCanBook_(user) {
  return user.role === 'admin' || !!user.book;
}

function fzRequireBook_(user) {
  if (fzCanBook_(user)) return;
  const err = new Error('Zum Buchen brauchst du einen Code mit „Fahrzeuge buchen“.');
  err.isForbidden = true;
  throw err;
}

/** Eingaben prüfen → { date, endDate, allDay, start, end, vehicles, purpose, contact, recurrence } */
function fzValidate_(d) {
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const date = String(d.date || '');
  if (!isoRe.test(date)) throw new Error('Bitte ein gültiges Datum wählen.');
  let endDate = isoRe.test(d.endDate || '') ? d.endDate : date;
  if (endDate < date) throw new Error('Das Ende liegt vor dem Beginn.');
  const allDay = !!d.allDay;
  const start = allDay ? '' : String(d.start || '');
  const end = allDay ? '' : String(d.end || '');
  if (!allDay) {
    if (!timeRe.test(start)) throw new Error('Bitte eine Beginn-Uhrzeit eingeben.');
    if (!timeRe.test(end)) throw new Error('Bitte eine End-Uhrzeit eingeben.');
    if (endDate === date && end <= start) throw new Error('Das Ende liegt vor dem Beginn.');
  }
  const ids = FAHRZEUGE.map(v => v.id);
  const vehicles = ids.filter(id => (Array.isArray(d.vehicles) ? d.vehicles : []).includes(id));
  if (!vehicles.length) throw new Error('Bitte mindestens ein Fahrzeug wählen.');
  const purpose = String(d.purpose || '').trim().replace(/\s+/g, ' ');
  if (!purpose) throw new Error('Bitte den Zweck angeben.');
  if (purpose.length > FZ.MAX_PURPOSE) throw new Error('Der Zweck ist zu lang.');
  const contact = String(d.contact || '').trim().replace(/\s+/g, ' ');
  if (!contact) throw new Error('Bitte einen Ansprechpartner (ASP) angeben.');
  if (contact.length > FZ.MAX_CONTACT) throw new Error('Der Name des Ansprechpartners ist zu lang.');
  let recurrence = '';
  if (d.recurrence) {
    const r = String(d.recurrence).trim().replace(/^RRULE:/i, '').toUpperCase();
    if (r.length > 300 || !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[-+,0-9A-Z]+)*$/.test(r)) throw new Error('Die Wiederholung ist ungültig.');
    if (!/;(UNTIL|COUNT)=/.test(r)) throw new Error('Eine Serie braucht ein Ende (bis Datum oder Anzahl).');
    recurrence = 'RRULE:' + r;
  }
  return { date, endDate, allDay, start, end, vehicles, purpose, contact, recurrence };
}

/** Lokales Datum/Uhrzeit → Date (Zeitzone des Script-Projekts = Europe/Berlin). */
function fzLocal_(iso, hhmm) {
  const [y, m, d] = iso.split('-').map(Number);
  const [h, mi] = (hhmm || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
}

function fzNextDay_(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return dateToIso_(new Date(y, m - 1, d + 1));
}

/** Zeitraum eines Kalendereintrags in ms: [von, bis) */
function fzRangeOfEvent_(ev) {
  if (ev.start.date) return [fzLocal_(ev.start.date).getTime(), fzLocal_(ev.end.date).getTime()];
  return [new Date(ev.start.dateTime).getTime(), new Date(ev.end.dateTime).getTime()];
}

function fzTitle_(f, state) {
  const base = `${f.vehicles.join(' + ')} · ${f.purpose} · ASP: ${f.contact}`;
  if (state === 'requested') return `Angefragt: ${base}`;
  if (state === 'rejected') return `Abgelehnt: ${base}`;
  return base;
}

function fzStampText_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd.MM.yyyy HH:mm');
}

/** Kalender-Body aus den Feldern; existing: bestehender Eintrag (Erinnerungen usw. bleiben). */
function fzBody_(f, meta, existing) {
  const body = existing ? JSON.parse(JSON.stringify(existing)) : {};
  delete body.__cal;
  body.summary = fzTitle_(f, meta.state);
  if (f.allDay) {
    body.start = { date: f.date };
    body.end = { date: fzNextDay_(f.endDate) };
  } else {
    body.start = { dateTime: fzLocal_(f.date, f.start).toISOString(), timeZone: CONFIG.TIMEZONE };
    body.end = { dateTime: fzLocal_(f.endDate, f.end).toISOString(), timeZone: CONFIG.TIMEZONE };
  }
  if (f.recurrence) body.recurrence = [f.recurrence];
  else delete body.recurrence;
  const lines = [`Über die Dienstplan-App angefragt von ${meta.requestedBy} am ${meta.requestedAt}.`];
  if (meta.state === 'confirmed' && meta.decidedBy) lines.push(`Bestätigt von ${meta.decidedBy} am ${meta.decidedAt}.`);
  if (meta.state === 'rejected') lines.push(`Abgelehnt von ${meta.decidedBy} am ${meta.decidedAt}${meta.reason ? `: ${meta.reason}` : '.'}`);
  if (meta.state === 'requested') lines.push('Noch nicht bestätigt.');
  body.description = lines.join('\n');
  if (meta.state === 'requested') body.colorId = FZ.COLOR_REQUESTED;
  else if (meta.state === 'rejected') body.colorId = FZ.COLOR_REJECTED;
  else delete body.colorId;
  body.transparency = meta.state === 'rejected' ? 'transparent' : 'opaque';
  const priv = {
    fz: '1', vehicles: f.vehicles.join(','), purpose: f.purpose, contact: f.contact, state: meta.state,
    requestedBy: meta.requestedBy, requestedAt: meta.requestedAt,
    decidedBy: meta.decidedBy || '', decidedAt: meta.decidedAt || '', reason: meta.reason || '',
  };
  body.extendedProperties = { private: priv };
  return body;
}

/** Felder + Metadaten aus einem bestehenden Eintrag. */
function fzFieldsOf_(ev) {
  const b = fzToBooking_(ev);
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const f = {
    date: b.date, endDate: b.endDate, allDay: b.allDay, start: b.start, end: b.end === '24:00' ? '00:00' : b.end,
    vehicles: b.vehicles, purpose: b.purpose || b.title, contact: b.contact || '-',
    recurrence: (ev.recurrence || []).find(l => /^RRULE:/i.test(l)) || '',
  };
  if (b.end === '24:00') f.endDate = fzNextDay_(b.endDate);
  const meta = {
    state: b.state, requestedBy: priv.requestedBy || '', requestedAt: priv.requestedAt || '',
    decidedBy: priv.decidedBy || '', decidedAt: priv.decidedAt || '', reason: priv.reason || '',
  };
  return { f, meta, booking: b, app: priv.fz === '1' };
}

/**
 * Überschneidungen: ranges [[von, bis), …] in ms, vehicles, ausgenommen ids/serien.
 * Abgelehnte Buchungen zählen nicht. → [{ vehicles, date, text, purpose, contact }]
 */
function fzConflicts_(calId, ranges, vehicles, excludeId) {
  if (!ranges.length) return [];
  const min = Math.min.apply(null, ranges.map(r => r[0]));
  const max = Math.max.apply(null, ranges.map(r => r[1]));
  const out = [];
  let pageToken;
  do {
    const resp = v3Cal_(() => Calendar.Events.list(calId, {
      timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(),
      singleEvents: true, maxResults: 2500, fields: FZ.FIELDS, pageToken,
    }));
    (resp.items || []).forEach(ev => {
      if (ev.status === 'cancelled' || (ev.eventType || 'default').toLowerCase() !== 'default') return;
      if (excludeId && (ev.id === excludeId || ev.recurringEventId === excludeId)) return;
      const b = fzToBooking_(ev);
      if (b.ignored || b.state === 'rejected') return;
      const shared = b.vehicles.filter(v => vehicles.includes(v));
      if (!shared.length) return;
      const r = fzRangeOfEvent_(ev);
      if (!ranges.some(x => x[0] < r[1] && r[0] < x[1])) return;
      out.push({ vehicles: shared, date: b.date, endDate: b.endDate, allDay: b.allDay, start: b.start, end: b.end,
        purpose: b.purpose || b.title, contact: b.contact, state: b.state });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function fzConflictText_(c) {
  const d = c.date.split('-').reverse().join('.');
  const time = c.allDay ? 'ganztägig' : `${c.start}–${c.end}`;
  return `${c.vehicles.join(' + ')} ist am ${d} (${time}) belegt: ${c.purpose}${c.contact ? ` (ASP ${c.contact})` : ''}${c.state === 'requested' ? ' – angefragt' : ''}`;
}

function fzConflictError_(conflicts, canForce) {
  const first = fzConflictText_(conflicts[0]);
  const more = conflicts.length > 1 ? ` (und ${conflicts.length - 1} weitere Überschneidung${conflicts.length > 2 ? 'en' : ''})` : '';
  const err = new Error(first + more + '.');
  err.conflicts = conflicts.slice(0, 20);
  err.canForce = canForce;
  return err;
}

/** Zeiträume eines (neuen) Eintrags; Serien über Google aufgelöst. */
function fzRangesOf_(calId, ev) {
  if (!ev.recurrence || !ev.recurrence.length) return [fzRangeOfEvent_(ev)];
  const until = new Date(Date.now() + FZ.SERIES_CHECK_DAYS * 864e5).toISOString();
  const out = [];
  let pageToken;
  do {
    const resp = v3Cal_(() => Calendar.Events.instances(calId, ev.id, { timeMax: until, maxResults: 2500, pageToken }));
    (resp.items || []).forEach(i => { if (i.status !== 'cancelled') out.push(fzRangeOfEvent_(i)); });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/** { id?, date, endDate, allDay, start, end, vehicles, purpose, contact, recurrence?, force? } */
function fzSaveBooking_(data, user) {
  fzRequireBook_(user);
  const f = fzValidate_(data);
  const admin = user.role === 'admin';
  const force = admin && !!data.force;
  return withWebLock_(() => {
    const calId = fzCalendarId_();
    const now = fzStampText_();
    let existing = null;
    let meta;
    if (data.id) {
      existing = fzGet_(calId, data.id);
      if (existing.recurringEventId) throw new Error('Einzelne Termine einer Serie lassen sich hier nicht ändern.');
      const cur = fzFieldsOf_(existing);
      if (!admin) {
        if (!cur.app || cur.meta.requestedBy !== user.name) throw new Error('Du kannst nur deine eigenen Anfragen ändern.');
        if (cur.meta.state !== 'requested') throw new Error('Bestätigte Buchungen kann nur ein Admin ändern.');
      }
      meta = cur.app ? cur.meta : { state: 'confirmed', requestedBy: user.name, requestedAt: now, decidedBy: user.name, decidedAt: now };
      if (meta.state === 'rejected') meta = Object.assign({}, meta, { state: admin ? 'confirmed' : 'requested', decidedBy: admin ? user.name : '', decidedAt: admin ? now : '', reason: '' });
    } else {
      meta = admin
        ? { state: 'confirmed', requestedBy: user.name, requestedAt: now, decidedBy: user.name, decidedAt: now }
        : { state: 'requested', requestedBy: user.name, requestedAt: now };
    }

    const body = fzBody_(f, meta, existing);
    // einzelne Buchung: vorher prüfen; Serie: anlegen, Vorkommen von Google holen, prüfen, ggf. zurücknehmen
    if (!f.recurrence) {
      const range = fzRangeOfEvent_(body);
      const conflicts = force ? [] : fzConflicts_(calId, [range], f.vehicles, existing && existing.id);
      if (conflicts.length) throw fzConflictError_(conflicts, admin);
      const saved = existing
        ? v3Cal_(() => Calendar.Events.update(body, calId, existing.id, { sendUpdates: 'none' }))
        : v3Cal_(() => Calendar.Events.insert(body, calId, { sendUpdates: 'none' }));
      return fzAfterWrite_(user, [saved], [], fzSavedMessage_(meta.state, !!existing));
    }
    const before = existing ? JSON.parse(JSON.stringify(existing)) : null;
    const saved = existing
      ? v3Cal_(() => Calendar.Events.update(body, calId, existing.id, { sendUpdates: 'none' }))
      : v3Cal_(() => Calendar.Events.insert(body, calId, { sendUpdates: 'none' }));
    if (!force) {
      const conflicts = fzConflicts_(calId, fzRangesOf_(calId, saved), f.vehicles, saved.id);
      if (conflicts.length) {
        if (before) { delete before.__cal; v3Cal_(() => Calendar.Events.update(before, calId, saved.id, { sendUpdates: 'none' })); }
        else v3Cal_(() => Calendar.Events.remove(calId, saved.id, { sendUpdates: 'none' }));
        throw fzConflictError_(conflicts, admin);
      }
    }
    return fzAfterWrite_(user, [], [], fzSavedMessage_(meta.state, !!existing), true);
  });
}

function fzSavedMessage_(state, edited) {
  if (state === 'requested') return edited ? 'Anfrage geändert – wartet auf Bestätigung.' : 'Angefragt – ein Admin bestätigt die Buchung.';
  return edited ? 'Buchung gespeichert.' : 'Gebucht.';
}

/** { id, decision: 'confirm'|'reject', reason?, force? } – nur Admin (WebApp.requiredRole_) */
function fzDecideBooking_(data, user) {
  const decision = data.decision;
  if (decision !== 'confirm' && decision !== 'reject') throw new Error('Unbekannte Entscheidung.');
  const reason = String(data.reason || '').trim().slice(0, 200);
  return withWebLock_(() => {
    const calId = fzCalendarId_();
    const ev = fzGet_(calId, data.id);
    const cur = fzFieldsOf_(ev);
    if (!cur.app) throw new Error('Dieser Eintrag stammt direkt aus dem Google Kalender und gilt schon als gebucht.');
    const meta = Object.assign({}, cur.meta, { decidedBy: user.name, decidedAt: fzStampText_(), reason: decision === 'reject' ? reason : '' });
    meta.state = decision === 'confirm' ? 'confirmed' : 'rejected';
    if (decision === 'confirm' && !data.force) {
      const conflicts = fzConflicts_(calId, fzRangesOf_(calId, ev), cur.f.vehicles, ev.id);
      if (conflicts.length) throw fzConflictError_(conflicts, true);
    }
    const saved = v3Cal_(() => Calendar.Events.update(fzBody_(cur.f, meta, ev), calId, ev.id, { sendUpdates: 'none' }));
    const msg = decision === 'confirm' ? 'Buchung bestätigt.' : 'Anfrage abgelehnt.';
    return fzAfterWrite_(user, ev.recurrence ? [] : [saved], [], msg, !!ev.recurrence);
  });
}

/** { id } – eigene Anfrage zurückziehen bzw. (Admin) Buchung löschen; Serien ganz. */
function fzCancelBooking_(data, user) {
  fzRequireBook_(user);
  return withWebLock_(() => {
    const calId = fzCalendarId_();
    const ev = fzGet_(calId, data.id);
    const cur = fzFieldsOf_(ev);
    if (user.role !== 'admin') {
      if (!cur.app || cur.meta.requestedBy !== user.name) throw new Error('Du kannst nur deine eigenen Anfragen zurückziehen.');
      if (cur.meta.state === 'confirmed') throw new Error('Bestätigte Buchungen kann nur ein Admin löschen.');
    }
    v3Cal_(() => Calendar.Events.remove(calId, ev.id, { sendUpdates: 'none' }));
    Logger.log(`Fahrzeugbuchung gelöscht von ${user.name}: ${ev.summary}`);
    const msg = user.role === 'admin' && cur.meta.state === 'confirmed' ? 'Buchung gelöscht.' : 'Anfrage zurückgezogen.';
    return fzAfterWrite_(user, [], [ev.id], msg);
  });
}

function fzGet_(calId, id) {
  if (!id) throw new Error('Keine Buchung angegeben.');
  try {
    const ev = Calendar.Events.get(calId, String(id));
    if (ev.status === 'cancelled') throw new Error('gone');
    return ev;
  } catch (e) {
    if (/gone|Not Found|deleted/i.test(errMsg_(e))) throw new Error('Diese Buchung gibt es nicht mehr. Bitte neu laden.');
    throw e;
  }
}

/**
 * Nach dem Schreiben frisch lesen. Google liefert frisch Geschriebenes manchmal
 * noch nicht in der Liste – einzelne Einträge werden dann hier ergänzt bzw. entfernt.
 */
function fzAfterWrite_(user, changed, removedIds, message, series) {
  const data = fzRead_();
  const drop = new Set(removedIds);
  ['bookings', 'unassigned'].forEach(k => { data[k] = data[k].filter(b => !drop.has(b.id) && !drop.has(b.seriesId)); });
  changed.forEach(ev => {
    const b = fzToBooking_(ev);
    delete b.ignored;
    ['bookings', 'unassigned'].forEach(k => { data[k] = data[k].filter(x => x.id !== b.id); });
    (b.vehicles.length ? data.bookings : data.unassigned).push(b);
  });
  data.bookings.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  fzCachePut_(data);
  return Object.assign({ message, series: !!series }, fzGetVehicles_(user, false));
}

/** Zum Testen im Editor: zeigt, wie die nächsten Einträge erkannt werden. */
function fahrzeugeTesten() {
  const data = fzRead_();
  const lines = data.bookings.slice(0, 40).map(b => `${b.date} ${b.start || 'ganzt.'}  [${b.vehicles.join(', ')}]  ${b.purpose}${b.contact ? '  · ASP ' + b.contact : ''}`);
  lines.push(`… ${data.bookings.length} Buchungen, ${data.unassigned.length} nicht zugeordnet`);
  data.unassigned.forEach(b => lines.push(`  ? ${b.date}  ${b.title}`));
  Logger.log(lines.join('\n'));
}

/* =========================
   CACHE
   ========================= */

function fzCachePut_(data) {
  try {
    const json = JSON.stringify(data);
    const n = Math.ceil(json.length / FZ.CACHE_CHUNK_CHARS) || 1;
    const obj = {};
    for (let i = 0; i < n; i++) obj[`${FZ.CACHE_KEY}_${i}`] = json.slice(i * FZ.CACHE_CHUNK_CHARS, (i + 1) * FZ.CACHE_CHUNK_CHARS);
    obj[`${FZ.CACHE_KEY}_n`] = String(n);
    CacheService.getScriptCache().putAll(obj, FZ.CACHE_SECONDS);
  } catch (e) {
    Logger.log('Fahrzeug-Cache nicht gespeichert: ' + errMsg_(e));
  }
}

function fzCacheGet_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(`${FZ.CACHE_KEY}_n`));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(`${FZ.CACHE_KEY}_${i}`);
    const parts = cache.getAll(keys);
    if (keys.some(k => parts[k] == null)) return null;
    return JSON.parse(keys.map(k => parts[k]).join(''));
  } catch (e) {
    return null;
  }
}
