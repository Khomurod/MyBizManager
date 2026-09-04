'use strict';

/**
 * Bulk entry: many business actions, one submission.
 *
 * `create_transaction_batch` is one business action with several amounts —
 * one tenant, one type, one period. This is the other axis: ten tenants
 * settling at once, expenses out of the general buckets, and tenant-paid pairs,
 * mixed freely, each keeping its own group, its own period and its own frozen
 * rates.
 *
 * The rules pinned here are the ones that make it safe to press once:
 * nothing is written unless everything validates, every row lands in a single
 * append, each entry is its own group and gets its own card, a pair inside a
 * bulk is byte-for-byte the pair the single action writes, and a retry is
 * resolved rather than re-run — refused outright if the list changed.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'bulk-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

// Two months with deliberately different rates, so an entry dated into the
// older one is visibly converted at that month's rate and not at today's.
const RATES = {
  '2026-07': { buy: 11000, sell: 11500 },
  '2026-08': { buy: 12000, sell: 12500 }
};

const TENANTS = [
  { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
  { name: 'Salon', defaultRent: 800000, currency: 'UZS', active: true },
  { name: 'Kafe', defaultRent: 500, currency: 'USD', active: true }
];

function boot(options = {}) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Tenants', JSON.stringify(options.tenants || TENANTS)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function bulk(gas, entries, overrides = {}) {
  return post(gas, Object.assign({
    action: 'create_transaction_bulk',
    requestId: 'bulk_req_1',
    source: 'Web',
    createdBy: 'tester',
    deferReports: true,
    entries: entries
  }, overrides));
}

/** Every stored ledger row, header excluded. */
function rows(gas) {
  return gas.__spreadsheet.getSheetByName('Omad_Transactions_V2')
    .getDataRange().getValues().slice(1).filter(r => r[0]);
}

function transactions(gas) {
  return rows(gas).map(r => {
    const out = {};
    LEDGER_HEADER.forEach((name, i) => { out[name] = r[i]; });
    return out;
  });
}

function queuedJobs(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0])
    .map(r => ({ jobId: r[0], relatedId: r[1], type: r[2], payload: JSON.parse(r[3]) }));
}

const RENT = { kind: 'ordinary', type: 'Income', tenant: 'Apteka', period: '2026-08', amount: 1000000, currency: 'UZS', method: 'Naqd', comment: 'Avgust ijara' };
const SALON = { kind: 'ordinary', type: 'Income', tenant: 'Salon', period: '2026-08', amount: 800000, currency: 'UZS', method: 'Bank', comment: 'Avgust ijara' };
const UTILITY = { kind: 'ordinary', type: 'Expense', tenant: 'Umumiy Naqd Puldan', period: '2026-08', amount: 250000, currency: 'UZS', method: 'Naqd', comment: 'Kommunal' };
const PAIR = { kind: 'tenant_paid', tenant: 'Apteka', period: '2026-08', amount: 300000, currency: 'UZS', method: 'Naqd', comment: 'Elektrik xizmati' };

// ------------------------------------------------------- what one submit does

