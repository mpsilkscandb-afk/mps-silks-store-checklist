// Backend core-logic tests — execute mps-core.gs directly in Node.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// -- load the .gs file through a CommonJS shim ------------------
function loadCore() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'mps-core.gs'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}
const C = loadCore();

// -- fixtures: the real MPS Silks workbook headers --------------
const MPS_TASK_HEADERS = ['Task_ID', 'Section', 'Task_Name', 'Type', 'Mandatory', 'Photo_Required', 'Active'];
const MPS_USER_HEADERS = ['Name', 'PIN', 'Active'];
const MPS_SUB_HEADERS = ['Timestamp', 'Date', 'Staff_Name', 'Role', 'Section', 'Task_ID', 'Task_Name',
  'Type', 'Response', 'Photo_URL', 'Status', 'Remarks', 'Sequence', 'Override_Reason'];

// -- SHA-256 / PIN hashing --------------------------------------
test('sha256Hex matches the published test vector for "abc"', () => {
  assert.strictEqual(
    C.sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('sha256Hex handles multi-byte input', () => {
  assert.strictEqual(
    C.sha256Hex('MPS Silks — ??????'),
    C.sha256Hex('MPS Silks — ??????')
  );
  assert.notStrictEqual(C.sha256Hex('a'), C.sha256Hex('b'));
});

test('hashPin / verifyPin round-trip with salt', () => {
  const h = C.hashPin('9182', 'salt-one');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(C.verifyPin(h, '9182', 'salt-one'), true);
  assert.strictEqual(C.verifyPin(h, '9183', 'salt-one'), false);
  assert.strictEqual(C.verifyPin(h, '9182', 'other-salt'), false);
});

test('verifyPin accepts legacy plaintext once, and flags migration', () => {
  assert.strictEqual(C.verifyPin('9182', '9182', 's'), true);
  assert.strictEqual(C.verifyPin('9182', '9183', 's'), false);
  assert.strictEqual(C.needsPinMigration('9182'), true);
  assert.strictEqual(C.needsPinMigration(C.hashPin('9182', 's')), false);
});

test('validPin requires 4–8 digits', () => {
  assert.strictEqual(C.validPin('9182'), true);
  assert.strictEqual(C.validPin('12345678'), true);
  assert.strictEqual(C.validPin('123'), false);
  assert.strictEqual(C.validPin('123456789'), false);
  assert.strictEqual(C.validPin('abcd'), false);
  assert.strictEqual(C.validPin(''), false);
});

test('constantTimeEq rejects mismatched lengths without throwing', () => {
  assert.strictEqual(C.constantTimeEq('abc', 'abcd'), false);
  assert.strictEqual(C.constantTimeEq('abcd', 'abcd'), true);
});

test('isAdminRole recognises admin-style roles only', () => {
  assert.strictEqual(C.isAdminRole('Admin'), true);
  assert.strictEqual(C.isAdminRole('owner'), true);
  assert.strictEqual(C.isAdminRole('Store Manager'), true);
  assert.strictEqual(C.isAdminRole('Staff'), false);
  assert.strictEqual(C.isAdminRole(''), false);
});

// -- column mapping ---------------------------------------------
test('mapColumns maps the exact MPS workbook headers', () => {
  const col = C.mapColumns(MPS_TASK_HEADERS, 'task');
  assert.strictEqual(col.taskId, 0);
  assert.strictEqual(col.section, 1);
  assert.strictEqual(col.taskName, 2);
  assert.strictEqual(col.type, 3);
  assert.strictEqual(col.mandatory, 4);
  assert.strictEqual(col.photoRequired, 5);
  assert.strictEqual(col.active, 6);
  assert.strictEqual(col.assignedTo, undefined); // MPS sheet has no assignment column
});

test('mapColumns handles BSC-style and messy headers', () => {
  const col = C.mapColumns(['Task ID', 'Section Name', 'Task', 'Type', 'Role1', 'Photo Required?'], 'task');
  assert.strictEqual(col.taskId, 0);
  assert.strictEqual(col.section, 1);
  assert.strictEqual(col.taskName, 2);
  assert.strictEqual(col.assignedTo, 4);
  assert.strictEqual(col.photoRequired, 5);
});

// -- task normalisation -----------------------------------------
test('normalizeTasks parses all real MPS tasks without problems', () => {
  const rows = [
    ['T001', 'Opening & Security', 'Open the store for customers at 9:30 AM', 'photo', 'Yes', 'Yes', 'Yes'],
    ['T002', 'Opening & Security', 'Check all CCTV cameras are working and recording', 'yesno', 'Yes', 'No', 'Yes'],
    ['T034', 'Closing & Security', 'Lock all shutters and doors and confirm CCTV is recording', 'yesno', 'Yes', 'No', 'Yes']
  ];
  const res = C.normalizeTasks(MPS_TASK_HEADERS, rows);
  assert.strictEqual(res.problems.length, 0);
  assert.strictEqual(res.tasks.length, 3);
  const t = res.tasks[0];
  assert.deepStrictEqual(
    { taskId: t.taskId, section: t.section, type: t.type, mandatory: t.mandatory, photoRequired: t.photoRequired, active: t.active },
    { taskId: 'T001', section: 'Opening & Security', type: 'photo', mandatory: true, photoRequired: true, active: true }
  );
  assert.deepStrictEqual(t.assignedTo, ['all']); // no assignment column ? everyone
  assert.strictEqual(res.tasks[1].type, 'yesno');
});

test('normalizeTasks reports invalid rows instead of discarding them silently', () => {
  const rows = [
    ['T100', 'Sec', 'Good task', 'yesno', 'Yes', 'No', 'Yes'],
    ['', '', '', '', '', '', ''],                                  // blank row ? skipped quietly
    ['T101', 'Sec', '', 'yesno', 'Yes', 'No', 'Yes'],              // no name ? problem
    ['T102', 'Sec', 'Odd type task', 'checkbox-maybe', 'Yes', 'No', 'Yes'], // unknown type ? problem + default
    ['', 'Sec', 'No ID task', 'yesno', 'Yes', 'No', 'Yes']         // missing id ? problem (still usable)
  ];
  const res = C.normalizeTasks(MPS_TASK_HEADERS, rows);
  assert.strictEqual(res.tasks.length, 3); // T100, odd-type, no-id
  assert.strictEqual(res.problems.length, 3);
  assert.match(res.problems[0].issue, /empty Task_Name/);
  assert.match(res.problems[1].issue, /unknown Type/);
  assert.match(res.problems[2].issue, /Missing Task_ID/);
  // unknown type defaulted so the task still works
  const odd = res.tasks.find((t) => t.taskName === 'Odd type task');
  assert.strictEqual(odd.type, 'yesno');
});

test('normalizeTasks on an unrecognised sheet returns an explanatory problem', () => {
  const res = C.normalizeTasks(['Foo', 'Bar'], [['1', '2']]);
  assert.strictEqual(res.tasks.length, 0);
  assert.strictEqual(res.problems.length, 1);
  assert.match(res.problems[0].issue, /no recognisable Task_ID or Task_Name/);
});

test('normalizeTasks treats blank Active as active and parses assignment lists', () => {
  const rows = [['T1', 'S', 'T', 'yesno', 'Yes', 'No', ''], ['T2', 'S', 'T2', 'yesno', 'No', 'No', 'No', 'Ramesh, Staff']];
  const res = C.normalizeTasks(MPS_TASK_HEADERS.concat('Assigned_To'), rows);
  assert.strictEqual(res.tasks[0].active, true);
  assert.deepStrictEqual(res.tasks[1].assignedTo, ['ramesh', 'staff']);
  assert.strictEqual(res.tasks[1].mandatory, false);
});

// -- users ------------------------------------------------------
test('normalizeUsers on real MPS headers defaults role to Staff', () => {
  const res = C.normalizeUsers(MPS_USER_HEADERS, [['Abu Bakker', '9182', 'Yes']]);
  assert.strictEqual(res.problems.length, 0);
  assert.strictEqual(res.users.length, 1);
  assert.strictEqual(res.users[0].role, 'Staff');
  assert.strictEqual(res.users[0].isAdmin, false);
  assert.strictEqual(res.users[0].active, true);
});

test('normalizeUsers recognises Admin role column when present', () => {
  const res = C.normalizeUsers(['Name', 'PIN', 'Role', 'Active'], [
    ['Owner One', '1111', 'Admin', 'Yes'],
    ['Staff Two', '2222', 'staff', 'No']
  ]);
  assert.strictEqual(res.users[0].isAdmin, true);
  assert.strictEqual(res.users[1].isAdmin, false);
  assert.strictEqual(res.users[1].active, false);
});

// -- submissions ------------------------------------------------
test('normalizeSubmissions parses the MPS submission columns', () => {
  const rows = [[
    '2026-10-20 10:15:00', '2026-10-20', 'Abu Bakker', 'Staff', 'Opening & Security',
    'T001', 'Open the store', 'photo', 'Photo', 'file-abc123', 'OK', '', 'First', ''
  ]];
  const subs = C.normalizeSubmissions(MPS_SUB_HEADERS, rows);
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].date, '2026-10-20');
  assert.strictEqual(subs[0].taskId, 'T001');
  assert.strictEqual(subs[0].status, 'OK');
  assert.strictEqual(subs[0].photoRef, 'file-abc123');
});

test('normalizeSubmissions converts dd/mm/yyyy dates and empty sheets', () => {
  assert.deepStrictEqual(C.normalizeSubmissions(MPS_SUB_HEADERS, []), []);
  const rows = [['2026 10:00', '20/10/2026', 'X', '', '', 'T1', '', '', '', '', '', '', '', '']];
  const subs = C.normalizeSubmissions(MPS_SUB_HEADERS, rows);
  assert.strictEqual(subs[0].date, '2026-10-20');
});

// -- status derivation (server-side) ----------------------------
test('deriveStatus for yesno', () => {
  const t = { type: 'yesno' };
  assert.strictEqual(C.deriveStatus(t, 'yes'), 'OK');
  assert.strictEqual(C.deriveStatus(t, 'No'), 'FAIL');
  assert.strictEqual(C.deriveStatus(t, 'maybe'), null);
});
test('deriveStatus for rating', () => {
  const t = { type: 'rating' };
  assert.strictEqual(C.deriveStatus(t, '5'), 'OK');
  assert.strictEqual(C.deriveStatus(t, '3'), 'OK');
  assert.strictEqual(C.deriveStatus(t, '2'), 'FAIL');
  assert.strictEqual(C.deriveStatus(t, '9'), null);
});
test('deriveStatus for photo and text', () => {
  assert.strictEqual(C.deriveStatus({ type: 'photo' }, 'Photo', 'file-1'), 'OK');
  assert.strictEqual(C.deriveStatus({ type: 'photo' }, '', ''), null);
  assert.strictEqual(C.deriveStatus({ type: 'text' }, 'done', ''), 'OK');
  assert.strictEqual(C.deriveStatus({ type: 'text' }, '   ', ''), null);
});

// -- submission validation --------------------------------------
function twoTasks() {
  const res = C.normalizeTasks(MPS_TASK_HEADERS, [
    ['T001', 'Opening', 'Open store', 'photo', 'Yes', 'Yes', 'Yes'],
    ['T002', 'Opening', 'Check CCTV', 'yesno', 'Yes', 'No', 'Yes'],
    ['T003', 'Temp', 'Optional note', 'text', 'No', 'No', 'No']
  ]);
  const map = {};
  res.tasks.forEach((t) => { map[t.taskId] = t; });
  return map;
}

test('validateEntries rejects an empty submission', () => {
  const v = C.validateEntries([], twoTasks());
  assert.strictEqual(v.ok, false);
  assert.match(v.errors[0], /No entries/);
});

test('validateEntries accepts a valid mixed batch', () => {
  const v = C.validateEntries([
    { taskId: 'T001', response: 'Photo', photoRef: 'fileid00009' },
    { taskId: 'T002', response: 'yes' },
    { taskId: 'T003', response: '' }           // optional, inactive ? error actually
  ], twoTasks());
  // T003 is inactive in this fixture
  assert.strictEqual(v.ok, false);
  assert.match(v.errors[0], /inactive/);

  const v2 = C.validateEntries([
    { taskId: 'T001', response: 'Photo', photoRef: 'fileid00009' },
    { taskId: 'T002', response: 'yes' }
  ], twoTasks());
  assert.strictEqual(v2.ok, true);
  assert.strictEqual(v2.clean.length, 2);
  assert.strictEqual(v2.clean[0].status, 'OK');
});

test('validateEntries: photo task without a photo is rejected', () => {
  const v = C.validateEntries([{ taskId: 'T001', response: 'Photo' }], twoTasks());
  assert.strictEqual(v.ok, false);
  assert.match(v.errors[0], /photograph is required/);
});

test('validateEntries: failing yes/no without remarks is rejected', () => {
  const v = C.validateEntries([{ taskId: 'T002', response: 'no', remarks: '' }], twoTasks());
  assert.strictEqual(v.ok, false);
  assert.match(v.errors[0], /remark explaining the issue/);
});

test('validateEntries: failing yes/no WITH remarks passes and is marked FAIL', () => {
  const v = C.validateEntries(
    [{ taskId: 'T002', response: 'no', remarks: 'Camera 3 is blank' }], twoTasks());
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.clean[0].status, 'FAIL');
});

