'use strict';

/**
 * How much work one task mutation does, and what it must still do.
 *
 * A mutation used to carry two different jobs in one response: the durable write
 * plus the occurrence reconciliation the caller is waiting for, and a full scan
 * of every schedule plus a Telegram round trip that nobody is. `deferReports`
 * moves the second half into `settle_tasks` / `mini_settle_tasks`, with the
 * five-minute trigger as the fallback it always was.
 *
 * The tests are in two halves, and the second is the important one:
 *
 *   1. the cost: finding one task or one occurrence must not read every row, and
 *      a deferred mutation must not scan or send inside its own response;
 *   2. the equivalence: the *stored* outcome of every mutation must be
 *      byte-identical whether or not the caller deferred. Deferral is allowed to
 *      change when a card is sent. It is not allowed to change what is on the
 *      sheet — which is exactly how `resume_routine` was caught rebuilding its
 *      horizon only as a side effect of the scan it no longer runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'task-perf-admin';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '111222333';

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_TASKS_GROUP_CHAT_ID: '-1009998887777'
    },
    sheets: { System_Config: [] }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

/** Counts whole-sheet passes by name, the way tests/read-efficiency.test.js does. */
function countSheetReads(gas, run) {
  const counts = {};
  const restore = [];
  gas.__spreadsheet.getSheets().forEach(sheet => {
    const name = sheet.getName();
    const original = sheet.getDataRange;
    restore.push(() => { sheet.getDataRange = original; });
    sheet.getDataRange = function () {
      const range = original.call(sheet);
      const inner = range.getValues;
      range.getValues = function () {
        counts[name] = (counts[name] || 0) + 1;
        return inner.call(range);
      };
      return range;
    };
  });
  try { run(); } finally { restore.forEach(fn => fn()); }
  return counts;
}

function sheetRows(gas, name) {
  const sheet = gas.__spreadsheet.getSheetByName(name);
  return sheet ? sheet.data.slice(1).map(row => row.slice()) : [];
}

// ------------------------------------------------------------ the row lookups

test('finding one task or one occurrence does not read the whole sheet', () => {
  const gas = boot();
  // Eight one-time tasks, so a whole-sheet pass is a pass over real rows. The
  // admin key deliberately spends a strict `auth_key` allowance on every
  // request (AUTH_FAILURE_LIMIT = 10/min), so a seeding loop stays under it.
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const created = post(gas, { action: 'save_task', type: 'once', title: `Ish ${i}`, reminderTimes: [] });
    assert.strictEqual(created.status, 'success', created.message);
    ids.push(created.taskId);
  }
  const target = ids[5];
  const occurrences = sheetRows(gas, 'Task_Occurrences');
  const targetOcc = occurrences.find(row => row[1] === target);
  assert.ok(targetOcc, 'the task has an occurrence to find');

  const counts = countSheetReads(gas, () => {
    const task = gas.findTask_(gas.__spreadsheet, target);
    assert.strictEqual(task.id, target);
    assert.strictEqual(task.title, 'Ish 5');
    const occ = gas.findOccurrence_(gas.__spreadsheet, targetOcc[0]);
    assert.strictEqual(occ.id, targetOcc[0]);
    assert.strictEqual(occ.taskId, target);
  });

  assert.ok(!counts.Tasks, 'findTask_ reads the id column and one row');
  assert.ok(!counts.Task_Occurrences, 'findOccurrence_ reads the id column and one row');
});

test('the row lookups answer exactly what the whole-sheet readers answered', () => {
  const gas = boot();
  for (let i = 0; i < 6; i++) {
    post(gas, { action: 'save_task', type: 'once', title: `Ish ${i}`, reminderTimes: ['09:00'] });
  }
  // `rowNumber` is the one thing every caller depends on: `writeOccurrenceRow_`
  // and `updateTaskRow_` both return silently when it is missing, so a lookup
  // that lost it would drop writes without an error.
  gas.readTaskRows_(gas.__spreadsheet).forEach(expected => {
    assert.deepStrictEqual(gas.findTask_(gas.__spreadsheet, expected.id), expected);
    assert.deepStrictEqual(
      gas.findTaskBeforeWritePerf_(gas.__spreadsheet, expected.id), expected,
      'and the reader it replaced agrees'
    );
  });
  gas.readOccurrenceRows_(gas.__spreadsheet).forEach(expected => {
    assert.deepStrictEqual(gas.findOccurrence_(gas.__spreadsheet, expected.id), expected);
    assert.deepStrictEqual(
      gas.findOccurrenceBeforeWritePerf_(gas.__spreadsheet, expected.id), expected);
  });
});

