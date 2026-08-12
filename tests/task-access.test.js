'use strict';

/**
 * Reading the task board requires the admin key.
 *
 * Invariant: the board is internal company information - who is responsible
 * for what, when it is due, and whose deadlines have been slipping. It used to
 * be readable by anyone holding the deployment URL, over POST and over GET.
 *
 * The key is compared only after a rate limit, so the endpoint cannot be used
 * to guess it, and the GET route is refused outright because a GET puts its
 * parameters in the URL - the one place an admin key must never travel.
 *
 * This file also pins the boundary: tightening task reads must not tighten the
 * accounting reads that the Omad and Café pages depend on.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const ADMIN_KEY = 'test-admin-key';
const SECRET_TITLE = 'Maxfiy ichki vazifa';

function props(extra) {
  return Object.assign({
    OMAD_ADMIN_KEY: ADMIN_KEY,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: '111222333',
    TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
  }, extra || {});
}

/** A loaded backend holding one task with a title no stranger may see. */
function withTask(extra) {
  const gas = loadScript({ properties: props(extra) });
  const result = gas.normalizeTaskInput_({
    type: 'once', title: SECRET_TITLE, responsible: 'Ali', deadlineKey: '2026-08-12'
  }, null);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);
  gas.materializeTaskOccurrences_(gas.__spreadsheet, result.task, Date.now());
  return { gas, doc: gas.__spreadsheet, task: result.task };
}

/** The raw serialised response body, for leak assertions. */
function rawBody(output) {
  return output.__text || output.getContent();
}

// ------------------------------------------------------------------ reads

test('an anonymous POST get_tasks is refused', () => {
  const { gas } = withTask();
  const output = gas.doPost(postEvent({ action: 'get_tasks' }));
  const body = readJsonOutput(output);

  assert.strictEqual(body.status, 'error');
  assert.strictEqual(rawBody(output).indexOf(SECRET_TITLE), -1, 'no task title reached the wire');
});

test('a wrong admin key is refused', () => {
  const { gas } = withTask();
  const output = gas.doPost(postEvent({ action: 'get_tasks', adminKey: 'not-the-key' }));

  assert.strictEqual(readJsonOutput(output).status, 'error');
  assert.strictEqual(rawBody(output).indexOf(SECRET_TITLE), -1);
});

test('the correct admin key returns the view', () => {
  const { gas } = withTask();
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks', adminKey: ADMIN_KEY })));

  assert.strictEqual(body.status, 'success');
  assert.ok(Array.from(body.view.tasks).some(t => t.title === SECRET_TITLE));
});

test('get_tasks over GET never returns data', () => {
  const { gas } = withTask();
  const output = gas.doGet({ parameter: { action: 'get_tasks' } });
  const body = readJsonOutput(output);

  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.view, undefined);
  assert.strictEqual(rawBody(output).indexOf(SECRET_TITLE), -1);

  // Even with the key in the query string, which is the whole reason GET is out.
  const withKey = gas.doGet({ parameter: { action: 'get_tasks', adminKey: ADMIN_KEY } });
  assert.strictEqual(readJsonOutput(withKey).status, 'error');
  assert.strictEqual(rawBody(withKey).indexOf(SECRET_TITLE), -1);
});

test('get_tasks with no OMAD_ADMIN_KEY configured is refused', () => {
  const gas = loadScript({ properties: { TELEGRAM_BOT_TOKEN: TOKEN } });
  const result = gas.normalizeTaskInput_({ type: 'once', title: SECRET_TITLE }, null);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);

  const output = gas.doPost(postEvent({ action: 'get_tasks', adminKey: 'anything' }));
  const body = readJsonOutput(output);

  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /OMAD_ADMIN_KEY/);
  assert.strictEqual(rawBody(output).indexOf(SECRET_TITLE), -1);
});

test('repeated anonymous reads are rate limited', () => {
  const { gas } = withTask();
  let last = null;
  for (let i = 0; i < gas.TASK_READ_RATE_LIMIT + 1; i++) {
    last = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks' })));
  }
  assert.strictEqual(last.status, 'error');
  assert.match(last.message, /^Juda ko'p so'rov yuborildi/,
    'past the limit the answer is the throttle message, not a key error');
});

// -------------------------------------------------------------- mutations

test('every task mutation is still admin gated', () => {
  const { gas, doc, task } = withTask();
  const occ = gas.readOccurrenceRows_(doc)[0];
  const before = JSON.stringify(doc.sheets.Tasks.data) + JSON.stringify(doc.sheets.Task_Occurrences.data);

  const mutations = [
    { action: 'save_task', type: 'once', title: 'Yangi' },
    { action: 'cancel_task', id: task.id },
    { action: 'pause_routine', id: task.id },
    { action: 'resume_routine', id: task.id },
    { action: 'skip_occurrence', occurrenceId: occ.id },
    { action: 'complete_occurrence', occurrenceId: occ.id },
    { action: 'reopen_occurrence', occurrenceId: occ.id }
  ];

  mutations.forEach(payload => {
    const body = readJsonOutput(gas.doPost(postEvent(payload)));
    assert.strictEqual(body.status, 'error', payload.action + ' must require the admin key');
  });

  const after = JSON.stringify(doc.sheets.Tasks.data) + JSON.stringify(doc.sheets.Task_Occurrences.data);
  assert.strictEqual(after, before, 'the sheets are untouched');
});

// -------------------------------------------------------------- boundaries

test('a task read does not leak into other actions', () => {
  const gas = loadScript({
    properties: props(),
    sheets: { System_Config: [['Key', 'Value'], ['Omad_Tenants', '[]']] }
  });

  const omad = readJsonOutput(gas.doPost(postEvent({ action: 'get_omad_data', adminKey: ADMIN_KEY })));
  assert.ok(omad.tenants, 'the Omad read still answers for a key holder');

  const cafe = readJsonOutput(gas.doPost(postEvent({ action: 'get_cafe_data', adminKey: ADMIN_KEY })));
  assert.ok(cafe, 'the café read still answers for a key holder');
});
