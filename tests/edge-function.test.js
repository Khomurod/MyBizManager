'use strict';

/**
 * The Edge function as it is deployed: supabase/functions/api/index.ts running
 * in Deno, answering HTTP, talking HTTP to a database and to "Apps Script".
 *
 * The database is the in-memory one (tests/supabase-mock.js) behind a local
 * HTTP server that speaks PostgREST's wire format; "Apps Script" is the same
 * backend in the test sandbox behind another. So a request the function
 * forwards and one it answers itself meet the same data, and the test can
 * check that they behave the same.
 *
 * Needs a Deno binary: DENO_BIN, `deno` on the PATH, or the `deno` npm package
 * (CI installs it). Skipped, saying why, when there is none.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { loadScript, readJsonOutput } = require('./gas-harness');
const { buildRuntimeSource } = require('../scripts/edge-runtime');

const ROOT = path.join(__dirname, '..');
const FUNCTION_DIR = path.join(ROOT, 'supabase', 'functions', 'api');
const ADMIN_KEY = 'edge-admin-key';
const CRON_SECRET = 'edge-cron-secret-0123456789';

function findDeno() {
  const candidates = [process.env.DENO_BIN, path.join(ROOT, 'node_modules', '.bin', 'deno'), 'deno'].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const DENO = findDeno();
const skip = DENO ? false : 'no Deno binary (set DENO_BIN or npm install deno)';

/** Reads a request body as text. */
function bodyOf(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** The in-memory database over HTTP, as PostgREST. */
function databaseServer(db) {
  return http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    const headers = { apikey: req.headers.apikey, Prefer: req.headers.prefer, 'Content-Type': req.headers['content-type'] };
    const answer = db.handle(db.url + req.url, { method: req.method.toLowerCase(), headers, payload: body || undefined });
    const out = { 'Content-Type': 'application/json' };
    Object.entries(answer.getHeaders() || {}).forEach(([name, value]) => { out[name] = value; });
    res.writeHead(answer.getResponseCode(), out);
    res.end(answer.getContentText());
  });
}

/** The sandbox's doPost over HTTP, as the Apps Script web app. */
function appsScriptServer(gas, seen) {
  return http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    const url = new URL(req.url, 'http://local');
    const parameter = Object.fromEntries(url.searchParams.entries());
    seen.push({ body, parameter });
    const output = req.method === 'POST'
      ? gas.doPost({ postData: { contents: body }, parameter })
      : gas.doGet({ parameter });
    const text = output.__text !== undefined ? output.__text : output.__html;
    res.writeHead(200, { 'Content-Type': output.__text !== undefined ? 'application/json' : 'text/html' });
    res.end(String(text));
  });
}

