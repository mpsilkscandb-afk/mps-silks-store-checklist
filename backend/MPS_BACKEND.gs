// ════════════════════════════════════════════════════════════════
//  MPS Silks Store Operations Checklist — Google Apps Script backend
//  File: MPS_BACKEND.gs   (IO layer — depends on mps-core.gs)
//
//  Deploy BOTH files in the same Apps Script project.
//  All deployment-specific values live in Script Properties:
//    SS_ID            (required) Google Sheets spreadsheet ID
//    PHOTO_FOLDER_ID  (required for photo tasks) Drive folder ID
//    SESSION_TTL_MIN  (optional) session lifetime, default 480 min
//    PIN_SALT         (optional) generated automatically on first run
//
//  ⚠ SECURITY MODEL
//  - Login exchanges a PIN for a random session token. The token is
//    stored server-side (CacheService) — PINs are never echoed back.
//  - PINs are stored in the sheet as salted SHA-256 values and are
//    migrated automatically when a legacy plain PIN is first used.
//  - Every admin action is authorised server-side from the session,
//    never from a value supplied by the browser.
//  - Uploaded photos stay PRIVATE in Drive and are only served
//    through the authenticated getPhoto action.
// ════════════════════════════════════════════════════════════════

// ── configuration ──────────────────────────────────────────────
function prop(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '' || v === undefined) ? def : v;
}
function requireProp(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing Script Property "' + key + '". See docs/DEPLOYMENT.md.');
  return v;
}
function pinSalt() {
  var sp = PropertiesService.getScriptProperties();
  var s = sp.getProperty('PIN_SALT');
  if (!s) {
    s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    sp.setProperty('PIN_SALT', s);
  }
  return s;
}
function sessionTtlSec() {
  var mins = parseInt(prop('SESSION_TTL_MIN', '480'), 10);
  if (isNaN(mins) || mins < 5) mins = 480;
  if (mins > 3000) mins = 3000; // CacheService hard cap is 216000 s
  return mins * 60;
}

// ── routing ────────────────────────────────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  var result;
  try {
    switch (str_(p.action)) {
      case 'me':           result = actionMe(p);            break;
      case 'getChecklist': result = actionGetChecklist(p);  break;
      case 'getDashboard': result = actionGetDashboard(p);  break;
      case 'getTasks':     result = actionGetTasks(p);      break;
      case 'getUsers':     result = actionGetUsers(p);      break;
      case 'getSettings':  result = actionGetSettings(p);   break;
      case 'getPhoto':     result = actionGetPhoto(p);      break;
      case 'getPhotos':    result = actionGetPhotos(p);     break;
      case 'health':       result = { ok: true, app: 'mps-silks-checklist', v: 1 }; break;
      default:             result = { ok: false, error: 'Unknown action.', code: 'BAD_ACTION' };
    }
  } catch (err) {
    result = serverError_(err);
  }
  return respond_(result);
}

function doPost(e) {
  var p = {};
  var result;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respond_({ ok: false, error: 'Malformed JSON body.', code: 'BAD_REQUEST' });
  }
  try {
    switch (str_(p.action)) {
      case 'login':          result = actionLogin(p);           break;
      case 'logout':         result = actionLogout(p);          break;
      case 'submitChecklist': result = actionSubmitChecklist(p); break;
      case 'uploadPhoto':    result = actionUploadPhoto(p);     break;
      case 'addTask':        result = admin_(p, actionAddTask);     break;
      case 'updateTask':     result = admin_(p, actionUpdateTask);  break;
      case 'toggleTask':     result = admin_(p, actionToggleTask);  break;
      case 'deleteTask':     result = admin_(p, actionDeleteTask);  break;
      case 'addUser':        result = admin_(p, actionAddUser);     break;
      case 'updateUser':     result = admin_(p, actionUpdateUser);  break;
      case 'updateSettings': result = admin_(p, actionUpdateSettings); break;
      default:               result = { ok: false, error: 'Unknown action.', code: 'BAD_ACTION' };
    }
  } catch (err) {
    result = serverError_(err);
  }
  return respond_(result);
}

function respond_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function serverError_(err) {
  // Never leak internals; log without user secrets.
  var msg = String((err && err.message) || err || 'Unknown error');
  console.error('MPS backend error: ' + msg);
  if (msg.indexOf('Missing Script Property') !== -1) {
    return { ok: false, error: msg, code: 'CONFIG' };
  }
  return { ok: false, error: 'Server error. Please try again.', code: 'SERVER' };
}

function str_(v) { return MPSCore.str(v); }

// ── sheet helpers ──────────────────────────────────────────────
var _ss = null;
function ss_() {
  if (!_ss) _ss = SpreadsheetApp.openById(requireProp('SS_ID'));
  return _ss;
}
function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('Required sheet "' + name + '" not found in the spreadsheet.');
  return s;
}
function readMatrix_(name) {
  var s = ss_().getSheetByName(name);
  if (!s || s.getLastRow() < 1) return { headers: [], rows: [] };
  var values = s.getDataRange().getValues();
  var headers = values[0].map(function (h) { return MPSCore.str(h); });
  return { headers: headers, rows: values.slice(1) };
}

