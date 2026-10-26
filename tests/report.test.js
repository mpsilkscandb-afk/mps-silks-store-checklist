// PDF report data-shape tests — buildReportData is pure, so it runs in Node.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// report.js attaches to globalThis when window is absent.
require('../js/report.js');
const R = globalThis.MPSReport;

// A getChecklist-shaped response with one photo task carrying TWO photos,
// one failed yes/no, one unanswered, and a task with a photo but NO
// capture time (old data).
function fixture() {
  return {
    ok: true,
    date: '2026-10-26',
    name: 'Server Name',          // must lose to the staff argument
    role: 'Staff',
    store: { name: 'MPS Silks', location: 'KGF' },
    sections: [
      {
        section: 'Opening',
        tasks: [
          {
            taskId: 'T001', taskName: 'Shop front photo', type: 'photo', submitted: true,
            submittedStatus: {
              response: 'Photo', status: 'OK', remarks: 'All clear',
              photoRef: 'fileid00001,fileid00002',
              photoTime: '2026-10-26 09:00:00,2026-10-26 09:05:00'
            }
          },
          {
            taskId: 'T002', taskName: 'Shutter check', type: 'yesno', submitted: true,
            submittedStatus: { response: 'no', status: 'FAIL', remarks: 'Latch sticking', photoRef: '', photoTime: '' }
          }
        ]
      },
      {
        section: 'Closing',
        tasks: [
          {
            taskId: 'T003', taskName: 'Cash drawer photo', type: 'photo', submitted: true,
            submittedStatus: { response: 'Photo', status: 'OK', remarks: '', photoRef: 'fileid00003', photoTime: '' }
          },
          { taskId: 'T004', taskName: 'Sweep floor', type: 'text', submitted: false, submittedStatus: null }
        ]
      }
    ]
  };
}

const NOW = Date.parse('2026-10-26T18:30:00+05:30');   // 06:30 PM IST

test('buildReportData keeps the section order and builds one row per task', () => {
  const d = R.buildReportData(fixture(), { name: 'Abu', role: 'Sales' }, NOW);
  assert.deepStrictEqual(d.sections.map((s) => s.name), ['Opening', 'Closing'],
    'sections keep the order the backend sent');
  assert.deepStrictEqual(d.sections[0].tasks.map((t) => t.taskId), ['T001', 'T002']);
  assert.deepStrictEqual(d.sections[1].tasks.map((t) => t.taskName),
    ['Cash drawer photo', 'Sweep floor']);
});

test('buildReportData summary counts total / completed / failed / pending / photos', () => {
  const d = R.buildReportData(fixture(), { name: 'Abu' }, NOW);
  assert.deepStrictEqual(d.summary, {
    total: 4, completed: 2, failed: 1, pending: 1, completionPct: 75, photos: 3
  });
});

test('buildReportData header: staff argument wins, IST generation time, store from config', () => {
  const d = R.buildReportData(fixture(), { name: 'Abu', role: 'Sales' }, NOW);
  assert.strictEqual(d.header.staffName, 'Abu', 'the signed-in staff beats the sheet value');
  assert.strictEqual(d.header.role, 'Sales');
  assert.strictEqual(d.header.storeName, 'MPS Silks');
  assert.strictEqual(d.header.storeLocation, 'KGF');
  assert.strictEqual(d.header.reportDate, '2026-10-26');
  assert.strictEqual(d.header.generatedOn, '2026-10-26 18:30:00', '13:00 UTC = 18:30 IST');
  assert.strictEqual(d.header.title, 'Store Operations Checklist Report');
});

test('buildReportData statuses are worded, not just coded', () => {
  const d = R.buildReportData(fixture(), {}, NOW);
  const all = d.sections.flatMap((s) => s.tasks);
  assert.deepStrictEqual(all.map((t) => t.status), ['OK', 'Failed', 'OK', 'Pending']);
  assert.strictEqual(all[1].response, 'No', 'a "no" answer reads as No');
  assert.strictEqual(all[3].response, 'Not submitted');
});

