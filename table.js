/* Dienstplan – Tabellenansicht (docs/PWA-Spezifikation-V3.md, Kapitel 7.2)
 * Nur Schreiben/Admin, ab 768 px Breite. Wird vor app.js geladen und nutzt
 * dessen Funktionen (state, api, render …) erst zur Laufzeit – auf oberster
 * Ebene steht hier deshalb nichts, was app.js braucht.
 */

const TABLE_MIN_WIDTH = '(min-width: 768px)';

// Spalten in Anzeigereihenfolge. edit: Art des Eingabefelds (fehlt = nicht bearbeitbar)
const TABLE_COLS = [
  { key: 'sel', label: 'Auswahl' },
  { key: 'date', label: 'Datum', sort: true, edit: 'date' },
  { key: 'start', label: 'Beginn', sort: true, edit: 'time' },
  { key: 'end', label: 'Ende', sort: true, edit: 'time' },
  { key: 'subject', label: 'Titel', sort: true, edit: 'text' },
  { key: 'repeat', label: 'Serie', sort: true, edit: 'form' }, // öffnet das Formular bei „Wiederholung“
  { key: 'location', label: 'Ort', sort: true, edit: 'text' },
  { key: 'category', label: 'Kategorie', sort: true, edit: 'select' },
  { key: 'status', label: 'Status', sort: true },
  { key: 'changed', label: 'Letzte Änderung', sort: true },
];

const tbl = {
  sort: { col: 'date', dir: 1 },
  filter: { cat: '', status: '', range: 'upcoming' }, // range: upcoming | all
  selected: new Set(),   // eventIds
  anchor: null,          // letzte angeklickte Zeile für Shift+Klick
  focus: null,           // { id, col } – Zelle mit Tastaturfokus
  edit: null,            // { id, col } – Zelle im Bearbeiten-Modus
  saving: new Set(),     // eventIds, die gerade gespeichert werden
  errors: {},            // `${id}|${col}` → Fehlermeldung (alte Zelle mit Hinweis)
  queue: Promise.resolve(), // Speichern nacheinander, damit keine Antwort eine neuere überschreibt
  bulkBusy: false,
  wired: false,
};

/* ---------- Wer darf die Tabelle sehen? ---------- */

function tableWideEnough() {
  return !window.matchMedia || matchMedia(TABLE_MIN_WIDTH).matches;
}

function tableAllowed() {
  return ROLE_RANK[state.role] >= ROLE_RANK.write && tableWideEnough();
}

/* ---------- Daten aufbereiten ---------- */

const STATUS_ORDER = { AKTIV: 0, VERSCHOBEN: 1, ABGESAGT: 2, 'LÖSCHEN': 3 };

function changedKey(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})\D+(\d{2}):(\d{2})/.exec(s || '');
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : '';
}

function tableSortValue(ev, col) {
  switch (col) {
    case 'date': return `${ev.date} ${ev.allDay ? '00:00' : ev.start || ''}`;
    case 'start': return ev.allDay ? '' : ev.start || '';
    case 'end': return ev.allDay ? '' : ev.end || '';
    case 'status': return STATUS_ORDER[ev.status] != null ? STATUS_ORDER[ev.status] : 9;
    case 'changed': return changedKey(ev.lastChange);
    case 'repeat': return repeatText(ev).toLocaleLowerCase('de');
    default: return String(ev[col] || '').toLocaleLowerCase('de');
  }
}

/** Sichtbare Zeilen: Suche (wie in der Liste), Filter, Sortierung. */
function tableRows() {
  const q = state.q.trim().toLowerCase();
  const today = todayIso();
  const f = tbl.filter;
  const rows = state.events.filter(ev => {
    if (!ev.eventId) return false;
    if (!matches(ev, q)) return false;
    // Serien laufen weiter, auch wenn sie früher begonnen haben → bei „Ab heute“ immer zeigen
    if (f.range === 'upcoming' && !q && !ev.recurring && (ev.endDate || ev.date) < today) return false;
    if (f.cat === '-') { if (ev.category) return false; } else if (f.cat && (ev.category || '').toLowerCase() !== f.cat.toLowerCase()) return false;
    if (f.status && ev.status !== f.status) return false;
    return true;
  });
  const { col, dir } = tbl.sort;
  rows.sort((a, b) => {
    const va = tableSortValue(a, col), vb = tableSortValue(b, col);
    let c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'de');
    if (c === 0) c = tableSortValue(a, 'date').localeCompare(tableSortValue(b, 'date'));
    return c * dir;
  });
  return rows;
}

