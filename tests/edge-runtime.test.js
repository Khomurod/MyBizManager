'use strict';

/**
 * The pieces of the Supabase Edge runtime (supabase/functions/api/lib/*),
 * one at a time. The whole backend running on them is covered by the rest of
 * the suite under `npm run test:edge`, and the deployed shape (index.ts in
 * Deno, over HTTP) by tests/edge-function.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const vm = require('vm');

const executor = require('../supabase/functions/api/lib/executor.js');
const routing = require('../supabase/functions/api/lib/routing.js');
const shims = require('../supabase/functions/api/lib/gas-shims.js');
const sha = require('../supabase/functions/api/lib/sha256.js');
const { createTashkentDate } = require('../supabase/functions/api/lib/zoned-date.js');
const { buildRuntimeSource } = require('../scripts/edge-runtime');
const { createSupabaseMock } = require('./supabase-mock');

// ------------------------------------------------------------------ routing

test('nothing is answered at the edge before the settings are in the database', () => {
  const body = JSON.stringify({ action: 'get_omad_data' });
  assert.strictEqual(routing.routePost(body, { ready: false, allow: '*' }), 'apps-script');
  assert.strictEqual(routing.routePost(body, null), 'apps-script');
});

test('the allow list names what the edge answers; "*" is everything Apps Script need not answer', () => {
  const ready = allow => ({ ready: true, allow });
  const post = action => JSON.stringify({ action });
  assert.strictEqual(routing.routePost(post('get_omad_data'), ready('')), 'apps-script');
  assert.strictEqual(routing.routePost(post('get_omad_data'), ready('get_omad_data, login')), 'edge');
  assert.strictEqual(routing.routePost(post('login'), ready('get_omad_data, login')), 'edge');
  assert.strictEqual(routing.routePost(post('save_task'), ready('get_omad_data')), 'apps-script');
  assert.strictEqual(routing.routePost(post('save_task'), ready('*')), 'edge');
  for (const action of ['get_health', 'rollback_supabase_storage', 'move_properties_to_script', 'apply_omad_migration']) {
    assert.strictEqual(routing.routePost(post(action), ready('*,' + action)), 'apps-script', action + ' needs Apps Script');
  }
});

test('the webhook and the jobs have switches of their own', () => {
  const update = JSON.stringify({ update_id: 1, message: { text: '/yangi' } });
  assert.strictEqual(routing.routePost(update, { ready: true, allow: 'get_omad_data' }), 'apps-script');
  assert.strictEqual(routing.routePost(update, { ready: true, allow: 'telegram' }), 'edge');
  assert.strictEqual(routing.routePost(update, { ready: true, allow: '*' }), 'edge');
  assert.strictEqual(routing.jobsRunHere({ ready: true, allow: 'telegram' }), false);
  assert.strictEqual(routing.jobsRunHere({ ready: true, allow: 'jobs' }), true);
  assert.strictEqual(routing.jobsRunHere({ ready: false, allow: '*' }), false);
});

test('a body that is not JSON, or asks for nothing, goes to Apps Script to be refused there', () => {
  assert.strictEqual(routing.routePost('not json', { ready: true, allow: '*' }), 'apps-script');
  assert.strictEqual(routing.routePost('{}', { ready: true, allow: '*' }), 'apps-script');
  assert.strictEqual(routing.routePost('[1]', { ready: true, allow: '*' }), 'apps-script');
});

// ------------------------------------------------------------------ executor

/** A tiny "backend": synchronous code doing I/O through the shims' io(). */
function counterBackend(log) {
  return {
    makeGlobals: ctx => ({ io: ctx.io, nd: ctx.nd, defer: ctx.defer }),
    invoke: G => {
      const stamp = G.nd('clock', () => Date.now());
      const id = G.nd('uuid', () => crypto.randomUUID());
      const a = G.io('GET a', { name: 'a' });
      G.defer('PUT cache', { name: 'cache' });
      const b = G.io('GET b', { name: 'b', after: a });
      return { a, b, stamp, id };
    },
    perform: request => { log.push(request.name); return request.name.toUpperCase(); },
    performDeferred: requests => requests.forEach(r => log.push('deferred:' + r.name))
  };
}

