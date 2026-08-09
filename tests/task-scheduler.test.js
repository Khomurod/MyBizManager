'use strict';

/**
 * What a scheduler pass costs, and what it will not let you do by accident.
 *
 * Invariants:
 *   * one pass reads the occurrence sheet once and appends everything it
 *     creates in one write. It used to cost a full scan per task, every five
 *     minutes, growing with the number of routines;
 *   * a row appended during a pass can still be updated later in the same
 *     pass - the batch writer hands back row numbers on the very objects the
 *     pass is holding;
 *   * work that has not come round yet cannot be completed, and skipping it
 *     takes an explicit confirmation.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent, readJsonOutput } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const ADMIN_KEY = 'test-admin-key';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: ADMIN_KEY
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

/** The date key the backend itself is using for "today". */
function serverToday(gas) {
  return gas.taskTodayKey_(Date.now());
}

function makeRoutines(gas, doc, count, startKey) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const result = gas.normalizeTaskInput_({
      type: 'routine', title: 'Kassa ' + i, startKey: startKey,
      recurrence: { freq: 'daily' }, dueTime: '20:00'
    }, null);
    gas.appendTaskRow_(doc, result.task);
    tasks.push(result.task);
  }
  return tasks;
}

/** Counts full getDataRange() scans of one sheet while `run` executes. */
function countScans(doc, sheetName, run) {
  const sheet = doc.getSheetByName(sheetName);
  const original = sheet.getDataRange;
  let scans = 0;
  sheet.getDataRange = function () { scans++; return original.call(sheet); };
  try { run(); } finally { sheet.getDataRange = original; }
  return scans;
}

/** Counts multi-row setValues writes on one sheet while `run` executes. */
function countMultiRowWrites(doc, sheetName, run) {
  const sheet = doc.getSheetByName(sheetName);
  const original = sheet.getRange;
  const writes = [];
  sheet.getRange = function (row, col, numRows, numCols) {
    const range = original.call(sheet, row, col, numRows, numCols);
    const setValues = range.setValues;
    range.setValues = function (values) {
      if (values.length > 1) writes.push(values.length);
      return setValues.call(range, values);
    };
    return range;
  };
  try { run(); } finally { sheet.getRange = original; }
  return writes;
}

// ------------------------------------------------------------------- cost

test('one scheduler pass reads the occurrence sheet once', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const tasks = makeRoutines(gas, doc, 5, today);
  tasks.forEach(t => gas.materializeTaskOccurrences_(doc, t, FIXED_NOW)); // steady state

  const scans = countScans(doc, 'Task_Occurrences', () => gas.runTaskScheduler_(doc, FIXED_NOW));

  // The baseline was 6 with five routines, and grew with every task added.
  assert.ok(scans <= 2, 'expected at most 2 full scans, saw ' + scans);
});

test('new occurrences are appended in one write', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  makeRoutines(gas, doc, 3, today);
  gas.taskOccurrencesSheet_(doc); // created lazily; the instrument needs it to exist

  const writes = countMultiRowWrites(doc, 'Task_Occurrences',
    () => gas.runTaskScheduler_(doc, FIXED_NOW));

  assert.strictEqual(writes.length, 1, 'a cold pass performs a single multi-row append');
  assert.strictEqual(writes[0], 45, '3 routines x 15 days, written at once');
});

test('a row appended in this pass can still be updated in the same pass', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const tasks = makeRoutines(gas, doc, 2, today);

  gas.runTaskScheduler_(doc, FIXED_NOW);

  // Today's rows were created and then announced within the one pass, so their
  // notifiedAt must have landed on their own rows.
  const rows = Array.from(gas.readOccurrenceRows_(doc));
  const todayRows = rows.filter(o => o.dateKey === today);
  assert.strictEqual(todayRows.length, 2);
  todayRows.forEach(o => assert.ok(o.notifiedAt, o.id + ' kept its notify flag'));

  const notified = rows.filter(o => o.notifiedAt).map(o => o.id).sort();
  assert.deepStrictEqual(notified, todayRows.map(o => o.id).sort(),
    'no other row was written over');
  assert.strictEqual(rows.length, tasks.length * 15);

  // Row numbers are unique and dense — nothing was written twice.
  const rowNumbers = rows.map(o => o.rowNumber);
  assert.strictEqual(new Set(rowNumbers).size, rowNumbers.length);
});

// ---------------------------------------------------------- future guards

test('completing a future occurrence is refused', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const [task] = makeRoutines(gas, doc, 1, today);
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const tomorrow = Array.from(gas.readOccurrenceRows_(doc))
    .find(o => o.dateKey === gas.taskDateKeyAddDays_(today, 1));

  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: tomorrow.id
  })));

  assert.strictEqual(body.status, 'error');
  assert.strictEqual(gas.findOccurrence_(doc, tomorrow.id).status, gas.TASK_STATUS_OPEN);
});

test('skipping a future occurrence needs confirmation', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const [task] = makeRoutines(gas, doc, 1, today);
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const tomorrowKey = gas.taskDateKeyAddDays_(today, 1);
  const tomorrow = Array.from(gas.readOccurrenceRows_(doc)).find(o => o.dateKey === tomorrowKey);

  const refused = readJsonOutput(gas.doPost(postEvent({
    action: 'skip_occurrence', adminKey: ADMIN_KEY, occurrenceId: tomorrow.id
  })));
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.needsFutureConfirm, true);
  assert.strictEqual(refused.dateKey, tomorrowKey);
  assert.strictEqual(gas.findOccurrence_(doc, tomorrow.id).status, gas.TASK_STATUS_OPEN);

  const confirmed = readJsonOutput(gas.doPost(postEvent({
    action: 'skip_occurrence', adminKey: ADMIN_KEY, occurrenceId: tomorrow.id, confirmFuture: true
  })));
  assert.strictEqual(confirmed.status, 'success');
  assert.strictEqual(gas.findOccurrence_(doc, tomorrow.id).status, gas.TASK_STATUS_SKIPPED);
});

test('today\'s occurrence can still be completed and skipped', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const tasks = makeRoutines(gas, doc, 2, today);
  tasks.forEach(t => gas.materializeTaskOccurrences_(doc, t, FIXED_NOW));

  const todayRows = Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.dateKey === today);

  const completed = readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: todayRows[0].id, completedBy: 'Ali'
  })));
  assert.strictEqual(completed.status, 'success');
  assert.strictEqual(gas.findOccurrence_(doc, todayRows[0].id).status, gas.TASK_STATUS_COMPLETED);

  const skipped = readJsonOutput(gas.doPost(postEvent({
    action: 'skip_occurrence', adminKey: ADMIN_KEY, occurrenceId: todayRows[1].id
  })));
  assert.strictEqual(skipped.status, 'success', 'today needs no confirmation');
  assert.strictEqual(gas.findOccurrence_(doc, todayRows[1].id).status, gas.TASK_STATUS_SKIPPED);
});
