// XLSX/CSV writer tests — validates the produced ZIP package and
// formula-injection guards, with an optional Python cross-check.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../js/xlsx.js');

// ── tiny stored-ZIP reader for assertions ──────────────────────
function readZip(bytes) {
  // find EOCD (signature 0x06054B50) scanning from the end
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i; break;
    }
  }
  assert.notStrictEqual(eocd, -1, 'ZIP end-of-central-directory not found');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const entries = {};
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    assert.strictEqual(view.getUint32(p, true), 0x02014B50, 'bad central directory signature');
    const method = view.getUint16(p + 10, true);
    const cSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header → data offset
    assert.strictEqual(view.getUint32(localOff, true), 0x04034B50, 'bad local header');
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + cSize);
    entries[name] = { method, data, text: new TextDecoder('utf-8').decode(data) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.strictEqual(cdSize > 0, true);
  return entries;
}

// ── formula guard ──────────────────────────────────────────────
test('guardFormula neutralises spreadsheet formula prefixes', () => {
  assert.strictEqual(XLSX.guardFormula('=1+1'), "'=1+1");
  assert.strictEqual(XLSX.guardFormula('+SUM(A1)'), "'+SUM(A1)");
  assert.strictEqual(XLSX.guardFormula('-2'), "'-2");
  assert.strictEqual(XLSX.guardFormula('@cmd'), "'@cmd");
  assert.strictEqual(XLSX.guardFormula('\tTAB'), "'\tTAB");
  assert.strictEqual(XLSX.guardFormula('plain text'), 'plain text');
  assert.strictEqual(XLSX.guardFormula('Cam 3 is dead'), 'Cam 3 is dead');
  assert.strictEqual(XLSX.guardFormula('₹1,200'), '₹1,200');
  assert.strictEqual(XLSX.guardFormula(null), '');
});

// ── workbook structure ────────────────────────────────────────
const sampleSheets = [
  { name: 'Summary', cols: [30, 18], rows: [['MPS Silks Report'], ['Completion %', '67%']] },
  {
    name: 'Task Details', cols: [10, 40],
    rows: [
      ['Task ID', 'Task'],
      ['T001', 'Open the store — 9:30 AM'],
      ['T002', 'Check CCTV, "recording"'],
      ['T003', '=EVIL()'],
      ['T004', 'Line\nbreak & <tags>']
    ]
  }
];

test('buildWorkbook produces a valid stored-ZIP package', () => {
  const bytes = XLSX.buildWorkbook(sampleSheets);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 500);
  // ZIP magic
  assert.deepStrictEqual([...bytes.subarray(0, 4)], [0x50, 0x4B, 0x03, 0x04]);
  const entries = readZip(bytes);
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml'
  ];
  required.forEach((name) => assert.ok(entries[name], 'missing package part: ' + name));
  // every entry uses the stored method (0)
  Object.keys(entries).forEach((k) => assert.strictEqual(entries[k].method, 0));
});

test('workbook.xml lists the sheet names and rels point at real parts', () => {
  const entries = readZip(XLSX.buildWorkbook(sampleSheets));
  const wb = entries['xl/workbook.xml'].text;
  assert.match(wb, /<sheet name="Summary"/);
  assert.match(wb, /<sheet name="Task Details"/);
  const rels = entries['xl/_rels/workbook.xml.rels'].text;
  assert.match(rels, /worksheets\/sheet1\.xml/);
  assert.match(rels, /styles\.xml/);
  const ct = entries['[Content_Types].xml'].text;
  assert.match(ct, /spreadsheetml\.sheet\.main\+xml/);
  assert.match(ct, /worksheets\/sheet1\.xml/);
});

test('cells are escaped, guarded and typed correctly', () => {
  const entries = readZip(XLSX.buildWorkbook(sampleSheets));
  const s2 = entries['xl/worksheets/sheet2.xml'].text;
  // header row uses bold style s="1"
  assert.match(s2, /<c r="A1" t="inlineStr" s="1"><is><t[^>]*>Task ID<\/t>/);
  // quotes and ampersands escaped
  assert.ok(s2.includes('&quot;recording&quot;') || s2.includes('"recording"'));
  assert.match(s2, /&amp;/); // "CCTV, & ..." escaping — the comma item has none, check below
  // formula-prefixed user text neutralised ('=EVIL() → &apos;=EVIL())
  assert.match(s2, /&apos;=EVIL\(\)/);
  // line break + angle brackets survive escaping
  assert.match(s2, /Line\nbreak &amp; &lt;tags&gt;/);
  // XML never contains raw control chars
  assert.doesNotMatch(s2, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
});

test('numeric cells are written as numbers', () => {
  const entries = readZip(XLSX.buildWorkbook([{ name: 'N', rows: [['n'], [42]] }]));
  const s = entries['xl/worksheets/sheet1.xml'].text;
  assert.match(s, /<c r="A2"><v>42<\/v><\/c>/);
  assert.match(s, /<c r="A1" t="inlineStr" s="1">/);
});

test('col names extend beyond Z', () => {
  const entries = readZip(XLSX.buildWorkbook([{ name: 'Wide', rows: [Array(30).fill('x')] }]));
  const s = entries['xl/worksheets/sheet1.xml'].text;
  assert.match(s, /r="AA1"/);
});

// ── CSV ────────────────────────────────────────────────────────
test('toCsv adds a UTF-8 BOM, quotes delimiters and guards formulas', () => {
  const csv = XLSX.toCsv([
    ['Task', 'Remarks'],
    ['T001', 'has, comma'],
    ['T002', 'has "quotes"'],
    ['T003', '=1+1']
  ]);
  assert.ok(csv.charCodeAt(0) === 0xFEFF, 'BOM required for Excel');
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[0], 'Task,Remarks');
  assert.strictEqual(lines[1], 'T001,"has, comma"');
  assert.strictEqual(lines[2], 'T002,"has ""quotes"""');
  assert.strictEqual(lines[3], 'T003,\'=1+1');
});

// ── Python cross-validation (skipped when Python is absent) ────
test('Python zipfile + openpyxl can open the generated workbook', (t) => {
  let py = null;
  for (const cmd of ['python3', 'python', 'py']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) { py = cmd; break; }
  }
  if (!py) { t.skip('Python not available for cross-validation'); return; }

  const file = path.join(os.tmpdir(), 'mps-xlsx-test.xlsx');
  fs.writeFileSync(file, Buffer.from(XLSX.buildWorkbook(sampleSheets)));

  // 1) zip integrity
  const zipTest = spawnSync(py, ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
  assert.strictEqual(zipTest.status, 0, 'zipfile -t failed: ' + zipTest.stderr);

  // 2) openpyxl round-trip (skip if openpyxl missing)
  const script = [
    'import sys',
    'try:',
    '    import openpyxl',
    'except ImportError:',
    '    sys.exit(2)',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'assert wb.sheetnames == ["Summary", "Task Details"], wb.sheetnames',
    'ws = wb["Task Details"]',
    'assert ws["A4"].value == "T003", ws["A4"].value',
    'v = ws["B4"].value',
    'assert v == chr(39) + "=EVIL()", repr(v)',
    'assert wb["Summary"]["A1"].value == "MPS Silks Report"',
    'print("OPENPYXL_OK")'
  ].join('\n');
  const round = spawnSync(py, ['-c', script, file], { encoding: 'utf8' });
  if (round.status === 2) { t.skip('openpyxl not installed'); return; }
  assert.strictEqual(round.status, 0, 'openpyxl validation failed: ' + round.stderr);
  assert.match(round.stdout, /OPENPYXL_OK/);
  fs.unlinkSync(file);
});