function tableEvent(id) {
  return state.events.find(e => e.eventId === id);
}

/* ---------- Zeichnen ---------- */

function renderTable() {
  // Während eine Zelle bearbeitet wird, nicht von außen neu zeichnen (z. B. Laden im Hintergrund) –
  // nach dem Bearbeiten wird ohnehin neu gezeichnet.
  if (tbl.edit && listEl.querySelector('.cell-input')) return;
  // Auswahl auf noch vorhandene Termine beschränken
  for (const id of [...tbl.selected]) if (!tableEvent(id)) tbl.selected.delete(id);
  const hadFocus = listEl.contains(document.activeElement) && !!document.activeElement.closest('.tbl');
  const rows = tableRows();
  const allSel = rows.length > 0 && rows.every(ev => tbl.selected.has(ev.eventId));
  const someSel = rows.some(ev => tbl.selected.has(ev.eventId));
  if (!tbl.focus || !rows.some(ev => ev.eventId === tbl.focus.id)) {
    tbl.focus = rows.length ? { id: rows[0].eventId, col: 'date' } : null;
  }

  const catOpts = state.categoryList.map(c =>
    `<option value="${esc(c.name)}" ${tbl.filter.cat.toLowerCase() === c.name.toLowerCase() ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const sel = (v, cur) => (v === cur ? 'selected' : '');

  const head = TABLE_COLS.map(c => {
    if (c.key === 'sel') {
      return `<th class="c-sel" scope="col"><label class="tbl-check"><input type="checkbox" id="tblAll" ${allSel ? 'checked' : ''}
        aria-label="Alle sichtbaren Termine auswählen"><span aria-hidden="true"></span></label></th>`;
    }
    const active = tbl.sort.col === c.key;
    const ariaSort = active ? (tbl.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th class="c-${c.key}" scope="col" aria-sort="${ariaSort}">
      <button type="button" class="th-btn${active ? ' active' : ''}" data-sort="${c.key}">${esc(c.label)}${
        active ? icon(tbl.sort.dir > 0 ? 'chevronUp' : 'chevronDown', 14, 2.5) : ''}</button></th>`;
  }).join('');

  const body = rows.map(ev => tableRowHtml(ev)).join('');

  listEl.innerHTML = `
    <div class="tbl-filters" role="group" aria-label="Filter">
      <label class="tbl-filter">Zeitraum
        <select id="tfRange"><option value="upcoming" ${sel('upcoming', tbl.filter.range)}>Ab heute</option><option value="all" ${sel('all', tbl.filter.range)}>Alle</option></select></label>
      <label class="tbl-filter">Kategorie
        <select id="tfCat"><option value="">Alle</option>${catOpts}<option value="-" ${sel('-', tbl.filter.cat)}>Ohne Kategorie</option></select></label>
      <label class="tbl-filter">Status
        <select id="tfStatus"><option value="">Alle</option><option value="AKTIV" ${sel('AKTIV', tbl.filter.status)}>Aktiv</option>
          <option value="ABGESAGT" ${sel('ABGESAGT', tbl.filter.status)}>Abgesagt</option><option value="VERSCHOBEN" ${sel('VERSCHOBEN', tbl.filter.status)}>Verschoben</option></select></label>
      <span class="tbl-count" aria-live="polite">${rows.length} ${rows.length === 1 ? 'Termin' : 'Termine'}</span>
    </div>
    <div class="tbl-scroll">
      <table class="tbl" role="grid" aria-label="Termine als Tabelle" aria-rowcount="${rows.length + 1}">
        <thead><tr>${head}</tr></thead>
        <tbody>${body || `<tr><td colspan="${TABLE_COLS.length}" class="tbl-empty">${state.q ? 'Keine Treffer.' : 'Keine Termine für diese Filter.'}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="tbl-hint">Klick in eine Zelle zum Bearbeiten · Enter speichert, Esc bricht ab · Pfeiltasten wechseln die Zelle · Shift+Klick wählt mehrere</p>
    ${tableBarHtml()}`;

  const all = $('#tblAll');
  if (all) all.indeterminate = someSel && !allSel;
  tableFitHeight();
  hydrateIcons(listEl);
  $('#btnNew').hidden = !can('write') || tbl.selected.size > 0;

  // Fokus/Bearbeiten nach dem Neuzeichnen wiederherstellen
  if (tbl.edit) {
    const input = listEl.querySelector('.cell-input');
    if (input) {
      input.focus({ preventScroll: true });
      if (input.select && input.type === 'text') input.select();
    }
  } else if (hadFocus && tbl.focus) {
    const td = tableCell(tbl.focus.id, tbl.focus.col);
    if (td) td.focus({ preventScroll: true });
  }
}

/** Tabelle scrollt in sich (Kopfzeile bleibt stehen) und füllt den Platz bis zum unteren Rand. */
function tableFitHeight() {
  const sc = listEl.querySelector('.tbl-scroll');
  if (!sc) return;
  const top = sc.getBoundingClientRect().top + window.scrollY;
  const reserve = tbl.selected.size ? 120 : 110; // Hinweiszeile und Aktionsleiste bzw. „+ Termin“
  sc.style.maxHeight = `${Math.max(320, window.innerHeight - top - reserve)}px`;
}

function tableRowHtml(ev) {
  const id = ev.eventId;
  const isSel = tbl.selected.has(id);
  const saving = tbl.saving.has(id);
  const cls = ['tr'];
  if (isSel) cls.push('is-sel');
  if (saving) cls.push('is-saving');
  if (ev.status === S.ABGESAGT) cls.push('is-cancelled');
  if (ev.status === S.VERSCHOBEN) cls.push('is-moved');
  if (!ev.recurring && (ev.endDate || ev.date) < todayIso()) cls.push('is-past');
  if (ev.date === todayIso()) cls.push('is-today');

  const cells = TABLE_COLS.map(c => {
    const focused = tbl.focus && tbl.focus.id === id && tbl.focus.col === c.key;
    const err = tbl.errors[`${id}|${c.key}`];
    const editing = tbl.edit && tbl.edit.id === id && tbl.edit.col === c.key;
    const attrs = `data-id="${esc(id)}" data-col="${c.key}" tabindex="${focused ? 0 : -1}" role="gridcell"` +
      (err ? ` aria-invalid="true" title="${esc(err)}"` : '');
    const classes = [`c-${c.key}`];
    if (c.edit && (c.edit === 'form' || tableCanInline(ev, c.key))) classes.push('editable');
    if (err) classes.push('has-error');
    if (editing) return `<td class="${classes.join(' ')} editing" ${attrs}>${tableEditorHtml(ev, c)}</td>`;
    return `<td class="${classes.join(' ')}" ${attrs}>${tableCellHtml(ev, c.key, isSel, saving)}${
      err ? `<span class="sr-only">Fehler: ${esc(err)}</span>` : ''}</td>`;
  }).join('');
  return `<tr class="${cls.join(' ')}" data-id="${esc(id)}" aria-selected="${isSel}">${cells}</tr>`;
}

function tableCellHtml(ev, col, isSel, saving) {
  switch (col) {
    case 'sel':
      return saving
        ? '<span class="spin sm" role="status" aria-label="Wird gespeichert"></span>'
        : `<label class="tbl-check"><input type="checkbox" data-check ${isSel ? 'checked' : ''} tabindex="-1"
            aria-label="${esc(`${ev.subject}, ${dayMonth(ev.date)} auswählen`)}"><span aria-hidden="true"></span></label>`;
    case 'date': {
      const multi = ev.endDate && ev.endDate !== ev.date ? `<span class="tbl-sub">bis ${esc(dayMonth(ev.endDate))}</span>` : '';
      return `<span class="tbl-date"><b>${esc(wdShort(ev.date))}</b> ${esc(fmt(ev.date, { day: '2-digit', month: '2-digit', year: 'numeric' }))}</span>${multi}`;
    }
    case 'start':
      return ev.allDay ? '<span class="tbl-muted">Ganztägig</span>' : esc(ev.start || '');
    case 'end':
      return ev.allDay ? '' : esc(ev.end || '');
    case 'subject':
      return `<span class="tbl-title">${esc(ev.subject)}</span>`;
    case 'location':
      return esc(ev.location || '');
    case 'repeat': {
      const t = repeatText(ev);
      if (!t) return '<span class="tbl-muted">–</span>';
      const [main, until] = t.split(' bis ');
      return `<span class="tbl-repeat">${icon('series', 14, 2.5)}${esc(main)}</span>${until ? `<span class="tbl-sub">bis ${esc(until)}</span>` : ''}`;
    }
    case 'category': {
      if (!ev.category) return '<span class="tbl-muted">–</span>';
      const color = categoryColor(ev.category);
      return `<span class="tbl-cat">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(ev.category)}</span>`;
    }
    case 'status': {
      let badge;
      if (ev.status === S.VERSCHOBEN) {
        const target = parseGermanDate(ev.verschobenAuf);
        badge = `<span class="badge warn">${icon('arrowRight', 12, 2.5)}${target ? `auf ${esc(dayMonth(target))}` : 'Verschoben'}</span>`;
      } else {
        badge = statusBadge(ev);
      }
      return `<button type="button" class="tbl-status" data-open tabindex="-1" aria-label="${esc(`Details zu ${ev.subject}`)}">${badge}</button>`;
    }
    case 'changed':
      return `<span class="tbl-muted">${esc(ev.lastChange || '')}</span>`;
    default:
      return '';
  }
}

function tableEditorHtml(ev, c) {
  const label = `${c.label} von ${ev.subject}`;
  if (c.edit === 'select') {
    const opts = state.categoryList.map(x =>
      `<option value="${esc(x.name)}" ${(ev.category || '').toLowerCase() === x.name.toLowerCase() ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    return `<select class="cell-input" aria-label="${esc(label)}"><option value="">Keine</option>${opts}</select>`;
  }
  const value = c.key === 'subject' ? ev.subject : c.key === 'location' ? ev.location : ev[c.key];
  return `<input class="cell-input" type="${c.edit}" value="${esc(value || '')}" aria-label="${esc(label)}" autocomplete="off">`;
}

