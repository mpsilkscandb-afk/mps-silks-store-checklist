// IST date-helper tests (shared frontend logic).
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// dates.js attaches to globalThis in Node.
require('../js/dates.js');
const Dates = globalThis.Dates;

test('parse accepts valid dates and rejects junk', () => {
  assert.deepStrictEqual(Dates.parse('2026-10-20'), { y: 2026, m: 10, d: 20 });
  assert.strictEqual(Dates.parse('20-10-2026'), null);
  assert.strictEqual(Dates.parse('2026-13-01'), null);
  assert.strictEqual(Dates.parse(''), null);
  assert.strictEqual(Dates.parse(null), null);
});

test('addDays crosses month, year and leap boundaries', () => {
  assert.strictEqual(Dates.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(Dates.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(Dates.addDays('2028-02-28', 1), '2028-02-29'); // leap year
  assert.strictEqual(Dates.addDays('2027-02-28', 1), '2027-03-01'); // non-leap
  assert.strictEqual(Dates.addDays('2026-10-20', -30), '2026-09-20');
});

test('dayRange is inclusive, ordered and capped', () => {
  assert.deepStrictEqual(Dates.range('2026-10-18', '2026-10-20'),
    ['2026-10-18', '2026-10-19', '2026-10-20']);
  assert.deepStrictEqual(Dates.range('2026-10-20', '2026-10-18'), []); // invalid order
  assert.strictEqual(Dates.range('2026-01-01', '2026-12-31').length, 365);
  assert.strictEqual(Dates.range('2026-01-01', '2026-12-31', 92).length, 92);
});

test('formatting uses Indian month/day names', () => {
  assert.strictEqual(Dates.formatFull('2026-10-20'), 'Tuesday, 20 Oct 2026');
  assert.strictEqual(Dates.formatShort('2026-10-20'), 'Tue 20 Oct');
  assert.strictEqual(Dates.dayOfWeek('2026-10-18'), 'Sunday');
  assert.strictEqual(Dates.formatFull('junk'), 'junk');
});

test('IST boundary: 18:30 UTC is already the next day in Asia/Kolkata', (t) => {
  // Verify the runtime has full ICU for Asia/Kolkata, else skip.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch (e) {
    t.skip('ICU with Asia/Kolkata unavailable');
    return;
  }
  const instant = new Date(Date.UTC(2026, 9, 20, 18, 30, 0)); // 20 Oct 18:30 UTC
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(instant).forEach((p) => { parts[p.type] = p.value; });
  const istDate = parts.year + '-' + parts.month + '-' + parts.day;
  const istHour = parts.hour === '24' ? '00' : parts.hour;
  assert.strictEqual(istDate, '2026-10-21', 'IST date must roll over at 18:30 UTC');
  assert.strictEqual(istHour + ':' + parts.minute, '00:00');
});

test('IST boundary: 18:29 UTC is still the same day in Asia/Kolkata', (t) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch (e) {
    t.skip('ICU with Asia/Kolkata unavailable');
    return;
  }
  const instant = new Date(Date.UTC(2026, 9, 20, 18, 29, 0));
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant).forEach((p) => { parts[p.type] = p.value; });
  assert.strictEqual(parts.year + '-' + parts.month + '-' + parts.day, '2026-10-20');
});

// -- photo-time display helpers ---------------------------------
test('pretty renders an IST timestamp as "26 Oct 2026, 02:03 PM"', () => {
  assert.strictEqual(Dates.pretty('2026-10-26 14:03:11'), '26 Oct 2026, 02:03 PM');
  assert.strictEqual(Dates.pretty('2026-10-26 00:05:09'), '26 Oct 2026, 12:05 AM');
  assert.strictEqual(Dates.pretty('2026-10-26 12:00:00'), '26 Oct 2026, 12:00 PM');
  assert.strictEqual(Dates.pretty('2026-10-26 09:05'), '26 Oct 2026, 09:05 AM', 'seconds optional');
  assert.strictEqual(Dates.pretty('2026-10-26'), '26 Oct 2026', 'a bare day stays a date');
  // Unreadable input (e.g. old String(Date) garbage) must come back blank so
  // callers can say "Photo time not recorded" instead of showing nonsense.
  assert.strictEqual(Dates.pretty('Mon Oct 26 2026 14:03:11 GMT+0530'), '');
  assert.strictEqual(Dates.pretty('junk'), '');
  assert.strictEqual(Dates.pretty(''), '');
  assert.strictEqual(Dates.pretty(null), '');
  assert.strictEqual(Dates.pretty(undefined), '');
});

test('fromMs converts an instant to IST date/time parts', () => {
  const p = Dates.fromMs(Date.UTC(2026, 9, 26, 8, 33, 11));   // 26 Oct 08:33:11 UTC
  assert.strictEqual(p.date, '2026-10-26');
  assert.strictEqual(p.time, '14:03:11');
  assert.strictEqual(p.hm, '14:03');
  const rolled = Dates.fromMs(Date.UTC(2026, 9, 26, 19, 59, 0));
  assert.strictEqual(rolled.date, '2026-10-27', '19:59 UTC is already the next IST day');
  assert.strictEqual(Dates.fromMs('junk'), null);
  assert.strictEqual(Dates.fromMs(null), null);
});

// -- photo capture times must carry a REAL date AND time ----------------
// A date-only value, a midnight timestamp (a date-only Sheets cell read
// back as a Date) or a pre-app serial (Sheets time-of-day cells serialise
// as 1899-12-30) is NOT a recorded capture time, so prettyPhoto returns ''
// and the caller shows "Photo time not recorded" — never a bare date.
test('prettyPhoto shows a time only when the value has a real date AND time', () => {
  // real capture times keep their time
  assert.strictEqual(Dates.prettyPhoto('2026-10-26 10:31:00'), '26 Oct 2026, 10:31 AM');
  assert.strictEqual(Dates.prettyPhoto('2026-10-26 00:05:09'), '26 Oct 2026, 12:05 AM',
    'a genuine just-after-midnight capture still shows');
  // THE BUG: a bare date must never be shown as a capture time
  assert.strictEqual(Dates.prettyPhoto('2026-10-26'), '', 'date-only ? not recorded');
  // midnight = a date-only Sheets cell, so it is not a real capture time
  assert.strictEqual(Dates.prettyPhoto('2026-10-26 00:00:00'), '', 'midnight ? not recorded');
  assert.strictEqual(Dates.prettyPhoto('2026-10-26 00:00'), '', 'midnight (no seconds) ? not recorded');
  // Sheets time-of-day cells serialise as 1899-12-30 (+IST LMT 05:53:28)
  assert.strictEqual(Dates.prettyPhoto('1899-12-30 05:53:28'), '', 'pre-app serial ? not recorded');
  // empty / unreadable
  assert.strictEqual(Dates.prettyPhoto(''), '');
  assert.strictEqual(Dates.prettyPhoto(null), '');
  assert.strictEqual(Dates.prettyPhoto(undefined), '');
  assert.strictEqual(Dates.prettyPhoto('junk'), '');
  // 'pretty' itself is unchanged (the Timestamp column still shows a date)
  assert.strictEqual(Dates.pretty('2026-10-26'), '26 Oct 2026', 'pretty is untouched');
});