test('validateEntries: unknown and duplicate task ids are rejected', () => {
  const v = C.validateEntries([{ taskId: 'T999', response: 'yes' }], twoTasks());
  assert.match(v.errors[0], /unknown task/);
  const v2 = C.validateEntries([
    { taskId: 'T002', response: 'yes' },
    { taskId: 'T002', response: 'no' }
  ], twoTasks());
  assert.match(v2.errors[0], /duplicate taskId/);
});

test('validateEntries: response/remarks length caps', () => {
  const v = C.validateEntries(
    [{ taskId: 'T002', response: 'x'.repeat(501) }], twoTasks());
  assert.match(v.errors[0], /response too long/);
  const v2 = C.validateEntries(
    [{ taskId: 'T002', response: 'no', remarks: 'y'.repeat(1001) }], twoTasks());
  assert.match(v2.errors[0], /remarks too long/);
});

// -- dashboard maths --------------------------------------------
function dashFixture() {
  const res = C.normalizeTasks(MPS_TASK_HEADERS, [
    ['T001', 'Opening', 'Open store', 'photo', 'Yes', 'Yes', 'Yes'],
    ['T002', 'Opening', 'Check CCTV', 'yesno', 'Yes', 'No', 'Yes'],
    ['T003', 'Closing', 'Lock shutters', 'yesno', 'Yes', 'No', 'Yes']
  ]);
  const subs = [
    // first entry for T001, then an update (resubmission)
    { date: '2026-10-20', taskId: 'T001', staffName: 'Abu', role: 'Staff', status: 'OK', response: 'Photo', photoRef: 'f1', remarks: '', timestamp: '2026-10-20 10:00:00', sequence: 'First', submissionId: 'b1' },
    { date: '2026-10-20', taskId: 'T001', staffName: 'Abu', role: 'Staff', status: 'OK', response: 'Photo', photoRef: 'f2', remarks: 'retaken', timestamp: '2026-10-20 11:00:00', sequence: 'Update', submissionId: 'b2' },
    // a FAILED submission counts as submitted, never as passed
    { date: '2026-10-20', taskId: 'T002', staffName: 'Ravi', role: 'Staff', status: 'FAIL', response: 'no', photoRef: '', remarks: 'Cam 3 dead', timestamp: '2026-10-20 10:05:00', sequence: 'First', submissionId: 'b3' },
    // another day
    { date: '2026-10-19', taskId: 'T001', staffName: 'Abu', role: 'Staff', status: 'OK', response: 'Photo', photoRef: 'f3', remarks: '', timestamp: '2026-10-19 10:00:00', sequence: 'First', submissionId: 'b4' }
  ];
  return { tasks: res.tasks, subs };
}

