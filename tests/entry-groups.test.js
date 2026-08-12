'use strict';

/**
 * Entry_Group_ID — the immutable identifier that says which accounting rows are
 * one business action.
 *
 * The rules being pinned here:
 *   - every row keeps its own transaction id;
 *   - the rows of one action share one *stored* group id;
 *   - grouping is never deduced from a timestamp or an id prefix, except by
 *     the deterministic backfill that exists only for rows written before the
 *     column did;
 *   - a retry lands in the same group rather than opening a second one.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'group-admin-key';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID'
];

/** A legacy sheet whose rows predate Entry_Group_ID: 11 columns, no group. */
function bootLegacy(rows = []) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_AUTHORIZED_USER_ID: '49328655'
    },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({ '2026-02': { buy: 12000, sell: 12500 } })]],
      Omad_Transactions: [LEGACY_HEADER.slice(0, 11), ...rows]
    }
  });
}

function legacyRow(id, overrides = {}) {
  return [
    id, overrides.tenant || 'Tehnopark', overrides.month || '2026-02',
    overrides.type || 'Income', overrides.amount || 1000000, 'UZS', 'Naqd',
    overrides.date || '05/02/2026', overrides.comment || 'ijara', '', overrides.requestId || ''
  ];
}

test('a row written before the column existed reads back with a deterministic group id', () => {
  const gas = bootLegacy([legacyRow('1770280404091_0'), legacyRow('1770280404091_1')]);
  const transactions = gas.readOmadTransactions_(gas.__spreadsheet);

  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].groupId, 'grp_legacy_1770280404091');
  // Two lines of one entry derive the same group without anything being stored.
  assert.equal(transactions[0].groupId, transactions[1].groupId);
});

test('the derivation is stable, so backfilling twice changes nothing the second time', () => {
  const gas = bootLegacy([legacyRow('1770280404091_0'), legacyRow('1770810464239_0')]);

  const first = gas.backfillEntryGroupIds_(gas.__spreadsheet);
  assert.equal(first.filled, 2);
  assert.equal(first.alreadySet, 0);

  const second = gas.backfillEntryGroupIds_(gas.__spreadsheet);
  assert.equal(second.filled, 0);
  assert.equal(second.alreadySet, 2);

  const stored = gas.__spreadsheet.getSheetByName('Omad_Transactions').data;
  assert.equal(stored[1][11], 'grp_legacy_1770280404091');
  assert.equal(stored[2][11], 'grp_legacy_1770810464239');
});

test('a backfilled row keeps the group it already had', () => {
  const gas = bootLegacy([
    [...legacyRow('1770280404091_0'), 'grp_supplied_by_the_client']
  ]);

  gas.backfillEntryGroupIds_(gas.__spreadsheet);
  assert.equal(gas.__spreadsheet.getSheetByName('Omad_Transactions').data[1][11], 'grp_supplied_by_the_client');
});

test('a stored group id wins over the id prefix, so one action can span two id bases', () => {
  const gas = bootLegacy([
    [...legacyRow('1770280404091_0', { type: 'Income' }), 'grp_pair'],
    [...legacyRow('1999999999999_0', { type: 'Expense' }), 'grp_pair'],
    [...legacyRow('1770280404091_1'), 'grp_other']
  ]);

  const group = gas.findTransactionsByGroupId_(gas.__spreadsheet, 'grp_pair');
  assert.equal(group.length, 2);
  assert.deepEqual(group.map(t => t.type).sort(), ['Expense', 'Income']);
  // The id prefix would have put row 3 in with row 1; the stored group does not.
  assert.ok(!group.some(t => t.id === '1770280404091_1'));
});

test('a group of rows is appended in one write, so a group cannot be half-created', () => {
  const gas = bootLegacy();
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');

  let setValuesCalls = 0;
  const originalGetRange = sheet.getRange;
  sheet.getRange = function (...args) {
    const range = originalGetRange.apply(sheet, args);
    const originalSetValues = range.setValues;
    range.setValues = function (values) {
      if (values.length > 1) setValuesCalls++;
      return originalSetValues.call(range, values);
    };
    return range;
  };

  gas.appendOmadTransactionGroup_(gas.__spreadsheet, [
    { id: '1800000000000_0', tenant: 'Apteka', month: '2026-02', type: 'Income', amount: 1000000, currency: 'UZS', method: 'Naqd', groupId: 'grp_pair' },
    { id: '1800000000000_1', tenant: 'Umumiy Naqd Puldan', month: '2026-02', type: 'Expense', amount: 1000000, currency: 'UZS', method: 'Naqd', groupId: 'grp_pair' }
  ]);

  assert.equal(setValuesCalls, 1, 'both rows must land in a single spreadsheet write');
  assert.equal(gas.findTransactionsByGroupId_(gas.__spreadsheet, 'grp_pair').length, 2);
});

test('a /yangi entry gets its own stored group id rather than inheriting the id prefix', () => {
  const gas = bootLegacy();
  const doc = gas.__spreadsheet;
  const configSheet = doc.getSheetByName('System_Config');

  gas.__cache['yangi_49328655'] = JSON.stringify({
    type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS',
    amount: 500000, step: 'await_desc', sessionId: 'sess1'
  });
  gas.processOmadTextStep_('fevral ijara', 111, 'yangi_49328655', gas.CacheService.getScriptCache(), doc, configSheet, '49328655');

  const written = gas.readOmadTransactions_(doc);
  assert.equal(written.length, 1);
  assert.ok(written[0].groupId.startsWith('grp_'));
  assert.ok(!written[0].groupId.startsWith('grp_legacy_'));
});

test('a report job resolves its rows by group id, falling back to the id prefix for older jobs', () => {
  const gas = bootLegacy([
    [...legacyRow('1770280404091_0'), 'grp_pair'],
    [...legacyRow('1999999999999_0', { type: 'Expense' }), 'grp_pair']
  ]);

  // The rows are read once by the caller and the group picked out of them,
  // rather than the resolver fetching the whole ledger for itself and the
  // caller fetching it again for the balances.
  const all = gas.readOmadTransactions_(gas.__spreadsheet);

  const byGroup = gas.resolveReportGroupFrom_(all, { groupId: 'grp_pair' });
  assert.equal(byGroup.length, 2);

  // A job enqueued before the column existed carries only a baseId.
  const byBase = gas.resolveReportGroupFrom_(all, { baseId: '1770280404091' });
  assert.equal(byBase.length, 1);
  assert.equal(byBase[0].id, '1770280404091_0');

  // An unknown group falls back rather than reporting on nothing.
  const fallback = gas.resolveReportGroupFrom_(all, { groupId: 'grp_missing', baseId: '1770280404091' });
  assert.equal(fallback.length, 1);
});

test('a whole-list save stores the group id the client sent', () => {
  const gas = bootLegacy();
  const response = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [
      { id: '1800000000000_0', tenant: 'Apteka', month: '2026-02', type: 'Income', amount: 1000000, currency: 'UZS', method: 'Naqd', groupId: 'grp_web_abc' },
      { id: '1800000000000_1', tenant: 'Apteka', month: '2026-02', type: 'Income', amount: 200, currency: 'USD', method: 'Bank', groupId: 'grp_web_abc' }
    ],
    tenants: [], rates: {}, templateExpenses: [],
    deferReports: true
  })));

  assert.equal(response.status, 'success');
  const group = gas.findTransactionsByGroupId_(gas.__spreadsheet, 'grp_web_abc');
  assert.equal(group.length, 2);
  assert.deepEqual(group.map(t => t.currency).sort(), ['USD', 'UZS']);
});