// Read + normalize; short-TTL cache. Never use for auth-critical reads.
function cachedMatrix_(name, ttl, normalizer) {
  var gen = cacheGet_('gen:' + name) || '0';
  var key = 'cache:' + name + ':' + gen;
  var hit = cacheGet_(key);
  if (hit) return hit;
  var m = readMatrix_(name);
  var out = normalizer(m.headers, m.rows);
  cachePut_(key, out, ttl || 120);
  return out;
}
function invalidate_(name) {
  cachePut_('gen:' + name, String(Date.now()), 216000);
}

// ── cache / lock helpers ───────────────────────────────────────
function cacheGet_(key) {
  try {
    var v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
function cachePut_(key, data, ttl) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(data), ttl || 300);
  } catch (e) { /* cache is an optimisation only */ }
}
function cacheDel_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { ok: false, error: 'The server is busy. Please try again.', code: 'BUSY' };
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// ── time helpers (Asia/Kolkata everywhere) ─────────────────────
function nowIst_() {
  return Utilities.formatDate(new Date(), MPSCore.IST_TZ, 'yyyy-MM-dd HH:mm:ss');
}
function todayIst_() {
  return Utilities.formatDate(new Date(), MPSCore.IST_TZ, 'yyyy-MM-dd');
}

// ── sessions ───────────────────────────────────────────────────
// Token → { name, role, isAdmin, exp } in CacheService.
function createSession_(user) {
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  var ttl = sessionTtlSec();
  var sess = {
    name: user.name,
    role: user.role,
    isAdmin: !!user.isAdmin,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttl
  };
  cachePut_('sess:' + token, sess, ttl);
  return { token: token, ttlSec: ttl, session: sess };
}
function getSession_(p) {
  var token = str_((p && p.token) || '');
  if (!token) return null;
  var sess = cacheGet_('sess:' + token);
  if (!sess) return null;
  var now = Math.floor(Date.now() / 1000);
  if (sess.exp && sess.exp < now) { cacheDel_('sess:' + token); return null; }
  // Immediate revocation stamp (set when an admin deactivates a user).
  var rev = cacheGet_('rev:' + sess.name);
  if (rev && parseInt(rev, 10) > (sess.iat || 0)) { cacheDel_('sess:' + token); return null; }
  // Sliding expiry: re-put with full TTL, capped at the original exp.
  var ttl = Math.min(sessionTtlSec(), (sess.exp - now) + 60);
  cachePut_('sess:' + token, sess, ttl);
  return { token: token, sess: sess };
}
function destroySession_(token) {
  if (token) cacheDel_('sess:' + token);
}
// Confirm the session's user is still active (fast 60 s user cache —
// deactivating a user therefore revokes access within ~1 minute).
function sessionStillValid_(sess) {
  var users = loadUsers_(60);
  var u = users.find(function (x) { return x.name === sess.name; });
  return !!(u && u.active);
}

function requireSession_(p, needAdmin) {
  var s = getSession_(p);
  if (!s) return { error: 'Session expired. Please sign in again.', code: 'AUTH' };
  if (!sessionStillValid_(s.sess)) {
    destroySession_(s.token);
    return { error: 'Your account is inactive. Please contact the store admin.', code: 'AUTH' };
  }
  if (needAdmin && !s.sess.isAdmin) {
    return { error: 'Admin access required.', code: 'FORBIDDEN' };
  }
  return { s: s };
}
function admin_(p, fn) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  return fn(p, auth.s.sess);
}

// ── login (PIN → token, rate limited) ──────────────────────────
function actionLogin(p) {
  var pin = str_(p.pin);
  if (!MPSCore.validPin(pin)) {
    return { ok: false, error: 'Enter your 4–8 digit PIN.', code: 'BAD_PIN' };
  }
  return withLock_(function () {
    var now = Date.now();
    // Global limiter: ≥20 failures in the window blocks everything.
    var g = cacheGet_('rl:g') || { fails: 0, until: 0 };
    if (g.until > now) {
      return { ok: false, error: 'Too many failed attempts. Try again in a few minutes.', code: 'RATE' };
    }
    // Per-PIN limiter: ≥5 failures locks that PIN.
    var rlKey = 'rl:' + MPSCore.sha256Hex(pin).slice(0, 16);
    var rl = cacheGet_(rlKey) || { fails: 0, until: 0 };
    if (rl.until > now) {
      return { ok: false, error: 'Too many failed attempts for this PIN. Try again in a few minutes.', code: 'RATE' };
    }

    var users = loadUsers_(60);
    var match = null;
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (!u.pin) continue;
      if (MPSCore.verifyPin(u.pin, pin, pinSalt())) { match = u; break; }
    }
    if (!match || !match.active) {
      rl.fails++; g.fails++;
      var lockMins = rl.fails >= 5 ? 5 : 0;
      cachePut_(rlKey, { fails: rl.fails, until: lockMins ? now + lockMins * 60000 : 0 }, 900);
      cachePut_('rl:g', { fails: g.fails, until: g.fails >= 20 ? now + 5 * 60000 : 0 }, 900);
      // Same generic message whether the PIN or the account is wrong.
      return { ok: false, error: 'Invalid PIN. Please try again.', code: 'BAD_PIN' };
    }
    // Progressive migration: store plain legacy PIN as salted hash.
    if (MPSCore.needsPinMigration(match.pin)) {
      try { migratePin_(match); } catch (e) { console.error('PIN migration failed: ' + e.message); }
      loadUsers_(0, true);
    }
    cacheDel_(rlKey);
    var created = createSession_(match);
    return {
      ok: true,
      token: created.token,
      name: match.name,
      role: match.role,
      isAdmin: created.session.isAdmin,
      expiresInMin: Math.round(created.ttlSec / 60)
    };
  });
}