test('each I/O happens once, in order, and the clock and ids are the same on every run', () => {
  const log = [];
  const out = executor.runSync(counterBackend(log));
  assert.deepStrictEqual(out.result.a, 'A');
  assert.deepStrictEqual(out.result.b, 'B');
  assert.deepStrictEqual(log, ['a', 'deferred:cache', 'b'], 'the cache write went out with the next real I/O, once');
  assert.strictEqual(out.runs, 3);
  assert.strictEqual(out.ios, 2);
});

test('the asynchronous loop gives the same answer', async () => {
  const log = [];
  const backend = counterBackend(log);
  const out = await executor.run(Object.assign({}, backend, {
    perform: request => new Promise(resolve => setTimeout(() => resolve(backend.perform(request)), 1)),
    performDeferred: requests => Promise.resolve(backend.performDeferred(requests))
  }));
  assert.strictEqual(out.result.b, 'B');
  assert.deepStrictEqual(log.sort(), ['a', 'b', 'deferred:cache']);
});

test('a run that asks for something else than the first run did is refused, not guessed', () => {
  let flip = false;
  assert.throws(() => executor.runSync({
    makeGlobals: ctx => ctx,
    invoke: ctx => {
      ctx.io('GET first', {});
      flip = !flip;
      return ctx.io(flip ? 'GET second' : 'GET other', {});
    },
    perform: () => 'x'
  }), /Replay diverged/);
});

test('the backend catching the replay signal changes nothing', () => {
  const out = executor.runSync({
    makeGlobals: ctx => ctx,
    invoke: ctx => {
      let first;
      try { first = ctx.io('GET a', {}); } catch (error) { first = 'swallowed'; }
      return first;
    },
    perform: () => 'answer'
  });
  assert.strictEqual(out.result, 'answer');
});

test('an error the backend throws is its answer, and a runaway request is stopped', () => {
  const out = executor.runSync({ makeGlobals: ctx => ctx, invoke: () => { throw new Error('refused'); }, perform: () => null });
  assert.match(String(out.error), /refused/);
  let n = 0;
  assert.throws(() => executor.runSync({
    makeGlobals: ctx => ctx,
    invoke: ctx => { for (let i = 0; i < 1000; i++) ctx.io('GET ' + i, {}); },
    perform: () => n++,
    maxRuns: 5
  }), /more than 5 runs/);
});

test('a lease taken and not given back is found on the tape', () => {
  const lock = (owner, acquired) => ({
    key: 'POST https://p.supabase.co/rest/v1/rpc/mbm_lock\n' + JSON.stringify({ p_owner: owner, p_ttl_ms: 90000, p_wait_ms: 5000 }),
    response: { code: 200, text: JSON.stringify({ acquired }) }
  });
  const apply = (ops, code = 200) => ({
    key: 'POST https://p.supabase.co/rest/v1/rpc/mbm_apply\n' + JSON.stringify({ ops }),
    response: { code, text: '[]' }
  });
  const unlock = owner => ({
    key: 'POST https://p.supabase.co/rest/v1/rpc/mbm_unlock\n' + JSON.stringify({ p_owner: owner }),
    response: { code: 200, text: '{"released":true}' }
  });
  assert.deepStrictEqual(executor.leasesLeftHeld({ io: [lock('x_a', true), apply([{ op: 'unlock', owner: 'x_a' }])] }), []);
  assert.deepStrictEqual(executor.leasesLeftHeld({ io: [lock('x_a', true), apply([{ op: 'unlock', owner: 'x_a' }], 503)] }), ['x_a']);
  assert.deepStrictEqual(executor.leasesLeftHeld({ io: [lock('x_a', true), unlock('x_a')] }), []);
  assert.deepStrictEqual(executor.leasesLeftHeld({ io: [lock('x_b', false)] }), [], 'never taken');
  assert.deepStrictEqual(executor.leasesLeftHeld({ io: [lock('x_c', true)] }), ['x_c']);
});

