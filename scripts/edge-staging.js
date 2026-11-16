#!/usr/bin/env node
'use strict';

/**
 * The test project (mybizmanager-staging), brought up to date and exercised
 * end to end once the function has been deployed to it (.github/workflows/
 * ci.yml -> edge-staging):
 *
 *   1. migrations  every file in supabase/migrations not yet recorded in
 *                  supabase_migrations.schema_migrations (matched by name) is
 *                  applied, in order, with its record, in one transaction;
 *   2. data        if the project is empty, the synthetic data set of
 *                  scripts/staging-seed.js -- invented tenants and amounts;
 *   3. settings    the function answers everything itself (there is no Apps
 *                  Script behind it here), a fresh admin key for this run,
 *                  the cron and webhook secrets made once;
 *   4. checks      reads, a write and its retry, sign-in, the lease freed,
 *                  a Telegram update, the timed jobs, the refusals; with how
 *                  long each took, in the log and on the run's summary page.
 *
 *   SUPABASE_ACCESS_TOKEN  the GitHub secret of that name (the Management API)
 *
 * It only ever touches the test project: the ref is fixed here, and a
 * different SUPABASE_PROJECT_REF is refused. The live project's migrations
 * and switches are applied by hand (docs/DEPLOYMENT.md). Secrets made here are
 * masked in the log and never printed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGING_REF = 'uzpfgnjxvmrzwvocuiaf';
const FUNCTION_URL = 'https://' + STAGING_REF + '.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1';
const NATIVE = '*,telegram,jobs';

const failures = [];
const timings = [];

function fail(message) {
  console.error('edge staging: ' + message);
  process.exit(1);
}

function check(ok, what) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what);
  if (!ok) failures.push(what);
}

function mask(value) {
  if (process.env.GITHUB_ACTIONS) console.log('::add-mask::' + value);
  return value;
}

const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
const ref = String(process.env.SUPABASE_PROJECT_REF || STAGING_REF).trim();
if (ref !== STAGING_REF) fail('refusing to touch ' + ref + ': this script is for the test project only.');
if (!token) fail('the SUPABASE_ACCESS_TOKEN secret is not set for this workflow.');

/** One SQL text through the Management API; the rows of its last statement. */
async function sql(query) {
  const res = await fetch('https://api.supabase.com/v1/projects/' + ref + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(90000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('SQL refused (HTTP ' + res.status + '): ' + text.slice(0, 600));
  try { return JSON.parse(text || '[]'); } catch (error) { return []; }
}

const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
const quoted = name => '"' + String(name).replace(/"/g, '""') + '"';

// ------------------------------------------------------------- 1. migrations

async function migrate() {
  await sql('create schema if not exists supabase_migrations; ' +
    'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);');
  const applied = new Set((await sql('select name from supabase_migrations.schema_migrations')).map(row => row.name));
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const [, version, name] = file.match(/^(\d{14})_(.+)\.sql$/);
    if (applied.has(name)) continue;
    console.log('edge staging: applying ' + file);
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    await sql('begin;\n' + body + '\n;\ninsert into supabase_migrations.schema_migrations (version, name) values (' +
      literal(version) + ', ' + literal(name) + ');\ncommit;');
  }
  const now = (await sql('select name from supabase_migrations.schema_migrations order by version')).map(row => row.name);
  console.log('edge staging: migrations recorded: ' + now.join(', '));
  for (const file of files) check(now.includes(file.replace(/^\d{14}_|\.sql$/g, '')), 'migration ' + file);
}

// ------------------------------------------------------------------ 2. data

async function seed() {
  const [{ n }] = await sql('select count(*)::int as n from public.system_config');
  if (n > 0) {
    console.log('edge staging: data present (' + n + ' settings rows), not seeded again');
    return;
  }
  const { stagingTables } = require('./staging-seed');
  const tables = stagingTables();
  const statements = ['begin;'];
  Object.keys(tables).forEach(table => {
    const rows = tables[table];
    if (!rows.length) return;
    const cols = Object.keys(rows[0]).map(quoted).join(', ');
    statements.push('insert into public.' + quoted(table) + ' (' + cols + ') select ' + cols +
      ' from jsonb_populate_recordset(null::public.' + quoted(table) + ', $seed$' + JSON.stringify(rows) +
      '$seed$::jsonb) with ordinality as r order by r.ordinality;');
  });
  statements.push('commit;');
  await sql(statements.join('\n'));
  console.log('edge staging: seeded ' + Object.keys(tables).map(t => t + '=' + tables[t].length).join(' '));
}

// -------------------------------------------------------------- 3. settings

async function configure() {
  const adminKey = mask(crypto.randomBytes(24).toString('hex'));
  const made = () => "replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')";
  await sql([
    'begin;',
    "delete from public.app_properties where key = 'EDGE_APPS_SCRIPT_URL';",
    'insert into public.app_properties (key, value) values',
    "  ('__PROPERTIES_READY', now()::text),",
    "  ('EDGE_CRON_SECRET', " + made() + '),',
    "  ('OMAD_SESSION_SECRET', " + made() + '),',
    "  ('TELEGRAM_WEBHOOK_SECRET', " + made() + ')',
    'on conflict (key) do nothing;',
    'insert into public.app_properties (key, value) values',
    "  ('EDGE_NATIVE_ACTIONS', " + literal(NATIVE) + '),',
    "  ('EDGE_FUNCTION_URL', " + literal(FUNCTION_URL) + '),',
    "  ('OMAD_ADMIN_KEY', " + literal(adminKey) + ')',
    'on conflict (key) do update set value = excluded.value, updated_at = now();',
    'commit;'
  ].join('\n'));
  const rows = await sql("select key, value from public.app_properties where key in ('EDGE_CRON_SECRET', 'TELEGRAM_WEBHOOK_SECRET')");
  const secrets = {};
  rows.forEach(row => { secrets[row.key] = mask(row.value); });
  return { adminKey, cronSecret: secrets.EDGE_CRON_SECRET, webhookSecret: secrets.TELEGRAM_WEBHOOK_SECRET };
}

// ---------------------------------------------------------------- 4. checks

async function call(label, { body, query = '', headers = {}, method = 'POST' } = {}) {
  const started = Date.now();
  const res = await fetch(FUNCTION_URL + query, {
    method,
    headers: Object.assign({ 'Content-Type': 'text/plain;charset=utf-8' }, headers),
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body || {})),
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  const ms = Date.now() - started;
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  const runtime = res.headers.get('x-mbm-runtime') || '';
  if (label) timings.push({ label, ms, runtime, status: res.status });
  return { status: res.status, runtime, json, text, ms };
}

async function waitForSwitches() {
  for (let i = 0; i < 12; i++) {
    const probe = await call('', { method: 'GET', query: '&probe=1' });
    if (probe.json && probe.json.ready && probe.json.allow === NATIVE && probe.json.configRead) return probe.json;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return null;
}

const median = list => {
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

async function exercise({ adminKey, cronSecret, webhookSecret }) {
  const probe = await waitForSwitches();
  check(!!probe, 'the function sees the switches (ready, ' + NATIVE + ')');
  if (probe) console.log('edge staging: probe ' + JSON.stringify({ region: probe.region, allow: probe.allow, forwardsTo: probe.forwardsTo }));

  // An account, made with the admin key, and everything after as that
  // account -- the way the app works. The admin key itself is throttled to
  // ten calls a minute (02a_auth.gs), so it is used only where it must be.
  const password = mask(crypto.randomBytes(12).toString('hex'));
  const account = await call('set_user_password (admin key)', {
    body: { action: 'set_user_password', adminKey, username: 'staging_check', password, role: 'omad_admin' }
  });
  check(account.runtime === 'edge' && account.json && account.json.status === 'success',
    'an account is set with the admin key' + (account.json && account.json.message ? ' (' + account.json.message + ')' : ''));
  const login = await call('login', { body: { action: 'login', username: 'staging_check', password } });
  const session = login.json && login.json.status === 'success' ? login.json.token : '';
  check(login.runtime === 'edge' && !!session, 'login gives a session on the Edge function');
  if (!session) return;
  mask(session);
  const wrong = await call('', { body: { action: 'login', username: 'staging_check', password: 'not-the-password' } });
  check(wrong.json && wrong.json.status === 'error', 'a wrong password is refused');
  const anonymous = await call('', { body: { action: 'get_omad_data', scope: 'dashboard' } });
  check(anonymous.json && anonymous.json.status === 'error', 'no credentials, no data');

  // Reads: the dashboard as the app loads it, then the whole ledger and the rest.
  const reads = [];
  for (let i = 0; i < 6; i++) {
    const read = await call(i === 0 ? 'dashboard (first call)' : '',
      { body: { action: 'get_omad_data', scope: 'dashboard', sessionToken: session } });
    if (i > 0) reads.push(read.ms);
    if (i === 0) {
      check(read.runtime === 'edge', 'the dashboard read is answered by the Edge function');
      check(read.json && read.json.status === 'success', 'the dashboard read succeeds' +
        (read.json && read.json.message ? ' (' + read.json.message + ')' : ''));
    }
  }
  timings.push({ label: 'dashboard (median of the next 5)', ms: median(reads), runtime: 'edge', status: 200 });
  const full = await call('get_omad_data (whole ledger)', { body: { action: 'get_omad_data', sessionToken: session } });
  check(full.json && full.json.status === 'success' && Array.isArray(full.json.transactions),
    'the whole ledger reads (' + (full.json && full.json.transactions ? full.json.transactions.length : '?') + ' rows)');
  for (const action of ['get_tasks', 'get_cafe_data', 'list_transactions']) {
    const read = await call(action, { body: { action, sessionToken: session } });
    check(read.runtime === 'edge' && read.json && read.json.status !== 'error', action + ' answers from the Edge function' +
      (read.json && read.json.message ? ' (' + read.json.message + ')' : ''));
  }
  const byKey = await call('dashboard (admin key)', { body: { action: 'get_omad_data', scope: 'dashboard', adminKey } });
  check(byKey.json && byKey.json.status === 'success', 'the admin key reads too');

  // A write, then the same write again.
  const requestId = 'staging_' + Date.now();
  const entry = {
    action: 'create_transaction', sessionToken: session, requestId, period: new Date().toISOString().slice(0, 7),
    tenant: "Do'kon A", type: 'Income', amount: 1, currency: 'USD', method: 'Naqd', comment: 'staging check',
    deferReports: true
  };
  const write = await call('create_transaction', { body: entry });
  check(write.runtime === 'edge' && write.json && write.json.status === 'success',
    'create_transaction succeeds on the Edge function' + (write.json && write.json.message ? ' (' + write.json.message + ')' : ''));
  const again = await call('create_transaction (same requestId)', { body: entry });
  check(again.json && again.json.status === 'success', 'the same requestId again is accepted' +
    (again.json && again.json.message ? ' (' + again.json.message + ')' : ''));
  const [{ n: copies }] = await sql('select count(*)::int as n from public.omad_transactions_v2 where request_id = ' + literal(requestId));
  check(copies === 1, 'and stored once (' + copies + ')');
  const [{ n: leases }] = await sql('select count(*)::int as n from public.app_lease');
  check(leases === 0, 'no lease is left held (' + leases + ')');
  const after = await call('dashboard (after the write)', { body: { action: 'get_omad_data', scope: 'dashboard', sessionToken: session } });
  check(after.json && after.json.status === 'success', 'the dashboard reads after the write');

  // Telegram.
  const update = await call('Telegram update', {
    query: '&wh=' + encodeURIComponent(webhookSecret),
    body: { update_id: Date.now() % 1e9, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Test' }, text: '/start' } }
  });
  check(update.status === 200, 'a Telegram update is answered 200 (' + update.status + ')');

  // The timed jobs.
  const job = await call('?job=telegram-jobs', { query: '&job=telegram-jobs', headers: { 'x-mbm-cron': cronSecret } });
  check(job.status === 200 && job.json && job.json.status === 'success', 'the timed jobs run on the Edge function' +
    (job.json && job.json.message ? ' (' + job.json.message + ')' : ''));
  const forbidden = await call('', { query: '&job=telegram-jobs', headers: { 'x-mbm-cron': 'wrong-secret-0123456789' } });
  check(forbidden.status === 403, 'a wrong cron secret is refused');

  // What only Apps Script can do: forwarded, and there is no Apps Script here.
  const health = await call('', { body: { action: 'get_health', sessionToken: session } });
  check(health.runtime === 'unconfigured' && health.status === 503, 'get_health is forwarded (no Apps Script here: 503 unconfigured)');

  const cron = await sql("select jobname, schedule, active from cron.job where jobname like 'mbm-%' order by jobname");
  check(cron.length === 2 && cron.every(row => row.active), 'pg_cron holds both jobs (' + cron.map(row => row.jobname).join(', ') + ')');
  const runs = await sql("select d.status, count(*)::int as n from cron.job_run_details d join cron.job j using (jobid) " +
    "where j.jobname = 'mbm-telegram-jobs' group by d.status");
  console.log('edge staging: mbm-telegram-jobs runs so far: ' + (runs.map(r => r.status + '=' + r.n).join(', ') || 'none yet'));
}

function report() {
  const lines = ['| Call | ms | Answered by | HTTP |', '|---|---:|---|---:|']
    .concat(timings.map(t => '| ' + t.label + ' | ' + t.ms + ' | ' + t.runtime + ' | ' + t.status + ' |'));
  console.log('\n' + lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Test project: the Edge function, end to end\n\n' +
      'Called from the GitHub runner (US). ' + (failures.length ? '**' + failures.length + ' check(s) failed.**' : 'Every check passed.') +
      '\n\n' + lines.join('\n') + '\n');
  }
}

(async () => {
  await migrate();
  await seed();
  const secrets = await configure();
  await exercise(secrets);
  report();
  if (failures.length) fail(failures.length + ' check(s) failed: ' + failures.join('; '));
  console.log('edge staging: every check passed.');
})().catch(error => fail(String(error && error.stack || error)));