test('an id that is absent, blank or a prefix finds nothing', () => {
  const gas = boot();
  const id = post(gas, { action: 'save_task', type: 'once', title: 'Bitta', reminderTimes: [] }).taskId;
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, ''), null);
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, null), null);
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, undefined), null);
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, 'task_nope'), null);
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, id.slice(0, -2)), null,
    'a prefix is not a match; the whole cell has to be the id');
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, ''), null);
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, 'occ_nope'), null);
});

test('a missing task or occurrence is still refused by name', () => {
  const gas = boot();
  assert.strictEqual(post(gas, { action: 'cancel_task', id: 'task_nope' }).message, 'Vazifa topilmadi.');
  assert.strictEqual(post(gas, { action: 'pause_routine', id: 'task_nope' }).message, 'Vazifa topilmadi.');
  assert.strictEqual(
    post(gas, { action: 'complete_occurrence', occurrenceId: 'occ_nope' }).message, 'Vazifa topilmadi.');
  assert.strictEqual(
    post(gas, { action: 'skip_occurrence', occurrenceId: 'occ_nope' }).message, 'Vazifa topilmadi.');
});

// ---------------------------------------------------------- deferred settling

test('a deferred mutation neither scans the schedules nor sends to Telegram', () => {
  const gas = boot();
  const created = post(gas, {
    action: 'save_task', type: 'routine', title: 'Har kuni',
    recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [], deferReports: true
  });
  assert.strictEqual(created.status, 'success');
  assert.strictEqual(gas.__fetchCalls.length, 0, 'no Telegram round trip inside the response');

  // Nothing was announced, so nothing is marked as announced either: the
  // scheduler is still the only thing that sets Notified_At.
  const occurrences = sheetRows(gas, 'Task_Occurrences');
  assert.ok(occurrences.length > 1, 'the horizon is materialised in the foreground');
  const notifiedColumn = gas.TASK_OCC_HEADER.indexOf('Notified_At');
  assert.ok(occurrences.every(row => !row[notifiedColumn]));

  // ...and the settle request is what does it, exactly as the trigger would.
  const settled = post(gas, { action: 'settle_tasks' });
  assert.strictEqual(settled.status, 'success');
  assert.ok(settled.notified >= 1, 'the settle request announces what came due');
  assert.ok(gas.__fetchCalls.length >= 1, 'and that is where Telegram is called');
});

test('an undeferred mutation keeps announcing inside its own response', () => {
  const gas = boot();
  const created = post(gas, {
    action: 'save_task', type: 'routine', title: 'Har kuni',
    recurrence: { freq: 'daily', interval: 1 }, reminderTimes: []
  });
  assert.strictEqual(created.status, 'success');
  const notifiedColumn = gas.TASK_OCC_HEADER.indexOf('Notified_At');
  assert.ok(sheetRows(gas, 'Task_Occurrences').some(row => !!row[notifiedColumn]),
    'a client that says nothing gets exactly the behaviour it always had');
});

test('the trigger still settles a deferred mutation whose settle request was lost', () => {
  const gas = boot();
  post(gas, {
    action: 'save_task', type: 'once', title: 'Bugun', reminderTimes: [], deferReports: true
  });
  assert.strictEqual(gas.__fetchCalls.length, 0);

  // The follow-up request never arrives — the tab was closed, the phone lost
  // signal. The five-minute trigger runs the same cycle.
  gas.processPendingTelegramJobs();
  assert.ok(gas.__fetchCalls.length >= 1, 'the card is late, never missing');
  const notifiedColumn = gas.TASK_OCC_HEADER.indexOf('Notified_At');
  assert.ok(sheetRows(gas, 'Task_Occurrences').every(row => !!row[notifiedColumn]));
});

test('settle_tasks is omad_admin only, like every other task action', () => {
  const gas = boot();
  const refused = readJsonOutput(gas.doPost(postEvent({ action: 'settle_tasks' })));
  assert.strictEqual(refused.status, 'error');
  assert.notStrictEqual(refused.message, 'Unknown action',
    'it is routed inside the task namespace rather than falling through');
  const wrongKey = readJsonOutput(gas.doPost(postEvent({ action: 'settle_tasks', adminKey: 'nope' })));
  assert.strictEqual(wrongKey.status, 'error');
});

