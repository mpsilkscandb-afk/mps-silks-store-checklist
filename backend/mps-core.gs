// ════════════════════════════════════════════════════════════════
//  MPS Silks Store Operations Checklist — Pure backend logic
//  File: mps-core.gs
//
//  This file contains NO Google Apps Script services so that it can
//  be executed directly by the Node.js test suite (see tests/).
//  The IO layer (MPS_BACKEND.gs) calls into the MPSCore namespace.
// ════════════════════════════════════════════════════════════════

var MPSCore = (function () {
  'use strict';

  var IST_TZ = 'Asia/Kolkata';
  var MAX_PHOTOS = 5;                       // photos a single task may carry
  var PHOTO_ID_RE = /^[A-Za-z0-9_-]{10,}$/; // a Drive file id in a Photo_URL cell

  // ── generic helpers ──────────────────────────────────────────
  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }
  function lower(v) { return str(v).toLowerCase(); }
  function yes(v) {
    var l = lower(v);
    return l === 'yes' || l === 'y' || l === 'true' || l === '1';
  }
  function normHeader(h) { return lower(h).replace(/[^a-z0-9]/g, ''); }

  // Map sheet headers (any spelling) to canonical field names.
  // Header sets are PER ENTITY — shared aliases (e.g. "Name", "Role",
  // "Status") would otherwise be stolen by another entity's fields.
  // kind: 'task' (default) | 'user' | 'sub' | 'settings'
  var COLUMN_SETS = {
    task: {
      taskId:        ['taskid', 'id', 'taskcode', 'code'],
      section:       ['section', 'sectionname', 'category', 'department', 'area'],
      taskName:      ['taskname', 'task', 'name', 'description', 'checklistitem', 'item'],
      type:          ['type', 'tasktype', 'responsetype', 'inputtype'],
      mandatory:     ['mandatory', 'required', 'ismandatory'],
      photoRequired: ['photorequired', 'photo', 'photoneeded', 'needphoto', 'photographrequired', 'requiresphoto'],
      active:        ['active', 'enabled', 'isactive'],
      assignedTo:    ['assignedto', 'assignee', 'staff', 'staffname', 'assignedrole', 'role', 'role1', 'role2', 'owner'],
      frequency:     ['frequency', 'freq', 'taskfrequency', 'repeat', 'recurrence', 'schedule', 'dailyweeklymonthly']
    },
    user: {
      name:   ['name', 'staff', 'employee', 'username', 'fullname', 'staffname'],
      pin:    ['pin', 'password', 'passcode', 'code', 'secret'],
      role:   ['role', 'designation', 'access', 'userrole'],
      active: ['active', 'status', 'enabled', 'isactive']
    },
    sub: {
      timestamp:     ['timestamp', 'submittedat', 'submitted', 'datetime', 'time'],
      date:          ['date', 'submissiondate', 'day'],
      staffName:     ['staffname', 'staff', 'user', 'submittedby', 'name'],
      role:          ['role', 'designation', 'userrole'],
      section:       ['section', 'sectionname', 'category'],
      taskId:        ['taskid', 'id'],
      taskName:      ['taskname', 'task', 'description'],
      type:          ['type', 'tasktype'],
      response:      ['response', 'answer', 'value', 'result'],
      photoUrl:      ['photourl', 'photo', 'photoid', 'image', 'imageurl', 'fileid'],
      photoTime:     ['phototime', 'photoat', 'phototakenat', 'photocapturedat', 'photoclicktime'],
      remarks:       ['remarks', 'remark', 'comments', 'comment', 'notes', 'note', 'reason'],
      status:        ['status', 'outcome'],
      sequence:      ['sequence', 'seq'],
      updateReason:  ['updatereason', 'overridereason', 'override', 'reasonforupdate'],
      submissionId:  ['submissionid', 'batchid', 'requestid', 'clientid']
    },
    settings: {
      key:   ['key', 'settingkey', 'name'],
      value: ['value', 'settingvalue', 'val']
    }
  };

  function mapColumns(headers, kind) {
    var set = COLUMN_SETS[kind || 'task'] || COLUMN_SETS.task;
    var col = {};
    var used = {};
    var i, j, k, aliases, idx;
    for (k in set) {
      if (!Object.prototype.hasOwnProperty.call(set, k)) continue;
      aliases = set[k];
      idx = -1;
      for (i = 0; i < headers.length; i++) {
        if (used[i]) continue;
        var nh = normHeader(headers[i]);
        if (aliases.indexOf(nh) !== -1) { idx = i; break; }
      }
      if (idx === -1) {
        // second pass: prefix match (e.g. "Photo Required?" → photorequired)
        for (i = 0; i < headers.length; i++) {
          if (used[i]) continue;
          var nh2 = normHeader(headers[i]);
          for (j = 0; j < aliases.length; j++) {
            if (nh2 && (nh2.indexOf(aliases[j]) === 0 || aliases[j].indexOf(nh2) === 0)) {
              idx = i; break;
            }
          }
          if (idx !== -1) break;
        }
      }
      if (idx !== -1) { col[k] = idx; used[idx] = true; }
    }
    return col;
  }

  // ── date helpers (pure, string based, IST day semantics) ─────
  // Days are 'YYYY-MM-DD' strings; arithmetic anchored at UTC noon
  // to be immune to DST (IST has none, but be safe).
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d, 12, 0, 0);
  }
  function fmtDay(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function addDays(dayStr, n) {
    var ms = parseDay(dayStr);
    if (ms === null) return null;
    return fmtDay(ms + n * 86400000);
  }
  function dayRange(from, to, maxDays) {
    var out = [];
    var f = parseDay(from), t = parseDay(to);
    if (f === null || t === null || t < f) return out;
    var limit = maxDays || 366;
    var cur = f;
    while (cur <= t && out.length < limit) {
      out.push(fmtDay(cur));
      cur += 86400000;
    }
    return out;
  }
  function normDateCell(v) {
    if (v instanceof Date) {
      // Sheets may hand back Date objects already interpreted in the
      // script's timezone; format them consistently.
      return v.getUTCFullYear() + '-' + pad2(v.getUTCMonth() + 1) + '-' + pad2(v.getUTCDate());
    }
    var s = str(v);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    // dd/mm/yyyy or dd-mm-yyyy
    m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
    if (m) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    return '';
  }

  // ── cell → 'YYYY-MM-DD HH:MM:SS' (IST) ──────────────────────
  // Google Sheets converts a LONE value like "2026-10-26 14:03:11" written
  // into a Timestamp / Photo_Time cell into a Date object; String(Date) then
  // reads back as "Mon Oct 26 2026 14:03:11 GMT+0530 …" (multi-value cells
  // such as "t1,t2" stay text, which is why the damage looked inconsistent).
  // This helper turns such a Date back into the store's wall-clock time as
  // plain text — the instant + 5:30 read via the UTC getters, so it never
  // depends on the script's own time zone — and passes strings through
  // untouched, so a comma list keeps its parts index-aligned with the photo
  // ids. It also repairs rows written BEFORE the columns were typed as text.
  var IST_OFFSET_MS = 5.5 * 3600000;
  function cellToIstString(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      var t = v.getTime();
      if (isNaN(t)) return '';
      var d = new Date(t + IST_OFFSET_MS);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
        ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    }
    return str(v);
  }

  // Pad a single-digit hour: '2026-10-24 9:35:26' -> '2026-10-24 09:35:26'.
  // Sheets and manual edits can store '9:35:26'; our parsers expect two
  // digits, so we normalise BEFORE parsing. An already two-digit hour, a
  // date-only value, junk or a ","-list (split first) is returned unchanged.
  function padHour(s) {
    return String(s === null || s === undefined ? '' : s).replace(
      /^(\d{4}-\d{2}-\d{2}[ T])(\d)(:\d{2}(?::\d{2})?)$/,
      function (m, date, h, rest) { return date + '0' + h + rest; });
  }

  // Does a single 'YYYY-MM-DD HH:MM[:SS]' value carry a REAL capture time?
  // Rejects a bare date (no time part), a midnight stamp (a date-only cell
  // Sheets read back as a Date at 00:00:00) and any pre-app year (Sheets
  // serialises a time-of-day-only cell as 1899-12-30, whose IST offset is
  // +05:53:28). None of these is a trustworthy photo capture time.
  function photoTimeHasRealTime(s) {
    var v = padHour(s);
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(v || '').trim());
    if (!m) return false;                                   // junk / empty
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2020) return false;                             // 1899 time-of-day serial
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    if (m[4] === undefined) return false;                   // no time part at all
    var hh = +m[4], mm = +m[5], ss = m[6] === undefined ? 0 : +m[6];
    if (hh > 23 || mm > 59 || ss > 59) return false;
    if (hh === 0 && mm === 0 && ss === 0) return false;     // midnight = date-only
    return true;
  }

  // Photo_Time cell → ","-list of 'YYYY-MM-DD HH:MM:SS', keeping slot
  // alignment with the ","-list of photo ids. Old rows are first repaired via
  // cellToIstString (a Sheets Date becomes a full timestamp); then every slot
  // that carries no REAL time (a bare date, a midnight stamp or an 1899
  // serial) is blanked so admin/dashboard/PDF say "Photo time not recorded"
  // instead of a bare date or "12:00 AM". This is the ROOT-CAUSE guard on the
  // value side; the display side (Dates.prettyPhoto) is defence in depth.
  function normalizePhotoTimeCell(v) {
    if (v === null || v === undefined) return '';
    var s = cellToIstString(v);
    if (!s) return '';
    var parts = String(s).split(',');
    for (var i = 0; i < parts.length; i++) {
      parts[i] = photoTimeHasRealTime(parts[i]) ? padHour(parts[i]) : '';
    }
    return parts.join(',');
  }

  // ── PIN hashing (pure JS SHA-256) ────────────────────────────
  var SHA_K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  function sha256Hex(ascii) {
    var mathPow = Math.pow, maxWord = mathPow(2, 32);
    var i, j, result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var k = sha256Hex._k || (sha256Hex._k = []);
    if (!k.length) {
      for (i = 0; i < 64; i++) k[i] = (mathPow(i, 0.5) * maxWord) | 0;
    }
    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return sha256Hex._utf8(ascii) && sha256Hex(sha256Hex._utf8(ascii));
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    var w, a, b, c, d, e, f, g, h, maj, t1, t2;
    var H = sha256Hex._H || (sha256Hex._H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var orig = H.slice(0);
    for (j = 0; j < words.length;) {
      a = orig[0]; b = orig[1]; c = orig[2]; d = orig[3];
      e = orig[4]; f = orig[5]; g = orig[6]; h = orig[7];
      w = [];
      for (i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[j + i] | 0;
        else {
          var w15 = w[i - 15], w2 = w[i - 2];
          w[i] = ((w15 >>> 7 | w15 << 25) ^ (w15 >>> 18 | w15 << 14) ^ (w15 >>> 3)) +
                 w[i - 7] +
                 ((w2 >>> 17 | w2 << 15) ^ (w2 >>> 19 | w2 << 13) ^ (w2 >>> 10)) +
                 w[i - 16];
        }
        var ch = (e & f) ^ (~e & g);
        var maj2 = (a & b) ^ (a & c) ^ (b & c);
        t1 = (h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) +
              ch + SHA_K[i] + (w[i] | 0)) | 0;
        t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + maj2) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      orig[0] = (orig[0] + a) | 0;
      orig[1] = (orig[1] + b) | 0;
      orig[2] = (orig[2] + c) | 0;
      orig[3] = (orig[3] + d) | 0;
      orig[4] = (orig[4] + e) | 0;
      orig[5] = (orig[5] + f) | 0;
      orig[6] = (orig[6] + g) | 0;
      orig[7] = (orig[7] + h) | 0;
      j += 16; // advance to the next 512-bit block
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        var b2 = (orig[i] >> (j * 8)) & 255;
        result += ((b2 < 16 ? '0' : '') + b2.toString(16));
      }
    }
    return result;
  }
  sha256Hex._utf8 = function (s) {
    try {
      return unescape(encodeURIComponent(s));
    } catch (e) { return s; }
  };

  var ADMIN_ROLES = ['admin', 'owner', 'manager', 'store manager', 'storemanager', 'proprietor'];

  function hashPin(pin, salt) {
    return 'sha256:' + sha256Hex(String(salt) + ':' + String(pin));
  }
  function constantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    var r = 0;
    for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }
  // stored may be 'sha256:...' (migrated) or a legacy plain value.
  function verifyPin(stored, pin, salt) {
    stored = str(stored);
    if (!stored || !pin) return false;
    if (/^sha256:/i.test(stored)) return constantTimeEq(stored, hashPin(pin, salt));
    return constantTimeEq(stored, String(pin));
  }
  function needsPinMigration(stored) {
    return !!str(stored) && !/^sha256:/i.test(str(stored));
  }
  function validPin(pin) {
    return /^\d{4,8}$/.test(str(pin));
  }
  function isAdminRole(role) {
    return ADMIN_ROLES.indexOf(lower(role)) !== -1;
  }

  // ── normalizers ──────────────────────────────────────────────
  var VALID_TYPES = ['yesno', 'rating', 'photo', 'text'];
  function normType(t) {
    var v = lower(t).replace(/[\s_\-]/g, '');
    if (v === 'yesno' || v === 'yn' || v === 'yes/no' || v === 'boolean' || v === 'checkbox') return 'yesno';
    if (v === 'rating' || v === 'stars' || v === 'star' || v === 'score') return 'rating';
    if (v === 'photo' || v === 'image' || v === 'picture') return 'photo';
    if (v === 'text' || v === 'note' || v === 'string' || v === 'other') return 'text';
    return null;
  }

  // Task frequency: daily (default) | weekly (Fridays) | monthly (the 28th).
  // Returns the canonical value, or null when the text is not recognised.
  // A blank cell means daily.
  function normFrequency(v) {
    var s = lower(v).replace(/[^a-z]/g, '');
    if (s === '' || s === 'daily' || s === 'day' || s === 'everyday') return 'daily';
    if (s === 'weekly' || s === 'week') return 'weekly';
    if (s === 'monthly' || s === 'month') return 'monthly';
    return null;
  }
  var WEEKLY_DAY = 5;     // Friday (Sunday = 0)
  var MONTHLY_DATE = 28;  // the 28th exists in every month

  // Is this task due on the given IST day ('YYYY-MM-DD')?
  // No frequency (or an unreadable day) means daily, so older data keeps working.
  function isDueOn(task, day) {
    var f = task && task.frequency;
    if (!f || f === 'daily') return true;
    var ms = parseDay(day);
    if (ms === null) return true;
    var d = new Date(ms);
    if (f === 'weekly') return d.getUTCDay() === WEEKLY_DAY;
    if (f === 'monthly') return d.getUTCDate() === MONTHLY_DATE;
    return true;
  }

  // rows: array of arrays (sheet values, excluding header)
  function normalizeTasks(headers, rows) {
    var col = mapColumns(headers, 'task');
    var tasks = [];
    var problems = [];
    if (col.taskName === undefined && col.taskId === undefined) {
      return {
        tasks: tasks,
        problems: [{ row: 0, issue: 'Checklist sheet has no recognisable Task_ID or Task_Name column. Found: ' + headers.join(', ') }]
      };
    }
    for (var r = 0; r < rows.length; r++) {
      var raw = rows[r];
      var rowNo = r + 2; // 1-based + header
      if (!raw || raw.every(function (c) { return str(c) === ''; })) continue;
      var taskId = col.taskId !== undefined ? str(raw[col.taskId]) : '';
      var taskName = col.taskName !== undefined ? str(raw[col.taskName]) : '';
      if (!taskId && !taskName) {
        problems.push({ row: rowNo, issue: 'Row has neither a Task_ID nor a Task_Name — skipped.' });
        continue;
      }
      if (!taskId) {
        taskId = 'T' + pad3(tasks.length + 1);
        problems.push({ row: rowNo, issue: 'Missing Task_ID for "' + taskName + '" — assigned ' + taskId + ' for this session only. Add a Task_ID in the sheet.' });
      }
      if (!taskName) {
        problems.push({ row: rowNo, issue: 'Task ' + taskId + ' has an empty Task_Name — skipped.' });
        continue;
      }
      var type = col.type !== undefined ? normType(raw[col.type]) : 'yesno';
      if (col.type !== undefined && !type) {
        problems.push({ row: rowNo, issue: 'Task ' + taskId + ' has unknown Type "' + str(raw[col.type]) + '" — defaulted to yesno.' });
        type = 'yesno';
      }
      if (!type) type = 'yesno';
      var assignedTo = [];
      if (col.assignedTo !== undefined) {
        var av = str(raw[col.assignedTo]);
        if (av) {
          assignedTo = av.split(/[,;]+/).map(function (s) { return lower(s); }).filter(Boolean);
        }
      }
      if (!assignedTo.length) assignedTo = ['all'];
      var frequency = 'daily';
      if (col.frequency !== undefined) {
        var fv = normFrequency(raw[col.frequency]);
        if (fv === null) {
          problems.push({ row: rowNo, issue: 'Task ' + taskId + ' has unknown Frequency "' + str(raw[col.frequency]) + '" — treated as Daily. Use Daily, Weekly or Monthly.' });
          fv = 'daily';
        }
        frequency = fv;
      }
      tasks.push({
        row: rowNo,
        taskId: taskId,
        section: col.section !== undefined ? str(raw[col.section]) || 'General' : 'General',
        taskName: taskName,
        type: type,
        mandatory: col.mandatory !== undefined ? yes(raw[col.mandatory]) : true,
        photoRequired: col.photoRequired !== undefined ? yes(raw[col.photoRequired]) : false,
        active: col.active !== undefined ? (str(raw[col.active]) === '' ? true : yes(raw[col.active])) : true,
        assignedTo: assignedTo,
        frequency: frequency
      });
    }
    return { tasks: tasks, problems: problems };
  }
  function pad3(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }

  function normalizeUsers(headers, rows) {
    var col = mapColumns(headers, 'user');
    var users = [];
    var problems = [];
    if (col.name === undefined) {
      return { users: users, problems: [{ row: 0, issue: 'Users sheet has no recognisable Name column. Found: ' + headers.join(', ') }] };
    }
    for (var r = 0; r < rows.length; r++) {
      var raw = rows[r];
      var rowNo = r + 2;
      if (!raw || raw.every(function (c) { return str(c) === ''; })) continue;
      var name = str(raw[col.name]);
      if (!name) { problems.push({ row: rowNo, issue: 'User row without a name — skipped.' }); continue; }
      var pin = col.pin !== undefined ? str(raw[col.pin]) : '';
      var role = col.role !== undefined ? str(raw[col.role]) : '';
      if (!role) role = 'Staff';
      users.push({
        row: rowNo,
        name: name,
        pin: pin,
        role: role,
        isAdmin: isAdminRole(role),
        active: col.active !== undefined ? yes(raw[col.active]) : true
      });
    }
    return { users: users, problems: problems };
  }

  function normalizeSubmissions(headers, rows) {
    var col = mapColumns(headers, 'sub');
    var subs = [];
    if (col.taskId === undefined && col.taskName === undefined) return subs;
    for (var r = 0; r < rows.length; r++) {
      var raw = rows[r];
      if (!raw || raw.every(function (c) { return str(c) === ''; })) continue;
      var ts = col.timestamp !== undefined ? cellToIstString(raw[col.timestamp]) : '';
      var date = col.date !== undefined ? normDateCell(raw[col.date]) : '';
      if (!date && ts.length >= 10) date = normDateCell(ts.slice(0, 10));
      subs.push({
        row: r + 2,
        timestamp: ts,
        date: date,
        staffName: col.staffName !== undefined ? str(raw[col.staffName]) : '',
        role: col.role !== undefined ? str(raw[col.role]) : '',
        section: col.section !== undefined ? str(raw[col.section]) : '',
        taskId: col.taskId !== undefined ? str(raw[col.taskId]) : '',
        taskName: col.taskName !== undefined ? str(raw[col.taskName]) : '',
        type: col.type !== undefined ? str(raw[col.type]) : '',
        response: col.response !== undefined ? str(raw[col.response]) : '',
        photoRef: col.photoUrl !== undefined ? str(raw[col.photoUrl]) : '',
        photoTime: col.photoTime !== undefined ? normalizePhotoTimeCell(raw[col.photoTime]) : '',
        status: col.status !== undefined ? str(raw[col.status]).toUpperCase() : '',
        remarks: col.remarks !== undefined ? str(raw[col.remarks]) : '',
        sequence: col.sequence !== undefined ? str(raw[col.sequence]) : '',
        updateReason: col.updateReason !== undefined ? str(raw[col.updateReason]) : '',
        submissionId: col.submissionId !== undefined ? str(raw[col.submissionId]) : ''
      });
    }
    return subs;
  }

  // ── response → status derivation (server-side, not client) ───
  function deriveStatus(task, response, photoRef) {
    if (task.type === 'yesno') {
      var v = lower(response);
      if (v === 'yes' || v === 'y' || v === 'true') return 'OK';
      if (v === 'no' || v === 'n' || v === 'false') return 'FAIL';
      return null;
    }
    if (task.type === 'rating') {
      var n = parseInt(response, 10);
      if (isNaN(n) || n < 1 || n > 5) return null;
      return n >= 3 ? 'OK' : 'FAIL';
    }
    if (task.type === 'photo') {
      return str(photoRef) ? 'OK' : null;
    }
    // text
    return str(response) ? 'OK' : null;
  }

  // ── submission validation ────────────────────────────────────
  // Photo_URL cells hold Drive file ids joined with "," (a single older id
  // is still valid). Non-ids and repeats are dropped.
  function parsePhotoRefs(v) {
    var out = [];
    var seen = {};
    str(v).split(',').forEach(function (part) {
      var id = str(part);
      if (!PHOTO_ID_RE.test(id) || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  // Photo_Time cells hold one capture time per id (same order, ","-joined).
  // Missing slots stay empty so both lists stay index-aligned; the result is
  // "" when every slot is empty.
  function cleanPhotoTimes(refCount, v, nowMs) {
    var parts = str(v).split(',');
    var out = [];
    var n = refCount > 0 ? refCount : 0;
    for (var i = 0; i < n; i++) {
      out.push(cleanPhotoTime(parts[i] === undefined ? '' : parts[i], nowMs));
    }
    return out.join(',');
  }

  // Time a photo was taken, 'YYYY-MM-DD HH:MM:SS' (IST, from the phone). A
  // value in that format is NEVER dropped silently: it is only discarded when
  // it is more than 14 days in the past or more than 24 h in the future
  // (phone clocks are often a little off; gallery photos can be old).
  function cleanPhotoTime(v, nowMs) {
    var s = padHour(str(v));
    if (!/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/.test(s)) return '';
    var t = Date.parse(s.replace(' ', 'T') + '+05:30');
    if (isNaN(t)) return '';
    var now = nowMs || Date.now();
    if (t > now + 24 * 3600000 || t < now - 14 * 86400000) return '';
    return s;
  }

  // entries: [{taskId, response, remarks, photoRef, photoTime, updateReason}]
  function validateEntries(entries, taskMap, nowMs) {
    var errors = [];
    var clean = [];
    if (!entries || !entries.length) {
      return { ok: false, errors: ['No entries supplied.'], clean: [] };
    }
    if (entries.length > 200) {
      return { ok: false, errors: ['Too many entries in one submission (max 200).'], clean: [] };
    }
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var tid = str(e.taskId);
      var prefix = 'Entry ' + (i + 1) + ' (' + (tid || 'no task id') + '): ';
      if (!tid) { errors.push(prefix + 'missing taskId.'); continue; }
      if (seen[tid]) { errors.push(prefix + 'duplicate taskId in the same submission.'); continue; }
      seen[tid] = true;
      var task = taskMap[tid];
      if (!task) { errors.push(prefix + 'unknown task.'); continue; }
      if (!task.active) { errors.push(prefix + 'task is inactive.'); continue; }
      var response = str(e.response);
      var remarks = str(e.remarks);
      var refs = parsePhotoRefs(e.photoRef);
      var photoRef = refs.join(',');
      var updateReason = str(e.updateReason);
      if (response.length > 500) { errors.push(prefix + 'response too long (max 500 chars).'); continue; }
      if (remarks.length > 1000) { errors.push(prefix + 'remarks too long (max 1000 chars).'); continue; }
      if (updateReason.length > 500) { errors.push(prefix + 'update reason too long (max 500 chars).'); continue; }
      if (refs.length > MAX_PHOTOS) {
        errors.push(prefix + 'A task can have at most 5 photos.');
        continue;
      }
      if (task.photoRequired && !photoRef) {
        errors.push(prefix + 'a photograph is required for this task.');
        continue;
      }
      var status = deriveStatus(task, response, photoRef);
      if (status === null) {
        var expect = task.type === 'yesno' ? 'yes or no'
          : task.type === 'rating' ? 'a rating from 1 to 5'
          : task.type === 'photo' ? 'an uploaded photo'
          : 'a non-empty response';
        errors.push(prefix + 'expected ' + expect + ', got "' + response + '".');
        continue;
      }
      if (status === 'FAIL' && remarks.length < 3) {
        errors.push(prefix + 'a remark explaining the issue is required when a task fails.');
        continue;
      }
      if (task.mandatory && !response && !photoRef) {
        errors.push(prefix + 'mandatory task requires a response.');
        continue;
      }
      clean.push({
        taskId: tid,
        taskName: task.taskName,
        section: task.section,
        type: task.type,
        response: response,
        remarks: remarks,
        photoRef: photoRef,
        photoTime: photoRef ? cleanPhotoTimes(refs.length, e.photoTime, nowMs) : '',
        status: status,
        updateReason: updateReason
      });
    }
    return { ok: errors.length === 0, errors: errors, clean: clean };
  }

  // ── dashboard computation ────────────────────────────────────
  // tasks: normalized tasks; subs: normalized submissions (any dates).
  // Completion % = distinct assigned tasks with a valid latest
  // submission on the date ÷ active assigned tasks × 100.
  function computeDashboard(tasks, subs, dateFrom, dateTo, today) {
    var activeTasks = tasks.filter(function (t) { return t.active; });
    var days = dayRange(dateFrom, dateTo, 92);
    if (!days.length) return null;
    var focusDate = days[days.length - 1];

    // latest submission per (date, taskId) — sheet order = time order
    var latest = {};
    var counts = {};
    var byBatch = {};
    subs.forEach(function (s) {
      if (!s.date || !s.taskId) return;
      var key = s.date + '__' + s.taskId;
      latest[key] = s; // append-only sheet: last row wins
      counts[key] = (counts[key] || 0) + 1;
      if (s.submissionId) byBatch[s.submissionId] = true;
    });

    function statusOf(date, task) {
      var sub = latest[date + '__' + task.taskId];
      if (!sub) return { state: 'PENDING' };
      var failed = String(sub.status).toUpperCase() === 'FAIL';
      return {
        state: failed ? 'FAIL' : 'PASS',
        sub: sub,
        updates: counts[date + '__' + task.taskId]
      };
    }

    // per-day stats
    var trend = days.map(function (d) {
      var dueTasks = activeTasks.filter(function (t) { return isDueOn(t, d); });
      var assigned = dueTasks.length, submitted = 0, passed = 0, failed = 0;
      dueTasks.forEach(function (t) {
        var st = statusOf(d, t);
        if (st.state === 'PASS') { submitted++; passed++; }
        else if (st.state === 'FAIL') { submitted++; failed++; }
      });
      return {
        date: d,
        assigned: assigned,
        submitted: submitted,
        passed: passed,
        failed: failed,
        pending: assigned - submitted,
        pct: assigned > 0 ? Math.round((submitted / assigned) * 100) : 0,
        passPct: assigned > 0 ? Math.round((passed / assigned) * 100) : 0
      };
    });

    // focus date (headline)
    var sectionsMap = {};
    var sectionOrder = [];
    var failedList = [];
    var outstandingList = [];
    var detail = [];
    var isPast = today && focusDate < today;

    activeTasks.forEach(function (t) {
      if (!isDueOn(t, focusDate)) return;   // weekly / monthly task not due on this day
      if (!sectionsMap[t.section]) {
        sectionsMap[t.section] = { section: t.section, assigned: 0, submitted: 0, passed: 0, failed: 0, pending: 0, pct: 0, tasks: [] };
        sectionOrder.push(t.section);
      }
      var s = sectionsMap[t.section];
      s.assigned++;
      var st = statusOf(focusDate, t);
      var row = {
        date: focusDate,
        taskId: t.taskId,
        section: t.section,
        taskName: t.taskName,
        type: t.type,
        mandatory: t.mandatory,
        photoRequired: t.photoRequired,
        assignedTo: t.assignedTo.join(', '),
        frequency: t.frequency || 'daily',
        state: st.state,
        status: st.state === 'PENDING' ? 'PENDING' : (st.state === 'FAIL' ? 'FAIL' : 'PASS'),
        response: st.sub ? st.sub.response : '',
        staffName: st.sub ? st.sub.staffName : '',
        remarks: st.sub ? st.sub.remarks : '',
        photoRef: st.sub ? st.sub.photoRef : '',
        photoTime: st.sub ? st.sub.photoTime : '',
        photoCount: st.sub ? parsePhotoRefs(st.sub.photoRef).length : 0,
        timestamp: st.sub ? st.sub.timestamp : '',
        sequence: st.sub ? st.sub.sequence : '',
        updateReason: st.sub ? st.sub.updateReason : '',
        updates: st.updates || 0
      };
      s.tasks.push(row);
      if (st.state === 'PASS') { s.submitted++; s.passed++; }
      else if (st.state === 'FAIL') {
        s.submitted++; s.failed++;
        failedList.push(row);
      } else {
        s.pending++;
        outstandingList.push(row);
      }
      detail.push(row);
    });

    var sections = sectionOrder.map(function (name) {
      var s = sectionsMap[name];
      s.pct = s.assigned > 0 ? Math.round((s.submitted / s.assigned) * 100) : 0;
      return s;
    });
    outstandingList.forEach(function (r) { r.outstandingLabel = isPast ? 'Missed' : 'Pending'; });

    // staff-wise: submissions made by each staff member on focus date.
    // Only tasks with an actual submission are attributed — pending tasks
    // must not fabricate zero-rows (e.g. an "Unknown" entry with 0/0/0).
    // An *unnamed* submission still lands in the "Unknown" bucket so that
    // data problems are reported, never silently dropped.
    var staffMap = {};
    detail.forEach(function (r) {
      if (r.state === 'PENDING') return;
      var name = r.staffName || 'Unknown';
      if (!staffMap[name]) staffMap[name] = { name: name, submitted: 0, passed: 0, failed: 0 };
      staffMap[name].submitted++;
      if (r.state === 'FAIL') staffMap[name].failed++; else staffMap[name].passed++;
    });
    var staff = Object.keys(staffMap).sort().map(function (k) { return staffMap[k]; });

    // updates (resubmission) log for focus date
    var updatesLog = [];
    Object.keys(counts).forEach(function (key) {
      if (key.indexOf(focusDate + '__') !== 0) return;
      if (counts[key] < 2) return;
      var taskId = key.slice(focusDate.length + 2);
      var all = subs.filter(function (s) { return s.date === focusDate && s.taskId === taskId; });
      var first = all[0], last = all[all.length - 1];
      updatesLog.push({
        date: focusDate,
        taskId: taskId,
        taskName: last.taskName || (first ? first.taskName : ''),
        section: last.section || (first ? first.section : ''),
        firstBy: first.staffName,
        firstResponse: first.response,
        firstRemarks: first.remarks,
        firstStatus: first.status,
        latestBy: last.staffName,
        latestResponse: last.response,
        latestRemarks: last.remarks,
        latestStatus: last.status,
        latestPhotoRef: last.photoRef,
        totalEntries: all.length
      });
    });

    var fTrend = trend[trend.length - 1];
    return {
      dateFrom: days[0],
      dateTo: focusDate,
      focusDate: focusDate,
      today: today || '',
      outstandingLabel: isPast ? 'Missed' : 'Pending',
      headline: {
        assigned: fTrend.assigned,
        submitted: fTrend.submitted,
        passed: fTrend.passed,
        failed: fTrend.failed,
        pending: fTrend.pending,
        pct: fTrend.pct,
        passPct: fTrend.passPct
      },
      range: {
        days: days.length,
        assignedTotal: trend.reduce(function (a, t) { return a + t.assigned; }, 0),
        submittedTotal: trend.reduce(function (a, t) { return a + t.submitted; }, 0),
        passedTotal: trend.reduce(function (a, t) { return a + t.passed; }, 0),
        failedTotal: trend.reduce(function (a, t) { return a + t.failed; }, 0),
        pct: (function () {
          var a = trend.reduce(function (x, t) { return x + t.assigned; }, 0);
          var s = trend.reduce(function (x, t) { return x + t.submitted; }, 0);
          return a > 0 ? Math.round((s / a) * 100) : 0;
        })()
      },
      sections: sections,
      staff: staff,
      trend: trend,
      failed: failedList,
      outstanding: outstandingList,
      updates: updatesLog,
      detail: detail
    };
  }

  // Which tasks are assigned to a given staff member.
  // Missing/empty assignment ⇒ visible to everyone (single-store default).
  // Optional 4th argument: an IST day. When given, tasks that are not due on
  // that day (weekly / monthly) are left out.
  function tasksForUser(tasks, name, role, day) {
    var n = lower(name), r = lower(role);
    return tasks.filter(function (t) {
      if (!t.active) return false;
      if (day && !isDueOn(t, day)) return false;
      var a = t.assignedTo || ['all'];
      if (a.indexOf('all') !== -1 || a.indexOf('') !== -1) return true;
      return a.indexOf(n) !== -1 || (r && a.indexOf(r) !== -1);
    });
  }

  // Latest submission per task for one IST day (staff checklist view).
  function latestForDay(subs, day) {
    var map = {};
    subs.forEach(function (s) {
      if (s.date === day && s.taskId) map[s.taskId] = s;
    });
    return map;
  }

  // Group tasks into ordered sections for the checklist UI.
  function sectionsFor(tasks) {
    var order = [];
    var map = {};
    tasks.forEach(function (t) {
      if (!map[t.section]) { map[t.section] = []; order.push(t.section); }
      map[t.section].push(t);
    });
    return order.map(function (name) { return { section: name, tasks: map[name] }; });
  }

  // Input sanitisation for task/user writes.
  function cleanText(v, max) {
    var s = str(v).replace(/[\u0000-\u001f]/g, ' ');
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }
  function normYesNo(v, def) {
    var l = lower(v);
    if (l === 'yes' || l === 'y' || l === 'true') return 'Yes';
    if (l === 'no' || l === 'n' || l === 'false') return 'No';
    return def;
  }

  // Photos taken in a date range, newest first (admin photo gallery).
  // subs: normalized submissions. Never exposes anything but the Drive file id.
  // A row can carry several photos ("id1,id2") — it is expanded into ONE
  // gallery item per id, with that id's own capture time.
  // Optional 5th argument: a section name — only that section's photos are
  // returned (the cap still applies to the filtered result).
  function listPhotos(subs, dateFrom, dateTo, limit, section) {
    var max = limit > 0 ? limit : 200;
    var want = section ? str(section) : '';
    var all = [];
    (subs || []).forEach(function (s) {
      if (!s || !s.date || s.date < dateFrom || s.date > dateTo) return;
      if (want && str(s.section) !== want) return;
      var refs = parsePhotoRefs(s.photoRef);
      if (!refs.length) return;
      var times = str(s.photoTime).split(',');
      refs.forEach(function (id, i) {
        all.push({ date: s.date, timestamp: s.timestamp, photoRef: id, photoTime: str(times[i]),
                   staffName: s.staffName, section: s.section, taskId: s.taskId, taskName: s.taskName,
                   status: s.status, sequence: s.sequence, remarks: s.remarks,
                   photoIndex: i + 1, photoCount: refs.length });
      });
    });
    // A later update row can repeat the same photo without its capture time:
    // remember the first capture time seen for each photo.
    var takenAt = {};
    all.forEach(function (it) { if (it.photoTime && !takenAt[it.photoRef]) takenAt[it.photoRef] = it.photoTime; });
    all.sort(function (a, b) {
      var ta = String(takenAt[a.photoRef] || a.timestamp), tb = String(takenAt[b.photoRef] || b.timestamp);
      return tb < ta ? -1 : (tb > ta ? 1 : 0);          // newest photo first
    });
    var seen = {};
    var unique = all.filter(function (it) {           // same photo can appear on several rows
      if (seen[it.photoRef]) return false;
      seen[it.photoRef] = true;
      return true;
    });
    return {
      total: unique.length,
      truncated: unique.length > max,
      photos: unique.slice(0, max).map(function (it) {
        return { date: it.date, timestamp: it.timestamp, photoTime: takenAt[it.photoRef] || '', staffName: it.staffName, section: it.section,
                 taskId: it.taskId, taskName: it.taskName, status: it.status, sequence: it.sequence,
                 remarks: it.remarks, photoRef: it.photoRef, photoIndex: it.photoIndex, photoCount: it.photoCount };
      })
    };
  }

  return {
    IST_TZ: IST_TZ,
    str: str,
    lower: lower,
    yes: yes,
    normHeader: normHeader,
    mapColumns: mapColumns,
    parseDay: parseDay,
    fmtDay: fmtDay,
    addDays: addDays,
    dayRange: dayRange,
    normDateCell: normDateCell,
    cellToIstString: cellToIstString,
    padHour: padHour,
    photoTimeHasRealTime: photoTimeHasRealTime,
    normalizePhotoTimeCell: normalizePhotoTimeCell,
    sha256Hex: sha256Hex,
    hashPin: hashPin,
    verifyPin: verifyPin,
    needsPinMigration: needsPinMigration,
    validPin: validPin,
    constantTimeEq: constantTimeEq,
    isAdminRole: isAdminRole,
    VALID_TYPES: VALID_TYPES,
    normType: normType,
    normalizeTasks: normalizeTasks,
    normalizeUsers: normalizeUsers,
    normalizeSubmissions: normalizeSubmissions,
    deriveStatus: deriveStatus,
    validateEntries: validateEntries,
    computeDashboard: computeDashboard,
    listPhotos: listPhotos,
    cleanPhotoTime: cleanPhotoTime,
    parsePhotoRefs: parsePhotoRefs,
    cleanPhotoTimes: cleanPhotoTimes,
    MAX_PHOTOS: MAX_PHOTOS,
    normFrequency: normFrequency,
    isDueOn: isDueOn,
    tasksForUser: tasksForUser,
    latestForDay: latestForDay,
    sectionsFor: sectionsFor,
    cleanText: cleanText,
    normYesNo: normYesNo
  };
})();

// Allow the Node test suite to require() this file.
if (typeof module !== 'undefined' && module.exports) module.exports = MPSCore;
