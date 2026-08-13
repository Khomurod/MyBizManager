'use strict';

/**
 * The materialised Omad read model.
 *
 * The dashboard and the Mini App's first screen used to be a full pass over the
 * historical ledger, every time either was opened. The model stores the answer
 * against the ledger's own revision, so the pass happens once per write rather
 * than once per look.
 *
 * Two properties are what make that safe, and both are asserted here rather
 * than argued for:
 *
 *   1. **It is the ledger's own arithmetic.** Every figure it holds has to
 *      equal what `calculateActuals_` / `calculateTenantPaid_` produce from the
 *      rows — period by period and tenant by tenant. A summary that is faster
 *      and different is simply wrong.
 *   2. **It is derived, never authoritative.** Creating, correcting and
 *      cancelling all have to move it; deleting it entirely has to cost one
 *      rebuild and nothing else; and poisoning it must not be able to reach a
 *      stored financial record.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'read-model-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const TENANTS = [
  { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
  { name: 'Tehnopark', defaultRent: 500, currency: 'USD', active: true },
  { name: "O'quv Markaz", defaultRent: 2000000, currency: 'UZS', active: true }
];

/** Three periods, three tenants, both currencies and both methods. */
function ledgerRows() {
  const rows = [];
  const periods = ['2026-06', '2026-07', '2026-08'];
  let n = 0;
  periods.forEach((period, p) => {
    TENANTS.forEach((tenant, t) => {
      n++;
      rows.push([
        `17500000${String(100 + n).padStart(5, '0')}_0`, tenant.name, period, 'Income',
        t === 1 ? 400 : 900000 + t * 1000, t === 1 ? 'USD' : 'UZS',
        t % 2 === 0 ? 'Naqd' : 'Bank',
        `1${p + 2}/0${p + 6}/2026`, 'ijara', '', `req_${n}`, `grp_${n}`, ''
      ]);
    });
    n++;
    rows.push([
      `17500000${String(100 + n).padStart(5, '0')}_0`, 'Kommunal', period, 'Expense',
      250000, 'UZS', 'Bank', `20/0${p + 6}/2026`, 'svet', '', `req_${n}`, `grp_${n}`, ''
    ]);
  });
  return rows;
}

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({
          '2026-06': { buy: 12000, sell: 12500 },
          '2026-07': { buy: 12100, sell: 12600 },
          '2026-08': { buy: 12200, sell: 12700 }
        })],
        ['Omad_Tenants', JSON.stringify(TENANTS)],
        ['Omad_Template_Expenses', '[]']
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(ledgerRows())
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

/** Boots and cuts over to the append-only ledger, as production is. */
function bootOnLedger() {
  const gas = boot();
  assert.strictEqual(post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 }).status, 'success');
  assert.strictEqual(post(gas, { action: 'cutover_omad_migration' }).status, 'success');
  return gas;
}

function countLedgerReads(gas, run) {
  let count = 0;
  const restore = [];
  gas.__spreadsheet.getSheets().forEach(sheet => {
    if (sheet.getName() !== 'Omad_Transactions_V2') return;
    const original = sheet.getDataRange;
    restore.push(() => { sheet.getDataRange = original; });
    sheet.getDataRange = function () {
      const range = original.call(sheet);
      const inner = range.getValues;
      range.getValues = function () { count++; return inner.call(range); };
      return range;
    };
  });
  try { run(); } finally { restore.forEach(fn => fn()); }
  return count;
}

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_q',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

// ------------------------------------------------------------- it is the ledger

test('every figure in the model is the figure the full ledger pass gives', () => {
  const gas = bootOnLedger();
  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  // Round-tripped through JSON because objects built inside the harness's VM
  // realm have a different prototype, which deepStrictEqual rejects.
  const model = JSON.parse(JSON.stringify(gas.omadReadModel_(gas.__spreadsheet, configSheet)));
  const transactions = gas.readOmadTransactions_(gas.__spreadsheet);

  const allTime = gas.calculateActuals_(transactions, '');
  assert.deepStrictEqual(model.balances,
    { cash: allTime.cash, bank: allTime.bank, total: allTime.total },
    'the all-time balances are the all-time balances');

  assert.deepStrictEqual(model.periodList, ['2026-06', '2026-07', '2026-08']);

  model.periodList.forEach(period => {
    const actuals = gas.calculateActuals_(transactions, period);
    assert.strictEqual(model.periods[period].income, actuals.income, `${period} income`);
    assert.strictEqual(model.periods[period].expense, actuals.expense, `${period} expense`);
    assert.strictEqual(model.periods[period].net, actuals.net, `${period} net`);

    TENANTS.forEach(tenant => {
      assert.strictEqual(
        model.periods[period].paid[tenant.name] || 0,
        gas.calculateTenantPaid_(transactions, tenant.name, period),
        `${tenant.name} in ${period} disagrees with the per-tenant calculation`);
    });
  });
});