function tableBarHtml() {
  const n = tbl.selected.size;
  if (!n) return '';
  const evs = [...tbl.selected].map(tableEvent).filter(Boolean);
  const nCancel = evs.filter(e => e.status === S.AKTIV).length;
  const nReact = evs.filter(e => e.status === S.ABGESAGT || e.status === S.VERSCHOBEN).length;
  const dis = tbl.bulkBusy ? 'disabled' : '';
  return `<div class="tbl-bar" role="toolbar" aria-label="Aktionen für ${n} ausgewählte Termine">
    <span class="tbl-bar-count"><b>${n}</b> ausgewählt</span>
    <button type="button" class="btn small" data-bulk="cancel" ${nCancel && !tbl.bulkBusy ? '' : 'disabled'}>${icon('ban', 18)}Absagen (${nCancel})</button>
    <button type="button" class="btn small" data-bulk="reactivate" ${nReact && !tbl.bulkBusy ? '' : 'disabled'}>${icon('refresh', 18)}Wieder aktivieren (${nReact})</button>
    <button type="button" class="btn small" data-bulk="category" ${dis}>${icon('tags', 18)}Kategorie setzen…</button>
    ${can('admin') ? `<button type="button" class="btn small danger-outline" data-bulk="delete" ${dis}>Löschen (${n})</button>` : ''}
    <button type="button" class="btn small text" data-bulk="clear" ${dis}>Auswahl aufheben</button>
  </div>`;
}

