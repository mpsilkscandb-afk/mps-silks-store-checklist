# API — MPS Silks Store Operations Checklist

Backend: Google Apps Script web app (deployed from `backend/MPS_BACKEND.gs` +
`backend/mps-core.gs`), returning **JSON** for every action (`getPhoto` returns the photo as a
base64 `dataUrl`, because Apps Script cannot serve binary files).

## Transport

| | |
|---|---|
| Endpoint | `MPS_API_ENDPOINT` — the `/exec` web-app URL (public configuration, **not** a secret) |
| Reads | `GET {endpoint}/?action=<name>&<params…>&token=<session>` |
| Writes | `POST {endpoint}` with a JSON body: `{ "action": "<name>", "token": "…", … }` |
| Content-Type | `text/plain;charset=utf-8` **deliberately** — avoids the CORS preflight; the body is still strict JSON |
| Token | Session token from `login`, sent as `token` (query/JSON field) and echoed in the `X-Token` header by the client |
| Redirects | followed automatically (Apps Script may bounce `script.googleusercontent.com`) |

Every JSON response contains `ok: true|false`. Errors add `error` (human
message) and `code` (machine-readable). **PINs are never returned by any
action.**

## Error codes

| Code | Meaning | Client behaviour |
|---|---|---|
| `AUTH` | missing/expired token, or account deactivated | clear session → login screen |
| `FORBIDDEN` | authenticated but not allowed (admin-only, or task not assigned to you) | show message |
| `RATE` | too many failed PIN attempts | show message, wait |
| `BAD_PIN` | invalid PIN format **or** wrong PIN (same message — no user enumeration) | show message |
| `VALIDATION` | input failed validation | show `error` / `errors[]` |
| `NOT_FOUND` | referenced task/photo does not exist | show message |
| `BAD_REQUEST` | body was not parseable JSON | show message |
| `BAD_ACTION` | unknown `action` | programming error |
| `CONFIG` | Script Property or sheet header missing | show message, see docs/DEPLOYMENT.md |
| `STORAGE` | Drive upload failed | retry allowed |
| `BUSY` | LockService could not be acquired | retry allowed |
| `SERVER` | unexpected server error (details logged, never returned) | retry allowed |
| `NETWORK` *(client)* | fetch failed | retry allowed (idempotent thanks to `batchId`) |

---

## Public actions (no session required)

### `login` → POST
```json
{ "action": "login", "pin": "1234" }
```
Response `200`:
```json
{ "ok": true, "token": "…", "name": "…", "role": "Staff",
  "isAdmin": false, "expiresInMin": 480 }
```
Failures: `BAD_PIN`, `RATE`. Rate limits: ≥5 failures/PIN → 5 min lock;
≥20 global failures → 5 min lock (LockService-guarded windows).

### `health` → GET
`{ "ok": true, "app": "mps-silks-checklist", "v": 1 }` — unauthenticated
liveness probe (no data).

---

## Session actions (any valid token)

### `logout` → POST
Destroys the session token. `{ "ok": true }` (always ok — idempotent).

### `me` → GET
```json
{ "ok": true, "name": "…", "role": "Staff|Admin", "isAdmin": false }
```

### `getChecklist` → GET  *(staff)*
Today's (IST) assigned, active tasks merged with today's latest submissions.
```json
{ "ok": true, "date": "2026-10-21", "name": "…", "role": "…",
  "store": { "name": "MPS Silks", "location": "…" },
  "sections": [ { "section": "Opening & Security",
      "tasks": [ { "taskId": "T001", "taskName": "…", "type": "photo",
        "mandatory": true, "photoRequired": true, "submitted": false,
        "submittedStatus": null } ] } ] }
```
When already submitted, `submittedStatus` carries `{response, status,
staffName, timestamp, remarks, photoRef, photoTime, sequence, isMine}`;
`photoRef`/`photoTime` are the sheet's comma-joined photo ids and their
capture times (see `submitChecklist`).

### `submitChecklist` → POST
```json
{ "action": "submitChecklist", "token": "…", "batchId": "client-uuid",
  "entries": [
    { "taskId": "T001", "response": "Photo", "photoRef": "drive-file-id-1,drive-file-id-2",
      "photoTime": "2026-10-21 09:10:00,2026-10-21 09:12:00",
      "remarks": "", "updateReason": "" } ] }
```
A task may carry **at most 5 photos**: `photoRef` is the Drive file ids
(each ≥ 10 chars of `[A-Za-z0-9_-]`) joined with `,`; `photoTime` holds the
matching capture time per id in the same order (an empty slot, e.g.
`t1,,t3`, means "no time for that photo"). Rows keep the raw lists in
`Photo_URL` / `Photo_Time`.
Server pipeline: session → assignment (staff may only submit their own
tasks) → `validateEntries` (types, mandatory, photo presence, remarks on
failure, length caps, unknown/duplicate IDs) → **LockService** →
**idempotency**: if `batchId` already exists in today's sheet →
`{ "ok": true, "duplicate": true, … }` **without writing again** → append
rows with `Sequence = First|Update` derived server-side → cache invalidation.

Response:
```json
{ "ok": true, "message": "Checklist submitted.",
  "saved": [ { "taskId": "T001", "status": "OK", "sequence": "First" } ],
  "timestamp": "2026-10-21 10:15:00", "date": "2026-10-21" }
```
Failures: `AUTH`, `VALIDATION` (with full `errors[]`), `FORBIDDEN`.