test('the Mini App answers the same figures from the model as from the ledger', () => {
  const gas = bootOnLedger();
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_home', initData: signedInitData(), period: '2026-07'
  })));

  const transactions = gas.readOmadTransactions_(gas.__spreadsheet);
  const actuals = gas.calculateActuals_(transactions, '2026-07');

  assert.strictEqual(body.omad.income, actuals.income);
  assert.strictEqual(body.omad.expense, actuals.expense);
  assert.strictEqual(body.omad.net, actuals.net);
  assert.strictEqual(body.omad.cash, actuals.cash);
  assert.strictEqual(body.omad.bank, actuals.bank);
  assert.strictEqual(body.omad.total, actuals.total);

  body.tenants.forEach(row => {
    assert.strictEqual(row.paid,
      gas.calculateTenantPaid_(transactions, row.name, '2026-07'),
      `${row.name} paid disagrees with the per-tenant calculation`);
  });
});

// --------------------------------------------------------------- it is faster

test('the dashboard sends no transaction history and reads the ledger once', () => {
  const gas = bootOnLedger();

  let body;
  const reads = countLedgerReads(gas, () => {
    body = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  });

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.historyMode, 'paged');
  assert.strictEqual(body.transactions, undefined, 'the ledger does not go down the wire');
  assert.ok(body.summary && body.summary.periods, 'the figures do');
  assert.ok(Array.isArray(body.recent) && body.recent.length > 0, 'and a small recent list');
  assert.strictEqual(reads, 1, 'one pass builds the model');
});

test('a second dashboard load does not touch the ledger at all', () => {
  const gas = bootOnLedger();
  post(gas, { action: 'get_omad_data', scope: 'dashboard' });

  let body;
  const reads = countLedgerReads(gas, () => {
    body = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  });

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(reads, 0, 'the stored model answers it');
  assert.ok(body.summary.periods['2026-08'], 'and it is still a complete answer');
});

test('opening the Mini App twice reads the ledger once', () => {
  const gas = bootOnLedger();
  const initData = signedInitData();
  post(gas, { action: 'get_omad_data', scope: 'dashboard' });   // model warm

  const reads = countLedgerReads(gas, () => {
    const body = readJsonOutput(gas.doPost(postEvent({ action: 'mini_home', initData, period: '2026-08' })));
    assert.strictEqual(body.status, 'success');
  });
  assert.strictEqual(reads, 0);
});

// -------------------------------------------------------- writes move it

test('a new entry makes the stored model unreachable and the next read is right', () => {
  const gas = bootOnLedger();
  const before = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  const beforeIncome = before.summary.periods['2026-08'].income;

  const created = post(gas, {
    action: 'create_transaction', requestId: 'rm_new_1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 250000, currency: 'UZS', method: 'Naqd',
    comment: 'qo\'shimcha'
  });
  assert.strictEqual(created.status, 'success', created.message);

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.summary.periods['2026-08'].income, beforeIncome + 250000);
  assert.strictEqual(after.summary.periods['2026-08'].paid.Apteka,
    gas.calculateTenantPaid_(gas.readOmadTransactions_(gas.__spreadsheet), 'Apteka', '2026-08'));
  assert.strictEqual(after.recent[0].tenant, 'Apteka', 'and it leads the recent list');
});

test('a correction moves the summary by the difference, not by the whole amount', () => {
  const gas = bootOnLedger();
  const created = post(gas, {
    action: 'create_transaction', requestId: 'rm_c_1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 300000, currency: 'UZS', method: 'Naqd'
  });
  const base = post(gas, { action: 'get_omad_data', scope: 'dashboard' })
    .summary.periods['2026-08'].income;

  const corrected = post(gas, {
    action: 'correct_transaction', transactionId: created.transaction.id,
    requestId: 'rm_c_2', amount: 100000, currency: 'UZS', method: 'Naqd',
    period: '2026-08', tenant: 'Apteka', type: 'Income', reason: 'typo'
  });
  assert.strictEqual(corrected.status, 'success', corrected.message);

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.summary.periods['2026-08'].income, base - 200000,
    'the corrected original is excluded and only the replacement counts');
  assert.strictEqual(after.summary.periods['2026-08'].income,
    gas.calculateActuals_(gas.readOmadTransactions_(gas.__spreadsheet), '2026-08').income);
});

