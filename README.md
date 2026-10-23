# MPS Silks — Store Operations Checklist

A production-ready, self-contained store-operations checklist for **MPS Silks**.
Staff sign in with a PIN, complete their assigned daily tasks (with photos where
required), and admins track completion, missed tasks, remarks, photo evidence and
audit history from a dashboard — with `.xlsx` / `.csv` export.

- **Frontend:** zero-build static HTML/CSS/JS → deploys to GitHub Pages as-is
- **Backend:** Google Apps Script (2 files) + Google Sheets as the single source of truth + private Google Drive for photos
- **Branding:** maroon / gold / cream theme with the MPS logo (no third-party branding anywhere)
- **This repository contains no BSC data, no real PINs, no spreadsheet IDs and no secrets.**

> ⚠️ Nothing in this project has been deployed. All commands below are local.
> Deployment steps (for you to run and authorize later) are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## Feature checklist

| Area | What you get |
|---|---|
| Login | 4–8 digit PIN keypad → server-issued session token (PIN never stored or echoed) |
| Roles | **Staff** and **Admin**, enforced **server-side** (hiding buttons is not authorization) |
| Staff workflow | Assigned tasks → local validation → photo upload → **submit only confirmed after backend save** → safe retry without duplicates |
| Task types | Yes/No (remarks required on “No”), rating (1–5), photo (upload required), free text |
| Missed vs pending | Sheet has no due times → **today = Pending**, **past dates = Missed** (documented rule) |
| Completion % | distinct assigned tasks with a valid latest submission ÷ active assigned tasks; **failed ≠ passed** |
| Dashboard | date filters, headline stats, section & staff breakdowns, daily trend, outstanding list, remarks + photos, updates log |
| Admin UI | add / edit / activate / delete tasks, manage staff + PINs + roles, store settings — **no code changes needed** |
| Photos | type/size validated, stored **private** in Drive, served only through authenticated `getPhoto` |
| Export | `.xlsx` (primary) and `.csv` (secondary), formula-injection safe, generated client-side |
| Audit | every submission keeps history (`Sequence: First/Update`, `Submission_ID`, update reason, timestamp) |
| Security | salted SHA-256 PINs, rate limiting, LockService, session revocation, cache invalidation |

---

## Quick start (local, nothing deployed)

Requirements: **Node ≥ 18.17** (only for lint/test/build), Python 3 (optional, for the workbook template / cross-checks).

```powershell
# 1. syntax-check every JS/.gs file
npm.cmd run lint          # → node scripts/check-syntax.js

# 2. run the full test suite (69 tests: core logic, dates/IST, XLSX/CSV, page hygiene)
npm.cmd test              # → node --test

# 3. production build → dist/
npm.cmd run build         # → node scripts/build.js

# 4. preview the build locally
npm.cmd run serve         # http://localhost:4173
```

> `npm.cmd` (or plain `node …`) is used on Windows when npm is blocked by PowerShell execution policy.

Set your backend URL at build time (public configuration, not a secret):

```powershell
$env:MPS_API_ENDPOINT = "https://script.google.com/macros/s/…/exec"
npm.cmd run build         # injects it into dist/js/config.js
```

If unset, the build keeps the `__MPS_API_ENDPOINT__` placeholder and the app
tells you it is not configured yet.

---

## Repository layout

```
mps-silks-store-checklist/
├── index.html            # PIN login (keypad)
├── checklist.html        # staff: today's tasks, validation, photos, submit
├── dashboard.html        # admin: stats, filters, breakdowns, trend, exports
├── admin.html            # admin: tasks / staff / settings (server-enforced)
├── css/theme.css         # maroon/gold/cream design system
├── js/
│   ├── config.js         # public endpoint (build-injected)
│   ├── auth.js           # token session storage
│   ├── api.js            # GET/POST client, photo fetch
│   ├── dates.js          # Asia/Kolkata date helpers
│   ├── ui.js             # shared UI helpers (modal, toast, spinner…)
│   └── xlsx.js           # zero-dependency .xlsx/.csv writer
├── images/mps-logo.png   # MPS logo
├── backend/
│   ├── mps-core.gs       # pure logic (validated by the Node test suite)
│   ├── MPS_BACKEND.gs    # Apps Script IO: routing, sessions, sheets, photos
│   └── appsscript.json   # manifest (Scopes, timezone, webapp config)
├── sheets/mps-silks-workbook-template.xlsx   # clean Google Sheet template
├── scripts/              # lint / build / workbook-template generator
├── tests/                # node --test suite
├── docs/                 # architecture, API, security, deployment, troubleshooting
├── .github/workflows/deploy.yml   # lint → test → build → GitHub Pages
├── .env.example          # public env config (placeholders only)
└── .nojekyll
```

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, data flow, completion-% maths, pending/missed rule, sheet schema & header mapping |
| [docs/API.md](docs/API.md) | every GET/POST action, parameters, responses, error codes |
| [docs/SECURITY.md](docs/SECURITY.md) | auth model, PIN hashing, sessions, rate limits, photo privacy, Apps Script limitations (honest) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **step-by-step commands for you to authorize later**: repo, Pages, Apps Script, sheet, properties, first admin |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | common errors and fixes |

---

## Development notes

- **No npm dependencies.** The XLSX writer, hash, date logic etc. are implemented in-repo, so the
  project installs nothing and audits cleanly. Node is used only for lint/test/build.
- **The Google Sheet is the source of truth** for tasks, users, submissions and settings. The app
  never assumes a fixed column order — headers are matched by alias, unmapped rows/columns are
  *reported* (dashboard “mapping problems”, admin log), never silently dropped.
- **The backend core is shared with tests:** `backend/mps-core.gs` is a pure UMD module, executed
  directly by `node --test` — the same code that runs in production is what the tests exercise.
- **Timezone:** everything (day boundaries, “today”, trend dates, sheet `Date` values) uses
  `Asia/Kolkata`, not the server or browser timezone.

## Status

| Check | Result |
|---|---|
| `npm.cmd run lint` | ✅ 14/14 files pass syntax check |
| `npm.cmd test` | ✅ 69/69 tests pass |
| `npm.cmd run build` | ✅ `dist/` produced (placeholder endpoint until configured) |
| Deployment | ❌ **Not performed — intentionally.** See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |
