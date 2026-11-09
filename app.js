/* Dienstplan – Handy-App der Feuerwehr (Spezifikation: docs/PWA-Spezifikation.md)
 * Spricht mit der Apps-Script-Schnittstelle (config.js → API_URL).
 * Zugangscode, Terminliste, Darstellung und Ansicht liegen nur auf diesem Gerät.
 */

const S = { AKTIV: 'AKTIV', ABGESAGT: 'ABGESAGT', VERSCHOBEN: 'VERSCHOBEN', LOESCHEN: 'LÖSCHEN' };
const API_URL = (window.DIENSTPLAN_CONFIG || {}).API_URL || '';
const KEY_CODE = 'dienstplan.code';
const KEY_DATA = 'dienstplan.data';
const KEY_THEME = 'dienstplan.theme';
const KEY_VIEW = 'dienstplan.view';
const KEY_SWIPE_HINT = 'dienstplan.swipeHintSeen';

// Vorlagen für „Neuer Termin“ (V2 8.5) – aus config.js, sonst diese Vorgabe
const TEMPLATES = (window.DIENSTPLAN_CONFIG && window.DIENSTPLAN_CONFIG.TEMPLATES) || [
  { label: 'Übungsdienst', title: 'Übungsdienst: ', start: '19:30', end: '21:30', location: 'Feuerwehrhaus', category: 'Übung' },
  { label: 'Gruppendienst', title: 'Gruppendienst: ', start: '09:00', end: '12:00', location: 'Feuerwehrhaus', category: 'Ausbildung' },
  { label: 'Besprechung', title: 'Besprechung: ', start: '19:00', end: '', location: 'Schulungsraum', category: 'Besprechung' },
  { label: 'Leer', title: '', start: '19:00', end: '21:00', location: '', category: '' },
];

// Google-Kalender-Farben (V2, Kapitel 4.2). Im Dunkelmodus werden einige aufgehellt.
const COLOR_HEX = {
  light: { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' },
  dark: { 9: '#7986cb', 10: '#33b679', 11: '#ff5a4f' },
};

const ROLE_RANK = { read: 1, write: 2, admin: 3 };

const state = {
  events: [], categoryList: [], today: '', user: '', role: '',
  loadedAt: null, q: '', showPast: false, busy: false, loadError: null,
  codes: null, codeCount: null, page: null, // Verwaltung (Etappe 3)
  view: 'list', weekStart: null, selDay: null, // Wochenansicht (Etappe 4)
  saving: {}, // Karten, die gerade per Wischen geändert werden: key → Text
};

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const sheetEl = $('#sheet');
const backdropEl = $('#backdrop');
const appEl = $('#app');
const pageEl = $('#page');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Speicher (fehlertolerant) ---------- */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } },
};

/* ---------- Darstellung: Hell / Dunkel / System (V2, Kapitel 6) ---------- */

const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

function themePref() {
  const p = store.get(KEY_THEME);
  return p === 'light' || p === 'dark' ? p : 'system';
}

function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'system' && darkQuery && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#0b1530' : '#f4f3f0');
}

function setThemePref(pref) {
  if (pref === 'system') store.del(KEY_THEME); else store.set(KEY_THEME, pref);
  applyTheme();
  render(); // Kategoriefarben hängen vom Theme ab
}

if (darkQuery) {
  const onChange = () => { if (themePref() === 'system') { applyTheme(); render(); } };
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange);
  else if (darkQuery.addListener) darkQuery.addListener(onChange);
}

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/* ---------- Rollen (V2, Kapitel 2) ---------- */

/** Darf die aktuelle Rolle das? Unbekannte Rolle (ältere Schnittstelle) → ja; der Server prüft ohnehin. */
function can(role) {
  const have = ROLE_RANK[state.role];
  return have === undefined ? true : have >= ROLE_RANK[role];
}

/* ---------- Kategorien ---------- */

function categoryColor(name) {
  if (!name) return null;
  const entry = state.categoryList.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!entry) return null;
  const id = String(entry.colorId);
  return (isDark() && COLOR_HEX.dark[id]) || COLOR_HEX.light[id] || null;
}

function categoryOptions() {
  return state.categoryList.map(c => c.name);
}

/* ---------- Server ---------- */

