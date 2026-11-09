/* Dienstplan – Termine importieren (docs/PWA-Spezifikation-V3.md, Kapitel 7.3)
 * Nur Admin. Excel (.xlsx/.xls) über SheetJS aus vendor/ – wird erst beim Öffnen
 * einer Excel-Datei nachgeladen. CSV und ICS liest eigener Code.
 * Wird vor app.js geladen; auf oberster Ebene steht nichts, was app.js braucht.
 */

const IMP_XLSX_SRC = 'vendor/xlsx.full.min.js';
const IMP_KEY_MAP = 'dienstplan.importMap';
const IMP_BATCH = 50;
const IMP_DEFAULT_MIN = 60; // fehlt das Ende: +60 Minuten (DEFAULT_DURATION_MIN)

// Felder, die zugeordnet werden können. aliases: übliche Spaltennamen (klein, ohne Satzzeichen)
const IMP_FIELDS = [
  { key: 'subject', label: 'Titel', required: true, aliases: ['subject', 'betreff', 'titel', 'title', 'termin', 'bezeichnung', 'veranstaltung', 'name', 'summary'] },
  { key: 'date', label: 'Datum', required: true, aliases: ['start date', 'startdatum', 'datum', 'date', 'tag', 'beginn datum', 'von datum', 'dtstart'] },
  { key: 'start', label: 'Beginn', aliases: ['start time', 'startzeit', 'beginn', 'uhrzeit', 'zeit', 'von', 'start', 'beginn uhrzeit'] },
  { key: 'endDate', label: 'Enddatum', aliases: ['end date', 'enddatum', 'bis datum', 'datum bis'] },
  { key: 'end', label: 'Ende', aliases: ['end time', 'endzeit', 'ende', 'bis', 'end', 'ende uhrzeit'] },
  { key: 'allDay', label: 'Ganztägig', aliases: ['all day event', 'all day', 'ganztägig', 'ganztaegig', 'ganztags', 'ganzer tag'] },
  { key: 'location', label: 'Ort', aliases: ['location', 'ort', 'wo', 'treffpunkt', 'place'] },
  { key: 'description', label: 'Beschreibung', aliases: ['description', 'beschreibung', 'notiz', 'notizen', 'bemerkung', 'bemerkungen', 'hinweis', 'info'] },
  { key: 'category', label: 'Kategorie', aliases: ['category', 'kategorie', 'art', 'typ', 'categories'] },
  { key: 'recurrence', label: 'Wiederholung', aliases: ['recurrence', 'wiederholung', 'rrule', 'serie'] },
];
const IMP_OLD_FORMAT = ['subject', 'start date', 'start time', 'end date', 'end time', 'all day event'];
const IMP_RRULE_RE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[-+,0-9A-Z]+)*$/;

const imp = {
  step: 1, fileName: '', kind: '', loading: '', error: '',
  wb: null, sheetNames: [], sheet: '',
  headers: [], rows: [], mapping: {}, autoNote: '',
  items: [], cats: {},   // cats: Name (klein) → { name, mode: 'new'|'none', colorId }
  progress: 0, total: 0, result: null,
};

function impReset() {
  Object.assign(imp, {
    step: 1, fileName: '', kind: '', loading: '', error: '', wb: null, sheetNames: [], sheet: '',
    headers: [], rows: [], mapping: {}, autoNote: '', items: [], cats: {}, progress: 0, total: 0, result: null,
  });
}

/* =========================
   LESEN: CSV, ICS, Excel
   ========================= */