test('buildReportData photo lists carry id + capture time, missing time stays blank', () => {
  const d = R.buildReportData(fixture(), {}, NOW);
  const t1 = d.sections[0].tasks[0];
  assert.deepStrictEqual(t1.photos, [
    { ref: 'fileid00001', takenAt: '2026-10-26 09:00:00' },
    { ref: 'fileid00002', takenAt: '2026-10-26 09:05:00' }
  ]);
  assert.deepStrictEqual(d.sections[1].tasks[0].photos,
    [{ ref: 'fileid00003', takenAt: '' }], 'a photo without a capture time keeps an empty one');
});

test('buildReportData never throws on empty or malformed input', () => {
  assert.deepStrictEqual(R.buildReportData(null, null, NOW).summary,
    { total: 0, completed: 0, failed: 0, pending: 0, completionPct: 0, photos: 0 });
  const junk = R.buildReportData({ sections: [{ section: 'S', tasks: [{}] }] }, {}, NOW);
  assert.strictEqual(junk.sections[0].tasks[0].status, 'Pending');
  assert.deepStrictEqual(junk.sections[0].tasks[0].photos, []);
});

test('report page: jsPDF is vendored and lazy-loaded, no CDN', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'checklist.html'), 'utf8');
  const rep = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'report.js'), 'utf8');
  assert.match(page, /src="js\/report\.js"/, 'checklist.html loads the report module');
  assert.match(page, /downloadPdf\(/, 'both PDF buttons call downloadPdf');
  const buttons = page.match(/onclick="downloadPdf\(this\)"/g) || [];
  assert.strictEqual(buttons.length, 2, 'one button on the done screen, one on the Completed tab');
  assert.match(rep, /js\/vendor\/jspdf\.umd\.min\.js/, 'jsPDF comes from js/vendor');
  assert.doesNotMatch(rep, /https?:\/\/[^"'\s]*jspdf/i, 'never from a CDN');
  assert.match(rep, /images\/cb-logo\.jpg/, 'the C&B logo sits in the footer');
  assert.match(rep, /Page ' \+ p \+ ' of ' \+ pages/, 'every page is numbered');
  assert.match(rep, /MPS_Silks_Checklist_/, 'the filename carries staff + date');
});

test('C&B logo: mapped as images/cb-logo.jpg, format detected from the data URL', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  // The file exists under exactly one name, and it really is a JPEG.
  const imgs = fs.readdirSync(path.join(ROOT, 'images')).filter((f) => /^cb-logo/i.test(f));
  assert.deepStrictEqual(imgs, ['cb-logo.jpg'],
    'exactly one C&B logo file, named cb-logo.jpg (no .png / no duplicates)');
  const head = fs.readFileSync(path.join(ROOT, 'images', 'cb-logo.jpg'));
  assert.strictEqual(head.slice(0, 3).toString('hex'), 'ffd8ff', 'the logo is really JPEG data');
  // No stale reference to the old name may remain anywhere.
  const walk = (dir) => fs.readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e);
    if (fs.statSync(full).isDirectory()) {
      // tests/ may legitimately mention the OLD name inside its own assertions
      if (['node_modules', 'dist', '.git', 'sheets', 'tests'].includes(e)) return [];
      return walk(full);
    }
    return /\.(html|js|css|md|gs|json|yml)$/.test(e) ? [full] : [];
  });
  const stale = walk(ROOT).filter((f) => /cb-logo\.png/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(stale.map((f) => path.relative(ROOT, f)), [],
    'no cb-logo.png reference may survive the rename');
  // jsPDF format comes from the loaded data URL — never hardcoded for logos.
  const rep = require('node:fs').readFileSync(path.join(ROOT, 'js', 'report.js'), 'utf8');
  assert.doesNotMatch(rep, /addImage\([^)]*'PNG'/, 'no addImage call hardcodes PNG');
  assert.strictEqual(R.imgFormat('data:image/jpeg;base64,/9j/4AA='), 'JPEG');
  assert.strictEqual(R.imgFormat('data:image/jpg;base64,/9j/4AA='), 'JPEG');
  assert.strictEqual(R.imgFormat('data:image/png;base64,iVBOR'), 'PNG');
  assert.strictEqual(R.imgFormat('data:image/webp;base64,UklG'), null, 'unsupported type → skip');
  assert.strictEqual(R.imgFormat(''), null);
  assert.strictEqual(R.imgFormat(null), null);
});
