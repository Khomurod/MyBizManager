'use strict';

/**
 * Pausing a routine stops everything, including work already on the sheet.
 *
 * Invariant: a paused routine is silent. The scheduler materialises the next
 * 14 days ahead of time, so "stop creating new occurrences" is not enough on
 * its own - the days already written must not announce or remind either, and a
 * job enqueued a moment before the pause must not still be delivered.
 *
 * What a pause must never do is rewrite history: a day that was already
 * announced, completed or skipped stays exactly as it is.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent, readJsonOutput } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const ADMIN_KEY = 'test-admin-key';
const DAY_MS = 86400000;

// Anchored to the real Tashkent day, not a literal date. Pausing and pruning
// call Date.now() internally, so a fixture pinned to a fixed calendar day
// disagrees with the code under test for the five hours each evening when UTC
// and Tashkent are on different dates — and the suite went red every night.
const TASHKENT_OFFSET_MS = 5 * 3600000; // UTC+5, year round
function tashkentKey(ms) {
  return new Date(ms + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}
const TODAY = tashkentKey(Date.now());
const FIXED_NOW = Date.parse(TODAY + 'T09:00:00+05:00');
const TOMORROW = tashkentKey(FIXED_NOW + DAY_MS);
const DAY_AFTER = tashkentKey(FIXED_NOW + 2 * DAY_MS);
const DAY_THREE = tashkentKey(FIXED_NOW + 3 * DAY_MS);

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      TELEGRAM_GROUP_CHAT_ID: '-1001111111111',
      OMAD_ADMIN_KEY: ADMIN_KEY
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

function makeRoutine(gas, extra) {
  const result = gas.normalizeTaskInput_(Object.assign({
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' },
    dueTime: '20:00', reminderTimes: ['08:00']
  }, extra || {}), null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);
  gas.materializeTaskOccurrences_(gas.__spreadsheet, result.task, FIXED_NOW);
  return result.task;
}

/** Task job rows currently on the queue sheet, as {type, status} records. */
function jobRows(gas, doc) {
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  return data.slice(1).map(row => ({
    type: row[header.indexOf('Type')],
    status: row[header.indexOf('Status')],
    attempts: row[header.indexOf('Attempts')]
  }));
}

/**
 * Occurrences for one task, as a native array — the backend builds its arrays
 * inside the script VM, and those never satisfy deepStrictEqual against a
 * literal written out here.
 */
function occurrencesFor(gas, doc, taskId) {
  return Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.taskId === taskId);
}

function pause(gas, id) {
  return readJsonOutput(gas.doPost(postEvent({ action: 'pause_routine', adminKey: ADMIN_KEY, id: id })));
}

// ------------------------------------------------------------- the guard

test('a paused routine sends nothing even when its future days already exist', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);

  // Pause by writing the row directly: this is a routine whose horizon was
  // materialised before anybody pressed pause.
  const live = gas.findTask_(doc, task.id);
  live.status = gas.TASK_DEF_PAUSED;
  gas.updateTaskRow_(doc, live);

  const sentBefore = gas.__sentMessages.length;
  const jobsBefore = jobRows(gas, doc).length;

  gas.runTaskScheduler_(doc, FIXED_NOW + DAY_MS);
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(gas.__sentMessages.length, sentBefore, 'nothing was sent');
  const added = jobRows(gas, doc).slice(jobsBefore);
  assert.deepStrictEqual(added.filter(j => j.type === 'task_notify' || j.type === 'task_reminder'), []);
});

test('pausing through the API stops the group going forward', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);

  assert.strictEqual(pause(gas, task.id).status, 'success');
  assert.strictEqual(gas.findTask_(doc, task.id).status, gas.TASK_DEF_PAUSED);

  const before = gas.__sentMessages.length;
  gas.runTaskScheduler_(doc, FIXED_NOW + DAY_MS);
  gas.processPendingJobs_(doc, 25);
  assert.strictEqual(gas.__sentMessages.length, before, 'the group hears nothing');
});

// ------------------------------------------------------------- the prune