/** Bytes → Text: erst UTF-8, sonst Windows-1252 (CSV aus deutschem Excel). */
function impDecode(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch (e) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** CSV mit ; , oder Tab, Anführungszeichen und Zeilenumbrüchen in Feldern. → Zeilen als Arrays */
function impParseCsv(text) {
  const first = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const count = ch => first.split(ch).length - 1;
  const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/** ICS-Zeitstempel → { date, time } in Europe/Berlin (time leer = ganztägig) */
function impIcsTime(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value || '');
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '' }; // VALUE=DATE: ganztägig
  if (m[7]) {
    // UTC → Berliner Zeit
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    const p = Object.fromEntries(new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` }; // Ortszeit (TZID) – wird als Berliner Zeit genommen
}

/** Eigener kleiner ICS-Parser: VEVENTs → fertige Termin-Rohdaten (ohne Zuordnung). */
function impParseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const unescape = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { ev = {}; continue; }
    if (/^END:VEVENT/i.test(line)) { if (ev) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const params = m[2] || '';
    const val = m[3];
    if (key === 'DTSTART' || key === 'DTEND') ev[key] = impIcsTime(val, params);
    else if (key === 'RRULE') ev.RRULE = val.trim();
    else if (key === 'CATEGORIES') ev.CATEGORIES = unescape(val).split(',')[0].trim();
    else if (['SUMMARY', 'LOCATION', 'DESCRIPTION', 'STATUS', 'RECURRENCE-ID'].includes(key)) ev[key] = unescape(val).trim();
  }
  return out.map(e => {
    const s = e.DTSTART, en = e.DTEND;
    const allDay = !!s && !s.time;
    let endDate = en ? en.date : (s ? s.date : '');
    // ganztägig: DTEND ist exklusiv
    if (allDay && en && en.date > s.date) endDate = impAddDays(en.date, -1);
    return {
      subject: e.SUMMARY || '', date: s ? s.date : '', endDate, allDay,
      start: allDay || !s ? '' : s.time, end: allDay || !en ? '' : en.time,
      location: e.LOCATION || '', description: e.DESCRIPTION || '', category: e.CATEGORIES || '',
      recurrence: e.RRULE || '',
      skip: e['RECURRENCE-ID'] ? 'Einzelner geänderter Termin einer Serie – wird mit der Serie übernommen.'
        : /^CANCELLED$/i.test(e.STATUS || '') ? 'In der Datei als abgesagt markiert.' : '',
    };
  });
}

/** SheetJS nachladen (nur für Excel). */
function impLoadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = IMP_XLSX_SRC;
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel-Leser nicht verfügbar.')));
    s.onerror = () => reject(new Error('Der Excel-Leser konnte nicht geladen werden. Bist du online?'));
    document.head.appendChild(s);
  });
}

/* =========================
   WERTE UMWANDELN
   ========================= */

const impPad = n => String(n).padStart(2, '0');
function impAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${impPad(dt.getMonth() + 1)}-${impPad(dt.getDate())}`;
}

/** Datum: TT.MM.JJJJ (auch T.M.JJ), JJJJ-MM-TT, TT/MM/JJJJ, Excel-Seriennummer. → { date, time } */
function impParseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const ms = Math.round((v - 25569) * 86400000); // Excel: Tage seit 30.12.1899
    const d = new Date(ms);
    const time = v % 1 ? `${impPad(d.getUTCHours())}:${impPad(d.getUTCMinutes())}` : '';
    return { date: `${d.getUTCFullYear()}-${impPad(d.getUTCMonth() + 1)}-${impPad(d.getUTCDate())}`, time };
  }
  if (v instanceof Date && !isNaN(v)) {
    return { date: `${v.getFullYear()}-${impPad(v.getMonth() + 1)}-${impPad(v.getDate())}`, time: '' };
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})(?:[ ,T]+(.+))?$/.exec(s);
  let date = '', rest = '';
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    date = `${y}-${impPad(m[2])}-${impPad(m[1])}`;
    rest = m[4] || '';
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(.+))?$/.exec(s))) {
    date = `${m[1]}-${impPad(m[2])}-${impPad(m[3])}`;
    rest = m[4] || '';
  } else if (/^\d{5}(\.\d+)?$/.test(s)) {
    return impParseDate(parseFloat(s));
  } else return null;
  const [y, mo, d] = date.split('-').map(Number);
  const chk = new Date(y, mo - 1, d);
  if (chk.getMonth() !== mo - 1 || chk.getDate() !== d) return null;
  return { date, time: rest ? impParseTime(rest) || '' : '' };
}

/** Zeit: HH:MM, H.MM, HH:MM:SS, „19 Uhr“, Excel-Bruchteil. → 'HH:MM' oder null */
function impParseTime(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) {
    const mins = Math.round((v % 1) * 1440) % 1440;
    return `${impPad(Math.floor(mins / 60))}:${impPad(mins % 60)}`;
  }
  if (v instanceof Date && !isNaN(v)) return `${impPad(v.getHours())}:${impPad(v.getMinutes())}`;
  const s = String(v).trim().toLowerCase().replace(/\s*uhr$/, '');
  let m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(s);
  if (m && +m[1] < 24 && +m[2] < 60) return `${impPad(m[1])}:${m[2]}`;
  m = /^(\d{1,2})$/.exec(s);
  if (m && +m[1] < 24) return `${impPad(m[1])}:00`;
  if (/^0?\.\d+$/.test(s)) return impParseTime(parseFloat(s));
  return null;
}

function impParseBool(v) {
  if (typeof v === 'boolean') return v;
  return /^(true|wahr|ja|yes|x|1)$/i.test(String(v == null ? '' : v).trim());
}

