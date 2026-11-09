/******************************************************
 * Dienstplan – Schnittstelle für die Handy-App (PWA)
 *
 * Gehört ins SELBE Apps-Script-Projekt wie Dienstplan-Sync.gs und Kalender.gs.
 * Die App liegt auf GitHub Pages und schickt ihre Anfragen hierher.
 * Termine und Kategorien liegen im Google Kalender (Kalender.gs).
 *
 * Schutz: Jede Anfrage braucht einen persönlichen Zugangscode.
 * Seit Version 2 (Spezifikation V2, Kapitel 2 + 3):
 *   - Rollen: admin · write · read, geprüft bei JEDER Anfrage
 *   - gespeichert wird nur der SHA-256-Hash des Codes, nie der Code selbst
 *   - Codes liegen in den Script-Eigenschaften (nicht im Code, nicht im Sheet)
 *
 * Bereitstellung: Web-App, "Ausführen als: Ich", "Zugriff: Jeder".
 *
 * Einmalig nach dem Update auf Version 2 im Editor ausführen:
 *   1. migrateCodesV2()   alte Codes → neues Modell (Rolle "write")
 *   2. setAdmin()         eigenen Code zum Admin machen
 ******************************************************/

const WEBAPP = {
  // Stand der Schnittstelle – erscheint beim Aufruf der /exec-Adresse im Browser.
  // So lässt sich prüfen, ob die neue Version wirklich bereitgestellt ist.
  VERSION: '6.1 (automatisch bereitgestellt)',

  // Adresse der App auf GitHub Pages (für die Anmelde-Links)
  APP_URL: 'https://lars-menke.github.io/dienstplan/',

  PROP_CODES_V2: 'ZUGANGSCODES_V2',  // neues Modell (Hash, Rolle …)
  PROP_CODES_LEGACY: 'ZUGANGSCODES', // altes Modell (Klartext), wird migriert und gelöscht

  LAST_USED_INTERVAL_MS: 60 * 60 * 1000, // lastUsed höchstens stündlich schreiben
  MAX_NAME_LENGTH: 60,
};

const ROLES = {
  read: { rank: 1, label: 'Lesen', help: 'Termine nur ansehen' },
  write: { rank: 2, label: 'Schreiben', help: 'Termine anlegen, bearbeiten, absagen, verschieben' },
  admin: { rank: 3, label: 'Admin', help: 'zusätzlich löschen und Verwaltung' },
};

const MSG_FORBIDDEN = 'Dafür fehlen dir die Rechte.';

/* =========================
   EINSTIEG
   ========================= */

