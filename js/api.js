// ════════════════════════════════════════════════════════════════
//  MPS Silks — API client
//  GET  →  {endpoint}?action=…&token=…
//  POST →  {endpoint}  body: JSON text/plain (avoids CORS preflight)
//          with the session token inside the JSON body (no custom headers).
//  Handles session expiry centrally: any AUTH error clears the
//  session and returns the caller to the login screen.
// ════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var CFG = global.MPS_CONFIG || {};

  function endpoint() {
    var ep = String(CFG.apiEndpoint || '').trim().replace(/\/+$/, '');
    if (!ep || ep.indexOf('__MPS_') === 0) {
      return { error: 'The API endpoint is not configured yet. Set MPS_API_ENDPOINT in js/config.js (see docs/DEPLOYMENT.md).' };
    }
    return { url: ep };
  }

  function sessionToken() {
    var s = global.Auth && global.Auth.get();
    return s ? s.token : '';
  }

  function authFailed() {
    if (global.Auth) global.Auth.clear();
    if (!/index\.html$/.test(global.location.pathname) && !/index\.html/.test(global.location.search)) {
      global.location.replace('index.html?msg=expired');
    }
  }

  function normalize(res) {
    // Expired/invalid session → clear and return to login. FORBIDDEN
    // (non-admin hitting an admin action) is NOT a session failure.
    if (res && res.ok === false && res.code === 'AUTH') authFailed();
    return res;
  }

  var MPS_API = {
    configured: function () { return !endpoint().error; },

    get: function (action, params) {
      var ep = endpoint();
      if (ep.error) return Promise.resolve({ ok: false, error: ep.error, code: 'CONFIG' });
      var q = ['action=' + encodeURIComponent(action), 'token=' + encodeURIComponent(sessionToken())];
      Object.keys(params || {}).forEach(function (k) {
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])));
      });
      return fetch(ep.url + '?' + q.join('&'), { redirect: 'follow', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(normalize)
        .catch(function (e) {
          return { ok: false, error: 'Network error — check your connection and try again. (' + e.message + ')', code: 'NETWORK' };
        });
    },

    post: function (action, body) {
      var ep = endpoint();
      if (ep.error) return Promise.resolve({ ok: false, error: ep.error, code: 'CONFIG' });
      var payload = Object.assign({ action: action, token: sessionToken() }, body || {});
      return fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      })
        .then(function (r) { return r.json(); })
        .then(normalize)
        .catch(function (e) {
          return { ok: false, error: 'Network error — check your connection and try again. (' + e.message + ')', code: 'NETWORK' };
        });
    },

    // Fetch a private photo as an object URL (requires a valid session).
    photoUrl: function (fileId) {
      var ep = endpoint();
      if (ep.error) return Promise.reject(new Error(ep.error));
      return fetch(ep.url + '?action=getPhoto&token=' + encodeURIComponent(sessionToken()) + '&fileId=' + encodeURIComponent(fileId), { redirect: 'follow' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          normalize(res);
          // Apps Script cannot return raw image bytes, so the photo arrives as a base64 data URL.
          if (!res || res.ok !== true || String(res.dataUrl || '').indexOf('data:image/') !== 0) {
            throw new Error((res && res.error) || 'Photo unavailable.');
          }
          return res.dataUrl;
        });
    }
  };

  global.MPS_API = MPS_API;
})(window);
