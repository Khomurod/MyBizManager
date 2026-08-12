'use strict';

/**
 * The append-only transaction ledger.
 *
 * Financial records are never rewritten in place and never deleted. A
 * correction marks the original Corrected and appends a replacement that
 * points back at it; a cancellation flips the status and leaves the row where
 * it is. Both are idempotent on the request id.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'correct-admin-key';
const plain = value => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const RATES = {
  '2026-01': { buy: 12000, sell: 12500 },
  '2026-02': { buy: 12100, sell: 12600 },
  '2027-01': { buy: 13000, sell: 13500 }
};

/** A spreadsheet with the ledger already live (post-cutover). */
function bootLedger(extraConfig = []) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ...extraConfig
      ],
      Omad_Transactions_V2: [[
        'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
        'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
        'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
        'Telegram_Msg_ID', 'Schema_Version'
      ]]
    }
  });
}

function input(overrides = {}) {
  return {
    requestId: 'req-' + Math.random().toString(36).slice(2),
    period: '2026-01',
    tenant: 'Tehnopark',
    type: 'Income',
    amount: 1000000,
    currency: 'UZS',
    method: 'Naqd',
    comment: 'Yanvar ijara',
    createdBy: 'tester',
    source: 'Web',
    ...overrides
  };
}

function rows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

function post(gas, payload) {
  return readJsonOutput(gas.doPost(postEvent(payload)));
}

// -------------------------------------------------------------------- create

test('creating a transaction appends one Active row with its rate snapshot', () => {
  const gas = bootLedger();
  const result = gas.createTransaction_(gas.__spreadsheet, input({ currency: 'USD', amount: 100 }));

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(rows(gas).length, 1);

  const t = result.transaction;
  assert.strictEqual(t.status, 'Active');
  assert.strictEqual(t.source, 'Web');
  assert.strictEqual(t.period, '2026-01');
  assert.strictEqual(t.schemaVersion, gas.LEDGER_SCHEMA_VERSION);
  assert.ok(t.createdAt, 'a creation timestamp is recorded');
  assert.strictEqual(t.createdBy, 'tester');

  // Both rates in force are frozen, along with the one actually applied.
  assert.strictEqual(t.rateBuy, 12000);
  assert.strictEqual(t.rateSell, 12500);
  assert.strictEqual(t.rateUsed, 12500);
  assert.strictEqual(t.rateType, 'sell');
  assert.strictEqual(t.amountUZS, 1250000);
});

test('a UZS transaction records the rates but converts one-to-one', () => {
  const gas = bootLedger();
  const t = gas.createTransaction_(gas.__spreadsheet, input({ amount: 5000 })).transaction;

  assert.strictEqual(t.amountUZS, 5000);
  assert.strictEqual(t.rateType, 'none');
  assert.strictEqual(t.rateBuy, 12000, 'the rates are still recorded for history');
});

test('the same request id always produces the same transaction', () => {
  const gas = bootLedger();
  const payload = input({ requestId: 'stable-request' });

  const first = gas.createTransaction_(gas.__spreadsheet, payload);
  const second = gas.createTransaction_(gas.__spreadsheet, payload);
  const third = gas.createTransaction_(gas.__spreadsheet, payload);

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(third.duplicate, true);
  assert.strictEqual(second.transaction.id, first.transaction.id);
  assert.strictEqual(rows(gas).length, 1);
});

test('transactions created in the same millisecond get distinct ids', () => {
  const gas = bootLedger();
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    ids.add(gas.createTransaction_(gas.__spreadsheet, input()).transaction.id);
  }
  assert.strictEqual(ids.size, 5);
  assert.strictEqual(rows(gas).length, 5);
});

test('invalid input is rejected before anything is written', () => {
  const gas = bootLedger();
  const cases = [
    [{ period: 'Yanvar' }, /Davr/],
    [{ period: '2026-13' }, /Davr/],
    [{ tenant: '' }, /Obyekt/],
    [{ amount: 0 }, /Summa/],
    [{ amount: -5 }, /Summa/],
    [{ amount: 'abc' }, /Summa/],
    [{ currency: 'EUR' }, /Valyuta/],
    [{ method: 'Karta' }, /usul/],
    [{ type: 'Transfer' }, /turi/],
    [{ requestId: '' }, /requestId/]
  ];

  for (const [overrides, pattern] of cases) {
    const result = gas.createTransaction_(gas.__spreadsheet, input(overrides));
    assert.strictEqual(result.status, 'error', JSON.stringify(overrides));
    assert.match(result.message, pattern, JSON.stringify(overrides));
  }
  assert.strictEqual(rows(gas).length, 0, 'no partial writes');
});

