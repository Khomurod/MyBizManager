'use strict';

/**
 * Monetary input formatting.
 *
 * Typing 12500000 reads as 12 500 000 while you type and stores as 12500000.
 * The pure helpers are exercised here; caret behaviour, paste and the mobile
 * keyboard are covered by tests/omad-money.e2e.js in a real browser.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { document: { getElementById: () => null }, setTimeout };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'omad', '02c-money-input.js'), 'utf8'),
  sandbox, { filename: '02c-money-input.js' });

const { formatMoneyString, parseMoneyInput, cleanMoneyString, formatMoneyValue } = sandbox;

// ------------------------------------------------------------------ grouping

test('digits are grouped in threes', () => {
  assert.strictEqual(formatMoneyString('15000'), '15 000');
  assert.strictEqual(formatMoneyString('1000000'), '1 000 000');
  assert.strictEqual(formatMoneyString('12500000'), '12 500 000');
});

test('short numbers are left alone', () => {
  assert.strictEqual(formatMoneyString('0'), '0');
  assert.strictEqual(formatMoneyString('7'), '7');
  assert.strictEqual(formatMoneyString('999'), '999');
  assert.strictEqual(formatMoneyString('1000'), '1 000');
});

test('an empty field stays empty', () => {
  for (const value of ['', null, undefined, '   ', 'abc']) {
    assert.strictEqual(formatMoneyString(value), '', String(value));
  }
});

test('reformatting an already formatted value is stable', () => {
  const once = formatMoneyString('12500000');
  assert.strictEqual(formatMoneyString(once), once);
  assert.strictEqual(formatMoneyString(formatMoneyString(once)), once);
});

// ------------------------------------------------------------------ decimals

test('decimals are kept and left ungrouped', () => {
  assert.strictEqual(formatMoneyString('1234.56'), '1 234.56');
  assert.strictEqual(formatMoneyString('1234567.5'), '1 234 567.5');
});

test('a comma is accepted as a decimal separator', () => {
  assert.strictEqual(formatMoneyString('1234,56'), '1 234.56');
  assert.strictEqual(parseMoneyInput('1234,56'), 1234.56);
});

test('the last separator is the decimal point; earlier ones group', () => {
  assert.strictEqual(cleanMoneyString('1.2.3'), '12.3');
  assert.strictEqual(parseMoneyInput('1.2.3'), 12.3);
});

test('comma-grouped thousands are not mistaken for decimals', () => {
  assert.strictEqual(parseMoneyInput('12,500,000'), 12500000);
  assert.strictEqual(parseMoneyInput('1,000'), 1000);
});

test('a trailing separator is preserved while typing', () => {
  assert.strictEqual(formatMoneyString('1500.'), '1 500.');
  assert.ok(Number.isNaN(parseMoneyInput('.')), 'a lone separator is not a number');
});

// -------------------------------------------------------------------- paste

test('a pasted amount with currency and commas is cleaned', () => {
  assert.strictEqual(formatMoneyString('USD 1,250.50'), '1 250.50');
  assert.strictEqual(parseMoneyInput('USD 1,250.50'), 1250.5);
});

test('a pasted amount that already has spaces is unchanged', () => {
  assert.strictEqual(formatMoneyString('12 500 000'), '12 500 000');
  assert.strictEqual(parseMoneyInput('12 500 000'), 12500000);
});

test('non-breaking spaces and stray symbols are stripped', () => {
  assert.strictEqual(parseMoneyInput('12 500 000 soʻm'), 12500000);
  assert.strictEqual(parseMoneyInput('-500'), 500, 'a minus sign is not a valid amount here');
});

// -------------------------------------------------------------------- values

test('parsing returns a clean number with no spaces', () => {
  assert.strictEqual(parseMoneyInput('12 500 000'), 12500000);
  assert.strictEqual(parseMoneyInput('15 000'), 15000);
  assert.strictEqual(Number.isInteger(parseMoneyInput('1 000 000')), true);
});

test('parsing an empty or non-numeric field is NaN, not zero', () => {
  for (const value of ['', '   ', 'abc', null, undefined]) {
    assert.ok(Number.isNaN(parseMoneyInput(value)), String(value));
  }
});

test('a stored number is formatted for display', () => {
  assert.strictEqual(formatMoneyValue(12500000), '12 500 000');
  assert.strictEqual(formatMoneyValue(500), '500');
  assert.strictEqual(formatMoneyValue(1250.5), '1 250.5');
  assert.strictEqual(formatMoneyValue(null), '');
  assert.strictEqual(formatMoneyValue(undefined), '');
  assert.strictEqual(formatMoneyValue(''), '');
  assert.strictEqual(formatMoneyValue('abc'), '');
  assert.strictEqual(formatMoneyValue(0), '0', 'a real zero is still shown');
});

test('a formatted value round-trips back to the same number', () => {
  for (const amount of [0, 7, 999, 1000, 15000, 1000000, 12500000, 1250.5, 99.99]) {
    assert.strictEqual(parseMoneyInput(formatMoneyValue(amount)), amount, String(amount));
  }
});

// --------------------------------------------------------- deletion behaviour

test('deleting digits reformats correctly', () => {
  // 12 500 000 -> the user deletes the last three digits.
  assert.strictEqual(formatMoneyString('12500'), '12 500');
  assert.strictEqual(formatMoneyString('12'), '12');
  assert.strictEqual(formatMoneyString(''), '');
});

test('deleting a separator does not delete the digit beside it', () => {
  // Removing the space from "12 500" leaves "12500", which regroups the same.
  assert.strictEqual(formatMoneyString('12500'), '12 500');
});
