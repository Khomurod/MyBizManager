'use strict';

/**
 * Reminder scheduling: multiple times per day, no duplicate messages across
 * repeated scheduler passes, a catch-up window that suppresses long-missed
 * reminders, and reminders that stop the moment an occurrence is completed.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const TODAY = '2026-08-10';
const AT_0900 = Date.UTC(2026, 7, 10, 4, 0, 0);  // 09:00 Tashkent
const AT_1430 = Date.UTC(2026, 7, 10, 9, 30, 0); // 14:30 Tashkent
const AT_1500 = Date.UTC(2026, 7, 10, 10, 0, 0); // 15:00 Tashkent

function setup() {
  const gas = loadScript({ properties: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP, OMAD_ADMIN_KEY: 'k' } });
  return { gas, doc: gas.__spreadsheet };
}

function makeRoutine(gas, extra) {
  const payload = Object.assign({ type: 'routine', title: 'Eslatmali', startKey: TODAY, recurrence: { freq: 'daily' } }, extra);
  const r = gas.normalizeTaskInput_(payload, null);
  if (r.error) throw new Error(r.error);
  gas.appendTaskRow_(gas.__spreadsheet, r.task);
  return r.task;
}

function jobsOfType(gas, type) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0] && row[2] === type);
}

test('a reminder fires once per due time and never duplicates across passes', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '14:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);

  // 09:00: the 08:00 slot is due; 14:00 is still in the future.
  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'only the 08:00 reminder is due');

  // Running again at the same instant enqueues nothing new.
  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'no duplicate reminder');

  // 14:30: the 14:00 slot is now due.
  gas.runTaskScheduler_(doc, AT_1430);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 2, 'the 14:00 reminder is added');

  // And still no duplicates on a later pass.
  gas.runTaskScheduler_(doc, AT_1430);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 2);
});

test('a reminder missed by more than the catch-up window is suppressed, not blasted', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);

  // First pass only at 15:00 — the 08:00 slot is 7h stale (> 3h window).
  gas.runTaskScheduler_(doc, AT_1500);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0, 'no stale reminder is sent');

  // But it is marked handled, so a later pass never revives it.
  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  assert.ok(occ.remindersSent[TODAY + ' 08:00'], 'the slot is recorded as handled');
});

test('completing an occurrence stops its remaining reminders', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '14:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);
  gas.runTaskScheduler_(doc, AT_0900); // 08:00 reminder queued

  const occ = gas.findOccurrence_(doc, gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY).id);
  gas.completeTaskOccurrence_(doc, occ, { byName: 'Xodim', source: 'telegram', nowMs: AT_0900 });

  // The 14:00 slot must never be enqueued once the task is done.
  gas.runTaskScheduler_(doc, AT_1430);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'no reminder after completion');
});

test('a reminder job whose occurrence is already done sends nothing', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);
  const occ = gas.findOccurrence_(doc, gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY).id);

  // Queue a reminder, then complete the occurrence before the job runs.
  gas.enqueueTaskJob_(doc, 'task_reminder', occ.id, { occurrenceId: occ.id, slot: TODAY + ' 08:00' });
  gas.completeTaskOccurrence_(doc, occ, { byName: 'Xodim', source: 'telegram', nowMs: AT_0900 });

  const before = gas.__sentMessages.filter(m => /Eslatma/.test(m.text)).length;
  gas.processPendingJobs_(doc, 25);
  const after = gas.__sentMessages.filter(m => /Eslatma/.test(m.text)).length;
  assert.strictEqual(after, before, 'the stale reminder job is a no-op');
});

test('a new occurrence is announced exactly once', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, {});
  gas.materializeTaskOccurrences_(doc, task, AT_0900);

  gas.runTaskScheduler_(doc, AT_0900);
  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 1, 'one notify per occurrence');
});

test('reminders and notifications require a configured Tasks group to send', () => {
  // No TELEGRAM_TASKS_GROUP_CHAT_ID configured.
  const gas = loadScript({ properties: { TELEGRAM_BOT_TOKEN: TOKEN, OMAD_ADMIN_KEY: 'k' } });
  const doc = gas.__spreadsheet;
  const r = gas.normalizeTaskInput_({ type: 'routine', title: 'X', startKey: TODAY, recurrence: { freq: 'daily' }, reminderTimes: ['08:00'] }, null);
  gas.appendTaskRow_(doc, r.task);
  gas.materializeTaskOccurrences_(doc, r.task, AT_0900);
  gas.runTaskScheduler_(doc, AT_0900);
  gas.processPendingJobs_(doc, 25);
  // The jobs are enqueued but fail cleanly (no group), never crashing the run.
  assert.strictEqual(gas.__sentMessages.length, 0, 'nothing is sent without a group');
});
