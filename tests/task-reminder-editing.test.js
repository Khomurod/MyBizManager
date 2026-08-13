'use strict';

/**
 * Editing reminders without editing anything else.
 *
 * The Mini App and the /tasks board both build a `save_task` payload out of the
 * fields their form happens to show. That is safe only because of one rule in
 * `normalizeTaskInput_`: an *absent* field means "leave alone" and an
 * explicitly empty one means "clear". The tests here pin the rule from the
 * caller's side — an edit that mentions only the reminders has to leave the
 * cadence, the start date, the end date, the deadline, the photo rule and the
 * responsible exactly as they were.
 *
 * They also pin the two rules that decide when a reminder actually fires:
 *
 *   * a routine's reminders belong to the days it is scheduled for, and
 *     editing them must not turn it daily;
 *   * a one-time task with no deadline day has nowhere to hang a single
 *     reminder, so reminders on one can only mean "every day until it is done".
 *
 * Dates are built with the engine's own helpers or in fixed UTC+5, never from
 * the host clock — see the note in the App Brief about the harness's
 * `formatDate` mock.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';

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

/** Saves a payload through the same entry point both clients use. */
function save(gas, doc, payload) {
  const result = gas.saveTaskAction_(doc, payload);
  assert.strictEqual(result.status, 'success', result.message);
  return result;
}

function taskById(gas, doc, id) {
  return gas.findTask_(doc, id);
}

function occurrencesOf(gas, doc, taskId) {
  return Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.taskId === taskId);
}

// ------------------------------------------------------------- routine edits

/** A Monday/Thursday routine with two reminder times. */
function makeWeeklyRoutine(gas, doc) {
  const created = save(gas, doc, {
    type: 'routine',
    title: 'Do\'konni tekshirish',
    responsible: 'Aziz',
    photoRequired: true,
    recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 4] },
    startKey: '2026-08-03',
    endKey: '2026-12-31',
    dueTime: '18:00',
    reminderTimes: ['09:00'],
    priority: 'high'
  });
  return taskById(gas, doc, created.taskId);
}

test('editing only the reminders leaves a weekly routine weekly', () => {
  const { gas, doc } = setup();
  const before = makeWeeklyRoutine(gas, doc);

  // Exactly what the Mini App sheet sends: the fields it shows, and nothing
  // about the cadence.
  save(gas, doc, {
    id: before.id,
    title: before.title,
    description: '',
    priority: 'high',
    responsible: 'Aziz',
    reminderTimes: ['09:00', '18:30']
  });

  const after = taskById(gas, doc, before.id);
  assert.strictEqual(after.recurrence.freq, 'weekly', 'still weekly');
  assert.deepStrictEqual(Array.from(after.recurrence.weekdays), [1, 4], 'still Monday and Thursday');
  assert.strictEqual(after.recurrence.interval, 1);
  assert.strictEqual(after.startKey, '2026-08-03', 'the start date survives');
  assert.strictEqual(after.endKey, '2026-12-31', 'so does the end date');
  assert.strictEqual(after.dueTime, '18:00', 'and the due time');
  assert.strictEqual(after.photoRequired, true, 'and the proof requirement');
  assert.deepStrictEqual(Array.from(after.reminderTimes), ['09:00', '18:30'], 'the reminders changed');
});

test('a routine does not become daily just because its reminders were edited', () => {
  const { gas, doc } = setup();
  const before = makeWeeklyRoutine(gas, doc);

  save(gas, doc, { id: before.id, title: before.title, reminderTimes: ['07:15'] });

  const after = taskById(gas, doc, before.id);
  assert.strictEqual(after.remindDaily, false,
    'the task-level daily flag belongs to one-time tasks and stays off');
  // The engine's own answer: a routine occurrence is reminded on its own day.
  const occ = occurrencesOf(gas, doc, before.id)[0];
  assert.ok(occ, 'the routine materialised at least one day');
  assert.strictEqual(gas.taskRemindsDaily_(occ), false,
    'so its reminder does not roll forward on to unscheduled days');
});

