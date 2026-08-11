'use strict';

/**
 * What "har kuni, vazifa bajarilguncha" means for a one-time task.
 *
 * The rule, and the bug it replaces: `taskReminderDatesFor_` used to check the
 * occurrence's dateKey first and return early, so `remindDaily` was dead code
 * for any one-time task that had a deadline. A task due on the 14th with a
 * 09:00 reminder and daily enabled reminded once, on the 14th.
 *
 * Now a one-time task with remindDaily reminds every Tashkent day it stays
 * open - no deadline, a deadline still days away, or a deadline long past -
 * and stops the moment the occurrence leaves Open. With remindDaily off, a
 * dated task keeps the old behaviour exactly: its deadline day and nothing
 * else. A routine is untouched either way: each of its days is its own
 * occurrence and owns its own reminders.
 *
 * Fixed calendar dates are safe in this file. Every entry point used here -
 * runTaskScheduler_, materializeTaskOccurrences_, completeTaskOccurrence_ -
 * takes an explicit instant, and none of these tests goes through the web API,
 * which is the path that runs a second scheduler pass at the real Date.now().
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';

// The worked example from the bug report: created the 11th, due the 14th.
const CREATED = '2026-08-11';
const DEADLINE = '2026-08-14';

/** A Tashkent wall-clock instant. UTC+5 year round, so this is exact. */
function at(dateKey, timeKey) {
  return Date.parse(dateKey + 'T' + timeKey + ':00+05:00');
}

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: 'k'
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

/** Creates a task and materialises its occurrence(s) at `nowMs`. */
function makeTask(gas, doc, payload, nowMs) {
  const result = gas.normalizeTaskInput_(payload, null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, nowMs);
  return result.task;
}

function makeOnce(gas, doc, extra, nowMs) {
  return makeTask(gas, doc, Object.assign({
    type: 'once', title: 'Hisobot topshirish'
  }, extra), nowMs === undefined ? at(CREATED, '08:00') : nowMs);
}

function onlyOccurrence(gas, doc, taskId) {
  const rows = gas.readOccurrenceRows_(doc).filter(o => o.taskId === taskId);
  assert.strictEqual(rows.length, 1, 'a one-time task has exactly one occurrence');
  return rows[0];
}

/** Every reminder slot the queue has been asked to send, in order. */
function reminderSlots(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .filter(row => row[0] && row[2] === 'task_reminder')
    .map(row => JSON.parse(row[3]).slot);
}

// ------------------------------------------------------- the worked example

test('a dated one-time task with daily reminders fires before, on and after its deadline', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, {
    deadlineKey: DEADLINE, deadlineTime: '09:00',
    reminderTimes: ['09:00'], remindDaily: true
  });

  // Created on the 11th, due on the 14th. Every day in between must ring.
  for (const day of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
    gas.runTaskScheduler_(doc, at(day, '09:00'));
  }
  assert.deepStrictEqual(reminderSlots(gas), [
    '2026-08-11 09:00', '2026-08-12 09:00', '2026-08-13 09:00', '2026-08-14 09:00'
  ], 'one reminder per day from creation through the deadline');

  // Still open the morning after the deadline: it keeps ringing.
  gas.runTaskScheduler_(doc, at('2026-08-15', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-16', '09:00'));
  assert.deepStrictEqual(reminderSlots(gas).slice(4),
    ['2026-08-15 09:00', '2026-08-16 09:00'],
    'an overdue but open task is still reminded');
});

test('a deadline-less one-time task with daily reminders fires every day', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, { reminderTimes: ['09:00'], remindDaily: true });

  gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-13', '09:00'));

  assert.deepStrictEqual(reminderSlots(gas),
    ['2026-08-11 09:00', '2026-08-12 09:00', '2026-08-13 09:00']);
});

test('several reminder times a day each roll forward independently', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00', '18:00'], remindDaily: true
  });

  gas.runTaskScheduler_(doc, at('2026-08-11', '09:30'));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-11 09:00'], '18:00 is still ahead');

  gas.runTaskScheduler_(doc, at('2026-08-11', '18:05'));
  gas.runTaskScheduler_(doc, at('2026-08-12', '09:10'));
  assert.deepStrictEqual(reminderSlots(gas),
    ['2026-08-11 09:00', '2026-08-11 18:00', '2026-08-12 09:00']);
});

// ------------------------------------------------- the deadline-only reading

