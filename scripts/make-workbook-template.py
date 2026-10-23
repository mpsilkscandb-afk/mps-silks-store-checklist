#!/usr/bin/env python3
"""Generate sheets/mps-silks-workbook-template.xlsx.

Source of truth for task content is the existing MPS workbook
(``checklist.xlsx`` in the project's parent folder — NOT committed here).
This script produces a clean, shareable *template* for a new Google Sheet:

  * Checklist_Config  — copied verbatim (tasks, sections, flags)
  * Users             — HEADERS ONLY (Name, PIN, Role, Active)
                        never copies real staff names or PINs
  * Submissions       — headers + Submission_ID (idempotency/dedup key)
  * Settings          — copied verbatim (store name, timings)

Run:  python scripts/make-workbook-template.py [path/to/checklist.xlsx]
"""
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT.parent / "checklist.xlsx"
OUT = ROOT / "sheets" / "mps-silks-workbook-template.xlsx"

USER_HEADERS = ["Name", "PIN", "Role", "Active"]
SUBMISSION_HEADERS = [
    "Timestamp", "Date", "Staff_Name", "Role", "Section", "Task_ID",
    "Task_Name", "Type", "Response", "Photo_URL", "Status", "Remarks",
    "Sequence", "Override_Reason", "Submission_ID", "Photo_Time",
]


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.exists():
        print(f"source workbook not found: {src}", file=sys.stderr)
        return 1

    wb = openpyxl.load_workbook(src)
    out = openpyxl.Workbook()
    out.remove(out.active)

    # 1) Checklist_Config — verbatim
    cfg = wb["Checklist_Config"]
    ws = out.create_sheet("Checklist_Config")
    for row in cfg.iter_rows(values_only=True):
        ws.append(list(row))

    # 2) Users — headers only, Role column added, no real PINs
    ws = out.create_sheet("Users")
    ws.append(USER_HEADERS)

    # 3) Submissions — headers only, + Submission_ID
    ws = out.create_sheet("Submissions")
    ws.append(SUBMISSION_HEADERS)

    # 4) Settings — verbatim
    st = wb["Settings"]
    ws = out.create_sheet("Settings")
    for row in st.iter_rows(values_only=True):
        ws.append(list(row))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT)

    # safety: refuse to ship a workbook whose PIN/password columns hold a
    # PIN-shaped value (a purely numeric string of 4-8 digits). Shape-based
    # on purpose: no real PIN value is stored anywhere in this repository.
    check = openpyxl.load_workbook(OUT)
    users = check["Users"]
    assert users.max_row == 1, "Users sheet must be headers-only"

    def _pin_shaped(v):
        if v is None:
            return False
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        s = str(v).strip()
        return s.isdigit() and 4 <= len(s) <= 8

    PIN_COL_HINTS = ("pin", "password", "passcode")
    for sheet in check.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        if not rows:
            continue
        header = [str(h).strip().lower() if h is not None else "" for h in rows[0]]
        pin_cols = [i for i, h in enumerate(header)
                    if any(k in h for k in PIN_COL_HINTS)]
        for r_no, row in enumerate(rows[1:], start=2):
            for i in pin_cols:
                if i < len(row) and _pin_shaped(row[i]):
                    raise SystemExit(
                        "refusing to write: PIN-shaped value in %s row %d"
                        % (sheet.title, r_no)
                    )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
