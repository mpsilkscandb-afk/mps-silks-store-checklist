// ════════════════════════════════════════════════════════════════
//  MPS Silks — minimal XLSX writer (zero dependencies)
//  Produces a real .xlsx workbook (OOXML, stored ZIP entries) that
//  opens in Excel / LibreOffice / Google Sheets. Also provides a
//  CSV exporter with formula-injection protection.
//
//  Sheet spec: { name: 'Summary', cols: [width, ...] | null,
//                rows: [[cell, ...], ...] }
//  Cell values: string | number | boolean
//  Covered by tests/xlsx.test.js.
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // ── formula-injection guard ──────────────────────────────────
  // A user-entered value starting with =, +, -, @ (or tab/CR) can
  // be executed as a formula by spreadsheet apps when the file is
  // a CSV or when cells are typed as numbers/formulas. We prefix
  // such values with an apostrophe so they stay literal text.
  function guardFormula(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
    return s;
  }

  // ── XML helpers ──────────────────────────────────────────────
  function escXml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      // strip control characters that are invalid in XML 1.0
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function colName(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = (n - m - 1) / 26;
    }
    return s;
  }

  // ── CRC32 (for ZIP) ──────────────────────────────────────────
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ── ZIP writer (store method — no compression) ───────────────
  var DOS_TIME = 0;                          // 00:00
  var DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

  function utf8Bytes(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    // fallback
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function buildZip(files) {
    // files: [{ name, bytes }]  → Uint8Array (stored entries)
    var chunks = [];
    var central = [];
    var offset = 0;

    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

    files.forEach(function (f) {
      var nameBytes = utf8Bytes(f.name);
      var crc = crc32(f.bytes);
      var local = [].concat(
        u32(0x04034B50), u16(20), u16(0), u16(0),           // sig, version, flags, method=store
        u16(DOS_TIME), u16(DOS_DATE),
        u32(crc), u32(f.bytes.length), u32(f.bytes.length), // crc, csize, usize
        u16(nameBytes.length), u16(0)                       // name len, extra len
      );
      central.push({
        bytes: [].concat(
          u32(0x02014B50), u16(20), u16(20), u16(0), u16(0),
          u16(DOS_TIME), u16(DOS_DATE),
          u32(crc), u32(f.bytes.length), u32(f.bytes.length),
          u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
          u32(0), u32(offset)
        ),
        name: nameBytes
      });
      chunks.push(new Uint8Array(local), nameBytes, f.bytes);
      offset += local.length + nameBytes.length + f.bytes.length;
    });

    var centralStart = offset;
    var centralSize = 0;
    central.forEach(function (c) {
      chunks.push(new Uint8Array(c.bytes), c.name);
      centralSize += c.bytes.length + c.name.length;
    });
    var eocd = [].concat(
      u32(0x06054B50), u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(centralSize), u32(centralStart), u16(0)
    );
    chunks.push(new Uint8Array(eocd));

    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  // ── worksheet XML ────────────────────────────────────────────
  function sheetXml(sheet) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (sheet.cols && sheet.cols.length) {
      xml += '<cols>';
      sheet.cols.forEach(function (w, i) {
        xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (w || 12) + '" customWidth="1"/>';
      });
      xml += '</cols>';
    }
    xml += '<sheetData>';
    (sheet.rows || []).forEach(function (row, rIdx) {
      xml += '<row r="' + (rIdx + 1) + '">';
      row.forEach(function (val, cIdx) {
        if (val === null || val === undefined || val === '') return;
        var ref = colName(cIdx + 1) + (rIdx + 1);
        if (typeof val === 'number' && isFinite(val)) {
          xml += '<c r="' + ref + '"><v>' + val + '</v></c>';
        } else if (typeof val === 'boolean') {
          xml += '<c r="' + ref + '" t="b"><v>' + (val ? 1 : 0) + '</v></c>';
        } else {
          var style = (rIdx === 0 && sheet.headerStyle !== false) ? ' s="1"' : '';
          xml += '<c r="' + ref + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' +
            escXml(guardFormula(val)) + '</t></is></c>';
        }
      });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  // ── package parts ────────────────────────────────────────────
  function buildWorkbook(sheets) {
    if (!sheets || !sheets.length) throw new Error('buildWorkbook: no sheets');
    var files = [];

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';
    files.push({ name: '[Content_Types].xml', bytes: utf8Bytes(ct) });

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    files.push({ name: '_rels/.rels', bytes: utf8Bytes(rels) });

    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheets.map(function (s, i) {
        return '<sheet name="' + escXml(String(s.name || ('Sheet' + (i + 1))).slice(0, 28)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets></workbook>';
    files.push({ name: 'xl/workbook.xml', bytes: utf8Bytes(wb) });

    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    files.push({ name: 'xl/_rels/workbook.xml.rels', bytes: utf8Bytes(wbRels) });

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color rgb="FF2B1A16"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF7A1420"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFAF1DC"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '</cellXfs>' +
      '</styleSheet>';
    files.push({ name: 'xl/styles.xml', bytes: utf8Bytes(styles) });

    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', bytes: utf8Bytes(sheetXml(s)) });
    });

    return buildZip(files);
  }

  // ── CSV (with BOM for Excel) ─────────────────────────────────
  function csvCell(v) {
    var s = guardFormula(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(rows) {
    var body = (rows || []).map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n');
    return '\uFEFF' + body; // UTF-8 BOM so Excel reads Indian scripts correctly
  }

  // ── download helpers ─────────────────────────────────────────
  function triggerDownload(blob, filename) {
    var a = document.createElement('a');
    var url = global.URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      global.URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  function downloadXlsx(filename, sheets) {
    var bytes = buildWorkbook(sheets);
    triggerDownload(new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), filename);
  }

  function downloadCsv(filename, rows) {
    triggerDownload(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), filename);
  }

  var XLSX = {
    guardFormula: guardFormula,
    buildWorkbook: buildWorkbook,
    toCsv: toCsv,
    downloadXlsx: downloadXlsx,
    downloadCsv: downloadCsv
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = XLSX;
  global.XLSX = XLSX;
})(typeof window !== 'undefined' ? window : globalThis);
