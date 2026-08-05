'use strict';

/**
 * The canonical year-month period model.
 *
 * Month-only values ("Dekabr") cannot distinguish December 2026 from December
 * 2027 and sort alphabetically. These tests pin the replacement, including the
 * cases that make blind "just pick a year" migrations dangerous.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const gas = loadScript();

/**
 * Values built inside the script sandbox belong to another realm, so
 * deepStrictEqual would reject them on prototype identity alone. Round-tripping
 * through JSON gives a host-realm value with the same shape.
 */
const plain = value => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

// ------------------------------------------------------------------ basics

test('canonical periods are recognised and malformed ones are not', () => {
  for (const good of ['2026-01', '2026-12', '2027-01', '1999-06']) {
    assert.strictEqual(gas.isCanonicalPeriod_(good), true, good);
  }
  for (const bad of ['2026-00', '2026-13', '2026-1', '26-01', 'Yanvar', '', null, '2026/01']) {
    assert.strictEqual(gas.isCanonicalPeriod_(bad), false, String(bad));
  }
});

test('periods are built, split and labelled in Uzbek', () => {
  assert.strictEqual(gas.buildPeriod_(2026, 1), '2026-01');
  assert.strictEqual(gas.buildPeriod_(2026, 12), '2026-12');
  assert.strictEqual(gas.buildPeriod_(2026, 13), '');
  assert.strictEqual(gas.periodYear_('2026-03'), 2026);
  assert.strictEqual(gas.periodMonth_('2026-03'), 3);
  assert.strictEqual(gas.formatPeriodLabel_('2026-01'), 'Yanvar 2026');
  assert.strictEqual(gas.formatPeriodLabel_('2027-12'), 'Dekabr 2027');
  assert.strictEqual(gas.formatPeriodLabel_('Jami Davr'), 'Jami Davr');
});

test('periods sort chronologically as plain strings', () => {
  const shuffled = ['2027-01', '2026-02', '2026-12', '2026-01'];
  assert.deepStrictEqual(
    shuffled.slice().sort(gas.comparePeriods_),
    ['2026-01', '2026-02', '2026-12', '2027-01']
  );
});

test('adding months crosses year boundaries in both directions', () => {
  assert.strictEqual(gas.addMonthsToPeriod_('2026-12', 1), '2027-01');
  assert.strictEqual(gas.addMonthsToPeriod_('2027-01', -1), '2026-12');
  assert.strictEqual(gas.addMonthsToPeriod_('2026-01', -1), '2025-12');
  assert.strictEqual(gas.addMonthsToPeriod_('2026-01', 12), '2027-01');
  assert.strictEqual(gas.addMonthsToPeriod_('2026-06', 18), '2027-12');
});

test('the same month in two different years is two different periods', () => {
  assert.notStrictEqual(gas.buildPeriod_(2026, 1), gas.buildPeriod_(2027, 1));
  assert.strictEqual(gas.comparePeriods_('2026-01', '2027-01'), -1);
});

// --------------------------------------------------------------- date parsing

// The day is carried alongside the year and month so a date can be rewritten
// into the sheet as a real date without losing which day it was.
test('dd/MM/yyyy dates are parsed', () => {
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('05/02/2026')), { year: 2026, month: 2, day: 5 });
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('31/12/2026')), { year: 2026, month: 12, day: 31 });
});

test('ISO dates are parsed', () => {
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('2026-07-15')), { year: 2026, month: 7, day: 15 });
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('2026-07-15T09:30:00.000Z')), { year: 2026, month: 7, day: 15 });
});

test('real Date values from Sheets are parsed', () => {
  assert.deepStrictEqual(plain(gas.parseTransactionDate_(new Date(2026, 4, 20))), { year: 2026, month: 5, day: 20 });
});

test('leap-day handling distinguishes valid from invalid February dates', () => {
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('29/02/2024')), { year: 2024, month: 2, day: 29 });
  assert.strictEqual(gas.parseTransactionDate_('29/02/2026'), null, '2026 is not a leap year');
  assert.deepStrictEqual(plain(gas.parseTransactionDate_('2024-02-29')), { year: 2024, month: 2, day: 29 });
  assert.strictEqual(gas.parseTransactionDate_('2100-02-29'), null, '2100 is not a leap year');
});

test('invalid and ambiguous dates are rejected rather than guessed', () => {
  for (const bad of ['', null, undefined, 'noma\'lum', '32/01/2026', '05/13/2026',
                     '05/02/26', '2026-13-01', '2026-04-31']) {
    assert.strictEqual(gas.parseTransactionDate_(bad), null, String(bad));
  }
});

// --------------------------------------------------------- period resolution

function resolve(month, date, fallbackYear) {
  return gas.resolveTransactionPeriod_({ month, date }, fallbackYear);
}

test('an already-canonical month is used as-is', () => {
  const result = resolve('2026-05', '01/05/2026', 2020);
  assert.strictEqual(result.period, '2026-05');
  assert.strictEqual(result.source, 'canonical');
  assert.strictEqual(result.confident, true);
});

test('the year comes from the date when the month agrees', () => {
  const result = resolve('Fevral', '05/02/2027', 2020);
  assert.strictEqual(result.period, '2027-02');
  assert.strictEqual(result.source, 'date');
  assert.strictEqual(result.confident, true);
});

test('a December row entered in early January keeps December of the previous year', () => {
  const result = resolve('Dekabr', '03/01/2027');
  assert.strictEqual(result.period, '2026-12');
  assert.strictEqual(result.source, 'date_boundary');
  assert.strictEqual(result.confident, true);
});