function tableCell(id, col) {
  return listEl.querySelector(`td[data-id="${CSS.escape(id)}"][data-col="${col}"]`);
}

/* ---------- Bearbeiten in der Zelle ---------- */

/** Datum/Zeit einer Serie und Zeiten ganztägiger Termine gehen nur übers Formular. */
function tableCanInline(ev, col) {
  if (col === 'repeat') return false;
  if ((col === 'date' || col === 'start' || col === 'end') && ev.recurring) return false;
  if ((col === 'start' || col === 'end') && ev.allDay) return false;
  return true;
}

function tableStartEdit(id, col) {
  const ev = tableEvent(id);
  const c = TABLE_COLS.find(x => x.key === col);
  if (!ev || !c || !c.edit || tbl.saving.has(id) || tbl.bulkBusy) return;
  if (!tableCanInline(ev, col)) { openForm(ev, col === 'repeat' ? { focus: '#fRep' } : undefined); return; }
  delete tbl.errors[`${id}|${col}`];
  tbl.focus = { id, col };
  tbl.edit = { id, col };
  renderTable();
  const input = listEl.querySelector('.cell-input');
  if (!input) return;
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    tbl.edit = null;
    if (save) tableCommit(ev, col, input.value);
    else renderTable();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); tableFocusCell(id, col); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); tableFocusCell(id, col); }
  });
  input.addEventListener('blur', () => finish(true));
  if (c.edit === 'select') input.addEventListener('change', () => { finish(true); tableFocusCell(id, col); });
}