function actionLogout(p) {
  var s = getSession_(p);
  if (s) destroySession_(s.token);
  return { ok: true };
}

function actionMe(p) {
  var auth = requireSession_(p, false);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  return {
    ok: true,
    name: auth.s.sess.name,
    role: auth.s.sess.role,
    isAdmin: auth.s.sess.isAdmin
  };
}

// ── users ──────────────────────────────────────────────────────
function loadUsers_(ttl, force) {
  if (force) invalidate_('Users');
  return cachedMatrix_('Users', ttl || 60, function (headers, rows) {
    return MPSCore.normalizeUsers(headers, rows).users;
  });
}
function migratePin_(user) {
  var sheet = sheet_('Users');
  var m = readMatrix_('Users');
  var col = MPSCore.mapColumns(m.headers, 'user');
  if (col.name === undefined || col.pin === undefined) return;
  for (var i = 0; i < m.rows.length; i++) {
    if (MPSCore.str(m.rows[i][col.name]) === user.name) {
      sheet.getRange(i + 2, col.pin + 1).setValue(MPSCore.hashPin(user.pin, pinSalt()));
      invalidate_('Users');
      return;
    }
  }
}

function actionGetUsers(p) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var users = loadUsers_(0, true).map(function (u) {
    return { name: u.name, role: u.role, active: u.active, pinSet: !!u.pin, isAdmin: u.isAdmin };
  });
  return { ok: true, users: users };
}

function actionAddUser(p, sess) {
  var name = MPSCore.cleanText(p.name, 60);
  var pin = MPSCore.str(p.pin);
  var role = MPSCore.cleanText(p.role, 40) || 'Staff';
  var active = MPSCore.normYesNo(p.active, 'Yes');
  if (!name) return { ok: false, error: 'Name is required.', code: 'VALIDATION' };
  if (!MPSCore.validPin(pin)) return { ok: false, error: 'PIN must be 4–8 digits.', code: 'VALIDATION' };
  return withLock_(function () {
    var users = loadUsers_(0, true);
    if (users.some(function (u) { return u.name.toLowerCase() === name.toLowerCase(); })) {
      return { ok: false, error: 'A staff member with that name already exists.', code: 'VALIDATION' };
    }
    if (users.some(function (u) { return u.pin && MPSCore.verifyPin(u.pin, pin, pinSalt()); })) {
      return { ok: false, error: 'That PIN is already in use. Choose a different one.', code: 'VALIDATION' };
    }
    ensureHeaders_('Users', ['Name', 'PIN', 'Role', 'Active']);
    sheet_('Users').appendRow([name, MPSCore.hashPin(pin, pinSalt()), role, active]);
    invalidate_('Users');
    return { ok: true, message: 'Staff member added.' };
  });
}

function actionUpdateUser(p, sess) {
  var name = MPSCore.str(p.name);
  if (!name) return { ok: false, error: 'Name is required.', code: 'VALIDATION' };
  var newPin = MPSCore.str(p.newPin);
  if (newPin && !MPSCore.validPin(newPin)) {
    return { ok: false, error: 'PIN must be 4–8 digits.', code: 'VALIDATION' };
  }
  return withLock_(function () {
    var users = loadUsers_(0, true);
    var target = users.find(function (u) { return u.name === name; });
    if (!target) return { ok: false, error: 'Staff member not found.', code: 'VALIDATION' };

    // Guard: an admin cannot lock out the last active admin.
    var removingAdmin = target.isAdmin &&
      (MPSCore.normYesNo(p.active, target.active ? 'Yes' : 'No') === 'No' ||
       (p.role && !MPSCore.isAdminRole(p.role)));
    if (removingAdmin) {
      var activeAdmins = users.filter(function (u) { return u.isAdmin && u.active && u.name !== name; });
      if (!activeAdmins.length) {
        return { ok: false, error: 'This is the last active admin — promote another admin first.', code: 'VALIDATION' };
      }
    }
    if (newPin && users.some(function (u) { return u.name !== name && u.pin && MPSCore.verifyPin(u.pin, newPin, pinSalt()); })) {
      return { ok: false, error: 'That PIN is already in use. Choose a different one.', code: 'VALIDATION' };
    }

    var sheet = sheet_('Users');
    var m = readMatrix_('Users');
    var col = MPSCore.mapColumns(m.headers, 'user');
    ensureHeaders_('Users', ['Name', 'PIN', 'Role', 'Active']);
    m = readMatrix_('Users');
    col = MPSCore.mapColumns(m.headers, 'user');
    for (var i = 0; i < m.rows.length; i++) {
      if (MPSCore.str(m.rows[i][col.name]) !== name) continue;
      if (newPin) sheet.getRange(i + 2, col.pin + 1).setValue(MPSCore.hashPin(newPin, pinSalt()));
      if (p.role !== undefined && col.role !== undefined) {
        sheet.getRange(i + 2, col.role + 1).setValue(MPSCore.cleanText(p.role, 40) || 'Staff');
      }
      if (p.active !== undefined && col.active !== undefined) {
        sheet.getRange(i + 2, col.active + 1).setValue(MPSCore.normYesNo(p.active, 'Yes'));
      }
      invalidate_('Users');
      // Revoke the user's current sessions immediately on deactivation.
      if (MPSCore.normYesNo(p.active, 'Yes') === 'No') revokeUserSessions_(name);
      return { ok: true, message: 'Staff member updated.' };
    }
    return { ok: false, error: 'Staff member not found.', code: 'VALIDATION' };
  });
}
function revokeUserSessions_(name) {
  // Best-effort: sessions live in a shared cache we cannot enumerate,
  // so we bump a per-user revocation stamp checked on each request.
  cachePut_('rev:' + name, String(Date.now()), 21600);
}