const impMinutes = t => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };

/* =========================
   ZUORDNEN, PRÜFEN, DUBLETTEN
   ========================= */

const impNorm = s => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Spalten automatisch zuordnen (gemerkte Zuordnung vor üblichen Namen). */
function impAutoMap(headers) {
  const norm = headers.map(impNorm);
  const map = {};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(IMP_KEY_MAP) || '{}') || {}; } catch (e) { /* egal */ }
  for (const f of IMP_FIELDS) {
    const remembered = saved[f.key] != null ? norm.indexOf(impNorm(saved[f.key])) : -1;
    if (remembered !== -1) { map[f.key] = remembered; continue; }
    const i = norm.findIndex((h, idx) => f.aliases.includes(h) && !Object.values(map).includes(idx));
    if (i !== -1) map[f.key] = i;
  }
  return map;
}

function impRememberMap() {
  const saved = {};
  for (const [k, i] of Object.entries(imp.mapping)) if (i != null && i !== -1) saved[k] = imp.headers[i];
  try { localStorage.setItem(IMP_KEY_MAP, JSON.stringify(saved)); } catch (e) { /* egal */ }
}

/** Zeile (Array) + Zuordnung → Rohdaten */
function impRowToRaw(row) {
  const get = k => (imp.mapping[k] != null && imp.mapping[k] !== -1 ? row[imp.mapping[k]] : '');
  return {
    subject: get('subject'), date: get('date'), endDate: get('endDate'), start: get('start'), end: get('end'),
    allDay: get('allDay'), location: get('location'), description: get('description'),
    category: get('category'), recurrence: get('recurrence'),
  };
}

/** Rohdaten → geprüfter Termin { …, mark: 'new'|'dup'|'error', reason, selected } */
function impBuildItem(raw, fromIcs) {
  const it = {
    subject: String(raw.subject == null ? '' : raw.subject).trim(),
    location: String(raw.location == null ? '' : raw.location).trim(),
    description: String(raw.description == null ? '' : raw.description).trim(),
    category: String(raw.category == null ? '' : raw.category).trim(),
    recurrence: '', date: '', endDate: '', start: '', end: '', allDay: false,
    mark: 'new', reason: '', selected: true,
  };
  const fail = reason => Object.assign(it, { mark: 'error', reason, selected: false });
  if (raw.skip) return fail(raw.skip);
  if (!it.subject) return fail('Titel fehlt.');

  const d = fromIcs ? (raw.date ? { date: raw.date, time: '' } : null) : impParseDate(raw.date);
  if (!d) return fail(raw.date === '' || raw.date == null ? 'Datum fehlt.' : `Datum nicht lesbar: „${raw.date}“`);
  it.date = d.date;
  const ed = raw.endDate === '' || raw.endDate == null ? null : (fromIcs ? { date: raw.endDate } : impParseDate(raw.endDate));
  if (raw.endDate && !ed) return fail(`Enddatum nicht lesbar: „${raw.endDate}“`);
  it.endDate = ed && ed.date > it.date ? ed.date : it.date;

  let start = fromIcs ? raw.start : impParseTime(raw.start);
  let end = fromIcs ? raw.end : impParseTime(raw.end);
  if (start === null) return fail(`Beginn nicht lesbar: „${raw.start}“`);
  if (end === null) return fail(`Ende nicht lesbar: „${raw.end}“`);
  if (!start && d.time) start = d.time; // Datum mit Uhrzeit in einer Zelle
  if (!end && ed && ed.time) end = ed.time;

  it.allDay = fromIcs ? !!raw.allDay : (impParseBool(raw.allDay) || !start);
  if (it.allDay) {
    it.start = ''; it.end = '';
  } else {
    it.start = start;
    const s = impMinutes(start);
    let e = impMinutes(end);
    if (e == null) {
      e = s + IMP_DEFAULT_MIN;
      if (e >= 1440 && it.endDate === it.date) it.endDate = impAddDays(it.date, 1);
      it.end = `${impPad(Math.floor((e % 1440) / 60))}:${impPad(e % 60)}`;
    } else {
      if (it.endDate === it.date && e <= s) return fail('Das Ende liegt vor dem Beginn.');
      it.end = end;
    }
  }

  const rr = String(raw.recurrence == null ? '' : raw.recurrence).trim().replace(/^RRULE:/i, '').toUpperCase();
  if (rr) {
    if (!IMP_RRULE_RE.test(rr)) return fail(`Wiederholung nicht lesbar: „${raw.recurrence}“`);
    it.recurrence = `RRULE:${rr}`;
  }
  if (it.subject.length > 200) return fail('Der Titel ist zu lang (höchstens 200 Zeichen).');
  return it;
}

