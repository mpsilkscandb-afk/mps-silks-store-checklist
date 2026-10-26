// ════════════════════════════════════════════════════════════════
//  MPS Silks — staff PDF report (A4, generated in the browser)
//
//  buildReportData(checklistResponse, staff, now) is PURE (no DOM,
//  no network) and is covered by tests/report.test.js.
//  downloadReport(data, opts) draws the PDF with the VENDORED jsPDF
//  (js/vendor/jspdf.umd.min.js, loaded lazily on demand — no CDN).
//
//  Design notes:
//  • A4 portrait, standard PDF fonts only (no font files to ship).
//  • Words, never glyphs: statuses say "OK / Failed / Pending" (and
//    are also coloured), so the report survives greyscale printing.
//  • Maroon #7B1E28 + gold #C9972C, the MPS Silks palette.
//  • A footer with page numbers runs on EVERY page.
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var IST_OFFSET_MS = 5.5 * 3600000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Epoch ms → IST parts, with no Intl dependency (deterministic in tests).
  function istParts(ms) {
    var d = new Date(Number(ms) + IST_OFFSET_MS);
    if (isNaN(d.getTime())) return null;
    return {
      date: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
      time: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds())
    };
  }

  // '2026-10-26 14:03:11' → '26 Oct 2026, 02:03 PM' ('' when unreadable).
  function prettyStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || '').trim());
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    var out = d + ' ' + MONTHS[mo - 1] + ' ' + y;
    if (m[4] !== undefined) {
      var hh = +m[4], mm = m[5];
      if (hh > 23 || +mm > 59) return out;
      var ampm = hh >= 12 ? 'PM' : 'AM';
      var h12 = hh % 12 || 12;
      out += ', ' + pad2(h12) + ':' + mm + ' ' + ampm;
    }
    return out;
  }

  // Keep the PDF inside standard-font territory: no emoji, no ₹, no
  // typographic dashes (they render as boxes in the 14 core fonts).
  function safeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/₹/g, 'Rs.')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/→/g, '->')
      .replace(/[✓✔]/g, 'OK')
      .replace(/[\uD800-\uDFFF]/g, '');   // emoji surrogates
  }

  // One report row per task: {taskId, taskName, type, response, status,
  // remarks, photos:[{ref, takenAt}]} — status is always worded.
  function toRow(t, st) {
    var refs = String((st && st.photoRef) || '').split(',');
    var times = String((st && st.photoTime) || '').split(',');
    var photos = [];
    refs.forEach(function (raw, i) {
      var ref = String(raw).trim();
      if (ref) photos.push({ ref: ref, takenAt: String(times[i] === undefined ? '' : times[i]).trim() });
    });
    var type = String(t.type || '').toLowerCase();
    var rawResp = st ? String(st.response || '') : '';
    var response;
    if (!st) response = 'Not submitted';
    else if (type === 'yesno') response = /^y/i.test(rawResp) ? 'Yes' : (/^n/i.test(rawResp) ? 'No' : rawResp);
    else if (type === 'rating') response = rawResp ? rawResp + ' / 5' : 'Not answered';
    else if (type === 'photo') response = photos.length ? 'Photo (' + photos.length + ')' : 'Photo';
    else response = rawResp || 'Not answered';
    var status = !st ? 'Pending'
      : (String(st.status || '').toUpperCase() === 'FAIL' ? 'Failed' : 'OK');
    return {
      taskId: String(t.taskId || ''),
      taskName: String(t.taskName || ''),
      type: String(t.type || ''),
      response: safeText(response),
      status: status,
      remarks: safeText((st && st.remarks) || ''),
      photos: photos
    };
  }

  // PURE: a getChecklist response (+ the signed-in staff + a fixed "now")
  // → everything the renderer needs. No DOM, no network, no Date.now()
  // unless "now" is omitted.
  function buildReportData(checklistResponse, staff, now) {
    var res = checklistResponse || {};
    var s = staff || {};
    var nowMs = now === undefined || now === null
      ? Date.now()
      : (now instanceof Date ? now.getTime() : Number(now));
    var gen = istParts(nowMs) || { date: '', time: '' };
    var store = res.store || {};
    var header = {
      title: 'Store Operations Checklist Report',
      storeName: safeText(store.name || 'MPS Silks'),
      storeLocation: safeText(store.location || ''),
      staffName: safeText(s.name || res.name || ''),
      role: safeText(s.role || res.role || ''),
      reportDate: String(res.date || ''),
      generatedOn: gen.date + (gen.time ? ' ' + gen.time : '')
    };
    var sections = [];
    var total = 0, completed = 0, failed = 0, pending = 0, photos = 0;
    (res.sections || []).forEach(function (sec) {
      var rows = [];
      (sec.tasks || []).forEach(function (t) {
        var st = t.submitted ? (t.submittedStatus || {}) : null;
        var row = toRow(t, st);
        total++;
        if (row.status === 'OK') completed++;
        else if (row.status === 'Failed') failed++;
        else pending++;
        photos += row.photos.length;
        rows.push(row);
      });
      if (rows.length) sections.push({ name: safeText(sec.section || ''), tasks: rows });
    });
    return {
      header: header,
      summary: {
        total: total,
        completed: completed,
        failed: failed,
        pending: pending,
        completionPct: total > 0 ? Math.round(((completed + failed) / total) * 100) : 0,
        photos: photos
      },
      sections: sections
    };
  }

  // ── browser half (never loaded by the Node tests) ────────────
  function ensureJsPdf() {
    if (global.jspdf && global.jspdf.jsPDF) return Promise.resolve(global.jspdf.jsPDF);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/vendor/jspdf.umd.min.js';        // vendored — never a CDN
      s.onload = function () {
        if (global.jspdf && global.jspdf.jsPDF) resolve(global.jspdf.jsPDF);
        else reject(new Error('The PDF library loaded but is not usable.'));
      };
      s.onerror = function () { reject(new Error('The PDF library could not be loaded.')); };
      document.head.appendChild(s);
    });
  }

  // Load an image (same-origin URL or data URL) as a data URL that KEEPS THE
  // FILE'S OWN FORMAT — images/cb-logo.jpg stays JPEG instead of being
  // re-encoded to PNG on a canvas (that also keeps its pixels untouched).
  function toDataUrl(src) {
    if (!src) return Promise.resolve(null);
    if (/^data:/i.test(src)) return Promise.resolve(src);   // already a data URL
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch(src, { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) {
        if (!b) return null;
        if (!/^image\//i.test(b.type || '')) return null;
        return new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };   // "data:image/jpeg;base64,…"
          fr.onerror = function () { resolve(null); };
          fr.readAsDataURL(b);
        });
      })
      .catch(function () { return null; });                  // missing file → skip quietly
  }

  // jsPDF needs the format name; read it from the data URL we actually loaded
  // ('JPEG' for image/jpeg, 'PNG' for image/png) instead of hardcoding one.
  function imgFormat(dataUrl) {
    var m = /^data:image\/(jpe?g|png|gif|webp)/i.exec(String(dataUrl || ''));
    if (!m) return null;
    var t = m[1].toLowerCase();
    if (t === 'jpg') t = 'jpeg';
    return (t === 'jpeg' || t === 'png') ? t.toUpperCase() : null;
  }

  function addImage(doc, dataUrl, x, y, w, h) {
    var fmt = imgFormat(dataUrl);
    if (!fmt) return false;
    try { doc.addImage(dataUrl, fmt, x, y, w, h); return true; }
    catch (e) { return false; }
  }

  // Photo thumbs are re-compressed small so the PDF stays email/phone friendly.
  function shrinkPhoto(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl) { resolve(null); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h) { resolve(null); return; }
          if (w > 800) { h = Math.round(h * 800 / w); w = 800; }
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.6));
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  // Fetch every distinct photo id with a max of 3 in flight.
  function fetchPhotos(refs, loader, onProgress) {
    var out = {}, i = 0, active = 0, done = 0, total = refs.length;
    return new Promise(function (resolve) {
      if (!total) { resolve(out); return; }
      function next() {
        while (active < 3 && i < total) {
          (function (ref) {
            active++;
            Promise.resolve().then(function () { return loader(ref); })
              .then(function (url) { out[ref] = url; })
              .catch(function () { out[ref] = null; })       // → "Photo unavailable"
              .then(function () {
                active--; done++;
                if (onProgress) onProgress('Preparing PDF... ' + done + '/' + total + ' photos');
                if (done === total) resolve(out); else next();
              });
          })(refs[i++]);
        }
      }
      next();
    });
  }

  function downloadReport(data, opts) {
    var o = opts || {};
    var loader = o.photoLoader;
    var onProgress = o.onProgress || function () {};
    var jsPdfCtor;
    var logoMps = null, logoCb = null;
    return ensureJsPdf().then(function (Ctor) {
      jsPdfCtor = Ctor;
      var refs = [];
      data.sections.forEach(function (sec) {
        sec.tasks.forEach(function (task) {
          task.photos.forEach(function (ph) {
            if (refs.indexOf(ph.ref) === -1) refs.push(ph.ref);
          });
        });
      });
      return Promise.all([
        loader ? fetchPhotos(refs, loader, onProgress) : Promise.resolve({}),
        toDataUrl('images/mps-logo.png'),      // MPS header logo
        toDataUrl('images/cb-logo.jpg')        // footer logo (optional)
      ]).then(function (r) {
        return { photos: r[0], mps: r[1], cb: r[2] };
      });
    }).then(function (assets) {
      onProgress('Preparing PDF...');
      return renderPdf(jsPdfCtor, data, assets, onProgress).then(function (pdf) {
        var name = 'MPS_Silks_Checklist_' +
          (data.header.staffName || 'Staff').replace(/[^\w-]+/g, '_') + '_' +
          (data.header.reportDate || (new Date().toISOString().slice(0, 10))) + '.pdf';
        savePdf(pdf, name);
        onProgress('');
        return name;
      });
    }).catch(function (e) {
      onProgress('');
      throw e;
    });
  }

  function renderPdf(jsPdfCtor, data, assets, onProgress) {
    var doc = new jsPdfCtor({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    var W = 210, H = 297, ML = 14, MR = 14, CW = W - ML - MR;
    var FOOT = 16;                       // reserved strip at the bottom
    var maxY = H - FOOT;
    var MAROON = [123, 30, 40], GOLD = [201, 151, 44];
    var GREEN = [30, 107, 58], RED = [179, 38, 30], AMBER = [176, 110, 10];
    var INK = [40, 36, 34], INK60 = [112, 106, 100], CREAM = [255, 248, 231];
    var IVORY = [250, 246, 237], LINE = [226, 217, 200];

    // The photo thumbs, shrunk once, keyed by file id.
    var thumbs = {};
    var shrinkJobs = [];
    Object.keys(assets.photos).forEach(function (ref) {
      if (assets.photos[ref]) {
        shrinkJobs.push(shrinkPhoto(assets.photos[ref]).then(function (t) { thumbs[ref] = t; }));
      }
    });

    return Promise.all(shrinkJobs).then(function () {
      var y = 0;

      function need(h) {
        if (y + h > maxY) { doc.addPage(); y = 20; return true; }
        return false;
      }
      function line(x1, yy, x2) { doc.setDrawColor.apply(doc, LINE); doc.line(x1, yy, x2, yy); }

      // ── page 1 header band ─────────────────────────────────
      doc.setFillColor.apply(doc, MAROON);
      doc.rect(0, 0, W, 30, 'F');
      var tx = ML;
      if (assets.mps && addImage(doc, assets.mps, ML, 6, 18, 18)) tx = ML + 22;
      doc.setTextColor(255, 248, 231);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text(safeText(data.header.title), tx, 13);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(226, 200, 140);
      doc.text(safeText(data.header.storeName + (data.header.storeLocation ? ' - ' + data.header.storeLocation : '')), tx, 19.5);
      y = 36;

      // ── who / when box ─────────────────────────────────────
      var infoH = 20;
      doc.setFillColor.apply(doc, IVORY);
      doc.setDrawColor.apply(doc, LINE);
      doc.rect(ML, y, CW, infoH, 'FD');
      doc.setTextColor.apply(doc, INK);
      doc.setFontSize(9);
      var col = [
        ['Staff', data.header.staffName || '-'],
        ['Role', data.header.role || '-'],
        ['Report date', data.header.reportDate ? (window.Dates && window.Dates.formatFull ? window.Dates.formatFull(data.header.reportDate) : data.header.reportDate) : '-'],
        ['Generated on', prettyStamp(data.header.generatedOn) ? prettyStamp(data.header.generatedOn) + ' IST' : (data.header.generatedOn || '-')]
      ];
      var cwid = CW / col.length;
      col.forEach(function (c, i) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor.apply(doc, INK60);
        doc.setFontSize(7.5);
        doc.text(safeText(c[0]), ML + i * cwid + 5, y + 8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor.apply(doc, MAROON);
        doc.setFontSize(10);
        doc.text(doc.splitTextToSize(safeText(c[1]), cwid - 8)[0] || '-', ML + i * cwid + 5, y + 14);
        if (i) { doc.setDrawColor.apply(doc, LINE); doc.line(ML + i * cwid, y + 3, ML + i * cwid, y + infoH - 3); }
      });
      y += infoH + 6;

      // ── summary strip ──────────────────────────────────────
      var sm = data.summary;
      var stats = [
        ['Total tasks', String(sm.total)],
        ['Completed OK', String(sm.completed)],
        ['Failed / No', String(sm.failed)],
        ['Pending', String(sm.pending)],
        ['Completion', sm.completionPct + '%'],
        ['Photos', String(sm.photos)]
      ];
      var boxH = 18, bw = CW / stats.length;
      doc.setFillColor.apply(doc, CREAM);
      doc.setDrawColor.apply(doc, GOLD);
      doc.rect(ML, y, CW, boxH, 'FD');
      stats.forEach(function (st, i) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor.apply(doc, i === 2 && +st[1] > 0 ? RED : (i === 4 ? MAROON : INK));
        doc.setFontSize(13);
        doc.text(st[1], ML + i * bw + bw / 2, y + 9, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setTextColor.apply(doc, INK60);
        doc.setFontSize(7);
        doc.text(st[0], ML + i * bw + bw / 2, y + 14.5, { align: 'center' });
        if (i) { doc.setDrawColor.apply(doc, LINE); doc.line(ML + i * bw, y + 3, ML + i * bw, y + boxH - 3); }
      });
      y += boxH + 8;

      // ── per-section tables ─────────────────────────────────
      var COLS = [
        ['Task', 60], ['Response', 28], ['Status', 22], ['Remarks', CW - 110]
      ];
      function statusColor(s) { return s === 'OK' ? GREEN : (s === 'Failed' ? RED : AMBER); }

      function tableHeader() {
        doc.setFillColor.apply(doc, MAROON);
        doc.rect(ML, y, CW, 8, 'F');
        doc.setTextColor(255, 248, 231);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        var x = ML;
        COLS.forEach(function (c) {
          doc.text(c[0], x + 3, y + 5.4);
          x += c[1];
        });
        y += 8;
      }

      data.sections.forEach(function (sec) {
        need(24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11.5);
        doc.setTextColor.apply(doc, MAROON);
        doc.text(safeText(sec.name), ML, y + 5);
        y += 7;
        doc.setDrawColor.apply(doc, GOLD);
        doc.setLineWidth(0.6);
        doc.line(ML, y, ML + CW, y);
        doc.setLineWidth(0.2);
        y += 2.5;
        tableHeader();
        sec.tasks.forEach(function (task) {
          var nameLines = doc.splitTextToSize(safeText(task.taskName) || '-', COLS[0][1] - 6);
          var remLines = doc.splitTextToSize(task.remarks || '-', COLS[3][1] - 6);
          var rowsN = Math.max(nameLines.length, remLines.length, 1);
          var rowH = rowsN * 4.2 + 3.6;
          if (y + rowH > maxY) { doc.addPage(); y = 20; tableHeader(); }
          doc.setFillColor.apply(doc, (sec.tasks.indexOf(task) % 2) ? IVORY : [255, 255, 255]);
          doc.rect(ML, y, CW, rowH, 'F');
          doc.setDrawColor.apply(doc, LINE);
          doc.line(ML, y + rowH, ML + CW, y + rowH);
          var x = ML;
          doc.setTextColor.apply(doc, INK);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.text(nameLines, x + 3, y + 6); x += COLS[0][1];
          doc.text(task.response || '-', x + 3, y + 6); x += COLS[1][1];
          doc.setFont('helvetica', 'bold');
          doc.setTextColor.apply(doc, statusColor(task.status));
          doc.text(task.status, x + 3, y + 6); x += COLS[2][1];
          doc.setFont('helvetica', 'normal');
          doc.setTextColor.apply(doc, task.remarks ? INK : INK60);
          doc.text(remLines, x + 3, y + 6);
          y += rowH;
        });

        // ── this section's photos: 2 per row, ~55 mm thumbs ──
        var phs = [];
        sec.tasks.forEach(function (task) {
          task.photos.forEach(function (ph, i) {
            phs.push({ task: task.taskName, ref: ph.ref, takenAt: ph.takenAt, idx: i + 1, count: task.photos.length });
          });
        });
        if (phs.length) {
          need(20);
          y += 5;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          doc.setTextColor.apply(doc, MAROON);
          doc.text('Photos (' + phs.length + ')', ML, y + 4);
          y += 7;
          var TW = 55, GAP = CW - 2 * TW, capH = 11;
          phs.forEach(function (ph, i) {
            var colI = i % 2;
            var img = thumbs[ph.ref] || null;
            var ih = img ? Math.min(TW * 0.75, 55) : 30;   // landscape-ish box
            var blockH = ih + capH;
            if (y + blockH > maxY) { doc.addPage(); y = 20; }
            var x = ML + colI * (TW + GAP);
            doc.setDrawColor.apply(doc, LINE);
            doc.setFillColor.apply(doc, IVORY);
            doc.rect(x, y, TW, ih, 'FD');
            if (img) {
              // keep the aspect ratio inside the box
              var w = TW - 2, h = 36;
              try {
                var dims = doc.getImageProperties(img);
                h = (dims.height && dims.width) ? (TW - 2) * dims.height / dims.width : ih - 2;
                if (h > ih - 2) { h = ih - 2; w = dims.width ? h * dims.width / dims.height : w; }
              } catch (e) {}
              if (!addImage(doc, img, x + (TW - w) / 2, y + (ih - h) / 2, w, h)) img = null;
            }
            if (!img) {
              doc.setFont('helvetica', 'italic');
              doc.setFontSize(8);
              doc.setTextColor.apply(doc, INK60);
              doc.text('Photo unavailable', x + TW / 2, y + ih / 2, { align: 'center' });
            }
            var taken = prettyStamp(ph.takenAt);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor.apply(doc, INK);
            doc.text('Photo taken: ' + (taken ? taken + ' IST' : 'not recorded'), x, y + ih + 4);
            doc.setTextColor.apply(doc, INK60);
            doc.text('Photo ' + ph.idx + ' of ' + ph.count + ' - ' + safeText(ph.task), x, y + ih + 8);
            if (colI === 1) y += blockH + 2;
            else if (i === phs.length - 1) y += blockH + 2;   // odd last one
          });
        }
        y += 6;
      });

      if (data.sections.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.setTextColor.apply(doc, INK60);
        doc.text('No tasks were submitted for this day.', ML, y + 5);
      }

      // ── footer on EVERY page ───────────────────────────────
      var pages = doc.getNumberOfPages();
      var footerLeft = 'MPS Silks Store Operations Checklist - ' +
        (data.header.staffName || '-') + ' - ' + (data.header.reportDate || '-');
      for (var p = 1; p <= pages; p++) {
        doc.setPage(p);
        doc.setDrawColor.apply(doc, LINE);
        doc.line(ML, H - 13, W - MR, H - 13);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor.apply(doc, INK60);
        doc.text(safeText(footerLeft), ML, H - 9);
        doc.text('Page ' + p + ' of ' + pages, W - MR, H - 9, { align: 'right' });
        if (assets.cb) {                  // "Implemented by" logo (format from data URL)
          if (addImage(doc, assets.cb, W - MR - 8, H - 12.4, 8, 8)) {
            doc.setFontSize(6.5);
            doc.text('Implemented by', W - MR - 8 - 2, H - 8, { align: 'right' });
          }
        }
      }
      return doc;
    });
  }

  // doc.save() covers desktop + Android; iOS Safari needs a Blob URL.
  function savePdf(doc, filename) {
    try {
      var blob = doc.output('blob');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var canDownload = typeof a.download !== 'undefined' &&
        !/iP(hone|ad|od)/i.test(navigator.userAgent || '');
      if (canDownload) {
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      } else {
        window.open(url, '_blank');       // iOS: share/save from the opened tab
        setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
      }
    } catch (e) {
      doc.save(filename);
    }
  }

  global.MPSReport = {
    buildReportData: buildReportData,
    downloadReport: downloadReport,
    prettyStamp: prettyStamp,
    safeText: safeText,
    imgFormat: imgFormat
  };
})(typeof window !== 'undefined' ? window : globalThis);