// ── settings ───────────────────────────────────────────────────
function actionGetSettings(p) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  return { ok: true, settings: loadSettings_() };
}
function loadSettings_(ttl) {
  return cachedMatrix_('Settings', ttl || 300, function (headers, rows) {
    var col = MPSCore.mapColumns(headers, 'settings');
    var out = {};
    if (col.key === undefined || col.value === undefined) return out;
    rows.forEach(function (r) {
      var k = MPSCore.str(r[col.key]);
      if (k) out[k] = MPSCore.str(r[col.value]);
    });
    return out;
  });
}
function actionUpdateSettings(p, sess) {
  var updates = p.settings || {};
  return withLock_(function () {
    var sheet = sheet_('Settings');
    var m = readMatrix_('Settings');
    if (!m.headers.length) {
      sheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
      m = { headers: ['Key', 'Value'], rows: [] };
    }
    var remaining = {};
    Object.keys(updates).forEach(function (k) { remaining[MPSCore.cleanText(k, 60)] = MPSCore.cleanText(updates[k], 200); });
    for (var i = 0; i < m.rows.length; i++) {
      var key = MPSCore.str(m.rows[i][0]);
      if (remaining[key] !== undefined) {
        sheet.getRange(i + 2, 2).setValue(remaining[key]);
        delete remaining[key];
      }
    }
    Object.keys(remaining).forEach(function (k) {
      if (k) sheet.appendRow([k, remaining[k]]);
    });
    invalidate_('Settings');
    return { ok: true, message: 'Settings saved.' };
  });
}

// ── tasks ──────────────────────────────────────────────────────
function loadTasks_(ttl) {
  return cachedMatrix_('Checklist_Config', ttl || 120, function (headers, rows) {
    var res = MPSCore.normalizeTasks(headers, rows);
    if (res.problems.length) console.warn('Checklist mapping problems: ' + JSON.stringify(res.problems));
    return res;
  });
}

function actionGetTasks(p) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var res = loadTasks_(0, true);
  return {
    ok: true,
    tasks: res.tasks.map(publicTask_),
    problems: res.problems
  };
}
function publicTask_(t) {
  return {
    taskId: t.taskId,
    section: t.section,
    taskName: t.taskName,
    type: t.type,
    mandatory: t.mandatory,
    photoRequired: t.photoRequired,
    active: t.active,
    assignedTo: t.assignedTo,
    frequency: t.frequency || 'daily'
  };
}

function actionGetChecklist(p) {
  var auth = requireSession_(p, false);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var sess = auth.s.sess;
  var today = todayIst_();
  var res = loadTasks_(120);
  var mine = MPSCore.tasksForUser(res.tasks, sess.name, sess.role, today);
  var subs = readTodaySubmissions_(today);
  var latest = MPSCore.latestForDay(subs, today);
  var sections = MPSCore.sectionsFor(mine).map(function (s) {
    return {
      section: s.section,
      tasks: s.tasks.map(function (t) {
        var sub = latest[t.taskId] || null;
        return {
          taskId: t.taskId,
          taskName: t.taskName,
          type: t.type,
          mandatory: t.mandatory,
          photoRequired: t.photoRequired,
          submitted: !!sub,
          submittedStatus: sub ? {
            response: sub.response,
            status: sub.status,
            staffName: sub.staffName,
            timestamp: sub.timestamp,
            remarks: sub.remarks,
            photoRef: sub.photoRef,
            photoTime: sub.photoTime,
            sequence: sub.sequence,
            isMine: sub.staffName === sess.name
          } : null
        };
      })
    };
  });
  var settings = loadSettings_(300);
  return {
    ok: true,
    date: today,
    name: sess.name,
    role: sess.role,
    store: {
      name: settings.Store_Name || 'MPS Silks',
      location: settings.Store_Location || ''
    },
    sections: sections
  };
}

function readTodaySubmissions_(today) {
  var m = readMatrix_('Submissions');
  return MPSCore.normalizeSubmissions(m.headers, m.rows).filter(function (s) {
    return s.date === today;
  });
}

// ── task administration (sheet edits, lock-protected) ──────────
function taskRowLoc_(taskId) {
  var m = readMatrix_('Checklist_Config');
  var col = MPSCore.mapColumns(m.headers, 'task');
  if (col.taskId === undefined) return null;
  for (var i = 0; i < m.rows.length; i++) {
    if (MPSCore.str(m.rows[i][col.taskId]) === taskId) return { row: i + 2, col: col, m: m };
  }
  return null;
}

