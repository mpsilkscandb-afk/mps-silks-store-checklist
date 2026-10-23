// ════════════════════════════════════════════════════════════════
//  MPS Silks — build script (zero dependencies)
//  Copies the static site into dist/ and, when MPS_API_ENDPOINT is
//  provided at build time, injects it into js/config.js.
//
//    npm run build
//    MPS_API_ENDPOINT=https://script.google.com/macros/s/… npm run build
// ════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const COPY = [
  'index.html',
  'checklist.html',
  'dashboard.html',
  'admin.html',
  'css',
  'js',
  'images',
  '.nojekyll'
];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

for (const item of COPY) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.warn('skip (missing):', item);
    continue;
  }
  copyRecursive(src, path.join(DIST, item));
}

// Inject the public API endpoint if provided (never a secret).
const endpoint = (process.env.MPS_API_ENDPOINT || '').trim();
const configPath = path.join(DIST, 'js', 'config.js');
let config = fs.readFileSync(configPath, 'utf8');
if (endpoint) {
  if (!/^https:\/\/script\.google\.com\/macros\//.test(endpoint) && !/^https:\/\//.test(endpoint)) {
    console.error('MPS_API_ENDPOINT must be an https:// URL.');
    process.exit(1);
  }
  config = config.replace('__MPS_API_ENDPOINT__', endpoint.replace(/\/+$/, ''));
  fs.writeFileSync(configPath, config);
  console.log('Injected API endpoint into dist/js/config.js');
} else {
  console.log('MPS_API_ENDPOINT not set — dist keeps the placeholder. Set it before going live (see docs/DEPLOYMENT.md).');
}

console.log('Build complete →', DIST);
