'use strict';

/**
 * Pure recurrence + Asia/Tashkent time coverage. These functions carry no
 * spreadsheet state, so they are exercised directly against the loaded bundle.
 *
 * Tashkent is a fixed UTC+5 (no DST), which is what makes every assertion here
 * independent of the machine's own timezone.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const gas = loadScript();

// ---------------------------------------------------------------- timezone

test('an instant maps to the correct Tashkent wall clock', () => {
  // 2026-08-10T04:00:00Z is 09:00 in Tashkent (UTC+5).
  const parts = gas.taskTzParts_(Date.UTC(2026, 7, 10, 4, 0, 0));
  assert.strictEqual(parts.dateKey, '2026-08-10');
  assert.strictEqual(parts.timeKey, '09:00');
  assert.strictEqual(parts.weekday, 1); // Monday
});

test('late-evening UTC rolls over to the next Tashkent day', () => {
  // 19:30Z + 5h = 00:30 the following calendar day in Tashkent.
  const parts = gas.taskTzParts_(Date.UTC(2026, 7, 10, 19, 30, 0));
  assert.strictEqual(parts.dateKey, '2026-08-11');
  assert.strictEqual(parts.timeKey, '00:30');
});

test('taskInstantMs_ is the inverse of taskTzParts_', () => {
  const ms = gas.taskInstantMs_('2026-08-10', '09:00');
  assert.strictEqual(ms, Date.UTC(2026, 7, 10, 4, 0, 0));
  const parts = gas.taskTzParts_(ms);
  assert.strictEqual(parts.dateKey, '2026-08-10');
  assert.strictEqual(parts.timeKey, '09:00');
});

test('date-key arithmetic crosses month and year ends', () => {
  assert.strictEqual(gas.taskDateKeyAddDays_('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(gas.taskDateKeyAddDays_('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(gas.taskDateKeyAddDays_('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(gas.taskDaysBetweenKeys_('2026-08-10', '2026-08-24'), 14);
  assert.strictEqual(gas.taskWeekdayOfKey_('2024-01-01'), 1); // a Monday
});

// -------------------------------------------------------------- recurrence

function occursIn(recurrence, start, end, from, to) {
  const r = gas.normalizeTaskRecurrence_(recurrence);
  // Array.from re-homes the sandbox array into this realm so deepStrictEqual's
  // prototype check passes (the values themselves are plain strings).
  return Array.from(gas.routineOccurrenceKeysInRange_(r, start, end, from, to));
}

test('daily recurrence hits every day; interval skips days', () => {
  assert.deepStrictEqual(
    occursIn({ freq: 'daily' }, '2026-08-10', '', '2026-08-10', '2026-08-13'),
    ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);

  assert.deepStrictEqual(
    occursIn({ freq: 'daily', interval: 3 }, '2026-08-10', '', '2026-08-10', '2026-08-20'),
    ['2026-08-10', '2026-08-13', '2026-08-16', '2026-08-19']);
});

test('weekly recurrence honours selected weekdays', () => {
  // Mon(1), Wed(3), Fri(5) starting on a Monday.
  const keys = occursIn({ freq: 'weekly', weekdays: [1, 3, 5] }, '2026-08-10', '', '2026-08-10', '2026-08-16');
  assert.deepStrictEqual(keys, ['2026-08-10', '2026-08-12', '2026-08-14']);
});

test('weekly interval of 2 skips the intervening week', () => {
  const keys = occursIn({ freq: 'weekly', weekdays: [1], interval: 2 }, '2026-08-10', '', '2026-08-10', '2026-09-07');
  // Mondays: 10 Aug (wk0), 24 Aug (wk2), 07 Sep (wk4) — not 17 or 31 Aug.
  assert.deepStrictEqual(keys, ['2026-08-10', '2026-08-24', '2026-09-07']);
});

test('monthly recurrence lands on a fixed day of month', () => {
  const keys = occursIn({ freq: 'monthly', monthDay: 15 }, '2026-08-15', '', '2026-08-01', '2026-10-31');
  assert.deepStrictEqual(keys, ['2026-08-15', '2026-09-15', '2026-10-15']);
});

test('monthly "last" clamps to each month length', () => {
  const keys = occursIn({ freq: 'monthly', monthDay: 'last' }, '2026-08-31', '', '2026-08-01', '2027-02-28');
  // Aug 31, Sep 30, Oct 31, Nov 30, Dec 31, Jan 31, Feb 28 (2027 not leap).
  assert.deepStrictEqual(keys,
    ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
});

test('custom interval counts whole days from the start', () => {
  const keys = occursIn({ freq: 'custom', intervalDays: 10 }, '2026-08-10', '', '2026-08-10', '2026-09-10');
  assert.deepStrictEqual(keys, ['2026-08-10', '2026-08-20', '2026-08-30', '2026-09-09']);
});

test('start and end bounds are respected', () => {
  const keys = occursIn({ freq: 'daily' }, '2026-08-12', '2026-08-14', '2026-08-10', '2026-08-20');
  assert.deepStrictEqual(keys, ['2026-08-12', '2026-08-13', '2026-08-14']);
});

// ---------------------------------------------------------------- duration

test('late duration formats without going negative', () => {
  assert.strictEqual(gas.formatTaskDuration_(0), '0m');
  assert.strictEqual(gas.formatTaskDuration_(-5000), '0m');
  assert.strictEqual(gas.formatTaskDuration_((2 * 60 + 14) * 60000), '2h 14m');
  assert.strictEqual(gas.formatTaskDuration_((26 * 60) * 60000), '1d 2h 0m');
});

// ------------------------------------------- a monthly day is chosen, not guessed
//
// `normalizeTaskRecurrence_` resolves an unusable `monthDay` to the 1st, and it
// does so on the read path as well as the write path — so the default cannot be
// tightened without rewriting what stored rows mean. The save path asks the
// different question instead: did the client actually choose?

test('a month day is a real choice or it is not one', () => {
  assert.strictEqual(gas.isTaskMonthDayChoice_('last'), true);
  assert.strictEqual(gas.isTaskMonthDayChoice_(15), true);
  assert.strictEqual(gas.isTaskMonthDayChoice_('15'), true);
  assert.strictEqual(gas.isTaskMonthDayChoice_(1), true);
  assert.strictEqual(gas.isTaskMonthDayChoice_(31), true);

  assert.strictEqual(gas.isTaskMonthDayChoice_(undefined), false, 'not asked');
  assert.strictEqual(gas.isTaskMonthDayChoice_(''), false, 'asked and left blank');
  assert.strictEqual(gas.isTaskMonthDayChoice_(null), false);
  assert.strictEqual(gas.isTaskMonthDayChoice_(0), false);
  assert.strictEqual(gas.isTaskMonthDayChoice_(32), false);
  assert.strictEqual(gas.isTaskMonthDayChoice_(-3), false);
  assert.strictEqual(gas.isTaskMonthDayChoice_(15.5), false);
  assert.strictEqual(gas.isTaskMonthDayChoice_('Last'), false, 'the sentinel is exact');
  assert.strictEqual(gas.isTaskMonthDayChoice_('oxirgi'), false);
});

test('the stored default is untouched, so existing rows keep their meaning', () => {
  // This is the read path, and it must keep answering 1 rather than refusing.
  assert.strictEqual(normalizeTaskRecurrence('monthly', {}).monthDay, 1);
  assert.strictEqual(normalizeTaskRecurrence('monthly', { monthDay: 'last' }).monthDay, 'last');
  assert.strictEqual(normalizeTaskRecurrence('monthly', { monthDay: 20 }).monthDay, 20);

  function normalizeTaskRecurrence(freq, extra) {
    return gas.normalizeTaskRecurrence_(Object.assign({ freq: freq }, extra));
  }
});

test('saving a monthly routine without a day is refused, not defaulted to the 1st', () => {
  const refused = gas.normalizeTaskInput_({
    type: 'routine', title: 'Oylik hisobot',
    recurrence: { freq: 'monthly', interval: 1 }
  }, null);
  assert.ok(refused.error, 'refused');
  assert.match(refused.error, /oy kunini/i);

  const blank = gas.normalizeTaskInput_({
    type: 'routine', title: 'Oylik hisobot',
    recurrence: { freq: 'monthly', interval: 1, monthDay: '' }
  }, null);
  assert.ok(blank.error, 'a blank choice is not a choice either');
});

test('a chosen monthly day and the last-day sentinel both save', () => {
  const day = gas.normalizeTaskInput_({
    type: 'routine', title: 'Oylik hisobot',
    recurrence: { freq: 'monthly', interval: 1, monthDay: 20 }
  }, null);
  assert.ok(!day.error, day.error);
  assert.strictEqual(day.task.recurrence.monthDay, 20);

  const last = gas.normalizeTaskInput_({
    type: 'routine', title: 'Oylik hisobot',
    recurrence: { freq: 'monthly', interval: 1, monthDay: 'last' }
  }, null);
  assert.ok(!last.error, last.error);
  assert.strictEqual(last.task.recurrence.monthDay, 'last');
});

test('an edit that never mentions the cadence keeps the stored month day', () => {
  const created = gas.normalizeTaskInput_({
    type: 'routine', title: 'Oylik hisobot',
    recurrence: { freq: 'monthly', interval: 1, monthDay: 20 }
  }, null);

  // Exactly what a client that only shows a title sends.
  const edited = gas.normalizeTaskInput_({ id: created.task.id, title: 'Yangi nom' }, created.task);
  assert.ok(!edited.error, edited.error);
  assert.strictEqual(edited.task.recurrence.freq, 'monthly');
  assert.strictEqual(edited.task.recurrence.monthDay, 20, 'the day survived an unrelated edit');
});

test('the other cadences are not affected by the monthly guard', () => {
  for (const recurrence of [
    { freq: 'daily', interval: 1 },
    { freq: 'weekly', interval: 2, weekdays: [1, 4] },
    { freq: 'custom', intervalDays: 10 }
  ]) {
    const built = gas.normalizeTaskInput_(
      { type: 'routine', title: 'X', recurrence: recurrence }, null);
    assert.ok(!built.error, recurrence.freq + ': ' + built.error);
  }
});

test('the /yangi wizard always names a month day, so the guard never blocks it', () => {
  // The wizard asks `vz_monthday` for every monthly task, and its draft carries
  // a day from the moment it exists. Asserting it here is what stops the guard
  // above and the wizard drifting apart: the wizard is the one client whose
  // payload nobody can see on a screen.
  const draft = gas.newWizardDraft_('routine');
  draft.title = 'Oylik hisobot';
  draft.recurrence.freq = 'monthly';

  const payload = gas.wizardTaskPayload_(draft, 49328655, 'req_1');
  assert.ok(gas.isTaskMonthDayChoice_(payload.recurrence.monthDay),
    'the draft names a day even before the operator picks one');

  const built = gas.normalizeTaskInput_(payload, null);
  assert.ok(!built.error, built.error);

  // And the day the operator actually picks reaches the engine.
  draft.recurrence.monthDay = 'last';
  const chosen = gas.normalizeTaskInput_(gas.wizardTaskPayload_(draft, 49328655, 'req_2'), null);
  assert.ok(!chosen.error, chosen.error);
  assert.strictEqual(chosen.task.recurrence.monthDay, 'last');
});