// Validate a partial task payload → { ok, fields } (only provided fields).
function readTaskPayload_(p) {
  var fields = {};
  if (p.section !== undefined) {
    var section = MPSCore.cleanText(p.section, 60);
    if (!section) return { ok: false, error: 'Section name is required.', code: 'VALIDATION' };
    fields.section = section;
  }
  if (p.taskName !== undefined) {
    var taskName = MPSCore.cleanText(p.taskName, 160);
    if (!taskName) return { ok: false, error: 'Task name is required.', code: 'VALIDATION' };
    fields.taskName = taskName;
  }
  if (p.type !== undefined) {
    var type = MPSCore.normType(p.type);
    if (!type) {
      return { ok: false, error: 'Type must be one of: ' + MPSCore.VALID_TYPES.join(', ') + '.', code: 'VALIDATION' };
    }
    fields.type = type;
  }
  var flags = ['mandatory', 'photoRequired', 'active'];
  for (var i = 0; i < flags.length; i++) {
    if (p[flags[i]] !== undefined) fields[flags[i]] = MPSCore.normYesNo(p[flags[i]], 'Yes');
  }
  if (p.assignedTo !== undefined) fields.assignedTo = MPSCore.cleanText(p.assignedTo, 200);
  if (p.frequency !== undefined) {
    var freq = MPSCore.normFrequency(p.frequency);
    if (!freq) return { ok: false, error: 'Frequency must be Daily, Weekly or Monthly.', code: 'VALIDATION' };
    fields.frequency = freq.charAt(0).toUpperCase() + freq.slice(1);
  }
  return { ok: true, fields: fields };
}

function nextTaskId_(m, col) {
  var max = 0;
  for (var i = 0; i < m.rows.length; i++) {
    var id = MPSCore.str(m.rows[i][col.taskId]);
    var mm = /^T(\d+)$/i.exec(id);
    if (mm) max = Math.max(max, parseInt(mm[1], 10));
  }
  var next = String(max + 1);
  while (next.length < 3) next = '0' + next;
  return 'T' + next;
}

function actionAddTask(p, sess) {
  var f = readTaskPayload_(p);
  if (!f.ok) return { ok: false, error: f.error, code: f.code };
  var fields = f.fields;
  if (!fields.section || !fields.taskName) {
    return { ok: false, error: 'Section and task name are required.', code: 'VALIDATION' };
  }
  return withLock_(function () {
    var m = readMatrix_('Checklist_Config');
    var col = MPSCore.mapColumns(m.headers, 'task');
    if (col.taskId === undefined || col.section === undefined || col.taskName === undefined) {
      return {
        ok: false,
        error: 'Checklist_Config sheet is missing required headers (Task_ID, Section, Task_Name). See docs/DEPLOYMENT.md.',
        code: 'CONFIG'
      };
    }
    if (fields.assignedTo !== undefined && col.assignedTo === undefined) {
      ensureHeaders_('Checklist_Config', ['Assigned_To']);
      m = readMatrix_('Checklist_Config');
      col = MPSCore.mapColumns(m.headers, 'task');
    }
    if (fields.frequency !== undefined && col.frequency === undefined) {
      ensureHeaders_('Checklist_Config', ['Frequency']);
      m = readMatrix_('Checklist_Config');
      col = MPSCore.mapColumns(m.headers, 'task');
    }
    var taskId = nextTaskId_(m, col);
    var width = m.headers.length;
    Object.keys(col).forEach(function (k) { width = Math.max(width, col[k] + 1); });
    var row = new Array(width).fill('');
    row[col.taskId] = taskId;
    row[col.section] = fields.section;
    row[col.taskName] = fields.taskName;
    row[col.type] = fields.type || 'yesno';
    if (col.mandatory !== undefined) row[col.mandatory] = fields.mandatory || 'Yes';
    if (col.photoRequired !== undefined) row[col.photoRequired] = fields.photoRequired || 'No';
    if (col.active !== undefined) row[col.active] = fields.active || 'Yes';
    if (col.assignedTo !== undefined) row[col.assignedTo] = fields.assignedTo || '';
    if (col.frequency !== undefined) row[col.frequency] = fields.frequency || 'Daily';
    sheet_('Checklist_Config').appendRow(row);
    invalidate_('Checklist_Config');
    return { ok: true, message: 'Task added.', taskId: taskId };
  });
}

function actionUpdateTask(p, sess) {
  var taskId = MPSCore.cleanText(p.taskId, 20);
  if (!taskId) return { ok: false, error: 'Task ID is required.', code: 'VALIDATION' };
  var f = readTaskPayload_(p);
  if (!f.ok) return { ok: false, error: f.error, code: f.code };
  var fields = f.fields;
  if (!Object.keys(fields).length) return { ok: false, error: 'Nothing to update.', code: 'VALIDATION' };
  return withLock_(function () {
    var loc = taskRowLoc_(taskId);
    if (!loc) return { ok: false, error: 'Task ' + taskId + ' not found.', code: 'NOT_FOUND' };
    if (fields.assignedTo !== undefined && loc.col.assignedTo === undefined) {
      ensureHeaders_('Checklist_Config', ['Assigned_To']);
      loc = taskRowLoc_(taskId);
    }
    if (fields.frequency !== undefined && loc.col.frequency === undefined) {
      ensureHeaders_('Checklist_Config', ['Frequency']);
      loc = taskRowLoc_(taskId);
    }
    var sheet = sheet_('Checklist_Config');
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (loc.col[k] === undefined) {
        return { ok: false, error: 'Checklist_Config is missing the header for "' + k + '". See docs/DEPLOYMENT.md.', code: 'CONFIG' };
      }
      sheet.getRange(loc.row, loc.col[k] + 1).setValue(fields[k]);
    }
    invalidate_('Checklist_Config');
    return { ok: true, message: 'Task updated.', taskId: taskId };
  });
}

