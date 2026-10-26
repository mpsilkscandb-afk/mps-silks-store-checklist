// ════════════════════════════════════════════════════════════════
//  MPS Silks — tiny dependency-free JPEG EXIF reader
//
//  Why: the photo's TRUE capture time lives in the EXIF block of the
//  original JPEG. compressImage() redraws the image on a canvas, which
//  strips EXIF — so the time must be read from the original File first.
//
//  EXIF carries NO time zone: "2026:10:26 14:03:11" is the phone's
//  local wall-clock time, which for the store phones is IST.
//
//  findDateTime(bytes) is pure (Uint8Array in, 'YYYY-MM-DD HH:MM:SS'
//  or null out) and is covered by tests/pages.test.js.
//  readFileDateTime(file) is the browser wrapper (reads the first 256 KB).
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  function u16(b, o, le) {
    return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  }
  function u32(b, o, le) {
    return le
      ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
      : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  }
  function hasBytes(b, o, n) { return o >= 0 && n >= 0 && o + n <= b.length; }
  function isExifHeader(b, o) {
    // "Exif\0\0"
    return hasBytes(b, o, 6) && b[o] === 0x45 && b[o + 1] === 0x78 &&
      b[o + 2] === 0x69 && b[o + 3] === 0x66 && b[o + 4] === 0 && b[o + 5] === 0;
  }
  function bytesEqual(b, o, s) {
    if (!hasBytes(b, o, s.length)) return false;
    for (var i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  }

  // Locate the first APP1 ("Exif\0\0") segment of a JPEG.
  function findExifBlock(b) {
    if (!hasBytes(b, 0, 4)) return null;
    if (!(b[0] === 0xFF && b[1] === 0xD8)) return null;   // not a JPEG (PNG/HEIC/…)
    var pos = 2;
    while (hasBytes(b, pos, 4)) {
      if (b[pos] !== 0xFF) return null;                    // desynced — give up
      var marker = b[pos + 1];
      if (marker === 0xFF) { pos += 1; continue; }         // fill byte
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { pos += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return null; // SOS / EOI: no EXIF
      var len = u16(b, pos + 2, false);
      if (len < 2) return null;
      var segStart = pos + 4, segLen = len - 2;
      if (marker === 0xE1 && isExifHeader(b, segStart)) {
        return { start: segStart + 6, end: Math.min(segStart + segLen, b.length) };
      }
      pos += 2 + len;
    }
    return null;
  }

  // Read one IFD: returns { tags: {tag: valueOffsetInBytes}, next: absolute
  // offset of the next IFD } — offsets are already relative to the TIFF base.
  function readIfd(b, tiffStart, end, ifdRel, le) {
    var ifd = tiffStart + ifdRel;
    if (!hasBytes(b, ifd, 2)) return null;
    var count = u16(b, ifd, le);
    var tags = {};
    var p = ifd + 2;
    for (var i = 0; i < count; i++, p += 12) {
      if (!hasBytes(b, p, 12)) break;
      var tag = u16(b, p, le);
      var type = u16(b, p + 2, le);
      var n = u32(b, p + 4, le);
      var sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      var size = sizes[type] || 0;
      if (!size) continue;                                  // unknown type: skip
      var total = size * n;
      if (total <= 4) {                                     // value stored inline
        tags[tag] = { rel: p + 8, len: total };
      } else {
        var off = tiffStart + u32(b, p + 8, le);
        if (off >= tiffStart && off < end) tags[tag] = { rel: off, len: total };
      }
    }
    return { tags: tags, end: ifd + 2 + count * 12 };
  }

  function readAscii(b, tiffStart, end, entry) {
    if (!entry) return null;
    var o = entry.rel, len = entry.len;
    if (o < tiffStart || !hasBytes(b, o, len)) return null;
    if (o + len > end) return null;
    var out = '';
    for (var i = 0; i < len && b[o + i] !== 0; i++) out += String.fromCharCode(b[o + i]);
    return out.trim();
  }

  // "2026:10:26 14:03:11" → "2026-10-26 14:03:11" (null when not a timestamp).
  function normalizeDateTime(s) {
    if (!s) return null;
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s).trim());
    if (!m) return null;
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
  }

  // Pure entry point: Uint8Array of a JPEG → 'YYYY-MM-DD HH:MM:SS' | null.
  // Preference: EXIF DateTimeOriginal (0x9003) → DateTimeDigitized (0x9004)
  // → IFD0 DateTime (0x0132).
  function findDateTime(bytes) {
    try {
      var b = bytes;
      if (!b || typeof b.length !== 'number') return null;
      var block = findExifBlock(b);
      if (!block) return null;
      var tiffStart = block.start, end = block.end;
      if (!hasBytes(b, tiffStart, 8)) return null;
      var le;
      if (b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49) le = true;
      else if (b[tiffStart] === 0x4D && b[tiffStart + 1] === 0x4D) le = false;
      else return null;
      if (u16(b, tiffStart + 2, le) !== 42) return null;
      var ifd0 = readIfd(b, tiffStart, end, u32(b, tiffStart + 4, le), le);
      if (!ifd0) return null;

      var found = normalizeDateTime(readAscii(b, tiffStart, end, ifd0.tags[0x9003]));
      if (found) return found;

      var exifPtr = ifd0.tags[0x8769];
      if (exifPtr) {
        // 0x8769 holds the OFFSET of the Exif sub-IFD (relative to the TIFF
        // header), stored inline — dereference it before parsing.
        var exifRel = u32(b, exifPtr.rel, le);
        var exifIfd = readIfd(b, tiffStart, end, exifRel, le);
        if (exifIfd) {
          found = normalizeDateTime(readAscii(b, tiffStart, end, exifIfd.tags[0x9003])) ||
            normalizeDateTime(readAscii(b, tiffStart, end, exifIfd.tags[0x9004]));
          if (found) return found;
        }
      }
      return normalizeDateTime(readAscii(b, tiffStart, end, ifd0.tags[0x0132]));
    } catch (e) {
      return null;   // a damaged block must never break photo capture
    }
  }

  // Browser wrapper: read the head of the File (EXIF always sits at the
  // start) and return the capture time, or null for non-JPEG/broken files.
  function readFileDateTime(file) {
    var none = typeof Promise !== 'undefined' ? Promise.resolve(null) : null;
    try {
      if (!file || typeof file.slice !== 'function') return none;
      var head = file.slice(0, 262144);
      if (head.arrayBuffer) {
        return head.arrayBuffer().then(function (buf) {
          return findDateTime(new Uint8Array(buf));
        }).catch(function () { return null; });
      }
      if (typeof FileReader === 'undefined') return none;
      return new Promise(function (resolve) {
        var r = new FileReader();
        r.onload = function (e) { resolve(findDateTime(new Uint8Array(e.target.result))); };
        r.onerror = function () { resolve(null); };
        r.readAsArrayBuffer(head);
      });
    } catch (e) {
      return none;
    }
  }

  global.EXIF = { findDateTime: findDateTime, readFileDateTime: readFileDateTime };
})(typeof window !== 'undefined' ? window : globalThis);