/** Ähnliche Titel: gleich, einer enthält den anderen, oder Bigramm-Ähnlichkeit ≥ 0,8 */
function impSimilar(a, b) {
  const x = impNorm(a).replace(/\s+/g, ''), y = impNorm(b).replace(/\s+/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if ((x.length >= 5 && y.includes(x)) || (y.length >= 5 && x.includes(y))) return true;
  const grams = s => { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const ga = grams(x), gb = grams(y);
  if (!ga.length || !gb.length) return false;
  const pool = gb.slice();
  let hit = 0;
  ga.forEach(g => { const i = pool.indexOf(g); if (i !== -1) { hit++; pool.splice(i, 1); } });
  return (2 * hit) / (ga.length + gb.length) >= 0.8;
}

/** Dubletten: gleiches Datum + gleicher Beginn (bzw. beide ganztägig) + ähnlicher Titel – gegen den Kalender und frühere Zeilen der Datei. */
function impMarkDuplicates(items, existing) {
  const seen = [];
  for (const it of items) {
    if (it.mark === 'error') continue;
    const same = o => o.date === it.date && (!!o.allDay === !!it.allDay) && (it.allDay || (o.start || '') === it.start) && impSimilar(o.subject, it.subject);
    const inCal = existing.find(same);
    const inFile = seen.find(same);
    if (inCal || inFile) {
      it.mark = 'dup';
      it.selected = false;
      it.reason = inCal ? `Ähnlicher Termin schon im Kalender: „${inCal.subject}“` : `Steht weiter oben schon in der Datei: „${inFile.subject}“`;
    }
    seen.push(it);
  }
  return items;
}

/** Unbekannte Kategorien sammeln (Vorschlag: neu anlegen mit freier Farbe). */
function impCollectCats(items) {
  const known = (state.categoryList || []).map(c => c.name.toLowerCase());
  const used = new Set((state.categoryList || []).map(c => Number(c.colorId)));
  const free = COLOR_ORDER.filter(id => !used.has(id));
  const cats = {};
  for (const it of items) {
    if (!it.category || it.mark === 'error') continue;
    const k = it.category.toLowerCase();
    if (known.includes(k)) {
      it.category = state.categoryList.find(c => c.name.toLowerCase() === k).name;
      continue;
    }
    if (!cats[k]) {
      const prev = imp.cats[k];
      cats[k] = prev || { name: it.category, mode: 'new', colorId: free.shift() || COLOR_ORDER[0] };
      cats[k].count = 0;
    }
    cats[k].count++;
  }
  return cats;
}

/** Aus den Zeilen die Vorschau bauen. */
function impPrepare(rawList, fromIcs) {
  imp.items = impMarkDuplicates(rawList.map(r => impBuildItem(r, fromIcs)), state.events || []);
  imp.cats = impCollectCats(imp.items);
  imp.step = 3;
}

/* =========================
   OBERFLÄCHE
   ========================= */

/** Nur zeichnen, solange die Import-Seite offen ist (Import läuft auch weiter, wenn man sie verlässt). */
function impRender() {
  if (state.page === 'import') renderImportPage();
}

function impStepsHtml() {
  const names = ['Datei', 'Spalten', 'Vorschau', 'Import'];
  return `<ol class="imp-steps" aria-label="Schritte">${names.map((n, i) =>
    `<li class="${imp.step === i + 1 ? 'is-current' : imp.step > i + 1 ? 'is-done' : ''}" ${imp.step === i + 1 ? 'aria-current="step"' : ''}><span>${i + 1}</span>${n}</li>`).join('')}</ol>`;
}

function renderImportPage() {
  pageEl.classList.add('wide');
  let body = impStepsHtml();
  if (imp.step === 1) body += impStep1Html();
  else if (imp.step === 2) body += impStep2Html();
  else if (imp.step === 3) body += impStep3Html();
  else body += impStep4Html();
  pageEl.innerHTML = pageShell('Termine importieren', body);
  hydrateIcons(pageEl);
  impBind();
}

function impStep1Html() {
  if (imp.loading) return `<div class="loading" role="status"><span class="spin"></span>${esc(imp.loading)}</div>`;
  const sheetPick = imp.sheetNames.length > 1 ? `
    <fieldset class="group-set"><legend>Welches Blatt aus „${esc(imp.fileName)}“?</legend>
      <div class="group-box">${imp.sheetNames.map(n => `
        <button class="opt" type="button" data-sheet="${esc(n)}">${icon('note', 20)}<span class="grow">${esc(n)}</span>${icon('chevronRight', 18)}</button>`).join('')}</div>
    </fieldset>` : '';
  return `
    ${imp.error ? `<div class="note warn" role="alert">${icon('info', 18)}<span>${esc(imp.error)}</span></div>` : ''}
    ${sheetPick || `
    <label class="imp-drop" id="impDrop">
      ${icon('note', 32)}
      <b>Datei wählen</b>
      <span>Excel (.xlsx, .xls), CSV oder Kalender-Datei (.ics) – oder hierher ziehen</span>
      <input type="file" id="impFile" accept=".xlsx,.xls,.csv,.ics,text/csv,text/calendar,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel">
    </label>
    <div class="note">${icon('info', 18)}<span>Die Datei wird nur hier im Browser gelesen. Du siehst vor dem Import eine Vorschau und entscheidest, welche Termine übernommen werden.</span></div>`}`;
}

function impStep2Html() {
  const sample = imp.rows[0] || [];
  const opts = sel => `<option value="-1">— nicht zuordnen —</option>${imp.headers.map((h, i) =>
    `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `Spalte ${i + 1}`)}</option>`).join('')}`;
  const rows = IMP_FIELDS.map(f => {
    const i = imp.mapping[f.key] == null ? -1 : imp.mapping[f.key];
    const ex = i !== -1 ? sample[i] : '';
    return `<div class="imp-map-row">
      <label for="map-${f.key}">${esc(f.label)}${f.required ? ' <span class="imp-req">Pflicht</span>' : ''}</label>
      <select id="map-${f.key}" data-map="${f.key}">${opts(i)}</select>
      <span class="imp-sample" title="${esc(String(ex))}">${ex !== '' && ex != null ? esc(impShow(ex)) : ''}</span>
    </div>`;
  }).join('');
  return `
    <p class="sub">„${esc(imp.fileName)}“${imp.sheet ? ` · Blatt „${esc(imp.sheet)}“` : ''} · ${imp.rows.length} ${imp.rows.length === 1 ? 'Zeile' : 'Zeilen'}</p>
    <div class="imp-map">${rows}</div>
    <span class="small-note">Rechts steht als Beispiel der Wert aus der ersten Zeile. Die Zuordnung wird auf diesem Gerät gemerkt.</span>
    <div class="row-btns">
      <button class="btn small" type="button" id="impBack1" style="flex:1">Andere Datei</button>
      <button class="btn primary" type="button" id="impToPreview" style="flex:2">Weiter zur Vorschau</button>
    </div>`;
}