test('computeDashboard: completion = submitted ÷ assigned; failed ? passed', () => {
  const { tasks, subs } = dashFixture();
  const d = C.computeDashboard(tasks, subs, '2026-10-20', '2026-10-20', '2026-10-20');
  assert.strictEqual(d.headline.assigned, 3);
  assert.strictEqual(d.headline.submitted, 2);   // T001 + T002
  assert.strictEqual(d.headline.passed, 1);      // only T001
  assert.strictEqual(d.headline.failed, 1);      // T002 failed
  assert.strictEqual(d.headline.pending, 1);     // T003 not submitted
  assert.strictEqual(d.headline.pct, 67);        // 2 ÷ 3
  assert.strictEqual(d.headline.passPct, 33);    // 1 ÷ 3
  // failed must never be counted as passed
  assert.strictEqual(d.headline.passed + d.headline.failed, d.headline.submitted);
});

test('computeDashboard: repeated submissions are not double-counted', () => {
  const { tasks, subs } = dashFixture();
  const d = C.computeDashboard(tasks, subs, '2026-10-20', '2026-10-20', '2026-10-20');
  const t001 = d.detail.find((t) => t.taskId === 'T001');
  assert.strictEqual(t001.updates, 2);           // two rows exist for the day
  assert.strictEqual(t001.state, 'PASS');        // latest state wins
  assert.strictEqual(d.headline.submitted, 2);   // but counted once
  const log = d.updates.find((u) => u.taskId === 'T001');
  assert.ok(log, 'resubmission must appear in the updates log');
  assert.strictEqual(log.totalEntries, 2);
});

