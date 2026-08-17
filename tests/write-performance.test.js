'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'write-perf-admin';

const LEDGER_HEADER = [[
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
]];

function boot(extra = {}) {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12100, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: LEDGER_HEADER
    },
    ...extra
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent({ adminKey: ADMIN_KEY, ...body })));
}

function batchPayload(overrides = {}) {
  return {
    action: 'create_transaction_batch',
    requestId: 'batch_req_1',
    groupId: 'grp_write_perf_1',
    period: '2026-08',
    tenant: 'Tehnopark',
    type: 'Income',
    comment: 'three-part payment',
    source: 'Web',
    createdBy: 'tester',
    deferReports: true,
    lines: [
      { amount: 100000, currency: 'UZS', method: 'Naqd' },
      { amount: 20, currency: 'USD', method: 'Bank' },
      { amount: 300000, currency: 'UZS', method: 'Bank' }
    ],
    ...overrides
  };
}

test('one multi-line Omad entry lands atomically in one backend request', () => {
  const gas = boot();
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  let fullLedgerPasses = 0;
  const originalDataRange = ledger.getDataRange;
  ledger.getDataRange = function () {
    fullLedgerPasses++;
    return originalDataRange.call(ledger);
  };

  const result = post(gas, batchPayload());

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.transactions.length, 3);
  assert.strictEqual(fullLedgerPasses, 0, 'saving must not scan all ledger columns');

  const rows = ledger.data.slice(1);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map(row => row[1]), ['batch_req_1__n3_0', 'batch_req_1__n3_1', 'batch_req_1__n3_2']);
  assert.ok(rows.every(row => row[22] === 'grp_write_perf_1'));
  assert.strictEqual(rows[0][15], 100000);
  assert.strictEqual(rows[1][15], 250000, 'USD freezes the current sell rate');
  assert.strictEqual(rows[2][15], 300000);

  const queue = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  assert.ok(queue && queue.data.length === 2, 'one durable group report is queued');
  assert.strictEqual(queue.data[1][4], 'Pending', 'deferred reporting does not block the save');
});

test('retrying the same multi-line entry returns the original result without duplicates', () => {
  const gas = boot();
  const first = post(gas, batchPayload());
  const second = post(gas, batchPayload());
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');

  assert.strictEqual(first.status, 'success');
  assert.strictEqual(second.status, 'success');
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.transactions.length, 3);
  assert.strictEqual(ledger.data.length - 1, 3);

  const queue = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  assert.strictEqual(queue.data.length - 1, 1, 'retry queues no second Telegram report');
});

test('a partial old-backend fallback is completed rather than mistaken for a full batch', () => {
  const gas = boot();
  const payload = batchPayload();

  const firstLine = post(gas, {
    action: 'create_transaction',
    requestId: payload.requestId + '__n3_0',
    groupId: payload.groupId,
    period: payload.period,
    tenant: payload.tenant,
    type: payload.type,
    comment: payload.comment,
    source: payload.source,
    createdBy: payload.createdBy,
    amount: payload.lines[0].amount,
    currency: payload.lines[0].currency,
    method: payload.lines[0].method,
    deferReports: true
  });
  assert.strictEqual(firstLine.status, 'success');

  const resumed = post(gas, payload);
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  assert.strictEqual(resumed.status, 'success');
  assert.strictEqual(resumed.duplicate, false);
  assert.strictEqual(resumed.resumed, true);
  assert.strictEqual(resumed.transactions.length, 3);
  assert.deepStrictEqual(ledger.data.slice(1).map(row => row[1]).sort(),
    ['batch_req_1__n3_0', 'batch_req_1__n3_1', 'batch_req_1__n3_2']);
});

test('a completed batch cannot be retried with fewer lines', () => {
  const gas = boot();
  const first = post(gas, batchPayload());
  const shorter = batchPayload({ lines: batchPayload().lines.slice(0, 2) });
  const retry = post(gas, shorter);
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');

  assert.strictEqual(first.status, 'success');
  assert.strictEqual(retry.status, 'error');
  assert.strictEqual(retry.code, 'batch_retry_conflict');
  assert.strictEqual(ledger.data.length - 1, 3, 'the original three rows stay untouched');
});