async function api(action, data) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain vermeidet die CORS-Vorabfrage, die Apps Script nicht beantwortet
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, data: data || {}, code: store.get(KEY_CODE) }),
    });
  } catch (e) {
    const err = new Error('Keine Verbindung zum Server. Bist du online?');
    err.offline = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Der Server antwortet nicht richtig (HTTP ${res.status}).`);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Unerwartete Antwort vom Server.');
  }
  if (json.role) state.role = json.role;
  if (!json.ok) {
    const err = new Error(json.error || 'Unbekannter Fehler.');
    err.auth = !!json.auth;
    err.forbidden = !!json.forbidden;
    throw err;
  }
  return json;
}

function applyData(d) {
  state.events = d.events || [];
  state.categoryList = d.categoryList || [];
  state.today = d.today || state.today;
  state.user = d.userName || d.user || state.user;
  state.role = d.role || state.role;
  if (d.codeCount !== undefined) state.codeCount = d.codeCount;
  state.loadedAt = Date.now();
  state.loadError = null;
  store.set(KEY_DATA, JSON.stringify({
    events: state.events, categoryList: state.categoryList,
    today: state.today, user: state.user, role: state.role, codeCount: state.codeCount, loadedAt: state.loadedAt,
  }));
}

/** fresh: von Hand aktualisiert – das Backend liest dann direkt aus dem Kalender. */
async function load(fresh) {
  if (state.busy) return;
  const reload = $('#btnReload');
  reload.classList.add('spinning');
  reload.setAttribute('aria-busy', 'true');
  if (!state.events.length) {
    listEl.innerHTML = `<div class="loading" role="status"><span class="spin"></span>Lade Termine…</div>`;
  }
  try {
    applyData(await api('getData', fresh === true ? { fresh: true } : {}));
  } catch (e) {
    if (e.auth) return logout(e.message);
    state.loadError = e;
  } finally {
    reload.classList.remove('spinning');
    reload.removeAttribute('aria-busy');
  }
  render();
}

/**
 * Führt eine Änderung aus. onSuccess(d) ersetzt das Standardverhalten
 * (Sheet schließen, neu zeichnen, Meldung).
 */
async function mutate(btn, action, data, onSuccess) {
  if (state.busy) return;
  state.busy = true;
  renderHeader();
  const buttons = sheetEl.querySelectorAll('button, input, textarea');
  buttons.forEach(b => (b.disabled = true));
  const label = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span>Wird gespeichert…';
  try {
    const d = await api(action, data);
    if (d.events) applyData(d);
    if (d.codes) state.codes = d.codes;
    if (d.codeCount !== undefined) state.codeCount = d.codeCount;
    state.busy = false;
    renderHeader();
    if (onSuccess) return onSuccess(d);
    closeSheet();
    render();
    toast(d.message || 'Gespeichert.', d.warning);
  } catch (e) {
    state.busy = false;
    if (e.auth) { closeSheet(true); return logout(e.message); }
    buttons.forEach(b => (b.disabled = false));
    btn.innerHTML = label;
    renderHeader();
    if (e.forbidden) render(); // Rolle hat sich geändert → Anzeige anpassen
    toast(e.message, true);
  }
}

// Termine werden nur noch über ihre eventId angesprochen (V3 7.1)
const ref = ev => ({ eventId: ev.eventId });
const setStatus = (ev, status, btn, extra) => mutate(btn, 'setStatus', Object.assign({ ref: ref(ev), status }, extra || {}));

/* ---------- Datum ---------- */

const pad = n => String(n).padStart(2, '0');
const toDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const toIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (iso, n) => { const d = toDate(iso); d.setDate(d.getDate() + n); return toIso(d); };
const todayIso = () => toIso(new Date());
const fmt = (iso, opts) => toDate(iso).toLocaleDateString('de-DE', opts);
const wdShort = iso => fmt(iso, { weekday: 'short' }).replace('.', '');          // "Fr"
const dayMonth = iso => { const d = toDate(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; }; // "13.11."
const wdDayMonth = iso => `${wdShort(iso)} ${dayMonth(iso)}`;                     // "Fr 13.11."
const longDate = iso => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = iso => fmt(iso, { month: 'long' });
const timeNow = ts => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Montag der Woche (ISO) */
function weekStart(iso) {
  const d = toDate(iso);
  const dow = (d.getDay() + 6) % 7; // Mo = 0
  d.setDate(d.getDate() - dow);
  return toIso(d);
}

function timeText(ev) {
  if (ev.allDay) {
    return ev.endDate && ev.endDate !== ev.date ? `Ganztägig bis ${dayMonth(ev.endDate)}` : 'Ganztägig';
  }
  let t = ev.end ? `${ev.start}–${ev.end} Uhr` : `${ev.start} Uhr`;
  if (ev.endDate && ev.endDate !== ev.date) t += ` (bis ${dayMonth(ev.endDate)})`;
  return t;
}

function relDayPrefix(iso) {
  const t = todayIso();
  if (iso === t) return 'Heute · ';
  if (iso === addDays(t, 1)) return 'Morgen · ';
  if (iso === addDays(t, -1)) return 'Gestern · ';
  return '';
}

/** "19.11.2026, 19:00 Uhr" → "2026-11-19" */
function parseGermanDate(s) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : '';
}

/** Folgetermin: Beschreibung beginnt mit "(verschoben vom 12.11.2026)" → "12.11." */
function movedFrom(ev) {
  const m = /^\(verschoben vom (\d{1,2})\.(\d{1,2})\.\d{4}\)/.exec(ev.description || '');
  return m ? `${pad(m[1])}.${pad(m[2])}.` : '';
}

/* ---------- Wiederholung (RRULE) ---------- */

const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mo … So
const ORDS = [1, 2, 3, 4, -1];
const ordLabel = n => (n === -1 ? 'letzten' : `${n}.`);
const sortDays = days => [...new Set(days)].sort((a, b) => WD_ORDER.indexOf(a) - WD_ORDER.indexOf(b));
const sortOrds = ords => [...new Set(ords)].sort((a, b) => ORDS.indexOf(a) - ORDS.indexOf(b));

/** n-ter Wochentag im Monat; der 5. zählt als „letzter“ (-1) */
function nthWeekday(iso) {
  const d = toDate(iso);
  const n = Math.ceil(d.getDate() / 7);
  return { n: n >= 5 ? -1 : n, wd: d.getDay() };
}

function isLastOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getMonth() !== d.getMonth();
}

/**
 * Wiederholung als Formular-Zustand:
 * { freq: NONE|DAILY|WEEKLY|MONTHLY|YEARLY|CUSTOM, interval, days[], monthMode: day|weekday,
 *   monthDay, ords[], wd, end: never|until|count, until, count, raw }
 */
function defaultRep(iso) {
  const d = toDate(iso);
  return {
    freq: 'NONE', interval: 1, days: [d.getDay()], monthMode: 'day', monthDay: d.getDate(),
    ords: [nthWeekday(iso).n], wd: d.getDay(), end: 'never', until: '', count: 10, raw: '',
  };
}

/** RRULE → Formular-Zustand. Was das Formular nicht abbilden kann, bleibt als „CUSTOM“ unverändert. */
function parseRule(rule, iso) {
  const rep = defaultRep(iso || todayIso());
  const raw = String(rule || '').replace(/^RRULE:/i, '').trim().toUpperCase();
  if (!raw) return rep;
  rep.raw = raw;
  rep.freq = 'CUSTOM';
  const p = {};
  raw.split(';').forEach(kv => { const [k, v] = kv.split('='); if (k) p[k] = v || ''; });
  const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(p.UNTIL || '');
  if (u) {
    rep.until = u[4] ? toIso(new Date(Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]))) : `${u[1]}-${u[2]}-${u[3]}`;
    rep.end = 'until';
  }
  if (+p.COUNT > 0) { rep.count = +p.COUNT; rep.end = 'count'; }

  const allowed = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'COUNT', 'WKST'];
  if (Object.keys(p).some(k => !allowed.includes(k)) || (p.UNTIL && p.COUNT) || (p.UNTIL && !u)) return rep;
  const interval = p.INTERVAL ? +p.INTERVAL : 1;
  if (!(interval >= 1 && interval <= 99)) return rep;
  const items = (p.BYDAY ? p.BYDAY.split(',') : []).map(x => /^([+-]?\d)?([A-Z]{2})$/.exec(x));
  if (items.some(m => !m || !RR_DAYS.includes(m[2]))) return rep;
  const byday = items.map(m => ({ n: m[1] ? +m[1] : 0, wd: RR_DAYS.indexOf(m[2]) }));

  switch (p.FREQ) {
    case 'DAILY':
    case 'YEARLY':
      if (byday.length || p.BYMONTHDAY) return rep;
      break;
    case 'WEEKLY':
      if (p.BYMONTHDAY || byday.some(i => i.n)) return rep;
      if (byday.length) rep.days = sortDays(byday.map(i => i.wd));
      break;
    case 'MONTHLY':
      if (p.BYMONTHDAY) {
        if (byday.length || !/^\d{1,2}$/.test(p.BYMONTHDAY) || +p.BYMONTHDAY > 31) return rep;
        rep.monthMode = 'day';
        rep.monthDay = +p.BYMONTHDAY;
      } else if (byday.length) {
        if (new Set(byday.map(i => i.wd)).size !== 1 || byday.some(i => !ORDS.includes(i.n))) return rep;
        rep.monthMode = 'weekday';
        rep.wd = byday[0].wd;
        rep.ords = sortOrds(byday.map(i => i.n));
      }
      break;
    default:
      return rep;
  }
  rep.freq = p.FREQ;
  rep.interval = interval;
  return rep;
}

/** Formular-Zustand → RRULE (leer = keine Wiederholung) */
function buildRule(rep, allDay) {
  if (rep.freq === 'NONE') return '';
  if (rep.freq === 'CUSTOM') return rep.raw ? `RRULE:${rep.raw}` : '';
  const parts = [`FREQ=${rep.freq}`];
  if (rep.interval > 1) parts.push(`INTERVAL=${rep.interval}`);
  if (rep.freq === 'WEEKLY' && rep.days.length) parts.push(`BYDAY=${sortDays(rep.days).map(d => RR_DAYS[d]).join(',')}`);
  if (rep.freq === 'MONTHLY') {
    if (rep.monthMode === 'weekday') parts.push(`BYDAY=${sortOrds(rep.ords).map(n => `${n}${RR_DAYS[rep.wd]}`).join(',')}`);
    else parts.push(`BYMONTHDAY=${rep.monthDay}`);
  }
  // UNTIL: ganztägig als Datum, sonst Ende des Tages (UTC, schließt den letzten Tag sicher ein)
  if (rep.end === 'until' && rep.until) parts.push(`UNTIL=${rep.until.replace(/-/g, '')}${allDay ? '' : 'T235959Z'}`);
  if (rep.end === 'count' && rep.count > 0) parts.push(`COUNT=${rep.count}`);
  return `RRULE:${parts.join(';')}`;
}

/** Passt der Tag zur Regel? (für den ersten Termin) */
function repMatches(rep, iso) {
  const d = toDate(iso);
  if (rep.freq === 'WEEKLY') return rep.days.includes(d.getDay());
  if (rep.freq === 'MONTHLY') {
    if (rep.monthMode === 'day') return d.getDate() === rep.monthDay;
    return d.getDay() === rep.wd && rep.ords.some(n => (n === -1 ? isLastOfMonth(d) : Math.ceil(d.getDate() / 7) === n));
  }
  return true;
}

/** Erster Tag ab iso, der zur Regel passt (Google zählt das Startdatum sonst immer mit). */
function firstOccurrence(rep, iso) {
  if (!['WEEKLY', 'MONTHLY'].includes(rep.freq)) return iso;
  for (let i = 0; i < 800; i++) {
    const day = addDays(iso, i);
    if (repMatches(rep, day)) return day;
  }
  return iso;
}

/** Text zur Regel: „jeden Monat am 1. Samstag bis 30.06.2027“ (short: Wochentage abgekürzt) */
function repText(rep, short) {
  const wdName = d => (short ? WD_SHORT[d] : WD_LONG[d]);
  const every = (one, many) => (rep.interval > 1 ? `alle ${rep.interval} ${many}` : one);
  let t;
  switch (rep.freq) {
    case 'NONE': return '';
    case 'DAILY': t = every('täglich', 'Tage'); break;
    case 'WEEKLY': t = `${every('jede Woche', 'Wochen')} (${sortDays(rep.days).map(d => WD_SHORT[d]).join(', ')})`; break;
    case 'MONTHLY':
      t = every('jeden Monat', 'Monate') + (rep.monthMode === 'weekday'
        ? ` am ${sortOrds(rep.ords).map(ordLabel).join(' + ')} ${wdName(rep.wd)}`
        : ` am ${rep.monthDay}.`);
      break;
    case 'YEARLY': t = every('jedes Jahr', 'Jahre'); break;
    default: {
      const f = (/FREQ=(\w+)/.exec(rep.raw) || [])[1];
      t = `${{ DAILY: 'täglich', WEEKLY: 'wöchentlich', MONTHLY: 'monatlich', YEARLY: 'jährlich' }[f] || 'Serie'} (eigene Regel)`;
    }
  }
  if (rep.end === 'until' && rep.until) t += ` bis ${fmt(rep.until, { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
  if (rep.end === 'count' && rep.count) t += ` · ${rep.count}-mal`;
  return t;
}

/** Kurzer Text für Liste/Tabelle/Details */
function repeatText(ev) {
  if (!ev.recurrence) return ev.recurring ? 'Serie' : '';
  return repText(parseRule(ev.recurrence, ev.date), true);
}

const minutes = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = mins => `${pad(Math.floor(((mins % 1440) + 1440) % 1440 / 60))}:${pad(((mins % 60) + 60) % 60)}`;

/* ---------- Kopfzeile ---------- */

function renderHeader() {
  const el = $('#syncState');
  const offlineEl = $('#offline');
  if (state.busy) {
    el.innerHTML = `<span class="spin sm"></span>Wird gespeichert…`;
  } else if (state.loadError && state.loadedAt) {
    el.innerHTML = `${icon('wifiOff', 14)}${state.loadError.offline ? 'Offline' : 'Nicht aktuell'} · Stand ${timeNow(state.loadedAt)}`;
  } else if (state.loadedAt) {
    el.innerHTML = `<span class="ok">${icon('check', 14, 2.5)}</span>Im Kalender · Stand ${timeNow(state.loadedAt)}`;
  } else {
    el.textContent = '';
  }

  if (state.loadError && state.loadedAt) {
    $('#offlineText').textContent = state.loadError.offline
      ? `Offline – du siehst den Stand von ${timeNow(state.loadedAt)}. Änderungen gehen erst wieder mit Verbindung.`
      : `Laden fehlgeschlagen – du siehst den Stand von ${timeNow(state.loadedAt)}. ${state.loadError.message}`;
    offlineEl.hidden = false;
  } else {
    offlineEl.hidden = true;
  }
  $('#btnNew').hidden = !can('write') || (state.view === 'table' && tbl.selected.size > 0);
}

/* ---------- Liste (V2, Kapitel 8.1) ---------- */

function matches(ev, q) {
  return !q || `${ev.subject} ${ev.location} ${ev.description} ${ev.category}`.toLowerCase().includes(q);
}

function render() {
  renderHeader();
  if (state.page) renderPage();
  // Tabelle (V3 7.2): nur Schreiben/Admin und ab 768 px – sonst zurück zur Liste
  if (state.view === 'table' && state.role && !tableAllowed()) state.view = 'list';
  $('#btnTable').hidden = !tableAllowed();
  const week = state.view === 'week';
  const table = state.view === 'table';
  $('#weekHead').hidden = !week;
  $('#searchBox').hidden = week;
  document.querySelectorAll('.seg [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  listEl.classList.toggle('week-list', week);
  listEl.classList.toggle('table-list', table);
  document.body.classList.toggle('is-table', table);
  if (week && state.loadedAt) return renderWeek();
  if (table && state.loadedAt) return renderTable();
  if (!state.loadedAt) {
    if (state.loadError) {
      listEl.innerHTML = `<div class="empty">${icon('wifiOff', 32)}<p>${esc(state.loadError.message)}</p>
        <button class="btn small" type="button" id="retry">${icon('refresh', 18)}Nochmal versuchen</button></div>`;
      $('#retry').onclick = load;
    }
    return;
  }

  const today = todayIso();
  const q = state.q.trim().toLowerCase();
  const showPast = state.showPast || !!q;
  const wStart = weekStart(today);
  const wEnd = addDays(wStart, 6);
  const curMonth = today.slice(0, 7);

  const past = [];
  const groups = []; // { key, label, today?, items }
  const groupFor = (key, label, isToday) => {
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, label, today: isToday, items: [] }; groups.push(g); }
    return g;
  };

  for (const ev of state.events) {
    if (!matches(ev, q)) continue;
    const end = ev.endDate || ev.date;
    if (end < today) { past.push(ev); continue; }
    if (ev.date <= today) groupFor('today', '', true).items.push(ev);
    else if (ev.date <= wEnd) groupFor('week', 'Diese Woche').items.push(ev);
    else if (ev.date.slice(0, 7) === curMonth) groupFor('month', `Später im ${monthName(today)}`).items.push(ev);
    else groupFor(ev.date.slice(0, 7), fmt(ev.date, { month: 'long', year: 'numeric' })).items.push(ev);
  }
  const order = ['today', 'week', 'month'];
  groups.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib);
    return a.key.localeCompare(b.key);
  });

  let html = '';
  if (!q) {
    html += `<button class="past-btn" type="button" id="pastBtn" aria-expanded="${state.showPast}">
      ${icon(state.showPast ? 'chevronDown' : 'chevronUp', 14, 2.5)}${state.showPast ? 'Vergangene ausblenden' : 'Vergangene Termine'}</button>`;
  }
  if (ROLE_RANK[state.role] >= ROLE_RANK.write && !store.get(KEY_SWIPE_HINT)) {
    html += `<p class="swipe-hint">Tipp: Karte nach links wischen = Absagen · nach rechts = Verschieben</p>`;
  }

  if (showPast && past.length) {
    let month = '';
    for (const ev of past) {
      const key = ev.date.slice(0, 7);
      if (key !== month) {
        month = key;
        html += `<h2 class="group">${esc(fmt(ev.date, { month: 'long', year: 'numeric' }))} · vergangen</h2>`;
      }
      html += cardHtml(ev, false);
    }
  } else if (state.showPast && !past.length) {
    html += `<p class="empty" style="padding:16px">Keine vergangenen Termine.</p>`;
  }

  for (const g of groups) {
    html += g.today
      ? `<h2 class="group-today" id="todayAnchor"><span class="today-tag">HEUTE</span>${esc(fmt(today, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>`
      : `<h2 class="group" data-upcoming>${esc(g.label)}</h2>`;
    html += g.items.map(ev => cardHtml(ev, g.today && ev.date === today)).join('');
  }

  if (!groups.length && !(showPast && past.length)) {
    html += `<div class="empty">${icon('calendar', 32)}<p>${q ? 'Keine Treffer.' : 'Keine kommenden Termine.'}</p></div>`;
  }

  listEl.innerHTML = html;
  const pb = $('#pastBtn');
  if (pb) pb.onclick = () => { state.showPast = !state.showPast; render(); if (state.showPast) listEl.scrollIntoView(); };
}

function cardKey(ev) {
  // eventId; nur für noch nicht übertragene Sheet-Zeilen (Datenquelle „sheet“) ein Anzeige-Schlüssel
  return ev.eventId || `tmp-${ev.date}-${ev.subject}`;
}

/** Karten wischen: nur Schreiben/Admin, nur aktive Termine, nur in der Liste. */
function canSwipeCard(ev) {
  return state.view === 'list' && ROLE_RANK[state.role] >= ROLE_RANK.write && ev.status === S.AKTIV && !state.saving[cardKey(ev)];
}

function cardHtml(ev, isToday) {
  const saving = state.saving[cardKey(ev)];
  const cls = ['card'];
  if (saving) cls.push('is-saving');
  if (ev.status === S.ABGESAGT) cls.push('is-cancelled');
  else if (ev.status === S.VERSCHOBEN) cls.push('is-moved');
  else if (isToday) cls.push('is-today');
  const meta = [timeText(ev), ev.location].filter(Boolean).map(esc).join(' · ');
  const statusWord = ev.status === S.ABGESAGT ? ', abgesagt' : ev.status === S.VERSCHOBEN ? ', verschoben' : '';
  const card = `<button class="${cls.join(' ')}" type="button" data-i="${state.events.indexOf(ev)}" data-key="${esc(cardKey(ev))}"
      aria-label="${esc(`${ev.subject}, ${longDate(ev.date)}, ${timeText(ev)}${statusWord}`)}">
    <span class="tile" aria-hidden="true"><span class="wd">${esc(wdShort(ev.date))}</span><span class="d">${toDate(ev.date).getDate()}</span><span class="m">${esc(fmt(ev.date, { month: 'short' }).replace('.', ''))}</span></span>
    <span class="card-body" aria-hidden="true">
      <span class="card-title">${esc(ev.subject)}</span>
      <span class="card-meta">${meta}</span>
      ${saving ? `<span class="badges"><span class="badge off saving"><span class="spin"></span>${esc(saving)}</span></span>` : badgesHtml(ev, false)}
    </span>
  </button>`;
  if (!canSwipeCard(ev)) return card;
  return `<div class="swipe-wrap" data-swipe="${esc(cardKey(ev))}">
    <div class="swipe-bg" aria-hidden="true">
      <span class="sw-move">${icon('arrowRight', 18)}<b>Verschieben</b></span>
      <span class="sw-cancel"><b>Absagen</b>${icon('ban', 18)}</span>
    </div>${card}</div>`;
}

function categoryBadge(ev) {
  if (!ev.category) return '';
  const color = categoryColor(ev.category);
  return `<span class="badge">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(ev.category)}</span>`;
}