test('computeDashboard: pending is only "Missed" for past dates', () => {
  const { tasks, subs } = dashFixture();
  const today = C.computeDashboard(tasks, subs, '2026-10-20', '2026-10-20', '2026-10-20');
  assert.strictEqual(today.outstandingLabel, 'Pending');
  const past = C.computeDashboard(tasks, subs, '2026-10-19', '2026-10-19', '2026-10-20');
  assert.strictEqual(past.outstandingLabel, 'Missed');
  assert.strictEqual(past.headline.assigned, 3);
  assert.strictEqual(past.headline.submitted, 1);
  assert.ok(past.outstanding.every((t) => t.outstandingLabel === 'Missed'));
});

test('computeDashboard: section + trend maths over a range', () => {
  const { tasks, subs } = dashFixture();
  const d = C.computeDashboard(tasks, subs, '2026-10-19', '2026-10-20', '2026-10-21');
  assert.strictEqual(d.trend.length, 2);
  assert.strictEqual(d.trend[0].date, '2026-10-19');
  assert.strictEqual(d.trend[0].submitted, 1);
  assert.strictEqual(d.trend[1].submitted, 2);
  const opening = d.sections.find((s) => s.section === 'Opening');
  assert.strictEqual(opening.assigned, 2);
  assert.strictEqual(opening.passed, 1);
  assert.strictEqual(opening.failed, 1);
  assert.strictEqual(opening.pct, 100);
  const closing = d.sections.find((s) => s.section === 'Closing');
  assert.strictEqual(closing.pending, 1);
  // range aggregate = sum(submitted) ÷ sum(assigned)
  assert.strictEqual(d.range.assignedTotal, 6);
  assert.strictEqual(d.range.submittedTotal, 3);
  assert.strictEqual(d.range.pct, 50);
});

test('computeDashboard: invalid range returns null; empty data is safe', () => {
  const { tasks } = dashFixture();
  assert.strictEqual(C.computeDashboard(tasks, [], '2026-10-25', '2026-10-20', '2026-10-25'), null);
  const d = C.computeDashboard([], [], '2026-10-20', '2026-10-20', '2026-10-20');
  assert.strictEqual(d.headline.assigned, 0);
  assert.strictEqual(d.headline.pct, 0);
});

test('computeDashboard: staff-wise counts come from submissions', () => {
  const { tasks, subs } = dashFixture();
  const d = C.computeDashboard(tasks, subs, '2026-10-20', '2026-10-20', '2026-10-20');
  const abu = d.staff.find((s) => s.name === 'Abu');
  const ravi = d.staff.find((s) => s.name === 'Ravi');
  assert.strictEqual(abu.submitted, 1);
  assert.strictEqual(abu.passed, 1);
  assert.strictEqual(ravi.failed, 1);
  // regression: pending tasks must not fabricate zero-rows (e.g. a phantom
  // "Unknown 0/0/0") — only actual submissions are attributed to staff
  assert.deepStrictEqual(d.staff.map((s) => s.name).sort(), ['Abu', 'Ravi']);
  // …but a submission with an EMPTY staff name is still reported as
  // "Unknown" — data problems are bucketed, never silently dropped
  const withAnon = subs.concat([{
    date: '2026-10-20', taskId: 'T003', staffName: '', status: 'OK', response: 'y',
    photoRef: '', remarks: '', timestamp: '2026-10-20 09:00:00', sequence: 'First', submissionId: 'b9'
  }]);
  const d2 = C.computeDashboard(tasks, withAnon, '2026-10-20', '2026-10-20', '2026-10-20');
  const unk = d2.staff.find((s) => s.name === 'Unknown');
  assert.ok(unk && unk.submitted === 1, 'unnamed submission must be bucketed as Unknown');
  assert.ok(d2.staff.every((s) => s.submitted > 0), 'no zero-submission staff rows');
});

