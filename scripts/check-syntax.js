// ════════════════════════════════════════════════════════════════
//  MPS Silks — zero-dependency syntax lint
//  Parses every JS file (and the Apps Script .gs files) without
//  executing it. Fails the build on any syntax error.
// ════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const targets = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry)) continue;
      walk(full);
    } else if (/\.(js|gs)$/.test(entry)) {
      targets.push(full);
    }
  }
}
walk(ROOT);

let failed = 0;
for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    // Compile only — never executes the code.
    new vm.Script(src, { filename: path.relative(ROOT, file) });
    console.log('ok   ', path.relative(ROOT, file));
  } catch (err) {
    failed++;
    console.error('FAIL ', path.relative(ROOT, file), '→', err.message);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check.`);
  process.exit(1);
}
console.log(`\nAll ${targets.length} files passed syntax check.`);
