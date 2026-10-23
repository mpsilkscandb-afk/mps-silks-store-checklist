# Deployment — MPS Silks Store Operations Checklist

> ## ⚠️ Status: NOTHING HAS BEEN DEPLOYED
> No GitHub repository exists yet, no push, no Pages site, no Apps Script
> deployment, no sheet or Drive changes, no live data touched. Everything
> below is prepared for **you to review and authorize later**. Run the steps
> in order; each one names the command or click it requires.

All local pre-checks are green:

| Check | Command | Result |
|---|---|---|
| Syntax/lint | `npm.cmd run lint` | ✅ 14/14 files |
| Tests | `npm.cmd test` | ✅ 69/69 |
| Build | `npm.cmd run build` | ✅ `dist/` |

---

## Step 0 — Prerequisites

- GitHub account, Google account (for Sheets/Drive/Apps Script)
- Node ≥ 18.17 locally (for lint/test/build before pushing)
- This folder: `mps-silks-store-checklist/` (future repo root)

---

## Step 1 — Create the GitHub repository and push (you authorize)

No git repo exists yet. From `mps-silks-store-checklist/`:

```powershell
git init -b main
git add .
git status                      # review: no .env, no secrets, no dist/
git commit -m "MPS Silks store operations checklist: frontend + Apps Script backend"

# create an empty PRIVATE (or public, if you prefer) repo, then:
git remote add origin https://github.com/<your-account>/mps-silks-store-checklist.git
git push -u origin main
```

Verify `git status` shows **no** `.env`, no `dist/`, no spreadsheet files
(`sheets/*.xlsx` template *is* intended to be committed — it contains no PINs
and no user rows).

> This is the first command you must authorize. Nothing above talks to any
> existing system.

## Step 2 — Enable GitHub Pages (you authorize)

1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Repo → **Settings → Secrets and variables → Actions → Variables** → create
   `MPS_API_ENDPOINT` with the value from Step 5 (empty for the first run is
   fine — the workflow builds with the placeholder until you set it).

The workflow `.github/workflows/deploy.yml` runs on every push to `main`:
**lint → test → build → deploy `dist/` to Pages.** It will only succeed once
tests pass; the site is at `https://<account>.github.io/mps-silks-store-checklist/`.

---

## Step 3 — Create the Google Sheet (source of truth)

1. New Google Sheet (e.g. **“MPS Silks — Store Ops Checklist”**).
2. Import the template tabs from `sheets/mps-silks-workbook-template.xlsx`
   (File → Import → Upload → *Replace spreadsheet* keeps all 4 tabs):
   - `Checklist_Config` — 34 MPS tasks, already populated
   - `Users` — headers only (`Name, PIN, Role, Active`), **add your people**
   - `Submissions` — headers only incl. `Submission_ID` (the app appends)
   - `Settings` — `Store_Name = MPS Silks`, timings
3. **Add the first admin** — exactly one row in `Users`:

   | Name | PIN | Role | Active |
   |---|---|---|---|
   | Your Name | 4–8 digits of your choice | `Admin` | Yes |

   > The MPS workbook had **no `Role` column**, so anyone without `Admin`
   > (or `Owner/Manager/Store Manager`) is a **Staff** user — set the Role
   > *before* the first login or you will have no admin. PINs are hashed on
   > first successful login; until then the sheet holds the plain value, so
   > share the sheet edit access only with the deployer account.
4. Sheet ID = the long string in the URL:
   `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit` → save it
   for Step 5. It is a **backend-only** value (Script Property, never a repo).

## Step 4 — Private photo folder (you authorize)