function tableFocusCell(id, col) {
  tbl.focus = { id, col };
  requestAnimationFrame(() => { const td = tableCell(id, col); if (td) td.focus({ preventScroll: true }); });
}

/** Neuen Wert prüfen, Termindaten zusammenbauen und speichern. */
function tableCommit(ev, col, raw) {
  const value = String(raw == null ? '' : raw).trim();
  const old = String((col === 'category' ? ev.category : ev[col]) || '');
  if (value === old) return renderTable();

  const data = {
    ref: { eventId: ev.eventId }, eventId: ev.eventId,
    subject: ev.subject, allDay: !!ev.allDay, date: ev.date, endDate: ev.endDate || ev.date,
    start: ev.start || '', end: ev.end || '', location: ev.location || '',
    description: ev.description || '', category: ev.category || '',
  };
  const fail = msg => { tbl.errors[`${ev.eventId}|${col}`] = msg; renderTable(); toast(msg, true); };

  switch (col) {
    case 'subject':
      if (!value) return fail('Der Titel darf nicht leer sein.');
      data.subject = value;
      break;
    case 'location':
      data.location = value;
      break;
    case 'category':
      data.category = value;
      break;
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('Bitte ein gültiges Datum eingeben.');
      // mehrtägige Termine behalten ihre Länge
      const days = Math.round((toDate(data.endDate) - toDate(data.date)) / 86400000);
      data.date = value;
      data.endDate = addDays(value, Math.max(0, days));
      break;
    }
    case 'start': {
      const s = minutes(value);
      if (s == null) return fail('Bitte eine Uhrzeit wie 19:30 eingeben.');
      // Beginn verschieben: Dauer bleibt gleich, das Ende rückt mit
      const os = minutes(data.start), oe = minutes(data.end);
      if (os != null && oe != null) {
        const span = (toDate(data.endDate) - toDate(data.date)) / 86400000 * 1440 + oe - os;
        const endAbs = s + span;
        data.endDate = addDays(data.date, Math.floor(endAbs / 1440));
        data.end = hhmm(endAbs);
      }
      data.start = value;
      break;
    }
    case 'end': {
      if (value && minutes(value) == null) return fail('Bitte eine Uhrzeit wie 21:30 eingeben.');
      if (value && data.endDate === data.date && minutes(value) <= minutes(data.start)) return fail('Das Ende liegt vor dem Beginn.');
      data.end = value;
      break;
    }
    default:
      return renderTable();
  }
  tableSave(ev.eventId, col, data);
}

