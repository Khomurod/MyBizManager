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
  assert.deepStrictEqual(rows.map(row => row[1]), ['batch_req_1_0', 'batch_req_1_1', 'batch_req_1_2']);
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
  assert.strictEqual(ledger.data.length - 1, 3);

  const queue = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  assert.strictEqual(queue.data.length - 1, 1, 'retry queues no second Telegram report');
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

test('the Omad browser batches new carts, defers Telegram, and has old-backend fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'omad', '12-app.js'), 'utf8');
  assert.match(source, /create_transaction_batch/);
  assert.match(source, /lines:\s*cart\.map/);
  assert.match(source, /deferReports\s*=\s*true/);
  assert.match(source, /unknown action/i);
  assert.match(source, /submitNewLedgerEntryLegacyFallback_/);
  assert.match(source, /settleOmadWriteInBackground_/);
  assert.doesNotMatch(source, /action:\s*['"]process_jobs['"]/);
});
