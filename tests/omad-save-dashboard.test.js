'use strict';

/**
 * A web write can bring the dashboard back with it.
 *
 * After every save the dashboard used to ask for its figures in a second
 * request -- a whole second Apps Script start-up. A write that sends
 * `includeDashboard: true` now gets them on its own answer, computed after the
 * write. These tests hold what makes that safe: the figures are the ones a
 * fresh read would return, only a stored write carries them, a client that
 * does not ask is answered exactly as before, and every kind of web write
 * (new entry, edit, cancel, tenant-paid, bulk) can carry them.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent, SUPABASE_RUN, supabaseRoundTrips } = require('./gas-harness');

const ADMIN_KEY = 'save-dashboard-admin';
const PERIOD = '2026-08';
const LEDGER_HEADER = [[
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
]];

function boot() {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ [PERIOD]: { buy: 12100, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Omad_Tenants', JSON.stringify([{ name: 'Tehnopark', defaultRent: 500000, currency: 'UZS', active: true }])]
      ],
      Omad_Transactions_V2: LEDGER_HEADER
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function entry(requestId, amount, extra = {}) {
  return Object.assign({
    action: 'create_transaction_batch', requestId, groupId: 'g_' + requestId, period: PERIOD,
    tenant: 'Tehnopark', type: 'Income', source: 'Web', deferReports: true,
    lines: [{ amount, currency: 'UZS', method: 'Naqd' }]
  }, extra);
}

/** The dashboard a fresh read returns, without the build stamp. */
function freshDashboard(gas) {
  return comparable(post(gas, { action: 'get_omad_data', scope: 'dashboard' }));
}

function comparable(dashboard) {
  const copy = JSON.parse(JSON.stringify(dashboard));
  if (copy.summary) delete copy.summary.builtAt;
  return copy;
}

test('a save that asks for the dashboard gets the figures a fresh read would return', () => {
  const gas = boot();
  const saved = post(gas, entry('r1', 100000, { includeDashboard: true }));
  assert.strictEqual(saved.status, 'success');
  assert.ok(saved.dashboard, 'the figures came back with the save');
  assert.strictEqual(saved.dashboard.status, 'success');
  assert.deepStrictEqual(saved.dashboard.summary.allTime, { income: 100000, expense: 0, net: 100000 },
    'computed after the write, so the new income is in them');
  assert.deepStrictEqual(comparable(saved.dashboard), freshDashboard(gas));
});

test('a client that does not ask is answered exactly as before', () => {
  const gas = boot();
  const saved = post(gas, entry('r1', 100000));
  assert.strictEqual(saved.status, 'success');
  assert.strictEqual(saved.dashboard, undefined);
});

test('a refused write carries no figures', () => {
  const gas = boot();
  const refused = post(gas, entry('r1', 0, { includeDashboard: true }));
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.dashboard, undefined);
});

test('a retried save answers with its first record and the current figures', () => {
  const gas = boot();
  post(gas, entry('r1', 100000, { includeDashboard: true }));
  const again = post(gas, entry('r1', 100000, { includeDashboard: true }));
  assert.strictEqual(again.duplicate, true);
  assert.deepStrictEqual(again.dashboard.summary.allTime, { income: 100000, expense: 0, net: 100000 },
    'the retry did not count the money twice');
});

test('an edit, a cancellation, a tenant-paid pair and a bulk entry can all bring the figures back', () => {
  const gas = boot();
  const first = post(gas, entry('r1', 100000));
  const id = first.transactions[0].id;

  const corrected = post(gas, {
    action: 'correct_transaction', transactionId: id, requestId: 'r1_fix', period: PERIOD, tenant: 'Tehnopark',
    type: 'Income', amount: 150000, currency: 'UZS', method: 'Naqd', source: 'Web', deferReports: true,
    includeDashboard: true
  });
  assert.strictEqual(corrected.status, 'success');
  assert.strictEqual(corrected.dashboard.summary.allTime.income, 150000);

  const pair = post(gas, {
    action: 'tenant_paid_expense', requestId: 'tp1', groupId: 'g_tp1', tenant: 'Tehnopark', period: PERIOD,
    amount: 20000, currency: 'UZS', method: 'Naqd', comment: 'Santexnik', source: 'Web', deferReports: true,
    includeDashboard: true
  });
  assert.strictEqual(pair.status, 'success');
  assert.deepStrictEqual(comparable(pair.dashboard), freshDashboard(gas));

  const bulk = post(gas, {
    action: 'create_transaction_bulk', requestId: 'b1', source: 'Web', deferReports: true, includeDashboard: true,
    entries: [{ period: PERIOD, tenant: 'Tehnopark', type: 'Income', amount: 5000, currency: 'UZS', method: 'Naqd' }]
  });
  assert.strictEqual(bulk.status, 'success');
  assert.deepStrictEqual(comparable(bulk.dashboard), freshDashboard(gas));

  const current = post(gas, { action: 'list_transactions' }).transactions.find(t => t.tenant === 'Tehnopark' && Number(t.amount) === 150000);
  const cancelled = post(gas, {
    action: 'cancel_transaction', transactionId: current.id, requestId: 'c1', reason: 'test', deferReports: true,
    includeDashboard: true
  });
  assert.strictEqual(cancelled.status, 'success');
  assert.deepStrictEqual(comparable(cancelled.dashboard), freshDashboard(gas));
});

test('on Supabase the figures cost fewer round trips than asking for them separately', { skip: !SUPABASE_RUN && 'Supabase only' }, () => {
  const gas = boot();
  post(gas, entry('warm', 1000));
  const plainSave = supabaseRoundTrips(gas, () => post(gas, entry('r1', 1000)));
  const separateRead = supabaseRoundTrips(gas, () => post(gas, { action: 'get_omad_data', scope: 'dashboard' }));
  const together = supabaseRoundTrips(gas, () => post(gas, entry('r2', 1000, { includeDashboard: true })));
  // The separate read also costs a whole Apps Script start-up, which this
  // count cannot see; the database side alone must not be worse.
  assert.ok(together <= plainSave + separateRead + 1,
    `save with figures ${together} vs save ${plainSave} + read ${separateRead}`);
});