function tableSave(id, col, data) {
  tbl.saving.add(id);
  renderTable();
  tbl.queue = tbl.queue.then(async () => {
    state.busy = true;
    renderHeader();
    try {
      const d = await api('saveEvent', data);
      applyData(d);
      delete tbl.errors[`${id}|${col}`];
    } catch (e) {
      if (e.auth) { tbl.saving.delete(id); state.busy = false; return logout(e.message); }
      tbl.errors[`${id}|${col}`] = e.message;
      toast(e.message, true);
      if (e.forbidden) setView('list');
    } finally {
      tbl.saving.delete(id);
      state.busy = tbl.saving.size > 0;
      renderHeader();
      if (state.view === 'table') renderTable();
    }
  });
}

/* ---------- Auswahl ---------- */

function tableToggle(id, shift) {
  const rows = tableRows().map(e => e.eventId);
  if (shift && tbl.anchor && rows.includes(tbl.anchor)) {
    const a = rows.indexOf(tbl.anchor), b = rows.indexOf(id);
    const on = !tbl.selected.has(id) || tbl.selected.has(tbl.anchor);
    rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => (on ? tbl.selected.add(x) : tbl.selected.delete(x)));
  } else if (tbl.selected.has(id)) {
    tbl.selected.delete(id);
  } else {
    tbl.selected.add(id);
  }
  tbl.anchor = id;
  tbl.focus = { id, col: 'sel' };
  renderTable();
  tableFocusCell(id, 'sel');
}

/* ---------- Mehrfach-Aktionen ---------- */

async function tableBulk(kind, btn) {
  const evs = [...tbl.selected].map(tableEvent).filter(Boolean);
  if (!evs.length) return;
  if (kind === 'clear') { tbl.selected.clear(); tbl.anchor = null; return renderTable(); }
  if (kind === 'category') return tableCategorySheet(evs);
  if (kind === 'delete') {
    return confirmAct({
      title: `${evs.length} ${evs.length === 1 ? 'Termin' : 'Termine'} löschen?`,
      text: 'Die Termine werden aus dem Kalender entfernt und im Blatt „Gelöscht“ gesichert. Wenn sie nur ausfallen, ist „Absagen“ meist besser.',
      label: 'Endgültig löschen', cls: 'primary',
      onYes: b => tableRunInSheet(b, async () => {
        let d = null, failed = 0;
        for (const ev of evs) {
          try { d = await api('setStatus', { ref: { eventId: ev.eventId }, status: S.LOESCHEN }); }
          catch (e) { if (e.auth) throw e; failed++; }
        }
        return Object.assign(d || await api('getData'), {
          message: `${evs.length - failed} gelöscht${failed ? `, ${failed} Fehler` : ''}.`, warning: failed > 0,
        });
      }),
      back: () => closeSheet(),
    });
  }
  const status = kind === 'cancel' ? S.ABGESAGT : S.AKTIV;
  const ids = evs.filter(e => (kind === 'cancel' ? e.status === S.AKTIV : e.status !== S.AKTIV)).map(e => e.eventId);
  if (!ids.length) return;
  await tableRun(btn, () => api('setStatusBulk', { eventIds: ids, status }));
}

/** Aktion aus der Aktionsleiste: Kreisel im Knopf, danach Auswahl leeren. */
async function tableRun(btn, fn) {
  if (tbl.bulkBusy || state.busy) return;
  tbl.bulkBusy = true;
  state.busy = true;
  renderHeader();
  listEl.querySelectorAll('.tbl-bar button').forEach(b => (b.disabled = true));
  if (btn) btn.innerHTML = '<span class="spin"></span>Wird gespeichert…';
  try {
    const d = await fn();
    if (d.events) applyData(d);
    tbl.selected.clear();
    toast(d.message || 'Gespeichert.', d.warning);
  } catch (e) {
    if (e.auth) { tbl.bulkBusy = false; state.busy = false; return logout(e.message); }
    toast(e.message, true);
  } finally {
    tbl.bulkBusy = false;
    state.busy = false;
    render();
  }
}