function badgesHtml(ev, withStatus) {
  const b = [];
  if (withStatus) b.push(statusBadge(ev));
  if (ev.status === S.VERSCHOBEN) {
    const target = parseGermanDate(ev.verschobenAuf);
    b.push(`<span class="badge warn">${icon('arrowRight', 12, 2.5)}${target ? `Verschoben auf ${esc(wdDayMonth(target))}` : 'Verschoben'}</span>`);
  }
  if (ev.status === S.ABGESAGT && !withStatus) b.push(`<span class="badge off">${icon('x', 12, 2.5)}Abgesagt</span>`);
  if (ev.status === S.LOESCHEN && !withStatus) b.push(`<span class="badge off">Wird gelöscht</span>`);
  b.push(categoryBadge(ev));
  if (ev.recurring) b.push(`<span class="badge">${icon('series', 12, 2.5)}Serie</span>`);
  const from = movedFrom(ev);
  if (from) b.push(`<span class="badge plain">vom ${esc(from)} verschoben</span>`);
  if (!ev.synced && ev.status !== S.LOESCHEN) b.push(`<span class="badge plain">Noch nicht im Kalender</span>`);
  const inner = b.filter(Boolean).join('');
  return inner ? `<span class="badges">${inner}</span>` : '';
}

function statusBadge(ev) {
  switch (ev.status) {
    case S.ABGESAGT: return `<span class="badge off">${icon('x', 12, 2.5)}Abgesagt</span>`;
    case S.VERSCHOBEN: return '';
    case S.LOESCHEN: return `<span class="badge off">Wird gelöscht</span>`;
    default: return `<span class="badge ok"><span class="dot"></span>Aktiv</span>`;
  }
}

/* ---------- Wochenansicht (V2, Kapitel 8.2) ---------- */