test('a mixed submission lands as one append, one group per entry', () => {
  const gas = boot();
  const answer = bulk(gas, [RENT, UTILITY, PAIR, SALON]);

  assert.strictEqual(answer.status, 'success', answer.message);
  assert.strictEqual(answer.duplicate, false);
  assert.strictEqual(answer.groupIds.length, 4);

  // Four business actions, five rows: the pair is two.
  const stored = transactions(gas);
  assert.strictEqual(stored.length, 5);

  // Each entry is its own group, which is what lets a correction a month later
  // edit that one entry and its one Telegram card.
  const groups = answer.groupIds;
  assert.strictEqual(new Set(groups).size, 4, 'no two entries share a group');

  // ...and the pair's two rows share theirs.
  const pairRows = stored.filter(r => r.Entry_Group_ID === groups[2]);
  assert.strictEqual(pairRows.length, 2);
  assert.deepStrictEqual(pairRows.map(r => r.Type).sort(), ['Expense', 'Income']);

  // Every id is distinct. Ids are what a correction, a void and a delete look a
  // row up by.
  const ids = stored.map(r => r.ID);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('one card is queued per business action, not one per row and not one for the lot', () => {
  const gas = boot();
  const answer = bulk(gas, [RENT, PAIR, SALON]);
  assert.strictEqual(answer.status, 'success');

  const jobs = queuedJobs(gas).filter(j => j.type === 'omad_transaction_report');
  assert.strictEqual(jobs.length, 3);
  assert.deepStrictEqual(
    jobs.map(j => j.payload.groupId).sort(),
    answer.groupIds.slice().sort());
});

test('a tenant-paid entry inside a bulk is the pair the single action writes', () => {
  const single = boot();
  assert.strictEqual(post(single, {
    action: 'tenant_paid_expense', requestId: 'single_1', groupId: 'grp_single',
    tenant: 'Apteka', period: '2026-08', amount: 300000, currency: 'UZS',
    method: 'Naqd', comment: 'Elektrik xizmati', source: 'Web', createdBy: 'tester',
    deferReports: true
  }).status, 'success');

  const batched = boot();
  assert.strictEqual(bulk(batched, [PAIR]).status, 'success');

  // Everything except the fields that are meant to differ: the ids, the request
  // ids, the group id and the timestamp.
  const shape = tx => ({
    period: tx.Period, tenant: tx.Tenant, type: tx.Type, amount: tx.Amount,
    currency: tx.Currency, rateBuy: tx.Rate_Buy, rateSell: tx.Rate_Sell,
    rateUsed: tx.Rate_Used, rateType: tx.Rate_Type, amountUZS: tx.Amount_UZS,
    method: tx.Method, comment: tx.Comment, status: tx.Status, kind: tx.Entry_Kind
  });
  assert.deepStrictEqual(transactions(batched).map(shape), transactions(single).map(shape));
});

test('a pair inside a bulk still moves no cash', () => {
  const gas = boot();
  assert.strictEqual(bulk(gas, [PAIR]).status, 'success');

  const stored = transactions(gas);
  const income = stored.find(r => r.Type === 'Income');
  const expense = stored.find(r => r.Type === 'Expense');

  // The tenant's balance moves; the safe does not. Both halves froze the same
  // converted value, so the pair nets to exactly zero however the rate moves.
  assert.strictEqual(income.Tenant, 'Apteka');
  assert.strictEqual(expense.Tenant, 'Umumiy Naqd Puldan');
  assert.strictEqual(Number(income.Amount_UZS) - Number(expense.Amount_UZS), 0);
});

// ------------------------------------------------------------------- the money

test('each entry freezes the rates of its own month', () => {
  const gas = boot();
  const answer = bulk(gas, [
    { kind: 'ordinary', type: 'Income', tenant: 'Kafe', period: '2026-07', amount: 500, currency: 'USD', method: 'Bank', comment: 'Iyul' },
    { kind: 'ordinary', type: 'Income', tenant: 'Kafe', period: '2026-08', amount: 500, currency: 'USD', method: 'Bank', comment: 'Avgust' }
  ]);
  assert.strictEqual(answer.status, 'success', answer.message);

  const stored = transactions(gas);
  const july = stored.find(r => r.Period === '2026-07');
  const august = stored.find(r => r.Period === '2026-08');

  // This is why the batch's single shared rate pair could not be reused here:
  // settling two months at once has to use each month's own rate.
  assert.strictEqual(Number(july.Rate_Used), 11500);
  assert.strictEqual(Number(july.Amount_UZS), 500 * 11500);
  assert.strictEqual(Number(august.Rate_Used), 12500);
  assert.strictEqual(Number(august.Amount_UZS), 500 * 12500);
});

// -------------------------------------------------------------- all or nothing

test('one invalid entry rejects the whole submission and writes nothing', () => {
  const gas = boot();
  const answer = bulk(gas, [RENT, Object.assign({}, SALON, { amount: -5 }), UTILITY]);

  assert.strictEqual(answer.status, 'error');
  assert.strictEqual(answer.entryIndex, 1, 'and says which row is wrong');
  assert.strictEqual(rows(gas).length, 0, 'the two valid entries did not land');
});

test('an income to a name that is not a tenant is refused', () => {
  const gas = boot();
  // A misspelt name credits a balance nobody owes, and the debt figure is what
  // the whole application is for. One row from a dropdown survives that; fifty
  // typed into a grid do not.
  const answer = bulk(gas, [Object.assign({}, RENT, { tenant: 'Aptekaa' })]);
  assert.strictEqual(answer.status, 'error');
  assert.ok(answer.message.includes('Aptekaa'));
  assert.strictEqual(rows(gas).length, 0);

  // And an income cannot be booked against an expense bucket, which has no
  // balance to credit.
  const bucket = bulk(gas, [Object.assign({}, RENT, { tenant: 'Umumiy Naqd Puldan' })]);
  assert.strictEqual(bucket.status, 'error');
  assert.strictEqual(rows(gas).length, 0);
});

test('an expense may come out of the general buckets', () => {
  const gas = boot();
  const answer = bulk(gas, [
    UTILITY,
    { kind: 'ordinary', type: 'Expense', tenant: 'Umumiy Bankdan', period: '2026-08', amount: 90000, currency: 'UZS', method: 'Bank', comment: 'Internet' },
    { kind: 'ordinary', type: 'Expense', tenant: 'Apteka', period: '2026-08', amount: 40000, currency: 'UZS', method: 'Naqd', comment: 'Ta\'mirlash' }
  ]);
  assert.strictEqual(answer.status, 'success', answer.message);
  assert.strictEqual(rows(gas).length, 3);
});

test('an empty submission and an oversized one are both refused', () => {
  const gas = boot();
  assert.strictEqual(bulk(gas, []).status, 'error');

  const tooMany = [];
  for (let i = 0; i < gas.BULK_MAX_ENTRIES + 1; i++) tooMany.push(RENT);
  const answer = bulk(gas, tooMany);
  assert.strictEqual(answer.status, 'error');
  assert.strictEqual(rows(gas).length, 0);
});

test('the cap is a cap on entries, and a full one still writes in one go', () => {
  const gas = boot();
  const entries = [];
  for (let i = 0; i < gas.BULK_MAX_ENTRIES; i++) entries.push(PAIR);

  const answer = bulk(gas, entries);
  assert.strictEqual(answer.status, 'success', answer.message);
  // A pair is two rows, so the row cap is twice the entry cap.
  assert.strictEqual(rows(gas).length, gas.BULK_MAX_ENTRIES * 2);
  assert.strictEqual(new Set(answer.groupIds).size, gas.BULK_MAX_ENTRIES);
});

test('a submission is refused outright when the ledger is not live', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify(RATES)], ['Omad_Tenants', JSON.stringify(TENANTS)]],
      Omad_Transactions: [['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment', 'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind']]
    }
  });
  const answer = bulk(gas, [RENT]);
  assert.strictEqual(answer.status, 'error');
  assert.ok(answer.message.includes("ko'chiring"));
});

