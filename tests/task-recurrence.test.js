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
