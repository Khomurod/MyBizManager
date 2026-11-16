#!/usr/bin/env node
'use strict';

/**
 * Applies the migrations a Supabase project has not recorded yet, through the
 * Management API, and (with --edge-rows) the Edge function's three fixed rows.
 *
 *   SUPABASE_ACCESS_TOKEN  the GitHub secret of that name
 *   SUPABASE_PROJECT_REF   the project
 *
 *   node scripts/supabase-migrate.js              migrations only
 *   node scripts/supabase-migrate.js --edge-rows  and EDGE_APPS_SCRIPT_URL,
 *                                                 EDGE_FUNCTION_URL, EDGE_CRON_SECRET
 *
 * Used by scripts/edge-staging.js for the test project on every staging run,
 * and by the `migrate-production` job for the live project -- which runs only
 * when somebody starts it by hand on main with that box ticked
 * (docs/DEPLOYMENT.md). A merge never reaches it.
 *
 * Each file in supabase/migrations is matched to the project's record
 * (supabase_migrations.schema_migrations) by its name, the part after the
 * version, and applied with its record in one transaction: a file that fails
 * leaves nothing behind and stops the run. An applied file is never applied
 * again, so running this twice does nothing the second time.
 *
 * The rows: EDGE_APPS_SCRIPT_URL is the Apps Script URL the frontend already
 * calls (GOOGLE_APP_URL in assets/omad/00-config.js); EDGE_FUNCTION_URL the
 * project's own function, pinned to us-east-1; EDGE_CRON_SECRET is made by
 * the database once and never leaves it. None of them makes the function
 * answer anything itself -- that takes the settings move and
 * EDGE_NATIVE_ACTIONS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const literal = value => "'" + String(value).replace(/'/g, "''") + "'";

function client(ref, token) {
  if (!/^[a-z]{20}$/.test(String(ref || ''))) throw new Error('SUPABASE_PROJECT_REF is missing or is not a project ref.');
  if (!String(token || '').trim()) throw new Error('the SUPABASE_ACCESS_TOKEN secret is not set for this workflow.');
  /** One SQL text through the Management API; the rows of its last statement. */
  return async function sql(query) {
    const res = await fetch('https://api.supabase.com/v1/projects/' + ref + '/database/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(90000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error('SQL refused (HTTP ' + res.status + '): ' + text.slice(0, 600));
    try { return JSON.parse(text || '[]'); } catch (error) { return []; }
  };
}

function migrationFiles() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return fs.readdirSync(dir).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort().map(file => {
    const [, version, name] = file.match(/^(\d{14})_(.+)\.sql$/);
    return { file, version, name, body: fs.readFileSync(path.join(dir, file), 'utf8') };
  });
}

/** Applies what is missing; returns { applied: [file], recorded: [name] }. */
async function migrate(sql, log = console.log) {
  await sql('create schema if not exists supabase_migrations; ' +
    'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);');
  const before = new Set((await sql('select name from supabase_migrations.schema_migrations')).map(row => row.name));
  const applied = [];
  for (const migration of migrationFiles()) {
    if (before.has(migration.name)) continue;
    log('applying ' + migration.file);
    await sql('begin;\n' + migration.body + '\n;\ninsert into supabase_migrations.schema_migrations (version, name) values (' +
      literal(migration.version) + ', ' + literal(migration.name) + ');\ncommit;');
    applied.push(migration.file);
  }
  const recorded = (await sql('select name from supabase_migrations.schema_migrations order by version')).map(row => row.name);
  return { applied, recorded, expected: migrationFiles().map(m => m.name) };
}

/** The Apps Script /exec URL the frontend calls. */
function appsScriptUrl() {
  const config = fs.readFileSync(path.join(ROOT, 'assets', 'omad', '00-config.js'), 'utf8');
  const match = config.match(/GOOGLE_APP_URL\s*=\s*"(https:\/\/script\.google\.com\/macros\/s\/[^"]+\/exec)"/);
  if (!match) throw new Error('GOOGLE_APP_URL not found in assets/omad/00-config.js');
  return match[1];
}

/** EDGE_APPS_SCRIPT_URL, EDGE_FUNCTION_URL and (once) EDGE_CRON_SECRET. */
async function writeEdgeRows(sql, ref) {
  const functionUrl = 'https://' + ref + '.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1';
  const made = "replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')";
  await sql([
    'begin;',
    'insert into public.app_properties (key, value) values',
    "  ('EDGE_APPS_SCRIPT_URL', " + literal(appsScriptUrl()) + '),',
    "  ('EDGE_FUNCTION_URL', " + literal(functionUrl) + ')',
    'on conflict (key) do update set value = excluded.value, updated_at = now();',
    "insert into public.app_properties (key, value) values ('EDGE_CRON_SECRET', " + made + ')',
    'on conflict (key) do nothing;',
    'commit;'
  ].join('\n'));
  const rows = await sql("select key, length(value) as length from public.app_properties where key like 'EDGE\\_%' order by key");
  return rows.map(row => row.key + (row.key === 'EDGE_CRON_SECRET' ? ' (' + row.length + ' characters)' : ''));
}

module.exports = { client, migrate, migrationFiles, writeEdgeRows, appsScriptUrl };

if (require.main === module) {
  (async () => {
    const ref = String(process.env.SUPABASE_PROJECT_REF || '').trim();
    const sql = client(ref, process.env.SUPABASE_ACCESS_TOKEN);
    const result = await migrate(sql, line => console.log('supabase migrate: ' + line));
    console.log('supabase migrate: ' + (result.applied.length ? 'applied ' + result.applied.join(', ') : 'nothing to apply'));
    const missing = result.expected.filter(name => !result.recorded.includes(name));
    if (missing.length) throw new Error('not recorded after the run: ' + missing.join(', '));
    console.log('supabase migrate: recorded ' + result.recorded.join(', '));
    if (process.argv.includes('--edge-rows')) {
      console.log('supabase migrate: Edge rows present: ' + (await writeEdgeRows(sql, ref)).join(', '));
    }
  })().catch(error => {
    console.error('supabase migrate: ' + String(error && error.message || error));
    process.exit(1);
  });
}