test('concurrent creation of different requests keeps every record', () => {
  const gas = bootLedger();
  // Ten distinct requests arriving back to back, as two browser tabs would.
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(gas.createTransaction_(gas.__spreadsheet, input({
      requestId: 'req-' + i, amount: 100000 + i
    })));
  }

  assert.strictEqual(results.filter(r => r.status === 'success').length, 10);
  assert.strictEqual(rows(gas).length, 10);
  assert.strictEqual(new Set(results.map(r => r.transaction.id)).size, 10);
});

test('two simultaneous submissions of the same request produce one record', () => {
  const gas = bootLedger();
  const payload = input({ requestId: 'double-click' });
  const a = gas.createTransaction_(gas.__spreadsheet, payload);
  const b = gas.createTransaction_(gas.__spreadsheet, payload);

  assert.strictEqual(a.transaction.id, b.transaction.id);
  assert.strictEqual(rows(gas).length, 1);
});

// ------------------------------------------------------------------- correct

test('a correction preserves the original and appends a replacement', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input({ amount: 1000000 })).transaction;

  const corrected = gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-1', transactionId: original.id, amount: 1500000, comment: 'tuzatildi'
  }));

  assert.strictEqual(corrected.status, 'success');
  assert.strictEqual(corrected.corrected, original.id);
  assert.strictEqual(rows(gas).length, 2, 'nothing is removed');

  const stored = gas.readLedgerRows_(gas.__spreadsheet);
  assert.strictEqual(stored[0].status, 'Corrected');
  assert.strictEqual(stored[0].amount, 1000000, 'the original amount is preserved');
  assert.ok(stored[0].updatedAt, 'the original is timestamped');
  assert.strictEqual(stored[1].status, 'Active');
  assert.strictEqual(stored[1].amount, 1500000);
  assert.strictEqual(stored[1].relatedId, original.id);
});

test('only the replacement counts towards balances', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input({ amount: 1000000 })).transaction;
  gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-1', transactionId: original.id, amount: 1500000
  }));

  const active = gas.listActiveTransactions_(gas.__spreadsheet, {});
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].amount, 1500000);
});

test('correcting an already-corrected transaction is refused', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input()).transaction;
  gas.correctTransaction_(gas.__spreadsheet, input({ requestId: 'fix-1', transactionId: original.id }));

  const conflict = gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-2', transactionId: original.id
  }));
  assert.strictEqual(conflict.status, 'error');
  assert.match(conflict.message, /tuzatilgan/);
  assert.strictEqual(rows(gas).length, 2, 'the conflicting attempt writes nothing');
});

test('a correction is idempotent on its request id', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input()).transaction;

  const a = gas.correctTransaction_(gas.__spreadsheet, input({ requestId: 'fix-1', transactionId: original.id }));
  const b = gas.correctTransaction_(gas.__spreadsheet, input({ requestId: 'fix-1', transactionId: original.id }));

  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(b.transaction.id, a.transaction.id);
  assert.strictEqual(rows(gas).length, 2);
});

test('a correction inherits the group message so the report is edited', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input({ msgId: '4242' })).transaction;
  const corrected = gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-1', transactionId: original.id, amount: 2000000
  }));
  assert.strictEqual(corrected.transaction.msgId, '4242');
});

test('correcting an unknown transaction is refused', () => {
  const gas = bootLedger();
  const result = gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-1', transactionId: 'does-not-exist'
  }));
  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /topilmadi/);
});

test('a correction re-snapshots the rates for its own period', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet,
    input({ period: '2026-01', currency: 'USD', amount: 100 })).transaction;
  assert.strictEqual(original.rateUsed, 12500);

  const corrected = gas.correctTransaction_(gas.__spreadsheet, input({
    requestId: 'fix-1', transactionId: original.id, period: '2027-01', currency: 'USD', amount: 100
  }));
  assert.strictEqual(corrected.transaction.rateUsed, 13500);
  assert.strictEqual(corrected.transaction.amountUZS, 1350000);
});

// -------------------------------------------------------------------- cancel