test('remindDaily=false keeps a dated one-time task on its deadline day only', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, {
    deadlineKey: DEADLINE, deadlineTime: '09:00',
    reminderTimes: ['09:00'], remindDaily: false
  });

  gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-13', '09:00'));
  assert.deepStrictEqual(reminderSlots(gas), [], 'nothing before the deadline');

  gas.runTaskScheduler_(doc, at(DEADLINE, '09:00'));
  assert.deepStrictEqual(reminderSlots(gas), [DEADLINE + ' 09:00'], 'the deadline day rings');

  gas.runTaskScheduler_(doc, at('2026-08-15', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-16', '09:00'));
  assert.deepStrictEqual(reminderSlots(gas), [DEADLINE + ' 09:00'], 'and nothing after it');
});

test("a routine's reminders stay on their own day even with remindDaily set", () => {
  const { gas, doc } = setup();
  // Every third day, so a rolling reading would be unmistakable: it would ring
  // on days the routine does not even have an occurrence for.
  makeTask(gas, doc, {
    type: 'routine', title: 'Kassa', startKey: '2026-08-11',
    recurrence: { freq: 'custom', intervalDays: 3 },
    reminderTimes: ['09:00'], remindDaily: true
  }, at('2026-08-11', '08:00'));

  for (const day of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
    gas.runTaskScheduler_(doc, at(day, '09:00'));
  }

  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-11 09:00', '2026-08-14 09:00'],
    'only the routine days themselves ring');
});

// ------------------------------------------------------------- stopping

test('completing a one-time task stops its daily reminders', () => {
  const { gas, doc } = setup();
  const task = makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
  });

  gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
  assert.strictEqual(reminderSlots(gas).length, 2);

  gas.completeTaskOccurrence_(doc, onlyOccurrence(gas, doc, task.id),
    { byName: 'Ali', source: 'telegram', nowMs: at('2026-08-12', '10:00') });

  // The deadline day and the days past it must stay silent.
  gas.runTaskScheduler_(doc, at('2026-08-13', '09:00'));
  gas.runTaskScheduler_(doc, at(DEADLINE, '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-15', '09:00'));
  assert.strictEqual(reminderSlots(gas).length, 2, 'nothing is reminded after completion');
});

test('a cancelled or skipped occurrence stops its daily reminders', () => {
  for (const endState of ['Cancelled', 'Skipped']) {
    const { gas, doc } = setup();
    const task = makeOnce(gas, doc, {
      deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
    });
    gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));

    const occ = onlyOccurrence(gas, doc, task.id);
    occ.status = gas['TASK_STATUS_' + endState.toUpperCase()];
    assert.strictEqual(occ.status, endState, 'the status constant resolved');
    gas.writeOccurrenceRow_(doc, occ);

    gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
    gas.runTaskScheduler_(doc, at('2026-08-13', '09:00'));
    assert.deepStrictEqual(reminderSlots(gas), ['2026-08-11 09:00'],
      endState + ' stops the daily reminder');
  }
});

// ---------------------------------------------------------- no duplicates

test('repeated scheduler passes never duplicate a day\'s reminder', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
  });

  // Five minutes apart, the way the real trigger runs, all day long.
  for (let minutes = 0; minutes <= 240; minutes += 5) {
    gas.runTaskScheduler_(doc, at('2026-08-11', '09:00') + minutes * 60000);
  }
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-11 09:00'],
    'forty-nine passes, one reminder');

  for (let minutes = 0; minutes <= 240; minutes += 5) {
    gas.runTaskScheduler_(doc, at('2026-08-12', '09:00') + minutes * 60000);
  }
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-11 09:00', '2026-08-12 09:00']);
});

// -------------------------------------------------------- the catch-up window

test('a daily reminder missed by more than the catch-up window is suppressed, not blasted', () => {
  const { gas, doc } = setup();
  const task = makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
  });

  // First pass of the day at 17:00 - the 09:00 slot is 8h stale (> 3h).
  gas.runTaskScheduler_(doc, at('2026-08-11', '17:00'));
  assert.deepStrictEqual(reminderSlots(gas), [], 'the stale slot is not sent');
  assert.ok(onlyOccurrence(gas, doc, task.id).remindersSent['2026-08-11 09:00'],
    'but it is recorded as handled, so a later pass cannot revive it');

  gas.runTaskScheduler_(doc, at('2026-08-11', '19:00'));
  assert.deepStrictEqual(reminderSlots(gas), [], 'still nothing later the same day');

  // The next day is a fresh slot and rings normally.
  gas.runTaskScheduler_(doc, at('2026-08-12', '10:30'));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-12 09:00'],
    'a 90-minute delay is inside the window');
});

// ------------------------------------------------------------ Asia/Tashkent

