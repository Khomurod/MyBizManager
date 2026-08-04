#!/usr/bin/env node
'use strict';

/**
 * Bundles apps-script/*.gs into the single deployable script.gs.
 *
 *   node scripts/build-apps-script.js         write script.gs
 *   node scripts/build-apps-script.js --check  fail if script.gs is stale
 *
 * Apps Script files share one global scope, so concatenating them in filename
 * order is exactly equivalent to having them as separate files in the editor.
 * The bundle exists so deploying stays a single copy-paste; the modules under
 * apps-script/ are the source of truth and the only place to edit.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'apps-script');
const OUT_FILE = path.join(ROOT, 'script.gs');

const BANNER = [
  '// =============================================================================',
  '// GENERATED FILE - DO NOT EDIT.',
  '//',
  '// Built from apps-script/*.gs by scripts/build-apps-script.js.',
  '// Edit the modules under apps-script/ and run `npm run build`.',
  '//',
  '// Apps Script files share a single global scope, so this bundle behaves',
  '// identically to keeping the modules as separate files in the editor.',
  '// =============================================================================',
  ''
].join('\n');

function moduleFiles() {
  return fs.readdirSync(SRC_DIR)
    .filter(name => name.endsWith('.gs'))
    .sort();
}

function build() {
  const parts = [BANNER];
  for (const name of moduleFiles()) {
    const body = fs.readFileSync(path.join(SRC_DIR, name), 'utf8').replace(/\s+$/, '');
    parts.push(`// ----- apps-script/${name} ` + '-'.repeat(Math.max(0, 60 - name.length)));
    parts.push('');
    parts.push(body);
    parts.push('');
  }
  return parts.join('\n') + '\n';
}

const bundle = build();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== bundle) {
    console.error('script.gs is out of date. Run `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log('script.gs is up to date.');
} else {
  fs.writeFileSync(OUT_FILE, bundle);
  console.log(`script.gs rebuilt from ${moduleFiles().length} modules.`);
}
