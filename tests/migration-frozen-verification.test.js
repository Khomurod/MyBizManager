'use strict';

/**
 * Migration verification must check the values the dashboard will actually
 * read after cutover - the ones frozen onto each migrated row.
 *
 * Verification used to compare only row counts, periods and aggregate totals.
 * A frozen Amount_UZS could therefore be wrong while every total still added
 * up, and cutover would have been allowed. A frozen value is also never
 * re-derived from the current rate table: that would make verification agree
 * with whatever the table says today, which is the opposite of freezing it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const RATES = { '2026-08': { buy: 12050, sell: 11930 } };

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID'
];

/** Two USD rows and one UZS row, all in a single period. */
const LEGACY_ROWS = [
  ['t1_0', 'Tehnopark', '2026-08', 'Income', 100, 'USD', 'Naqd', '05/08/2026', 'a', '', 'r1'],
  ['t2_0', 'Apteka', '2026-08', 'Income', 200, 'USD', 'Bank', '06/08/2026', 'b', '', 'r2'],
  ['t3_0', 'UzsShop', '2026-08', 'Income', 5000000, 'UZS', 'Naqd', '07/08/2026', 'c', '', 'r3']
];

function boot() {
  return loadScript({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Migration_Fallback_Year', '2026']
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(LEGACY_ROWS.map(r => r.slice()))
    }
  });
}

/** Runs a real migration and returns the harness plus the V2 sheet. */
function migrated() {
  const gas = boot();
  const applied = gas.applyOmadMigration_(gas.__spreadsheet, { fallbackYear: 2026 });
  assert.strictEqual(applied.status, 'success', 'the fixture migrates cleanly');
  return { gas, sheet: gas.__spreadsheet.getSheetByName('Omad_Transactions_V2') };
}

/** Column index (1-based) of a ledger field. */
function col(gas, name) {
  return gas.LEDGER_HEADER.indexOf(name) + 1;
}

test('a clean migration verifies', () => {
  const { gas } = migrated();
  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  // Compared by content: the array comes from the VM realm, so identity
  // checks would reject it regardless of what it holds.
  assert.strictEqual(result.failures.join(' | '), '', 'a clean migration reports nothing');
  assert.strictEqual(result.ok, true);
});

// ------------------------------------------------- the frozen-value blind spot

test('a wrong frozen Amount_UZS fails even when counts and totals look right', () => {
  const { gas, sheet } = migrated();

  // Move value between two rows in the same period: the period total, the row
  // count, the balances and every recalculated figure stay exactly the same.
  const amountCol = col(gas, 'Amount_UZS');
  const before = sheet.getRange(2, amountCol).getValues()[0][0];
  const other = sheet.getRange(3, amountCol).getValues()[0][0];
  sheet.getRange(2, amountCol).setValue(before - 100000);
  sheet.getRange(3, amountCol).setValue(other + 100000);

  const result = gas.verifyOmadMigration_(gas.__spreadsheet);

  assert.strictEqual(result.ok, false, 'verification must refuse this');
  assert.strictEqual(result.sourceRows, result.targetRows, 'row counts still match');
  assert.ok(result.failures.some(f => /Amount_UZS noto'g'ri/.test(f)),
    'and it says which row and why: ' + JSON.stringify(result.failures));
});

test('a frozen value is judged against its own rate, not the current table', () => {
  const { gas, sheet } = migrated();

  // The operator edits the rate table long after the migration. Nothing about
  // the already-frozen rows changed, so verification must still pass.
  gas.setConfig(gas.__spreadsheet.getSheetByName('System_Config'), 'Omad_Rates',
    JSON.stringify({ '2026-08': { buy: 30000, sell: 29000 } }));

  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.ok(!result.failures.some(f => /Amount_UZS/.test(f)),
    'a rate change afterwards does not invalidate a frozen value');
});

test('a tampered exchange rate fails', () => {
  const { gas, sheet } = migrated();
  sheet.getRange(2, col(gas, 'Rate_Used')).setValue(9999);

  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => /Rate_Used|Amount_UZS/.test(f)));
});

// ------------------------------------------------------- per-field integrity

const FIELD_CASES = [
  ['Tenant', 'Tenant', 'Boshqa', /Tenant mos emas/],
  ['Type', 'Type', 'Expense', /Type mos emas/],
  ['Amount', 'Amount', 999, /Amount mos emas|Amount_UZS/],
  ['Currency', 'Currency', 'UZS', /Currency mos emas|Amount_UZS/],
  ['Method', 'Method', 'Bank', /Method mos emas/],
  ['Status', 'Status', 'Cancelled', /Status mos emas/],
  ['Request_ID', 'Request_ID', 'changed', /Request_ID mos emas/],
  ['Period', 'Period', '2026-07', /Period mos emas|Davr/]
];

FIELD_CASES.forEach(([label, column, value, pattern]) => {
  test(`a changed ${label} fails verification`, () => {
    const { gas, sheet } = migrated();
    sheet.getRange(2, col(gas, column)).setValue(value);

    const result = gas.verifyOmadMigration_(gas.__spreadsheet);
    assert.strictEqual(result.ok, false, `${label} was allowed through`);
    assert.ok(result.failures.some(f => pattern.test(f)),
      `${label}: ${JSON.stringify(result.failures)}`);
  });
});

// ------------------------------------------------------------ shape problems

test('a missing row fails', () => {
  const { gas, sheet } = migrated();
  sheet.deleteRow(2);
  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => /ko'chirilmagan|soni mos emas/.test(f)));
});

test('an extra row fails', () => {
  const { gas, sheet } = migrated();
  const copy = sheet.getRange(2, 1, 1, gas.LEDGER_HEADER.length).getValues()[0].slice();
  copy[0] = 'ghost_0';
  sheet.appendRow(copy);

  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => /Manbada yo'q|soni mos emas/.test(f)));
});

test('a duplicated id fails', () => {
  const { gas, sheet } = migrated();
  const copy = sheet.getRange(2, 1, 1, gas.LEDGER_HEADER.length).getValues()[0].slice();
  sheet.appendRow(copy);

  const result = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some(f => /Takrorlangan ID/.test(f)));
});

test('cutover is refused while verification fails', () => {
  const { gas, sheet } = migrated();
  sheet.getRange(2, col(gas, 'Amount_UZS')).setValue(1);

  const cutover = gas.cutoverOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(cutover.status, 'error', 'a failing verification blocks cutover');
  assert.strictEqual(
    gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions',
    'and the app stays on the legacy sheet');
});