function actionToggleTask(p, sess) {
  var taskId = MPSCore.cleanText(p.taskId, 20);
  if (!taskId) return { ok: false, error: 'Task ID is required.', code: 'VALIDATION' };
  return withLock_(function () {
    var loc = taskRowLoc_(taskId);
    if (!loc) return { ok: false, error: 'Task ' + taskId + ' not found.', code: 'NOT_FOUND' };
    if (loc.col.active === undefined) {
      ensureHeaders_('Checklist_Config', ['Active']);
      loc = taskRowLoc_(taskId);
    }
    if (loc.col.active === undefined) {
      return { ok: false, error: 'Checklist_Config is missing the Active header. See docs/DEPLOYMENT.md.', code: 'CONFIG' };
    }
    var cur = MPSCore.normYesNo(loc.m.rows[loc.row - 2][loc.col.active], 'Yes');
    var next = cur === 'Yes' ? 'No' : 'Yes';
    sheet_('Checklist_Config').getRange(loc.row, loc.col.active + 1).setValue(next);
    invalidate_('Checklist_Config');
    return { ok: true, message: 'Task ' + (next === 'Yes' ? 'activated' : 'deactivated') + '.', taskId: taskId, active: next };
  });
}

function actionDeleteTask(p, sess) {
  var taskId = MPSCore.cleanText(p.taskId, 20);
  if (!taskId) return { ok: false, error: 'Task ID is required.', code: 'VALIDATION' };
  return withLock_(function () {
    var loc = taskRowLoc_(taskId);
    if (!loc) return { ok: false, error: 'Task ' + taskId + ' not found.', code: 'NOT_FOUND' };
    // Never destroy history: a task with submissions must be deactivated, not deleted.
    var sm = readMatrix_('Submissions');
    var scol = MPSCore.mapColumns(sm.headers, 'sub');
    if (scol.taskId !== undefined) {
      for (var i = 0; i < sm.rows.length; i++) {
        if (MPSCore.str(sm.rows[i][scol.taskId]) === taskId) {
          return {
            ok: false,
            error: 'Task ' + taskId + ' has submission history — deactivate it instead of deleting.',
            code: 'VALIDATION'
          };
        }
      }
    }
    sheet_('Checklist_Config').deleteRow(loc.row);
    invalidate_('Checklist_Config');
    return { ok: true, message: 'Task deleted.', taskId: taskId };
  });
}