test('computeDashboard: submissions for tasks removed from the sheet are ignored', () => {
  const subs = [{ date: '2026-10-20', taskId: 'T_GONE', staffName: 'X', status: 'OK', response: 'y', photoRef: '', remarks: '', timestamp: '', sequence: 'First', submissionId: '' }];
  const d = C.computeDashboard([], subs, '2026-10-20', '2026-10-20', '2026-10-20');
  assert.strictEqual(d.headline.assigned, 0);
  assert.strictEqual(d.detail.length, 0);
});

// -- assignment / grouping --------------------------------------
test('tasksForUser: no assignment column means everyone sees the task', () => {
  const res = C.normalizeTasks(MPS_TASK_HEADERS, [
    ['T001', 'S', 'A', 'yesno', 'Yes', 'No', 'Yes'],
    ['T002', 'S', 'B', 'yesno', 'Yes', 'No', 'No']  // inactive
  ]);
  const mine = C.tasksForUser(res.tasks, 'Anybody', 'Staff');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].taskId, 'T001');
});

test('tasksForUser: honours name/role assignment lists', () => {
  const res = C.normalizeTasks(MPS_TASK_HEADERS.concat('Assigned_To'), [
    ['T001', 'S', 'A', 'yesno', 'Yes', 'No', 'Yes', 'Ramesh'],
    ['T002', 'S', 'B', 'yesno', 'Yes', 'No', 'Yes', 'Admin'],
    ['T003', 'S', 'C', 'yesno', 'Yes', 'No', 'Yes', '']
  ]);
  const forRamesh = C.tasksForUser(res.tasks, 'Ramesh', 'Staff');
  assert.deepStrictEqual(forRamesh.map((t) => t.taskId), ['T001', 'T003']);
  const forAdmin = C.tasksForUser(res.tasks, 'Sunita', 'Admin');
  assert.deepStrictEqual(forAdmin.map((t) => t.taskId), ['T002', 'T003']);
});

test('sectionsFor groups tasks in first-seen order', () => {
  const res = C.normalizeTasks(MPS_TASK_HEADERS, [
    ['T001', 'Opening', 'A', 'yesno', 'Yes', 'No', 'Yes'],
    ['T002', 'Closing', 'B', 'yesno', 'Yes', 'No', 'Yes'],
    ['T003', 'Opening', 'C', 'yesno', 'Yes', 'No', 'Yes']
  ]);
  const secs = C.sectionsFor(res.tasks);
  assert.deepStrictEqual(secs.map((s) => s.section), ['Opening', 'Closing']);
  assert.strictEqual(secs[0].tasks.length, 2);
});

test('latestForDay keeps the last submission per task', () => {
  const subs = [
    { date: '2026-10-20', taskId: 'T1', status: 'FAIL' },
    { date: '2026-10-20', taskId: 'T1', status: 'OK' },
    { date: '2026-10-19', taskId: 'T1', status: 'OK' }
  ];
  const latest = C.latestForDay(subs, '2026-10-20');
  assert.strictEqual(latest.T1.status, 'OK');
});