test('an edited routine pushes its new reminder times on to future days only', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'routine', title: 'Har kuni', recurrence: { freq: 'daily', interval: 1 },
    startKey: '2026-08-01', reminderTimes: ['09:00']
  });
  const task = taskById(gas, doc, created.taskId);
  gas.materializeTaskOccurrences_(doc, task, Date.parse('2026-08-10T06:00:00+05:00'));

  // A day in the past, already announced, is history and must not be rewritten.
  const rows = occurrencesOf(gas, doc, task.id);
  const past = rows.find(o => o.dateKey === '2026-08-05');
  if (past) {
    past.notifiedAt = '2026-08-05T04:00:00.000Z';
    gas.writeOccurrenceRow_(doc, past);
  }

  save(gas, doc, { id: task.id, title: task.title, reminderTimes: ['20:00'] });

  const after = occurrencesOf(gas, doc, task.id);
  const todayKey = gas.taskTodayKey_(Date.now());
  after.forEach(occ => {
    if (!occ.dateKey || occ.dateKey < todayKey) return;
    if (occ.status !== 'Open') return;
    assert.deepStrictEqual(Array.from(occ.reminderTimes), ['20:00'],
      `${occ.dateKey} should carry the new time`);
  });
});

// ------------------------------------------------------- one-time task edits

test('editing the reminders of a dated task keeps its deadline', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'once', title: 'Hisobot', deadlineKey: '2026-09-15', deadlineTime: '17:00',
    photoRequired: true, reminderTimes: ['09:00'], remindDaily: false
  });

  save(gas, doc, {
    id: created.taskId, title: 'Hisobot', reminderTimes: ['09:00', '15:00'], remindDaily: true
  });

  const after = taskById(gas, doc, created.taskId);
  assert.strictEqual(after.deadlineKey, '2026-09-15');
  assert.strictEqual(after.deadlineTime, '17:00');
  assert.strictEqual(after.photoRequired, true);
  assert.deepStrictEqual(Array.from(after.reminderTimes), ['09:00', '15:00']);
  assert.strictEqual(after.remindDaily, true);

  // ...and the live occurrence is told, so the change is real rather than only
  // stored on the definition.
  const occ = occurrencesOf(gas, doc, created.taskId)[0];
  assert.deepStrictEqual(Array.from(occ.reminderTimes), ['09:00', '15:00']);
  assert.strictEqual(occ.remindDaily, true);
});

test('reminders on a task with no deadline are daily whatever the client sends', () => {
  const { gas, doc } = setup();
  // A client that sends `remindDaily: false` here is asking for reminders that
  // can never fire: there is no deadline day to hang them on.
  const created = save(gas, doc, {
    type: 'once', title: 'Muddatsiz', reminderTimes: ['09:00'], remindDaily: false
  });

  const task = taskById(gas, doc, created.taskId);
  assert.strictEqual(task.remindDaily, true, 'the engine decides, not the form');

  const occ = occurrencesOf(gas, doc, created.taskId)[0];
  assert.strictEqual(gas.taskRemindsDaily_(occ), true);
  assert.deepStrictEqual(
    Array.from(gas.taskReminderDatesFor_(occ, '2026-08-20')), ['2026-08-20'],
    'it is reminded about today, every day it stays open');
});

test('a deadline-less task with no reminders is not forced daily', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, { type: 'once', title: 'Eslatmasiz', reminderTimes: [] });
  assert.strictEqual(taskById(gas, doc, created.taskId).remindDaily, false);
});

test('clearing the reminder list actually clears it', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'once', title: 'Hisobot', deadlineKey: '2026-09-15', reminderTimes: ['09:00', '18:00']
  });

  // An empty array is the client saying "off". An absent field would mean
  // "leave alone", which is why the sheet always sends the list.
  save(gas, doc, { id: created.taskId, title: 'Hisobot', reminderTimes: [] });

  assert.deepStrictEqual(Array.from(taskById(gas, doc, created.taskId).reminderTimes), []);
  assert.deepStrictEqual(
    Array.from(occurrencesOf(gas, doc, created.taskId)[0].reminderTimes), []);
});