test('a completed batch cannot be expanded by reusing its request id', () => {
  const gas = boot();
  const twoLines = batchPayload({ lines: batchPayload().lines.slice(0, 2) });
  const first = post(gas, twoLines);
  const retry = post(gas, batchPayload());
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');

  assert.strictEqual(first.status, 'success');
  assert.strictEqual(retry.status, 'error');
  assert.strictEqual(retry.code, 'batch_retry_conflict');
  assert.strictEqual(ledger.data.length - 1, 2, 'no third row is appended');
});

test('a retry cannot change the financial rate type of an existing USD line', () => {
  const gas = boot();
  const usd = batchPayload({
    lines: [{ amount: 20, currency: 'USD', method: 'Bank', rateType: 'sell' }]
  });
  const first = post(gas, usd);
  const retry = post(gas, {
    ...usd,
    lines: [{ amount: 20, currency: 'USD', method: 'Bank', rateType: 'buy' }]
  });

  assert.strictEqual(first.status, 'success');
  assert.strictEqual(retry.status, 'error');
  assert.strictEqual(retry.code, 'batch_retry_conflict');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length - 1, 1);
});

test('a counted partial rollout resumes with the rates frozen by its first line', () => {
  const gas = boot();
  const payload = batchPayload();
  const firstLine = post(gas, {
    action: 'create_transaction',
    requestId: payload.requestId + '__n3_0',
    groupId: payload.groupId,
    period: payload.period,
    tenant: payload.tenant,
    type: payload.type,
    comment: payload.comment,
    source: payload.source,
    createdBy: payload.createdBy,
    amount: payload.lines[0].amount,
    currency: payload.lines[0].currency,
    method: payload.lines[0].method,
    deferReports: true
  });
  assert.strictEqual(firstLine.status, 'success');

  const config = gas.__spreadsheet.getSheetByName('System_Config');
  config.getRange(1, 2).setValue(JSON.stringify({ '2026-08': { buy: 13100, sell: 14000 } }));

  const resumed = post(gas, payload);
  const rows = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.slice(1);
  assert.strictEqual(resumed.status, 'success');
  assert.strictEqual(resumed.resumed, true);
  assert.ok(rows.every(row => row[11] === 12100 && row[12] === 12500),
    'every line keeps the same original period rate snapshot');
  assert.strictEqual(rows[1][15], 250000, 'the resumed USD line uses the original sell rate');
});

test('a partial rollout with conflicting frozen rates fails closed', () => {
  const gas = boot();
  const payload = batchPayload();
  const first = payload.lines[0];
  const second = payload.lines[1];

  assert.strictEqual(post(gas, {
    action: 'create_transaction', requestId: payload.requestId + '__n3_0',
    groupId: payload.groupId, period: payload.period, tenant: payload.tenant,
    type: payload.type, comment: payload.comment, source: payload.source,
    createdBy: payload.createdBy, amount: first.amount, currency: first.currency,
    method: first.method, deferReports: true
  }).status, 'success');

  const config = gas.__spreadsheet.getSheetByName('System_Config');
  config.getRange(1, 2).setValue(JSON.stringify({ '2026-08': { buy: 13100, sell: 14000 } }));

  assert.strictEqual(post(gas, {
    action: 'create_transaction', requestId: payload.requestId + '__n3_1',
    groupId: payload.groupId, period: payload.period, tenant: payload.tenant,
    type: payload.type, comment: payload.comment, source: payload.source,
    createdBy: payload.createdBy, amount: second.amount, currency: second.currency,
    method: second.method, deferReports: true
  }).status, 'success');

  const retry = post(gas, payload);
  assert.strictEqual(retry.status, 'error');
  assert.strictEqual(retry.code, 'batch_retry_conflict');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length - 1, 2,
    'the missing third line is not guessed into an inconsistent group');
});