// -------------------------------------------------------------- equivalence
//
// Two runs of the same mutation, one deferred and one not, must leave the same
// rows behind. Reminder markers and Notified_At are the deliberate exception:
// those are set at announce time, and announcing is the half that moved.

const VOLATILE_OCCURRENCE_COLUMNS = [
  'Reminders_Sent_JSON', 'Notified_At', 'Telegram_Msg_ID', 'ID',
  // Wall-clock stamps and a lateness measured against one. `Status` and
  // `On_Time` are the outcome and are compared.
  'Created_At', 'Updated_At', 'Completed_At', 'Late_Ms'
];

function comparableOccurrences(gas) {
  const skip = VOLATILE_OCCURRENCE_COLUMNS.map(name => gas.TASK_OCC_HEADER.indexOf(name));
  return sheetRows(gas, 'Task_Occurrences')
    .map(row => row.filter((value, index) => skip.indexOf(index) === -1))
    .map(row => JSON.stringify(row))
    .sort();
}

function comparableTasks(gas) {
  const skip = ['ID', 'Created_At', 'Updated_At'].map(name => gas.TASKS_HEADER.indexOf(name));
  return sheetRows(gas, 'Tasks')
    .map(row => row.filter((value, index) => skip.indexOf(index) === -1))
    .map(row => JSON.stringify(row))
    .sort();
}

/** Runs `steps` against a fresh backend, deferring every mutation or none. */
function runScenario(steps, defer) {
  const gas = boot();
  const ids = {};
  steps.forEach(step => {
    const body = step(ids);
    const answer = post(gas, Object.assign({}, body, defer ? { deferReports: true } : {}));
    assert.strictEqual(answer.status, 'success', `${body.action}: ${answer.message}`);
    if (answer.taskId) ids.taskId = answer.taskId;
    if (answer.view) ids.view = answer.view;
    const occurrences = sheetRows(gas, 'Task_Occurrences');
    if (occurrences.length) ids.firstOccurrenceId = occurrences[0][0];
  });
  return gas;
}

const SCENARIOS = {
  'creating a routine': [
    () => ({ action: 'save_task', type: 'routine', title: 'Har kuni',
      recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [] })
  ],
  'editing a routine': [
    () => ({ action: 'save_task', type: 'routine', title: 'Har kuni',
      recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [] }),
    ids => ({ action: 'save_task', id: ids.taskId, title: 'Har kuni, yangi nom',
      responsible: 'Aziz' })
  ],
  'pausing a routine': [
    () => ({ action: 'save_task', type: 'routine', title: 'Har kuni',
      recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [] }),
    ids => ({ action: 'pause_routine', id: ids.taskId })
  ],
  'pausing and resuming a routine': [
    () => ({ action: 'save_task', type: 'routine', title: 'Har kuni',
      recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [] }),
    ids => ({ action: 'pause_routine', id: ids.taskId }),
    ids => ({ action: 'resume_routine', id: ids.taskId })
  ],
  'cancelling a task': [
    () => ({ action: 'save_task', type: 'once', title: 'Bir marta', reminderTimes: [] }),
    ids => ({ action: 'cancel_task', id: ids.taskId })
  ],
  'completing an occurrence': [
    () => ({ action: 'save_task', type: 'once', title: 'Bir marta', reminderTimes: [] }),
    ids => ({ action: 'complete_occurrence', occurrenceId: ids.firstOccurrenceId })
  ],
  'reopening an occurrence': [
    () => ({ action: 'save_task', type: 'once', title: 'Bir marta', reminderTimes: [] }),
    ids => ({ action: 'complete_occurrence', occurrenceId: ids.firstOccurrenceId }),
    ids => ({ action: 'reopen_occurrence', occurrenceId: ids.firstOccurrenceId })
  ],
  'skipping an occurrence': [
    () => ({ action: 'save_task', type: 'routine', title: 'Har kuni',
      recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [] }),
    ids => ({ action: 'skip_occurrence', occurrenceId: ids.firstOccurrenceId })
  ],
  'creating and editing a goal': [
    () => ({ action: 'save_task', type: 'goal', title: 'Maqsad',
      steps: ['Birinchi', 'Ikkinchi'], reminderTimes: [] }),
    ids => ({ action: 'save_task', id: ids.taskId, steps: ['Birinchi', 'Uchinchi'] })
  ]
};