test('an edit that never mentions the reminders keeps them', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'once', title: 'Hisobot', deadlineKey: '2026-09-15', reminderTimes: ['09:00']
  });

  save(gas, doc, { id: created.taskId, title: 'Yangi sarlavha' });

  const after = taskById(gas, doc, created.taskId);
  assert.strictEqual(after.title, 'Yangi sarlavha');
  assert.deepStrictEqual(Array.from(after.reminderTimes), ['09:00']);
});

// --------------------------------------------------------- several times a day

test('several reminder times fire once each, on the right day, in Tashkent', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'once', title: 'Uch marta', deadlineKey: '2026-08-14',
    reminderTimes: ['09:00', '13:00', '18:00'], remindDaily: false
  });
  const task = taskById(gas, doc, created.taskId);
  gas.materializeTaskOccurrences_(doc, task, Date.parse('2026-08-11T06:00:00+05:00'));

  const at = (dateKey, timeKey) => Date.parse(dateKey + 'T' + timeKey + ':00+05:00');

  // Just before nine in Tashkent: nothing yet, whatever the host clock says.
  gas.runTaskScheduler_(doc, at('2026-08-14', '08:59'));
  assert.strictEqual(reminderJobs(gas, doc).length, 0);

  gas.runTaskScheduler_(doc, at('2026-08-14', '09:01'));
  assert.strictEqual(reminderJobs(gas, doc).length, 1, 'the nine o\'clock slot');

  // Running again inside the same slot must not send a second card.
  gas.runTaskScheduler_(doc, at('2026-08-14', '09:20'));
  assert.strictEqual(reminderJobs(gas, doc).length, 1, 'no duplicate for the same slot');

  gas.runTaskScheduler_(doc, at('2026-08-14', '13:05'));
  gas.runTaskScheduler_(doc, at('2026-08-14', '18:05'));
  const slots = reminderJobs(gas, doc).map(job => job.slot).sort();
  assert.deepStrictEqual(slots,
    ['2026-08-14 09:00', '2026-08-14 13:00', '2026-08-14 18:00'],
    'three slots, one card each');
});

test('a duplicated time in the payload cannot produce two cards', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'once', title: 'Ikki marta bir xil', deadlineKey: '2026-08-14',
    reminderTimes: ['09:00', '9:00', '09:00']
  });
  assert.deepStrictEqual(Array.from(taskById(gas, doc, created.taskId).reminderTimes), ['09:00']);
});

test('a paused routine sends no reminder, and resuming brings them back', () => {
  const { gas, doc } = setup();
  const created = save(gas, doc, {
    type: 'routine', title: 'Har kuni', recurrence: { freq: 'daily', interval: 1 },
    startKey: '2026-08-01', reminderTimes: ['09:00']
  });
  const task = taskById(gas, doc, created.taskId);
  gas.materializeTaskOccurrences_(doc, task, Date.parse('2026-08-13T06:00:00+05:00'));

  assert.strictEqual(gas.setRoutinePausedAction_(doc, { id: task.id }, true).status, 'success');
  gas.runTaskScheduler_(doc, Date.parse('2026-08-14T09:05:00+05:00'));
  assert.strictEqual(reminderJobs(gas, doc).length, 0, 'a paused routine goes quiet');

  assert.strictEqual(gas.setRoutinePausedAction_(doc, { id: task.id }, false).status, 'success');
  gas.runTaskScheduler_(doc, Date.parse('2026-08-14T09:06:00+05:00'));
  assert.ok(reminderJobs(gas, doc).length > 0, 'resuming brings them back');
});

/** Every queued task_reminder job, with its slot. */
function reminderJobs(gas, doc) {
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = Array.from(data[0]).map(String);
  const typeAt = header.indexOf('Type');
  const payloadAt = header.indexOf('Payload_JSON');
  const jobs = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][typeAt]) !== 'task_reminder') continue;
    let payload = {};
    try { payload = JSON.parse(String(data[i][payloadAt] || '{}')); } catch (error) { payload = {}; }
    jobs.push({ slot: String(payload.slot || '') });
  }
  return jobs;
}