/** ISO-Kalenderwoche */
function isoWeek(iso) {
  const d = toDate(iso);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Donnerstag dieser Woche
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function weekRangeLabel(start) {
  const end = addDays(start, 6);
  const a = toDate(start), b = toDate(end);
  const month = d => d.toLocaleDateString('de-DE', { month: 'long' });
  if (a.getFullYear() !== b.getFullYear()) {
    return `${a.getDate()}. ${month(a)} ${a.getFullYear()} – ${b.getDate()}. ${month(b)} ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()}. ${month(a)} – ${b.getDate()}. ${month(b)}`;
  return `${a.getDate()}.–${b.getDate()}. ${month(b)}`;
}

function weekRelative(start) {
  const diff = Math.round((toDate(start) - toDate(weekStart(todayIso()))) / (7 * 86400000));
  if (diff === 0) return 'diese Woche';
  if (diff === 1) return 'nächste Woche';
  if (diff === -1) return 'letzte Woche';
  return diff > 0 ? `in ${diff} Wochen` : `vor ${-diff} Wochen`;
}

function eventsOn(iso) {
  return state.events.filter(ev => ev.date <= iso && (ev.endDate || ev.date) >= iso);
}

function ensureWeek() {
  if (!state.weekStart) state.weekStart = weekStart(todayIso());
  const end = addDays(state.weekStart, 6);
  if (!state.selDay || state.selDay < state.weekStart || state.selDay > end) {
    const t = todayIso();
    state.selDay = t >= state.weekStart && t <= end ? t : state.weekStart;
  }
}

function dotColor(ev) {
  if (ev.status === S.VERSCHOBEN) return 'var(--warn-solid)';
  if (ev.status === S.ABGESAGT) return 'var(--off)';
  return categoryColor(ev.category) || 'var(--muted)';
}

function shortTime(ev) {
  if (ev.allDay) return 'Ganztägig';
  return ev.end ? `${ev.start}–${ev.end}` : ev.start;
}

function renderWeek() {
  ensureWeek();
  const today = todayIso();
  const days = [...Array(7)].map((_, i) => addDays(state.weekStart, i));

  $('#weekRange').textContent = weekRangeLabel(state.weekStart);
  $('#weekSub').textContent = `KW ${isoWeek(state.weekStart)} · ${weekRelative(state.weekStart)}`;

  $('#dayStrip').innerHTML = days.map(d => {
    const evs = eventsOn(d);
    const dots = evs.slice(0, 3).map(ev => `<i style="background:${dotColor(ev)}"></i>`).join('');
    const label = `${longDate(d)}${d === today ? ', heute' : ''}, ${evs.length ? `${evs.length} ${evs.length === 1 ? 'Termin' : 'Termine'}` : 'kein Termin'}`;
    return `<button class="day-btn${d === today ? ' is-today' : ''}" type="button" data-day="${d}" aria-pressed="${d === state.selDay}" aria-label="${esc(label)}">
      <span class="wd" aria-hidden="true">${esc(wdShort(d))}</span><span class="d" aria-hidden="true">${toDate(d).getDate()}</span>
      <span class="day-dots" aria-hidden="true">${dots}</span></button>`;
  }).join('');

  listEl.innerHTML = days.map(d => {
    const evs = eventsOn(d);
    const cards = evs.map(ev => {
      const cls = ['wcard'];
      let meta;
      if (ev.status === S.VERSCHOBEN) {
        cls.push('is-moved');
        const target = parseGermanDate(ev.verschobenAuf);
        meta = `${esc(shortTime(ev))} · ${target ? `Verschoben auf ${esc(wdDayMonth(target))}` : 'Verschoben'}`;
      } else if (ev.status === S.ABGESAGT) {
        cls.push('is-cancelled');
        meta = `${esc(shortTime(ev))} · Abgesagt`;
      } else {
        if (d === today) cls.push('is-today');
        const color = categoryColor(ev.category);
        meta = `${color ? `<span class="dot" style="background:${color}"></span>` : ''}${[shortTime(ev), ev.location].filter(Boolean).map(esc).join(' · ')}`;
      }
      const statusWord = ev.status === S.ABGESAGT ? ', abgesagt' : ev.status === S.VERSCHOBEN ? ', verschoben' : '';
      return `<button class="${cls.join(' ')}" type="button" data-i="${state.events.indexOf(ev)}" data-key="${esc(cardKey(ev))}"
          aria-label="${esc(`${ev.subject}, ${timeText(ev)}${ev.location ? ', ' + ev.location : ''}${statusWord}`)}">
        <span class="wmeta" aria-hidden="true">${meta}</span><span class="wtitle" aria-hidden="true">${esc(ev.subject)}</span></button>`;
    }).join('');
    return `<section class="day-row${d === today ? ' is-today' : ''}" id="day-${d}" aria-label="${esc(longDate(d))}">
      <div class="day-label" aria-hidden="true"><span class="wd">${esc(wdShort(d))}</span><span class="d">${toDate(d).getDate()}</span></div>
      ${cards ? `<div class="day-events">${cards}</div>` : '<span class="day-empty">Kein Termin</span>'}
    </section>`;
  }).join('');
}

function setView(view) {
  state.view = view === 'week' || (view === 'table' && tableAllowed()) ? view : 'list';
  store.set(KEY_VIEW, state.view);
  render();
  window.scrollTo(0, 0);
}

function shiftWeek(n) {
  ensureWeek();
  state.weekStart = addDays(state.weekStart, 7 * n);
  const t = todayIso();
  const end = addDays(state.weekStart, 6);
  state.selDay = t >= state.weekStart && t <= end ? t : state.weekStart;
  renderWeek();
  window.scrollTo(0, 0);
}

function scrollToDay(d) {
  const row = document.getElementById('day-' + d);
  if (!row) return;
  const smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  row.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

/* ---------- Gesten (V2, Kapitel 8.6) ---------- */

const CARD_SWIPE_RATIO = 0.35;   // Schwelle: 35 % der Kartenbreite
const AXIS_LOCK = 10;            // ab hier wird entschieden: waagerecht oder senkrecht

/* --- Karte wischen: links = Absagen (sofort, mit Rückgängig), rechts = Verschieben --- */

const cardSwipe = { wrap: null, card: null, x: 0, y: 0, dx: 0, axis: null, moved: false, width: 0 };

function cardSwipeStart(target, x, y) {
  const wrap = target.closest && target.closest('.swipe-wrap');
  if (!wrap || state.view !== 'list' || state.busy || !sheetEl.hidden) return;
  Object.assign(cardSwipe, { wrap, card: wrap.querySelector('.card'), x, y, dx: 0, axis: null, moved: false, width: wrap.offsetWidth });
}

/** true = waagerechte Geste erkannt (dann nicht scrollen). */
function cardSwipeMove(x, y) {
  const c = cardSwipe;
  if (!c.wrap) return false;
  const dx = x - c.x, dy = y - c.y;
  if (c.axis === null && (Math.abs(dx) > AXIS_LOCK || Math.abs(dy) > AXIS_LOCK)) {
    c.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
    if (c.axis === 'y') { c.wrap = null; return false; } // senkrecht: normal scrollen
    c.wrap.classList.add('dragging');
  }
  if (c.axis !== 'x') return false;
  c.dx = dx;
  c.card.style.transition = 'none';
  c.card.style.transform = `translateX(${dx}px)`;
  c.wrap.classList.toggle('dir-left', dx < 0);
  c.wrap.classList.toggle('dir-right', dx > 0);
  c.wrap.classList.toggle('armed', Math.abs(dx) >= c.width * CARD_SWIPE_RATIO);
  return true;
}

function cardSwipeEnd() {
  const c = cardSwipe;
  if (!c.wrap) return;
  const { wrap, card, dx, width } = c;
  c.wrap = null;
  if (c.axis !== 'x') return;
  c.moved = true;
  setTimeout(() => { c.moved = false; }, 350);

  const ev = state.events.find(e => cardKey(e) === wrap.dataset.swipe);
  const passed = Math.abs(dx) >= width * CARD_SWIPE_RATIO;
  const anim = !reducedMotion();
  const reset = () => {
    card.style.transition = anim ? 'transform .2s ease-out' : 'none';
    card.style.transform = '';
    setTimeout(() => wrap.classList.remove('dragging', 'dir-left', 'dir-right', 'armed'), anim ? 200 : 0);
  };
  if (!passed || !ev) return reset();

  store.set(KEY_SWIPE_HINT, '1');
  if (dx < 0) {
    // Absagen: Karte rausschieben, dann sofort speichern
    card.style.transition = anim ? 'transform .18s ease-in' : 'none';
    card.style.transform = `translateX(${-width}px)`;
    setTimeout(() => quickStatus(ev, S.ABGESAGT), anim ? 180 : 0);
  } else {
    reset();
    openMove(ev);
  }
}

/**
 * Status ohne Sheet ändern (Wischen, Rückgängig). Die Karte zeigt solange
 * „Wird abgesagt…“, die Kopfzeile „Wird gespeichert…“.
 */
async function quickStatus(ev, status) {
  if (state.busy) return;
  const key = cardKey(ev);
  state.busy = true;
  state.saving[key] = status === S.ABGESAGT ? 'Wird abgesagt…' : 'Wird zurückgesetzt…';
  render();
  try {
    const d = await api('setStatus', { ref: ref(ev), status });
    applyData(d);
    delete state.saving[key];
    state.busy = false;
    render();
    if (status === S.ABGESAGT && !d.warning) {
      toast('Termin abgesagt.', false, {
        label: 'Rückgängig',
        onClick: () => {
          const fresh = state.events.find(e => cardKey(e) === key) || ev;
          quickStatus(fresh, S.AKTIV);
        },
      });
    } else {
      toast(d.message || 'Gespeichert.', d.warning);
    }
  } catch (e) {
    delete state.saving[key];
    state.busy = false;
    if (e.auth) return logout(e.message);
    render();
    toast(e.message, true);
  }
}

listEl.addEventListener('touchstart', e => {
  if (e.touches.length === 1) cardSwipeStart(e.target, e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
listEl.addEventListener('touchmove', e => {
  if (cardSwipeMove(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
}, { passive: false });
listEl.addEventListener('touchend', cardSwipeEnd);
listEl.addEventListener('touchcancel', () => { if (cardSwipe.wrap) { cardSwipe.dx = 0; cardSwipeEnd(); } });
listEl.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') cardSwipeStart(e.target, e.clientX, e.clientY); });
window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') cardSwipeMove(e.clientX, e.clientY); });
window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') cardSwipeEnd(); });

/* --- Pull-to-Refresh in Liste und Woche --- */

// Bewusst ziehen: Der Inhalt wandert sichtbar mit (mit Widerstand). Ausgelöst wird nur,
// wenn der Zugweg erreicht ist UND dort kurz gehalten wird – schnelles Wischen
// (normales Scrollen) löst nie aus, egal wie weit.
const PTR_RESIST = 0.45;   // Inhalt bewegt sich mit 45 % des Fingerwegs
const PTR_TRIGGER = 90;    // sichtbarer Zugweg (≈ 210 px Fingerweg)
const PTR_DWELL = 250;     // so lange (ms) muss der Zugweg gehalten werden
const PTR_MAX = 130;
const ptr = { y: 0, x: 0, pull: 0, active: false, axis: null, moved: false, loading: false, reachedAt: 0, armed: false, timer: null };

function setArmed(on) {
  ptr.armed = on;
  reloadBtn.classList.toggle('ready', on);
  if (on && navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* egal */ } }
}
const reloadBtn = $('#btnReload');

/** Steht die Seite ganz oben? Prüft Fenster und mögliche Scroll-Container. */
function atPageTop() {
  const se = document.scrollingElement || document.documentElement;
  return Math.max(window.scrollY || 0, se.scrollTop || 0, document.body.scrollTop || 0) <= 0;
}

/** Zieh-Anzeige: Inhalt rutscht mit, der ↻-Knopf färbt sich ein und dreht sich. */
function setPtr(px, animate) {
  const icn = reloadBtn.querySelector('.ic');
  reloadBtn.classList.toggle('pulling', px > 0);
  if (icn) icn.style.transform = px > 0 ? `rotate(${Math.round(px * 3)}deg)` : '';
  listEl.style.transition = animate && !reducedMotion() ? 'transform .25s ease-out' : 'none';
  listEl.style.transform = px > 0 ? `translateY(${px}px)` : '';
}

function ptrStart(x, y) {
  if (!atPageTop() || ptr.loading || state.busy || !sheetEl.hidden || state.page) return;
  clearTimeout(ptr.timer);
  Object.assign(ptr, { x, y, pull: 0, active: true, axis: null, moved: false, reachedAt: 0, armed: false, timer: null });
}

function ptrMove(x, y) {
  if (!ptr.active) return false;
  const dx = x - ptr.x, dy = y - ptr.y;
  if (ptr.axis === null && (Math.abs(dx) > AXIS_LOCK || Math.abs(dy) > AXIS_LOCK)) {
    ptr.axis = dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.5 && atPageTop() ? 'down' : 'other';
    if (ptr.axis !== 'down') { ptr.active = false; return false; }
  }
  if (ptr.axis !== 'down') return false;
  if (!atPageTop()) { ptr.active = false; setPtr(0, true); return false; }
  ptr.pull = Math.max(0, Math.min(PTR_MAX, (dy - AXIS_LOCK) * PTR_RESIST));
  setPtr(ptr.pull, false);
  if (ptr.pull >= PTR_TRIGGER) {
    if (!ptr.reachedAt) {
      ptr.reachedAt = Date.now();
      // erst nach kurzem Halten „scharf“ – dann färbt sich der Knopf voll ein
      ptr.timer = setTimeout(() => { if (ptr.active && ptr.pull >= PTR_TRIGGER) setArmed(true); }, PTR_DWELL);
    }
  } else if (ptr.reachedAt) {
    ptr.reachedAt = 0;
    clearTimeout(ptr.timer);
    setArmed(false);
  }
  return true;
}

async function ptrEnd() {
  if (!ptr.active) return;
  ptr.active = false;
  if (ptr.axis !== 'down') return;
  ptr.moved = true;
  setTimeout(() => { ptr.moved = false; }, 350);
  clearTimeout(ptr.timer);
  const go = ptr.armed && ptr.pull >= PTR_TRIGGER && Date.now() - ptr.reachedAt >= PTR_DWELL;
  setArmed(false);
  setPtr(0, true);                        // Inhalt federt zurück
  if (!go) return;
  ptr.loading = true;
  reloadBtn.classList.add('ready');      // bleibt eingefärbt, solange geladen wird
  await load(true);                       // dreht den Knopf (.spinning)
  reloadBtn.classList.remove('ready');
  ptr.loading = false;
  toast(state.loadError ? state.loadError.message : 'Aktualisiert.', !!state.loadError);
}

// am ganzen App-Bereich, damit auch leere Listen gezogen werden können
appEl.addEventListener('touchstart', e => {
  const tblScroll = e.target.closest('.tbl-scroll');
  if (e.touches.length === 1 && !e.target.closest('#dayStrip, .swipe-wrap.dragging') && !(tblScroll && tblScroll.scrollTop > 0)) {
    ptrStart(e.touches[0].clientX, e.touches[0].clientY);
  }
  else ptr.active = false;
}, { passive: true });
appEl.addEventListener('touchmove', e => {
  if (cardSwipe.axis === 'x' && cardSwipe.wrap) return;
  if (e.touches.length !== 1) { ptr.active = false; return; }
  if (ptrMove(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
}, { passive: false });
appEl.addEventListener('touchend', ptrEnd);
appEl.addEventListener('touchcancel', () => {
  ptr.active = false;
  clearTimeout(ptr.timer);
  if (!ptr.loading) { setArmed(false); setPtr(0, true); }
});

/* --- Sheet nach unten ziehen zum Schließen (iPhone-App ohne Zurück-Geste) --- */

const sheetDrag = { y: 0, x: 0, dy: 0, active: false, axis: null };

sheetEl.addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || state.busy) return;
  const scroller = sheetEl.querySelector('.sheet-scroll');
  const onHandle = e.target.closest('.grip, .sheet-head, h2');
  if (!onHandle && scroller && scroller.scrollTop > 0) return;
  if (e.target.closest('input, textarea, select, .swatches, .day-strip')) return;
  Object.assign(sheetDrag, { y: e.touches[0].clientY, x: e.touches[0].clientX, dy: 0, active: true, axis: null });
}, { passive: true });

sheetEl.addEventListener('touchmove', e => {
  if (!sheetDrag.active) return;
  const dy = e.touches[0].clientY - sheetDrag.y;
  const dx = e.touches[0].clientX - sheetDrag.x;
  if (sheetDrag.axis === null && (Math.abs(dy) > AXIS_LOCK || Math.abs(dx) > AXIS_LOCK)) {
    sheetDrag.axis = dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'down' : 'other';
    if (sheetDrag.axis !== 'down') { sheetDrag.active = false; return; }
    sheetEl.classList.add('dragging');
  }
  if (sheetDrag.axis !== 'down') return;
  sheetDrag.dy = Math.max(0, dy);
  sheetEl.style.transform = `translateY(${sheetDrag.dy}px)`;
  if (e.cancelable) e.preventDefault();
}, { passive: false });

sheetEl.addEventListener('touchend', () => {
  if (!sheetDrag.active) return;
  sheetDrag.active = false;
  sheetEl.classList.remove('dragging');
  if (sheetDrag.axis !== 'down') return;
  if (sheetDrag.dy > Math.min(140, sheetEl.offsetHeight * 0.25)) closeSheet();
  else sheetEl.style.transform = '';
});

/* ---------- Bottom Sheet mit Fokusführung ---------- */

let lastFocus = null;
let lastFocusKey = null;

function focusables(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function openSheet(html, opts = {}) {
  const wasOpen = sheetEl.classList.contains('open');
  if (!wasOpen) {
    lastFocus = document.activeElement;
    const card = lastFocus && lastFocus.closest && lastFocus.closest('.card, .wcard');
    lastFocusKey = card ? card.dataset.key : null;
  }
  if (!wasOpen) pushNav('sheet');
  sheetEl.innerHTML = html;
  hydrateIcons(sheetEl);
  sheetEl.hidden = false;
  sheetEl.style.transform = '';
  setBackgroundInert(true);
  backdropEl.classList.add('open');
  requestAnimationFrame(() => sheetEl.classList.add('open'));

  const target = sheetEl.querySelector(opts.focus || '[data-autofocus]') || sheetEl.querySelector('#sheetTitle');
  if (target) {
    if (target.id === 'sheetTitle') target.setAttribute('tabindex', '-1');
    setTimeout(() => target.focus({ preventScroll: true }), wasOpen ? 0 : 60);
  }
  const scroller = sheetEl.querySelector('.sheet-scroll');
  if (scroller) scroller.scrollTop = 0;
}

/** Hintergrund (Liste bzw. Verwaltungsseite) für Tastatur und Screenreader sperren, solange ein Sheet offen ist. */
function setBackgroundInert(on) {
  [appEl, pageEl].forEach(el => {
    el.inert = on;
    if (on) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
  });
}

function closeSheet(force, fromHistory) {
  if (state.busy && !force) return;
  if (!sheetEl.classList.contains('open') && sheetEl.hidden) return;
  if (!fromHistory) popNav('sheet');
  sheetEl.style.transform = '';
  sheetEl.classList.remove('open');
  backdropEl.classList.remove('open');
  setBackgroundInert(false);
  setTimeout(() => { if (!sheetEl.classList.contains('open')) { sheetEl.hidden = true; sheetEl.innerHTML = ''; } }, 260);
  restoreFocus();
}

/** Fokus zurück auf das auslösende Element – oder dieselbe Karte, falls die Liste neu gezeichnet wurde. */
/* Zurück-Taste (Android) bzw. Zurück-Geste (Browser): Für jedes offene Sheet und
 * jede Verwaltungsseite liegt ein Eintrag im Verlauf. popstate schließt es wieder. */
let navSkip = 0;
let navPending = null; // Eintrag, der nach einem laufenden history.back() angelegt wird

function pushNav(kind) {
  if (navSkip > 0) { navPending = kind; return; }
  try { history.pushState({ dp: kind }, ''); } catch (e) { /* egal */ }
}

/** Beim Schließen über die Oberfläche den eigenen Verlaufseintrag wieder entfernen. */
function popNav(kind) {
  if (history.state && history.state.dp === kind) {
    navSkip++;
    history.back();
  }
}

window.addEventListener('popstate', () => {
  if (navSkip > 0) {
    navSkip--;
    if (navSkip === 0 && navPending) { const k = navPending; navPending = null; pushNav(k); }
    return;
  }
  if (!sheetEl.hidden && sheetEl.classList.contains('open')) {
    if (state.busy) { pushNav('sheet'); return; } // während des Speicherns offen lassen
    closeSheet(false, true);
  } else if (state.page) {
    closePage(true);
  }
});

function restoreFocus() {
  const el = lastFocus;
  const key = lastFocusKey;
  lastFocus = null;
  lastFocusKey = null;
  setTimeout(() => {
    let target = el && document.contains(el) ? el : null;
    if (!target && key) target = listEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!target && state.view === 'table' && tbl.focus && !state.page) target = tableCell(tbl.focus.id, tbl.focus.col);
    if (!target) target = state.page ? pageEl.querySelector('h1') : $('#btnMore');
    if (state.page && target && !pageEl.contains(target)) target = pageEl.querySelector('h1');
    if (target && (!appEl.hidden || state.page)) target.focus({ preventScroll: true });
  }, 30);
}

// Fokus im Sheet halten, Escape schließt
sheetEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const f = focusables(sheetEl);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !sheetEl.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
backdropEl.addEventListener('click', () => closeSheet());

const closeBtn = () => `<button class="close-btn" type="button" data-close aria-label="Schließen" data-icon="x"></button>`;
const grip = '<div class="grip" aria-hidden="true"></div>';

function bindClose() {
  sheetEl.querySelectorAll('[data-close]').forEach(b => (b.onclick = () => closeSheet()));
}

/* ---------- Details (V2, Kapitel 8.3) ---------- */

function openDetail(ev) {
  const notes = [];
  if (ev.status === S.VERSCHOBEN) {
    notes.push(`<div class="note warn">${icon('arrowRight', 18)}<span>Verschoben${ev.verschobenAuf ? ` auf <b>${esc(ev.verschobenAuf)}</b>` : ''}.${
      ev.folgetermin ? ' Der neue Termin ist angelegt.' : ''}</span></div>`);
  }
  if (ev.status === S.ABGESAGT) notes.push(`<div class="note">${icon('ban', 18)}<span>Abgesagt. Der Termin bleibt im Kalender sichtbar.</span></div>`);
  if (ev.recurring) notes.push(`<div class="note">${icon('series', 18)}<span>Serientermin${repeatText(ev) && repeatText(ev) !== 'Serie' ? ` (${esc(repeatText(ev))})` : ''} – Änderungen gelten für die ganze Serie.</span></div>`);

  const last = ev.lastChange ? `Letzte Änderung: ${esc(ev.lastChange)}` : '';
  let actions;
  if (!can('write')) {
    actions = `
      <div class="note outline">${icon('eye', 18)}<span>Du kannst Termine ansehen. Änderungen macht, wer den Dienstplan pflegt.</span></div>
      <button class="btn" type="button" data-close>Schließen</button>
      ${last ? `<span class="small-note center">${last}</span>` : ''}`;
  } else {
    const main = ev.status === S.AKTIV
      ? `<div class="tiles">
           <button class="tile-btn" type="button" data-act="cancel">${icon('ban', 22)}Absagen</button>
           <button class="tile-btn warn" type="button" data-act="move">${icon('arrowRight', 22)}Verschieben</button>
         </div>
         <button class="btn primary" type="button" data-act="edit">${icon('pencil', 20)}Bearbeiten</button>`
      : `<button class="btn primary" type="button" data-act="reactivate">${icon('refresh', 20)}Wieder aktivieren</button>
         <button class="btn" type="button" data-act="edit">${icon('pencil', 20)}Bearbeiten</button>`;
    const del = can('admin') ? `<button class="btn danger" type="button" data-act="delete">Löschen</button>` : '';
    actions = `${main}${last || del ? `<div class="foot-row"><span class="small-note">${last}</span>${del}</div>` : ''}`;
  }

  openSheet(`<div class="sheet-scroll">
    ${grip}
    <div class="sheet-head">
      <div>
        ${badgesHtml(ev, true)}
        <h2 id="sheetTitle">${esc(ev.subject)}</h2>
      </div>
      ${closeBtn()}
    </div>
    <div class="facts">
      <div class="fact">${icon('calendar', 20)}<div><strong>${esc(relDayPrefix(ev.date) + longDate(ev.date))}</strong><span class="muted">${esc(timeText(ev))}</span></div></div>
      ${ev.location ? `<div class="fact">${icon('pin', 20)}<span>${esc(ev.location)}</span></div>` : ''}
      ${ev.description ? `<div class="fact">${icon('note', 20)}<span class="desc">${esc(ev.description)}</span></div>` : ''}
    </div>
    ${notes.join('')}
    <div class="actions">${actions}</div>
  </div>`);
  bindClose();

  const handlers = {
    edit: () => openForm(ev),
    move: () => openMove(ev),
    cancel: () => confirmAct({
      title: 'Termin absagen?',
      text: `„${ev.subject}“ bleibt im Kalender sichtbar und wird als abgesagt markiert.`,
      label: 'Absagen', cls: 'primary',
      onYes: btn => setStatus(ev, S.ABGESAGT, btn),
      back: () => openDetail(ev),
    }),
    reactivate: btn => ev.folgetermin
      ? confirmAct({
          title: 'Wieder aktivieren?',
          text: 'Der bereits angelegte neue Termin bleibt bestehen. Falls er nicht mehr gebraucht wird, bitte separat absagen oder löschen.',
          label: 'Wieder aktivieren', cls: 'primary',
          onYes: b => setStatus(ev, S.AKTIV, b),
          back: () => openDetail(ev),
        })
      : setStatus(ev, S.AKTIV, btn),
    delete: () => confirmAct({
      title: 'Termin löschen?',
      text: `„${ev.subject}“ wird aus dem Kalender entfernt. Wenn er nur ausfällt, ist „Absagen“ meist besser – dann sehen es alle.`,
      label: 'Endgültig löschen', cls: 'primary',
      onYes: btn => setStatus(ev, S.LOESCHEN, btn),
      back: () => openDetail(ev),
    }),
  };
  sheetEl.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => handlers[b.dataset.act](b)));
}

function confirmAct(o) {
  openSheet(`<div class="sheet-scroll">
    ${grip}
    <div><h2 id="sheetTitle">${esc(o.title)}</h2><p class="sub">${esc(o.text)}</p></div>
    <div class="actions">
      <button class="btn ${o.cls}" type="button" id="cYes" data-autofocus>${esc(o.label)}</button>
      <button class="btn" type="button" id="cNo">Zurück</button>
    </div>
  </div>`);
  $('#cYes').onclick = e => o.onYes(e.currentTarget);
  $('#cNo').onclick = o.back;
}

/* ---------- Verschieben (V2, Kapitel 8.4) ---------- */

function openMove(ev) {
  const w1 = addDays(ev.date, 7);
  const w2 = addDays(ev.date, 14);
  const dur = (() => {
    const s = minutes(ev.start), e = minutes(ev.end);
    if (s == null || e == null) return null;
    const days = Math.round((toDate(ev.endDate || ev.date) - toDate(ev.date)) / 86400000);
    return e - s + days * 1440;
  })();

  openSheet(`<div class="sheet-scroll">
    ${grip}
    <div>
      <h2 id="sheetTitle">Verschieben</h2>
      <p class="sub">${esc(ev.subject)} · bisher ${esc(wdDayMonth(ev.date))}${ev.allDay ? '' : `, ${esc(ev.start)} Uhr`}</p>
    </div>
    <div class="stack">
      <span class="label" id="quickLabel">Schnell wählen</span>
      <div class="quick" role="group" aria-labelledby="quickLabel">
        <button type="button" data-q="w1" aria-pressed="true"><b>+1 Woche</b><span>${esc(wdDayMonth(w1))}</span></button>
        <button type="button" data-q="w2" aria-pressed="false"><b>+2 Wochen</b><span>${esc(wdDayMonth(w2))}</span></button>
        <button type="button" data-q="other" aria-pressed="false"><b>Anderer Tag</b><span>wählen</span></button>
      </div>
    </div>
    <div class="grid2">
      <label class="field">Neues Datum<input type="date" id="mDate" value="${w1}" required></label>
      ${ev.allDay ? '' : `<label class="field">Uhrzeit<input type="time" id="mTime" value="${esc(ev.start)}"></label>`}
    </div>
    <div class="preview" aria-live="polite" id="mPreview"></div>
    ${ev.folgetermin ? `<div class="note warn">${icon('info', 18)}<span>Für diesen Termin gibt es schon einen neuen Termin. Es wird nur die Markierung geändert.</span></div>` : ''}
    <div class="actions">
      <button class="btn warn" type="button" id="mOk"></button>
      <button class="btn small" type="button" id="mBack">Abbrechen</button>
    </div>
  </div>`);

  const dateEl = $('#mDate');
  const timeEl = $('#mTime');

  const update = () => {
    const d = dateEl.value;
    const quick = d === w1 ? 'w1' : d === w2 ? 'w2' : 'other';
    sheetEl.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.q === quick)));
    if (!d) {
      $('#mPreview').innerHTML = '';
      $('#mOk').textContent = 'Datum wählen';
      return;
    }
    const t = timeEl ? timeEl.value : '';
    let newTime = ev.allDay ? 'Ganztägig' : '';
    if (!ev.allDay && t) {
      newTime = dur != null ? `${t}–${hhmm(minutes(t) + dur)} Uhr` : `${t} Uhr`;
    }
    $('#mPreview').innerHTML = `
      <div class="preview-row old">
        <span class="mini-tile" aria-hidden="true"><span class="wd">${esc(wdShort(ev.date).toUpperCase())}</span><span class="d">${toDate(ev.date).getDate()}</span></span>
        <div><b>Alter Termin bleibt sichtbar</b><span>als „Verschoben auf ${esc(dayMonth(d))}“</span></div>
      </div>
      <div class="preview-row">
        <span class="mini-tile" aria-hidden="true"><span class="wd">${esc(wdShort(d).toUpperCase())}</span><span class="d">${toDate(d).getDate()}</span></span>
        <div><b>Neuer Termin wird angelegt</b><span>${esc([newTime, ev.location].filter(Boolean).join(' · '))}</span></div>
      </div>`;
    $('#mOk').textContent = `Auf ${wdDayMonth(d)} verschieben`;
  };

  sheetEl.querySelectorAll('[data-q]').forEach(b => (b.onclick = () => {
    if (b.dataset.q === 'w1') dateEl.value = w1;
    if (b.dataset.q === 'w2') dateEl.value = w2;
    update();
    if (b.dataset.q === 'other') {
      sheetEl.querySelector('[data-q="other"]').setAttribute('aria-pressed', 'true');
      dateEl.focus();
      if (dateEl.showPicker) { try { dateEl.showPicker(); } catch (e) { /* nicht überall erlaubt */ } }
    }
  }));
  dateEl.addEventListener('input', update);
  if (timeEl) timeEl.addEventListener('input', update);
  update();

  $('#mOk').onclick = e => {
    const newDate = dateEl.value;
    const newTime = timeEl ? timeEl.value : '';
    if (!newDate) return toast('Bitte ein neues Datum wählen.', true);
    if (newDate === ev.date && (!timeEl || newTime === ev.start)) return toast('Das ist noch der alte Termin.', true);
    setStatus(ev, S.VERSCHOBEN, e.currentTarget, { newDate, newTime });
  };
  $('#mBack').onclick = () => openDetail(ev);
}

/* ---------- Neuer Termin / Bearbeiten (V2, Kapitel 8.5, ohne Vorlagen) ---------- */

function openForm(ev, opts) {
  const isNew = !ev;
  // in der Wochenansicht startet ein neuer Termin am gewählten Tag
  const today = state.view === 'week' && state.selDay ? state.selDay : todayIso();
  const e = ev || {
    subject: '', date: today, endDate: today, start: '19:00', end: '21:00',
    allDay: false, location: '', description: '', category: '',
  };
  let category = e.category || '';
  const rep = parseRule(e.recurrence || '', e.date);
  const wasCustom = rep.freq === 'CUSTOM';

  const chips = () => {
    const opts = categoryOptions();
    if (!opts.length) return '';
    const chip = (name, label) => {
      const color = name ? categoryColor(name) : null;
      const on = (category || '').toLowerCase() === (name || '').toLowerCase();
      return `<button class="chip" type="button" data-cat="${esc(name)}" aria-pressed="${on}">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}</button>`;
    };
    return `<div class="stack"><span class="label" id="catLabel">Kategorie</span>
      <div class="chips" role="group" aria-labelledby="catLabel">${opts.map(n => chip(n, n)).join('')}${chip('', 'Keine')}</div></div>`;
  };

  openSheet(`<div class="sheet-scroll">
      ${grip}
      <h2 id="sheetTitle">${isNew ? 'Neuer Termin' : 'Termin bearbeiten'}</h2>
      ${isNew && TEMPLATES.length ? `<div class="stack"><span class="label" id="tplLabel">Vorlage</span>
        <div class="chips" role="group" aria-labelledby="tplLabel">${TEMPLATES.map((t, i) =>
          `<button class="tpl-chip" type="button" data-tpl="${i}" aria-pressed="false">${esc(t.label)}</button>`).join('')}</div></div>` : ''}
      <label class="field">Titel<input id="fSub" value="${esc(e.subject)}" placeholder="z. B. Übungsdienst" autocomplete="off" ${isNew ? 'data-autofocus' : ''}></label>
      <label class="switch-row">Ganztägig
        <span class="switch"><input type="checkbox" id="fAll" role="switch" ${e.allDay ? 'checked' : ''}><span class="track"></span><span class="knob"></span></span>
      </label>
      <div class="grid2">
        <label class="field">Datum<input type="date" id="fDate" value="${esc(e.date)}"></label>
        <label class="field">Bis<input type="date" id="fEnd" value="${esc(e.endDate || e.date)}"></label>
        <label class="field" data-time>Beginn<input type="time" id="fStart" value="${esc(e.start)}"></label>
        <label class="field" data-time>Ende<input type="time" id="fStop" value="${esc(e.end)}"></label>
      </div>
      <fieldset class="rep-box">
        <legend class="label">Wiederholung</legend>
        <div class="rep-row">
          <select id="fRep" aria-label="Wiederholung">
            <option value="NONE">Keine</option><option value="DAILY">Täglich</option><option value="WEEKLY">Wöchentlich</option>
            <option value="MONTHLY">Monatlich</option><option value="YEARLY">Jährlich</option>
            ${wasCustom ? '<option value="CUSTOM">Eigene Regel (aus Google Kalender)</option>' : ''}
          </select>
          <label class="rep-every" data-rep="int">alle <input type="number" id="fInt" min="1" max="99" inputmode="numeric" value="${rep.interval}" aria-label="Abstand"> <span id="fIntUnit"></span></label>
        </div>
        <div class="chips rep-days" data-rep="weekly" role="group" aria-label="An diesen Wochentagen">
          ${WD_ORDER.map(d => `<button class="chip day" type="button" data-wd="${d}" aria-pressed="false" aria-label="${WD_LONG[d]}">${WD_SHORT[d]}</button>`).join('')}
        </div>
        <div class="stack" data-rep="monthly">
          <div class="seg" role="group" aria-label="Monatlich am">
            <button type="button" data-mm="weekday" aria-pressed="false">Am Wochentag</button>
            <button type="button" data-mm="day" aria-pressed="false">Am Tag im Monat</button>
          </div>
          <div class="rep-row" data-rep="mweek">
            <span class="rep-word">am</span>
            <div class="chips" role="group" aria-label="Welcher im Monat">
              ${ORDS.map(n => `<button class="chip day" type="button" data-ord="${n}" aria-pressed="false">${n === -1 ? 'Letzten' : `${n}.`}</button>`).join('')}
            </div>
            <select id="fWd" aria-label="Wochentag">${WD_ORDER.map(d => `<option value="${d}">${WD_LONG[d]}</option>`).join('')}</select>
          </div>
          <label class="rep-row" data-rep="mday"><span class="rep-word">am</span><input type="number" id="fMday" min="1" max="31" inputmode="numeric" value="${rep.monthDay}" aria-label="Tag im Monat"><span class="rep-word">. Tag</span></label>
        </div>
        <div class="rep-row" data-rep="end">
          <select id="fEndMode" aria-label="Ende der Serie">
            <option value="never">Ohne Ende</option><option value="until">Endet am</option><option value="count">Endet nach</option>
          </select>
          <input type="date" id="fUntil" value="${esc(rep.until)}" aria-label="Letzter Termin" data-endf="until">
          <label class="rep-every" data-endf="count"><input type="number" id="fCount" min="1" max="999" inputmode="numeric" value="${rep.count}" aria-label="Anzahl Termine"> Terminen</label>
        </div>
        <p class="small-note rep-preview" id="fRepPreview" aria-live="polite"></p>
        <p class="small-note" id="fRepNote" hidden>Diese Wiederholung wurde im Google Kalender eingestellt. Sie bleibt so, solange du hier nichts anderes wählst.</p>
      </fieldset>
      <label class="field">Ort<input id="fLoc" value="${esc(e.location)}" placeholder="z. B. Feuerwehrhaus"></label>
      <div id="fCats">${chips()}</div>
      <label class="field">Beschreibung<textarea id="fDesc" rows="2" placeholder="z. B. PA mitbringen">${esc(e.description)}</textarea></label>
      ${ev && ev.recurring ? `<div class="note">${icon('series', 18)}<span>Serientermin – Änderungen gelten für die ganze Serie.</span></div>` : ''}
    </div>
    <div class="sheet-foot">
      <button class="btn small" type="button" id="fBack" style="flex:1">Abbrechen</button>
      <button class="btn primary" type="button" id="fOk" style="flex:2">${isNew ? 'Anlegen' : 'Speichern'}</button>
    </div>`, opts && opts.focus ? { focus: opts.focus } : {});

  const toggleTimes = () => sheetEl.querySelectorAll('[data-time]').forEach(el => (el.hidden = $('#fAll').checked));

  // Vorlage anwenden: Titel-Anfang, Uhrzeit, Ort, Kategorie (fehlt sie, bleibt sie leer)
  sheetEl.querySelectorAll('[data-tpl]').forEach(b => (b.onclick = () => {
    const t = TEMPLATES[+b.dataset.tpl];
    const known = categoryOptions().find(n => n.toLowerCase() === (t.category || '').toLowerCase());
    category = known || '';
    $('#fSub').value = t.title || '';
    $('#fAll').checked = false;
    toggleTimes();
    $('#fStart').value = t.start || '';
    $('#fStop').value = t.end || '';
    $('#fLoc').value = t.location || '';
    $('#fCats').innerHTML = chips();
    sheetEl.querySelectorAll('[data-tpl]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const sub = $('#fSub');
    sub.focus();
    sub.setSelectionRange(sub.value.length, sub.value.length);
  }));
  $('#fAll').onchange = toggleTimes;
  toggleTimes();

  // Wiederholung: Bedienelemente ↔ rep
  const repEl = $('#fRep');
  repEl.value = rep.freq;
  $('#fWd').value = String(rep.wd);
  $('#fEndMode').value = rep.end;
  const units = { DAILY: ['Tag', 'Tage'], WEEKLY: ['Woche', 'Wochen'], MONTHLY: ['Monat', 'Monate'], YEARLY: ['Jahr', 'Jahre'] };
  const showRep = () => {
    const f = rep.freq;
    const active = f !== 'NONE' && f !== 'CUSTOM';
    sheetEl.querySelectorAll('[data-rep]').forEach(el => {
      const k = el.dataset.rep;
      el.hidden = !active || (k === 'weekly' && f !== 'WEEKLY') || (k === 'monthly' && f !== 'MONTHLY') ||
        (k === 'mweek' && rep.monthMode !== 'weekday') || (k === 'mday' && rep.monthMode !== 'day');
    });
    sheetEl.querySelectorAll('[data-endf]').forEach(el => (el.hidden = el.dataset.endf !== rep.end));
    if (units[f]) $('#fIntUnit').textContent = units[f][rep.interval === 1 ? 0 : 1];
    sheetEl.querySelectorAll('[data-wd]').forEach(b => b.setAttribute('aria-pressed', String(rep.days.includes(+b.dataset.wd))));
    sheetEl.querySelectorAll('[data-ord]').forEach(b => b.setAttribute('aria-pressed', String(rep.ords.includes(+b.dataset.ord))));
    sheetEl.querySelectorAll('[data-mm]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mm === rep.monthMode)));
    $('#fRepNote').hidden = f !== 'CUSTOM';
    // Vorschau inkl. erstem Termin, falls das Datum nicht zur Regel passt
    const date = $('#fDate').value;
    let text = active || f === 'CUSTOM' ? repText(rep, false) : '';
    if (active && date) {
      const first = firstOccurrence(rep, date);
      if (first !== date) text += ` · Erster Termin: ${wdShort(first)} ${fmt(first, { day: '2-digit', month: '2-digit', year: 'numeric' })} (Datum wird angepasst)`;
    }
    $('#fRepPreview').textContent = text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
    $('#fRepPreview').hidden = !text;
  };
  repEl.onchange = () => {
    const prev = rep.freq;
    rep.freq = repEl.value;
    // beim Einschalten passend zum gewählten Datum vorbelegen
    if (prev === 'NONE' || prev === 'CUSTOM') {
      const d = $('#fDate').value || e.date;
      const def = defaultRep(d);
      Object.assign(rep, { days: def.days, monthDay: def.monthDay, ords: def.ords, wd: def.wd, monthMode: 'weekday' });
      $('#fWd').value = String(rep.wd);
      $('#fMday').value = rep.monthDay;
    }
    showRep();
  };
  $('#fInt').oninput = () => { rep.interval = Math.max(1, Math.min(99, parseInt($('#fInt').value, 10) || 1)); showRep(); };
  $('#fWd').onchange = () => { rep.wd = +$('#fWd').value; showRep(); };
  $('#fMday').oninput = () => { rep.monthDay = Math.max(1, Math.min(31, parseInt($('#fMday').value, 10) || 1)); showRep(); };
  $('#fEndMode').onchange = () => { rep.end = $('#fEndMode').value; showRep(); };
  $('#fUntil').oninput = $('#fUntil').onchange = () => { rep.until = $('#fUntil').value; showRep(); };
  $('#fCount').oninput = () => { rep.count = Math.max(1, Math.min(999, parseInt($('#fCount').value, 10) || 1)); showRep(); };
  sheetEl.querySelector('.rep-box').addEventListener('click', ev2 => {
    const wd = ev2.target.closest('[data-wd]');
    const ord = ev2.target.closest('[data-ord]');
    const mm = ev2.target.closest('[data-mm]');
    const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : list.concat(v));
    if (wd) rep.days = toggle(rep.days, +wd.dataset.wd);
    else if (ord) rep.ords = toggle(rep.ords, +ord.dataset.ord);
    else if (mm) rep.monthMode = mm.dataset.mm;
    else return;
    showRep();
  });
  showRep();

  let prevDate = $('#fDate').value;
  $('#fDate').onchange = () => {
    const d = $('#fDate').value;
    const end = $('#fEnd').value;
    if (!end || end === prevDate || end < d) $('#fEnd').value = d;
    prevDate = d;
    showRep(); // Vorschau „Erster Termin“ hängt vom Datum ab
  };

  $('#fCats').addEventListener('click', ev2 => {
    const b = ev2.target.closest('[data-cat]');
    if (!b) return;
    category = b.dataset.cat;
    $('#fCats').querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });

  $('#fBack').onclick = () => (isNew ? closeSheet() : openDetail(ev));
  $('#fOk').onclick = btnEv => {
    const data = {
      ref: isNew ? null : ref(ev),
      eventId: isNew ? '' : ev.eventId,
      subject: $('#fSub').value.trim(),
      allDay: $('#fAll').checked,
      date: $('#fDate').value,
      endDate: $('#fEnd').value,
      start: $('#fStart').value,
      end: $('#fStop').value,
      location: $('#fLoc').value.trim(),
      description: $('#fDesc').value.trim(),
      category,
      recurrence: buildRule(rep, $('#fAll').checked),
    };
    if (rep.freq === 'WEEKLY' && !rep.days.length) return toast('Bitte mindestens einen Wochentag wählen.', true);
    if (rep.freq === 'MONTHLY' && rep.monthMode === 'weekday' && !rep.ords.length) return toast('Bitte wählen, der wievielte Wochentag im Monat.', true);
    if (rep.freq !== 'NONE' && rep.freq !== 'CUSTOM' && data.date) {
      // Startdatum auf den ersten passenden Tag legen (mehrtägige Termine behalten ihre Länge)
      const first = firstOccurrence(rep, data.date);
      if (first !== data.date) {
        const days = Math.round((toDate(data.endDate || data.date) - toDate(data.date)) / 86400000);
        data.date = first;
        data.endDate = addDays(first, Math.max(0, days));
      }
      if (rep.end === 'until' && !rep.until) { $('#fUntil').focus(); return toast('Bitte das Datum des letzten Termins wählen.', true); }
      if (rep.end === 'until' && rep.until < data.date) { $('#fUntil').focus(); return toast('Der letzte Termin der Serie liegt vor dem ersten.', true); }
    }
    if (!data.subject) { $('#fSub').focus(); return toast('Bitte einen Titel eingeben.', true); }
    if (!data.date) { $('#fDate').focus(); return toast('Bitte ein Datum wählen.', true); }
    if (!data.allDay && !data.start) { $('#fStart').focus(); return toast('Bitte eine Beginn-Uhrzeit eingeben.', true); }
    mutate(btnEv.currentTarget, 'saveEvent', data);
  };
}

/* ---------- Weitere Aktionen (V2, Kapitel 8.7) ---------- */

function openMore() {
  const pref = themePref();
  const opt = (value, iconName, label, hint) => `
    <label class="opt ${pref === value ? 'selected' : ''}">
      ${icon(iconName, 20)}
      <span class="grow">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <input type="radio" name="theme" value="${value}" ${pref === value ? 'checked' : ''}>
    </label>`;
  const admin = can('admin') && ROLE_RANK[state.role];

  openSheet(`<div class="sheet-scroll">
    ${grip}
    <div class="me">
      <span class="avatar" aria-hidden="true">${esc((state.user || '?').trim().charAt(0).toUpperCase())}</span>
      <div>
        <span class="small-note" style="font-size:13px">Angemeldet als</span>
        <h2 id="sheetTitle" class="who">${esc(state.user || 'Unbekannt')}${admin ? '<span class="role-badge">ADMIN</span>' : ''}</h2>
      </div>
      ${closeBtn()}
    </div>

    <fieldset class="group-set">
      <legend>Darstellung</legend>
      <div class="group-box">
        ${opt('light', 'sun', 'Hell')}
        ${opt('dark', 'moon', 'Dunkel')}
        ${opt('system', 'phone', 'Systemeinstellung', 'Folgt dem Handy')}
      </div>
      <span class="small-note">Gilt nur auf diesem Gerät.</span>
    </fieldset>

    ${admin ? `
    <div class="stack">
      <span class="label">Verwaltung</span>
      <div class="group-box">
        <button class="opt" type="button" data-admin="Kategorien">${icon('tags', 20)}<span class="grow">Kategorien</span><span class="count">${state.categoryList.length || ''}</span>${icon('chevronRight', 18)}</button>
        <button class="opt" type="button" data-admin="Zugangscodes">${icon('key', 20)}<span class="grow">Zugangscodes</span><span class="count">${state.codeCount || ''}</span>${icon('chevronRight', 18)}</button>
        <button class="opt" type="button" data-admin="Import">${icon('plus', 20)}<span class="grow">Termine importieren</span>${icon('chevronRight', 18)}</button>
      </div>
    </div>` : ''}

    <button class="btn text" type="button" id="xLogout" style="color:var(--danger)">${icon('logout', 18)}Abmelden</button>
  </div>`);
  bindClose();

  sheetEl.querySelectorAll('input[name="theme"]').forEach(r => (r.onchange = () => {
    setThemePref(r.value);
    sheetEl.querySelectorAll('.opt').forEach(o => o.classList.toggle('selected', o.contains(r)));
  }));
  sheetEl.querySelectorAll('[data-admin]').forEach(b => (b.onclick = () => {
    closeSheet();
    openPage({ Kategorien: 'categories', Zugangscodes: 'codes', Import: 'import' }[b.dataset.admin]);
  }));
  $('#xLogout').onclick = () => confirmAct({
    title: 'Abmelden?',
    text: 'Auf diesem Gerät musst du danach den Zugangscode neu eingeben – auch in der normalen App.',
    label: 'Abmelden', cls: 'primary',
    onYes: () => { closeSheet(); logout(''); },
    back: openMore,
  });
}

/* ---------- Verwaltung: Seiten (V2, Kapitel 8.8 + 8.9) ---------- */

const COLOR_NAMES = { 1: 'Lavendel', 2: 'Salbei', 3: 'Weintraube', 4: 'Flamingo', 5: 'Banane', 6: 'Mandarine', 7: 'Pfau', 8: 'Graphit', 9: 'Heidelbeere', 10: 'Basilikum', 11: 'Tomate' };
// Reihenfolge im Farbraster wie im Entwurf; 6 und 8 reserviert
const COLOR_ORDER = [11, 4, 5, 10, 2, 7, 9, 1, 3];
const ROLE_INFO = {
  read: { label: 'Lesen', help: 'Termine ansehen, nichts ändern' },
  write: { label: 'Schreiben', help: 'Anlegen, bearbeiten, absagen, verschieben' },
  admin: { label: 'Admin', help: 'Alles – auch löschen, Kategorien, Codes' },
};

/** Echte Google-Farbe (Farbauswahl zeigt immer die Originalfarben, V2 4.2). */
const realColor = id => COLOR_HEX.light[String(id)] || '#9e9e9e';

function openPage(name) {
  if (name === 'import' && !state.busy) impReset();
  pushNav('page');
  state.page = name;
  appEl.hidden = true;
  pageEl.hidden = false;
  window.scrollTo(0, 0);
  renderPage();
  setTimeout(() => { const h = pageEl.querySelector('h1'); if (h) h.focus(); }, 80);
  if (name === 'codes') { state.codesError = null; loadCodes(); }
}

function closePage(fromHistory) {
  if (!fromHistory) popNav('page');
  state.page = null;
  pageEl.hidden = true;
  pageEl.innerHTML = '';
  pageEl.classList.remove('wide');
  appEl.hidden = false;
  render();
  setTimeout(() => $('#btnMore').focus(), 30);
}

// Escape schließt die Verwaltungsseite (wenn kein Sheet offen ist)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.page && sheetEl.hidden && !state.busy) { e.preventDefault(); closePage(); }
});

