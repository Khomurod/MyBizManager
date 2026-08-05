'use strict';

/**
 * Regression cover for the live "wrong month" failure.
 *
 * The spreadsheet reads typed text with a MM/DD/YYYY locale. The app writes
 * dates as DD/MM/YYYY and the accounting period as "YYYY-MM", so Sheets
 * silently rewrote both:
 *
 *   "05/08/2026" (5 August) -> stored as 8 May
 *   "2026-08"               -> stored as a real date (1 August)
 *
 * With the period gone from the Month column and the date shifted, a
 * transaction entered on 5 August was reported to the group as May 2026 while
 * the user's own confirmation - built in memory, before the write - correctly
 * said August.
 *
 * These tests run against a spreadsheet that reproduces that coercion.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const GROUP_ID = '-1001234567890';

function coercingSheet(rows) {
  return loadScript({
    coerceLikeSheets: true,
    properties: {
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: GROUP_ID
    },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({ Avgust: { buy: 12050, sell: 11930 } })]],
      Omad_Transactions: rows || [[
        'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date',
        'Comment', 'Telegram_Msg_ID', 'Request_ID'
      ]]
    }
  });
}

function storedRow(gas, index = 1) {
  return gas.__spreadsheet.getSheetByName('Omad_Transactions').getDataRange().getValues()[index];
}

// ------------------------------------------------- the exact live failure

test('an August entry is still August after the spreadsheet round-trip', () => {
  const gas = coercingSheet();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: '1785879979972_0',
    tenant: 'Umumiy Naqd Puldan',
    month: '2026-08',
    type: 'Expense',
    amount: 13055000,
    currency: 'UZS',
    method: 'Naqd',
    date: '05/08/2026',
    comment: 'Mashina krediti'
  });

  const read = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.strictEqual(read.length, 1);
  assert.strictEqual(read[0].period, '2026-08', 'the entry must not drift into another month');
  assert.strictEqual(read[0].periodLabel, 'Avgust 2026');
});

test('the date column keeps the day and month the app meant', () => {
  const gas = coercingSheet();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: 'd1_0', tenant: 'Tehnopark', month: '2026-08', type: 'Income',
    amount: 1000, currency: 'UZS', method: 'Naqd', date: '05/08/2026', comment: ''
  });

  const stored = storedRow(gas)[7];
  assert.ok(stored instanceof Date, 'a real date cannot be re-read in the wrong order');
  assert.strictEqual(stored.getFullYear(), 2026);
  assert.strictEqual(stored.getMonth() + 1, 8, 'August, not May');
  assert.strictEqual(stored.getDate(), 5);
});

test('the month column survives as a period rather than becoming a date', () => {
  const gas = coercingSheet();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: 'm1_0', tenant: 'Tehnopark', month: '2026-08', type: 'Income',
    amount: 1000, currency: 'UZS', method: 'Naqd', date: '05/08/2026', comment: ''
  });

  assert.strictEqual(storedRow(gas)[2], '2026-08');
});

// --------------------------------------------- healing what is already there

test('a month cell that was already turned into a date still resolves', () => {
  // Exactly the row the live sheet is holding right now.
  const gas = coercingSheet([
    ['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date',
      'Comment', 'Telegram_Msg_ID', 'Request_ID'],
    ['1785879979972_0', 'Umumiy Naqd Puldan', new Date(2026, 7, 1), 'Expense', 13055000,
      'UZS', 'Naqd', new Date(2026, 4, 8), 'Mashina krediti', 456, 'tg_1_1']
  ]);

  const read = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.strictEqual(read[0].period, '2026-08');
  assert.strictEqual(read[0].periodLabel, 'Avgust 2026');
});

test('a rewrite does not corrupt a period that came back as a date', () => {
  const gas = coercingSheet([
    ['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date',
      'Comment', 'Telegram_Msg_ID', 'Request_ID'],
    ['a_0', 'Tehnopark', new Date(2026, 7, 1), 'Income', 500, 'UZS', 'Naqd',
      new Date(2026, 7, 5), 'x', '', '']
  ]);

  const normalized = gas.normalizeTransaction_(gas.readOmadTransactions_(gas.__spreadsheet)[0]);
  assert.strictEqual(normalized.month, '2026-08', 'a date must never be stringified into the month');
});

// ----------------------------------------------------------- no regressions

test('legacy month names with an unambiguous date are untouched', () => {
  const gas = coercingSheet([
    ['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date',
      'Comment', 'Telegram_Msg_ID', 'Request_ID'],
    ['old_0', 'Tehnopark', 'Avgust', 'Income', 900, 'UZS', 'Naqd', '25/08/2026', 'y', '', '']
  ]);

  const read = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.strictEqual(read[0].period, '2026-08');
});

// ------------------------------------- the same trap in the migrated ledger

test('the ledger period is written as text, not collapsed into a date', () => {
  const gas = coercingSheet();
  const sheet = gas.ledgerSheet_(gas.__spreadsheet);

  const row = new Array(gas.LEDGER_HEADER.length).fill('');
  row[0] = 'led_1';
  row[2] = '2026-08-05T10:00:00.000Z';
  row[6] = '2026-08';
  gas.appendLedgerRow_(sheet, row);

  const written = sheet.getDataRange().getValues()[1];
  assert.strictEqual(written[6], '2026-08', 'the period must stay a period');
  assert.strictEqual(written[2], '2026-08-05T10:00:00.000Z', 'the timestamp must stay text');
});

test('a ledger period already stored as a date is still read correctly', () => {
  const gas = coercingSheet();
  const row = new Array(gas.LEDGER_HEADER.length).fill('');
  row[0] = 'led_2';
  row[6] = new Date(2026, 7, 1);

  assert.strictEqual(gas.ledgerRowToTransaction_(row, 2).period, '2026-08');
});

// --------------------------------------------- the group report month total

test("the group report quotes a real month balance, not zero", () => {
  const gas = coercingSheet();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: 'r1_0', tenant: 'Tehnopark', month: '2026-08', type: 'Income',
    amount: 5000000, currency: 'UZS', method: 'Naqd', date: '05/08/2026', comment: 'Ijara'
  });

  gas.runOmadTransactionReportJob_(gas.__spreadsheet, { payload: { baseId: 'r1', messageId: '' } });

  const groupMessage = gas.__sentMessages.filter(m => String(m.chat_id) === GROUP_ID).pop();
  assert.ok(groupMessage, 'a report was sent');
  assert.ok(groupMessage.text.includes('Avgust 2026'), 'the report names the right month');
  assert.ok(
    !/qoldig'i: 0 UZS/.test(groupMessage.text),
    "the month balance must be the real figure, not 0"
  );
});