// ------------------------------------------------------------------ the clock

test('local time is Tashkent time, whatever zone the machine is in', () => {
  const TashkentDate = createTashkentDate(Date, () => Date.UTC(2026, 10, 16, 20, 30));
  const now = new TashkentDate();
  assert.strictEqual(now.getHours(), 1, '20:30 UTC is 01:30 next day in Tashkent');
  assert.strictEqual(now.getDate(), 17);
  assert.match(now.toString(), /GMT\+0500/);
  const local = new TashkentDate(2026, 0, 1, 9, 0);
  assert.strictEqual(local.toISOString(), '2026-01-01T04:00:00.000Z');
  assert.ok(new Date() instanceof TashkentDate, 'a native date still is a Date to the backend');
  assert.strictEqual(TashkentDate.parse('2026-03-01'), Date.UTC(2026, 2, 1), 'a date-only ISO string is UTC, as everywhere');
  assert.strictEqual(new TashkentDate(Date.UTC(2026, 5, 1)).getTimezoneOffset(), -300);
});

test('formatDate follows Apps Script patterns in the zone it is given', () => {
  const at = new Date(Date.UTC(2026, 10, 16, 20, 5, 9));
  assert.strictEqual(shims.formatDate(at, 'Asia/Tashkent', 'yyyy-MM-dd HH:mm:ss'), '2026-11-17 01:05:09');
  assert.strictEqual(shims.formatDate(at, 'UTC', 'dd/MM/yyyy'), '16/11/2026');
  assert.strictEqual(shims.formatDate(at, 'Asia/Tashkent', "EEE, d MMM yyyy 'at' h a"), 'Tue, 17 Nov 2026 at 1 AM');
  assert.strictEqual(shims.formatDate(at, 'Asia/Tashkent', 'Z XXX'), '+0500 +05:00');
  assert.strictEqual(shims.formatDate(at, 'GMT+3', 'HH:mm'), '23:05');
  assert.throws(() => shims.formatDate(at, 'Asia/Tashkent', 'q'), /Illegal pattern/);
});

// ------------------------------------------------------------------ crypto

test('HMAC-SHA256 and SHA-256 match Node, as signed bytes the way Apps Script returns them', () => {
  const utilities = shims.createUtilities(() => null);
  for (const [value, key] of [['', ''], ['initData', 'WebAppData'], ['x'.repeat(200), 'k'.repeat(100)], ['ünïcödé ✓', 'ключ']]) {
    const expected = Array.from(crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(value, 'utf8')).digest())
      .map(b => (b > 127 ? b - 256 : b));
    assert.deepStrictEqual(utilities.computeHmacSha256Signature(value, key), expected);
  }
  const keyBytes = Array.from(crypto.randomBytes(32)).map(b => (b > 127 ? b - 256 : b));
  const valueBytes = Array.from(crypto.randomBytes(77)).map(b => (b > 127 ? b - 256 : b));
  const unsigned = list => Buffer.from(list.map(b => b & 0xff));
  assert.deepStrictEqual(utilities.computeHmacSha256Signature(valueBytes, keyBytes),
    Array.from(crypto.createHmac('sha256', unsigned(keyBytes)).update(unsigned(valueBytes)).digest()).map(b => (b > 127 ? b - 256 : b)));
  assert.deepStrictEqual(Array.from(sha.sha256(sha.utf8('abc'))).map(b => b.toString(16).padStart(2, '0')).join(''),
    crypto.createHash('sha256').update('abc').digest('hex'));
});

// ------------------------------------------------------------------ the network