function pageShell(title, body, fab) {
  return `<header class="page-head">
      <div class="wrap page-head-row">
        <button class="icon-btn" type="button" id="pageBack" aria-label="Zurück">${icon('chevronLeft', 20)}</button>
        <div class="brand"><h1 tabindex="-1">${esc(title)}</h1><p class="sync">Nur für Admins</p></div>
      </div>
    </header>
    <main class="page-body wrap">${body}</main>
    ${fab || ''}`;
}

function renderPage() {
  if (state.page === 'categories') renderCategoriesPage();
  if (state.page === 'codes') renderCodesPage();
  if (state.page === 'import') renderImportPage();
  const back = $('#pageBack');
  if (back) back.onclick = closePage;
}

/* --- Kategorien --- */

function renderCategoriesPage() {
  const list = state.categoryList;
  const rows = list.length
    ? `<div class="group-box">${list.map((c, i) => `
        <button class="opt cat-row" type="button" data-cat-i="${i}">
          <span class="swatch" style="background:${realColor(c.colorId)}" aria-hidden="true"></span>
          <span class="grow"><b>${esc(c.name)}</b><small>${esc(COLOR_NAMES[c.colorId] || 'ohne Farbe')} · ${c.count ? `${c.count} ${c.count === 1 ? 'Termin' : 'Termine'}` : 'nicht genutzt'}</small></span>
          ${icon('chevronRight', 18)}
        </button>`).join('')}</div>`
    : `<p class="empty" style="padding:24px 0">Noch keine Kategorien.</p>`;

  pageEl.innerHTML = pageShell('Kategorien', `
    ${rows}
    <button class="btn dashed" type="button" id="catAdd">${icon('plus', 20)}Kategorie hinzufügen</button>
    <div class="note">${icon('info', 18)}<span>Im Google Kalender bekommt der Termin die Farbe. Zusätzlich steht „Kategorie: …“ in der ersten Zeile der Beschreibung – so sieht man sie auch in Apple Kalender und Abos.</span></div>`);

  pageEl.querySelectorAll('[data-cat-i]').forEach(b => (b.onclick = () => openCategorySheet(list[+b.dataset.catI])));
  $('#catAdd').onclick = () => openCategorySheet(null);
}