Object.keys(SCENARIOS).forEach(name => {
  test(`${name} stores the same rows deferred or not`, () => {
    const plain = runScenario(SCENARIOS[name], false);
    const deferred = runScenario(SCENARIOS[name], true);

    assert.deepStrictEqual(comparableTasks(deferred), comparableTasks(plain));
    assert.deepStrictEqual(comparableOccurrences(deferred), comparableOccurrences(plain));
    assert.strictEqual(
      sheetRows(deferred, 'Task_Occurrences').length,
      sheetRows(plain, 'Task_Occurrences').length,
      'the same number of occurrence rows exist either way'
    );
  });
});

test('resuming a routine rebuilds its horizon in the foreground, not as a side effect', () => {
  // The specific regression: `pause_routine` deletes the unseen future days, and
  // `resume_routine` used to get them back only because the inline schedule scan
  // happened to run afterwards. Deferring the scan left the caller with a
  // routine reported active and a Kelgusi list with nothing in it.
  const gas = boot();
  const created = post(gas, {
    action: 'save_task', type: 'routine', title: 'Har kuni',
    recurrence: { freq: 'daily', interval: 1 }, reminderTimes: [], deferReports: true
  });
  const taskId = created.taskId;
  const horizon = sheetRows(gas, 'Task_Occurrences').length;
  assert.ok(horizon > 1, 'a daily routine materialises a horizon');

  post(gas, { action: 'pause_routine', id: taskId, deferReports: true });
  assert.strictEqual(sheetRows(gas, 'Task_Occurrences').length, 1,
    'unseen future days are removed by the pause');

  const resumed = post(gas, { action: 'resume_routine', id: taskId, deferReports: true });
  assert.strictEqual(resumed.status, 'success');
  assert.strictEqual(sheetRows(gas, 'Task_Occurrences').length, horizon,
    'the horizon is back before the response is written');
  assert.ok(resumed.view.today.upcoming.length + resumed.view.today.needsAttention.length > 0,
    'and the answer the client paints agrees with the sheet');
});

// ------------------------------------------------------------------ Mini App

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_q',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

test('mini_settle_tasks needs verified initData and settles like the trigger', () => {
  const gas = boot();
  const initData = signedInitData();

  const saved = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_task_action', initData, taskAction: 'save_task',
    type: 'once', title: 'Telefondan', reminderTimes: [], deferReports: true
  })));
  assert.strictEqual(saved.status, 'success');
  assert.strictEqual(gas.__fetchCalls.length, 0, 'the phone waits for no Telegram call');

  // Neither the admin key nor a web session reaches a mini_ action.
  const refused = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_settle_tasks', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(refused.authorized, false);

  const settled = readJsonOutput(gas.doPost(postEvent({ action: 'mini_settle_tasks', initData })));
  assert.strictEqual(settled.status, 'success');
  assert.ok(settled.notified >= 1);
  assert.ok(gas.__fetchCalls.length >= 1);
});

test('the Mini App keeps rewriting attribution from the signature, flag or not', () => {
  const gas = boot();
  const initData = signedInitData();
  const saved = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_task_action', initData, taskAction: 'save_task',
    type: 'once', title: 'Kim yaratdi', reminderTimes: [],
    deferReports: true, createdBy: 'somebody-else'
  })));
  assert.strictEqual(saved.status, 'success');
  const createdBy = gas.TASKS_HEADER.indexOf('Created_By');
  assert.strictEqual(sheetRows(gas, 'Tasks')[0][createdBy], `tg:${AUTHORIZED_ID}`);
});

// ------------------------------------------------------------------ the clients

test('both task clients defer settling and coalesce the follow-up request', () => {
  const board = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tasks', '01-tasks-api.js'), 'utf8');
  assert.match(board, /deferReports:\s*true/);
  assert.match(board, /action:\s*'settle_tasks'/);
  assert.match(board, /taskSettlePending/, 'the follow-up request is coalesced');
  assert.match(board, /taskMutationInFlight/, 'and a second click is refused explicitly');

  const mini = fs.readFileSync(path.join(__dirname, '..', 'assets', 'mini', '05-tasks.js'), 'utf8');
  const miniApi = fs.readFileSync(path.join(__dirname, '..', 'assets', 'mini', '01-api.js'), 'utf8');
  assert.strictEqual((mini.match(/deferReports:\s*true/g) || []).length, 3,
    'every mini_task_action payload defers');
  assert.strictEqual((mini.match(/settleTasksInBackground\(\)/g) || []).length, 3);
  assert.match(miniApi, /action must not be awaited|mini_settle_tasks/);
  assert.match(miniApi, /miniTaskSettlePending/);
});
