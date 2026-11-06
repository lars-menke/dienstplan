/* Dienstplan – Handy-App
 * Spricht mit der Apps-Script-Schnittstelle (config.js → API_URL).
 * Zugangscode und letzte Terminliste liegen nur auf diesem Gerät.
 */

const S = { AKTIV: 'AKTIV', ABGESAGT: 'ABGESAGT', VERSCHOBEN: 'VERSCHOBEN', LOESCHEN: 'LÖSCHEN' };
const API_URL = (window.DIENSTPLAN_CONFIG || {}).API_URL || '';
const KEY_CODE = 'dienstplan.code';
const KEY_DATA = 'dienstplan.data';

const state = {
  events: [], categories: [], today: '', user: '', role: '',
  tab: 'upcoming', q: '', busy: false, loadedAt: null,
};

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const sheetEl = $('#sheet');
const backdropEl = $('#backdrop');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Rollen ----------
 * Die Rolle kommt vom Server (read · write · admin). Der Server prüft jede
 * Aktion selbst; hier wird nur ausgeblendet, was nicht erlaubt ist.
 * Unbekannte Rolle (ältere Schnittstelle) → alles anzeigen wie bisher.
 */
const ROLE_RANK = { read: 1, write: 2, admin: 3 };
const ROLE_LABEL = { read: 'Lesen', write: 'Schreiben', admin: 'Admin' };

function can(role) {
  const have = ROLE_RANK[state.role];
  return have === undefined ? true : have >= ROLE_RANK[role];
}

function applyRoleUi() {
  $('#btnNew').hidden = !can('write');
}

/* ---------- Speicher (fehlertolerant) ---------- */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } },
};

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
    throw new Error('Unerwartete Antwort vom Server. Ist die Schnittstelle mit Zugriff „Jeder“ bereitgestellt?');
  }
  if (!json.ok) {
    const err = new Error(json.error || 'Unbekannter Fehler.');
    err.auth = !!json.auth;
    throw err;
  }
  return json;
}

function applyData(d) {
  state.events = d.events || [];
  state.categories = d.categories || [];
  state.today = d.today || state.today;
  state.user = d.userName || d.user || state.user;
  state.role = d.role || state.role;
  state.loadedAt = Date.now();
  applyRoleUi();
  store.set(KEY_DATA, JSON.stringify({
    events: state.events, categories: state.categories, today: state.today,
    user: state.user, role: state.role, loadedAt: state.loadedAt,
  }));
}

function setStale(text) {
  const el = $('#stale');
  el.textContent = text || '';
  el.hidden = !text;
}