test('a cancellation removes its amount from the summary', () => {
  const gas = bootOnLedger();
  const created = post(gas, {
    action: 'create_transaction', requestId: 'rm_x_1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 777000, currency: 'UZS', method: 'Naqd'
  });
  const withIt = post(gas, { action: 'get_omad_data', scope: 'dashboard' })
    .summary.periods['2026-08'].income;

  assert.strictEqual(post(gas, {
    action: 'cancel_transaction', transactionId: created.transaction.id,
    requestId: 'rm_x_2', reason: 'test'
  }).status, 'success');

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.summary.periods['2026-08'].income, withIt - 777000);
  assert.strictEqual(after.summary.balances.cash,
    gas.calculateActuals_(gas.readOmadTransactions_(gas.__spreadsheet), '').cash);
});

test('a rate change does not move a frozen ledger figure', () => {
  const gas = bootOnLedger();
  const before = post(gas, { action: 'get_omad_data', scope: 'dashboard' })
    .summary.periods['2026-08'].income;

  assert.strictEqual(post(gas, {
    action: 'save_omad', rates: { '2026-08': { buy: 20000, sell: 21000 } }
  }).status, 'success');

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.summary.periods['2026-08'].income, before,
    'every V2 row carries the rate it was written at');
});

// ------------------------------------------------------- it fails towards the ledger

test('deleting the stored model costs one rebuild and nothing else', () => {
  const gas = bootOnLedger();
  const expected = post(gas, { action: 'get_omad_data', scope: 'dashboard' }).summary;

  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  gas.setConfig(configSheet, 'Omad_Read_Model', '');

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.deepStrictEqual(after.summary.periods, expected.periods);
  assert.deepStrictEqual(after.summary.balances, expected.balances);
});

test('an unparsable stored model is rebuilt rather than trusted', () => {
  const gas = bootOnLedger();
  const expected = post(gas, { action: 'get_omad_data', scope: 'dashboard' }).summary;

  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  gas.setConfig(configSheet, 'Omad_Read_Model', '{not json');

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.deepStrictEqual(after.summary.periods, expected.periods);
});

test('a poisoned model cannot reach a stored financial record', () => {
  const gas = bootOnLedger();
  post(gas, { action: 'get_omad_data', scope: 'dashboard' });

  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  const poisoned = JSON.parse(gas.getConfig(configSheet, 'Omad_Read_Model'));
  poisoned.balances = { cash: -999999999, bank: -999999999, total: -1999999998 };
  poisoned.periods['2026-08'].income = 1;
  gas.setConfig(configSheet, 'Omad_Read_Model', JSON.stringify(poisoned));

  // The write path reads the sheets, so the record it stores is unaffected.
  const created = post(gas, {
    action: 'create_transaction', requestId: 'rm_p_1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 123000, currency: 'UZS', method: 'Naqd'
  });
  assert.strictEqual(created.status, 'success', created.message);
  assert.strictEqual(created.transaction.amountUZS, 123000);

  // ...and the write bumped the revision, so the poison is unreachable.
  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.summary.periods['2026-08'].income,
    gas.calculateActuals_(gas.readOmadTransactions_(gas.__spreadsheet), '2026-08').income);
});

test('verify reports a summary that disagrees with the ledger, and rebuild fixes it', () => {
  const gas = bootOnLedger();
  post(gas, { action: 'get_omad_data', scope: 'dashboard' });

  assert.strictEqual(post(gas, { action: 'verify_omad_read_model' }).readModel.ok, true);

  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  const poisoned = JSON.parse(gas.getConfig(configSheet, 'Omad_Read_Model'));
  poisoned.periods['2026-07'].income = 42;
  poisoned.periods['2026-07'].paid.Apteka = 7;
  gas.setConfig(configSheet, 'Omad_Read_Model', JSON.stringify(poisoned));

  const verified = post(gas, { action: 'verify_omad_read_model' }).readModel;
  assert.strictEqual(verified.ok, false);
  assert.ok(verified.differences.some(d => d.field === '2026-07.income'));
  assert.ok(verified.differences.some(d => d.field === '2026-07.paid.Apteka'));

  assert.strictEqual(post(gas, { action: 'rebuild_omad_read_model' }).status, 'success');
  assert.strictEqual(post(gas, { action: 'verify_omad_read_model' }).readModel.ok, true);
});