// ------------------------------------------------------------------ retrying

test('the same submission sent twice writes once', () => {
  const gas = boot();
  const first = bulk(gas, [RENT, PAIR, SALON]);
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(rows(gas).length, 4);

  const second = bulk(gas, [RENT, PAIR, SALON]);
  assert.strictEqual(second.status, 'success');
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(rows(gas).length, 4, 'nothing was added');
  assert.deepStrictEqual(second.groupIds, first.groupIds, 'and it is the same entry');

  // A resolved retry queues no second round of cards.
  assert.strictEqual(queuedJobs(gas).filter(j => j.type === 'omad_transaction_report').length, 3);
});

test('a retry whose list has changed is refused, not reinterpreted', () => {
  const gas = boot();
  assert.strictEqual(bulk(gas, [RENT, SALON]).status, 'success');
  const before = rows(gas).length;

  // A changed amount on the same request id: the person edited the grid and
  // pressed again after an uncertain answer.
  const edited = bulk(gas, [RENT, Object.assign({}, SALON, { amount: 900000 })]);
  assert.strictEqual(edited.status, 'error');
  assert.strictEqual(edited.code, 'bulk_retry_conflict');

  // A shorter list carrying the same id claims to be the same submission and
  // is not: the count is part of the key.
  const shortened = bulk(gas, [RENT]);
  assert.strictEqual(shortened.status, 'error');
  assert.strictEqual(shortened.code, 'bulk_retry_conflict');

  // A different kind at the same position is a different submission too.
  const reshaped = bulk(gas, [RENT, PAIR]);
  assert.strictEqual(reshaped.status, 'error');
  assert.strictEqual(reshaped.code, 'bulk_retry_conflict');

  assert.strictEqual(rows(gas).length, before, 'and none of that wrote anything');
});

