/******************************************************
 * Fahrzeugbuchung (docs/Fahrzeugbuchung-Spezifikation.md)
 *
 * Gehört ins SELBE Apps-Script-Projekt wie WebApp.gs und Kalender.gs.
 * Master ist der Google Kalender „Fahrzeuge 18-2“. Seine ID wird beim ersten
 * Zugriff über den Namen gefunden und in der Script-Eigenschaft
 * FAHRZEUG_KALENDER gespeichert (steht nicht im Repo).
 *
 * Etappe 1: nur lesen. Einträge aus Google werden über den Titel erkannt.
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

const FZ_ACTIONS = ['getVehicles'];

function handleFahrzeuge_(action, data, user) {
  switch (action) {
    case 'getVehicles': return fzGetVehicles_(user, !!(data && data.fresh));
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
  return Object.assign({
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