test('the Tashkent day, not the UTC day, decides which day a reminder belongs to', () => {
  const { gas, doc } = setup();
  makeOnce(gas, doc, { reminderTimes: ['02:00'], remindDaily: true });

  // 21:30 UTC on the 11th is already 02:30 on the 12th in Tashkent, so the
  // 02:00 slot that is due belongs to the 12th. Reading this in UTC would
  // both name the wrong day and think the reminder was 19.5 hours late.
  gas.runTaskScheduler_(doc, Date.UTC(2026, 7, 11, 21, 30));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-12 02:00']);

  // 18:00 UTC is 23:00 the same Tashkent day - the next 02:00 has not arrived.
  gas.runTaskScheduler_(doc, Date.UTC(2026, 7, 12, 18, 0));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-12 02:00'], 'no new slot yet');

  gas.runTaskScheduler_(doc, Date.UTC(2026, 7, 12, 21, 30));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-12 02:00', '2026-08-13 02:00']);
});

test('the deadline day resolves to one slot whichever way it is reached', () => {
  const { gas, doc } = setup();
  const task = makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
  });

  gas.runTaskScheduler_(doc, at(DEADLINE, '09:00'));
  // On the deadline day todayKey and dateKey are the same string, so the daily
  // path and the deadline path name the same slot and cannot double-send.
  const occ = onlyOccurrence(gas, doc, task.id);
  assert.strictEqual(occ.dateKey, DEADLINE);
  assert.deepStrictEqual(Object.keys(occ.remindersSent), [DEADLINE + ' 09:00']);
  assert.deepStrictEqual(reminderSlots(gas), [DEADLINE + ' 09:00']);
});

// ------------------------------------------------------- bounded bookkeeping

test('daily markers are pruned so Reminders_Sent_JSON cannot grow without bound', () => {
  const { gas, doc } = setup();
  const task = makeOnce(gas, doc, {
    reminderTimes: ['09:00', '18:00'], remindDaily: true
  });

  // Sixty days of an open task: 120 slots would accumulate unpruned.
  for (let day = 0; day < 60; day++) {
    const key = gas.taskDateKeyAddDays_(CREATED, day);
    gas.runTaskScheduler_(doc, at(key, '09:00'));
    gas.runTaskScheduler_(doc, at(key, '18:00'));
  }
  assert.strictEqual(reminderSlots(gas).length, 120, 'every day still rang');

  // Two slots a day across the retention window, inclusive of today: 30, not
  // the 120 an unpruned occurrence would carry.
  const lastDay = gas.taskDateKeyAddDays_(CREATED, 59);
  const kept = Object.keys(onlyOccurrence(gas, doc, task.id).remindersSent);
  assert.strictEqual(kept.length, 2 * (gas.TASK_REMINDER_HISTORY_DAYS + 1),
    'only the retention window is kept');
  const oldest = kept.map(slot => slot.split(' ')[0]).sort()[0];
  assert.strictEqual(oldest, gas.taskDateKeyAddDays_(lastDay, -gas.TASK_REMINDER_HISTORY_DAYS),
    'nothing older than the window survives');
});

test('pruning cannot resurrect a day that has already been reminded', () => {
  const { gas, doc } = setup();
  const task = makeOnce(gas, doc, { reminderTimes: ['09:00'], remindDaily: true });

  gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));
  for (let day = 1; day <= 30; day++) {
    gas.runTaskScheduler_(doc, at(gas.taskDateKeyAddDays_(CREATED, day), '09:00'));
  }
  const slots = reminderSlots(gas);
  assert.strictEqual(new Set(slots).size, slots.length, 'no slot appears twice');

  // Re-running the pruned days sends nothing: their instants are far outside
  // the catch-up window, so even an unmarked slot stays silent.
  const before = slots.length;
  gas.runTaskScheduler_(doc, at('2026-08-11', '09:00'));
  gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
  assert.strictEqual(reminderSlots(gas).length, before, 'no reminder is re-sent');
  assert.strictEqual(onlyOccurrence(gas, doc, task.id).status, 'Open');
});

// --------------------------------------------------- existing saved tasks

test('an occurrence saved before this change is read with the new meaning', () => {
  const { gas, doc } = setup();
  // Written the way the old code wrote it: a dated one-time occurrence whose
  // Remind_Daily was true but whose reminders only ever fired on the deadline.
  const task = makeOnce(gas, doc, {
    deadlineKey: DEADLINE, reminderTimes: ['09:00'], remindDaily: true
  });
  const occ = onlyOccurrence(gas, doc, task.id);
  assert.strictEqual(occ.remindDaily, true, 'the stored flag is unchanged');
  assert.deepStrictEqual(occ.remindersSent, {}, 'and it carries no history yet');

  gas.runTaskScheduler_(doc, at('2026-08-12', '09:00'));
  assert.deepStrictEqual(reminderSlots(gas), ['2026-08-12 09:00'],
    'the same stored row now rings daily, with no migration');
});