// -- date utilities in core -------------------------------------
test('core day helpers agree with the frontend helpers', () => {
  assert.strictEqual(C.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(C.addDays('2026-01-01', -1), '2025-12-31');
  assert.deepStrictEqual(C.dayRange('2026-10-19', '2026-10-20'), ['2026-10-19', '2026-10-20']);
  assert.deepStrictEqual(C.dayRange('2026-10-25', '2026-10-20'), []);
  assert.strictEqual(C.normDateCell('20/10/2026'), '2026-10-20');
  assert.strictEqual(C.normDateCell('2026-10-20 10:30'), '2026-10-20');
});

test('normType accepts common spellings and rejects junk', () => {
  assert.strictEqual(C.normType('Yes / No'), 'yesno');
  assert.strictEqual(C.normType('YN'), 'yesno');
  assert.strictEqual(C.normType('Stars'), 'rating');
  assert.strictEqual(C.normType('PHOTO'), 'photo');
  assert.strictEqual(C.normType('Note'), 'text');
  assert.strictEqual(C.normType('nonsense'), null);
});

test('cleanText strips control chars and caps length', () => {
  assert.strictEqual(C.cleanText('a\u0000b', 10), 'a b');
  assert.strictEqual(C.cleanText('abcdef', 3), 'abc');
  assert.strictEqual(C.cleanText(null), '');
});

// -- task frequency: daily / weekly (Friday) / monthly (28th) ---
const FREQ_HEADERS = ['Task_ID', 'Section', 'Task_Name', 'Type', 'Mandatory', 'Photo_Required', 'Active', 'Frequency'];
function freqTasks() {
  return C.normalizeTasks(FREQ_HEADERS, [
    ['T001', 'Opening', 'Open shutters', 'yesno', 'Yes', 'No', 'Yes', 'Daily'],
    ['T002', 'Opening', 'Weekly stock count', 'yesno', 'Yes', 'No', 'Yes', 'weekly'],
    ['T003', 'Admin', 'Monthly audit', 'text', 'Yes', 'No', 'Yes', ' MONTHLY '],
    ['T004', 'Admin', 'Blank means daily', 'yesno', 'Yes', 'No', 'Yes', ''],
    ['T005', 'Admin', 'Typo frequency', 'yesno', 'Yes', 'No', 'Yes', 'fortnightly']
  ]);
}

test('frequency: normFrequency accepts spellings; blank = daily; junk = null', () => {
  assert.strictEqual(C.normFrequency('Daily'), 'daily');
  assert.strictEqual(C.normFrequency(' WEEKLY '), 'weekly');
  assert.strictEqual(C.normFrequency('Monthly'), 'monthly');
  assert.strictEqual(C.normFrequency(''), 'daily');
  assert.strictEqual(C.normFrequency(null), 'daily');
  assert.strictEqual(C.normFrequency('fortnightly'), null);
});

test('frequency: the Frequency column is read and an unknown value is reported', () => {
  const res = freqTasks();
  const f = {}; res.tasks.forEach(t => { f[t.taskId] = t.frequency; });
  assert.deepStrictEqual(f, { T001: 'daily', T002: 'weekly', T003: 'monthly', T004: 'daily', T005: 'daily' });
  assert.ok(res.problems.some(p => /T005/.test(p.issue) && /Frequency/.test(p.issue)));
  // a sheet without the column still works: everything is daily
  const old = C.normalizeTasks(MPS_TASK_HEADERS, [['T1', 'S', 'A task', 'yesno', 'Yes', 'No', 'Yes']]);
  assert.strictEqual(old.tasks[0].frequency, 'daily');
  assert.strictEqual(old.problems.length, 0);
});

test('frequency: a header like "Task Frequency" or "Frequency (D/W/M)" is found', () => {
  ['Task Frequency', 'Frequency (D/W/M)', 'frequency'].forEach(h => {
    const col = C.mapColumns(['Task_ID', 'Section', 'Task_Name', h], 'task');
    assert.strictEqual(col.frequency, 3, h);
  });
});

test('frequency: isDueOn - weekly is Friday only, monthly is the 28th only', () => {
  const w = { frequency: 'weekly' }, m = { frequency: 'monthly' }, d = { frequency: 'daily' };
  // 2026-10-23 is a Friday
  assert.strictEqual(C.isDueOn(w, '2026-10-23'), true);
  assert.strictEqual(C.isDueOn(w, '2026-10-22'), false);
  assert.strictEqual(C.isDueOn(w, '2026-10-24'), false);
  assert.strictEqual(C.isDueOn(m, '2026-10-28'), true);
  assert.strictEqual(C.isDueOn(m, '2026-10-27'), false);
  assert.strictEqual(C.isDueOn(m, '2026-02-28'), true);   // every month has a 28th
  assert.strictEqual(C.isDueOn(d, '2026-10-22'), true);
  assert.strictEqual(C.isDueOn({}, '2026-10-22'), true);  // no frequency = daily
  assert.strictEqual(C.isDueOn(w, 'not-a-date'), true);   // unreadable day: do not hide tasks
});

test('frequency: tasksForUser with a day hides tasks that are not due', () => {
  const res = freqTasks();
  const ids = day => C.tasksForUser(res.tasks, 'Abu', 'Staff', day).map(t => t.taskId);
  assert.deepStrictEqual(ids('2026-10-22'), ['T001', 'T004', 'T005']);                 // Thursday
  assert.deepStrictEqual(ids('2026-10-23'), ['T001', 'T002', 'T004', 'T005']);         // Friday
  assert.deepStrictEqual(ids('2026-10-28'), ['T001', 'T003', 'T004', 'T005']);         // the 28th (Wednesday)
  assert.strictEqual(C.tasksForUser(res.tasks, 'Abu', 'Staff').length, 5);             // no day = no filter
});

test('frequency: dashboard counts a weekly task as assigned only on its due day', () => {
  const tasks = freqTasks().tasks;
  const thu = C.computeDashboard(tasks, [], '2026-10-22', '2026-10-22', '2026-10-22');
  assert.strictEqual(thu.headline.assigned, 3);                 // T001, T004, T005
  const fri = C.computeDashboard(tasks, [], '2026-10-23', '2026-10-23', '2026-10-23');
  assert.strictEqual(fri.headline.assigned, 4);                 // + weekly T002
  assert.ok(fri.detail.some(r => r.taskId === 'T002' && r.frequency === 'weekly'));
  assert.ok(!thu.detail.some(r => r.taskId === 'T002'));
  // a range Thu..Fri sums the daily assigned counts: 3 + 4
  const range = C.computeDashboard(tasks, [], '2026-10-22', '2026-10-23', '2026-10-23');
  assert.strictEqual(range.range.assignedTotal, 7);
  assert.deepStrictEqual(range.trend.map(t => t.assigned), [3, 4]);
});

test('frequency: an unsubmitted weekly task is Missed only on its own Friday', () => {
  const tasks = freqTasks().tasks;
  const subs = [{ date: '2026-10-23', taskId: 'T002', staffName: 'Abu', status: 'OK', response: 'yes', timestamp: '2026-10-23 10:00:00' }];
  const fri = C.computeDashboard(tasks, subs, '2026-10-23', '2026-10-23', '2026-10-23');
  assert.strictEqual(fri.headline.submitted, 1);
  const sat = C.computeDashboard(tasks, [], '2026-10-24', '2026-10-24', '2026-10-24');
  assert.strictEqual(sat.outstanding.filter(r => r.taskId === 'T002').length, 0);
});

// -- multiple photos per task (max 5) -----------------------------
test('parsePhotoRefs keeps valid ids, drops junk and repeats; a single old id still works', () => {
  assert.strictEqual(C.MAX_PHOTOS, 5, 'a task may carry at most 5 photos');
  assert.deepStrictEqual(C.parsePhotoRefs('fileid00001'), ['fileid00001'], 'a single old id still works');
  assert.deepStrictEqual(C.parsePhotoRefs(' fileid00001 , fileid00002 '), ['fileid00001', 'fileid00002'],
    'spaces around ids are trimmed');
  assert.deepStrictEqual(C.parsePhotoRefs('short,fileid00003'), ['fileid00003'],
    'ids shorter than 10 characters are dropped');
  assert.deepStrictEqual(C.parsePhotoRefs('fileid00004,fileid00004'), ['fileid00004'],
    'repeats are de-duplicated');
  assert.deepStrictEqual(C.parsePhotoRefs('fileid00005,bad id!,fileid00006'), ['fileid00005', 'fileid00006'],
    'non-id text is dropped, the rest stays in order');
  assert.deepStrictEqual(C.parsePhotoRefs(''), [], 'empty input gives no ids');
  assert.deepStrictEqual(C.parsePhotoRefs(undefined), [], 'missing input gives no ids');
});

test('cleanPhotoTimes keeps one slot per id and leaves empty slots blank', () => {
  const now = Date.parse('2026-10-22T10:00:00+05:30');
  assert.strictEqual(C.cleanPhotoTimes(1, '2026-10-22 09:14:05', now), '2026-10-22 09:14:05',
    'a single old id + time still works');
  assert.strictEqual(C.cleanPhotoTimes(3, '2026-10-22 09:00:00,,2026-10-22 09:30:00', now),
    '2026-10-22 09:00:00,,2026-10-22 09:30:00', 'a blank middle slot stays blank, order kept');
  assert.strictEqual(C.cleanPhotoTimes(4, '2026-10-22 09:00:00', now), '2026-10-22 09:00:00,,,',
    'fewer times than ids are padded with empty slots');
  assert.strictEqual(C.cleanPhotoTimes(1, '2026-10-22 09:00:00,2026-10-22 09:01:00', now), '2026-10-22 09:00:00',
    'extra times are trimmed to the id count');
  assert.strictEqual(C.cleanPhotoTimes(2, 'garbage,,', now), ',', 'cleaning applies to every slot');
  assert.strictEqual(C.cleanPhotoTimes(0, 'x', now), '', 'no ids means no times');
});

test('validateEntries accepts up to 5 photos and keeps their times aligned', () => {
  const now = Date.parse('2026-10-22T10:00:00+05:30');
  const tasks = { T1: { taskId: 'T1', taskName: 'Shop front', section: 'Opening', type: 'photo', photoRequired: true, mandatory: false, active: true } };
  const five = ['fileid00001', 'fileid00002', 'fileid00003', 'fileid00004', 'fileid00005'].join(',');
  const times = '2026-10-22 09:00:00,,2026-10-22 09:30:00,,2026-10-22 09:45:00';
  const ok = C.validateEntries([{ taskId: 'T1', response: 'Photo', photoRef: five, photoTime: times }], tasks, now);
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.strictEqual(ok.clean[0].photoRef, five, 'the id list is stored as-is');
  assert.strictEqual(ok.clean[0].photoTime, times, 'the blank middle slot survives, times stay aligned');
  assert.strictEqual(ok.clean[0].status, 'OK');

  const bad = C.validateEntries([{ taskId: 'T1', response: 'Photo', photoRef: five + ',fileid00006' }], tasks, now);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => /at most 5 photos/.test(e)), 'a 6th photo is refused');

  const one = C.validateEntries([{ taskId: 'T1', response: 'Photo', photoRef: 'fileid00009', photoTime: '2026-10-22 09:14:05' }], tasks, now);
  assert.ok(one.ok, JSON.stringify(one.errors));
  assert.strictEqual(one.clean[0].photoRef, 'fileid00009', 'an old single id still works');
  assert.strictEqual(one.clean[0].photoTime, '2026-10-22 09:14:05');

  const none = C.validateEntries([{ taskId: 'T1', response: 'Photo' }], tasks, now);
  assert.strictEqual(none.ok, false);
  assert.ok(none.errors.some((e) => /photograph is required/.test(e)),
    'a task that needs a photo with 0 ids is rejected');
});