test('legacy uncounted rollout rows are accepted only when the whole retry already exists', () => {
  const gas = boot();
  const payload = batchPayload();
  for (let i = 0; i < payload.lines.length; i++) {
    const line = payload.lines[i];
    const result = post(gas, {
      action: 'create_transaction', requestId: `${payload.requestId}_${i}`,
      groupId: payload.groupId, period: payload.period, tenant: payload.tenant,
      type: payload.type, comment: payload.comment, source: payload.source,
      createdBy: payload.createdBy, amount: line.amount, currency: line.currency,
      method: line.method, deferReports: true
    });
    assert.strictEqual(result.status, 'success');
  }
  const retry = post(gas, payload);
  assert.strictEqual(retry.status, 'success');
  assert.strictEqual(retry.duplicate, true);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length - 1, 3);
});

test('legacy uncounted partial rollout is refused rather than guessing the original cart size', () => {
  const gas = boot();
  const payload = batchPayload();
  const line = payload.lines[0];
  assert.strictEqual(post(gas, {
    action: 'create_transaction', requestId: payload.requestId + '_0',
    groupId: payload.groupId, period: payload.period, tenant: payload.tenant,
    type: payload.type, comment: payload.comment, source: payload.source,
    createdBy: payload.createdBy, amount: line.amount, currency: line.currency,
    method: line.method, deferReports: true
  }).status, 'success');

  const retry = post(gas, payload);
  assert.strictEqual(retry.status, 'error');
  assert.strictEqual(retry.code, 'batch_retry_conflict');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length - 1, 1);
});

test('request ids remain case-sensitive after the fast lookup change', () => {
  const gas = boot();
  const common = {
    action: 'create_transaction', period: '2026-08', tenant: 'Tehnopark',
    type: 'Income', amount: 50000, currency: 'UZS', method: 'Naqd', deferReports: true
  };
  assert.strictEqual(post(gas, { ...common, requestId: 'CaseSensitive' }).status, 'success');
  assert.strictEqual(post(gas, { ...common, requestId: 'casesensitive' }).status, 'success');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length - 1, 2);
});

test('ordinary single-row creates no longer full-scan the ledger to dedupe or mint an id', () => {
  const historical = [];
  for (let i = 0; i < 400; i++) {
    historical.push([
      `1700000000000_${i}`, `old_${i}`, '2026-08-01T00:00:00.000Z', '', 'seed', 'Web',
      '2026-08', 'Tehnopark', 'Income', 1000, 'UZS', 12100, 12500, 1, 'none', 1000,
      'Naqd', '', 'Active', '', '', 2, `grp_old_${i}`, ''
    ]);
  }
  const gas = boot({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12100, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: LEDGER_HEADER.concat(historical)
    }
  });
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  let fullLedgerPasses = 0;
  const originalDataRange = ledger.getDataRange;
  ledger.getDataRange = function () {
    fullLedgerPasses++;
    return originalDataRange.call(ledger);
  };

  const result = post(gas, {
    action: 'create_transaction', requestId: 'single_fast',
    period: '2026-08', tenant: 'Tehnopark', type: 'Income', amount: 50000,
    currency: 'UZS', method: 'Naqd', deferReports: true
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(fullLedgerPasses, 0);
  assert.strictEqual(ledger.data.length - 1, 401);
});

// -------------------------------------------------- correction / cancellation
//
// An edit and a cancellation both start by finding one row by its transaction
// id. That lookup used to read all 24 columns of every historical row, once per
// line of the entry being edited. The rules it feeds are unchanged: a
// correction still refuses a row that is not Active, a cancellation still
// answers `duplicate` for one that is already Cancelled or Void, and the
// original is still never rewritten.

/** A big ledger with one known Active row to correct or cancel. */
function bootHistoricalLedger(targetOverrides = {}) {
  const historical = [];
  for (let i = 0; i < 400; i++) {
    historical.push([
      `1700000000000_${i}`, `old_${i}`, '2026-08-01T00:00:00.000Z', '', 'seed', 'Web',
      '2026-08', 'Tehnopark', 'Income', 1000, 'UZS', 12100, 12500, 1, 'none', 1000,
      'Naqd', '', 'Active', '', '', 2, `grp_old_${i}`, ''
    ]);
  }
  const target = historical[217];
  Object.keys(targetOverrides).forEach(index => { target[index] = targetOverrides[index]; });
  return {
    gas: boot({
      sheets: {
        System_Config: [
          ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12100, sell: 12500 } })],
          ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
        ],
        Omad_Transactions_V2: LEDGER_HEADER.concat(historical)
      }
    }),
    targetId: target[0]
  };
}