test('a January row entered in late December keeps January of the next year', () => {
  const result = resolve('Yanvar', '30/12/2026');
  assert.strictEqual(result.period, '2027-01');
  assert.strictEqual(result.source, 'date_boundary');
});

test('any other month/date disagreement is flagged, not silently reassigned', () => {
  const result = resolve('Mart', '05/09/2026', 2026);
  assert.strictEqual(result.source, 'conflict');
  assert.strictEqual(result.confident, false);
  assert.match(result.detail, /disagrees/);
});

test('a date alone determines the period', () => {
  const result = resolve('', '17/08/2026');
  assert.strictEqual(result.period, '2026-08');
  assert.strictEqual(result.source, 'date_only');
});

test('a month name with an unusable date falls back to the configured year', () => {
  const result = resolve('Iyul', 'noma\'lum', 2026);
  assert.strictEqual(result.period, '2026-07');
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.confident, false, 'a fallback is never confident');
});

test('a month name with no date and no configured year stays unresolved', () => {
  const result = resolve('Iyul', '', 0);
  assert.strictEqual(result.period, '');
  assert.strictEqual(result.source, 'needs_fallback_year');
});

test('a row with neither month nor date is unresolved', () => {
  const result = resolve('', '', 2026);
  assert.strictEqual(result.period, '');
  assert.strictEqual(result.source, 'unresolved');
});

test('month names are matched case-insensitively and in short form', () => {
  assert.strictEqual(gas.parseUzbekMonth_('yanvar'), 1);
  assert.strictEqual(gas.parseUzbekMonth_('DEKABR'), 12);
  assert.strictEqual(gas.parseUzbekMonth_('Sen'), 9);
  assert.strictEqual(gas.parseUzbekMonth_('7'), 7);
  assert.strictEqual(gas.parseUzbekMonth_('13'), 0);
  assert.strictEqual(gas.parseUzbekMonth_('Sentabr oyi'), 0);
});

// ------------------------------------------------------------- rate lookup

test('rates are found by canonical period and by the legacy month key', () => {
  const rates = { '2026-02': { buy: 12000, sell: 12500 }, Mart: { buy: 12100, sell: 12600 } };
  assert.strictEqual(gas.getPeriodRateByType_(rates, '2026-02', 'buy'), 12000);
  assert.strictEqual(gas.getPeriodRateByType_(rates, '2026-03', 'sell'), 12600,
    'a legacy month-name key still resolves');
  assert.strictEqual(gas.getPeriodRateByType_(rates, '2027-03', 'sell'), 12600,
    'legacy keys are year-agnostic by nature');
});

test('a canonical key wins over the legacy key for the same month', () => {
  const rates = { Mart: { buy: 1, sell: 1 }, '2026-03': { buy: 9, sell: 9 } };
  assert.strictEqual(gas.getPeriodRateByType_(rates, '2026-03', 'sell'), 9);
});

test('a period with no rate at all reports as missing rather than defaulting silently', () => {
  assert.strictEqual(gas.findRateEntry_({}, '2026-04'), null);
  assert.strictEqual(gas.getPeriodRateByType_({}, '2026-04', 'sell'), gas.DEFAULT_RATE_UZS);
});

test('legacy rate keys migrate to canonical ones under the fallback year', () => {
  const result = gas.migrateRatesMap_(
    { Yanvar: 12000, '2026-02': { buy: 12100, sell: 12600 }, Kuz: 1 }, 2026);
  assert.deepStrictEqual(plain(result.rates['2026-01']), { buy: 12000, sell: 12000 });
  assert.deepStrictEqual(plain(result.rates['2026-02']), { buy: 12100, sell: 12600 });
  assert.deepStrictEqual(plain(result.unresolved), ['Kuz']);
});

// ------------------------------------------------------------- conversion

test('USD converts at the period rate and UZS is untouched', () => {
  const rates = { '2026-02': { buy: 12000, sell: 12500 } };
  assert.strictEqual(gas.toUZS_(100, 'USD', '2026-02', rates, 'sell'), 1250000);
  assert.strictEqual(gas.toUZS_(100, 'USD', '2026-02', rates, 'buy'), 1200000);
  assert.strictEqual(gas.toUZS_(5000, 'UZS', '2026-02', rates, 'sell'), 5000);
});

test('two Januaries in different years convert at their own rates', () => {
  const rates = { '2026-01': { buy: 12000, sell: 12500 }, '2027-01': { buy: 13000, sell: 13500 } };
  assert.strictEqual(gas.toUZS_(100, 'USD', '2026-01', rates, 'sell'), 1250000);
  assert.strictEqual(gas.toUZS_(100, 'USD', '2027-01', rates, 'sell'), 1350000);
});

test('balances are computed per period, not per month name', () => {
  const gasWithRates = loadScript({
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({
        '2026-01': { buy: 12000, sell: 12500 },
        '2027-01': { buy: 13000, sell: 13500 }
      })]]
    }
  });

  const transactions = [
    { period: '2026-01', type: 'Income', amount: 1000000, currency: 'UZS' },
    { period: '2027-01', type: 'Income', amount: 2000000, currency: 'UZS' },
    { period: '2027-01', type: 'Expense', amount: 500000, currency: 'UZS' }
  ];

  const jan2026 = gasWithRates.calculateBalancesFromTransactions_(transactions, '2026-01');
  assert.strictEqual(jan2026.monthBalance, 1000000);
  assert.strictEqual(jan2026.allTimeBalance, 2500000);

  const jan2027 = gasWithRates.calculateBalancesFromTransactions_(transactions, '2027-01');
  assert.strictEqual(jan2027.monthBalance, 1500000);
});
