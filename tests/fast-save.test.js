'use strict';

/**
 * Fast saving: the confirmation comes back as soon as the financial record is
 * safely stored. Reporting is queued and never blocks the response.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const ADMIN_KEY = 'correct-admin-key';

const LEDGER_HEADER_ROW = [[
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version'
]];

function boot(options = {}) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-01': { buy: 12000, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: LEDGER_HEADER_ROW
    },
    ...options
  });
}

function input(overrides = {}) {
  return {
    action: 'create_transaction',
    requestId: 'req-1',
    period: '2026-01',
    tenant: 'Tehnopark',
    type: 'Income',
    amount: 1000000,
    currency: 'UZS',
    method: 'Naqd',
    comment: '',
    ...overrides
  };
}

function activeCount(gas) {
  return gas.listActiveTransactions_(gas.__spreadsheet, {}).length;
}

function queueRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

// ------------------------------------------------- essential vs non-essential

test('the financial record is stored before anything else happens', () => {
  const gas = boot({ fetch: () => { throw new Error('Telegram is unreachable'); } });

  const body = readJsonOutput(gas.doPost(postEvent(input())));

  assert.strictEqual(body.status, 'success', 'the caller is confirmed');
  assert.strictEqual(activeCount(gas), 1, 'the transaction is stored');
  assert.strictEqual(queueRows(gas)[0][4], 'Pending', 'the report is retried later');
});

test('at most one queued job rides along with a save', () => {
  const gas = boot({
    fetch: () => ({ getResponseCode: () => 502, getContentText: () => 'bad gateway' })
  });

  // Three transactions leave three pending reports.
  for (let i = 0; i < 3; i++) {
    gas.doPost(postEvent(input({ requestId: 'req-' + i })));
  }
  assert.strictEqual(queueRows(gas).filter(r => r[4] === 'Pending').length, 3);

  // A save never drains more than one, so the response time does not grow with
  // the size of the backlog.
  assert.strictEqual(gas.JOB_QUEUE_INLINE_BATCH, 1);
});

test('deferReports skips the inline drain entirely', () => {
  const gas = boot();

  const body = readJsonOutput(gas.doPost(postEvent(input({ deferReports: true }))));
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(activeCount(gas), 1);
  assert.deepStrictEqual(gas.__sentMessages, [], 'nothing was sent inline');
  assert.strictEqual(queueRows(gas)[0][4], 'Pending', 'the trigger will pick it up');
});

test('the trigger entry point drains the whole backlog', () => {
  let telegramDown = true;
  const gas = boot({
    fetch: () => (telegramDown
      ? { getResponseCode: () => 502, getContentText: () => 'bad gateway' }
      : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { message_id: 7 } }) })
  });

  for (let i = 0; i < 4; i++) gas.doPost(postEvent(input({ requestId: 'req-' + i })));
  telegramDown = false;

  // Make every retry due.
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    sheet.getRange(row, 7).setValue(new Date(0).toISOString());
  }

  assert.strictEqual(gas.processPendingTelegramJobs(), 4);
  assert.strictEqual(queueRows(gas).filter(r => r[4] === 'Completed').length, 4);
});

// -------------------------------------------------------------- idempotency

test('a browser refresh mid-save does not create a second transaction', () => {
  const gas = boot();

  // The first submit reaches the server. The browser is refreshed before the
  // response lands, and resubmits with the same request id from sessionStorage.
  gas.doPost(postEvent(input({ requestId: 'web_1700_abc_0' })));
  const resubmit = readJsonOutput(gas.doPost(postEvent(input({ requestId: 'web_1700_abc_0' }))));

  assert.strictEqual(resubmit.status, 'success');
  assert.strictEqual(resubmit.duplicate, true);
  assert.strictEqual(activeCount(gas), 1);
});

test('a duplicate submission queues no second report', () => {
  const gas = boot();

  gas.doPost(postEvent(input({ requestId: 'same' })));
  const before = queueRows(gas).length;
  gas.doPost(postEvent(input({ requestId: 'same' })));

  assert.strictEqual(queueRows(gas).length, before, 'the group is not reported twice');
});

test('two simultaneous submissions of different entries both land', () => {
  const gas = boot();

  const a = readJsonOutput(gas.doPost(postEvent(input({ requestId: 'tab-a', amount: 100000 }))));
  const b = readJsonOutput(gas.doPost(postEvent(input({ requestId: 'tab-b', amount: 200000 }))));

  assert.notStrictEqual(a.transaction.id, b.transaction.id);
  assert.strictEqual(activeCount(gas), 2);
});

// ------------------------------------------------------ temporary failures

test('an Apps Script write failure surfaces as an error, not a silent success', () => {
  const gas = boot();
  // Simulate the sheet becoming unwritable mid-request. Ledger rows are
  // written through a range so the column formats can be applied first, so
  // that is where an Apps Script outage surfaces.
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  sheet.appendRow = () => { throw new Error('Service Spreadsheets timed out'); };
  sheet.getRange = () => { throw new Error('Service Spreadsheets timed out'); };

  const body = readJsonOutput(gas.doPost(postEvent(input({ requestId: 'r1' }))));

  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /timed out/);
  assert.strictEqual(queueRows(gas).length, 0, 'no report is queued for a save that failed');
});

test('a queue write failure does not fail the transaction', () => {
  const gas = boot();
  const original = gas.__spreadsheet.insertSheet;
  gas.__spreadsheet.insertSheet = name => {
    if (name === 'Omad_Job_Queue') throw new Error('cannot create sheet');
    return original.call(gas.__spreadsheet, name);
  };

  const body = readJsonOutput(gas.doPost(postEvent(input({ requestId: 'r1' }))));

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(activeCount(gas), 1, 'the money is recorded even if reporting cannot be queued');
});

test('the queue status is visible without the admin key', () => {
  const gas = boot({
    fetch: () => ({ getResponseCode: () => 502, getContentText: () => 'bad gateway' })
  });
  gas.doPost(postEvent(input({ requestId: 'r1' })));

  const status = readJsonOutput(gas.doPost(postEvent({ action: 'get_job_queue_status' })));
  assert.strictEqual(status.queue.counts.pending, 1);
  assert.strictEqual(status.queue.counts.failed, 0);
});