test('listPhotos expands a multi-photo row and lists a repeated photo once', () => {
  const mk = (extra) => Object.assign({ staffName: 'A', taskId: 'T1', taskName: 'Task', section: 'S', status: 'OK', remarks: '' }, extra);
  const row = mk({ date: '2026-10-21', timestamp: '2026-10-21 10:00:00', sequence: 'First',
    photoRef: 'fileid00001,fileid00002,fileid00003',
    photoTime: '2026-10-21 09:00:00,,2026-10-21 09:30:00' });
  const upd = mk({ date: '2026-10-21', timestamp: '2026-10-21 11:00:00', sequence: 'Update',
    photoRef: 'fileid00001', photoTime: '' });
  const r = C.listPhotos([row, upd], '2026-10-21', '2026-10-21', 200);
  assert.strictEqual(r.total, 3, 'one item per photo id; the repeated id is listed once');
  // Sort key = capture time, falling back to the row timestamp when a photo
  // has no time: 10:00 (no time) > 09:30 > 09:00.
  assert.deepStrictEqual(r.photos.map((p) => p.photoRef), ['fileid00002', 'fileid00003', 'fileid00001']);
  assert.deepStrictEqual(r.photos.map((p) => p.photoTime), ['', '2026-10-21 09:30:00', '2026-10-21 09:00:00'],
    'every photo carries its own capture time');
  assert.deepStrictEqual(r.photos.map((p) => p.photoIndex), [2, 3, 1], 'photoIndex is 1-based within its row');
  r.photos.forEach((p) => assert.strictEqual(p.photoCount, 3, 'photoCount is the row total'));
});

