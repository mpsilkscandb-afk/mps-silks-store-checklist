// ════════════════════════════════════════════════════════════════
//  MPS Silks — session handling (token based; the PIN is NEVER
//  stored on the device — only the server-issued session token).
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var KEY = 'mpsAuth';

  var Auth = {
    save: function (session) {
      // session: { token, name, role, isAdmin, exp }
      try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) {}
    },
    get: function () {
      try {
        var raw = sessionStorage.getItem(KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || !s.token) return null;
        if (s.exp && Date.now() > s.exp) { Auth.clear(); return null; }
        return s;
      } catch (e) { return null; }
    },
    clear: function () {
      try { sessionStorage.removeItem(KEY); } catch (e) {}
    },
    // Client-side guard (cosmetic only — the backend re-checks every call).
    require: function (opts) {
      var s = Auth.get();
      if (!s) {
        global.location.replace('index.html?msg=signin');
        return null;
      }
      if (opts && opts.admin && !s.isAdmin) {
        global.location.replace('checklist.html');
        return null;
      }
      return s;
    },
    logout: function () {
      var s = Auth.get();
      Auth.clear();
      // Best-effort server-side session destroy.
      if (s && s.token && global.MPS_API && global.MPS_API.post) {
        global.MPS_API.post('logout', {}).catch(function () {});
      }
    }
  };

  global.Auth = Auth;
})(window);
