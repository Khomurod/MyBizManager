'use strict';

/**
 * What a correction must never do: hide the original without a replacement.
 *
 * correctTransaction_ used to mark the original Corrected first and append the
 * replacement second, so a spreadsheet failure between the two writes removed
 * money from every figure the business acts on and left nothing in its place.
 * The order is now reversed and the failure path voids the replacement, so the
 * only reachable outcomes are "both landed" and "nothing counts".
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const ADMIN_KEY = 'safety-admin-key';

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID'
];

function bootLedger() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-01': { buy: 12000, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER]
    }
  });
}

function baseInput(overrides = {}) {
  return Object.assign({
    requestId: 'req-original',
    period: '2026-01',
    tenant: 'Tehnopark',
    type: 'Income',
    amount: 1000000,
    currency: 'UZS',
    method: 'Naqd',
    comment: 'yanvar',
    createdBy: 'tester',
    source: 'Web'
  }, overrides);
}

/**
 * Makes the status write on one specific row throw, leaving every other write
 * working — which is what a transient spreadsheet fault actually looks like.
 */
function breakStatusWriteForRow(gas, rowNumber) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  const originalGetRange = sheet.getRange;
  sheet.getRange = function (row, col, numRows, numCols) {
    const range = originalGetRange.call(sheet, row, col, numRows, numCols);
    if (row === rowNumber && col === 19) {
      range.setValue = () => { throw new Error('spreadsheet unavailable'); };
    }
    return range;
  };
  return () => { sheet.getRange = originalGetRange; };
}

test('a correction that cannot hide the original leaves the original Active and counting', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  assert.equal(created.status, 'success');
  const originalId = created.transaction.id;

  const restore = breakStatusWriteForRow(gas, 2);
  const corrected = gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: originalId, amount: 750000
  }));
  restore();

  assert.equal(corrected.status, 'error');

  const original = gas.getTransaction_(doc, originalId);
  assert.equal(original.status, 'Active', 'the original must never be left hidden');

  // Exactly one Active row, carrying the original amount.
  const active = gas.listActiveTransactions_(doc, {});
  assert.equal(active.length, 1);
  assert.equal(active[0].id, originalId);
  assert.equal(active[0].amount, 1000000);
});

test('the discarded replacement is marked Void, not left Active to double-count', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  const restore = breakStatusWriteForRow(gas, 2);
  gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));
  restore();

  const rows = gas.readLedgerRows_(doc);
  assert.equal(rows.length, 2, 'the replacement row is kept as evidence, not deleted');
  const replacement = rows.find(r => r.id !== created.transaction.id);
  assert.equal(replacement.status, 'Void');

  // A Void row is invisible to everything that adds money up.
  assert.equal(gas.listActiveTransactions_(doc, {}).length, 1);
});

test('the failure is recorded in the audit log with both ids', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  const restore = breakStatusWriteForRow(gas, 2);
  gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));
  restore();

  const audit = doc.getSheetByName('Omad_Audit_Log').data;
  const entry = audit.find(row => row[1] === 'transaction_correction_failed');
  assert.ok(entry, 'a failed correction must be audited');
  assert.ok(String(entry[2]).includes(created.transaction.id));
});

test('retrying a failed correction succeeds instead of replaying the voided attempt', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  const restore = breakStatusWriteForRow(gas, 2);
  const failed = gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));
  restore();
  assert.equal(failed.status, 'error');

  // Same request id, sheet now healthy: the Void row must not be mistaken for
  // "already done".
  const retried = gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));

  assert.equal(retried.status, 'success');
  assert.equal(retried.duplicate, false);
  assert.equal(gas.getTransaction_(doc, created.transaction.id).status, 'Corrected');

  const active = gas.listActiveTransactions_(doc, {});
  assert.equal(active.length, 1);
  assert.equal(active[0].amount, 750000);
});

test('a healthy correction still hides the original and keeps one Active row', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  const corrected = gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));

  assert.equal(corrected.status, 'success');
  assert.equal(corrected.corrected, created.transaction.id);
  assert.equal(gas.getTransaction_(doc, created.transaction.id).status, 'Corrected');

  const active = gas.listActiveTransactions_(doc, {});
  assert.equal(active.length, 1);
  assert.equal(active[0].amount, 750000);
  assert.equal(active[0].relatedId, created.transaction.id);
});

test('a correction stays inside the business action it corrects', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput({ groupId: 'grp_pair' }));
  const corrected = gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));

  assert.equal(corrected.transaction.groupId, 'grp_pair');
  // Both the hidden original and its replacement belong to the same group.
  assert.equal(gas.findLedgerRowsByGroupId_(doc, 'grp_pair').length, 2);
});

test('a Void row cannot be cancelled into counting for something', () => {
  const gas = bootLedger();
  const doc = gas.__spreadsheet;

  const created = gas.createTransaction_(doc, baseInput());
  const restore = breakStatusWriteForRow(gas, 2);
  gas.correctTransaction_(doc, baseInput({
    requestId: 'req-correction', transactionId: created.transaction.id, amount: 750000
  }));
  restore();

  const voided = gas.readLedgerRows_(doc).find(r => r.status === 'Void');
  const result = gas.cancelTransaction_(doc, { transactionId: voided.id, requestId: 'req-cancel' });

  assert.equal(result.status, 'success');
  assert.equal(result.duplicate, true);
  assert.equal(gas.getTransaction_(doc, voided.id).status, 'Void');
});