test('cancelling flips the status and deletes nothing', () => {
  const gas = bootLedger();
  const created = gas.createTransaction_(gas.__spreadsheet, input()).transaction;

  const cancelled = gas.cancelTransaction_(gas.__spreadsheet, {
    requestId: 'cancel-1', transactionId: created.id, reason: 'xato kiritildi'
  });

  assert.strictEqual(cancelled.status, 'success');
  assert.strictEqual(cancelled.transaction.status, 'Cancelled');
  assert.strictEqual(rows(gas).length, 1, 'the row stays in the sheet');
  assert.strictEqual(gas.listActiveTransactions_(gas.__spreadsheet, {}).length, 0);
});

test('cancelling twice is the same outcome as cancelling once', () => {
  const gas = bootLedger();
  const created = gas.createTransaction_(gas.__spreadsheet, input()).transaction;

  gas.cancelTransaction_(gas.__spreadsheet, { requestId: 'c1', transactionId: created.id });
  const again = gas.cancelTransaction_(gas.__spreadsheet, { requestId: 'c2', transactionId: created.id });

  assert.strictEqual(again.status, 'success');
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(rows(gas).length, 1);
});

test('a corrected record cannot be cancelled - the replacement must be', () => {
  const gas = bootLedger();
  const original = gas.createTransaction_(gas.__spreadsheet, input()).transaction;
  const replacement = gas.correctTransaction_(gas.__spreadsheet,
    input({ requestId: 'fix-1', transactionId: original.id })).transaction;

  const refused = gas.cancelTransaction_(gas.__spreadsheet, {
    requestId: 'c1', transactionId: original.id
  });
  assert.strictEqual(refused.status, 'error');

  const allowed = gas.cancelTransaction_(gas.__spreadsheet, {
    requestId: 'c2', transactionId: replacement.id
  });
  assert.strictEqual(allowed.status, 'success');
  assert.strictEqual(gas.listActiveTransactions_(gas.__spreadsheet, {}).length, 0);
});

// --------------------------------------------------------------- audit trail

test('the audit history walks the whole correction chain', () => {
  const gas = bootLedger();
  const first = gas.createTransaction_(gas.__spreadsheet, input({ amount: 1000000 })).transaction;
  const second = gas.correctTransaction_(gas.__spreadsheet,
    input({ requestId: 'fix-1', transactionId: first.id, amount: 1500000 })).transaction;
  const third = gas.correctTransaction_(gas.__spreadsheet,
    input({ requestId: 'fix-2', transactionId: second.id, amount: 1750000 })).transaction;

  // The same chain is returned no matter which link you ask about.
  for (const id of [first.id, second.id, third.id]) {
    const history = gas.getTransactionHistory_(gas.__spreadsheet, id);
    assert.strictEqual(history.chain.length, 3, id);
    assert.deepStrictEqual(plain(history.chain.map(t => t.amount)), [1000000, 1500000, 1750000], id);
    assert.deepStrictEqual(plain(history.chain.map(t => t.status)),
      ['Corrected', 'Corrected', 'Active'], id);
    assert.strictEqual(history.current.id, third.id, id);
  }
});

test('every operation writes an audit-log row', () => {
  const gas = bootLedger();
  const created = gas.createTransaction_(gas.__spreadsheet, input()).transaction;
  const replacement = gas.correctTransaction_(gas.__spreadsheet,
    input({ requestId: 'fix-1', transactionId: created.id })).transaction;
  gas.cancelTransaction_(gas.__spreadsheet, { requestId: 'c1', transactionId: replacement.id });

  const events = gas.__spreadsheet.getSheetByName('Omad_Audit_Log')
    .getDataRange().getValues().slice(1).map(r => r[1]);
  assert.ok(events.includes('transaction_created'));
  assert.ok(events.includes('transaction_corrected'));
  assert.ok(events.includes('transaction_cancelled'));
});

test('the correction audit row records the before and after values', () => {
  const gas = bootLedger();
  const created = gas.createTransaction_(gas.__spreadsheet, input({ amount: 1000000 })).transaction;
  gas.correctTransaction_(gas.__spreadsheet,
    input({ requestId: 'fix-1', transactionId: created.id, amount: 1500000 }));

  const audit = gas.__spreadsheet.getSheetByName('Omad_Audit_Log')
    .getDataRange().getValues().slice(1).find(r => r[1] === 'transaction_corrected');
  const details = JSON.parse(audit[2]);
  assert.strictEqual(details.before.amount, 1000000);
  assert.strictEqual(details.after.amount, 1500000);
});

// ----------------------------------------------------------------- the API

