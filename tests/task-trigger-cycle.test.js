'use strict';

/**
 * One time-driven trigger does the whole cycle.
 *
 * `processPendingTelegramJobs` - the trigger the live project already has -
 * now scans the task schedules and enqueues what has come due before draining
 * the queue, so the operator does not have to maintain a second
 * `processTaskSchedules` trigger beside it.
 *
 * The two properties that make that safe, and that this file pins:
 *
 *   * running either entry point, in any order and any number of times, sends
 *     each reminder exactly once - the pass marks a slot at enqueue time under
 *     the script lock, and the queue refuses an identical pending job;
 *   * a fault in the task scan never stops the queue draining, because the same
 *     queue carries the accounting reports.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const REPORT_GROUP = '-1001111111111';

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      TELEGRAM_GROUP_CHAT_ID: REPORT_GROUP,
      OMAD_ADMIN_KEY: 'k'
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

/**
 * A deadline-less one-time task with a reminder that is already due.
 *
 * Anchored to the real Tashkent day because the trigger entry points read
 * Date.now() themselves - that is the whole point of them - so the fixture has
 * to live on the same day the code under test will compute.
 */
function makeDueTask(gas, doc, reminderTime) {
  const result = gas.normalizeTaskInput_({
    type: 'once', title: 'Kunlik hisobot',
    reminderTimes: [reminderTime], remindDaily: true
  }, null);
  gas.appendTaskRow_(doc, result.task);
  return result.task;
}

/**
 * A reminder time that is already past *today* in Tashkent.
 *
 * Subtracting half an hour from "now" is only the same day for most of the
 * day: run this between 00:00 and 00:30 Tashkent and it lands on yesterday's
 * date, the occurrence is created for today, and nothing is due — so the whole
 * file failed for the first half hour of every day.
 *
 * Clamping to the start of the day keeps the reminder in the past and on the
 * day the trigger will compute, whatever time the suite runs.
 */
function recentlyDueTime(gas) {
  const now = gas.taskTzParts_(Date.now());
  const [hours, minutes] = String(now.timeKey).split(':').map(Number);
  const dueMinutes = Math.max(0, (hours * 60 + minutes) - 30);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(dueMinutes / 60))}:${pad(dueMinutes % 60)}`;
}

function reminderSends(gas) {
  return gas.__sentMessages.filter(m => /Eslatma/.test(m.text));
}

function notifySends(gas) {
  return gas.__sentMessages.filter(m => /Yangi vazifa/.test(m.text));
}

// ------------------------------------------------------------- one tick

test('the existing trigger scans, enqueues and sends in a single call', () => {
  const { gas, doc } = setup();
  makeDueTask(gas, doc, recentlyDueTime(gas));

  // No scheduler call of any kind before this line: the trigger does it all.
  gas.processPendingTelegramJobs();

  assert.strictEqual(notifySends(gas).length, 1, 'the task was announced');
  assert.strictEqual(reminderSends(gas).length, 1, 'and its due reminder went out');
});

test('the trigger still returns the number of jobs it processed', () => {
  const { gas, doc } = setup();
  makeDueTask(gas, doc, recentlyDueTime(gas));

  // A notify and a reminder, both enqueued and drained by the same tick.
  assert.strictEqual(gas.processPendingTelegramJobs(), 2);
  assert.strictEqual(gas.processPendingTelegramJobs(), 0, 'nothing is left to do');
});

// ------------------------------------------------------------ idempotency

test('running both entry points cannot duplicate a reminder', () => {
  const { gas, doc } = setup();
  makeDueTask(gas, doc, recentlyDueTime(gas));

  gas.processPendingTelegramJobs();
  gas.processTaskSchedules();
  gas.processPendingTelegramJobs();
  gas.processTaskSchedules();
  gas.processPendingTelegramJobs();

  assert.strictEqual(reminderSends(gas).length, 1, 'five passes, one reminder');
  assert.strictEqual(notifySends(gas).length, 1, 'and one announcement');
});

test('the manual entry point first is equally safe', () => {
  const { gas, doc } = setup();
  makeDueTask(gas, doc, recentlyDueTime(gas));

  gas.processTaskSchedules();
  gas.processPendingTelegramJobs();
  gas.processTaskSchedules();

  assert.strictEqual(reminderSends(gas).length, 1);
  assert.strictEqual(notifySends(gas).length, 1);
});

test('completing between two ticks stops the reminder that was not sent yet', () => {
  const { gas, doc } = setup();
  const parts = gas.taskTzParts_(Date.now() + 6 * 3600000); // hours away
  makeDueTask(gas, doc, parts.timeKey);

  gas.processPendingTelegramJobs();            // announces, nothing due yet
  assert.strictEqual(reminderSends(gas).length, 0);

  const occ = gas.readOccurrenceRows_(doc)[0];
  gas.completeTaskOccurrence_(doc, occ, { byName: 'Ali', source: 'telegram' });

  gas.processPendingTelegramJobs();
  assert.strictEqual(reminderSends(gas).length, 0, 'a finished task is never reminded');
});

// ------------------------------------------------------- failure isolation

test('a failing task scan still lets the accounting queue drain', () => {
  const { gas, doc } = setup();
  makeDueTask(gas, doc, recentlyDueTime(gas));
  // A financial report already waiting: it must go out regardless.
  gas.enqueueJob_(doc, 'omad_transaction_delete_report', 'tx_1',
    { summary: 'Test o\'chirildi' });

  // Break the task scan the way a corrupt sheet would.
  const tasksSheet = doc.getSheetByName('Tasks');
  tasksSheet.getDataRange = function () { throw new Error('Tasks sheet unreadable'); };

  const processed = gas.processPendingTelegramJobs();

  assert.strictEqual(processed, 1, 'the queued report was still processed');
  assert.strictEqual(reminderSends(gas).length, 0, 'the task side simply did nothing');
  const logged = doc.getSheetByName('Telegram_Debug_Log').getDataRange().getValues()
    .filter(row => row[1] === 'task_scheduler_trigger_failed');
  assert.strictEqual(logged.length, 1, 'and the fault was recorded rather than swallowed');
});
