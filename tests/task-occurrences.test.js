'use strict';

/**
 * Occurrence materialisation, the Today view and routine statistics.
 *
 * Time is injected (FIXED_NOW) so every "today", "overdue" and "upcoming"
 * assertion is deterministic regardless of when the suite runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent
const TODAY = '2026-08-10';

function fresh() {
  const gas = loadScript();
  return { gas, doc: gas.__spreadsheet };
}

function makeTask(gas, payload) {
  const result = gas.normalizeTaskInput_(payload, null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);
  return result.task;
}

function occurrences(gas, taskId) {
  const all = gas.readOccurrenceRows_(gas.__spreadsheet);
  const out = [];
  for (let i = 0; i < all.length; i++) if (!taskId || all[i].taskId === taskId) out.push(all[i]);
  return out;
}

// --------------------------------------------------------------- one-time

test('a one-time task with a deadline gets one occurrence with a due instant', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'once', title: 'Hujjat topshirish', deadlineKey: '2026-08-12', deadlineTime: '17:00'
  });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const occ = occurrences(gas, task.id);
  assert.strictEqual(occ.length, 1);
  assert.strictEqual(occ[0].dateKey, '2026-08-12');
  assert.strictEqual(occ[0].dueAt, gas.taskInstantMs_('2026-08-12', '17:00'));
});

test('a one-time task without a deadline is supported and has no due instant', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, { type: 'once', title: 'Ofisni yig\'ishtirish' });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const occ = occurrences(gas, task.id);
  assert.strictEqual(occ.length, 1);
  assert.strictEqual(occ[0].dueAt, '');
  assert.strictEqual(occ[0].dateKey, '');
});

// ---------------------------------------------------------------- routine

test('a daily routine materialises today plus the horizon, and never duplicates', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Kassani hisoblash', startKey: TODAY,
    recurrence: { freq: 'daily' }, dueTime: '20:00'
  });

  const first = gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  assert.ok(first.length >= 2, 'today and upcoming days are created');

  const before = occurrences(gas, task.id).length;
  const again = gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  assert.strictEqual(again.length, 0, 're-running creates nothing new');
  assert.strictEqual(occurrences(gas, task.id).length, before, 'no duplicates');

  const todays = occurrences(gas, task.id).filter(o => o.dateKey === TODAY);
  assert.strictEqual(todays.length, 1);
  assert.strictEqual(todays[0].dueAt, gas.taskInstantMs_(TODAY, '20:00'));
});

test('a paused routine materialises nothing', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Paused', startKey: TODAY, recurrence: { freq: 'daily' }
  });
  task.status = gas.TASK_DEF_PAUSED;
  const created = gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  assert.strictEqual(created.length, 0);
});

test('a skipped occurrence is not regenerated', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Skippable', startKey: TODAY, recurrence: { freq: 'daily' }
  });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const today = occurrences(gas, task.id).find(o => o.dateKey === TODAY);
  today.status = gas.TASK_STATUS_SKIPPED;
  gas.writeOccurrenceRow_(doc, today);

  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  const todays = occurrences(gas, task.id).filter(o => o.dateKey === TODAY);
  assert.strictEqual(todays.length, 1, 'the skipped day keeps its single row');
  assert.strictEqual(todays[0].status, gas.TASK_STATUS_SKIPPED);
});

// ------------------------------------------------------------------- goal

test('a goal creates one occurrence per step and reports progress', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'goal', title: 'Yangi filial ochish',
    steps: [{ title: 'Joy topish' }, { title: 'Ta\'mirlash' }, { title: 'Ishga tushirish' }]
  });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  const occ = occurrences(gas, task.id);
  assert.strictEqual(occ.length, 3);

  // Complete one step; progress should be 33%.
  const first = gas.findOccurrence_(doc, occ[0].id);
  gas.completeTaskOccurrence_(doc, first, { byName: 'Admin', source: 'web', nowMs: FIXED_NOW });

  const view = gas.buildTaskViews_(doc, FIXED_NOW);
  const goal = view.tasks.find(t => t.id === task.id);
  assert.strictEqual(goal.progress.total, 3);
  assert.strictEqual(goal.progress.done, 1);
  assert.strictEqual(goal.progress.percent, 33);
});

test('completing the final step completes the goal', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, { type: 'goal', title: 'Two step', steps: [{ title: 'A' }, { title: 'B' }] });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);

  occurrences(gas, task.id).forEach(o => {
    const live = gas.findOccurrence_(doc, o.id);
    gas.completeTaskOccurrence_(doc, live, { byName: 'Admin', source: 'web', nowMs: FIXED_NOW });
  });

  const goal = gas.findTask_(doc, task.id);
  assert.strictEqual(goal.status, gas.TASK_DEF_COMPLETED);
});

// --------------------------------------------------------------- the view

test('the Today view separates overdue, due-today, upcoming and completed', () => {
  const { gas, doc } = fresh();
  // Due at 08:00 today, now is 09:00 -> overdue.
  const overdueTask = makeTask(gas, {
    type: 'routine', title: 'Overdue', startKey: TODAY, recurrence: { freq: 'daily' }, dueTime: '08:00'
  });
  gas.materializeTaskOccurrences_(doc, overdueTask, FIXED_NOW);

  // Due at 20:00 today -> due today, not yet overdue.
  const dueTodayTask = makeTask(gas, {
    type: 'routine', title: 'Later today', startKey: TODAY, recurrence: { freq: 'daily' }, dueTime: '20:00'
  });
  gas.materializeTaskOccurrences_(doc, dueTodayTask, FIXED_NOW);

  const view = gas.buildTaskViews_(doc, FIXED_NOW);
  assert.ok(view.counts.overdue >= 1, 'the 08:00 routine is overdue');
  assert.ok(view.counts.dueToday >= 1, 'the 20:00 routine is due today');
  assert.ok(view.counts.upcoming >= 1, 'the horizon occurrences are upcoming');

  // Complete the overdue one and it should move to completedToday, marked late.
  const overdueOcc = gas.findOccurrence_(doc,
    occurrences(gas, overdueTask.id).find(o => o.dateKey === TODAY).id);
  gas.completeTaskOccurrence_(doc, overdueOcc, { byName: 'Xodim', source: 'telegram', nowMs: FIXED_NOW });

  const after = gas.buildTaskViews_(doc, FIXED_NOW);
  const completed = after.today.completedToday.find(o => o.taskId === overdueTask.id);
  assert.ok(completed, 'the completed occurrence shows in completedToday');
  assert.strictEqual(completed.onTime, false);
  assert.strictEqual(completed.lateLabel, '1h 0m'); // 09:00 - 08:00
});

// ------------------------------------------------------------------ stats

test('routine streak and completion rate reflect history', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Streaky', startKey: '2026-08-01', recurrence: { freq: 'daily' }, dueTime: '20:00'
  });

  // Hand-build history: 07,08,09 completed; 06 missed (still Open in the past).
  [['2026-08-06', gas.TASK_STATUS_OPEN],
   ['2026-08-07', gas.TASK_STATUS_COMPLETED],
   ['2026-08-08', gas.TASK_STATUS_COMPLETED],
   ['2026-08-09', gas.TASK_STATUS_COMPLETED]].forEach(([key, status]) => {
    const occ = gas.buildOccurrenceForRoutine_(task, key);
    occ.status = status;
    gas.appendOccurrenceRow_(doc, occ);
  });

  const view = gas.buildTaskViews_(doc, FIXED_NOW);
  const summary = view.tasks.find(t => t.id === task.id);
  assert.strictEqual(summary.stats.streak, 3, 'the three most recent days are a streak');
  assert.strictEqual(summary.stats.completed, 3);
  assert.strictEqual(summary.stats.completionRate, 75); // 3 of 4 counted
});
