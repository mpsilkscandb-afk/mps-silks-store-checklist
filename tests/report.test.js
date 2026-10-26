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
  assert.match(rep, /images\/cb-logo\.png/, 'the C&B logo is loaded for the header');
  assert.match(rep, /whiteLogo/, 'the dark artwork is recoloured white at runtime');
  assert.doesNotMatch(rep, /Implemented by/i, 'no "Implemented by" text anywhere in the PDF');
  assert.match(rep, /Page ' \+ p \+ ' of ' \+ pages/, 'every page is numbered');
  assert.match(rep, /MPS_Silks_Checklist_/, 'the filename carries staff + date');
});

test('C&B logo: mapped as images/cb-logo.png, format detected from the data URL', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  // The file exists under exactly one name, is really PNG, and HAS an alpha
  // channel (colour type 6 = RGBA or 4 = grey+alpha) so it can sit on both
  // light and dark surfaces.
  const imgs = fs.readdirSync(path.join(ROOT, 'images')).filter((f) => /^cb-logo/i.test(f));
  assert.deepStrictEqual(imgs, ['cb-logo.png'],
    'exactly one C&B logo file, named cb-logo.png (no .jpg / no duplicates)');
  const head = fs.readFileSync(path.join(ROOT, 'images', 'cb-logo.png'));
  assert.strictEqual(head.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'the logo is really PNG data');
  const colourType = head[25];   // byte 25 of a PNG: colour type in the IHDR chunk
  assert.ok(colourType === 6 || colourType === 4,
    'the logo must carry an alpha channel (got colour type ' + colourType + ')');
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
  const stale = walk(ROOT).filter((f) => /cb-logo\.jpg/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(stale.map((f) => path.relative(ROOT, f)), [],
    'no cb-logo.jpg reference may survive the switch to PNG');
  // jsPDF format comes from the loaded data URL — never hardcoded.
  const rep = require('node:fs').readFileSync(path.join(ROOT, 'js', 'report.js'), 'utf8');
  assert.doesNotMatch(rep, /addImage\([^)]*'(PNG|JPEG)'/, 'no addImage call hardcodes a format');
  assert.strictEqual(R.imgFormat('data:image/png;base64,iVBOR'), 'PNG');
  assert.strictEqual(R.imgFormat('data:image/jpeg;base64,/9j/4AA='), 'JPEG');
  assert.strictEqual(R.imgFormat('data:image/jpg;base64,/9j/4AA='), 'JPEG');
  assert.strictEqual(R.imgFormat('data:image/webp;base64,UklG'), null, 'unsupported type → skip');
  assert.strictEqual(R.imgFormat(''), null);
  assert.strictEqual(R.imgFormat(null), null);
});

test('PDF header: C&B logo goes top-right, white, aspect-true, and never under the title', () => {
  const rep = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'report.js'), 'utf8');
  // The logo is placed from the RIGHT edge with the same margin as the left.
  assert.match(rep, /cbRight - cbW/, 'the C&B logo is anchored to the right margin');
  assert.match(rep, /var cbRight = W - MR;/, 'its right margin equals the left margin (MR === ML)');
  assert.match(rep, /cbH \* dims\.width \/ dims\.height/, 'aspect ratio comes from the real pixels');
  assert.match(rep, /cbRight -= \(cbW \+ 6\)/, 'the title may not reach the logo');
  assert.match(rep, /getTextWidth\(title\) > \(cbRight - tx\)/, 'the title shrinks instead of overlapping');
  // The white version is made at runtime, keeping alpha — not a second file.
  assert.match(rep, /globalCompositeOperation = 'source-in'/, 'white logo keeps the PNG alpha');
  assert.match(rep, /fillStyle = '#FFFFFF'/, 'white logo is painted white');
  assert.match(rep, /toDataURL\('image\/png'\)/, 'white logo is exported as PNG (alpha intact)');
  // The logo is only ever drawn in the header band, never in the footer loop.
  const footerLoop = rep.slice(rep.indexOf('footer on EVERY page'));
  assert.doesNotMatch(footerLoop, /addImage|assets\.cb/, 'the footer loop draws no logo');
  assert.match(footerLoop, /Page ' \+ p \+ ' of ' \+ pages/, 'the footer keeps staff/date + page number');
});

test('whiteLogo degrades gracefully when there is no Image/canvas (Node)', async () => {
  // In Node there is no Image, so it must resolve null rather than throw —
  // the browser path is exercised by the page itself.
  const out = await R.whiteLogo('data:image/png;base64,iVBOR');
  assert.strictEqual(out, null, 'whiteLogo resolves null without a DOM');
  assert.strictEqual(await R.whiteLogo(null), null, 'whiteLogo(null) is safe');
});

test('photoStamp shows a time only when the value has a real date AND time', () => {
  // The PDF caption must never print a bare date as "Photo taken". A
  // date-only value, a midnight stamp or a pre-app (1899) serial all mean
  // "no real capture time", so photoStamp returns '' and the caption prints
  // "not recorded".
  assert.strictEqual(R.photoStamp('2026-10-26 10:31:00'), '26 Oct 2026, 10:31 AM');
  assert.strictEqual(R.photoStamp('2026-10-26'), '', 'date-only -> not recorded');
  assert.strictEqual(R.photoStamp('2026-10-26 00:00:00'), '', 'midnight -> not recorded');
  assert.strictEqual(R.photoStamp('1899-12-30 05:53:28'), '', 'Sheets time-of-day serial -> not recorded');
  assert.strictEqual(R.photoStamp(''), '');
  assert.strictEqual(R.photoStamp(null), '');
  assert.strictEqual(R.photoStamp(undefined), '');
  // prettyStamp (used for the Timestamp header) is unchanged.
  assert.strictEqual(R.prettyStamp('2026-10-26'), '26 Oct 2026', 'prettyStamp is untouched');
  assert.strictEqual(R.prettyStamp('2026-10-26 14:03:11'), '26 Oct 2026, 02:03 PM');
});

test('prettyStamp / photoStamp accept a single-digit hour', () => {
  assert.strictEqual(R.prettyStamp('2026-10-24 9:35:26'), '24 Oct 2026, 09:35 AM');
  assert.strictEqual(R.prettyStamp('2026-10-24 09:35:26'), '24 Oct 2026, 09:35 AM');
  assert.strictEqual(R.prettyStamp('2026-10-24 10:03:29'), '24 Oct 2026, 10:03 AM');
  assert.strictEqual(R.prettyStamp('2026-10-26'), '26 Oct 2026', 'a bare day stays a date');
  assert.strictEqual(R.photoStamp('2026-10-24 9:35:26'), '24 Oct 2026, 09:35 AM');
  assert.strictEqual(R.photoStamp('2026-10-24 09:35:26'), '24 Oct 2026, 09:35 AM');
  assert.strictEqual(R.photoStamp('2026-10-24 10:03:29'), '24 Oct 2026, 10:03 AM');
  // photoStamp still refuses non-times -> caption prints "not recorded"
  assert.strictEqual(R.photoStamp('2026-10-26'), '', 'date-only -> not recorded');
  assert.strictEqual(R.photoStamp(''), '', 'empty');
  assert.strictEqual(R.photoStamp('1899-12-30 05:53:28'), '', '1899 serial');
});
