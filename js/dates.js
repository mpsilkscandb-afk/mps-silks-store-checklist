// ════════════════════════════════════════════════════════════════
//  MPS Silks — IST (Asia/Kolkata) date helpers
//  All daily grouping, "today" and date filters use the store's
//  local time zone, regardless of where the device thinks it is.
//  Pure functions — covered by tests/dates.test.js.
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var TZ = 'Asia/Kolkata';

  function parts(date) {
    // en-CA yields stable YYYY-MM-DD output; fall back to manual math.
    try {
      var f = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      var p = {};
      f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
      return {
        date: p.year + '-' + p.month + '-' + p.day,
        time: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute + ':' + p.second,
        hm: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute
      };
    } catch (e) {
      var d = new Date(date.getTime() + 5.5 * 3600000);
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      return {
        date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
        time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()),
        hm: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
      };
    }
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAYS_S = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var Dates = {
    tz: TZ,

    today: function () { return parts(new Date()).date; },
    now: function () { return parts(new Date()); },

    // 'YYYY-MM-DD' → {y,m,d} or null
    parse: function (s) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
      if (!m) return null;
      var y = +m[1], mo = +m[2], d = +m[3];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return { y: y, m: mo, d: d };
    },

    addDays: function (dayStr, n) {
      var p = Dates.parse(dayStr);
      if (!p) return null;
      var ms = Date.UTC(p.y, p.m - 1, p.d, 12) + n * 86400000;
      var d = new Date(ms);
      function pad(x) { return (x < 10 ? '0' : '') + x; }
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    },

    dayOfWeek: function (dayStr) {
      var p = Dates.parse(dayStr);
      if (!p) return '';
      return DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay()];
    },

    formatFull: function (dayStr) {
      var p = Dates.parse(dayStr);
      if (!p) return String(dayStr || '');
      var dow = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
      return DAYS[dow] + ', ' + p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y;
    },

    formatShort: function (dayStr) {
      var p = Dates.parse(dayStr);
      if (!p) return String(dayStr || '');
      var dow = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
      return DAYS_S[dow] + ' ' + p.d + ' ' + MONTHS[p.m - 1];
    },

    isValid: function (s) { return !!Dates.parse(s); },

    range: function (from, to, maxDays) {
      var out = [];
      if (!Dates.isValid(from) || !Dates.isValid(to) || from > to) return out;
      var cur = from, limit = maxDays || 366;
      while (cur <= to && out.length < limit) {
        out.push(cur);
        cur = Dates.addDays(cur, 1);
      }
      return out;
    }
  };

  global.Dates = Dates;
})(typeof window !== 'undefined' ? window : globalThis);
