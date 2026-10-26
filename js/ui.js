// ════════════════════════════════════════════════════════════════
//  MPS Silks — shared UI utilities
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureToast() {
    var t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    return t;
  }

  function toast(msg, type) {
    var t = ensureToast();
    t.textContent = msg;
    t.className = (type === 'err' ? 'err' : type === 'ok' ? 'ok' : '') + ' show';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = ''; }, 3500);
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Compress an image File → JPEG data URL (mobile friendly).
  function compressImage(file, opts) {
    var o = opts || {};
    var maxWidth = o.maxWidth || 1280;
    var quality = o.quality || 0.7;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose an image file.')); return; }
      if (file.size > 25 * 1024 * 1024) { reject(new Error('That image is too large — please pick a smaller one.')); return; }
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = function () { reject(new Error('That image could not be read.')); };
        img.src = e.target.result;
      };
      reader.onerror = function () { reject(new Error('File could not be read.')); };
      reader.readAsDataURL(file);
    });
  }

  function scoreClass(pct) { return pct >= 80 ? 'g' : pct >= 50 ? 'a' : 'r'; }

  // ── photo capture time ───────────────────────────────────────
  // Pure fallback order: EXIF string → file.lastModified → now.
  // EXIF has no time zone, so its value is already the phone's local
  // (= store) wall-clock time; lastModified/current time are instants and
  // are converted to IST through Dates.fromMs(). Returns 'YYYY-MM-DD HH:MM:SS'.
  function photoTakenAtFrom(exifStr, lastModifiedMs, nowMs) {
    var exif = typeof exifStr === 'string' ? exifStr.trim() : '';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(exif)) return exif;
    var ms = (typeof lastModifiedMs === 'number' && isFinite(lastModifiedMs) && lastModifiedMs > 0)
      ? lastModifiedMs
      : ((typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now());
    var p = global.Dates && global.Dates.fromMs ? global.Dates.fromMs(ms) : null;
    return p ? p.date + ' ' + p.time : '';
  }

  // The moment the photo was actually taken (must be read from the ORIGINAL
  // File — canvas re-compression strips EXIF).
  function getPhotoTakenAt(file) {
    var exifRead = (global.EXIF && global.EXIF.readFileDateTime)
      ? global.EXIF.readFileDateTime(file)
      : (typeof Promise !== 'undefined' ? Promise.resolve(null) : null);
    if (!exifRead) {
      return Promise.resolve(photoTakenAtFrom(null, file && file.lastModified, Date.now()));
    }
    return exifRead.then(function (exifStr) {
      return photoTakenAtFrom(exifStr, file && file.lastModified, Date.now());
    });
  }

  // Log out helper shared by all pages.
  function bindLogout(btnId) {
    var b = document.getElementById(btnId);
    if (b) b.addEventListener('click', function () {
      Auth.logout();
      global.location.href = 'index.html';
    });
  }

  // Fill topbar identity (name + role) for signed-in pages.
  function fillIdentity(subId, session) {
    var el = document.getElementById(subId);
    if (el && session) {
      el.textContent = (session.name || '') + (session.role ? ' · ' + session.role : '');
    }
  }

  global.UI = {
    esc: esc,
    toast: toast,
    uuid: uuid,
    compressImage: compressImage,
    photoTakenAtFrom: photoTakenAtFrom,
    getPhotoTakenAt: getPhotoTakenAt,
    scoreClass: scoreClass,
    bindLogout: bindLogout,
    fillIdentity: fillIdentity
  };
})(window);