async function startFunction(env) {
  fs.writeFileSync(path.join(FUNCTION_DIR, 'runtime.js'),
    buildRuntimeSource(fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8')));
  const entry = 'file://' + path.join(FUNCTION_DIR, 'index.ts');
  // Deno.serve takes no port on the platform; here it is pointed at a free one.
  const boot = `const serve = Deno.serve; Deno.serve = (handler) => serve({ port: Number(Deno.env.get('MBM_TEST_PORT')), hostname: '127.0.0.1', onListen: () => console.log('listening') }, handler); await import(${JSON.stringify(entry)});`;
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(DENO, ['eval', '--ext=ts', boot], {
    cwd: FUNCTION_DIR,
    env: Object.assign({}, process.env, env, { MBM_TEST_PORT: String(port), DENO_NO_PACKAGE_JSON: '1', NO_COLOR: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the function did not start:\n' + logs.join(''))), 30000);
      const onData = chunk => {
        logs.push(String(chunk));
        if (/listening/.test(String(chunk))) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', chunk => logs.push(String(chunk)));
      child.on('exit', code => { clearTimeout(timer); reject(new Error('deno exited ' + code + ':\n' + logs.join(''))); });
    });
  } catch (error) {
    // A boot that timed out leaves Deno running: stop it, keep the reason.
    child.kill();
    throw error;
  }
  return { url: `http://127.0.0.1:${port}/`, child, logs };
}

test('the deployed function: forwards until allowed, then answers itself, the same way', { skip, timeout: 120000 }, async t => {
  const gas = loadScript({
    storage: 'supabase',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_WEBHOOK_SECRET: 'wh-secret-value' },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 100, currency: 'USD', active: true }])],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ]
    }
  });
  const db = gas.__supabase;
  const forwarded = [];
  const dbServer = databaseServer(db);
  const gasServer = appsScriptServer(gas, forwarded);
  const dbPort = await listen(dbServer);
  const gasPort = await listen(gasServer);
  // Not ready yet: the settings are "still in Apps Script".
  const marker = db.properties().__PROPERTIES_READY;
  db.setProperty('__PROPERTIES_READY', undefined);
  db.setProperty('EDGE_CRON_SECRET', CRON_SECRET);

  // Registered before the start, so a function that never comes up still
  // leaves no server open behind it.
  let fn = null;
  t.after(() => { if (fn) fn.child.kill(); dbServer.close(); gasServer.close(); });
  fn = await startFunction({
    SUPABASE_URL: `http://127.0.0.1:${dbPort}`,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: db.key }),
    APPS_SCRIPT_URL: `http://127.0.0.1:${gasPort}/exec`,
    MBM_CONFIG_TTL_MS: '0'
  });

  const post = async (body, query = '', headers = {}) => {
    const res = await fetch(fn.url + query, { method: 'POST', body: JSON.stringify(body), headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (error) { json = null; }
    return { status: res.status, runtime: res.headers.get('x-mbm-runtime'), cors: res.headers.get('access-control-allow-origin'), text, json };
  };
  const dashboard = { action: 'get_omad_data', scope: 'dashboard', adminKey: ADMIN_KEY };

  await t.test('before the settings are moved, everything goes to Apps Script', async () => {
    const answer = await post(dashboard, '?forceFunctionRegion=us-east-1');
    assert.strictEqual(answer.runtime, 'apps-script');
    assert.strictEqual(answer.json.status, 'success', answer.text);
    assert.strictEqual(answer.cors, '*');
    assert.strictEqual(forwarded.length, 1);
    assert.deepStrictEqual(forwarded[0].parameter, {}, 'the region pin is not passed on');
  });

  db.setProperty('__PROPERTIES_READY', marker);
  db.setProperty('EDGE_NATIVE_ACTIONS', 'get_omad_data');

  await t.test('an allowed action is answered here, with what Apps Script would have said', async () => {
    const here = await post(dashboard);
    assert.strictEqual(here.runtime, 'edge');
    assert.strictEqual(here.json.status, 'success', here.text);
    const there = readJsonOutput(gas.doPost({ postData: { contents: JSON.stringify(dashboard) }, parameter: {} }));
    assert.deepStrictEqual(here.json.summary, there.summary);
    assert.deepStrictEqual(here.json.tenants, there.tenants);
  });

  await t.test('an action not allowed yet is still forwarded', async () => {
    const before = forwarded.length;
    const answer = await post({ action: 'get_cafe_data', adminKey: ADMIN_KEY });
    assert.strictEqual(answer.runtime, 'apps-script');
    assert.strictEqual(forwarded.length, before + 1);
  });

  db.setProperty('EDGE_NATIVE_ACTIONS', '*');

  await t.test('a write lands once, under the lease, and the lease is free afterwards', async () => {
    const write = {
      action: 'create_transaction', adminKey: ADMIN_KEY, requestId: 'edge-1', period: '2026-08', tenant: 'Apteka',
      type: 'Income', amount: 100, currency: 'USD', method: 'Naqd', comment: '', deferReports: true
    };
    const [a, b] = await Promise.all([post(write), post(Object.assign({}, write, { requestId: 'edge-2' }))]);
    assert.strictEqual(a.json.status, 'success', a.text);
    assert.strictEqual(b.json.status, 'success', b.text);
    assert.strictEqual(a.runtime, 'edge');
    assert.strictEqual(db.count('omad_transactions_v2'), 2);
    const again = await post(write);
    assert.strictEqual(again.json.duplicate, true, 'a retry of the same request writes nothing');
    assert.strictEqual(db.count('omad_transactions_v2'), 2);
    assert.deepStrictEqual(db.rows.app_lease, []);
  });

  await t.test('what only Apps Script can do is forwarded even with everything allowed', async () => {
    const answer = await post({ action: 'get_storage_status', adminKey: ADMIN_KEY });
    assert.strictEqual(answer.runtime, 'apps-script');
    assert.strictEqual(answer.json.status, 'success', answer.text);
  });

  await t.test('a refusal is the backend\'s own answer, not an HTTP error', async () => {
    const answer = await post({ action: 'get_omad_data', adminKey: 'wrong' });
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.runtime, 'edge');
    assert.strictEqual(answer.json.status, 'error');
  });

  await t.test('"*" is the web actions: the bot and the timed jobs stay with Apps Script until named', async () => {
    const before = forwarded.length;
    const update = await post({ update_id: 8, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/yangi' } }, '?wh=nope');
    assert.strictEqual(update.runtime, 'apps-script');
    assert.strictEqual(forwarded.length, before + 1);
    const job = await post({}, '?job=telegram-jobs', { 'x-mbm-cron': CRON_SECRET });
    assert.strictEqual(job.status, 200, job.text);
    assert.strictEqual(job.json.status, 'skipped', job.text);
  });

  db.setProperty('EDGE_NATIVE_ACTIONS', '*,telegram,jobs');

  await t.test('a webhook without the secret is acknowledged and ignored', async () => {
    const answer = await post({ update_id: 9, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/yangi' } }, '?wh=nope');
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.text, 'OK');
    assert.strictEqual(answer.runtime, 'edge');
  });

  await t.test('the five-minute job needs the cron secret', async () => {
    const refused = await post({}, '?job=telegram-jobs');
    assert.strictEqual(refused.status, 403);
    const ran = await post({}, '?job=telegram-jobs', { 'x-mbm-cron': CRON_SECRET });
    assert.strictEqual(ran.status, 200, ran.text);
    assert.strictEqual(ran.json.status, 'success', ran.text);
  });

  await t.test('the nightly copy is passed on to Apps Script with the cron secret, which it checks', async () => {
    const refused = await post({}, '?job=db-backup');
    assert.strictEqual(refused.status, 403);
    const before = forwarded.length;
    const ran = await post({}, '?job=db-backup', { 'x-mbm-cron': CRON_SECRET });
    assert.strictEqual(ran.runtime, 'apps-script');
    assert.strictEqual(ran.json.status, 'success', ran.text);
    assert.strictEqual(JSON.parse(forwarded[before].body).action, 'run_database_backup');
    assert.ok(Object.keys(gas.__drive).length >= 1, 'and the copy is in Drive');
  });

  await t.test('GET is the inert banner, OPTIONS answers CORS, the probe says what this deployment sees', async () => {
    const banner = await fetch(fn.url);
    assert.strictEqual(await banner.text(), 'System Database is Active.');
    const options = await fetch(fn.url, { method: 'OPTIONS' });
    assert.strictEqual(options.status, 204);
    assert.strictEqual(options.headers.get('access-control-allow-origin'), '*');
    const probe = await (await fetch(fn.url + '?probe=1')).json();
    assert.strictEqual(probe.ready, true);
    assert.strictEqual(probe.allow, '*,telegram,jobs');
    assert.strictEqual(probe.configRead, true);
  });
});