test('a submission interrupted halfway resumes only what is missing', () => {
  const gas = boot();
  const doc = gas.__spreadsheet;

  // Exactly what a connection dropped mid-append leaves behind: entry 0 stored,
  // entries 1 and 2 never written.
  const partial = gas.createTransactionBulk_(doc, {
    requestId: 'bulk_resume', source: 'Web', createdBy: 'tester', entries: [RENT]
  });
  assert.strictEqual(partial.status, 'success');
  // Re-file it under the three-entry key the full submission would have used.
  const sheet = doc.getSheetByName('Omad_Transactions_V2');
  sheet.getRange(2, 2).setValue('bulk_resume__b3_0');

  const resumed = gas.createTransactionBulk_(doc, {
    requestId: 'bulk_resume', source: 'Web', createdBy: 'tester',
    entries: [RENT, SALON, PAIR]
  });
  assert.strictEqual(resumed.status, 'success', resumed.message);
  assert.strictEqual(resumed.resumed, true);
  assert.strictEqual(resumed.duplicate, false);

  // One row for the entry that was already there, plus one and two for the ones
  // that were not — never a second copy of the first.
  assert.strictEqual(rows(gas).length, 4);
  assert.strictEqual(resumed.groupIds[0], partial.groupIds[0], 'the stored entry kept its group');
  assert.strictEqual(new Set(resumed.groupIds).size, 3);
});

test('a voided row does not count as already written', () => {
  const gas = boot();
  assert.strictEqual(bulk(gas, [RENT]).status, 'success');

  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  sheet.getRange(2, 19).setValue(gas.TX_STATUS_VOID);

  const again = bulk(gas, [RENT]);
  assert.strictEqual(again.status, 'success');
  assert.strictEqual(again.duplicate, false, 'a voided attempt is written again');
  assert.strictEqual(rows(gas).length, 2);
});

// -------------------------------------------------------------- authorization

test('the bulk action needs the owner\'s role', () => {
  const gas = boot();
  const refused = readJsonOutput(gas.doPost(postEvent({
    action: 'create_transaction_bulk', requestId: 'nope', entries: [RENT]
  })));
  // Refused by the gate, not by a validator that happened to trip first.
  assert.strictEqual(refused.code, 'auth');
  assert.strictEqual(rows(gas).length, 0);

  const wrongKey = readJsonOutput(gas.doPost(postEvent({
    action: 'create_transaction_bulk', adminKey: 'not-the-key', requestId: 'nope', entries: [RENT]
  })));
  assert.strictEqual(wrongKey.code, 'auth');
  assert.strictEqual(rows(gas).length, 0);
});
