'use strict';

/**
 * "The tenant paid one of our bills."
 *
 * One operation, two linked accounting rows, one group, one report. The rules
 * being pinned: the pair is atomic, it nets to zero cash, it credits the
 * tenant, a retry cannot produce a second pair, and editing or cancelling it
 * always acts on both halves.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'tenant-paid-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

const RATES = { '2026-08': { buy: 12000, sell: 12500 } };
const TENANTS = [{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }];

function boot(options = {}) {
  const sheets = {
    System_Config: [
      ['Omad_Rates', JSON.stringify(RATES)],
      ['Omad_Tenants', JSON.stringify(TENANTS)],
      ...(options.ledger ? [['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']] : [])
    ]
  };
  if (options.ledger) sheets.Omad_Transactions_V2 = [LEDGER_HEADER];
  else sheets.Omad_Transactions = [LEGACY_HEADER];

  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets,
    fetch: options.fetch
  });
}

function payload(overrides = {}) {
  return Object.assign({
    action: 'tenant_paid_expense',
    requestId: 'web_req_1',
    groupId: 'grp_web_pair_1',
    tenant: 'Apteka',
    period: '2026-08',
    amount: 1000000,
    currency: 'UZS',
    method: 'Naqd',
    comment: 'Elektrik xizmati',
    source: 'Web',
    createdBy: 'tester',
    deferReports: true
  }, overrides);
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

test('one request writes a linked income and expense under one group', () => {
  const gas = boot();
  const response = post(gas, payload());

  assert.equal(response.status, 'success');
  assert.equal(response.duplicate, false);
  assert.equal(response.transactions.length, 2);

  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.length, 2);

  const income = rows.find(r => r.type === 'Income');
  const expense = rows.find(r => r.type === 'Expense');

  assert.equal(income.tenant, 'Apteka');
  assert.equal(income.amount, 1000000);
  assert.equal(expense.tenant, 'Umumiy Naqd Puldan');
  assert.equal(expense.amount, 1000000);

  // One group, one kind, two ids.
  assert.equal(income.groupId, 'grp_web_pair_1');
  assert.equal(expense.groupId, 'grp_web_pair_1');
  assert.equal(income.entryKind, 'tenant_paid_expense');
  assert.notEqual(income.id, expense.id);
});

test('the purpose survives on both halves, readable on its own', () => {
  const gas = boot();
  post(gas, payload());

  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  const income = rows.find(r => r.type === 'Income');
  const expense = rows.find(r => r.type === 'Expense');

  assert.ok(income.comment.includes('Elektrik xizmati'));
  assert.ok(income.comment.includes("nomimizdan"));
  assert.ok(expense.comment.includes('Elektrik xizmati'));
  assert.ok(expense.comment.includes('Apteka'), 'the expense names who settled it');
});

test('the tenant is credited and the company cash does not move', () => {
  const gas = boot();
  post(gas, payload());

  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  const actuals = gas.calculateActuals_(rows, '2026-08');

  // Income and expense of the same size, same method: cash is unchanged.
  assert.equal(actuals.cash, 0);
  assert.equal(actuals.bank, 0);
  assert.equal(actuals.total, 0);
  assert.equal(actuals.net, 0);
  // Both sides are still reported, rather than netted away into nothing.
  assert.equal(actuals.income, 1000000);
  assert.equal(actuals.expense, 1000000);

  const balances = gas.calculateBalancesFromTransactions_(rows, '2026-08');
  assert.equal(balances.allTimeBalance, 0);
  assert.equal(balances.monthBalance, 0);

  // But the tenant has paid.
  assert.equal(gas.calculateTenantPaid_(rows, 'Apteka', '2026-08'), 1000000);
});

test('a Bank payment books the expense against the bank, still netting to zero', () => {
  const gas = boot();
  post(gas, payload({ method: 'Bank' }));

  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.find(r => r.type === 'Expense').tenant, 'Umumiy Bankdan');

  const actuals = gas.calculateActuals_(rows, '2026-08');
  assert.equal(actuals.bank, 0);
  assert.equal(actuals.cash, 0);
  assert.equal(gas.calculateTenantPaid_(rows, 'Apteka', '2026-08'), 1000000);
});

test('both rows land in a single spreadsheet write, so the pair cannot be half-created', () => {
  const gas = boot();
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');

  const widths = [];
  const originalGetRange = sheet.getRange;
  sheet.getRange = function (...args) {
    const range = originalGetRange.apply(sheet, args);
    const originalSetValues = range.setValues;
    range.setValues = function (values) {
      if (values.length > 1 || (values[0] && values[0][0] && String(values[0][0]).indexOf('_') !== -1)) {
        widths.push(values.length);
      }
      return originalSetValues.call(range, values);
    };
    return range;
  };

  post(gas, payload());
  assert.deepEqual(widths, [2], 'exactly one write, carrying both rows');
});

test('a repeated click resolves to the pair the first one created', () => {
  const gas = boot();
  const first = post(gas, payload());
  const second = post(gas, payload());

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.groupId, first.groupId);
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 2, 'still one pair');
});

test('an expense bucket is refused as the tenant', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Umumiy Naqd Puldan' }));

  assert.equal(response.status, 'error');
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0);
});

test('a missing purpose is refused, because the expense would be unreadable later', () => {
  const gas = boot();
  assert.equal(post(gas, payload({ comment: '   ' })).status, 'error');
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0);
});

test('a bad amount, currency, method or period writes nothing', () => {
  const gas = boot();
  for (const bad of [{ amount: 0 }, { amount: -5 }, { currency: 'EUR' }, { method: 'Karta' }, { period: 'Avgust' }]) {
    assert.equal(post(gas, payload(bad)).status, 'error', JSON.stringify(bad));
  }
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0);
});

// ------------------------------------------------------------------ reporting

test('the group gets one report describing the pair, not two reports', () => {
  const sent = [];
  const gas = boot({
    fetch: (url, params) => {
      if (url.indexOf('/sendMessage') !== -1) sent.push(JSON.parse(params.payload));
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: 777 } })
      };
    }
  });

  post(gas, payload({ deferReports: false }));

  assert.equal(sent.length, 1, 'one message for one business action');
  const text = sent[0].text;
  assert.ok(text.includes('IJARACHI BIZNING NOMIMIZDAN'));
  assert.ok(text.includes('Apteka'));
  assert.ok(text.includes('Elektrik xizmati'));
  // The zero cash impact is stated, because it looks like an error otherwise.
  assert.ok(text.includes("Kassaga ta'siri: 0 UZS"));
});

test('an ordinary entry still gets the ordinary report', () => {
  const sent = [];
  const gas = boot({
    fetch: (url, params) => {
      if (url.indexOf('/sendMessage') !== -1) sent.push(JSON.parse(params.payload));
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: 778 } })
      };
    }
  });

  post(gas, {
    action: 'save_omad',
    transactions: [{ id: '1800000000000_0', tenant: 'Apteka', month: '2026-08', type: 'Income', amount: 500000, currency: 'UZS', method: 'Naqd', groupId: 'grp_plain' }],
    tenants: TENANTS, rates: RATES, templateExpenses: [],
    telegramReport: { operation: 'transaction_upsert', groupId: 'grp_plain', baseId: '1800000000000' }
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('YANGI KIRIM'));
  assert.ok(!sent[0].text.includes('NOMIMIZDAN'));
});

// -------------------------------------------------------------------- editing

test('editing replaces both halves under the same group id', () => {
  const gas = boot();
  post(gas, payload());

  const edited = post(gas, payload({
    requestId: 'web_req_2', groupId: 'grp_ignored',
    replaceGroupId: 'grp_web_pair_1', amount: 750000, comment: 'Santexnik xizmati'
  }));

  assert.equal(edited.status, 'success');
  assert.equal(edited.replaced, true);
  assert.equal(edited.groupId, 'grp_web_pair_1');

  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.length, 2, 'still exactly one pair');
  assert.ok(rows.every(r => r.groupId === 'grp_web_pair_1'));
  assert.ok(rows.every(r => r.amount === 750000));
  assert.ok(rows.some(r => r.comment.includes('Santexnik xizmati')));
  // Both halves moved together: cash is still untouched.
  assert.equal(gas.calculateActuals_(rows, '2026-08').cash, 0);
  assert.equal(gas.calculateTenantPaid_(rows, 'Apteka', '2026-08'), 750000);
});

test('an edit keeps the group message, so the report is edited rather than duplicated', () => {
  const calls = [];
  const gas = boot({
    fetch: (url, params) => {
      calls.push({ url, body: JSON.parse(params.payload) });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: 777 } })
      };
    }
  });

  post(gas, payload({ deferReports: false }));
  post(gas, payload({
    requestId: 'web_req_2', replaceGroupId: 'grp_web_pair_1',
    amount: 750000, deferReports: false
  }));

  assert.equal(calls.filter(c => c.url.indexOf('/sendMessage') !== -1).length, 1);
  const edits = calls.filter(c => c.url.indexOf('/editMessageText') !== -1);
  assert.equal(edits.length, 1, 'the second report edits the first message');
  assert.equal(edits[0].body.message_id, 777);
});

test('replacing something that is not a tenant-paid pair is refused', () => {
  const gas = boot();
  post(gas, {
    action: 'save_omad',
    transactions: [{ id: '1800000000000_0', tenant: 'Apteka', month: '2026-08', type: 'Income', amount: 500000, currency: 'UZS', method: 'Naqd', groupId: 'grp_plain' }],
    tenants: TENANTS, rates: RATES, templateExpenses: [], deferReports: true
  });

  const response = post(gas, payload({ replaceGroupId: 'grp_plain' }));
  assert.equal(response.status, 'error');
  // The ordinary entry is untouched.
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 1);
});

test('replacing a group that does not exist writes nothing', () => {
  const gas = boot();
  assert.equal(post(gas, payload({ replaceGroupId: 'grp_missing' })).status, 'error');
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0);
});

// --------------------------------------------------------------- ledger path

test('the ledger path writes the same pair, in one write, frozen at one rate', () => {
  const gas = boot({ ledger: true });
  const response = post(gas, payload({ currency: 'USD', amount: 100 }));

  assert.equal(response.status, 'success');
  const rows = gas.readLedgerRows_(gas.__spreadsheet);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.groupId === 'grp_web_pair_1'));
  assert.ok(rows.every(r => r.entryKind === 'tenant_paid_expense'));

  // Both halves froze the same converted value, so the pair nets to zero
  // whatever the rate does afterwards.
  assert.equal(rows[0].amountUZS, rows[1].amountUZS);
  assert.equal(rows[0].amountUZS, 100 * 12500);
});

test('the ledger path cancels rather than rewrites when a pair is edited', () => {
  const gas = boot({ ledger: true });
  post(gas, payload());
  post(gas, payload({ requestId: 'web_req_2', replaceGroupId: 'grp_web_pair_1', amount: 750000 }));

  const rows = gas.readLedgerRows_(gas.__spreadsheet);
  assert.equal(rows.length, 4, 'nothing is ever removed');
  assert.equal(rows.filter(r => r.status === 'Cancelled').length, 2);

  const active = gas.listActiveTransactions_(gas.__spreadsheet, {});
  assert.equal(active.length, 2);
  assert.ok(active.every(r => r.amount === 750000));
});

test('a duplicate request is recognised on the ledger path too', () => {
  const gas = boot({ ledger: true });
  post(gas, payload());
  const second = post(gas, payload());

  assert.equal(second.duplicate, true);
  assert.equal(gas.readLedgerRows_(gas.__spreadsheet).length, 2);
});

test('a correction inside the pair cannot change what kind of entry it is', () => {
  const gas = boot({ ledger: true });
  post(gas, payload());

  const income = gas.listActiveTransactions_(gas.__spreadsheet, {}).find(r => r.type === 'Income');
  const corrected = gas.correctTransaction_(gas.__spreadsheet, {
    requestId: 'fix-1', transactionId: income.id, period: '2026-08', tenant: 'Apteka',
    type: 'Income', amount: 900000, currency: 'UZS', method: 'Naqd', comment: 'tuzatildi'
  });

  assert.equal(corrected.status, 'success');
  assert.equal(corrected.transaction.entryKind, 'tenant_paid_expense');
  assert.equal(corrected.transaction.groupId, 'grp_web_pair_1');
});