// ── submissions ────────────────────────────────────────────────
function actionSubmitChecklist(p, fromGet) {
  var auth = requireSession_(p, false);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var sess = auth.s.sess;
  var today = todayIst_();
  var ts = nowIst_();
  var entries = p.entries;
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); } catch (e) { entries = null; }
  }
  var taskRes = loadTasks_(120);
  var taskMap = {};
  taskRes.tasks.forEach(function (t) { taskMap[t.taskId] = t; });
  // Staff may only submit tasks assigned to them, and only on the day they are due
  // (weekly = Friday, monthly = the 28th).
  var assignedAll = {};
  MPSCore.tasksForUser(taskRes.tasks, sess.name, sess.role).forEach(function (t) { assignedAll[t.taskId] = true; });
  var allowed = {};
  MPSCore.tasksForUser(taskRes.tasks, sess.name, sess.role, today).forEach(function (t) { allowed[t.taskId] = true; });
  if (entries && entries.length) {
    entries.forEach(function (e) {
      var eid = e ? MPSCore.str(e.taskId) : '';
      if (e && !allowed[eid]) {
        if (assignedAll[eid]) e._notDue = true; else e._forbidden = true;
      }
    });
  }
  var v = MPSCore.validateEntries(entries, taskMap);
  if (!v.ok) return { ok: false, error: v.errors[0], errors: v.errors, code: 'VALIDATION' };
  var notDue = (entries || []).filter(function (e) { return e && e._notDue; });
  if (notDue.length) {
    return { ok: false, error: 'Task ' + MPSCore.str(notDue[0].taskId) + ' is not due today.', code: 'NOT_DUE' };
  }
  var forbidden = (entries || []).filter(function (e) { return e && e._forbidden; });
  if (forbidden.length) {
    return { ok: false, error: 'Task ' + MPSCore.str(forbidden[0].taskId) + ' is not assigned to you.', code: 'FORBIDDEN' };
  }

  var batchId = MPSCore.str(p.batchId) || Utilities.getUuid();

  return withLock_(function () {
    // Idempotency: a retried batch must not double-write.
    var m = readMatrix_('Submissions');
    var existing = MPSCore.normalizeSubmissions(m.headers, m.rows);
    if (batchId && existing.some(function (s) { return s.submissionId === batchId && s.date === today; })) {
      return { ok: true, duplicate: true, message: 'This checklist was already submitted.' };
    }
    var todayIds = {};
    existing.forEach(function (s) { if (s.date === today && s.taskId) todayIds[s.taskId] = true; });

    var sheet = sheet_('Submissions');
    ensureHeaders_('Submissions', SUB_HEADERS_);
    var col = MPSCore.mapColumns(readMatrix_('Submissions').headers, 'sub');
    // Timestamp and Photo_Time must stay PLAIN TEXT (number format "@") — for
    // NEW sheets and for EXISTING ones. Sheets otherwise converts a lone
    // "2026-10-26 14:03:11" into a Date object, which reads back as
    // "Mon Oct 26 2026 14:03:11 GMT+0530 …" and shows up as garbage in the UI.
    // Runs inside the same lock as the write and is a no-op when already set.
    forceTextColumns_(sheet, [col.timestamp, col.photoTime]);

    var rows = v.clean.map(function (c) {
      var row = new Array(SUB_HEADERS_.length).fill('');
      row[col.timestamp !== undefined ? col.timestamp : 0] = String(ts);
      row[col.date !== undefined ? col.date : 1] = today;
      row[col.staffName !== undefined ? col.staffName : 2] = sess.name;
      row[col.role !== undefined ? col.role : 3] = sess.role;
      row[col.section !== undefined ? col.section : 4] = c.section;
      row[col.taskId !== undefined ? col.taskId : 5] = c.taskId;
      row[col.taskName !== undefined ? col.taskName : 6] = c.taskName;
      row[col.type !== undefined ? col.type : 7] = c.type;
      row[col.response !== undefined ? col.response : 8] = c.response;
      row[col.photoUrl !== undefined ? col.photoUrl : 9] = c.photoRef;
      row[col.status !== undefined ? col.status : 10] = c.status;
      row[col.remarks !== undefined ? col.remarks : 11] = c.remarks;
      row[col.sequence !== undefined ? col.sequence : 12] = todayIds[c.taskId] ? 'Update' : 'First';
      row[col.updateReason !== undefined ? col.updateReason : 13] = c.updateReason;
      row[col.submissionId !== undefined ? col.submissionId : 14] = batchId;
      row[col.photoTime !== undefined ? col.photoTime : 15] = String(c.photoTime || '');
      return row;
    });
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SUB_HEADERS_.length).setValues(rows);
    }
    invalidate_('Submissions');
    return {
      ok: true,
      message: 'Checklist submitted.',
      saved: v.clean.map(function (c) {
        return { taskId: c.taskId, status: c.status, sequence: todayIds[c.taskId] ? 'Update' : 'First' };
      }),
      timestamp: ts,
      date: today
    };
  });
}

var SUB_HEADERS_ = ['Timestamp', 'Date', 'Staff_Name', 'Role', 'Section', 'Task_ID', 'Task_Name',
  'Type', 'Response', 'Photo_URL', 'Status', 'Remarks', 'Sequence', 'Override_Reason', 'Submission_ID', 'Photo_Time'];

function ensureHeaders_(sheetName, wanted) {
  var sheet = sheet_(sheetName);
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getMaxColumns(), wanted.length)).getValues()[0]
    .map(function (h) { return MPSCore.str(h); });
  var next = existing.slice();
  var lastUsed = 0;
  existing.forEach(function (h, i) { if (h) lastUsed = i + 1; });
  var changed = false;
  wanted.forEach(function (h) {
    var norms = existing.map(MPSCore.normHeader);
    if (norms.indexOf(MPSCore.normHeader(h)) === -1) {
      next[lastUsed] = h;
      lastUsed++;
      changed = true;
    }
  });
  if (changed) sheet.getRange(1, 1, 1, next.length).setValues([next]);
}

// Force whole columns to the plain-text number format "@" so Sheets never
// re-interprets written strings as dates/numbers. Takes 0-based column
// indexes; missing indexes are skipped. Idempotent: the format is only
// written when the column is not already text, so it is cheap on every run.
function forceTextColumns_(sheet, idxs) {
  (idxs || []).forEach(function (idx) {
    if (idx === undefined || idx === null || idx < 0) return;
    try {
      var range = sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1);
      if (range.getNumberFormat() === '@') return;
      range.setNumberFormat('@');
    } catch (e) {
      // Non-fatal: the values are still written as strings; log without secrets.
      console.error('Could not set text format on column ' + (idx + 1) + ': ' + e.message);
    }
  });
}

// ── photos ─────────────────────────────────────────────────────
var PHOTO_MIME_OK_ = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.jpg' };
var PHOTO_MAX_BYTES_ = 3 * 1024 * 1024; // decoded image bytes

