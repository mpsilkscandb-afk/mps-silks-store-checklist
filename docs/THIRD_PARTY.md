# Third-party components

Everything in this repository is written for MPS Silks except the single
vendored file below. There are **no CDN links** — third-party code is copied
into `js/vendor/` and served from this site like any other asset, so the app
keeps working offline/behind filtered networks and nothing phones home.

| File | Project | Version | Licence | Used for |
|---|---|---|---|---|
| `js/vendor/jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) by James Hall et al. | 4.2.1 | MIT | Client-side PDF report (`js/report.js`) |

- The MIT licence text ships inside the file (the `@license` header at the top
  of `js/vendor/jspdf.umd.min.js`), which satisfies the MIT attribution
  requirement. Full text: <https://github.com/parallax/jsPDF/blob/master/LICENSE>.
- jsPDF is listed in `package.json` as a **devDependency** only, so the file can
  be refreshed with:

  ```powershell
  npm.cmd install
  Copy-Item node_modules\jspdf\dist\jspdf.umd.min.js js\vendor\jspdf.umd.min.js -Force
  npm.cmd test
  ```

  The site itself never loads anything from `node_modules` or a CDN — only the
  vendored copy, which `scripts/build.js` copies into `dist/` along with the
  rest of `js/`.

To add another vendored library later: copy it into `js/vendor/`, add a row to
this table, and load it with a plain `<script src="js/vendor/…">` tag.