test('dashboard detail rows carry photoCount next to the raw photo lists', () => {
  const tasks = C.normalizeTasks(MPS_TASK_HEADERS, [
    ['T001', 'Opening', 'Open store', 'photo', 'Yes', 'Yes', 'Yes']
  ]).tasks;
  const subs = [{ date: '2026-10-22', taskId: 'T001', staffName: 'Abu', status: 'OK', response: 'Photo',
    photoRef: 'fileid00001,fileid00002', photoTime: '2026-10-22 09:00:00,',
    timestamp: '2026-10-22 10:00:00', sequence: 'First', submissionId: 'b1' }];
  const d = C.computeDashboard(tasks, subs, '2026-10-22', '2026-10-22', '2026-10-22');
  const row = d.detail.find((r) => r.taskId === 'T001');
  assert.ok(row, 'the submitted task must appear in the detail rows');
  assert.strictEqual(row.photoCount, 2);
  assert.strictEqual(row.photoRef, 'fileid00001,fileid00002', 'the raw comma list is kept');
});

// -- photo capture time: Sheets Date repair + section filter ----
test('cellToIstString turns a Sheets Date back into IST wall-clock text', () => {
  // A lone "2026-10-26 14:03:11" written into a Timestamp / Photo_Time cell
  // comes back from Sheets as a Date. The store's wall clock is IST, so the
  // instant + 5:30 must be read via the UTC getters (never local getters —
  // the script machine's own zone must not leak into the data).
  const d = new Date(Date.UTC(2026, 9, 26, 8, 33, 11));   // 26 Oct 08:33:11 UTC
  assert.strictEqual(C.cellToIstString(d), '2026-10-26 14:03:11');
  const late = new Date(Date.UTC(2026, 9, 26, 19, 59, 59)); // past IST midnight
  assert.strictEqual(C.cellToIstString(late), '2026-10-27 01:29:59', 'IST rolls over at 18:30 UTC');
  // Strings pass through untouched, so a comma list keeps its parts
  // index-aligned with the photo ids.
  assert.strictEqual(C.cellToIstString('2026-10-26 14:03:11'), '2026-10-26 14:03:11');
  assert.strictEqual(C.cellToIstString('a,b,,c'), 'a,b,,c', 'a comma list stays unchanged');
  assert.strictEqual(C.cellToIstString(null), '');
  assert.strictEqual(C.cellToIstString(undefined), '');
  assert.strictEqual(C.cellToIstString(new Date('junk')), '', 'an invalid Date becomes blank');
  assert.strictEqual(C.cellToIstString(42), '42');
});

test('normalizeSubmissions repairs rows written before the columns were text', () => {
  // The workbook header (Photo_Time is the capture-time column).
  const H = ['Timestamp', 'Date', 'Staff_Name', 'Role', 'Section', 'Task_ID', 'Task_Name',
    'Type', 'Response', 'Photo_URL', 'Photo_Time', 'Status', 'Remarks', 'Sequence'];
  // Old rows hold real Date objects in Timestamp / Photo_Time.
  const subs = C.normalizeSubmissions(H, [
    [new Date(Date.UTC(2026, 9, 26, 5, 30, 0)), '', 'Abu', 'Staff', 'Opening', 'T001', 'Open store',
      'photo', 'Photo', 'fileid00001', new Date(Date.UTC(2026, 9, 26, 3, 14, 5)), 'OK', '', 'First']
  ]);
  assert.strictEqual(subs[0].timestamp, '2026-10-26 11:00:00');
  assert.strictEqual(subs[0].photoTime, '2026-10-26 08:44:05');
  assert.strictEqual(subs[0].date, '2026-10-26', 'the day is recovered from the repaired timestamp');
  // New rows are plain strings and are not touched.
  const clean = C.normalizeSubmissions(H, [
    ['2026-10-26 11:00:00', '2026-10-26', 'Abu', 'Staff', 'Opening', 'T001', 'Open store',
      'photo', 'Photo', 'fileid00001', '2026-10-26 08:44:05', 'OK', '', 'First']
  ]);
  assert.strictEqual(clean[0].timestamp, '2026-10-26 11:00:00');
  assert.strictEqual(clean[0].photoTime, '2026-10-26 08:44:05');
  assert.strictEqual(clean[0].date, '2026-10-26');
});

test('listPhotos can be narrowed to a single section', () => {
  const mk = (section, ref) => ({ date: '2026-10-21', timestamp: '2026-10-21 18:00:00',
    photoRef: ref, photoTime: '2026-10-21 09:00:00', staffName: 'A', taskId: 'T1',
    taskName: 'Task', section, status: 'OK', sequence: 'First', remarks: '' });
  const subs = [mk('Opening', 'fileid00001'), mk('Closing', 'fileid00002')];
  assert.strictEqual(C.listPhotos(subs, '2026-10-21', '2026-10-21', 200).total, 2, 'no section = everything');
  const only = C.listPhotos(subs, '2026-10-21', '2026-10-21', 200, 'Closing');
  assert.strictEqual(only.total, 1, 'the filter keeps only that section');
  assert.strictEqual(only.photos[0].photoRef, 'fileid00002');
  assert.strictEqual(only.photos[0].section, 'Closing');
  assert.strictEqual(C.listPhotos(subs, '2026-10-21', '2026-10-21', 200, 'Nope').total, 0);
});

