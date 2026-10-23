# Security — MPS Silks Store Operations Checklist

This document states the security model, what was deliberately changed versus
the reference backend this project was based on, and the **honest limitations**
of running on Google Apps Script. No secrets, PINs, spreadsheet IDs or user
data exist in this repository — by design.

## 1. Threat model (what we defend against)

| Threat | Control |
|---|---|
| Staff/visitor guesses a PIN | salted hashes, uniform error messages (no user enumeration), rate limiting: ≥5 fails/PIN → 5 min lock, ≥20 global fails → 5 min lock, all under `LockService` |
| Stolen/leaked session token | random 32-byte token, server-side only, sliding TTL (default 8 h, hard cap 6 h), destroyed on logout, invalidated when the account is deactivated |
| Browser fakes an admin | **role is never read from the client** — `admin_()` re-derives `isAdmin` from the Users sheet on every admin request |
| Browser fakes a submission | `Staff_Name`, `Role`, `Date`, `Timestamp`, `Status`, `Sequence` are all derived server-side from the session + IST clock |
| Duplicate submission on retry | client `batchId` → `Submission_ID` checked under lock; retries return `duplicate: true` without writing |
| Photo leaked via public Drive link | files are created **without sharing**, no Drive URLs are ever returned; `getPhoto` requires a session (admins: any photo; staff: own files only, checked against file metadata) |
| Spreadsheet credentials in the repo | backend IDs live in **Script Properties** only; `.env` is git-ignored; `.env.example` contains an empty placeholder; tests scan the repo for leaked IDs/PINs |
| Formula injection in exports | XLSX **and** CSV neutralise leading `= + - @` and tab with an apostrophe |
| Stored XSS from sheet data | all sheet/API-provided text is passed through `UI.esc()` before `innerHTML` interpolation; toasts/loaders use `textContent` |
| Concurrent writes corrupting data | `LockService` serializes login, submits, and every admin sheet mutation; caches are generation-invalidated |

## 2. Authentication & sessions

```
PIN (4–8 digits, entered on keypad)
  → POST login (rate-limited, lock-guarded)
  → verifyPin(storedHash, pin, PIN_SALT)      // constant-time compare on hash
  → random token (Utilities.getUuid ×2 → 256-bit)
  → CacheService "sess:<token>" = {name, role, isAdmin, exp}   (server-side!)
  → client stores ONLY the token
```

- **The PIN never leaves the server after login**: it is not stored
  client-side (no `localStorage`/`sessionStorage` entries, no URL, no DOM
  data attributes — enforced by tests), and no API ever returns a PIN or hash.
- PINs are stored as `sha256:<hex(PIN_SALT + ':' + PIN)>` in the Users sheet.
  A legacy **plain** PIN still works for its first use and is then rewritten
  as a hash (progressive migration, logged only as success/failure).
- `PIN_SALT` is auto-generated into Script Properties on first run.
- Every request re-validates the session against the Users sheet (60 s cache),
  so **deactivating a user cuts access within ~1 minute**; explicit
  deactivation also bumps a per-user revocation stamp (`rev:<name>`, 6 h).
- Admin rights come from the sheet column `Role`
  (`admin`, `owner`, `manager`, `store manager`, `storemanager`, `proprietor`,
  case-insensitive). Anything else — including a missing `Role` column — is
  **Staff**.

## 3. Authorization (two roles, server-side)

- **Staff:** `me`, `getChecklist`, `submitChecklist`, `uploadPhoto`,
  `getPhoto` (own files), `logout`.
- **Admin** (everything staff can, plus): `getDashboard`, `getTasks`,
  `getUsers`, `getSettings`, `addTask`, `updateTask`, `toggleTask`,
  `deleteTask`, `addUser`, `updateUser`, `updateSettings`.
- Implemented by `admin_(p, fn)` wrapping `requireSession_(p, true)` — a
  hidden button in the UI is a convenience, **never** the control.
- Additional server-side guards: staff can only submit tasks assigned to them;
  `deleteTask` refuses when submission history exists; `updateUser` refuses to
  remove the last active admin.

## 4. Difference from the reference backend (what was fixed)

This project started from a reference Apps Script backend. The following
**flaws of the reference were intentionally not carried over**:

| Reference behaviour | This project |
|---|---|
| Admin PIN hard-coded in source (`ADMIN_PW = '…'`) | no static credential anywhere; roles come from the sheet |
| “Everyone is admin” / client-declared admin | admin derived per-request from the session, which is derived from the Users sheet |
| Admin PIN accepted **on every request** | single login → random session token, revocable, TTL-bound |
| Plain-text PINs in the sheet | salted SHA-256 + automatic migration of existing plain values |
| Photos shared “anyone with the link” | private Drive files, authenticated `getPhoto` only |
| Web-app URLs / third-party endpoints in code | single public endpoint injected from configuration |
| Completion counted *failures as done* | submitted ÷ assigned, with failed reported separately (never in “passed”) |
| Writes without concurrency control | `LockService` on all mutations, idempotent submits |

## 5. Configuration & data hygiene

- **Backend-only** (Script Properties): `SS_ID`, `PHOTO_FOLDER_ID`,
  `SESSION_TTL_MIN`, `PIN_SALT`. Never in code, never in the repo, never in
  the browser.
- **Public** (may live in the repo): the Apps Script `/exec` URL
  (`MPS_API_ENDPOINT`). It is *addressing*, not authentication.
- `.gitignore` covers `.env`, `dist/`, editor/OS junk. Tests fail if a real
  spreadsheet ID, Drive folder ID, endpoint, PIN pattern or “BSC” reference
  appears anywhere in app code.
- `sheets/mps-silks-workbook-template.xlsx` is generated by
  `scripts/make-workbook-template.py`, which **refuses to save** if any user
  row or the known source PIN would be included.

## 6. Honest limitations of the Apps Script platform

These cannot be “fixed” in application code; they are accepted and documented:

1. **No custom HTTP status codes or security headers.** All responses are
   `200` and Apps Script sets its own headers — no `Cache-Control`,
   `CSP`, `X-Frame-Options`, HSTS. Clients must trust `ok`/`code` in the JSON,
   not the status code. (The app is a JSON API + Pages site, not HTML framing,
   which limits the impact.)
2. **Sessions live in a shared cache, not a database.** CacheService cannot be
   enumerated, so “log out all sessions of user X” is impossible directly —
   we approximate it with per-user revocation stamps checked on each request.
   Also, cache TTL is capped at 6 hours, which is why `SESSION_TTL_MIN` ≤ 3000.
3. **Sessions are shared-infrastructure.** CacheService is per-script, not per
   user; keys are unguessable (`sess:` + 256-bit random), which is the control.
4. **`doGet`/`doPost` are callable by anyone who knows the URL** (Apps Script
   “Anyone” web-app access is required for a token-less login page). All data
   actions therefore require a session; `health` exposes nothing but a name
   and version.
5. **The token travels in the query string for GETs** (Apps Script does not
   expose request headers to `doGet`). Query strings can end up in browser
   history and proxy logs — mitigated by short TTLs and logout invalidation.
   POSTs send it in the body (and `X-Token` header).
6. **Apps Script runs as the deployer** (“Execute as me”), so Google-side
   access to the spreadsheet/Drive is the deployer's account. Protect the
   sheet with standard Google sharing (only the service/deployer account needs
   edit; admins can view via the app).
7. **Google quotas** (URL fetches, executions, triggers) apply. LockService
   holds are short (validation + append only); a busy lock returns `BUSY` and
   the client simply retries.
8. **SHA-256 is a fast hash**, not a memory-hard KDF (Apps Script offers no
   bcrypt/scrypt/PBKDF2 synchronously). For 4–8 digit PINs this is
   compensated by: per-PIN and global rate limits, lockout windows, generic
   failure messages, and `PIN_SALT` stored outside the sheet. PINs should
   never be reused elsewhere.
9. **Photo upload limit:** the Apps Script request body caps decoded images at
   ~3 MB; the client downscales before upload.

## 7. Repository hygiene (enforced by tests)

- No `BSC` branding, third-party endpoints, spreadsheet/folder IDs, or
  hard-coded PINs anywhere in `*.html/js/gs/css/json/yml`.
- No `ANYONE_WITH_LINK` / public Drive URLs in frontend or backend.
- `.env.example` contains an empty placeholder only.
- Every routed backend action must have a defined handler (regression test).
- Backend config must go through Script Properties (`openById('literal…')`
  patterns are rejected).