function openCategorySheet(cat) {
  const isNew = !cat;
  let colorId = cat ? Number(cat.colorId) : null;
  const count = cat ? cat.count : 0;

  const swatches = () => COLOR_ORDER.map(id => `
      <button class="swatch-btn" type="button" data-color="${id}" aria-pressed="${id === colorId}" aria-label="${COLOR_NAMES[id]}" style="background:${realColor(id)}">${id === colorId ? icon('check', 22, 3) : ''}</button>`).join('') +
    [6, 8].map(id => `
      <button class="swatch-btn reserved" type="button" disabled aria-label="${COLOR_NAMES[id]} – reserviert für ${id === 6 ? 'Verschoben' : 'Abgesagt'}" style="--c:${realColor(id)}">${icon('ban', 18)}</button>`).join('');

  openSheet(`<div class="sheet-scroll">
      ${grip}
      <h2 id="sheetTitle">${isNew ? 'Neue Kategorie' : 'Kategorie bearbeiten'}</h2>
      <label class="field">Name<input id="cName" value="${esc(cat ? cat.name : '')}" maxlength="40" autocomplete="off" ${isNew ? 'data-autofocus' : ''}></label>
      <fieldset class="group-set">
        <legend>Farbe im Kalender · <span class="color-name" id="cColorName">${esc(COLOR_NAMES[colorId] || 'bitte wählen')}</span></legend>
        <div class="swatches" id="cSwatches">${swatches()}</div>
        <span class="small-note">Mandarine und Graphit sind für „Verschoben“ und „Abgesagt“ reserviert.</span>
      </fieldset>
      ${!isNew && count ? `<div class="note">${icon('info', 18)}<span>${count} ${count === 1 ? 'Termin nutzt' : 'Termine nutzen'} diese Kategorie. Neue Farbe und Name werden danach im Kalender nachgezogen – das kann etwas dauern.</span></div>` : ''}
    </div>
    <div class="sheet-foot column">
      <div class="row-btns">
        <button class="btn small" type="button" id="cCancel" style="flex:1">Abbrechen</button>
        <button class="btn primary" type="button" id="cSave" style="flex:2">${isNew ? 'Anlegen' : 'Speichern'}</button>
      </div>
      ${isNew ? '' : `<div class="center-col">
        <button class="btn danger" type="button" id="cDelete" ${count ? 'disabled aria-describedby="cDelHint"' : ''}>Löschen</button>
        ${count ? '<span class="small-note" id="cDelHint">Geht erst, wenn kein Termin mehr diese Kategorie nutzt.</span>' : ''}
      </div>`}
    </div>`);

  $('#cSwatches').addEventListener('click', e => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    colorId = +b.dataset.color;
    $('#cSwatches').innerHTML = swatches();
    $('#cColorName').textContent = COLOR_NAMES[colorId];
    const sel = $('#cSwatches').querySelector(`[data-color="${colorId}"]`);
    if (sel) sel.focus();
  });
  $('#cCancel').onclick = () => closeSheet();
  $('#cSave').onclick = e => {
    const name = $('#cName').value.trim();
    if (!name) { $('#cName').focus(); return toast('Bitte einen Namen eingeben.', true); }
    if (!colorId) return toast('Bitte eine Farbe wählen.', true);
    mutate(e.currentTarget, 'saveCategory', { oldName: cat ? cat.name : undefined, name, colorId });
  };
  const del = $('#cDelete');
  if (del && !count) {
    del.onclick = () => confirmAct({
      title: 'Kategorie löschen?',
      text: `„${cat.name}“ wird aus der Liste entfernt.`,
      label: 'Löschen', cls: 'primary',
      onYes: btn => mutate(btn, 'deleteCategory', { name: cat.name }),
      back: () => openCategorySheet(cat),
    });
  }
}