/** Wie tableRun, aber aus einem Sheet heraus (Bestätigung, Kategorie wählen). */
async function tableRunInSheet(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  tbl.bulkBusy = true;
  renderHeader();
  const buttons = sheetEl.querySelectorAll('button');
  buttons.forEach(b => (b.disabled = true));
  const label = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span>Wird gespeichert…';
  try {
    const d = await fn();
    if (d.events) applyData(d);
    tbl.selected.clear();
    state.busy = false;
    tbl.bulkBusy = false;
    closeSheet();
    render();
    toast(d.message || 'Gespeichert.', d.warning);
  } catch (e) {
    state.busy = false;
    tbl.bulkBusy = false;
    if (e.auth) { closeSheet(true); return logout(e.message); }
    buttons.forEach(b => (b.disabled = false));
    btn.innerHTML = label;
    renderHeader();
    toast(e.message, true);
  }
}

function tableCategorySheet(evs) {
  let chosen = null;
  const chip = (name, label) => {
    const color = name ? categoryColor(name) : null;
    return `<button class="chip" type="button" data-cat="${esc(name)}" aria-pressed="false">${
      color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}</button>`;
  };
  openSheet(`<div class="sheet-scroll">
      ${grip}
      <div class="sheet-head"><h2 id="sheetTitle">Kategorie setzen</h2>${closeBtn()}</div>
      <p class="sub">für ${evs.length} ${evs.length === 1 ? 'Termin' : 'Termine'}</p>
      <div class="chips" role="group" aria-label="Kategorie">${categoryOptions().map(n => chip(n, n)).join('')}${chip('', 'Keine')}</div>
    </div>
    <div class="sheet-foot">
      <button class="btn small" type="button" data-close style="flex:1">Abbrechen</button>
      <button class="btn primary" type="button" id="tcOk" style="flex:2" disabled>Übernehmen</button>
    </div>`);
  bindClose();
  sheetEl.querySelectorAll('[data-cat]').forEach(b => (b.onclick = () => {
    chosen = b.dataset.cat;
    sheetEl.querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('#tcOk').disabled = false;
  }));
  $('#tcOk').onclick = e => {
    if (chosen == null) return;
    const items = evs.map(ev => ({
      eventId: ev.eventId, subject: ev.subject, allDay: !!ev.allDay, date: ev.date, endDate: ev.endDate || ev.date,
      start: ev.start || '', end: ev.end || '', location: ev.location || '', description: ev.description || '', category: chosen,
    }));
    tableRunInSheet(e.currentTarget, async () => {
      let d = null, failed = 0;
      for (let i = 0; i < items.length; i += 50) {
        d = await api('saveEvents', { events: items.slice(i, i + 50) });
        failed += (d.failed || []).length;
      }
      return Object.assign(d, {
        message: `Kategorie ${chosen ? `„${chosen}“` : 'entfernt'} bei ${items.length - failed} ${items.length - failed === 1 ? 'Termin' : 'Terminen'}${failed ? `, ${failed} Fehler` : ''}.`,
        warning: failed > 0,
      });
    });
  };
}

/* ---------- Tastatur ---------- */

