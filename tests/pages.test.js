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
        // js/vendor holds THIRD-PARTY library code (jsPDF). It is byte-for-byte
        // upstream, contains its own words/strings (e.g. "PubSub") that trip
        // the brand regex above, and is never our branding — skip it. Our own
        // code under js/ is still fully scanned.
        if (e === 'vendor') continue;
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
  // js/vendor (third-party jsPDF) is skipped: it is upstream code, not ours.
  const files = PAGES.concat(fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => fs.statSync(path.join(ROOT, 'js', f)).isFile())
    .map((f) => 'js/' + f));
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
  assert.strictEqual(core.cleanPhotoTime('2026-10-22 10:30:00', now), '2026-10-22 10:30:00', 'a clock up to 24 h ahead is tolerated');
  assert.strictEqual(core.cleanPhotoTime('2026-10-23 09:59:00', now), '2026-10-23 09:59:00', 'just inside the 24 h future window');
  assert.strictEqual(core.cleanPhotoTime('2026-10-23 10:01:00', now), '', 'more than 24 h in the future is dropped');
  assert.strictEqual(core.cleanPhotoTime('2026-10-19 09:00:00', now), '2026-10-19 09:00:00', 'a 3-day-old gallery photo is kept');
  assert.strictEqual(core.cleanPhotoTime('2026-10-09 09:00:00', now), '2026-10-09 09:00:00', '13 days old is still inside the 14-day window');
  assert.strictEqual(core.cleanPhotoTime('2026-10-07 09:00:00', now), '', 'older than 14 days dropped');
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
  assert.match(page, /window\.UI\.getPhotoTakenAt\(file\)\.then\(function \(takenAt\)/,
    'the capture time is read from the ORIGINAL file before compression');
  assert.match(page, /a\.photos\.push\(\{ p: dataUrl, t: takenAt/, 'time is kept with each photo');
  assert.match(page, /photoTime: e\.photoRef \? \(e\.photoTime \|\| ''\) : ''/, 'time is sent with the submission');
  assert.match(page, /return \{ p: ph\.p, t: ph\.t \|\| '' \};/, 'time survives a saved draft');
  assert.match(page, /fmtPhotoTime\(sp\[0\]\.t\)/, 'staff see the first photo time on completed tasks');
  assert.match(page, /photoMeta\(a\)/, 'the completed card shows the photo meta line');
  assert.match(api, /'Submission_ID', 'Photo_Time'\]/, 'Photo_Time column is created automatically');
  assert.match(api, /c\.photoTime/, 'photo time is written to the sheet');
  assert.match(admin, /Photo time not recorded/, 'admin gallery shows a notice when no capture time exists');
  assert.match(admin, /Photo taken: /, 'admin gallery labels the capture time');
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

// -- capture time: EXIF reader + frontend fallback order --------
// Browser files attach to `window`, so evaluate them against a stub window
// (same trick as the config.js test above).
function loadBrowserJs(files) {
  const win = {};
  files.forEach((f) => new Function('window', read(f))(win));
  return win;
}

// Build a minimal JPEG carrying one APP1/Exif block: IFD0 holds the Exif-IFD
// pointer (0x8769) and the Exif IFD holds DateTimeOriginal (0x9003, ASCII).
function makeExifJpeg(dateTimeOriginal) {
  const tif = [];
  const put = (arr) => { arr.forEach((b) => tif.push(b & 0xff)); };
  put([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);      // II + 42, IFD0 at 8
  const exifIfdAt = 10 + 12 * 1 + 4;                           // after IFD0 (1 entry) + next-ptr
  put([0x01, 0x00]);                                           // IFD0 count = 1
  put([0x69, 0x87, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]);       // 0x8769 LONG count 1
  put([exifIfdAt, 0x00, 0x00, 0x00]);                          //   -> Exif IFD offset
  put([0x00, 0x00, 0x00, 0x00]);                               // next IFD = none
  const strOff = exifIfdAt + 2 + 12 + 4;
  put([0x01, 0x00]);                                           // Exif IFD count = 1
  put([0x03, 0x90, 0x02, 0x00]);                               // 0x9003 ASCII
  const s = (dateTimeOriginal + '\x00').split('').map((c) => c.charCodeAt(0));
  put([s.length, 0x00, 0x00, 0x00]);                           //   count
  put([strOff, 0x00, 0x00, 0x00]);                             //   -> string offset
  put([0x00, 0x00, 0x00, 0x00]);                               // next IFD = none
  while (tif.length < strOff) tif.push(0);
  put(s);
  const payload = [].concat([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], tif); // "Exif\0\0"
  const len = payload.length + 2;
  return new Uint8Array([].concat([0xFF, 0xD8, 0xFF, 0xE1, len >> 8, len & 0xff], payload));
}

test('exif.js reads DateTimeOriginal from a JPEG and rejects everything else', () => {
  const win = loadBrowserJs(['js/exif.js']);
  assert.strictEqual(win.EXIF.findDateTime(makeExifJpeg('2026:10:26 14:03:11')), '2026-10-26 14:03:11');
  // PNG / HEIC / garbage � never throw, never guess
  assert.strictEqual(win.EXIF.findDateTime(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, 'a PNG has no EXIF');
  assert.strictEqual(win.EXIF.findDateTime(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00])), null, 'truncated block');
  assert.strictEqual(win.EXIF.findDateTime(new Uint8Array(0)), null, 'empty file');
  assert.strictEqual(win.EXIF.findDateTime(null), null);
  assert.strictEqual(win.EXIF.findDateTime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test('photo capture time: EXIF first, then file.lastModified, then now', () => {
  const win = loadBrowserJs(['js/dates.js', 'js/exif.js', 'js/ui.js']);
  const now = Date.parse('2026-10-26T14:00:00+05:30');
  const lm = Date.parse('2026-10-25T09:30:00+05:30');
  assert.strictEqual(win.UI.photoTakenAtFrom('2026-10-26 12:11:10', lm, now), '2026-10-26 12:11:10',
    'a valid EXIF time always wins');
  assert.strictEqual(win.UI.photoTakenAtFrom(null, lm, now), '2026-10-25 09:30:00',
    'no EXIF ? the file\'s lastModified, as IST text');
  assert.strictEqual(win.UI.photoTakenAtFrom('junk', lm, now), '2026-10-25 09:30:00',
    'unreadable EXIF is ignored, not trusted');
  assert.strictEqual(win.UI.photoTakenAtFrom(null, null, now), '2026-10-26 14:00:00',
    'nothing else available ? the current time');
  // getPhotoTakenAt wires the EXIF reader in front of the pure helper.
  win.EXIF.readFileDateTime = () => Promise.resolve('2026-10-26 12:11:10');
  return win.UI.getPhotoTakenAt({ lastModified: lm }).then((t) => {
    assert.strictEqual(t, '2026-10-26 12:11:10', 'getPhotoTakenAt uses the EXIF time when present');
    win.EXIF.readFileDateTime = () => Promise.resolve(null);
    return win.UI.getPhotoTakenAt({ lastModified: lm });
  }).then((t) => {
    assert.strictEqual(t, '2026-10-25 09:30:00', 'no EXIF ? lastModified');
  });
});

test('checklist page reads the capture time from the ORIGINAL file before compressing it', () => {
  const page = read('checklist.html');
  assert.match(page, /src="js\/exif\.js"/, 'checklist.html loads the EXIF reader');
  const exifAt = page.indexOf('src="js/exif.js"');
  const uiAt = page.indexOf('src="js/ui.js"');
  assert.ok(exifAt !== -1 && uiAt !== -1 && exifAt < uiAt, 'exif.js must load before ui.js');
  // Only the checklist needs it (photos are taken there).
  ['index.html', 'dashboard.html', 'admin.html'].forEach((p) =>
    assert.doesNotMatch(read(p), /js\/exif\.js/, p + ' must not load exif.js'));
});

test('jsPDF is vendored locally (no CDN) and copied into dist', () => {
  const vendor = path.join(ROOT, 'js', 'vendor', 'jspdf.umd.min.js');
  assert.ok(fs.existsSync(vendor), 'js/vendor/jspdf.umd.min.js must exist (copied from node_modules)');
  assert.ok(fs.statSync(vendor).size > 100000, 'the vendored jsPDF looks truncated');
  PAGES.concat(['js/report.js', 'js/exif.js']).forEach((f) => {
    if (!fs.existsSync(path.join(ROOT, f))) return;
    assert.doesNotMatch(read(f), /https?:\/\/[^"'\s]*jspdf/i, f + ' must not load jsPDF from a CDN');
  });
  // js/ is copied recursively, so js/vendor rides along into dist/.
  assert.match(read('scripts/build.js'), /'js'/, 'build.js copies the whole js folder');
});


// -- C&B footer + docs for the new assets -----------------------
test('every page carries the shared "Implemented by Consulting & Beyond" footer', () => {
  PAGES.forEach((p) => {
    const src = read(p);
    assert.match(src, /class="cb-footer"/, p + ' footer block');
    assert.match(src, /images\/cb-logo\.jpg/, p + ' C&B logo');
    assert.match(src, /onerror="this\.style\.display=.(none|'none')."/,
      p + ' footer must hide the logo when the file is missing');
    assert.match(src, /Consulting &amp; Beyond/, p + ' text credit survives a missing logo');
  });
  assert.match(read('css/theme.css'), /\.cb-footer \{/, 'the footer style lives in the shared theme');
});

test('docs cover the new pieces: vendored jsPDF, logo, PDF report, photos tab', () => {
  const third = read('docs/THIRD_PARTY.md');
  assert.match(third, /jspdf/i, 'THIRD_PARTY.md names the vendored library');
  assert.match(third, /MIT/i, 'THIRD_PARTY.md states its licence');
  const arch = read('docs/ARCHITECTURE.md');
  assert.match(arch, /cellToIstString/, 'architecture explains the capture-time repair');
  assert.match(arch, /PDF report/i, 'architecture documents the PDF report');
  assert.match(arch, /photo gallery/i, 'architecture documents the Photos tab');
  assert.match(arch, /cb-logo\.jpg/, 'architecture documents where the C&B logo lives');
  const api = read('docs/API.md');
  assert.match(api, /optionally `section`/, 'API.md documents the getPhotos section param');
  const readme = read('README.md');
  assert.match(readme, /cb-logo\.jpg/, 'README says where the logo goes and how to replace it');
  assert.match(readme, /Download PDF report|PDF report/, 'README explains how to produce the PDF');
});