function countFullLedgerPasses(gas, run) {
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  let passes = 0;
  const original = ledger.getDataRange;
  ledger.getDataRange = function () {
    passes++;
    return original.call(ledger);
  };
  try { run(); } finally { ledger.getDataRange = original; }
  return passes;
}

test('correcting one transaction no longer reads the whole 24-column ledger', () => {
  const { gas, targetId } = bootHistoricalLedger();
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');

  let result;
  const passes = countFullLedgerPasses(gas, () => {
    result = post(gas, {
      action: 'correct_transaction', transactionId: targetId, requestId: 'fix_1',
      period: '2026-08', tenant: 'Tehnopark', type: 'Income', amount: 7777,
      currency: 'UZS', method: 'Bank', comment: 'fixed', deferReports: true
    });
  });

  assert.strictEqual(result.status, 'success', result.message);
  assert.strictEqual(passes, 0, 'finding one row must not transfer every ledger column');

  // The original is marked Corrected in place and the replacement is appended
  // after it, pointing back at it. Nothing is rewritten and nothing is removed.
  assert.strictEqual(ledger.data[218][0], targetId);
  assert.strictEqual(ledger.data[218][18], 'Corrected');
  assert.strictEqual(ledger.data[218][9], 1000, 'the original amount is untouched');
  const replacement = ledger.data[ledger.data.length - 1];
  assert.strictEqual(replacement[19], targetId, 'the replacement points at what it corrects');
  assert.strictEqual(replacement[9], 7777);
  assert.strictEqual(replacement[22], 'grp_old_217', 'a correction stays inside its group');
  assert.strictEqual(ledger.data.length - 1, 401);
});

test('cancelling one transaction no longer reads the whole 24-column ledger', () => {
  const { gas, targetId } = bootHistoricalLedger();
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');

  let result;
  const passes = countFullLedgerPasses(gas, () => {
    result = post(gas, {
      action: 'cancel_transaction', transactionId: targetId,
      requestId: 'kill_1', reason: 'entry edited', deferReports: true
    });
  });

  assert.strictEqual(result.status, 'success', result.message);
  assert.strictEqual(passes, 0);
  assert.strictEqual(ledger.data[218][18], 'Cancelled');
  assert.strictEqual(ledger.data.length - 1, 400, 'nothing is appended and nothing is deleted');
});

test('the fast id lookup still reports a row that is not Active', () => {
  // Correction and cancellation both read the status off the row the lookup
  // returns, so a lookup that quietly skipped non-Active rows would turn
  // "already cancelled" into "transaction not found".
  const corrected = bootHistoricalLedger({ 18: 'Corrected' });
  assert.strictEqual(
    post(corrected.gas, {
      action: 'correct_transaction', transactionId: corrected.targetId, requestId: 'fix_2',
      period: '2026-08', tenant: 'Tehnopark', type: 'Income', amount: 1,
      currency: 'UZS', method: 'Naqd', deferReports: true
    }).message,
    'Bu tranzaksiya allaqachon tuzatilgan.'
  );

  const cancelled = bootHistoricalLedger({ 18: 'Cancelled' });
  const twice = post(cancelled.gas, {
    action: 'cancel_transaction', transactionId: cancelled.targetId,
    requestId: 'kill_2', deferReports: true
  });
  assert.strictEqual(twice.status, 'success');
  assert.strictEqual(twice.duplicate, true, 'cancelling twice is still the same outcome');

  const voided = bootHistoricalLedger({ 18: 'Void' });
  const voidCancel = post(voided.gas, {
    action: 'cancel_transaction', transactionId: voided.targetId,
    requestId: 'kill_3', deferReports: true
  });
  assert.strictEqual(voidCancel.status, 'success');
  assert.strictEqual(voidCancel.duplicate, true);
});

