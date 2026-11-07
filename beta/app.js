/* Dienstplan Beta – neue Oberfläche (V2, Etappe 2)
 * Gleiche Schnittstelle wie die Live-App (../config.js → API_URL).
 * Der Zugangscode ist mit der Live-App geteilt (gleicher localStorage-Schlüssel),
 * die zwischengespeicherte Terminliste nicht.
 */

const S = { AKTIV: 'AKTIV', ABGESAGT: 'ABGESAGT', VERSCHOBEN: 'VERSCHOBEN', LOESCHEN: 'LÖSCHEN' };
const API_URL = (window.DIENSTPLAN_CONFIG || {}).API_URL || '';
const KEY_CODE = 'dienstplan.code';
const KEY_DATA = 'dienstplan.beta.data';
const KEY_THEME = 'dienstplan.theme';

// Google-Kalender-Farben (V2, Kapitel 4.2). Im Dunkelmodus werden einige aufgehellt.
const COLOR_HEX = {
  light: { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' },
  dark: { 9: '#7986cb', 10: '#33b679', 11: '#ff5a4f' },
};

const ROLE_RANK = { read: 1, write: 2, admin: 3 };

const state = {
  events: [], categories: [], categoryList: [], today: '', user: '', role: '',
  loadedAt: null, q: '', showPast: false, busy: false, loadError: null,
};

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const sheetEl = $('#sheet');
const backdropEl = $('#backdrop');
const appEl = $('#app');

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
  if (state.categoryList.length) return state.categoryList.map(c => c.name);
  return state.categories || [];
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
  state.categories = d.categories || [];
  state.categoryList = d.categoryList || [];
  state.today = d.today || state.today;
  state.user = d.userName || d.user || state.user;
  state.role = d.role || state.role;
  state.loadedAt = Date.now();
  state.loadError = null;
  store.set(KEY_DATA, JSON.stringify({
    events: state.events, categories: state.categories, categoryList: state.categoryList,
    today: state.today, user: state.user, role: state.role, loadedAt: state.loadedAt,
  }));
}

async function load() {
  if (state.busy) return;
  const reload = $('#btnReload');
  reload.classList.add('spinning');
  reload.setAttribute('aria-busy', 'true');
  if (!state.events.length) {
    listEl.innerHTML = `<div class="loading" role="status"><span class="spin"></span>Lade Termine…</div>`;
  }
  try {
    applyData(await api('getData'));
  } catch (e) {
    if (e.auth) return logout(e.message);
    state.loadError = e;
  } finally {
    reload.classList.remove('spinning');
    reload.removeAttribute('aria-busy');
  }
  render();
}

