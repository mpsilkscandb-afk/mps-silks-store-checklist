# Architecture — MPS Silks Store Operations Checklist

## 1. Components

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (GitHub Pages, static files — no server of our own)        │
│  index.html  checklist.html  dashboard.html  admin.html             │
│  js/config.js(endpoint)  auth.js(token)  api.js  dates.js  xlsx.js  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS  GET (?action=…)  /  POST (JSON body)
                │ Authorization header: token from PIN login
┌───────────────▼──────────────────────────────────────────────────────┐
│  Google Apps Script web app (deployed from this repo's backend/)    │
│  MPS_BACKEND.gs — routing, sessions, rate limits, photos, sheets    │
│  mps-core.gs     — pure logic (header mapping, validation, maths)   │
│      │               │                    │                         │
│      ▼               ▼                    ▼                         │
│  Google Sheets   CacheService         Drive folder (PRIVATE photos) │
│  (source of      (sessions,           files never shared publicly; │
│   truth)          rate limits,         served via getPhoto only)    │
│                   caches)                                           │
└──────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **Zero-build static frontend.** Plain HTML/JS/CSS identical in dev and prod;
  `scripts/build.js` only copies files and injects the public endpoint. GitHub
  Pages serves `dist/` as-is (`.nojekyll` included).
- **Google Sheets is the single source of truth** for tasks, users,
  submissions and settings. There is no separate database, and the app never
  writes to any other spreadsheet.
- **Pure core shared with tests.** All business logic lives in
  `backend/mps-core.gs` (UMD). Apps Script loads it as a library-style file;
  Node loads the *same file* in `tests/`. What the tests verify is exactly what
  runs in production.
- **Client trusts nothing.** The frontend pre-validates for good UX; the
  backend re-validates everything and is the only place authorization happens.

## 2. Request flow (staff submission)

1. `index.html` — PIN entered on keypad → `POST {action:'login'}`.
   Backend verifies the salted hash under a lock, rate-limits failures, and
   returns a **random session token** (stored server-side in CacheService).
   The PIN itself is never stored client-side.
2. `checklist.html` — `GET ?action=getChecklist` returns *the staff member's*
   assigned, active tasks for the IST “today”, merged with today's latest
   submissions (so already-done tasks show as done).
3. Staff answers tasks; for photo tasks the image is resized client-side,
   then `POST {action:'uploadPhoto'}` → `photoId` (private Drive file).
4. Local validation (`validateNew`) explains problems (mandatory missing,
   photo missing, “No” without remark). Then `POST {action:'submitChecklist'}`
   with a client-generated **`batchId`**.
5. Backend: session check → assignment check → server validation →
   **LockService** → idempotency check (`batchId` already written today?
   → `{duplicate:true}`, no second write) → append rows with
   `Sequence = First|Update` → invalidate caches → `{ok:true, timestamp}`.
6. **Only after `ok:true`** does the UI mark tasks submitted and clear the
   draft. If the network drops, the draft and `batchId` are kept: *Retry* is
   therefore safe — a response-less retry cannot double-write.
7. An edit of an already-submitted task requires an **update reason**; it is
   appended as a new row (`Sequence = Update`), so history is preserved and
   the dashboard “updates log” can show both entries.

## 3. Completion maths (single place: `computeDashboard`)

For a date range `[from, to]` and “today”:

- **assigned** = active tasks assigned to the user set (MPS workbook has no
  assignment column ⇒ every active task is assigned to `['all']` = everyone).
- **submitted (distinct)** = tasks whose *latest* submission on that date has a
  valid status (`OK` or `FAIL`). Multiple submissions of the same task that day
  count **once** (resubmissions are tracked separately as *updates*).
- **passed** = latest status `OK`. **failed** = latest status `FAIL`.
  **A failure is submitted, never passed** — `passed + failed === submitted`.
- **completion % (`pct`)** = `round(submitted ÷ assigned × 100)`
- **pass rate (`passPct`)** = `round(passed ÷ assigned × 100)` (shown separately)
- **outstanding** = assigned − submitted, listed task-by-task with a label:
  - **Pending** — the evaluated day *is* today
  - **Missed** — the evaluated day is in the past

> **Why Pending vs Missed works this way:** the workbook has **no due-time
> column**, so “late today” cannot be determined honestly. Rules:
> *today is never “missed” — tasks due today are **Pending**; only days that
> have fully passed can be **Missed**.* If due times are ever added to the
> sheet, this is the one rule that must be revisited (it is documented in the
> UI as well).

Per-section and per-staff stats aggregate the same per-task rows, and the trend
computes the headline numbers for each day of the range (range aggregate =
`sum(submitted) ÷ sum(assigned)` across days).

