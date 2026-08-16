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
const AT_0005 = Date.UTC(2026, 7, 9, 19, 5, 0);  // 00:05 Tashkent
const AT_0900 = Date.UTC(2026, 7, 10, 4, 0, 0);  // 09:00 Tashkent
const AT_1430 = Date.UTC(2026, 7, 10, 9, 30, 0); // 14:30 Tashkent
const AT_1500 = Date.UTC(2026, 7, 10, 10, 0, 0); // 15:00 Tashkent
const AT_1805 = Date.UTC(2026, 7, 10, 13, 5, 0); // 18:05 Tashkent
const AT_2100 = Date.UTC(2026, 7, 10, 16, 0, 0); // 21:00 Tashkent

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

function setTodayOccurrenceCreatedAt(gas, doc, createdAtMs) {
  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  if (!occ) throw new Error('today occurrence was not materialised');
  occ.createdAt = new Date(createdAtMs).toISOString();
  gas.writeOccurrenceRow_(doc, occ);
  return occ;
}

test('a reminder-led routine stays silent at midnight and first speaks at its reminder time', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['18:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0005);
  setTodayOccurrenceCreatedAt(gas, doc, AT_0005);

  gas.runTaskScheduler_(doc, AT_0005);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0, 'no midnight task announcement');
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0, '18:00 is still ahead');

  gas.runTaskScheduler_(doc, AT_1805);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'one message at the configured time');

  gas.processPendingJobs_(doc, 25);
  assert.strictEqual(gas.__sentMessages.filter(m => /Eslatma/.test(m.text)).length, 1);
  assert.strictEqual(gas.__sentMessages.filter(m => /Yangi vazifa/.test(m.text)).length, 0);

  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  assert.ok(occ.msgId, 'the first reminder becomes the occurrence group card');
  assert.ok(occ.notifiedAt, 'the successful first group contact is recorded');
});

test('creating a task after an early reminder waits for the next configured time', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '18:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);
  const occ = setTodayOccurrenceCreatedAt(gas, doc, AT_0900);

  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0,
    'the already-missed 08:00 slot is not blasted at creation');
  assert.ok(gas.findOccurrence_(doc, occ.id).remindersSent[TODAY + ' 08:00'],
    'the pre-creation slot is consumed so it cannot revive later');

  gas.runTaskScheduler_(doc, AT_1805);
  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1);
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 18:00');
});

test('creating a task after all reminder times sends only the latest one once', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '12:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_2100);
  setTodayOccurrenceCreatedAt(gas, doc, AT_2100);

  gas.runTaskScheduler_(doc, AT_2100);
  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1, 'no burst of old reminders');
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 12:00',
    'the latest configured slot is the single catch-up');
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);

  gas.runTaskScheduler_(doc, AT_2100 + 5 * 60000);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'a second pass cannot duplicate catch-up');
});

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