test('an unknown transaction id is still not found, and no id matches a blank one', () => {
  const { gas } = bootHistoricalLedger();
  assert.strictEqual(
    post(gas, {
      action: 'cancel_transaction', transactionId: 'no_such_row',
      requestId: 'kill_4', deferReports: true
    }).message,
    'Tranzaksiya topilmadi.'
  );
  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, ''), null);
  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, null), null);
  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, undefined), null);
});

test('transaction ids stay case-sensitive and exact after the fast lookup change', () => {
  const gas = boot({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12100, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: LEDGER_HEADER.concat([
        ['Abc_1', 'r1', '', '', '', 'Web', '2026-08', 'T', 'Income', 1, 'UZS',
          0, 0, 1, 'none', 1, 'Naqd', '', 'Active', '', '', 2, 'g1', ''],
        ['abc_1', 'r2', '', '', '', 'Web', '2026-08', 'T', 'Income', 2, 'UZS',
          0, 0, 1, 'none', 2, 'Naqd', '', 'Active', '', '', 2, 'g2', '']
      ])
    }
  });

  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, 'Abc_1').amount, 1);
  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, 'abc_1').amount, 2);
  assert.strictEqual(gas.findLedgerRow_(gas.__spreadsheet, 'Abc'), null,
    'a prefix is not a match; the whole cell has to be the id');
});

test('a duplicated id still resolves to the first matching row, as it always did', () => {
  const gas = boot({
    sheets: {
      System_Config: [['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']],
      Omad_Transactions_V2: LEDGER_HEADER.concat([
        ['dup_1', 'r1', '', '', '', 'Web', '2026-08', 'T', 'Income', 11, 'UZS',
          0, 0, 1, 'none', 11, 'Naqd', '', 'Active', '', '', 2, 'g1', ''],
        ['dup_1', 'r2', '', '', '', 'Web', '2026-08', 'T', 'Income', 22, 'UZS',
          0, 0, 1, 'none', 22, 'Naqd', '', 'Active', '', '', 2, 'g2', '']
      ])
    }
  });
  const found = gas.findLedgerRow_(gas.__spreadsheet, 'dup_1');
  assert.strictEqual(found.rowNumber, 2);
  assert.strictEqual(found.amount, 11);
});

test('cafe duplicate lookup reads only receipt details, not the whole sales history', () => {
  const cafeRows = [['Sana', 'Sotuvchi', 'Jami', 'Foyda', 'Tafsilotlar', 'ID']];
  for (let i = 0; i < 700; i++) {
    cafeRows.push([
      '2026-08-16T10:00:00.000Z', 'seller', 10000, 3000,
      JSON.stringify({ requestId: i === 611 ? 'target_request' : `sale_${i}`, items: [] }),
      `sale-id-${i}`
    ]);
  }
  const gas = boot({
    sheets: {
      System_Config: [],
      Omad_Transactions_V2: LEDGER_HEADER,
      Cafe_Sales: cafeRows
    }
  });
  const sheet = gas.__spreadsheet.getSheetByName('Cafe_Sales');
  let fullPasses = 0;
  const originalDataRange = sheet.getDataRange;
  sheet.getDataRange = function () {
    fullPasses++;
    return originalDataRange.call(sheet);
  };

  const found = gas.findCafeSaleByRequestId_(sheet, 'target_request');
  assert.ok(found);
  assert.strictEqual(found.detail.requestId, 'target_request');
  assert.strictEqual(found.row[5], 'sale-id-611');
  assert.strictEqual(fullPasses, 0, 'sale dedupe must not transfer all sale columns');
});

// ------------------------------------------------------- café stock movements