/* --- Zugangscodes --- */

async function loadCodes() {
  state.codes = state.codes || null;
  renderPage();
  try {
    const d = await api('listCodes');
    state.codes = d.codes;
    state.codeCount = d.codeCount;
  } catch (e) {
    if (e.auth) return logout(e.message);
    if (e.forbidden) { closePage(); return toast(e.message, true); }
    state.codesError = e.message;
  }
  if (state.page === 'codes') renderPage();
}

function relativeDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((toDate(todayIso()) - toDate(toIso(d))) / 86400000);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return `am ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}

function codeSub(c) {
  if (c.blocked) return `gesperrt am ${new Date(c.blocked).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
  if (c.self) return 'Dieses Gerät';
  return c.lastUsed ? `zuletzt genutzt ${relativeDay(c.lastUsed)}` : 'noch nie genutzt';
}

function roleBadge(c) {
  if (c.blocked) return '<span class="rbadge off">Gesperrt</span>';
  if (c.role === 'admin') return '<span class="rbadge admin">Admin</span>';
  if (c.role === 'write') return '<span class="rbadge write">Schreiben</span>';
  return '<span class="rbadge off">Lesen</span>';
}

function renderCodesPage() {
  let body;
  if (!state.codes) {
    body = state.codesError
      ? `<div class="empty">${icon('info', 32)}<p>${esc(state.codesError)}</p><button class="btn small" type="button" id="codesRetry">${icon('refresh', 18)}Nochmal versuchen</button></div>`
      : `<div class="loading" role="status"><span class="spin"></span>Lade Zugangscodes…</div>`;
  } else {
    const team = state.codes.find(c => c.team);
    const personal = state.codes.filter(c => !c.team);
    const teamCard = team
      ? `<section class="team-card" aria-labelledby="teamTitle">
          <div class="team-top"><h2 id="teamTitle">Mannschaft</h2><span class="rbadge off">Lesen</span></div>
          <span class="mono">${esc(team.hint)}</span>
          <span class="small-note">Gemeinsamer Code · ${team.lastUsed ? `zuletzt genutzt ${relativeDay(team.lastUsed)}` : 'noch nie genutzt'}</span>
          <span class="small-note">Den Anmelde-Link gibt es nur direkt nach dem Erzeugen. Ist er weg, einfach neu erzeugen.</span>
          <div class="row-btns">
            <button class="btn small" type="button" id="teamRotate" style="flex:2">${icon('refresh', 18)}Neu erzeugen</button>
            <button class="btn small" type="button" id="teamEdit" style="flex:1">Bearbeiten</button>
          </div>
        </section>`
      : `<section class="team-card" aria-labelledby="teamTitle">
          <div class="team-top"><h2 id="teamTitle">Mannschaft</h2><span class="rbadge off">Lesen</span></div>
          <span class="small-note">Noch kein gemeinsamer Lese-Code für die Mannschaft.</span>
          <button class="btn small" type="button" id="teamRotate">${icon('plus', 18)}Mannschafts-Code erzeugen</button>
        </section>`;

    body = `${teamCard}
      <h2 class="group">Persönliche Codes</h2>
      ${personal.length ? `<div class="group-box">${personal.map(c => `
        <button class="opt code-row${c.blocked ? ' is-blocked' : ''}" type="button" data-code-id="${esc(c.id)}">
          <span class="grow"><b>${esc(c.name)}</b><small>${esc(codeSub(c))}</small></span>
          ${roleBadge(c)}
        </button>`).join('')}</div>` : '<p class="empty" style="padding:16px 0">Noch keine persönlichen Codes.</p>'}`;
  }

  pageEl.innerHTML = pageShell('Zugangscodes', body,
    state.codes ? `<button class="fab" type="button" id="codeNew">${icon('plus', 20)}Code</button>` : '');

  const retry = $('#codesRetry');
  if (retry) retry.onclick = () => { state.codesError = null; loadCodes(); };
  if (!state.codes) return;
  pageEl.querySelectorAll('[data-code-id]').forEach(b => (b.onclick = () => openCodeSheet(state.codes.find(c => c.id === b.dataset.codeId))));
  $('#codeNew').onclick = openNewCodeSheet;
  const teamEdit = $('#teamEdit');
  if (teamEdit) teamEdit.onclick = () => openCodeSheet(state.codes.find(c => c.team));
  $('#teamRotate').onclick = () => {
    const team = state.codes.find(c => c.team);
    if (!team) return mutate($('#teamRotate'), 'rotateTeamCode', {}, d => showCreatedCode(d, 'Mannschaft', 'read', true));
    confirmAct({
      title: 'Mannschafts-Code neu erzeugen?',
      text: 'Der alte Code funktioniert danach nicht mehr. Den neuen Link musst du an alle in der Mannschaft verteilen.',
      label: 'Neu erzeugen', cls: 'primary',
      onYes: btn => mutate(btn, 'rotateTeamCode', {}, d => showCreatedCode(d, 'Mannschaft', 'read', true)),
      back: () => closeSheet(),
    });
  };
}

function roleOptions(selected, disabledRoles = []) {
  return ['read', 'write', 'admin'].map(r => `
    <label class="opt ${r === selected ? 'selected' : ''}">
      <span class="grow">${ROLE_INFO[r].label}<small>${ROLE_INFO[r].help}</small></span>
      <input type="radio" name="role" value="${r}" ${r === selected ? 'checked' : ''} ${disabledRoles.includes(r) ? 'disabled' : ''}>
    </label>`).join('');
}

function bindRoleOptions() {
  sheetEl.querySelectorAll('input[name="role"]').forEach(r => (r.onchange = () =>
    sheetEl.querySelectorAll('.opt').forEach(o => o.classList.toggle('selected', o.contains(r) && r.checked))));
}

function openNewCodeSheet() {
  openSheet(`<div class="sheet-scroll">
      ${grip}
      <h2 id="sheetTitle">Neuer Zugangscode</h2>
      <label class="field">Für wen?<input id="ncName" maxlength="60" autocomplete="off" data-autofocus aria-describedby="ncHint">
        <span class="small-note" id="ncHint" style="font-weight:400">Erscheint bei „Letzte Änderung“ am Termin.</span></label>
      <fieldset class="group-set"><legend>Rolle</legend><div class="group-box">${roleOptions('write')}</div></fieldset>
      <div class="note">${icon('info', 18)}<span>Danach bekommst du einen Anmelde-Link zum Teilen. Der Code wird nur einmal vollständig angezeigt.</span></div>
    </div>
    <div class="sheet-foot">
      <button class="btn small" type="button" id="ncCancel" style="flex:1">Abbrechen</button>
      <button class="btn primary" type="button" id="ncOk" style="flex:2">Code erstellen</button>
    </div>`);
  bindRoleOptions();
  $('#ncCancel').onclick = () => closeSheet();
  $('#ncOk').onclick = e => {
    const name = $('#ncName').value.trim();
    const role = (sheetEl.querySelector('input[name="role"]:checked') || {}).value;
    if (!name) { $('#ncName').focus(); return toast('Bitte einen Namen eingeben.', true); }
    mutate(e.currentTarget, 'createCode', { name, role }, d => showCreatedCode(d, name, role, false));
  };
}

/** Code einmalig groß anzeigen, Link teilen (navigator.share, sonst Kopieren). */
function showCreatedCode(d, name, role, team) {
  renderPage();
  const link = d.link;
  openSheet(`<div class="sheet-scroll">
    ${grip}
    <div>
      <h2 id="sheetTitle">${team ? 'Neuer Mannschafts-Code' : 'Zugangscode erstellt'}</h2>
      <p class="sub">${esc(name)} · ${esc(ROLE_INFO[role] ? ROLE_INFO[role].label : role)}</p>
    </div>
    <p class="code-big" aria-label="Code ${esc(d.code.split('').join(' '))}">${esc(d.code)}</p>
    <div class="note warn">${icon('info', 18)}<span>Der Code wird nur jetzt angezeigt. Teile den Link nur mit ${team ? 'der Mannschaft' : 'dieser Person'} – er funktioniert wie ein Passwort.</span></div>
    <div class="actions">
      <button class="btn primary" type="button" id="shareLink" data-autofocus>${icon('share', 20)}Link teilen</button>
      <button class="btn small" type="button" id="doneLink">Fertig</button>
    </div>
  </div>`);
  $('#shareLink').onclick = () => shareLink(link, team);
  $('#doneLink').onclick = () => closeSheet();
}

