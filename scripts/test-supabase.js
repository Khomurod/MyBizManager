#!/usr/bin/env node
'use strict';

/**
 * Runs a test suite against the Supabase store instead of the spreadsheet.
 *
 *   node scripts/test-supabase.js            unit/integration (tests/*.test.js)
 *   node scripts/test-supabase.js --e2e      browser flows (tests/*.e2e.js)
 *
 * Every test's sheets are copied into an in-memory Supabase (tests/supabase-mock.js,
 * built from supabase/migrations) by the application's own import code, and the
 * backend then runs with OMAD_STORAGE=supabase. A test that is about the
 * spreadsheet itself is skipped with its reason (`sheetsOnly` in tests/gas-harness.js).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suffix = process.argv.includes('--e2e') ? '.e2e.js' : '.test.js';
const testsDir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(testsDir).filter(f => f.endsWith(suffix)).sort().map(f => path.join('tests', f));

const result = spawnSync(process.execPath, ['--test'].concat(files), {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: Object.assign({}, process.env, { MBM_STORAGE: 'supabase' })
});
process.exit(result.status === null ? 1 : result.status);