## 4. Sheet schema & header mapping

Source workbook template: `sheets/mps-silks-workbook-template.xlsx`
(4 tabs — created from the MPS workbook with **no PINs and no user rows**).

| Sheet | Purpose | Required headers (aliases accepted) |
|---|---|---|
| `Checklist_Config` | tasks = source of truth | `Task_ID`, `Section`, `Task_Name`, `Type`, `Mandatory`, `Photo_Required`, `Active`, optional `Assigned_To`, optional `Frequency` (`Daily` / `Weekly` = Fridays / `Monthly` = the 28th; blank = Daily) |
| `Users` | staff accounts | `Name`, `PIN`, `Role`, `Active` |
| `Submissions` | append-only audit log | `Timestamp`, `Date`, `Staff_Name`, `Role`, `Section`, `Task_ID`, `Task_Name`, `Type`, `Response`, `Photo_URL`, `Status`, `Remarks`, `Sequence`, `Override_Reason`, `Submission_ID`, `Photo_Time` |
| `Settings` | key/value store | `Key`, `Value` (uses `Store_Name`, `Store_Location`, …) |

Mapping rules (`mapColumns(headers, kind)` in `mps-core.gs`):

- Columns are matched **by header alias per entity** (exact, then prefix) —
  *column order never matters* and extra columns are ignored, not fatal.
- Unknown `Type` values are **reported** and defaulted to `yesno` so the task
  still works; rows with problems appear in `problems[]` → dashboard
  “mapping problems” banner + `console.warn` server-side.
- Unrecognisable sheets produce an explanatory problem instead of an empty app.
- Blank `Active` = active; `Active/Yes/No` parsing is lenient on case/wording.
- Task IDs are strings; new tasks get `T001`, `T002`, … numbering by
  `addTask`.

Values written by the backend are always derived from the **session** (staff
name, role, IST timestamp, IST date) — a client cannot spoof them.

## 5. Date/time handling

- All date maths happens in `Asia/Kolkata` (`Intl.DateTimeFormat` on the
  client, `Utilities.getScriptZone()`/explicit zone on the backend).
- `Date` cells in `Submissions` are normalised to `YYYY-MM-DD`
  (`normDateCell` accepts `YYYY-MM-DD`, `DD/MM/YYYY`, `YYYY-MM-DD hh:mm`, Excel
  dates) so string comparison works for filtering.
- Today = IST today; the day rolls over at 00:00 IST even if the browser
  timezone differs (covered by boundary tests at 18:30 UTC).

## 6. Session & authorization flow

- Login → random 32-byte token in `CacheService` (`sess:<token>`, sliding TTL,
  default 480 min, hard cap 6 h by CacheService).
- Every action passes `requireSession_`; admin actions pass `admin_` which
  checks the **server-side** `isAdmin` flag derived from the Users-sheet
  `Role` (`admin|owner|manager|store manager|…`).
- The session's user is re-checked against the Users sheet (60 s cache), so
  deactivating a user revokes access within ~1 minute; explicit deactivation
  also bumps a per-user revocation stamp.
- Rate limits: ≥5 failed PINs → that PIN locked 5 min; ≥20 global failures →
  everything locked 5 min (both under LockService, 15 min windows).
- Full details and the honest limitation list: [SECURITY.md](SECURITY.md).

## 7. Photo pipeline

`uploadPhoto` (client, pre-submit) → MIME/type/≤3 MB validation →
private Drive file named `mps_<date>_<staff>_<taskId>_<uuid>.<ext>` →
metadata in the file *description* `{staff, taskId, date}` → `photoId` returned,
stored in `Submissions.Photo_URL`.

Read: `GET ?action=getPhoto&fileId=…` with a session — admins may fetch any
photo; staff only files whose description `staff` matches their own name.
No file is ever shared publicly; no Drive URL is ever sent to the browser.

## 8. Export pipeline (client-side)

`dashboard.html` → `js/xlsx.js` builds a real `.xlsx` (stored-ZIP OOXML,
no dependencies) or a UTF-8 BOM CSV from the same already-filtered data.
Any user text that looks like a formula (`=`, `+`, `-`, `@`, tab) is
neutralised with a leading apostrophe (CSV *and* XLSX).

## 9. Build & CI

- `scripts/check-syntax.js` — parses every `.js/.gs/.json` file (lint).
- `scripts/build.js` — copies to `dist/`, injects `MPS_API_ENDPOINT` into
  `dist/js/config.js`.
- `.github/workflows/deploy.yml` — on push to `main`: lint → test → build →
  deploy `dist/` to GitHub Pages (endpoint from repository variable
  `MPS_API_ENDPOINT`; never a secret).
