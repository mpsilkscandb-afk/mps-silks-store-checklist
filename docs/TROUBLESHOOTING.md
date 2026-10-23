# Troubleshooting — MPS Silks Store Operations Checklist

## Local development

| Symptom | Cause / fix |
|---|---|
| `npm` blocked by PowerShell execution policy | use `npm.cmd run …` or call `node scripts/…` directly |
| `Could not find 'tests/…'` when running tests | run `npm.cmd test` (`node --test` discovers `tests/*.test.js`); don't pass a trailing-slash path on Windows |
| Build warns “MPS_API_ENDPOINT not set” | expected until Step 6 of deployment; set `$env:MPS_API_ENDPOINT` before `npm.cmd run build`, or set the GitHub repo variable |
| Tests hang | usually a change in `mps-core.gs` loops — the suite runs the real backend core; check the last edited loop bounds |
| `python : … openpyxl` failures in `tests/xlsx.test.js` | that test auto-skips without Python; install `pip install openpyxl` to run the cross-validation |

## Backend (Apps Script)

| Symptom / code | Cause / fix |
|---|---|
| `CONFIG: Missing Script Property "SS_ID"` | set Script Properties (docs/DEPLOYMENT.md Step 5), then re-run |
| `CONFIG: Required sheet "Users" not found` | sheet/tab names must be exactly `Checklist_Config`, `Users`, `Submissions`, `Settings` |
| `CONFIG: … missing required headers` | row 1 of `Checklist_Config` must contain `Task_ID`, `Section`, `Task_Name` (order doesn't matter; see alias table in ARCHITECTURE.md) |
| `AUTH: Session expired` after 8 h | normal TTL; re-login. Lower/raise with `SESSION_TTL_MIN` (max 3000) |
| `AUTH: Your account is inactive` | user set to `Active = No` — reactivate in Admin UI or sheet |
| `RATE: Too many failed attempts` | 5 failed PINs (per PIN) or 20 globally lock logins for 5 minutes by design; wait, or clear via a new deployment execution if urgent |
| `BUSY: The server is busy` | LockService contention — retry; the client's retry is idempotent |
| `VALIDATION: Task T… is not assigned to you` | the task's `Assigned_To` doesn't include this staff name/role (blank = everyone) |
| `VALIDATION: … has submission history — deactivate it instead` | by design: history is append-only |
| `FORBIDDEN: Admin access required` | user's `Role` isn't admin-style — set `Admin` in `Users` |
| First login doesn't change plain PIN to `sha256:` | migration happens only on successful login; check Apps Script logs (`console.error`) |
| Login says invalid but PIN is right | row has `Active ≠ Yes`, or duplicate names in `Users` (names must be unique) |
| Photos fail with `CONFIG` | `PHOTO_FOLDER_ID` missing/incorrect; confirm the folder is accessible by the deployer account |
| Photos fail with `STORAGE` | Drive quota or sharing change; check `PHOTO_FOLDER_ID` permissions |
| `getPhoto` returns `FORBIDDEN` for staff | file description `staff` doesn't match the session user (files uploaded before a rename, etc.) |
| Dashboard numbers stale | caches invalidate on writes; hard-refresh. `Submissions` edits made **by hand** in the sheet are picked up within ~30 s |

## Frontend (GitHub Pages)

| Symptom | Cause / fix |
|---|---|
| “The API endpoint is not configured yet” | `MPS_API_ENDPOINT` not set at build time — set the repo variable and re-run CI, or edit `js/config.js` |
| CORS / “Network error” right after deploy | web-app deployed as “Execute as: Me / Anyone”? Redeploy as **Web app** with access **Anyone**; use the `/exec` URL (not `/dev`) |
| Endless login loop | token rejected (`AUTH`) — usually an expired session or deactivated account; check `?action=health` first |
| Photos don't upload on old phones | client downscales, but raw files > 3 MB are rejected — retake; see console for the exact message |
| XLSX won't open | run `npm.cmd test` — `tests/xlsx.test.js` validates the ZIP package (and with openpyxl when available) |
| Wrong day shown near midnight | everything is `Asia/Kolkata`; the browser timezone must not matter — check `js/dates.js` boundary tests if it does |

## Reading the diagnostics

- **Mapping problems:** dashboard banner + `admin.html` “mapping issues” list
  every row/header the backend couldn't interpret — nothing is silently
  dropped (`getTasks` → `problems[]`).
- **Apps Script logs:** script.google.com → your project → *Executions* /
  *Logs* (or `clasp logs`). Messages never contain PINs, tokens or sheet data.
- **Sheet as audit trail:** every submission is a row (incl. `Submission_ID`,
  `Sequence`, `Override_Reason`) — hand edits are visible as outliers.