function doGet() {
  return json_({ ok: true, info: 'Dienstplan-Schnittstelle. Bitte die App verwenden.', version: WEBAPP.VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Ungültige Anfrage.' });
  }

  let user = null;
  try {
    user = authenticate_(req.code);
    const data = req.data || {};
    requireRole_(user, requiredRole_(req.action, data));
    const result = handleAction_(req.action, data, user);
    return json_(Object.assign({ ok: true }, result, userInfo_(user)));
  } catch (err) {
    if (err.isAuth) return json_({ ok: false, error: errMsg_(err), auth: true });
    if (err.isForbidden) return json_(Object.assign({ ok: false, error: MSG_FORBIDDEN, forbidden: true }, userInfo_(user)));
    Logger.log(`FEHLER App (${req.action}): ${errMsg_(err)}`);
    return json_(Object.assign({ ok: false, error: errMsg_(err) }, user ? userInfo_(user) : {}));
  }
}

/** Steht in jeder Antwort (V2, Kapitel 5.1). `user` bleibt für die Live-App erhalten. */
function userInfo_(user) {
  return { role: user.role, userName: user.name, user: user.name };
}

function handleAction_(action, data, user) {
  checkTimezone_(true);
  // Termine und Kategorien: direkt im Google Kalender (Kalender.gs)
  if (V3_ACTIONS.includes(action)) return handleActionV3_(action, data, user);
  switch (action) {
    // Verwaltung (V2, Kapitel 5.2) – nur Admin
    case 'listCodes': return listCodes_(user);
    case 'createCode': return createCodeApi_(data, user);
    case 'updateCode': return updateCode_(data, user);
    case 'deleteCode': return deleteCode_(data, user);
    case 'rotateTeamCode': return rotateTeamCode_(user);
    default: throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

/** Für Admins zusätzlich die Anzahl der Zugangscodes (Anzeige in „Weitere Aktionen“). */
function withAdminInfo_(result, user) {
  if (user.role === 'admin') {
    const store = loadCodeStore_();
    result.codeCount = store ? store.length : 0;
  }
  return result;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================
   RECHTE (V2, Kapitel 2 + 5.1)
   ========================= */

/** Mindestrolle je Aktion. Unbekannte Aktionen brauchen sicherheitshalber Admin. */
function requiredRole_(action, data) {
  switch (action) {
    case 'getData':
      return 'read';
    case 'saveEvent':
    case 'saveEvents':
    case 'setStatusBulk':
      return 'write';
    case 'setStatus':
      return normalizeStatus_(data.status) === CONFIG.STATUS.LOESCHEN ? 'admin' : 'write';
    case 'syncAll':
    case 'saveCategory':
    case 'deleteCategory':
    case 'listCodes':
    case 'createCode':
    case 'updateCode':
    case 'deleteCode':
    case 'rotateTeamCode':
      return 'admin';
    default:
      return 'admin';
  }
}

function requireRole_(user, role) {
  const have = (ROLES[user.role] || ROLES.read).rank;
  if (have < ROLES[role].rank) {
    const err = new Error(MSG_FORBIDDEN);
    err.isForbidden = true;
    throw err;
  }
}

/* =========================
   ZUGANGSCODES – Speicher (V2, Kapitel 3.1)
   =========================
 * Eintrag: { id, name, role, team, hash, hint, blocked, created, lastUsed }
 *   hash     SHA-256 (hex) des normalisierten Codes
 *   hint     erste und letzte 4 Zeichen, z.B. "K7QM…H2XP"
 *   blocked  false oder ISO-Zeit der Sperre
 *   created, lastUsed  ISO-Zeit (lastUsed kann null sein)
 */

/** Neues Modell laden. null = noch nicht migriert. */
function loadCodeStore_() {
  const raw = PropertiesService.getScriptProperties().getProperty(WEBAPP.PROP_CODES_V2);
  if (raw == null) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    throw new Error('Zugangscodes sind beschädigt (Script-Eigenschaft ZUGANGSCODES_V2).');
  }
}

function saveCodeStore_(list) {
  PropertiesService.getScriptProperties().setProperty(WEBAPP.PROP_CODES_V2, JSON.stringify(list));
}

function loadLegacyCodes_() {
  const raw = PropertiesService.getScriptProperties().getProperty(WEBAPP.PROP_CODES_LEGACY);
  try {
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/** Liest/ändert den Code-Speicher unter Sperre, damit sich Änderungen nicht überschreiben. */
function withCodeStore_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Die Zugangscodes werden gerade bearbeitet. Bitte gleich nochmal versuchen.');
  try {
    const store = loadCodeStore_();
    if (store == null) throw new Error('Die Zugangscodes sind noch im alten Format. Bitte zuerst migrateCodesV2() ausführen.');
    const result = fn(store);
    saveCodeStore_(store);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   ZUGANGSCODES – Prüfen
   ========================= */

/** Gibt { name, role, id } zurück oder wirft einen Anmeldefehler. */
function authenticate_(code) {
  const clean = normalizeCode_(code);
  const store = clean ? loadCodeStore_() : [];

  // Übergang: solange nicht migriert wurde, gelten die alten Codes mit Rolle "write"
  if (store == null) {
    const legacy = loadLegacyCodes_().find(c => c.code === clean);
    if (legacy) return { id: null, name: legacy.name, role: 'write' };
    return authFail_();
  }

  const hash = hashCode_(clean);
  const entry = store.find(c => c.hash === hash);
  if (!entry || entry.blocked) return authFail_();

  touchLastUsed_(entry);
  return { id: entry.id, name: entry.name, role: entry.team ? 'read' : normalizeRole_(entry.role) };
}

function authFail_() {
  Utilities.sleep(800); // bremst Durchprobieren
  const err = new Error('Zugangscode ungültig oder gesperrt.');
  err.isAuth = true;
  throw err;
}

/** lastUsed höchstens einmal pro Stunde schreiben (V2, Kapitel 3.1). */
function touchLastUsed_(entry) {
  const last = entry.lastUsed ? new Date(entry.lastUsed).getTime() : 0;
  if (Date.now() - last < WEBAPP.LAST_USED_INTERVAL_MS) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // nicht wichtig genug, um zu warten
  try {
    const store = loadCodeStore_();
    const fresh = store && store.find(c => c.id === entry.id);
    if (!fresh) return;
    fresh.lastUsed = new Date().toISOString();
    saveCodeStore_(store);
  } catch (e) {
    Logger.log('lastUsed nicht gespeichert: ' + errMsg_(e));
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   ZUGANGSCODES – Erzeugen & Ändern
   (Kern für das Sheet-Menü; die App-Verwaltung folgt in Etappe 3)
   ========================= */

function normalizeCode_(code) {
  return (code || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeRole_(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role) ? role : 'read';
}

function hashCode_(clean) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, clean, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function codeHint_(clean) {
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

/** 20 Zeichen ohne verwechselbare Zeichen (kein 0/O, 1/I/L) ≈ 99 Bit Zufall */
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

function newCodeId_() {
  return 'c_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/**
 * Legt einen Code an. Gibt { entry, code, link } zurück.
 * Der Code selbst wird nur hier einmal zurückgegeben und nirgends gespeichert.
 */
function createCode_(name, role, team) {
  const cleanName = (name || '').toString().trim();
  if (!cleanName) throw new Error('Bitte einen Namen eingeben.');
  if (cleanName.length > WEBAPP.MAX_NAME_LENGTH) throw new Error(`Der Name ist zu lang (höchstens ${WEBAPP.MAX_NAME_LENGTH} Zeichen).`);
  if (!team && !ROLES[role]) throw new Error('Bitte eine Rolle wählen.');

  return withCodeStore_(store => {
    if (!team && store.some(c => !c.team && c.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error(`Für „${cleanName}“ gibt es schon einen Code.`);
    }

    let code;
    let hash;
    do {
      code = generateCode_();
      hash = hashCode_(code);
    } while (store.some(c => c.hash === hash));

    const entry = {
      id: newCodeId_(),
      name: cleanName,
      role: team ? 'read' : role,
      team: !!team,
      hash,
      hint: codeHint_(code),
      blocked: false,
      created: new Date().toISOString(),
      lastUsed: null,
    };
    store.push(entry);
    return { entry, code, link: codeLink_(code) };
  });
}

function codeLink_(code) {
  return `${WEBAPP.APP_URL}#code=${code}`;
}

function activeAdmins_(store) {
  return store.filter(c => !c.team && !c.blocked && c.role === 'admin');
}

/** Ändert Rolle und/oder Sperre eines Codes. Der letzte aktive Admin bleibt immer Admin. */
function updateCodeEntry_(store, entry, changes) {
  const next = Object.assign({}, entry, changes);
  if (entry.team) next.role = 'read';

  const admins = activeAdmins_(store);
  const losesAdmin = entry.role === 'admin' && !entry.blocked && (next.role !== 'admin' || next.blocked);
  if (losesAdmin && admins.length <= 1) {
    throw new Error('Das ist der letzte Admin-Code. Er kann weder gesperrt noch herabgestuft werden.');
  }
  Object.assign(entry, next);
  return entry;
}

function findCodeByName_(store, name) {
  const key = (name || '').toString().trim().toLowerCase();
  return store.find(c => !c.team && c.name.toLowerCase() === key) || null;
}

/* =========================
   EINMALIG IM EDITOR AUSFÜHREN
   ========================= */

/**
 * Überführt die alten Klartext-Codes ins neue Modell (V2, Kapitel 2 + 3.1).
 * Bestehende Codes bekommen die Rolle "write", der Name bleibt.
 * Danach wird die alte Eigenschaft gelöscht. Mehrfaches Ausführen schadet nicht.
 */
function migrateCodesV2() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const props = PropertiesService.getScriptProperties();
    const legacy = loadLegacyCodes_();
    const store = loadCodeStore_() || [];
    let added = 0;
    let skipped = 0;

    for (const old of legacy) {
      const clean = normalizeCode_(old.code);
      if (!clean || !old.name) { skipped++; continue; }
      const hash = hashCode_(clean);
      if (store.some(c => c.hash === hash)) { skipped++; continue; }

      store.push({
        id: newCodeId_(),
        name: old.name,
        role: 'write',
        team: false,
        hash,
        hint: codeHint_(clean),
        blocked: false,
        created: legacyDateToIso_(old.created),
        lastUsed: null,
      });
      added++;
    }

    saveCodeStore_(store);
    props.deleteProperty(WEBAPP.PROP_CODES_LEGACY);

    const summary = `Migration fertig: ${added} Code(s) übernommen, ${skipped} übersprungen. ` +
      `Jetzt im neuen Format: ${store.length}. Alte Klartext-Codes gelöscht.`;
    Logger.log(summary);
    Logger.log('Codes: ' + store.map(c => `${c.name} (${ROLES[c.role] ? ROLES[c.role].label : c.role})`).join(', '));
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Macht einen Code zum Admin.
 * Im Editor: Ohne Namen wird der einzige vorhandene persönliche Code genommen.
 * Gibt es mehrere, eine Zeile wie  setAdmin('Lars')  in eine Hilfsfunktion schreiben
 * oder im Sheet-Menü „🔑 Zugangscodes verwalten…“ die Rolle ändern.
 */
function setAdmin(name) {
  const store = loadCodeStore_();
  if (store == null) throw new Error('Bitte zuerst migrateCodesV2() ausführen.');

  let target = name ? findCodeByName_(store, name) : null;
  if (!name) {
    const personal = store.filter(c => !c.team);
    if (personal.length !== 1) {
      throw new Error(`Bitte einen Namen angeben. Vorhandene Codes: ${personal.map(c => c.name).join(', ') || 'keine'}`);
    }
    target = personal[0];
  }
  if (!target) throw new Error(`Kein Code mit dem Namen „${name}“ gefunden.`);

  withCodeStore_(list => {
    const entry = list.find(c => c.id === target.id);
    updateCodeEntry_(list, entry, { role: 'admin', blocked: false });
  });
  const msg = `„${target.name}“ ist jetzt Admin.`;
  Logger.log(msg);
  return msg;
}

function legacyDateToIso_(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((s || '').toString().trim());
  return m ? new Date(+m[3], +m[2] - 1, +m[1]).toISOString() : new Date().toISOString();
}

/* =========================
   ZUGANGSCODES – Sheet-Menü (Notfallweg, V2 Kapitel 3.1)
   ========================= */

/** Menü „🔑 Zugangscode erstellen…“: Dialog mit Name und Rolle. */
function createAccessCode() {
  if (loadCodeStore_() == null) {
    SpreadsheetApp.getUi().alert('Bitte zuerst im Apps-Script-Editor migrateCodesV2() ausführen.');
    return;
  }

  const roleOptions = ['read', 'write', 'admin'].map(r => `
      <label style="display:block;margin:6px 0;cursor:pointer">
        <input type="radio" name="role" value="${r}"${r === 'write' ? ' checked' : ''}>
        <b>${ROLES[r].label}</b> – ${escapeHtml_(ROLES[r].help)}
      </label>`).join('');

  const html = HtmlService.createHtmlOutput(`
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
      <div id="form">
        <label>Für wen?<br>
          <input id="name" maxlength="${WEBAPP.MAX_NAME_LENGTH}" style="width:100%;padding:8px;font-size:14px;box-sizing:border-box">
        </label>
        <div style="color:#666;font-size:12px">Erscheint bei „Letzte Änderung“.</div>
        <p style="margin:14px 0 4px"><b>Rolle</b></p>
        ${roleOptions}
        <p style="color:#666;font-size:12px">Der Code wird nur einmal vollständig angezeigt.</p>
        <button id="go" style="padding:8px 16px">Code erstellen</button>
        <div id="err" style="color:#b00;margin-top:8px"></div>
      </div>
      <div id="result" style="display:none">
        <p>Zugangscode für <b id="rName"></b> (<span id="rRole"></span>):</p>
        <p id="rCode" style="font:600 22px monospace;letter-spacing:2px;background:#f3f3f3;padding:10px;border-radius:8px;text-align:center"></p>
        <p><b>Am einfachsten:</b> diesen Link aufs Handy schicken. Wer ihn öffnet, ist direkt angemeldet:</p>
        <input id="rLink" readonly style="width:100%;padding:8px;font-size:13px;box-sizing:border-box" onclick="this.select()">
        <p><button id="copy">Link kopieren</button></p>
        <p style="color:#a00">Der Code wird nur jetzt angezeigt. Link nur an diese eine Person geben – er funktioniert wie ein Passwort.</p>
      </div>
    </div>
    <script>
      var $ = function (id) { return document.getElementById(id); };
      $('go').onclick = function () {
        var role = document.querySelector('input[name=role]:checked').value;
        $('go').disabled = true; $('err').textContent = '';
        google.script.run
          .withSuccessHandler(function (r) {
            $('form').style.display = 'none'; $('result').style.display = 'block';
            $('rName').textContent = r.name; $('rRole').textContent = r.roleLabel;
            $('rCode').textContent = r.pretty; $('rLink').value = r.link;
          })
          .withFailureHandler(function (e) { $('go').disabled = false; $('err').textContent = e.message; })
          .createCodeFromMenu($('name').value, role);
      };
      $('copy').onclick = function () { $('rLink').select(); document.execCommand('copy'); this.textContent = 'Kopiert ✓'; };
    </script>`).setWidth(480).setHeight(470);

  SpreadsheetApp.getUi().showModalDialog(html, '🔑 Zugangscode erstellen');
}

/** Wird vom Dialog aufgerufen (google.script.run). */
function createCodeFromMenu(name, role) {
  const r = createCode_(name, role, false);
  return { name: r.entry.name, roleLabel: ROLES[r.entry.role].label, pretty: formatCode_(r.code), link: r.link };
}

/**
 * Menü „🔑 Zugangscodes verwalten…“: Übersicht aller Codes mit
 * Rolle ändern, Sperren/Entsperren und Löschen (nur gesperrte Codes).
 * Die Codes selbst sind nicht gespeichert (nur der Hash) und daher nicht sichtbar.
 */
function manageAccessCodes() {
  if (loadCodeStore_() == null) {
    SpreadsheetApp.getUi().alert('Bitte zuerst im Apps-Script-Editor migrateCodesV2() ausführen.');
    return;
  }

  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; margin: 0; color: #1b1b1b; }
      .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
      #msg { min-height: 18px; font-weight: bold; }
      #msg.err { color: #b00; } #msg.ok { color: #2e7d32; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; font-size: 11px; text-transform: uppercase; color: #666; border-bottom: 2px solid #ddd; padding: 6px 4px; }
      td { border-bottom: 1px solid #eee; padding: 6px 4px; vertical-align: middle; }
      tr.blocked td { color: #999; background: #fafafa; }
      tr.blocked .name { text-decoration: line-through; }
      .name { font-weight: bold; }
      .sub { font-size: 11px; color: #777; }
      .hint { font-family: monospace; white-space: nowrap; }
      .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; font-weight: bold; background: #eee; }
      .badge.blocked { background: #ffcdd2; color: #8e1c16; }
      .badge.active { background: #e8f5e9; color: #2e7d32; }
      select, button { font-size: 12px; padding: 4px 6px; }
      button { cursor: pointer; white-space: nowrap; }
      button.danger { color: #b00; }
      button.confirm { background: #b00; color: #fff; border: 1px solid #b00; }
      .actions { white-space: nowrap; text-align: right; }
      .note { margin-top: 10px; font-size: 11px; color: #777; }
    </style>
    <div class="bar">
      <div id="msg"></div>
      <button id="new">＋ Neuer Zugangscode</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Rolle</th><th>Status</th><th>Code</th><th>Erstellt</th><th>Zuletzt genutzt</th><th></th></tr></thead>
      <tbody id="rows"><tr><td colspan="7">Lade…</td></tr></tbody>
    </table>
    <div class="note">
      Die vollständigen Codes werden aus Sicherheitsgründen nicht gespeichert, nur die ersten und letzten 4 Zeichen.
      Hat jemand seinen Code verloren: sperren, löschen und neu erstellen.
      Löschen geht nur bei gesperrten Codes. Der letzte Admin kann weder gesperrt noch herabgestuft werden.
    </div>
    <script>
      var ROLES = { read: 'Lesen', write: 'Schreiben', admin: 'Admin' };
      var pendingDelete = null;

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function msg(text, isErr) {
        var m = document.getElementById('msg');
        m.textContent = text || '';
        m.className = isErr ? 'err' : 'ok';
      }
      function busy(on) {
        Array.prototype.forEach.call(document.querySelectorAll('button, select'), function (el) { el.disabled = on; });
      }
      function call(fn, args, okText) {
        busy(true);
        var runner = google.script.run
          .withSuccessHandler(function (list) { busy(false); render(list); msg(okText || ''); })
          .withFailureHandler(function (e) { busy(false); msg(e.message, true); });
        runner[fn].apply(runner, args);
      }

      function render(list) {
        pendingDelete = null;
        var rows = document.getElementById('rows');
        if (!list.length) { rows.innerHTML = '<tr><td colspan="7">Noch keine Zugangscodes.</td></tr>'; return; }
        rows.innerHTML = list.map(function (c) {
          var role = c.team
            ? '<span class="badge">Mannschaft · Lesen</span>'
            : '<select data-id="' + c.id + '" class="role">' +
                ['read', 'write', 'admin'].map(function (r) {
                  return '<option value="' + r + '"' + (r === c.role ? ' selected' : '') + '>' + ROLES[r] + '</option>';
                }).join('') + '</select>';
          var status = c.blocked
            ? '<span class="badge blocked">gesperrt</span><div class="sub">seit ' + esc(c.blockedAt) + '</div>'
            : '<span class="badge active">aktiv</span>';
          var actions = c.team ? '' :
            (c.blocked
              ? '<button data-id="' + c.id + '" class="unblock">Entsperren</button> ' +
                '<button data-id="' + c.id + '" class="delete danger">Löschen</button>'
              : '<button data-id="' + c.id + '" class="block">Sperren</button>');
          return '<tr class="' + (c.blocked ? 'blocked' : '') + '">' +
            '<td><span class="name">' + esc(c.name) + '</span></td>' +
            '<td>' + role + '</td>' +
            '<td>' + status + '</td>' +
            '<td class="hint">' + esc(c.hint) + '</td>' +
            '<td>' + esc(c.created) + '</td>' +
            '<td>' + esc(c.lastUsed) + '</td>' +
            '<td class="actions">' + actions + '</td></tr>';
        }).join('');
      }

      document.getElementById('rows').addEventListener('change', function (e) {
        if (!e.target.classList.contains('role')) return;
        var name = e.target.closest('tr').querySelector('.name').textContent;
        call('menuUpdateCode', [e.target.dataset.id, { role: e.target.value }],
          '„' + name + '“ hat jetzt die Rolle ' + ROLES[e.target.value] + '.');
      });

      document.getElementById('rows').addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        var id = b.dataset.id;
        var name = b.closest('tr').querySelector('.name').textContent;
        if (b.classList.contains('block')) {
          call('menuUpdateCode', [id, { blocked: true }], '„' + name + '“ ist gesperrt.');
        } else if (b.classList.contains('unblock')) {
          call('menuUpdateCode', [id, { blocked: false }], '„' + name + '“ ist wieder freigegeben.');
        } else if (b.classList.contains('delete')) {
          if (pendingDelete !== id) {
            pendingDelete = id;
            b.textContent = 'Wirklich löschen?';
            b.className = 'delete confirm';
            return;
          }
          call('menuDeleteCode', [id], '„' + name + '“ wurde gelöscht.');
        }
      });

      document.getElementById('new').onclick = function () { google.script.run.createAccessCode(); };

      call('menuListCodes', []);
    </script>`).setWidth(860).setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, '🔑 Zugangscodes');
}

/** Früherer Menüpunkt „Rolle ändern…“ – führt jetzt in dieselbe Übersicht. */
function changeAccessCodeRole() {
  manageAccessCodes();
}

/** Für den Dialog: alle Codes ohne Hash, sortiert (Mannschaft, aktiv, gesperrt). */
function menuListCodes() {
  const store = loadCodeStore_();
  if (store == null) throw new Error('Bitte zuerst migrateCodesV2() ausführen.');
  const fmt = iso => (iso ? Utilities.formatDate(new Date(iso), CONFIG.TIMEZONE, 'dd.MM.yyyy HH:mm') : 'nie');

  return store
    .slice()
    .sort((a, b) => (b.team - a.team) || (!!a.blocked - !!b.blocked) || a.name.localeCompare(b.name, 'de'))
    .map(c => ({
      id: c.id,
      name: c.name,
      role: c.team ? 'read' : normalizeRole_(c.role),
      team: !!c.team,
      hint: prettyHint_(c.hint),
      blocked: !!c.blocked,
      blockedAt: c.blocked ? fmt(c.blocked) : '',
      created: fmt(c.created),
      lastUsed: fmt(c.lastUsed),
    }));
}

/** Für den Dialog: Rolle ändern oder sperren/entsperren. changes = { role } oder { blocked: true|false } */
function menuUpdateCode(id, changes) {
  withCodeStore_(list => {
    const entry = list.find(c => c.id === id);
    if (!entry) throw new Error('Diesen Code gibt es nicht mehr. Bitte die Übersicht neu öffnen.');
    if (entry.team) throw new Error('Der Mannschafts-Code kann hier nicht geändert werden.');

    const next = {};
    if (changes && changes.role !== undefined) {
      if (!ROLES[changes.role]) throw new Error('Unbekannte Rolle.');
      next.role = changes.role;
    }
    if (changes && changes.blocked !== undefined) {
      next.blocked = changes.blocked ? new Date().toISOString() : false;
    }
    updateCodeEntry_(list, entry, next);
  });
  return menuListCodes();
}

/** Für den Dialog: gesperrten Code endgültig entfernen. */
function menuDeleteCode(id) {
  withCodeStore_(list => {
    const idx = list.findIndex(c => c.id === id);
    if (idx === -1) throw new Error('Diesen Code gibt es nicht mehr. Bitte die Übersicht neu öffnen.');
    if (!list[idx].blocked) throw new Error('Nur gesperrte Codes können gelöscht werden. Bitte zuerst sperren.');
    list.splice(idx, 1);
  });
  return menuListCodes();
}

/** "K7QM…H2XP" → "K7QM-····-····-····-H2XP" (wie im Design, V2 Kapitel 8.9) */
function prettyHint_(hint) {
  const m = /^([A-Z0-9]{4})…([A-Z0-9]{4})$/.exec(hint || '');
  return m ? `${m[1]}-····-····-····-${m[2]}` : (hint || '');
}


/* =========================
   KATEGORIEN – gemeinsame Regeln (gespeichert werden sie in Kalender.gs)
   ========================= */

const RESERVED_COLORS = ['6', '8'];
const MAX_CATEGORY_NAME = 40;

/**
 * Plant in etwa einer Minute das Nachziehen im Kalender (Kategorie umbenannt oder
 * umgefärbt), damit die Anfrage selbst nicht hunderte Termine aktualisieren muss.
 */
function scheduleCalendarRefresh_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runScheduledRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runScheduledRefresh').timeBased().after(60 * 1000).create();
}

/** Wird vom einmaligen Trigger aufgerufen. */
function runScheduledRefresh() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runScheduledRefresh') ScriptApp.deleteTrigger(t);
  });
  v3RefreshCalendar_(); // betroffene Termine im Kalender neu schreiben
}

/* =========================
   VERWALTUNG: ZUGANGSCODES (V2, Kapitel 3 + 5.2)
   ========================= */

/** Liste ohne Hash. self = der Code dieser Anfrage. */
function listCodes_(user, extra) {
  const store = loadCodeStore_();
  if (store == null) throw new Error('Die Zugangscodes sind noch im alten Format. Bitte im Editor migrateCodesV2() ausführen.');
  const codes = store
    .slice()
    .sort((a, b) => (b.team - a.team) || (!!a.blocked - !!b.blocked) || a.name.localeCompare(b.name, 'de'))
    .map(c => ({
      id: c.id,
      name: c.name,
      role: c.team ? 'read' : normalizeRole_(c.role),
      team: !!c.team,
      hint: prettyHint_(c.hint),
      blocked: c.blocked || false,
      created: c.created || null,
      lastUsed: c.lastUsed || null,
      self: c.id === user.id,
    }));
  return Object.assign({ codes, codeCount: codes.length }, extra || {});
}

/** { name, role } → { code, link } nur in dieser Antwort */
function createCodeApi_(data, user) {
  const r = createCode_(data.name, data.role, false);
  return listCodes_(user, {
    message: `Zugangscode für „${r.entry.name}“ erstellt.`,
    code: formatCode_(r.code),
    link: r.link,
    created: { id: r.entry.id, name: r.entry.name, role: r.entry.role },
  });
}

/**
 * { id, name?, role?, blocked? } – ändern, sperren, entsperren.
 * Den eigenen Code kann man weder sperren noch herabstufen; der letzte Admin bleibt Admin.
 */
function updateCode_(data, user) {
  let message = 'Gespeichert.';
  withCodeStore_(store => {
    const entry = store.find(c => c.id === data.id);
    if (!entry) throw new Error('Diesen Code gibt es nicht mehr. Bitte neu laden.');

    const changes = {};
    if (data.name !== undefined) {
      const name = (data.name || '').toString().trim();
      if (!name) throw new Error('Bitte einen Namen eingeben.');
      if (name.length > WEBAPP.MAX_NAME_LENGTH) throw new Error(`Der Name ist zu lang (höchstens ${WEBAPP.MAX_NAME_LENGTH} Zeichen).`);
      if (!entry.team && store.some(c => c !== entry && !c.team && c.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Für „${name}“ gibt es schon einen Code.`);
      }
      changes.name = name;
    }
    if (data.role !== undefined) {
      if (!ROLES[data.role]) throw new Error('Unbekannte Rolle.');
      if (entry.team && data.role !== 'read') throw new Error('Der Mannschafts-Code hat immer die Rolle „Lesen“.');
      changes.role = data.role;
    }
    if (data.blocked !== undefined) {
      if (entry.team) throw new Error('Der Mannschafts-Code wird nicht gesperrt, sondern neu erzeugt.');
      changes.blocked = data.blocked ? new Date().toISOString() : false;
    }

    if (entry.id === user.id) {
      if (changes.blocked) throw new Error('Den eigenen Code kannst du nicht sperren.');
      if (changes.role && ROLES[changes.role].rank < ROLES[normalizeRole_(entry.role)].rank) {
        throw new Error('Den eigenen Code kannst du nicht herabstufen.');
      }
    }

    updateCodeEntry_(store, entry, changes);
    if (changes.blocked) message = `„${entry.name}“ ist gesperrt.`;
    else if (data.blocked === false) message = `„${entry.name}“ ist wieder freigegeben.`;
    else if (changes.role) message = `„${entry.name}“ hat jetzt die Rolle ${ROLES[entry.role].label}.`;
  });
  return listCodes_(user, { message });
}

/**
 * { id } – Code endgültig entfernen. Der eigene Code lässt sich nicht löschen,
 * der letzte aktive Admin auch nicht.
 */
function deleteCode_(data, user) {
  let name = '';
  withCodeStore_(store => {
    const idx = store.findIndex(c => c.id === data.id);
    if (idx === -1) throw new Error('Diesen Code gibt es nicht mehr. Bitte neu laden.');
    const entry = store[idx];
    if (entry.id === user.id) throw new Error('Den eigenen Code kannst du nicht löschen.');
    if (!entry.team && !entry.blocked && entry.role === 'admin' && activeAdmins_(store).length <= 1) {
      throw new Error('Das ist der letzte Admin-Code. Er kann nicht gelöscht werden.');
    }
    name = entry.name;
    store.splice(idx, 1);
  });
  return listCodes_(user, { message: `Zugangscode „${name}“ gelöscht.` });
}

/** Neuer Mannschafts-Code, der alte ist sofort ungültig. Legt einen an, falls es keinen gibt. */
function rotateTeamCode_(user) {
  const result = withCodeStore_(store => {
    let code;
    let hash;
    do {
      code = generateCode_();
      hash = hashCode_(code);
    } while (store.some(c => c.hash === hash));

    let entry = store.find(c => c.team);
    const isNew = !entry;
    if (isNew) {
      entry = { id: newCodeId_(), name: 'Mannschaft', role: 'read', team: true, blocked: false };
      store.push(entry);
    }
    Object.assign(entry, {
      hash,
      hint: codeHint_(code),
      role: 'read',
      blocked: false,
      created: new Date().toISOString(),
      lastUsed: null,
    });
    return { code, isNew };
  });

  return listCodes_(user, {
    message: result.isNew ? 'Mannschafts-Code erzeugt.' : 'Neuer Mannschafts-Code erzeugt. Der alte funktioniert nicht mehr.',
    code: formatCode_(result.code),
    link: codeLink_(result.code),
  });
}

/* =========================
   ABLAUF
   ========================= */

function withWebLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Gerade wird schon etwas gespeichert. Bitte in ein paar Sekunden nochmal versuchen.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   EINGABEN PRÜFEN
   ========================= */

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

  // Wiederholung (RRULE). Fehlt das Feld, bleibt eine vorhandene Wiederholung unverändert; '' entfernt sie.
  let recurrence;
  if (d.recurrence !== undefined && d.recurrence !== null) {
    const r = d.recurrence.toString().trim().replace(/^RRULE:/i, '').toUpperCase();
    if (r && (r.length > 300 || !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[-+,0-9A-Z]+)*$/.test(r))) {
      throw new Error('Die Wiederholung ist ungültig.');
    }
    recurrence = r ? `RRULE:${r}` : '';
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
    recurrence,
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