async function mutate(btn, action, data) {
  if (state.busy) return;
  state.busy = true;
  renderHeader();
  const buttons = sheetEl.querySelectorAll('button, input, textarea');
  buttons.forEach(b => (b.disabled = true));
  const label = btn.innerHTML;
  btn.innerHTML = `<span class="spin"></span>${action === 'syncAll' ? 'Wird synchronisiert…' : 'Wird gespeichert…'}`;
  try {
    const d = await api(action, data);
    applyData(d);
    state.busy = false;
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

const ref = ev => ({ row: ev.row, eventId: ev.eventId, subject: ev.subject });
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
  $('#btnNew').hidden = !can('write');
}

/* ---------- Liste (V2, Kapitel 8.1) ---------- */

function matches(ev, q) {
  return !q || `${ev.subject} ${ev.location} ${ev.description} ${ev.category}`.toLowerCase().includes(q);
}

function render() {
  renderHeader();
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

function cardHtml(ev, isToday) {
  const cls = ['card'];
  if (ev.status === S.ABGESAGT) cls.push('is-cancelled');
  else if (ev.status === S.VERSCHOBEN) cls.push('is-moved');
  else if (isToday) cls.push('is-today');
  const meta = [timeText(ev), ev.location].filter(Boolean).map(esc).join(' · ');
  const statusWord = ev.status === S.ABGESAGT ? ', abgesagt' : ev.status === S.VERSCHOBEN ? ', verschoben' : '';
  return `<button class="${cls.join(' ')}" type="button" data-i="${state.events.indexOf(ev)}" data-key="${esc(ev.eventId || 'r' + ev.row)}"
      aria-label="${esc(`${ev.subject}, ${longDate(ev.date)}, ${timeText(ev)}${statusWord}`)}">
    <span class="tile" aria-hidden="true"><span class="wd">${esc(wdShort(ev.date))}</span><span class="d">${toDate(ev.date).getDate()}</span><span class="m">${esc(fmt(ev.date, { month: 'short' }).replace('.', ''))}</span></span>
    <span class="card-body" aria-hidden="true">
      <span class="card-title">${esc(ev.subject)}</span>
      <span class="card-meta">${meta}</span>
      ${badgesHtml(ev, false)}
    </span>
  </button>`;
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
    const card = lastFocus && lastFocus.closest && lastFocus.closest('.card');
    lastFocusKey = card ? card.dataset.key : null;
  }
  sheetEl.innerHTML = html;
  hydrateIcons(sheetEl);
  sheetEl.hidden = false;
  appEl.inert = true;
  appEl.setAttribute('aria-hidden', 'true');
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

function closeSheet(force) {
  if (state.busy && !force) return;
  if (!sheetEl.classList.contains('open') && sheetEl.hidden) return;
  sheetEl.classList.remove('open');
  backdropEl.classList.remove('open');
  appEl.inert = false;
  appEl.removeAttribute('aria-hidden');
  setTimeout(() => { if (!sheetEl.classList.contains('open')) { sheetEl.hidden = true; sheetEl.innerHTML = ''; } }, 260);
  restoreFocus();
}

/** Fokus zurück auf das auslösende Element – oder dieselbe Karte, falls die Liste neu gezeichnet wurde. */
function restoreFocus() {
  const el = lastFocus;
  const key = lastFocusKey;
  lastFocus = null;
  lastFocusKey = null;
  setTimeout(() => {
    let target = el && document.contains(el) ? el : null;
    if (!target && key) target = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    if (!target) target = $('#btnMore');
    if (target && !appEl.hidden) target.focus({ preventScroll: true });
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
  if (ev.recurring) notes.push(`<div class="note">${icon('series', 18)}<span>Serientermin – Änderungen gelten für die ganze Serie.</span></div>`);

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

function openForm(ev) {
  const isNew = !ev;
  const today = todayIso();
  const e = ev || {
    subject: '', date: today, endDate: today, start: '19:00', end: '21:00',
    allDay: false, location: '', description: '', category: '',
  };
  let category = e.category || '';

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
      <label class="field">Ort<input id="fLoc" value="${esc(e.location)}" placeholder="z. B. Feuerwehrhaus"></label>
      <div id="fCats">${chips()}</div>
      <label class="field">Beschreibung<textarea id="fDesc" rows="2" placeholder="z. B. PA mitbringen">${esc(e.description)}</textarea></label>
      ${ev && ev.recurring ? `<div class="note">${icon('series', 18)}<span>Serientermin – Änderungen gelten für die ganze Serie.</span></div>` : ''}
    </div>
    <div class="sheet-foot">
      <button class="btn small" type="button" id="fBack" style="flex:1">Abbrechen</button>
      <button class="btn primary" type="button" id="fOk" style="flex:2">${isNew ? 'Anlegen' : 'Speichern'}</button>
    </div>`);

  const toggleTimes = () => sheetEl.querySelectorAll('[data-time]').forEach(el => (el.hidden = $('#fAll').checked));
  $('#fAll').onchange = toggleTimes;
  toggleTimes();

  let prevDate = $('#fDate').value;
  $('#fDate').onchange = () => {
    const d = $('#fDate').value;
    const end = $('#fEnd').value;
    if (!end || end === prevDate || end < d) $('#fEnd').value = d;
    prevDate = d;
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
      subject: $('#fSub').value.trim(),
      allDay: $('#fAll').checked,
      date: $('#fDate').value,
      endDate: $('#fEnd').value,
      start: $('#fStart').value,
      end: $('#fStop').value,
      location: $('#fLoc').value.trim(),
      description: $('#fDesc').value.trim(),
      category,
    };
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
        <button class="opt" type="button" data-admin="Zugangscodes">${icon('key', 20)}<span class="grow">Zugangscodes</span>${icon('chevronRight', 18)}</button>
      </div>
    </div>
    <div class="stack">
      <button class="btn small" type="button" id="xSync">${icon('refresh', 18)}Alle Termine jetzt synchronisieren</button>
      <span class="small-note">Nur nötig, wenn direkt im Sheet etwas geändert wurde. Dauert bis zu einer Minute.</span>
    </div>` : ''}

    <button class="btn text" type="button" id="xLogout" style="color:var(--danger)">${icon('logout', 18)}Abmelden</button>
  </div>`);
  bindClose();

  sheetEl.querySelectorAll('input[name="theme"]').forEach(r => (r.onchange = () => {
    setThemePref(r.value);
    sheetEl.querySelectorAll('.opt').forEach(o => o.classList.toggle('selected', o.contains(r)));
  }));
  sheetEl.querySelectorAll('[data-admin]').forEach(b => (b.onclick = () =>
    toast(`${b.dataset.admin} verwaltest du in der nächsten Beta-Version direkt hier. Bis dahin über das Sheet-Menü.`)));
  if ($('#xSync')) $('#xSync').onclick = e => mutate(e.currentTarget, 'syncAll');
  $('#xLogout').onclick = () => confirmAct({
    title: 'Abmelden?',
    text: 'Auf diesem Gerät musst du danach den Zugangscode neu eingeben – auch in der normalen App.',
    label: 'Abmelden', cls: 'primary',
    onYes: () => { closeSheet(); logout(''); },
    back: openMore,
  });
}

/* ---------- Meldungen ---------- */

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  t.setAttribute('role', isErr ? 'alert' : 'status');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 6000 : 3000);
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
  const card = e.target.closest('.card');
  if (card) openDetail(state.events[+card.dataset.i]);
});
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#btnNew').onclick = () => openForm(null);
$('#btnReload').onclick = load;
$('#btnMore').onclick = openMore;
$('#btnWeek').onclick = () => toast('Die Wochenansicht kommt mit einer der nächsten Beta-Versionen.');
// "Heute": springt zu heute bzw. zum nächsten kommenden Termin
$('#btnToday').onclick = () => {
  state.q = '';
  $('#q').value = '';
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
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}));
}

(function start() {
  applyTheme();
  hydrateIcons(document);

  if (!API_URL || API_URL.startsWith('HIER')) {
    showLogin('Die App ist noch nicht eingerichtet: In config.js fehlt der Link zur Schnittstelle.');
    $('#loginForm').querySelectorAll('input, button').forEach(el => (el.hidden = true));
    return;
  }

  // Anmelde-Link: …/beta/#code=XXXX → Code übernehmen und aus der Adresse entfernen
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