### `uploadPhoto` → POST
```json
{ "action": "uploadPhoto", "token": "…", "taskId": "T001",
  "photoBase64": "data:image/jpeg;base64,…" }
```
Validates MIME (`image/jpeg|png|webp`) and decoded size (≤ 3 MB), stores the
file **privately** in `PHOTO_FOLDER_ID` with owner metadata in the file
description. Response: `{ "ok": true, "photoId": "…", "name": "mps_….jpg" }`.
Failures: `VALIDATION`, `CONFIG`, `STORAGE`, `AUTH`.

### `getPhoto` → GET
`?action=getPhoto&fileId=<photoId>` → JSON `{ ok, dataUrl }` where `dataUrl` is
`data:image/...;base64,...` (Apps Script cannot return raw image bytes). Admins may fetch any photo; staff only files whose
description `staff` matches their own name; otherwise `FORBIDDEN` JSON.
No Drive URL is ever exposed.

---

## Admin actions (session with admin role, server-enforced)

### `getPhotos` → GET
Params: `dateFrom`, `dateTo` (`YYYY-MM-DD`; default the last 7 days; capped at
92 days). Returns `{ ok, dateFrom, dateTo, total, truncated, photos:[{ date,
timestamp, photoTime, staffName, section, taskId, taskName, status, sequence, remarks,
photoRef, photoIndex, photoCount }] }`, newest first, at most 200. A row with
several photos is expanded into **one item per photo**, so each `photoRef` is
a single id (loaded with `getPhoto`) with its own `photoTime` (`YYYY-MM-DD
HH:MM:SS` IST, or empty for older photos); `photoIndex` (1-based) and
`photoCount` say where the photo sits among the task's photos.

### `getDashboard` → GET
Params: `dateFrom`, `dateTo` (`YYYY-MM-DD`; swapped if reversed; capped at
92 days). Defaults to today.
```json
{ "ok": true, "storeName": "MPS Silks",
  "dashboard": {
    "from": "…", "to": "…", "today": "…",
    "headline": { "assigned": 34, "submitted": 30, "passed": 28,
                  "failed": 2, "pending": 4, "pct": 88, "passPct": 82 },
    "outstandingLabel": "Pending | Missed",
    "outstanding": [ { "taskId": "…", "taskName": "…", "outstandingLabel": "Missed" } ],
    "detail": [ { "taskId": "…", "state": "PASS|FAIL|PENDING|…", "updates": 1, … } ],
    "sections": [ { "section": "…", "assigned": 8, "submitted": 8, "passed": 7,
                    "failed": 1, "pending": 0, "pct": 100 } ],
    "staff":   [ { "name": "…", "submitted": 12, "passed": 11, "failed": 1 } ],
    "trend":   [ { "date": "…", "submitted": 1, "pct": 50 } ],
    "range":   { "assignedTotal": 68, "submittedTotal": 60, "pct": 88 },
    "updates": [ { "taskId": "…", "totalEntries": 2, "history": [ … ] } ],
    "mappingProblems": [ { "row": 5, "issue": "…" } ]
  } }
```
Rule reminder: *distinct assigned tasks with valid latest submission ÷ active
assigned*; failed ≠ passed; today = `Pending`, past days = `Missed`.
Detail rows keep `photoRef`/`photoTime` as the raw comma-joined lists and add
`photoCount` (how many photos the latest submission carries).

### `getTasks` → GET
`{ ok, tasks: [ { taskId, section, taskName, type, mandatory, photoRequired, active, assignedTo, frequency } ], problems: [] }`
`frequency` is `daily | weekly | monthly`. Weekly tasks are due every Friday and monthly tasks on the 28th (IST); a blank or unknown value means daily.
(all tasks incl. inactive, plus sheet-mapping problems).

### `addTask` → POST
`{ section, taskName, type, mandatory, photoRequired, active, assignedTo?, frequency? }`
→ `{ ok, message, taskId: "T035" }` (IDs auto-numbered `T###`).
`type` ∈ `yesno | rating | photo | text`; flags accept `Yes/No`-style values.

### `updateTask` → POST
`{ taskId, …any subset of addTask fields }` → `{ ok, message, taskId }`.

### `toggleTask` → POST
`{ taskId }` → `{ ok, taskId, active: "Yes" | "No" }` (flips `Active`).

### `deleteTask` → POST
`{ taskId }` → `{ ok, message }`. **Refused** (`VALIDATION`) when the task has
submission history — deactivate instead, history is never destroyed.

### `getUsers` → GET
`{ ok, users: [ { name, role, active, pinSet, isAdmin } ] }` — **never**
returns PINs or hashes (`pinSet` is a boolean only).

### `addUser` → POST
`{ name, pin, role?, active? }` — `pin` must be 4–8 digits; stored as
`salted SHA-256`. Duplicate names and duplicate PINs are refused.
`{ ok, message }`.

### `updateUser` → POST
`{ name, newPin?, role?, active? }`. Guards: valid PIN format, unique PIN,
**cannot remove/demote the last active admin**. Deactivating a user revokes
their sessions immediately. `{ ok, message }`.

### `getSettings` → GET / `updateSettings` → POST
`{ ok, settings: { Store_Name: "MPS Silks", … } }` /
`{ settings: { "Key": "Value", … } }` → upserts rows in the `Settings` sheet.

---

## Notes for integrators

- All timestamps/dates are written **server-side** in `Asia/Kolkata`; clients
  cannot spoof `Staff_Name`, `Role`, `Date` or `Status`.
- `POST` bodies are read exactly once; retries are safe **only because of
  `batchId`** (reuse the same one when retrying a failed request).
- Unknown actions return `BAD_ACTION`; malformed JSON returns `BAD_REQUEST`.
- There is no endpoint that lists sessions, returns PINs, or serves Drive URLs.