async function shareLink(link, team) {
  const text = team
    ? 'Zugang zum Dienstplan der Feuerwehr (nur lesen):'
    : 'Dein persönlicher Zugang zum Dienstplan der Feuerwehr:';
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Dienstplan', text, url: link });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // abgebrochen
    }
  }
  copyText(link);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link kopiert.');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    sheetEl.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    toast(ok ? 'Link kopiert.' : 'Kopieren hat nicht geklappt.', !ok);
  }
}

function openCodeSheet(c) {
  if (!c) return;
  const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'nie');
  const self = c.self;
  const team = c.team;
  openSheet(`<div class="sheet-scroll">
      ${grip}
      <div class="sheet-head">
        <div>${team ? '<span class="rbadge off inline">Mannschaft · Lesen</span>' : roleBadge(c).replace('rbadge', 'rbadge inline')}<h2 id="sheetTitle">${esc(c.name)}</h2></div>
        ${closeBtn()}
      </div>
      <div class="facts">
        <div class="fact">${icon('key', 20)}<div><strong class="mono">${esc(c.hint)}</strong><span class="muted">erstellt am ${esc(fmtDate(c.created))} · ${c.lastUsed ? `zuletzt genutzt ${esc(relativeDay(c.lastUsed))}` : 'noch nie genutzt'}</span></div></div>
      </div>
      ${self ? `<div class="note">${icon('info', 18)}<span>Das ist dein eigener Code. Du kannst ihn weder sperren, herabstufen noch löschen.</span></div>` : ''}
      <label class="field">Name<input id="csName" value="${esc(c.name)}" maxlength="60" autocomplete="off"></label>
      ${c.blocked || team ? '' : `<fieldset class="group-set"><legend>Rolle</legend><div class="group-box">${roleOptions(c.role, self ? ['read', 'write'].filter(r => ROLE_RANK[r] < ROLE_RANK[c.role]) : [])}</div></fieldset>`}
    </div>
    <div class="sheet-foot column">
      <button class="btn primary" type="button" id="csSave">Speichern</button>
      ${team || self ? '' : c.blocked
        ? '<button class="btn small" type="button" id="csUnblock">Entsperren</button>'
        : '<button class="btn small" type="button" id="csBlock">Sperren</button>'}
      ${self ? '' : `<button class="btn danger" type="button" id="csDelete">${team ? 'Mannschafts-Code löschen' : 'Löschen'}</button>`}
    </div>`);
  bindClose();
  bindRoleOptions();

  $('#csSave').onclick = e => {
    const name = $('#csName').value.trim();
    const roleEl = sheetEl.querySelector('input[name="role"]:checked');
    const changes = { id: c.id };
    if (!name) { $('#csName').focus(); return toast('Bitte einen Namen eingeben.', true); }
    if (name !== c.name) changes.name = name;
    if (roleEl && roleEl.value !== c.role) changes.role = roleEl.value;
    if (Object.keys(changes).length === 1) return closeSheet();
    mutate(e.currentTarget, 'updateCode', changes, afterCodeChange);
  };
  const block = $('#csBlock');
  if (block) block.onclick = () => confirmAct({
    title: `„${c.name}“ sperren?`,
    text: 'Der Code funktioniert danach nicht mehr. Entsperren geht jederzeit.',
    label: 'Sperren', cls: 'primary',
    onYes: btn => mutate(btn, 'updateCode', { id: c.id, blocked: true }, afterCodeChange),
    back: () => openCodeSheet(c),
  });
  const unblock = $('#csUnblock');
  if (unblock) unblock.onclick = e => mutate(e.currentTarget, 'updateCode', { id: c.id, blocked: false }, afterCodeChange);
  const del = $('#csDelete');
  if (del) del.onclick = () => confirmAct({
    title: team ? 'Mannschafts-Code löschen?' : `„${c.name}“ löschen?`,
    text: team
      ? 'Der gemeinsame Lese-Code funktioniert danach nicht mehr. Einen neuen kannst du jederzeit erzeugen.'
      : 'Der Code funktioniert danach nicht mehr und verschwindet aus der Liste. Das lässt sich nicht rückgängig machen.',
    label: 'Endgültig löschen', cls: 'primary',
    onYes: btn => mutate(btn, 'deleteCode', { id: c.id }, afterCodeChange),
    back: () => openCodeSheet(c),
  });
}

function afterCodeChange(d) {
  closeSheet();
  renderPage();
  toast(d.message || 'Gespeichert.');
}

/* ---------- Meldungen ---------- */

let toastTimer;
/** Meldung unten. action = { label, onClick } zeigt einen Knopf (z. B. „Rückgängig“). */
function toast(msg, isErr, action) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  if (action) {
    t.innerHTML = `${icon('check', 20, 2.5)}<span class="t-msg"></span><button class="t-btn" type="button"></button>`;
    t.querySelector('.t-msg').textContent = msg;
    const b = t.querySelector('.t-btn');
    b.textContent = action.label;
    b.onclick = () => { hideToast(); action.onClick(); };
    t.className = 'toast show has-action' + (isErr ? ' err' : '');
  } else {
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
  }
  t.setAttribute('role', isErr ? 'alert' : 'status');
  toastTimer = setTimeout(hideToast, action ? 6000 : isErr ? 6000 : 3000);
}

function hideToast() {
  const t = $('#toast');
  t.className = 'toast';
  setTimeout(() => { if (!t.classList.contains('show')) t.innerHTML = ''; }, 250);
}

/* ---------- Anmeldung (V2, Kapitel 8.10) ---------- */

function showLogin(message) {
  appEl.hidden = true;
  $('#login').hidden = false;
  $('#loginErr').textContent = message || '';
  $('#codeInput').value = '';
  document.documentElement.style.background = '#b71c1c';
  setTimeout(() => $('#codeInput').focus(), 50);
}

function showApp() {
  $('#login').hidden = true;
  appEl.hidden = false;
  document.documentElement.style.background = '';
}

function logout(message) {
  store.del(KEY_CODE);
  store.del(KEY_DATA);
  Object.assign(state, { events: [], role: '', user: '', loadedAt: null, loadError: null });
  showLogin(message);
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const code = $('#codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 10) { $('#loginErr').textContent = 'Bitte den vollständigen Code eingeben.'; return; }

  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Prüfe…';
  $('#loginErr').textContent = '';
  store.set(KEY_CODE, code);
  try {
    applyData(await api('getData'));
    showApp();
    render();
    $('#btnMore').focus();
  } catch (err) {
    store.del(KEY_CODE);
    $('#loginErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});

/* ---------- Start ---------- */

listEl.addEventListener('click', e => {
  if (swipe.moved || cardSwipe.moved || ptr.moved) return; // war eine Geste, kein Antippen
  const card = e.target.closest('.card, .wcard');
  if (card) openDetail(state.events[+card.dataset.i]);
});
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#btnNew').onclick = () => openForm(null);
$('#btnReload').onclick = () => load(true);
$('#btnMore').onclick = openMore;
document.querySelectorAll('.seg [data-view]').forEach(b => (b.onclick = () => setView(b.dataset.view)));
$('#weekPrev').onclick = () => shiftWeek(-1);
$('#weekNext').onclick = () => shiftWeek(1);
$('#dayStrip').addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (!b || swipe.moved) return;
  state.selDay = b.dataset.day;
  $('#dayStrip').querySelectorAll('[data-day]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  scrollToDay(state.selDay);
});

// Wischen in der Wochenansicht (Tagesstreifen und Tagesliste):
// nach links = nächste Woche, nach rechts = vorige Woche.
// Touch-Ereignisse statt Pointer-Events, weil mobile Browser (v. a. iOS)
// Pointer-Gesten beim Verdacht auf Scrollen abbrechen.
const swipe = { x: 0, y: 0, dx: 0, active: false, horizontal: null, moved: false };
const SWIPE_MIN = 60;      // Mindestweg in px für einen Wochenwechsel
const SWIPE_LOCK = 12;     // ab hier wird entschieden: waagerecht oder senkrecht

function swipeTargets() {
  return [$('#dayStrip'), listEl];
}

function setSwipeOffset(dx, animate) {
  swipeTargets().forEach(el => {
    el.style.transition = animate ? 'transform .2s ease-out, opacity .2s ease-out' : 'none';
    el.style.transform = dx ? `translateX(${dx}px)` : '';
    el.style.opacity = dx ? String(Math.max(0.4, 1 - Math.abs(dx) / 400)) : '';
  });
}

function swipeStart(x, y) {
  if (state.view !== 'week' || !sheetEl.hidden) return;
  Object.assign(swipe, { x, y, dx: 0, active: true, horizontal: null, moved: false });
}

/** Gibt true zurück, wenn die Bewegung als waagerechtes Wischen erkannt ist (dann kein Scrollen). */
function swipeMove(x, y) {
  if (!swipe.active) return false;
  const dx = x - swipe.x;
  const dy = y - swipe.y;
  if (swipe.horizontal === null && (Math.abs(dx) > SWIPE_LOCK || Math.abs(dy) > SWIPE_LOCK)) {
    swipe.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!swipe.horizontal) swipe.active = false; // senkrecht → normal scrollen lassen
  }
  if (swipe.horizontal) {
    swipe.dx = dx;
    if (!reducedMotion()) setSwipeOffset(dx * 0.5, false);
    return true;
  }
  return false;
}

function swipeEnd() {
  if (!swipe.active) return;
  swipe.active = false;
  if (!swipe.horizontal) return;
  swipe.moved = true;
  setTimeout(() => { swipe.moved = false; }, 350); // Klick nach dem Wischen ignorieren
  if (Math.abs(swipe.dx) >= SWIPE_MIN) {
    const dir = swipe.dx < 0 ? 1 : -1;
    setSwipeOffset(0, false);
    shiftWeek(dir);
    if (!reducedMotion()) {
      setSwipeOffset(-dir * 40, false);           // neue Woche kommt von der Seite
      requestAnimationFrame(() => requestAnimationFrame(() => setSwipeOffset(0, true)));
    }
  } else {
    setSwipeOffset(0, true);                      // zurückfedern
  }
}

function reducedMotion() {
  return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

swipeTargets().forEach(el => {
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { swipe.active = false; return; }
    swipeStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (swipeMove(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  el.addEventListener('touchend', swipeEnd);
  el.addEventListener('touchcancel', () => { swipe.active = false; setSwipeOffset(0, true); });

  // Maus (PC): gleiche Geste mit gedrückter Maustaste
  el.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') swipeStart(e.clientX, e.clientY); });
});
window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') swipeMove(e.clientX, e.clientY); });
window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') swipeEnd(); });
// "Heute": springt zu heute bzw. zum nächsten kommenden Termin
$('#btnToday').onclick = () => {
  if (state.view === 'week') {
    state.weekStart = weekStart(todayIso());
    state.selDay = todayIso();
    renderWeek();
    return scrollToDay(state.selDay);
  }
  state.q = '';
  $('#q').value = '';
  if (state.view === 'table') {
    render();
    const t = todayIso();
    const row = tableRows().find(ev => (ev.endDate || ev.date) >= t);
    if (row) {
      tbl.focus = { id: row.eventId, col: 'date' };
      renderTable();
      const td = tableCell(row.eventId, 'date');
      if (td) { td.focus({ preventScroll: true }); td.scrollIntoView({ block: 'center' }); }
    }
    return;
  }
  render();
  const target = $('#todayAnchor') || listEl.querySelector('[data-upcoming]');
  if (target) {
    const smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  } else {
    window.scrollTo(0, 0);
  }
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.get(KEY_CODE) && !state.busy &&
      state.loadedAt && Date.now() - state.loadedAt > 60000) load();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    cleanupBeta();
  });
}

/**
 * Aufräumen nach der Freigabe: Geräte, die die Testversion unter beta/ installiert
 * hatten, behalten sonst deren Service Worker und Cache. Beides wird hier entfernt.
 */
function cleanupBeta() {
  try {
    navigator.serviceWorker.getRegistrations().then(regs => regs
      .filter(r => /\/beta\/$/.test(r.scope))
      .forEach(r => r.unregister())).catch(() => {});
    if (window.caches) {
      caches.keys().then(keys => keys
        .filter(k => k.startsWith('dienstplan-beta-'))
        .forEach(k => caches.delete(k))).catch(() => {});
    }
    store.del('dienstplan.beta.data');
  } catch (e) { /* egal */ }
}

(function start() {
  applyTheme();
  const savedView = store.get(KEY_VIEW);
  state.view = savedView === 'week' || savedView === 'table' ? savedView : 'list';
  hydrateIcons(document);
  tableInit();

  if (!API_URL || API_URL.startsWith('HIER')) {
    showLogin('Die App ist noch nicht eingerichtet: In config.js fehlt der Link zur Schnittstelle.');
    $('#loginForm').querySelectorAll('input, button').forEach(el => (el.hidden = true));
    return;
  }

  // Anmelde-Link: …/dienstplan/#code=XXXX → Code übernehmen und aus der Adresse entfernen
  const m = /[#&]code=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) {
    store.set(KEY_CODE, m[1].toUpperCase().replace(/[^A-Z0-9]/g, ''));
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (!store.get(KEY_CODE)) return showLogin('');

  try {
    const cached = JSON.parse(store.get(KEY_DATA) || 'null');
    if (cached && cached.events) Object.assign(state, cached);
  } catch (e) { /* egal */ }

  showApp();
  render();
  load();
})();