1. Google Drive → new folder, e.g. **“MPS Checklist Photos”**.
2. Keep default (private) sharing — **do not** get a share link.
3. Copy the folder ID (`.../folders/`**`<FOLDER_ID>`**`) for Step 5.

---

## Step 5 — Create & configure the Apps Script backend (you authorize)

Option A — **clasp** (repeatable):

```powershell
npm.cmd install -g @google/clasp      # only if you don't have it
clasp login                           # opens Google consent
clasp create --type standalone --title "MPS Silks Checklist API"
# then, from the repo root:
clasp push   # sends backend/mps-core.gs + backend/MPS_BACKEND.gs + appsscript.json
```

Option B — **manual** (no tooling): script.google.com → New project →
paste `backend/mps-core.gs` into a file named **`mps-core`**,
`backend/MPS_BACKEND.gs` into a file named **`MPS_BACKEND`** (same order),
Project Settings → check “Show appsscript.json” and paste
`backend/appsscript.json`.

**Script Properties** (Project Settings → Script Properties):

| Key | Value | Required |
|---|---|---|
| `SS_ID` | sheet ID from Step 3 | ✅ |
| `PHOTO_FOLDER_ID` | Drive folder ID from Step 4 | ✅ (photo tasks) |
| `SESSION_TTL_MIN` | e.g. `480` (8 h) | optional, default 480 |
| `PIN_SALT` | — leave unset; auto-generated on first run | — |

**Deploy** (Deploy → New deployment → Web app):

- Description: `v1`
- **Execute as: Me** (the deployer account)
- **Who has access: Anyone** (logins are PIN-protected; the app is an API, not
  a Google resource)
- Authorize when prompted. The consent screen will request:
  - *spreadsheets* (the sheet above),
  - *Drive* — **all files**: required because `DriveApp` reads one manually
    created folder; restrict your Drive sharing accordingly,
  - *external requests* (none by default — used only for redirects).
- Copy the `/exec` URL → this is `MPS_API_ENDPOINT`.

**Smoke test before wiring the frontend:**

```
GET  <EXEC_URL>?action=health          → {"ok":true,"app":"mps-silks-checklist","v":1}
POST <EXEC_URL>  {"action":"login","pin":"<your PIN>"}   → {"ok":true,"token":"…"}
GET  <EXEC_URL>?action=me&token=…      → {"ok":true,"isAdmin":true}
```

## Step 6 — Point the frontend at the backend (you authorize)

```powershell
# set the repository variable in GitHub UI first (Step 2), then:
git push origin main                   # CI runs lint → test → build → Pages
```

Local alternative for testing:

```powershell
$env:MPS_API_ENDPOINT = "<EXEC_URL>"
npm.cmd run build
npm.cmd run serve                      # http://localhost:4173
```

Redeploy the web app **only if** you change backend code (Deploy → Manage
deployments → Edit → *Version: New version* → Deploy). The `/exec` URL stays
the same for new versions.

---

## Step 7 — Post-deploy verification checklist

- [ ] `?action=health` returns `ok:true`
- [ ] Login with the admin PIN → Dashboard visible; login with a staff PIN →
      Dashboard/Admin **not** offered *and* direct URLs redirect to login
      (server would refuse the API calls anyway)
- [ ] Staff: today's 34 tasks load, validation messages appear, photo task
      captures + uploads, submit shows **“Saved” only after the server
      confirms**, refresh shows tasks as done
- [ ] Submitting again the same day marks rows `Sequence = Update`
- [ ] Admin: dashboard shows completion %, failed ≠ passed, outstanding =
      **Pending** today / **Missed** for a past empty date, filters, trend,
      updates log, photo modal works, staff without `Role` cannot open it
- [ ] Export `.xlsx` opens in Excel/Google Sheets; a remark starting with
      `=` exports inert (apostrophe-prefixed)
- [ ] Admin UI: add → edit → deactivate → restore a test task; PIN reset for
      a test user; `deleteTask` on a used task is refused with the
      history message
- [ ] Sheet: PIN column shows `sha256:…` after first login; `Users` has no
      plain PINs left; `Submissions` timestamps are IST
- [ ] Users → `getUsers` response contains `pinSet` booleans only
- [ ] Drive folder: new photo files exist and are **not** link-shared

## Step 8 — Ongoing operations

- **Add staff:** Admin UI (or the sheet: `Name, PIN, Role, Active`).
- **Edit tasks:** Admin UI — no code changes, no redeploy.
- **Rotate the endpoint:** only if you create a new web-app deployment →
  update the `MPS_API_ENDPOINT` variable → next push rebuilds Pages.
- **Backup:** the sheet *is* the data — File → keep version history, or
  schedule a copy (outside this project's scope).
- **Lockout recovery:** edit `Users` directly in the sheet (owner account) —
  set a fresh PIN / `Active = Yes`.

## Consolidated list of commands/actions requiring your authorization

1. `git init` + `git push` to a **new** GitHub repo (Step 1)
2. Enable GitHub Pages + create repo variable (Step 2)
3. Create Google Sheet from the template + add users (Step 3)
4. Create private Drive folder (Step 4)
5. Create/configure Apps Script project, grant scopes, deploy `/exec` (Step 5)
6. Set `MPS_API_ENDPOINT` and push to trigger the first Pages deploy (Step 6)

None of these have been executed.
