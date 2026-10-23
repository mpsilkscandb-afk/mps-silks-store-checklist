// Static page checks: branding, security hygiene, asset wiring.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'checklist.html', 'dashboard.html', 'admin.html'];

function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

test('all four pages exist', () => {
  PAGES.forEach((p) => assert.ok(fs.existsSync(path.join(ROOT, p)), p + ' missing'));
});

test('no BSC branding, endpoints, credentials or data references anywhere in the app', () => {
  const banned = [
    // brand words
    /bsc/i, /bsctextiles/i, /workers\.dev/i, /C&\s?B/i, /Niranthar/i, /BSCCANDB/i,
    // shape-based patterns only (no real IDs live in this repository);
    // crafted so our own placeholders (<SHEET_ID>, __MPS_API_ENDPOINT__)
    // and example URLs cannot match:
    /\b1[A-Za-z0-9_-]{43}\b/i,                            // Google spreadsheet-ID shape (44 chars)
    /drive\.google\.com\/folders\/[A-Za-z0-9_-]{20,}/i,   // Drive folder URL shape
    /\bAKfycb[A-Za-z0-9_-]{20,}/i                         // Apps Script deployment-ID shape
  ];
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir)) {
      const full = path.join(dir, e);
      if (fs.statSync(full).isDirectory()) {
        // tests/docs/sheets may legitimately mention BSC as assertions/reference
        if (['node_modules', 'dist', '.git', 'docs', 'sheets', 'tests'].includes(e)) continue;
        out.push(...walk(full));
      } else if (/\.(html|js|gs|css|json|yml)$/.test(e)) out.push(full);
    }
    return out;
  };
  const offenders = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    banned.forEach((re) => {
      if (re.test(src)) offenders.push(path.relative(ROOT, file) + ' → ' + re);
    });
  }
  assert.deepStrictEqual(offenders, [],
    'BSC leftovers found:\n' + offenders.join('\n'));
});

test('branding: every page is titled MPS Silks, loads the theme and the logo', () => {
  PAGES.forEach((p) => {
    const src = read(p);
    assert.match(src, /<title>[^<]*MPS Silks/i, p + ' title');
    assert.match(src, /images\/mps-logo\.png/, p + ' logo');
    assert.match(src, /css\/theme\.css/, p + ' theme css');
    assert.match(src, /rel="icon"/, p + ' favicon');
  });
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'mps-logo.png')), 'logo file missing');
});

test('frontend wiring: config, auth, api on every data-driven page', () => {
  ['checklist.html', 'dashboard.html', 'admin.html'].forEach((p) => {
    const src = read(p);
    ['js/config.js', 'js/auth.js', 'js/api.js', 'js/ui.js'].forEach((dep) => {
      assert.ok(src.includes(dep), p + ' must load ' + dep);
    });
    assert.match(src, /Auth\.require\(/, p + ' must guard the session');
  });
});

test('every routed action has a handler function', () => {
  const src = read('backend/MPS_BACKEND.gs');
  const re = /case '(\w+)':\s*result = (?:admin_\(\s*p\s*,\s*)?(\w+)/g;
  const missing = [];
  let count = 0, m;
  while ((m = re.exec(src)) !== null) {
    count++;
    const [, action, fn] = m;
    if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(src)) {
      missing.push(action + ' → ' + fn + '() not defined');
    }
  }
  assert.deepStrictEqual(missing, []);
  // 8 identifier GET routes (health returns a literal) + 11 POST routes
  assert.strictEqual(count, 19, 'expected 19 routed handler actions, saw ' + count);
});

test('admin task actions exist and are lock-protected', () => {
  const src = read('backend/MPS_BACKEND.gs');
  ['actionAddTask', 'actionUpdateTask', 'actionToggleTask', 'actionDeleteTask'].forEach((fn) => {
    const at = src.indexOf('function ' + fn + '(');
    assert.ok(at !== -1, fn + ' missing');
    const body = src.slice(at, at + 4000);
    assert.match(body, /withLock_\(/, fn + ' must run under LockService');
    assert.match(body, /invalidate_\('Checklist_Config'\)/, fn + ' must invalidate the task cache');
  });
  // delete must refuse when submission history exists
  const del = src.slice(src.indexOf('function actionDeleteTask('));
  assert.match(del, /has submission history/);
});

test('no secrets or admin bypasses are hard-coded in frontend code', () => {
  const files = PAGES.concat(fs.readdirSync(path.join(ROOT, 'js')).map((f) => 'js/' + f));
  files.forEach((f) => {
    const src = read(f);
    assert.doesNotMatch(src, /ADMIN_PW|adminPassword\s*=\s*['"][^'"]+['"]/, f + ' hard-coded admin password');
    assert.doesNotMatch(src, /isAdmin\s*=\s*true/, f + ' hard-coded isAdmin bypass');
    // a literal 4-digit PIN literal in source would be a leak
    assert.doesNotMatch(src, /pin\s*[:=]\s*['"]\d{4}['"]/i, f + ' hard-coded PIN');
  });
});

test('login page stores a token, never the PIN', () => {
  const src = read('index.html');
  assert.match(src, /Auth\.save\(/);
  assert.match(src, /token/);
  assert.doesNotMatch(src, /sessionStorage\.setItem\([^)]*pin/i);
  assert.doesNotMatch(src, /localStorage\.setItem\([^)]*pin/i);
});

test('login page has an on-screen submit for phones (PINs shorter than max)', () => {
  const src = read('index.html');
  assert.match(src, /id="goBtn"/, 'visible Sign in button required');
  assert.match(src, /goBtn.*addEventListener\('click'/s, 'button must trigger validate()');
  assert.match(src, /go\.disabled = pin\.length < PIN_MIN/, 'enable only at min PIN length');
  // validate() posts through MPS_API — the client must be loaded before it
  assert.match(src, /src="js\/api\.js"/, 'index.html must load js/api.js');
  const apiAt = src.indexOf('src="js/api.js"');
  const cfgAt = src.indexOf('src="js/config.js"');
  assert.ok(cfgAt !== -1 && cfgAt < apiAt, 'config.js must load before api.js');
});

test('pinLength is exactly { min: 4, max: 4 }', () => {
  // Execute the real config.js against a stubbed window so the RUNTIME
  // value is asserted (not just the source text): the login keypad derives
  // its dot count, cap and auto-submit from this object.
  const windowStub = {};
  new Function('window', read('js/config.js'))(windowStub);
  assert.ok(windowStub.MPS_CONFIG, 'js/config.js must set window.MPS_CONFIG');
  assert.deepStrictEqual(windowStub.MPS_CONFIG.pinLength, { min: 4, max: 4 });
});

test('PIN UI matches the 4-digit policy in both pages', () => {
  const admin = read('admin.html');
  assert.doesNotMatch(admin, /4–8/, 'admin.html must not mention "4–8" for the PIN');
  assert.doesNotMatch(admin, /maxlength="8"/, 'admin PIN field must not allow 8 characters');
  assert.match(admin, /id="u-pinLabel">PIN \(4 digits\)</, 'PIN label must say "PIN (4 digits)"');
  assert.match(admin, /\/\^\\d\{4\}\$\//, 'PIN validation must require exactly 4 digits');
  // index.html must show exactly one dot per accepted digit (d0–d3), so the
  // refresh loop (i < PIN_MAX === 4) finds every element it needs.
  const index = read('index.html');
  const dots = index.match(/<div class="dot" id="d\d+"><\/div>/g) || [];
  assert.strictEqual(dots.length, 4, 'index.html must contain exactly 4 PIN dot elements');
  assert.match(index, /id="d0"/);
  assert.match(index, /id="d3"/);
});

test('photos are never exposed as public Drive links', () => {
  const files = PAGES.concat(['js/api.js']).map((f) => f.startsWith('js/') ? f : f);
  files.forEach((f) => {
    const src = read(f);
    assert.doesNotMatch(src, /drive\.google\.com\/uc\?id=/, f + ' public drive link');
    assert.doesNotMatch(src, /ANYONE_WITH_LINK/, f + ' public sharing');
  });
  const backend = read('backend/MPS_BACKEND.gs');
  assert.doesNotMatch(backend, /ANYONE_WITH_LINK/);
  assert.doesNotMatch(backend, /Permission\.VIEW/);
});

test('backend keeps spreadsheet/folder IDs in Script Properties, not in code', () => {
  const src = read('backend/MPS_BACKEND.gs');
  assert.doesNotMatch(src, /openById\(['"][A-Za-z0-9_-]{30,}['"]\)/);
  assert.match(src, /requireProp\('SS_ID'\)/);
  assert.match(src, /prop\('PHOTO_FOLDER_ID'/);
  // session tokens must be verified server-side for admin actions
  assert.match(src, /requireSession_/);
  assert.match(src, /admin_\(/);
});

test('.env.example exists and contains placeholders only', () => {
  const src = read('.env.example');
  assert.match(src, /MPS_API_ENDPOINT=/);
  const value = src.split(/MPS_API_ENDPOINT=(.*)/)[1].trim();
  assert.strictEqual(value, '', 'endpoint placeholder must be empty');
  assert.doesNotMatch(src, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/);
});

test('deployment plumbing present: .nojekyll, workflow, build, gitignore', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')));
  const wf = read(path.join('.github', 'workflows', 'deploy.yml'));
  assert.match(wf, /actions\/deploy-pages/);
  assert.match(wf, /npm test/);
  const gi = read('.gitignore');
  assert.match(gi, /\.env/);
  assert.match(gi, /dist\//);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'build.js')));
});

test('checklist page validates mandatory fields, photos and remarks before submitting', () => {
  const src = read('checklist.html');
  assert.match(src, /function validateNew/);
  assert.match(src, /photo is required/);
  assert.match(src, /mandatory task/);
  assert.match(src, /remark explaining/);
  assert.match(src, /batchId/);          // idempotent retries
  assert.match(src, /uploadPhoto/);
  // validateNew reads e.taskId — doSubmit must include it or every
  // client-side check silently no-ops (server still validates, but the
  // UX round-trip is lost). Regression guard:
  assert.match(src, /entries\.push\(\{\s*taskId: t\.taskId,/s,
    'doSubmit must put taskId on each entry so validateNew can match tasks');
  // tasks may only count as done after the SERVER confirmed the save —
  // a draft answer or a rejected submit must stay in Pending:
  assert.match(src, /function isDone\(id\).*return !!\(a && \(a\._done \|\| \(a\.serverPhotos && a\.serverPhotos\.length\)\)\);/s,
    'isDone must not count unconfirmed draft answers (a.v) or draft photos (a.photos)');
});

test('regression: picking a photo in edit mode keeps the stored photos', () => {
  const src = read('checklist.html');
  // saveEdit must send the KEPT server ids plus the freshly uploaded ones —
  // a pick in edit mode may never erase the ids that are STILL stored on the
  // server (that used to make saveEdit refuse with "A photo is required for
  // this task." even though the original photo existed):
  const pickPhoto = src.slice(src.indexOf('function pickPhoto('), src.indexOf('function removePhoto('));
  assert.doesNotMatch(pickPhoto, /delete a\.serverPhotos|serverPhotos\s*=\s*\[\]/,
    'pickPhoto must not erase the stored photo list in edit mode');
  assert.match(pickPhoto, /a\.photos\.push\(\{ p: dataUrl, t: takenAt, uploadedId: '' \}\);/,
    'a picked photo is appended with its own capture time');
  assert.match(pickPhoto, /photoTotal\(a\) >= maxPhotos\(\)[\s\S]*?at most 5 photos/,
    'the hard cap of 5 photos is enforced on every pick');
  // saveEdit uploads the pending photos first (reusing the ids of photos an
  // earlier try already uploaded), then sends the merged id list:
  const saveEdit = src.slice(src.indexOf('function saveEdit('));
  assert.match(saveEdit, /uploadPhotosThen\(\[entry\], btn,/,
    'saveEdit must upload the new photos before submitting');
  assert.match(saveEdit, /send\(entry\.photoRef, entry\.photoTime\)/,
    'saveEdit sends the merged photo id list');
  assert.match(saveEdit, /serverIds: server\.map\(function \(ph\) \{ return ph\.id; \}\)/,
    'the stored photo ids are kept in the update');
});

test('regression: validateNew refuses a photo-type task with no photo', () => {
  const src = read('checklist.html');
  // The server rejects a type='photo' entry without a photoRef
  // (mps-core.gs deriveStatus → "expected an uploaded photo") even when
  // Photo_Required is No, killing the WHOLE batch — so the client must
  // refuse early, before the network round-trip:
  assert.match(src,
    /\(t\.photoRequired \|\| t\.type === 'photo'\) && count < 1/,
    'validateNew must treat type=photo like photoRequired');
  assert.match(src, /errs\.push\('"' \+ t\.taskName \+ '": a photo is required\.'\);/,
    'the type=photo check must reuse the same "a photo is required" message');
  assert.match(src, /errs\.push\('"' \+ t\.taskName \+ '": a task can have at most ' \+ max \+ ' photos\.'\);/,
    'validateNew must refuse more than 5 photos');
});

test('dashboard implements completion %, filters, missed view and exports', () => {
  const src = read('dashboard.html');
  assert.match(src, /exportXlsx/);
  assert.match(src, /exportCsv/);
  assert.match(src, /statusFilter/);
  assert.match(src, /getDashboard/);
  assert.match(src, /outstandingLabel|Missed/);
});

test('admin page guards access, wires tabs and activates the default panel', () => {
  const src = read('admin.html');
  assert.match(src, /Auth\.require\(\{\s*admin:\s*true\s*\}\)/);
  assert.match(src, /data-tabbtn/);            // tab click wiring exists
  // regression: tab clicks are wired, but nothing activated panel-tasks on
  // load — the Tasks tab (the default view) rendered blank on first open.
  // The default panel must ship with the active class:
  assert.match(src, /class="panel active" id="panel-tasks"/,
    'panel-tasks must be active in the markup on first load');
});

test('POST requests send no custom headers (stays a CORS-simple request)', () => {
  const src = read('js/api.js');
  // A custom header (the previously shipped X-Token) forces an OPTIONS
  // preflight before every POST; the Apps Script backend is designed to be
  // preflight-free by sending only the safelisted text/plain content type.
  // The session token travels inside the JSON body; the backend never reads
  // request headers. The exact-match assertion below also fails if ANY
  // second header is added to the fetch options.
  const m = src.match(/return fetch\(ep\.url, \{[\s\S]*?\}\)/);
  assert.ok(m, 'POST fetch call must be present');
  assert.match(m[0], /method: 'POST'/);
  assert.match(m[0], /headers: \{ 'Content-Type': 'text\/plain;charset=utf-8' \}/,
    'POST must send exactly one header: the safelisted text/plain content type');
});

test('login response reads isAdmin from the created session, not the user row', () => {
  const src = read('backend/MPS_BACKEND.gs');
  // regression: user objects from normalizeUsers have no .session property —
  // `match.session.isAdmin` threw a TypeError on EVERY successful login and
  // surfaced as a generic "Server error. Please try again." (SERVER), while
  // wrong PINs still returned the normal BAD_PIN message.
  assert.match(src, /isAdmin: created\.session\.isAdmin/,
    'login response must read isAdmin from the created session');
  assert.doesNotMatch(src, /match\.session/,
    'match.session must not appear — user rows carry isAdmin directly');
});

test('API client appends the query string without a path slash', () => {
  const src = read('js/api.js');
  // Apps Script serves ".../exec/?action=…" (a trailing slash before the
  // query) as a DIFFERENT URL — an error page without CORS headers. The
  // client must append '?' directly to the /exec endpoint, never '/?'.
  assert.doesNotMatch(src, /ep\.url \+ '\/\?/,
    "js/api.js must never append '/?' to ep.url");
  assert.match(src, /ep\.url \+ '\?action=getPhoto/,
    'photoUrl must append "?action=getPhoto" directly');
});

// ── staff checklist: photo / draft / batch fixes ──────────────────
function loadValidateNew(tasks) {
  const src = read('checklist.html');
  const start = src.indexOf('function validateNew(entries)');
  const end = src.indexOf('// ── submit', start);
  assert.ok(start !== -1 && end !== -1, 'validateNew must exist');
  const body = src.slice(start, end);
  return new Function('findTask', body + '; return validateNew;')(
    (id) => tasks.find((t) => t.taskId === id) || null);
}

test('behaviour: a freshly picked photo (not yet uploaded) passes validateNew', () => {
  const tasks = [
    { taskId: 'T1', taskName: 'Photo task', type: 'photo', photoRequired: true, mandatory: true },
    { taskId: 'T2', taskName: 'Yes/no + photo', type: 'yesno', photoRequired: true, mandatory: false }
  ];
  const validateNew = loadValidateNew(tasks);
  const fresh = { p: 'data:image/jpeg;base64,xxx', t: '2026-10-22 09:00:00', uploadedId: '' };
  assert.deepStrictEqual(validateNew([
    { taskId: 'T1', response: 'Photo', remarks: '', pending: [fresh], serverIds: [] },
    { taskId: 'T2', response: 'yes', remarks: '', pending: [fresh], serverIds: [] }
  ]), []);
  const missing = validateNew([
    { taskId: 'T1', response: '', remarks: '', pending: [], serverIds: [] }
  ]);
  assert.ok(missing.some((m) => /a photo is required/.test(m)), 'no photo at all must still be refused');
  assert.deepStrictEqual(validateNew([
    { taskId: 'T1', response: 'Photo', remarks: '', pending: [], serverIds: ['FILEID12345'] }
  ]), [], 'kept server photos count towards the requirement');
  const six = ['id0000000001', 'id0000000002', 'id0000000003', 'id0000000004', 'id0000000005', 'id0000000006']
    .map((id) => ({ p: 'x', t: '', uploadedId: id }));
  assert.ok(validateNew([{ taskId: 'T1', response: 'Photo', remarks: '', pending: six, serverIds: [] }])
    .some((m) => /at most 5 photos/.test(m)), 'more than 5 photos must be refused');
});

test('regression: server photos are shown after the checklist loads', () => {
  const src = read('checklist.html');
  assert.match(src, /build\(\);[\s\S]*?restoreServerPhotos\(\);\s*loadEl\.style\.display/,
    'restoreServerPhotos() must run right after the first build()');
});

test('regression: a draft never restores a photo-type task as answered', () => {
  const src = read('checklist.html');
  assert.match(src, /dt\.type === 'photo'\) saved\.v = ''/, 'photo-type draft answer must be cleared on restore');
  assert.match(src, /_needPhoto/, 'tasks needing a re-taken photo must be flagged');
});

test('regression: a changed task set gets a new idempotency batch id', () => {
  const src = read('checklist.html');
  assert.match(src, /pendingBatchKey !== batchKey/, 'batch id must be renewed when the tasks differ');
});

test('regression: getPhoto returns JSON data URL, client reads it', () => {
  const api = read('js/api.js');
  const be = read('backend/MPS_BACKEND.gs');
  assert.match(api, /res\.dataUrl/, 'api.js photoUrl must read dataUrl from JSON');
  assert.doesNotMatch(api, /X-Token/, 'api.js comment must not mention X-Token');
  assert.match(be, /Utilities\.base64Encode\(blob\.getBytes\(\)\)/, 'backend must return base64');
  assert.doesNotMatch(be, /createTextOutput\(blob\.getBytes\(\)\)/, 'backend must not send raw bytes via ContentService');
});

// ── draft photos on device + admin photo gallery ──────────────────
test('regression: draft photos are kept in IndexedDB and restored', () => {
  const src = read('checklist.html');
  assert.match(src, /indexedDB\.open\('mps_draft_photos'/, 'drafts must store photos in IndexedDB');
  assert.match(src, /dpPut\(id, toDraftPhotos\(a\.photos\)\)/, 'a picked photo (with its own time) must be saved');
  assert.match(src, /if \(news\.length\) dpPut\(id, toDraftPhotos\(news\)\); else dpDelete\(id\);/,
    'removing the last draft photo deletes its draft entry');
  assert.match(src, /dpDelete\(e\.task\.taskId\)/, 'a submitted photo must be deleted from the device');
  assert.match(src, /dpLoadAll\(\)\.then/, 'photos must be restored before the first render');
  assert.match(src, /put\(\{ photos: photos \|\| \[\] \}, dpKey\(id\)\)/, 'a draft holds { photos: [...] }');
  assert.match(src, /if \(typeof v === 'string'\) return v \? \[\{ p: v, t: '' \}\] : \[\];/,
    'older single-photo drafts are converted to a one-item list');
  assert.doesNotMatch(src, /toSave\[k\] = \{[^}]*\bp:/, 'photo data must never go into localStorage');
});

test('admin: Photos tab lists photos for any date range', () => {
  const admin = read('admin.html');
  assert.match(admin, /data-tabbtn="photos"/);
  assert.match(admin, /id="panel-photos"/);
  assert.match(admin, /MPS_API\.get\('getPhotos'/);
  assert.match(admin, /\['tasks', 'users', 'photos', 'settings'\]/, 'tab switcher must know the photos panel');
  const be = read('backend/MPS_BACKEND.gs');
  assert.match(be, /case 'getPhotos':\s+result = actionGetPhotos\(p\)/);
  assert.match(be, /function actionGetPhotos\(p\) \{\s+var auth = requireSession_\(p, true\)/, 'getPhotos must be admin-only');
});

test('multi-photo UI: dashboard buttons per photo, admin numbers, checklist grid', () => {
  const dash = read('dashboard.html');
  assert.match(dash, /String\(t\.photoRef\)\.split\(','\)/, 'dashboard renders one button per photo id');
  assert.match(dash, /'Photo ' \+ \(i \+ 1\)/, 'several photos are labelled Photo 1, Photo 2, …');
  const admin = read('admin.html');
  assert.match(admin, /Photo ' \+ window\.UI\.esc\(ph\.photoIndex\) \+ ' of ' \+ window\.UI\.esc\(ph\.photoCount\)/,
    'the gallery numbers the photos of a multi-photo task');
  const page = read('checklist.html');
  assert.match(page, /removePhoto\(rm\.getAttribute\('data-phrm'\), \+rm\.getAttribute\('data-i'\)\)/,
    'every thumbnail has its own Remove button');
  assert.match(page, /Add another photo \(optional\) - ' \+ total \+ ' of ' \+ max/,
    'after the first photo the hint shows the current count');
  assert.match(page, /uploadPhotosThen\(entries, btn, 'Submit Checklist',/,
    'submit uploads the photos one at a time through the shared uploader');
});

test('core: listPhotos filters by date range, sorts newest first, dedupes, caps', () => {
  const core = require('../backend/mps-core.gs');
  const mk = (date, ts, ref, extra) => Object.assign({ date, timestamp: ts, photoRef: ref, staffName: 'A', taskId: 'T1', taskName: 'Task', section: 'S', status: 'OK', sequence: 'First', remarks: '' }, extra);
  const subs = [
    mk('2026-10-20', '2026-10-20 09:00:00', 'fileid00001'),
    mk('2026-10-21', '2026-10-21 08:00:00', 'fileid00002'),
    mk('2026-10-21', '2026-10-21 10:00:00', 'fileid00003'),
    mk('2026-10-22', '2026-10-22 08:00:00', ''),          // no photo
    mk('2026-10-19', '2026-10-19 08:00:00', 'fileid00000'), // out of range
    mk('2026-10-21', '2026-10-21 10:05:00', 'fileid00003')  // same photo again
  ];
  const r = core.listPhotos(subs, '2026-10-20', '2026-10-22', 200);
  assert.deepStrictEqual(r.photos.map((p) => p.photoRef), ['fileid00003', 'fileid00002', 'fileid00001']);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.truncated, false);
  const cap = core.listPhotos(subs, '2026-10-20', '2026-10-22', 2);
  assert.strictEqual(cap.photos.length, 2);
  assert.strictEqual(cap.truncated, true);
  assert.ok(!('row' in r.photos[0]) && !('role' in r.photos[0]), 'only gallery fields are returned');
});

// ── photo capture time ────────────────────────────────────────────
test('core: cleanPhotoTime accepts a recent IST time and drops bad ones', () => {
  const core = require('../backend/mps-core.gs');
  const now = Date.parse('2026-10-22T10:00:00+05:30');
  assert.strictEqual(core.cleanPhotoTime('2026-10-22 09:14:05', now), '2026-10-22 09:14:05');
  assert.strictEqual(core.cleanPhotoTime('2026-10-22 10:03:00', now), '2026-10-22 10:03:00', '5 min clock skew is tolerated');
  assert.strictEqual(core.cleanPhotoTime('2026-10-22 10:30:00', now), '', 'future time dropped');
  assert.strictEqual(core.cleanPhotoTime('2026-10-19 09:00:00', now), '', 'older than 36 h dropped');
  assert.strictEqual(core.cleanPhotoTime('22/10/2026 09:00', now), '', 'wrong format dropped');
  assert.strictEqual(core.cleanPhotoTime('', now), '');
  assert.strictEqual(core.cleanPhotoTime('2026-13-45 99:99:99', now), '', 'impossible date dropped');
});

test('core: validateEntries keeps the photo time only when there is a photo', () => {
  const core = require('../backend/mps-core.gs');
  const now = Date.parse('2026-10-22T10:00:00+05:30');
  const tasks = { T1: { taskId: 'T1', taskName: 'Shop front', section: 'Opening', type: 'photo', photoRequired: true, mandatory: false, active: true } };
  const ok = core.validateEntries([{ taskId: 'T1', response: 'Photo', photoRef: 'FILEID1234567', photoTime: '2026-10-22 09:14:05' }], tasks, now);
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.strictEqual(ok.clean[0].photoTime, '2026-10-22 09:14:05');
  const forged = core.validateEntries([{ taskId: 'T1', response: 'Photo', photoRef: 'FILEID1234567', photoTime: '2030-01-01 00:00:00' }], tasks, now);
  assert.strictEqual(forged.clean[0].photoTime, '', 'a forged future time is not stored');
});

test('core: listPhotos fills the capture time from any row of the same photo and sorts by it', () => {
  const core = require('../backend/mps-core.gs');
  const mk = (date, ts, ref, pt) => ({ date, timestamp: ts, photoRef: ref, photoTime: pt, staffName: 'A', taskId: 'T1', taskName: 'Task', section: 'S', status: 'OK', sequence: 'First', remarks: '' });
  const r = core.listPhotos([
    mk('2026-10-21', '2026-10-21 18:00:00', 'fileid00001', '2026-10-21 09:00:00'),
    mk('2026-10-21', '2026-10-21 19:00:00', 'fileid00001', ''),           // update row, no time
    mk('2026-10-21', '2026-10-21 17:00:00', 'fileid00002', '2026-10-21 12:30:00')
  ], '2026-10-21', '2026-10-21', 200);
  assert.deepStrictEqual(r.photos.map((p) => p.photoRef), ['fileid00002', 'fileid00001'], 'sorted by capture time, newest first');
  assert.strictEqual(r.photos[1].photoTime, '2026-10-21 09:00:00');
});

test('photo time flows through the whole app', () => {
  const page = read('checklist.html');
  const api = read('backend/MPS_BACKEND.gs');
  const admin = read('admin.html');
  assert.match(page, /var takenAt = window\.Dates\.now\(\)\.date/, 'time is captured when the photo is chosen');
  assert.match(page, /a\.photos\.push\(\{ p: dataUrl, t: takenAt/, 'time is kept with each photo');
  assert.match(page, /photoTime: e\.photoRef \? \(e\.photoTime \|\| ''\) : ''/, 'time is sent with the submission');
  assert.match(page, /return \{ p: ph\.p, t: ph\.t \|\| '' \};/, 'time survives a saved draft');
  assert.match(page, /fmtPhotoTime\(sp\[0\]\.t\)/, 'staff see the first photo time on completed tasks');
  assert.match(page, /photoMeta\(a\)/, 'the completed card shows the photo meta line');
  assert.match(api, /'Submission_ID', 'Photo_Time'\]/, 'Photo_Time column is created automatically');
  assert.match(api, /c\.photoTime/, 'photo time is written to the sheet');
  assert.match(admin, /Taken time not recorded/, 'admin gallery shows the capture time');
});

test('task frequency: admin form, backend rules and submit guard are wired', () => {
  const admin = read('admin.html');
  const api = read('backend/MPS_BACKEND.gs');
  assert.match(admin, /id="f-frequency"/, 'admin can set a task frequency');
  assert.match(admin, /frequency: document\.getElementById\('f-frequency'\)\.value/, 'frequency is sent when saving a task');
  assert.match(api, /tasksForUser\(res\.tasks, sess\.name, sess\.role, today\)/, 'staff checklist only lists tasks due today');
  assert.match(api, /code: 'NOT_DUE'/, 'a task that is not due cannot be submitted');
  assert.match(api, /ensureHeaders_\('Checklist_Config', \['Frequency'\]\)/, 'Frequency header is added when missing');
});