test('pausing removes only the unseen future', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);
  const rows = occurrencesFor(gas, doc, task.id);

  // Today's row is announced; one future day is completed and another skipped.
  const today = rows.find(o => o.dateKey === TODAY);
  today.notifiedAt = new Date(FIXED_NOW).toISOString();
  today.msgId = '555';
  gas.writeOccurrenceRow_(doc, today);

  const completed = rows.find(o => o.dateKey === DAY_AFTER);
  completed.status = gas.TASK_STATUS_COMPLETED;
  completed.completedByName = 'Ali';
  gas.writeOccurrenceRow_(doc, completed);

  const skipped = rows.find(o => o.dateKey === DAY_THREE);
  skipped.status = gas.TASK_STATUS_SKIPPED;
  gas.writeOccurrenceRow_(doc, skipped);

  pause(gas, task.id);

  const after = occurrencesFor(gas, doc, task.id);
  const keys = after.map(o => o.dateKey).sort();
  assert.deepStrictEqual(keys, [TODAY, DAY_AFTER, DAY_THREE],
    'every un-announced future day is gone, history is not');

  assert.strictEqual(after.find(o => o.dateKey === TODAY).status, gas.TASK_STATUS_OPEN);
  assert.strictEqual(after.find(o => o.dateKey === TODAY).msgId, '555');
  assert.strictEqual(after.find(o => o.dateKey === DAY_AFTER).status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(after.find(o => o.dateKey === DAY_AFTER).completedByName, 'Ali');
  assert.strictEqual(after.find(o => o.dateKey === DAY_THREE).status, gas.TASK_STATUS_SKIPPED);
});

test('a day that already pinged the group is treated as announced', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);

  const tomorrow = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === TOMORROW);
  tomorrow.remindersSent[TOMORROW + ' 08:00'] = new Date(FIXED_NOW).toISOString();
  gas.writeOccurrenceRow_(doc, tomorrow);

  pause(gas, task.id);

  const survivor = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === TOMORROW);
  assert.ok(survivor, 'a reminded day is history, not an unseen future day');
});

// --------------------------------------------------------- in-flight jobs

test('a notify job queued before the pause does not send', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);
  const today = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === TODAY);

  gas.enqueueTaskJob_(doc, 'task_notify', today.id, { occurrenceId: today.id });
  pause(gas, task.id);

  const before = gas.__sentMessages.length;
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(gas.__sentMessages.length, before, 'nothing was sent');
  const notify = jobRows(gas, doc).filter(j => j.type === 'task_notify');
  assert.ok(notify.length >= 1);
  notify.forEach(j => assert.strictEqual(j.status, 'Completed', 'the job finished cleanly, it did not fail'));
});

test('a reminder job queued before the pause does not send', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);
  const today = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === TODAY);

  gas.enqueueTaskJob_(doc, 'task_reminder', today.id, { occurrenceId: today.id, slot: TODAY + ' 08:00' });
  pause(gas, task.id);

  const before = gas.__sentMessages.length;
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(gas.__sentMessages.length, before);
  const reminders = jobRows(gas, doc).filter(j => j.type === 'task_reminder');
  assert.ok(reminders.length >= 1);
  reminders.forEach(j => assert.strictEqual(j.status, 'Completed'));
});

test('reminder slots are not burned while paused', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);
  pause(gas, task.id);

  // 08:00 tomorrow comes and goes while the routine is paused.
  gas.runTaskScheduler_(doc, FIXED_NOW + DAY_MS);

  const pausedDay = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === TODAY);
  assert.deepStrictEqual(Object.keys(pausedDay.remindersSent), [],
    "a paused day's reminder slot is left untouched, not silently consumed");
});

// ----------------------------------------------------------------- resume

test('resuming regenerates without duplicating', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);

  const completed = occurrencesFor(gas, doc, task.id).find(o => o.dateKey === DAY_AFTER);
  completed.status = gas.TASK_STATUS_COMPLETED;
  gas.writeOccurrenceRow_(doc, completed);

  pause(gas, task.id);
  readJsonOutput(gas.doPost(postEvent({ action: 'resume_routine', adminKey: ADMIN_KEY, id: task.id })));
  gas.runTaskScheduler_(doc, FIXED_NOW);

  const after = occurrencesFor(gas, doc, task.id);
  const keys = after.map(o => o.dateKey);
  assert.strictEqual(new Set(keys).size, keys.length, 'exactly one occurrence per due date');
  assert.strictEqual(after.find(o => o.dateKey === DAY_AFTER).status, gas.TASK_STATUS_COMPLETED,
    'completed history survived the pause/resume cycle');
});

test('paused routines disappear from the upcoming view', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas);
  pause(gas, task.id);

  const view = gas.buildTaskViews_(doc, FIXED_NOW);
  const mine = Array.from(view.today.upcoming).filter(o => o.taskId === task.id);
  assert.deepStrictEqual(mine, [], 'a paused routine has no upcoming days left on the sheet');
});