const MOVEMENTS_HEADER = [
  'Sana', "Yo'nalish", 'Sabab', 'Mahsulot_ID', 'Nomi',
  'Miqdor', 'Birlik', 'Tannarx', 'Qoldiq', 'Izoh', 'Kim', 'Request_ID'
];

function bootManyMovements(count = 500) {
  const rows = [MOVEMENTS_HEADER];
  for (let i = 0; i < count; i++) {
    rows.push([
      `2026-08-16T10:0${i % 10}:00.000Z`, i % 2 ? 'in' : 'out', i % 2 ? 'purchase' : 'spoilage',
      `i${i % 7}`, `Mahsulot ${i % 7}`, i + 1, 'dona', 1000 * i, 50, `izoh ${i}`, 'admin',
      i === 311 ? 'Stock_Target' : `stock_${i}`
    ]);
  }
  return boot({
    sheets: {
      System_Config: [],
      Omad_Transactions_V2: LEDGER_HEADER,
      Cafe_Stock_Movements: rows
    }
  });
}

function countFullPasses(gas, sheetName, run) {
  const sheet = gas.__spreadsheet.getSheetByName(sheetName);
  let passes = 0;
  const original = sheet.getDataRange;
  sheet.getDataRange = function () {
    passes++;
    return original.call(sheet);
  };
  try { run(); } finally { sheet.getDataRange = original; }
  return passes;
}

test('stock-movement duplicate detection reads only the Request_ID column', () => {
  const gas = bootManyMovements();
  const sheet = gas.__spreadsheet.getSheetByName('Cafe_Stock_Movements');

  let found;
  const passes = countFullPasses(gas, 'Cafe_Stock_Movements', () => {
    found = gas.findCafeMovementByRequestId_(sheet, 'Stock_Target');
  });

  assert.ok(found, 'the movement is found');
  assert.strictEqual(passes, 0, 'a duplicate check must not transfer every movement column');
  assert.strictEqual(found.rowNumber, 313);
  assert.strictEqual(found.row[11], 'Stock_Target');
  assert.strictEqual(found.row[3], `i${311 % 7}`, 'and the whole row comes back, as the caller expects');
  assert.deepStrictEqual(found, gas.findCafeMovementByRequestIdBeforeWritePerf_(sheet, 'Stock_Target'),
    'byte-identical to the reader it replaced');
});

test('a stock-movement id that is absent, blank or differently cased finds nothing', () => {
  const gas = bootManyMovements(20);
  const sheet = gas.__spreadsheet.getSheetByName('Cafe_Stock_Movements');
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, 'nope'), null);
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, ''), null);
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, null), null);
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, undefined), null);
  // Case sensitivity is the rule TextFinder would break without matchCase(true):
  // a different movement must never look like a retry of this one.
  assert.ok(gas.findCafeMovementByRequestId_(sheet, 'stock_3'));
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, 'STOCK_3'), null);
  assert.strictEqual(gas.findCafeMovementByRequestId_(sheet, 'stock_'), null,
    'a prefix is not a match');
});

test('the recent-movements read answers the same tail without reading the whole sheet', () => {
  const gas = bootManyMovements();
  [1, 5, 40, 200, 900].forEach(limit => {
    const expected = gas.readCafeStockMovementsBeforeWritePerf_(gas.__spreadsheet, limit);
    let actual;
    const passes = countFullPasses(gas, 'Cafe_Stock_Movements', () => {
      actual = gas.readCafeStockMovements_(gas.__spreadsheet, limit);
    });
    assert.strictEqual(passes, 0, `limit ${limit} must not read the whole history`);
    assert.deepStrictEqual(actual, expected, `limit ${limit} answers exactly what it used to`);
    assert.strictEqual(actual.total, 500, 'the total still counts every movement recorded');
  });
});

test('an empty or header-only movement sheet still answers empty', () => {
  const gas = boot({
    sheets: {
      System_Config: [], Omad_Transactions_V2: LEDGER_HEADER,
      Cafe_Stock_Movements: [MOVEMENTS_HEADER]
    }
  });
  // Compared field by field: the harness runs the backend in its own VM realm,
  // so a returned array is not reference-comparable with a host-side literal.
  const empty = gas.readCafeStockMovements_(gas.__spreadsheet, 40);
  assert.strictEqual(empty.rows.length, 0);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(
    gas.findCafeMovementByRequestId_(gas.__spreadsheet.getSheetByName('Cafe_Stock_Movements'), 'x'), null);
});