async function load() {
  if (!state.events.length) {
    listEl.innerHTML = '<div class="loading"><span class="spin"></span> Lade Termine…</div>';
  }
  try {
    applyData(await api('getData'));
    setStale('');
    render();
  } catch (e) {
    if (e.auth) return logout(e.message);
    if (state.events.length) {
      const when = new Date(state.loadedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      setStale(`${e.offline ? 'Offline' : 'Fehler beim Laden'} – du siehst den Stand vom ${when}.`);
      render();
    } else {
      listEl.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}<br><br>
        <button class="btn" style="padding:0 20px" id="retry">Nochmal versuchen</button></div>`;
      $('#retry').onclick = load;
    }
  }
}

async function mutate(btn, action, data) {
  if (state.busy) return;
  state.busy = true;
  const buttons = sheetEl.querySelectorAll('button');
  buttons.forEach(b => (b.disabled = true));
  const label = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Wird gespeichert…';
  try {
    const d = await api(action, data);
    applyData(d);
    setStale('');
    state.busy = false;
    closeSheet();
    render();
    toast(d.message || 'Gespeichert.', d.warning);
  } catch (e) {
    state.busy = false;
    if (e.auth) { closeSheet(); return logout(e.message); }
    buttons.forEach(b => (b.disabled = false));
    btn.innerHTML = label;
    toast(e.message, true);
  }
}

const ref = ev => ({ row: ev.row, eventId: ev.eventId, subject: ev.subject });

function setStatus(ev, status, btn, extra) {
  mutate(btn, 'setStatus', Object.assign({ ref: ref(ev), status }, extra || {}));
}

/* ---------- Anmeldung ---------- */

function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginErr').textContent = message || '';
  $('#codeInput').value = '';
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

function logout(message) {
  store.del(KEY_CODE);
  store.del(KEY_DATA);
  state.events = [];
  state.role = '';
  showLogin(message);
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const code = $('#codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 10) { $('#loginErr').textContent = 'Bitte den vollständigen Code eingeben.'; return; }

  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Prüfe…';
  $('#loginErr').textContent = '';
  store.set(KEY_CODE, code);
  try {
    applyData(await api('getData'));
    showApp();
    render();
  } catch (err) {
    store.del(KEY_CODE);
    $('#loginErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});

/* ---------- Datum ---------- */

const toDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (iso, opts) => toDate(iso).toLocaleDateString('de-DE', opts);
const shortDate = iso => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeText(ev) {
  if (ev.allDay) {
    return ev.endDate && ev.endDate !== ev.date
      ? `Ganztägig bis ${fmt(ev.endDate, { day: '2-digit', month: '2-digit' })}`
      : 'Ganztägig';
  }
  let t = ev.end ? `${ev.start}–${ev.end} Uhr` : `${ev.start} Uhr`;
  if (ev.endDate && ev.endDate !== ev.date) t += ` (bis ${fmt(ev.endDate, { day: '2-digit', month: '2-digit' })})`;
  return t;
}

/* ---------- Liste ---------- */

function render() {
  const today = todayIso();
  const q = state.q.trim().toLowerCase();
  let items = state.events.filter(ev => {
    const upcoming = (ev.endDate || ev.date) >= today;
    if ((state.tab === 'upcoming') !== upcoming) return false;
    if (q && !`${ev.subject} ${ev.location} ${ev.description} ${ev.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (state.tab === 'past') items = items.slice().reverse();

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">${
      q ? 'Keine Treffer.' : state.tab === 'upcoming' ? 'Keine kommenden Termine.' : 'Keine vergangenen Termine.'
    }</div>`;
    return;
  }

  let html = '';
  let month = '';
  for (const ev of items) {
    const key = ev.date.slice(0, 7);
    if (key !== month) {
      month = key;
      html += `<div class="month">${esc(fmt(ev.date, { month: 'long', year: 'numeric' }))}</div>`;
    }
    html += cardHtml(ev);
  }
  listEl.innerHTML = html;
}

function cardHtml(ev) {
  const cls = ev.status === S.ABGESAGT ? 'is-off' : ev.status === S.VERSCHOBEN ? 'is-warn' : '';
  const meta = [timeText(ev), ev.location].filter(Boolean).map(esc).join(' · ');
  const wd = fmt(ev.date, { weekday: 'short' }).replace('.', '');
  const mo = fmt(ev.date, { month: 'short' }).replace('.', '');
  return `<button class="card ${cls}" data-i="${state.events.indexOf(ev)}">
    <div class="date"><div class="wd">${esc(wd)}</div><div class="d">${toDate(ev.date).getDate()}</div><div class="m">${esc(mo)}</div></div>
    <div class="body"><div class="title">${esc(ev.subject)}</div><div class="meta">${meta}</div>${badgesHtml(ev)}</div>
  </button>`;
}

function badgesHtml(ev) {
  const b = [];
  if (ev.status === S.ABGESAGT) b.push('<span class="badge off">Abgesagt</span>');
  if (ev.status === S.VERSCHOBEN) b.push(`<span class="badge warn">Verschoben${ev.verschobenAuf ? ' → ' + esc(ev.verschobenAuf) : ''}</span>`);
  if (ev.status === S.LOESCHEN) b.push('<span class="badge off">Wird gelöscht</span>');
  if (ev.recurring) b.push('<span class="badge">🔁 Serie</span>');
  if (ev.category) b.push(`<span class="badge">${esc(ev.category)}</span>`);
  if (!ev.synced && ev.status !== S.LOESCHEN) b.push('<span class="badge">Noch nicht im Kalender</span>');
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
}

/* ---------- Bottom Sheet ---------- */

function openSheet(html) {
  sheetEl.innerHTML = '<div class="grip"></div>' + html;
  backdropEl.classList.add('open');
  sheetEl.classList.add('open');
  sheetEl.scrollTop = 0;
}

function closeSheet() {
  if (state.busy) return;
  backdropEl.classList.remove('open');
  sheetEl.classList.remove('open');
}

function openDetail(ev) {
  const longDate = fmt(ev.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let info = '';
  if (ev.status === S.VERSCHOBEN) {
    info += `<div class="info warn">↪️ Verschoben${ev.verschobenAuf ? ' auf <b>' + esc(ev.verschobenAuf) + '</b>' : ''}.${
      ev.folgetermin ? ' Der neue Termin ist angelegt.' : ''}</div>`;
  }
  if (ev.status === S.ABGESAGT) info += '<div class="info">❌ Abgesagt. Der Termin bleibt im Kalender sichtbar.</div>';
  if (ev.recurring) info += '<div class="info">🔁 Serientermin – Änderungen gelten für die ganze Serie.</div>';

  let actions;
  if (!can('write')) {
    info += '<div class="info">👀 Du kannst Termine ansehen. Änderungen macht, wer den Dienstplan pflegt.</div>';
    actions = '<button class="btn" data-act="close">Schließen</button>';
  } else {
    actions = ev.status === S.AKTIV
      ? `<button class="btn primary" data-act="edit">Bearbeiten</button>
         <div class="row"><button class="btn warn" data-act="move">Verschieben</button><button class="btn" data-act="cancel">Absagen</button></div>`
      : `<button class="btn primary" data-act="reactivate">Wieder aktivieren</button>
         <button class="btn" data-act="edit">Bearbeiten</button>`;
    if (can('admin')) actions += '\n<button class="btn danger" data-act="delete">Löschen</button>';
  }

  openSheet(`
    <h2>${esc(ev.subject)}</h2>
    ${badgesHtml(ev)}
    <div class="detail-line"><span class="ic">📅</span><div>${esc(longDate)}<div class="meta">${esc(timeText(ev))}</div></div></div>
    ${ev.location ? `<div class="detail-line"><span class="ic">📍</span><div>${esc(ev.location)}</div></div>` : ''}
    ${ev.description ? `<div class="detail-line"><span class="ic">📝</span><div class="desc">${esc(ev.description)}</div></div>` : ''}
    ${info}
    <div class="actions">
      ${actions}
    </div>
    ${ev.lastChange ? `<div class="small">Letzte Änderung: ${esc(ev.lastChange)}</div>` : ''}
  `);

  const handlers = {
    close: closeSheet,
    edit: () => openForm(ev),
    move: () => openMove(ev),
    cancel: () => confirmAct({
      title: 'Termin absagen?',
      text: `„${ev.subject}“ bleibt im Kalender sichtbar und wird als abgesagt markiert.`,
      label: 'Absagen', cls: 'primary',
      onYes: btn => setStatus(ev, S.ABGESAGT, btn),
      back: () => openDetail(ev),
    }),
    reactivate: () => ev.folgetermin
      ? confirmAct({
          title: 'Wieder aktivieren?',
          text: 'Der bereits angelegte neue Termin bleibt bestehen. Falls er nicht mehr gebraucht wird, bitte separat absagen oder löschen.',
          label: 'Wieder aktivieren', cls: 'primary',
          onYes: btn => setStatus(ev, S.AKTIV, btn),
          back: () => openDetail(ev),
        })
      : setStatus(ev, S.AKTIV, sheetEl.querySelector('[data-act="reactivate"]')),
    delete: () => confirmAct({
      title: 'Termin löschen?',
      text: `„${ev.subject}“ wird aus dem Kalender entfernt. Wenn er nur ausfällt, ist „Absagen“ meist besser – dann sehen es alle.`,
      label: 'Endgültig löschen', cls: 'primary',
      onYes: btn => setStatus(ev, S.LOESCHEN, btn),
      back: () => openDetail(ev),
    }),
  };
  sheetEl.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => handlers[b.dataset.act]()));
}

function confirmAct(o) {
  openSheet(`
    <h2>${esc(o.title)}</h2>
    <p class="lead">${esc(o.text)}</p>
    <div class="actions">
      <button class="btn ${o.cls}" id="cYes">${esc(o.label)}</button>
      <button class="btn" id="cNo">Zurück</button>
    </div>`);
  $('#cYes').onclick = e => o.onYes(e.currentTarget);
  $('#cNo').onclick = o.back;
}

function openMove(ev) {
  openSheet(`
    <h2>Verschieben</h2>
    <p class="lead">${esc(ev.subject)} · bisher ${esc(shortDate(ev.date))}${ev.allDay ? '' : ', ' + esc(ev.start) + ' Uhr'}</p>
    <div class="row">
      <label class="f">Neues Datum<input type="date" id="mDate" value="${esc(ev.date)}"></label>
      ${ev.allDay ? '' : `<label class="f">Uhrzeit<input type="time" id="mTime" value="${esc(ev.start)}"></label>`}
    </div>
    <div class="info">Der alte Termin bleibt als „verschoben“ im Kalender sichtbar. Der neue Termin wird automatisch angelegt.</div>
    ${ev.folgetermin ? '<div class="info warn">Für diesen Termin gibt es schon einen neuen Termin. Es wird nur die Markierung geändert.</div>' : ''}
    <div class="actions">
      <button class="btn warn" id="mOk">Verschieben</button>
      <button class="btn" id="mBack">Abbrechen</button>
    </div>`);

  $('#mOk').onclick = e => {
    const newDate = $('#mDate').value;
    const newTime = $('#mTime') ? $('#mTime').value : '';
    if (!newDate) return toast('Bitte ein neues Datum wählen.', true);
    if (newDate === ev.date && (!$('#mTime') || newTime === ev.start)) return toast('Das ist noch der alte Termin.', true);
    setStatus(ev, S.VERSCHOBEN, e.currentTarget, { newDate, newTime });
  };
  $('#mBack').onclick = () => openDetail(ev);
}

function openForm(ev) {
  const isNew = !ev;
  const today = todayIso();
  const e = ev || {
    subject: '', date: today, endDate: today, start: '19:00', end: '21:00',
    allDay: false, location: '', description: '', category: '',
  };

  const catField = state.categories.length
    ? `<label class="f">Kategorie<select id="fCat"><option value="">– keine –</option>${
        state.categories.map(c => `<option${c === e.category ? ' selected' : ''}>${esc(c)}</option>`).join('')
      }</select></label>`
    : '';

  openSheet(`
    <h2>${isNew ? 'Neuer Termin' : 'Termin bearbeiten'}</h2>
    <label class="f">Titel<input id="fSub" value="${esc(e.subject)}" placeholder="z. B. Übungsdienst" autocomplete="off"></label>
    <label class="check"><input type="checkbox" id="fAll"${e.allDay ? ' checked' : ''}> Ganztägig</label>
    <div class="row">
      <label class="f">Datum<input type="date" id="fDate" value="${esc(e.date)}"></label>
      <label class="f">Bis<input type="date" id="fEnd" value="${esc(e.endDate || e.date)}"></label>
    </div>
    <div class="row" id="fTimes">
      <label class="f">Beginn<input type="time" id="fStart" value="${esc(e.start)}"></label>
      <label class="f">Ende<input type="time" id="fStop" value="${esc(e.end)}"></label>
    </div>
    <label class="f">Ort<input id="fLoc" value="${esc(e.location)}" placeholder="z. B. Feuerwehrhaus"></label>
    ${catField}
    <label class="f">Beschreibung<textarea id="fDesc" rows="3">${esc(e.description)}</textarea></label>
    ${ev && ev.recurring ? '<div class="info">🔁 Serientermin – Änderungen gelten für die ganze Serie.</div>' : ''}
    <div class="actions">
      <button class="btn primary" id="fOk">${isNew ? 'Anlegen' : 'Speichern'}</button>
      <button class="btn" id="fBack">Abbrechen</button>
    </div>`);

  const toggleTimes = () => ($('#fTimes').style.display = $('#fAll').checked ? 'none' : '');
  $('#fAll').onchange = toggleTimes;
  toggleTimes();

  // "Bis" wandert mit, solange der Termin eintägig war
  let prevDate = $('#fDate').value;
  $('#fDate').onchange = () => {
    const d = $('#fDate').value;
    const end = $('#fEnd').value;
    if (!end || end === prevDate || end < d) $('#fEnd').value = d;
    prevDate = d;
  };

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
      category: $('#fCat') ? $('#fCat').value : (e.category || ''),
    };
    if (!data.subject) return toast('Bitte einen Titel eingeben.', true);
    if (!data.date) return toast('Bitte ein Datum wählen.', true);
    if (!data.allDay && !data.start) return toast('Bitte eine Beginn-Uhrzeit eingeben.', true);
    mutate(btnEv.currentTarget, 'saveEvent', data);
  };

  if (isNew) setTimeout(() => $('#fSub').focus(), 260);
}

function openMore() {
  openSheet(`
    <h2>Weitere Aktionen</h2>
    ${state.user ? `<p class="lead">Angemeldet als <b>${esc(state.user)}</b>${
      ROLE_LABEL[state.role] ? ` · ${ROLE_LABEL[state.role]}` : ''}</p>` : ''}
    <div class="actions">
      ${can('admin') ? '<button class="btn" id="xSync">Alle Termine jetzt synchronisieren</button>' : ''}
      <button class="btn" id="xLogout">Abmelden</button>
      <button class="btn" id="xBack">Schließen</button>
    </div>
    ${can('admin') ? `<div class="small">Normalerweise nicht nötig: Jede Änderung in der App wird sofort in den Kalender übertragen.
      Der komplette Sync ist nur für Änderungen gedacht, die direkt im Sheet gemacht wurden.</div>` : ''}`);
  if ($('#xSync')) $('#xSync').onclick = e => mutate(e.currentTarget, 'syncAll');
  $('#xLogout').onclick = () => confirmAct({
    title: 'Abmelden?',
    text: 'Auf diesem Gerät musst du danach den Zugangscode neu eingeben.',
    label: 'Abmelden', cls: 'primary',
    onYes: () => { closeSheet(); logout(''); },
    back: openMore,
  });
  $('#xBack').onclick = closeSheet;
}

/* ---------- Meldungen ---------- */

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 6000 : 3000);
}

/* ---------- Start ---------- */

listEl.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card) openDetail(state.events[+card.dataset.i]);
});
document.querySelectorAll('.seg button').forEach(b => (b.onclick = () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#btnNew').onclick = () => openForm(null);
$('#btnReload').onclick = load;
$('#btnMore').onclick = openMore;
backdropEl.onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// beim Zurückkehren in die App automatisch aktualisieren
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.get(KEY_CODE) && !state.busy &&
      state.loadedAt && Date.now() - state.loadedAt > 60000) load();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

(function start() {
  if (!API_URL || API_URL.startsWith('HIER')) {
    showLogin('Die App ist noch nicht eingerichtet: In config.js fehlt der Link zur Schnittstelle.');
    $('#loginForm').hidden = true;
    return;
  }

  // Anmelde-Link: …/#code=XXXX → Code übernehmen und aus der Adresse entfernen
  const m = /[#&]code=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) {
    store.set(KEY_CODE, m[1].toUpperCase().replace(/[^A-Z0-9]/g, ''));
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (!store.get(KEY_CODE)) return showLogin('');

  // letzte bekannte Liste sofort zeigen, dann frisch laden
  try {
    const cached = JSON.parse(store.get(KEY_DATA) || 'null');
    if (cached && cached.events) Object.assign(state, cached);
  } catch (e) { /* egal */ }

  showApp();
  applyRoleUi();
  if (state.events.length) render();
  load();
})();