function tableMove(dRow, dCol, abs) {
  if (!tbl.focus) return;
  const rows = tableRows().map(e => e.eventId);
  let r = rows.indexOf(tbl.focus.id);
  let c = TABLE_COLS.findIndex(x => x.key === tbl.focus.col);
  if (abs === 'home') c = 0;
  else if (abs === 'end') c = TABLE_COLS.length - 1;
  else if (abs === 'top') r = 0;
  else if (abs === 'bottom') r = rows.length - 1;
  r = Math.max(0, Math.min(rows.length - 1, r + dRow));
  c = Math.max(0, Math.min(TABLE_COLS.length - 1, c + dCol));
  if (!rows.length) return;
  const id = rows[r], col = TABLE_COLS[c].key;
  const prev = tableCell(tbl.focus.id, tbl.focus.col);
  if (prev) prev.tabIndex = -1;
  tbl.focus = { id, col };
  const td = tableCell(id, col);
  if (td) { td.tabIndex = 0; td.focus(); td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}

function tableKeydown(e) {
  const td = e.target.closest && e.target.closest('td[data-col]');
  if (!td || e.target.classList.contains('cell-input')) return;
  const { id, col } = td.dataset;
  const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (map[e.key]) { e.preventDefault(); return tableMove(...map[e.key]); }
  if (e.key === 'Home') { e.preventDefault(); return tableMove(0, 0, e.ctrlKey ? 'top' : 'home'); }
  if (e.key === 'End') { e.preventDefault(); return tableMove(0, 0, e.ctrlKey ? 'bottom' : 'end'); }
  if (e.key === 'PageDown') { e.preventDefault(); return tableMove(10, 0); }
  if (e.key === 'PageUp') { e.preventDefault(); return tableMove(-10, 0); }
  if (e.key === ' ' || (e.key === 'Enter' && col === 'sel')) { e.preventDefault(); return tableToggle(id, e.shiftKey); }
  if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault();
    if (col === 'status' || col === 'changed') return openDetail(tableEvent(id));
    return tableStartEdit(id, col);
  }
  if (e.key === 'Escape' && tbl.selected.size) { e.preventDefault(); tbl.selected.clear(); renderTable(); tableFocusCell(id, col); }
}

/* ---------- Verdrahtung (einmal, aus app.js start()) ---------- */

function tableInit() {
  if (tbl.wired) return;
  tbl.wired = true;

  listEl.addEventListener('click', e => {
    if (state.view !== 'table') return;
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const col = sortBtn.dataset.sort;
      tbl.sort = tbl.sort.col === col ? { col, dir: -tbl.sort.dir } : { col, dir: 1 };
      renderTable();
      const again = listEl.querySelector(`[data-sort="${col}"]`);
      if (again) again.focus();
      return;
    }
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) return tableBulk(bulk.dataset.bulk, bulk);
    if (e.target.id === 'tblAll') {
      const rows = tableRows();
      if (e.target.checked) rows.forEach(ev => tbl.selected.add(ev.eventId));
      else rows.forEach(ev => tbl.selected.delete(ev.eventId));
      return renderTable();
    }
    const td = e.target.closest('td[data-col]');
    if (!td || td.classList.contains('editing')) return;
    const { id, col } = td.dataset;
    if (col === 'sel') {
      e.preventDefault();
      return tableToggle(id, e.shiftKey);
    }
    if (e.shiftKey && tbl.anchor) { e.preventDefault(); return tableToggle(id, true); }
    if (e.target.closest('[data-open]') || col === 'changed') return openDetail(tableEvent(id));
    tableStartEdit(id, col);
  });

  listEl.addEventListener('change', e => {
    if (state.view !== 'table') return;
    if (e.target.id === 'tfRange') tbl.filter.range = e.target.value;
    else if (e.target.id === 'tfCat') tbl.filter.cat = e.target.value;
    else if (e.target.id === 'tfStatus') tbl.filter.status = e.target.value;
    else return;
    renderTable();
  });

  listEl.addEventListener('keydown', e => { if (state.view === 'table') tableKeydown(e); });

  // Shift+Klick soll keinen Text markieren
  listEl.addEventListener('mousedown', e => {
    if (state.view === 'table' && e.shiftKey && e.target.closest('td[data-col]')) e.preventDefault();
  });

  window.addEventListener('resize', () => { if (state.view === 'table') tableFitHeight(); });

  // schmaler als 768 px (Tablet gedreht, Fenster verkleinert) → zurück zur Liste
  if (window.matchMedia) {
    const mq = matchMedia(TABLE_MIN_WIDTH);
    const onChange = () => { if (state.view === 'table' && !tableAllowed()) setView('list'); else render(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}