test('recording stock is still idempotent on its request id', () => {
  const gas = boot({
    sheets: {
      System_Config: [
        ['Cafe_Inventory', JSON.stringify([{
          id: 'i1', name: 'Kola', type: 'product', qty: 10, unit: 'dona',
          sellPrice: 8000, unitCost: 6000, totalCost: 60000
        }])],
        ['Cafe_Recipes', '[]']
      ],
      Omad_Transactions_V2: LEDGER_HEADER
    }
  });
  const move = {
    action: 'adjust_cafe_stock', inventoryId: 'i1', direction: 'in',
    reason: 'purchase', qty: 5, cost: 30000, requestId: 'stock_once'
  };

  const first = post(gas, move);
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.inventory.find(i => i.id === 'i1').qty, 15);

  const retry = post(gas, move);
  assert.strictEqual(retry.status, 'success');
  assert.strictEqual(retry.duplicate, true, 'a retry resolves to the movement already made');
  assert.strictEqual(retry.inventory.find(i => i.id === 'i1').qty, 15, 'and the stock moved once');
  assert.strictEqual(
    gas.__spreadsheet.getSheetByName('Cafe_Stock_Movements').data.length - 1, 1,
    'one movement row, not two');
});

test('the café admin applies the returned stock at once and refreshes in the background', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'cafe_admin.html'), 'utf8');
  const handler = source.slice(source.indexOf('async function submitStockMovement'));
  assert.match(handler.slice(0, 1200), /answer\.inventory/,
    'the authoritative inventory in the answer is what goes on screen');
  assert.match(handler.slice(0, 1200), /refreshCafeInBackground\(\)/,
    'and the extra full refresh no longer blocks the person recording it');
  assert.doesNotMatch(handler.slice(0, 1200), /await syncData\(\)/);
  // A refresh asked for mid-flight is queued rather than dropped.
  assert.match(source, /cafeRefreshQueued = true/);
  assert.match(source, /if \(cafeRefreshQueued\) \{/);
});

test('the POS locks Sotish while one sale is in flight', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'cafe_pos.html'), 'utf8');
  assert.match(source, /id="sellBtn"/);
  assert.match(source, /let selling = false/);
  const handler = source.slice(source.indexOf('async function sell()'));
  assert.match(handler.slice(0, 400), /if \(selling\) return/,
    'a second tap is refused before anything is sent');
  assert.match(handler, /Sotilmoqda\.\.\./);
  assert.match(handler, /button\.disabled = true/);
  assert.match(handler, /finally \{[\s\S]*selling = false;[\s\S]*button\.disabled = false/,
    'and the button comes back on success and on failure alike');
  // The counters run after the round trip, so they must use the captured lines
  // rather than whatever the cart holds by then.
  assert.match(handler, /soldLines\.forEach/);
  assert.doesNotMatch(handler, /state\.cart\.forEach/);
  // The request id lifecycle is what the server dedupes on; it must not change.
  assert.match(handler, /pendingSaleId\(\)/);
  assert.match(handler, /clearPendingSaleId\(\)/);
});

test('the Omad browser batches new carts, defers Telegram, and has old-backend fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'omad', '12-app.js'), 'utf8');
  assert.match(source, /create_transaction_batch/);
  assert.match(source, /lines:\s*cart\.map/);
  assert.match(source, /deferReports\s*=\s*true/);
  assert.match(source, /unknown action/i);
  assert.match(source, /submitNewLedgerEntryLegacyFallback_/);
  assert.match(source, /__n\$\{cart\.length\}_\$\{i\}/);
  assert.match(source, /settleOmadWriteInBackground_/);
  assert.doesNotMatch(source, /action:\s*['"]process_jobs['"]/);
});