test('a failed call throws the way UrlFetchApp does, without the bot token in the message', () => {
  const answers = { code: 500, text: 'boom' };
  const fetchApp = shims.createUrlFetchApp(() => answers);
  assert.throws(() => fetchApp.fetch('https://api.telegram.org/bot123:SECRET/sendMessage', { method: 'post', payload: '{}' }),
    error => /returned code 500/.test(error.message) && !/SECRET/.test(error.message));
  const muted = fetchApp.fetch('https://api.telegram.org/bot123:SECRET/sendMessage', { method: 'post', payload: '{}', muteHttpExceptions: true });
  assert.strictEqual(muted.getResponseCode(), 500);
  const down = shims.createUrlFetchApp(() => ({ transportError: 'Exception: DNS error' }));
  assert.throws(() => down.fetch('https://example.org/', { muteHttpExceptions: true }), /DNS error/);
});

test('the cache lives in app_cache: reads ask the database, writes go with the next call, sum_ keys are not kept', () => {
  const db = createSupabaseMock();
  let clock = Date.UTC(2026, 10, 16, 8, 0);
  const sent = [];
  const env = { supabaseUrl: db.url, supabaseKey: db.key };
  const perform = work => {
    sent.push(work.request.method + ' ' + new URL(work.request.url).pathname);
    const response = db.handle(work.request.url, {
      method: work.request.method, headers: work.request.headers, payload: work.request.body === null ? undefined : work.request.body
    });
    return { code: response.getResponseCode(), text: response.getContentText(), headers: response.getHeaders() };
  };
  const run = invoke => executor.runSync({
    makeGlobals: ctx => ({ cache: shims.createDatabaseCache(ctx.io, ctx.defer, env, () => clock) }),
    invoke: G => invoke(G.cache),
    perform,
    performDeferred: requests => requests.forEach(perform)
  });

  const first = run(cache => {
    cache.put('yangi_42', '{"step":"amount"}', 60);
    cache.put('sum_dashboard_OMAD_1', 'big', 60);
    return cache.get('yangi_42');
  });
  assert.strictEqual(first.result, '{"step":"amount"}', 'a run sees its own write');
  assert.deepStrictEqual(sent, ['post /rest/v1/app_cache'], 'one write, sent at the end; the summary was not stored');
  assert.strictEqual(db.rows.app_cache.length, 1);

  assert.strictEqual(run(cache => cache.get('yangi_42')).result, '{"step":"amount"}', 'the next request reads it back');
  clock += 61000;
  assert.strictEqual(run(cache => cache.get('yangi_42')).result, null, 'and not once it has expired');
  run(cache => cache.remove('yangi_42'));
  assert.strictEqual(db.rows.app_cache.length, 0);
});

// ------------------------------------------------------------------ the runtime wrapper

function factoryFrom(bundle) {
  const holder = { exports: {} };
  vm.runInThisContext('(function (module) {\n' + buildRuntimeSource(bundle) + '\n})')(holder);
  return holder.exports;
}

const ENTRY_STUBS = 'function processPendingTelegramJobs() {}\nfunction processTaskSchedules() {}\n';

test('every call of the runtime is a fresh backend: nothing one request leaves reaches the next', () => {
  const factory = factoryFrom(ENTRY_STUBS + 'var hits = 0;\nfunction doPost(e) { hits++; return hits; }\nfunction doGet() { return Date.now(); }\n');
  assert.strictEqual(factory({ Date: { now: () => 7 } }).doPost({}), 1);
  assert.strictEqual(factory({ Date: { now: () => 7 } }).doPost({}), 1);
  assert.strictEqual(factory({ Date: { now: () => 7 } }).doGet(), 7, 'the services are the ones it is handed');
});

test('the runtime is strict: a forgotten var is an error, not a global shared between requests', () => {
  const factory = factoryFrom(ENTRY_STUBS + 'function doPost(e) { leaked = 1; return leaked; }\nfunction doGet() {}\n');
  assert.throws(() => factory({}).doPost({}), /leaked is not defined/);
  assert.strictEqual(typeof globalThis.leaked, 'undefined');
});

test('the runtime refuses to build without an entry point Apps Script calls', () => {
  assert.throws(() => buildRuntimeSource('function doPost(e) {}'), /no top-level function doGet/);
});