function actionUploadPhoto(p) {
  var auth = requireSession_(p, false);
  if (auth.error) return { ok: false, error: auth.error, code: 'AUTH' };
  var sess = auth.s.sess;
  var data = str_(p.photoBase64);
  var m = /^data:([a-z\/+.-]+);base64,(.+)$/i.exec(data);
  if (!m) return { ok: false, error: 'Invalid photo data.', code: 'VALIDATION' };
  var mime = m[1].toLowerCase();
  if (!PHOTO_MIME_OK_[mime]) return { ok: false, error: 'Only JPEG, PNG or WebP photos are allowed.', code: 'VALIDATION' };
  var bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) {
    return { ok: false, error: 'Photo could not be decoded.', code: 'VALIDATION' };
  }
  if (bytes.length > PHOTO_MAX_BYTES_) {
    return { ok: false, error: 'Photo is too large (max 3 MB). It is resized on the phone before upload — please retake.', code: 'VALIDATION' };
  }
  var folderId = prop('PHOTO_FOLDER_ID', '');
  if (!folderId) return { ok: false, error: 'Photo storage is not configured on the server.', code: 'CONFIG' };

  var today = todayIst_();
  var ts = nowIst_();
  var uuid = Utilities.getUuid();
  var filename = 'mps_' + today + '_' + sess.name.replace(/[^A-Za-z0-9]/g, '') + '_' + MPSCore.cleanText(p.taskId, 20) + '_' + uuid.slice(0, 8) + PHOTO_MIME_OK_[mime];
  try {
    var folder = DriveApp.getFolderById(folderId);
    var blob = Utilities.newBlob(bytes, mime, filename);
    var file = folder.createFile(blob);
    // Keep photos PRIVATE — no public sharing. Access only via getPhoto.
    file.setDescription(JSON.stringify({ staff: sess.name, taskId: MPSCore.str(p.taskId), date: today,
      takenAt: MPSCore.cleanPhotoTime(p.photoTime, Date.now()), uploadedAt: ts }));
    var fileId = file.getId();
    return { ok: true, photoId: fileId, name: filename };
  } catch (err) {
    console.error('Drive upload failed: ' + err.message);
    return { ok: false, error: 'Photo upload failed. Please try again.', code: 'STORAGE' };
  }
}

function actionGetPhoto(p) {
  var auth = requireSession_(p, false);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code || 'AUTH' };
  var sess = auth.s.sess;
  var fileId = str_(p.fileId);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return { ok: false, error: 'Invalid photo reference.', code: 'VALIDATION' };
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    return { ok: false, error: 'Photo not found.', code: 'NOT_FOUND' };
  }
  if (!sess.isAdmin) {
    var meta = {};
    try { meta = JSON.parse(file.getDescription() || '{}'); } catch (e2) {}
    if (meta.staff !== sess.name) return { ok: false, error: 'Access denied.', code: 'FORBIDDEN' };
  }
  // ContentService cannot serve binary files, so return the photo as a base64 data URL in JSON.
  var blob = file.getBlob();
  var mime = String(blob.getContentType() || 'image/jpeg').toLowerCase();
  if (mime.indexOf('image/') !== 0) return { ok: false, error: 'Not a photo.', code: 'VALIDATION' };
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// Admin photo gallery: every photo in a date range (default: last 7 days).
function actionGetPhotos(p) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var today = todayIst_();
  var dateTo = MPSCore.normDateCell(p.dateTo) || today;
  var dateFrom = MPSCore.normDateCell(p.dateFrom) || MPSCore.addDays(dateTo, -6);
  if (dateFrom > dateTo) { var tmp = dateFrom; dateFrom = dateTo; dateTo = tmp; }
  var days = MPSCore.dayRange(dateFrom, dateTo, 92);
  if (!days.length) return { ok: false, error: 'Invalid date range.', code: 'VALIDATION' };
  dateFrom = days[0]; dateTo = days[days.length - 1];
  var m = readMatrix_('Submissions');
  var subs = MPSCore.normalizeSubmissions(m.headers, m.rows);
  // Optional section filter (admin Photos tab); '' = every section.
  var section = MPSCore.str(p.section);
  var res = MPSCore.listPhotos(subs, dateFrom, dateTo, 200, section);
  return { ok: true, dateFrom: dateFrom, dateTo: dateTo, section: section, total: res.total, truncated: res.truncated, photos: res.photos };
}

// ── dashboard ──────────────────────────────────────────────────
function actionGetDashboard(p) {
  var auth = requireSession_(p, true);
  if (auth.error) return { ok: false, error: auth.error, code: auth.code };
  var today = todayIst_();
  var dateTo = MPSCore.normDateCell(p.dateTo) || today;
  var dateFrom = MPSCore.normDateCell(p.dateFrom) || dateTo;
  if (dateFrom > dateTo) { var tmp = dateFrom; dateFrom = dateTo; dateTo = tmp; }
  var days = MPSCore.dayRange(dateFrom, dateTo, 92);
  if (!days.length) return { ok: false, error: 'Invalid date range.', code: 'VALIDATION' };
  dateFrom = days[0]; dateTo = days[days.length - 1];

  var taskRes = loadTasks_(120);
  var gen = cacheGet_('gen:Submissions') || '0';
  var cacheKey = 'dash:' + gen + ':' + dateFrom + ':' + dateTo;
  var hit = cacheGet_(cacheKey);
  var subs;
  if (hit) {
    subs = hit;
  } else {
    var m = readMatrix_('Submissions');
    subs = MPSCore.normalizeSubmissions(m.headers, m.rows).filter(function (s) {
      return s.date && s.date >= dateFrom && s.date <= dateTo;
    });
    cachePut_(cacheKey, subs, 30);
  }
  var dash = MPSCore.computeDashboard(taskRes.tasks, subs, dateFrom, dateTo, today);
  if (!dash) return { ok: false, error: 'Invalid date range.', code: 'VALIDATION' };
  dash.mappingProblems = taskRes.problems;
  dash.storeName = (loadSettings_(300).Store_Name || 'MPS Silks');
  return { ok: true, dashboard: dash };
}