/** Zellwert zur Anzeige (Excel-Zahlen als Datum/Zeit erkennbar machen) */
function impShow(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = impParseDate(v); return d ? `${d.date}${d.time ? ' ' + d.time : ''}` : String(v); }
  if (typeof v === 'number' && v > 0 && v < 1) return impParseTime(v);
  return String(v).length > 40 ? String(v).slice(0, 40) + '…' : String(v);
}

function impStep3Html() {
  const n = { new: 0, dup: 0, error: 0 };
  imp.items.forEach(it => n[it.mark]++);
  const sel = imp.items.filter(it => it.selected).length;
  const cats = Object.entries(imp.cats);
  const swatch = id => `<span class="swatch" style="background:${realColor(id)}" aria-hidden="true"></span>`;
  const catHtml = cats.length ? `
    <fieldset class="group-set imp-cats"><legend>Unbekannte Kategorien</legend>
      ${cats.map(([k, c]) => `
      <div class="imp-cat">
        <span class="grow"><b>${esc(c.name)}</b><small>${c.count} ${c.count === 1 ? 'Termin' : 'Termine'}</small></span>
        <select data-catmode="${esc(k)}" aria-label="Was mit „${esc(c.name)}“ passieren soll">
          <option value="new" ${c.mode === 'new' ? 'selected' : ''}>neu anlegen</option>
          <option value="none" ${c.mode === 'none' ? 'selected' : ''}>ohne Kategorie</option>
        </select>
        ${c.mode === 'new' ? `<span class="imp-color">${swatch(c.colorId)}<select data-catcolor="${esc(k)}" aria-label="Farbe für „${esc(c.name)}“">${COLOR_ORDER.map(id =>
          `<option value="${id}" ${id === c.colorId ? 'selected' : ''}>${COLOR_NAMES[id]}</option>`).join('')}</select></span>` : ''}
      </div>`).join('')}
    </fieldset>` : '';
  const markHtml = it => it.mark === 'new' ? `<span class="badge ok">✓ neu</span>`
    : it.mark === 'dup' ? `<span class="badge warn">⚠ doppelt?</span>` : `<span class="badge off">✗ Fehler</span>`;
  const rows = imp.items.map((it, i) => {
    const catName = it.category && imp.cats[it.category.toLowerCase()] && imp.cats[it.category.toLowerCase()].mode === 'none' ? '' : it.category;
    const color = catName ? (categoryColor(catName) || (imp.cats[catName.toLowerCase()] ? realColor(imp.cats[catName.toLowerCase()].colorId) : null)) : null;
    const when = it.date ? `${wdShort(it.date)} ${fmt(it.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}${it.endDate && it.endDate !== it.date ? ` – ${dayMonth(it.endDate)}` : ''}` : '';
    return `<tr class="${it.mark === 'error' ? 'is-error' : ''}">
      <td class="c-sel"><label class="tbl-check"><input type="checkbox" data-imp="${i}" ${it.selected ? 'checked' : ''} ${it.mark === 'error' ? 'disabled' : ''}
        aria-label="${esc(`${it.subject || 'Zeile ' + (i + 1)} übernehmen`)}"><span aria-hidden="true"></span></label></td>
      <td>${markHtml(it)}</td>
      <td class="nowrap">${esc(when)}</td>
      <td class="nowrap">${it.allDay ? '<span class="tbl-muted">Ganztägig</span>' : it.start ? esc(`${it.start}–${it.end}`) : ''}</td>
      <td><b>${esc(it.subject)}</b>${it.recurrence ? `<span class="tbl-sub">${icon('series', 12, 2.5)} ${esc(repeatText({ recurrence: it.recurrence, date: it.date, recurring: true }))}</span>` : ''}</td>
      <td>${esc(it.location)}</td>
      <td>${catName ? `<span class="tbl-cat">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(catName)}</span>` : '<span class="tbl-muted">–</span>'}</td>
      <td class="imp-reason">${esc(it.reason)}</td>
    </tr>`;
  }).join('');
  return `
    <p class="sub">„${esc(imp.fileName)}“ · <b>${n.new}</b> neu · <b>${n.dup}</b> möglicherweise doppelt · <b>${n.error}</b> fehlerhaft${imp.autoNote ? ` · ${esc(imp.autoNote)}` : ''}</p>
    ${catHtml}
    <div class="imp-tools">
      <button class="btn small" type="button" data-impsel="new">Nur neue</button>
      <button class="btn small" type="button" data-impsel="all">Alle wählbaren</button>
      <button class="btn small" type="button" data-impsel="none">Keine</button>
    </div>
    <div class="tbl-scroll imp-scroll">
      <table class="tbl imp-tbl"><thead><tr>
        <th class="c-sel"><span class="sr-only">Übernehmen</span></th><th>Prüfung</th><th>Datum</th><th>Zeit</th><th>Titel</th><th>Ort</th><th>Kategorie</th><th>Hinweis</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="8" class="tbl-empty">Keine Termine in der Datei gefunden.</td></tr>`}</tbody></table>
    </div>
    <div class="row-btns">
      <button class="btn small" type="button" id="impBack2" style="flex:1">${imp.kind === 'ics' ? 'Andere Datei' : 'Zurück zur Zuordnung'}</button>
      <button class="btn primary" type="button" id="impGo" style="flex:2" ${sel ? '' : 'disabled'}>${sel} ${sel === 1 ? 'Termin' : 'Termine'} importieren</button>
    </div>`;
}

function impStep4Html() {
  const pct = imp.total ? Math.round((imp.progress / imp.total) * 100) : 0;
  if (!imp.result) {
    return `<div class="imp-progress" role="status" aria-live="polite">
      <b>Termine werden importiert…</b>
      <div class="imp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${imp.total}" aria-valuenow="${imp.progress}"><i style="width:${pct}%"></i></div>
      <span class="small-note">${imp.progress} von ${imp.total} · bitte die Seite offen lassen</span>
    </div>`;
  }
  const r = imp.result;
  return `<div class="imp-done" role="status">
      ${icon(r.failed.length ? 'info' : 'check', 32, 2.5)}
      <h2>${r.created} angelegt, ${r.skipped} übersprungen, ${r.failed.length} ${r.failed.length === 1 ? 'Fehler' : 'Fehler'}</h2>
      ${r.catsCreated ? `<span class="small-note">${r.catsCreated} neue ${r.catsCreated === 1 ? 'Kategorie' : 'Kategorien'} angelegt.</span>` : ''}
    </div>
    ${r.failed.length ? `<div class="group-box imp-errors">${r.failed.map(f => `
      <div class="opt"><span class="grow"><b>${esc(f.subject)}</b><small>${esc(f.when)} · ${esc(f.error)}</small></span></div>`).join('')}</div>` : ''}
    <div class="row-btns">
      <button class="btn small" type="button" id="impAgain" style="flex:1">Weitere Datei</button>
      <button class="btn primary" type="button" id="impClose" style="flex:2">Fertig</button>
    </div>`;
}

/* =========================
   ABLAUF
   ========================= */

function impBind() {
  const back = $('#pageBack');
  if (back) back.onclick = closePage; // Seite wird hier selbst neu gezeichnet
  const file = $('#impFile');
  if (file) file.onchange = () => { if (file.files[0]) impOpenFile(file.files[0]); };
  const drop = $('#impDrop');
  if (drop) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) impOpenFile(e.dataTransfer.files[0]);
    });
  }
  pageEl.querySelectorAll('[data-sheet]').forEach(b => (b.onclick = () => impUseSheet(b.dataset.sheet)));
  pageEl.querySelectorAll('[data-map]').forEach(s => (s.onchange = () => {
    imp.mapping[s.dataset.map] = +s.value;
    const row = s.closest('.imp-map-row');
    const ex = +s.value !== -1 ? (imp.rows[0] || [])[+s.value] : '';
    row.querySelector('.imp-sample').textContent = ex !== '' && ex != null ? impShow(ex) : '';
  }));
  const back1 = $('#impBack1');
  if (back1) back1.onclick = () => { impReset(); renderImportPage(); };
  const toPrev = $('#impToPreview');
  if (toPrev) toPrev.onclick = () => {
    const missing = IMP_FIELDS.filter(f => f.required && (imp.mapping[f.key] == null || imp.mapping[f.key] === -1));
    if (missing.length) return toast(`Bitte zuordnen: ${missing.map(f => f.label).join(', ')}.`, true);
    impRememberMap();
    impPrepare(imp.rows.map(impRowToRaw), false);
    renderImportPage();
  };
  pageEl.querySelectorAll('[data-imp]').forEach(c => (c.onchange = () => {
    imp.items[+c.dataset.imp].selected = c.checked;
    impUpdateGo();
  }));
  pageEl.querySelectorAll('[data-impsel]').forEach(b => (b.onclick = () => {
    imp.items.forEach(it => {
      if (it.mark === 'error') return;
      it.selected = b.dataset.impsel === 'all' || (b.dataset.impsel === 'new' && it.mark === 'new');
    });
    renderImportPage();
  }));
  pageEl.querySelectorAll('[data-catmode]').forEach(s => (s.onchange = () => { imp.cats[s.dataset.catmode].mode = s.value; renderImportPage(); }));
  pageEl.querySelectorAll('[data-catcolor]').forEach(s => (s.onchange = () => { imp.cats[s.dataset.catcolor].colorId = +s.value; renderImportPage(); }));
  const back2 = $('#impBack2');
  if (back2) back2.onclick = () => {
    if (imp.kind === 'ics') { impReset(); } else imp.step = 2;
    renderImportPage();
  };
  const go = $('#impGo');
  if (go) go.onclick = impRun;
  const again = $('#impAgain');
  if (again) again.onclick = () => { impReset(); renderImportPage(); };
  const done = $('#impClose');
  if (done) done.onclick = () => { impReset(); closePage(); };
}

function impUpdateGo() {
  const sel = imp.items.filter(it => it.selected).length;
  const go = $('#impGo');
  if (go) { go.disabled = !sel; go.textContent = `${sel} ${sel === 1 ? 'Termin' : 'Termine'} importieren`; }
}

async function impOpenFile(f) {
  impReset();
  imp.fileName = f.name;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'ics' || f.type === 'text/calendar') {
      imp.kind = 'ics';
      const list = impParseIcs(impDecode(await f.arrayBuffer()));
      if (!list.length) throw new Error('In der Kalender-Datei stehen keine Termine (VEVENT).');
      impPrepare(list, true);
    } else if (ext === 'csv' || f.type === 'text/csv') {
      imp.kind = 'csv';
      impUseTable(impParseCsv(impDecode(await f.arrayBuffer())));
    } else if (ext === 'xlsx' || ext === 'xls') {
      imp.kind = 'xlsx';
      imp.loading = 'Excel-Leser wird geladen…';
      renderImportPage();
      const XLSX = await impLoadXlsx();
      imp.wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      imp.sheetNames = imp.wb.SheetNames.filter(n => {
        const ws = imp.wb.Sheets[n];
        return ws && ws['!ref'];
      });
      imp.loading = '';
      if (!imp.sheetNames.length) throw new Error('Die Excel-Datei enthält keine Daten.');
      if (imp.sheetNames.length === 1) return impUseSheet(imp.sheetNames[0]);
    } else {
      throw new Error('Diese Datei kann ich nicht lesen. Möglich sind .xlsx, .xls, .csv und .ics.');
    }
  } catch (e) {
    const name = imp.fileName;
    impReset();
    imp.fileName = name;
    imp.error = e.message || String(e);
  }
  renderImportPage();
}

function impUseSheet(name) {
  imp.sheet = name;
  const rows = window.XLSX.utils.sheet_to_json(imp.wb.Sheets[name], { header: 1, raw: true, defval: '' });
  impUseTable(rows.filter(r => r.some(v => String(v).trim() !== '')));
  renderImportPage();
}

/** Tabelle (erste Zeile = Spaltennamen) übernehmen; bekanntes Format ohne Zuordnung direkt zur Vorschau. */
function impUseTable(rows) {
  if (rows.length < 2) {
    imp.error = 'In der Datei steht keine Terminzeile (erste Zeile = Spaltennamen).';
    imp.step = 1;
    return;
  }
  imp.headers = rows[0].map(h => String(h == null ? '' : h).trim());
  imp.rows = rows.slice(1);
  imp.mapping = impAutoMap(imp.headers);
  const norm = imp.headers.map(impNorm);
  const oldFormat = IMP_OLD_FORMAT.filter(h => norm.includes(h)).length >= 2 && norm.includes('subject') && norm.includes('start date');
  if (oldFormat) {
    imp.autoNote = 'bisheriges Excel-Format erkannt';
    impPrepare(imp.rows.map(impRowToRaw), false);
  } else {
    imp.step = 2;
  }
}

/** Schritt 4: Kategorien anlegen, dann in Paketen zu 50 über saveEvents. */
async function impRun() {
  if (state.busy) return;
  const chosen = imp.items.filter(it => it.selected && it.mark !== 'error');
  if (!chosen.length) return;
  const skipped = imp.items.length - chosen.length;
  state.busy = true;
  renderHeader();
  imp.step = 4;
  imp.total = chosen.length;
  imp.progress = 0;
  renderImportPage();

  const result = { created: 0, skipped, failed: [], catsCreated: 0 };
  const when = it => `${fmt(it.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}${it.allDay ? '' : `, ${it.start} Uhr`}`;
  let last = null;
  try {
    // 1. unbekannte Kategorien anlegen (nur die, die noch gebraucht werden)
    for (const c of Object.values(imp.cats)) {
      if (c.mode !== 'new' || !chosen.some(it => it.category.toLowerCase() === c.name.toLowerCase())) continue;
      try {
        last = await api('saveCategory', { name: c.name, colorId: c.colorId });
        result.catsCreated++;
      } catch (e) {
        if (e.auth || e.forbidden) throw e;
        c.mode = 'none';
        result.failed.push({ subject: `Kategorie „${c.name}“`, when: 'nicht angelegt', error: e.message });
      }
    }
    const payload = chosen.map(it => {
      const c = it.category ? imp.cats[it.category.toLowerCase()] : null;
      return {
        subject: it.subject, date: it.date, endDate: it.endDate, allDay: it.allDay, start: it.start, end: it.end,
        location: it.location, description: it.description, category: c && c.mode === 'none' ? '' : it.category,
        recurrence: it.recurrence,
      };
    });
    // 2. Termine in Paketen
    for (let i = 0; i < payload.length; i += IMP_BATCH) {
      const part = payload.slice(i, i + IMP_BATCH);
      try {
        last = await api('saveEvents', { events: part });
        result.created += last.created || 0;
        (last.failed || []).forEach(f => {
          const it = chosen[i + f.index];
          result.failed.push({ subject: it.subject, when: when(it), error: f.error });
        });
      } catch (e) {
        if (e.auth || e.forbidden) throw e;
        part.forEach((p, j) => result.failed.push({ subject: p.subject, when: when(chosen[i + j]), error: e.message }));
      }
      imp.progress = Math.min(payload.length, i + part.length);
      impRender();
    }
  } catch (e) {
    state.busy = false;
    if (e.auth) return logout(e.message);
    toast(e.message, true);
    imp.step = 3;
    impRender();
    return;
  }
  state.busy = false;
  if (last && last.events) applyData(last);
  renderHeader();
  imp.result = result;
  impRender();
  toast(`${result.created} ${result.created === 1 ? 'Termin' : 'Termine'} importiert.`, result.failed.length > 0);
}