test('create, correct and cancel are reachable over the API', () => {
  const gas = bootLedger();

  const created = post(gas, { action: 'create_transaction', adminKey: ADMIN_KEY, ...input({ requestId: 'r1' }) });
  assert.strictEqual(created.status, 'success');
  assert.ok(created.reportJobId, 'the Telegram report is queued, not sent inline');

  const read = post(gas, { action: 'get_transaction', adminKey: ADMIN_KEY, transactionId: created.transaction.id });
  assert.strictEqual(read.transaction.amount, 1000000);

  const corrected = post(gas, {
    action: 'correct_transaction', adminKey: ADMIN_KEY,
    ...input({ requestId: 'r2', transactionId: created.transaction.id, amount: 1200000 })
  });
  assert.strictEqual(corrected.status, 'success');

  const history = post(gas, {
    action: 'get_transaction_history', adminKey: ADMIN_KEY, transactionId: created.transaction.id
  });
  assert.strictEqual(history.history.chain.length, 2);

  const listed = post(gas, { action: 'list_transactions', adminKey: ADMIN_KEY, period: '2026-01' });
  assert.strictEqual(listed.transactions.length, 1);
  assert.strictEqual(listed.transactions[0].amount, 1200000);

  const cancelled = post(gas, {
    action: 'cancel_transaction', adminKey: ADMIN_KEY, requestId: 'r3', transactionId: corrected.transaction.id
  });
  assert.strictEqual(cancelled.status, 'success');
  assert.strictEqual(post(gas, { action: 'list_transactions' , adminKey: ADMIN_KEY,}).transactions.length, 0);
});

test('a Telegram failure never fails the transaction', () => {
  const gas = loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [['ID']]
    },
    fetch: () => ({ getResponseCode: () => 503, getContentText: () => 'unavailable' })
  });

  const created = post(gas, { action: 'create_transaction', adminKey: ADMIN_KEY, ...input({ requestId: 'r1' }) });
  assert.strictEqual(created.status, 'success');

  const queue = gas.__spreadsheet.getSheetByName('Omad_Job_Queue').getDataRange().getValues();
  assert.strictEqual(queue[1][4], 'Pending', 'the report is retried separately');
  assert.strictEqual(gas.listActiveTransactions_(gas.__spreadsheet, {}).length, 1);
});

// --------------------------------------------------- old / new compatibility

test('the individual operations refuse until the ledger is live', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify(RATES)]],
      Omad_Transactions: [
        ['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment', 'Telegram_Msg_ID', 'Request_ID'],
        ['1_0', 'Tehnopark', 'Yanvar', 'Income', 1000000, 'UZS', 'Naqd', '05/01/2026', '', '', '']
      ]
    }
  });

  const created = post(gas, { action: 'create_transaction', adminKey: ADMIN_KEY, ...input() });
  assert.strictEqual(created.status, 'error');
  assert.match(created.message, /ko'chiring/);

  // Reads still work against the legacy sheet, with resolved periods.
  const listed = post(gas, { action: 'list_transactions' , adminKey: ADMIN_KEY,});
  assert.strictEqual(listed.transactions.length, 1);
  assert.strictEqual(listed.transactions[0].period, '2026-01');
});

test('the whole-list rewrite is refused once the ledger is live', () => {
  const gas = bootLedger();
  gas.createTransaction_(gas.__spreadsheet, input({ requestId: 'r1' }));

  const saved = post(gas, {
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [],
    tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
    rates: RATES,
    templateExpenses: []
  });

  assert.strictEqual(saved.status, 'success', 'settings still save');
  assert.strictEqual(gas.listActiveTransactions_(gas.__spreadsheet, {}).length, 1,
    'an empty transaction list can no longer wipe the ledger');
});

test('reads return the same shape before and after cutover', () => {
  const gas = bootLedger();
  gas.createTransaction_(gas.__spreadsheet, input({ requestId: 'r1' }));

  const loaded = readJsonOutput(gas.doGet({ parameter: { action: 'get_omad' } }));
  const t = loaded.transactions[0];

  for (const field of ['id', 'tenant', 'month', 'type', 'amount', 'currency', 'method', 'date', 'comment']) {
    assert.ok(field in t, `legacy field ${field} is still present`);
  }
  assert.strictEqual(t.month, t.period, 'month mirrors the canonical period');
  assert.strictEqual(t.status, 'Active');
  assert.strictEqual(t.periodLabel, 'Yanvar 2026');
});