test('the read model actions are omad_admin only', () => {
  const gas = bootOnLedger();
  ['verify_omad_read_model', 'rebuild_omad_read_model', 'get_omad_history'].forEach(action => {
    const body = readJsonOutput(gas.doPost(postEvent({ action })));
    assert.strictEqual(body.status, 'error', `${action} answered without a credential`);
    assert.strictEqual(body.authExpired, true);
  });
});

// ---------------------------------------------------------------- paged history

test('history arrives a page of business actions at a time, newest first', () => {
  const gas = bootOnLedger();

  const first = post(gas, { action: 'get_omad_history', limit: 4 });
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.groupCount, 4);
  assert.strictEqual(first.groupTotal, 12, 'twelve business actions in the fixture');
  assert.strictEqual(first.hasMore, true);
  assert.strictEqual(first.transactions[0].period, '2026-08', 'newest period first');

  const second = post(gas, { action: 'get_omad_history', offset: 4, limit: 4 });
  const firstIds = first.transactions.map(t => t.id);
  const secondIds = second.transactions.map(t => t.id);
  assert.ok(secondIds.every(id => firstIds.indexOf(id) === -1), 'pages do not overlap');

  const last = post(gas, { action: 'get_omad_history', offset: 8, limit: 4 });
  assert.strictEqual(last.hasMore, false);

  const seen = firstIds.concat(secondIds, last.transactions.map(t => t.id)).sort();
  const all = Array.from(gas.readOmadTransactions_(gas.__spreadsheet)).map(t => t.id).sort();
  assert.deepStrictEqual(seen, all, 'the pages together are the whole ledger');
});

test('a history page never splits a business action', () => {
  const gas = bootOnLedger();
  const pair = post(gas, {
    action: 'tenant_paid_expense', requestId: 'rm_pair_1', tenant: 'Apteka',
    period: '2026-08', amount: 400000, currency: 'UZS', method: 'Naqd',
    comment: 'svet uchun'
  });
  assert.strictEqual(pair.status, 'success', pair.message);

  const page = post(gas, { action: 'get_omad_history', limit: 1 });
  assert.strictEqual(page.groupCount, 1);
  assert.strictEqual(page.transactions.length, 2, 'both halves of the pair travel together');
  assert.strictEqual(page.transactions[0].groupId, page.transactions[1].groupId);
});

test('a history page can be scoped to one period', () => {
  const gas = bootOnLedger();
  const page = post(gas, { action: 'get_omad_history', period: '2026-06', limit: 50 });
  assert.strictEqual(page.groupTotal, 4);
  assert.ok(page.transactions.every(t => t.period === '2026-06'));
});

// ------------------------------------------------------------------- legacy path

test('before cutover the dashboard still answers with the whole list', () => {
  // The legacy save path submits the entire transaction list back, so a screen
  // that may have to write it must be holding all of it.
  const gas = boot();
  const body = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(body.historyMode, 'full');
  assert.ok(Array.isArray(body.transactions) && body.transactions.length === 12);
  assert.strictEqual(body.summary, undefined);
});

test('the unscoped read is unchanged', () => {
  const gas = bootOnLedger();
  const body = post(gas, { action: 'get_omad_data' });
  assert.ok(Array.isArray(body.transactions) && body.transactions.length > 0);
  assert.ok(body.migration && body.tenants && body.rates);
});

test('a model built for the legacy sheet is not reused after cutover', () => {
  const gas = boot();
  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');
  // Build one while the legacy sheet is active.
  const legacyModel = gas.omadReadModel_(gas.__spreadsheet, configSheet);
  assert.strictEqual(legacyModel.source, 'Omad_Transactions');

  post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
  assert.strictEqual(post(gas, { action: 'cutover_omad_migration' }).status, 'success');

  const after = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(after.historyMode, 'paged');
  assert.strictEqual(
    after.summary.periods['2026-08'].income,
    gas.calculateActuals_(gas.readOmadTransactions_(gas.__spreadsheet), '2026-08').income);
});
