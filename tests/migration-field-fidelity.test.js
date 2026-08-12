'use strict';

/**
 * What the migration must carry across, and what verification must refuse.
 *
 * Matching totals are not evidence. The migration once dropped Entry_Kind
 * entirely and every aggregate still agreed: the row counts matched, the
 * period sums matched, the cash and bank balances matched, and each of the ten
 * fields the old check compared matched too. What changed was the *meaning* —
 * a tenant-paid pair arrived as two unrelated rows.
 *
 * So these tests assert the fields nobody was looking at, and assert that a
 * deliberately damaged target is rejected rather than cut over to.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'migration-fidelity-key';

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

/**
 * A ledger with one ordinary entry, one two-line entry, and one tenant-paid
 * pair — the three shapes that have to survive.
 */
const ROWS = [
  ['1786000000000_0', 'Apteka', '2026-08', 'Income', 1000000, 'UZS', 'Naqd', '12/08/2026',
    'Avgust ijara', '461', 'req_a', 'grp_simple', ''],

  ['1786000001000_0', 'Tehnopark', '2026-08', 'Income', 500, 'USD', 'Bank', '12/08/2026',
    'Ijara 1-qism', '', 'req_b_0', 'grp_split', ''],
  ['1786000001000_1', 'Tehnopark', '2026-08', 'Income', 200, 'USD', 'Bank', '12/08/2026',
    'Ijara 2-qism', '', 'req_b_1', 'grp_split', ''],

  ['1786000002000_0', 'Apteka', '2026-08', 'Income', 240000, 'UZS', 'Naqd', '12/08/2026',
    "Ijarachi bizning nomimizdan to'ladi: Elektrik", '', 'req_c_0', 'grp_paid', 'tenant_paid_expense'],
  ['1786000002000_1', 'Umumiy Naqd Puldan', '2026-08', 'Expense', 240000, 'UZS', 'Naqd', '12/08/2026',
    'Elektrik (to\'lovchi: Apteka)', '', 'req_c_1', 'grp_paid', 'tenant_paid_expense']
];

function boot() {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
          { name: 'Tehnopark', defaultRent: 500, currency: 'USD', active: true }
        ])]
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(ROWS.map(r => r.slice()))
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function ledger(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues();
  const header = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function apply(gas) {
  return post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
}

// ------------------------------------------------------------- what survives

test('the migration carries the group id across verbatim', () => {
  const gas = boot();
  assert.strictEqual(apply(gas).status, 'success');

  const rows = ledger(gas);
  assert.strictEqual(rows.length, ROWS.length);

  ROWS.forEach(source => {
    const migrated = rows.find(r => String(r.ID) === source[0]);
    assert.ok(migrated, `${source[0]} was migrated`);
    assert.strictEqual(String(migrated.Entry_Group_ID), source[11],
      `${source[0]} kept its group`);
  });
});

test('the migration carries the entry kind across, so a tenant-paid pair stays one', () => {
  const gas = boot();
  apply(gas);

  const rows = ledger(gas);
  const pair = rows.filter(r => String(r.Entry_Group_ID) === 'grp_paid');
  assert.strictEqual(pair.length, 2);
  pair.forEach(r => assert.strictEqual(String(r.Entry_Kind), 'tenant_paid_expense',
    'the kind is what makes the two halves one action'));

  // ...and the ordinary rows are not accidentally labelled.
  rows.filter(r => String(r.Entry_Group_ID) !== 'grp_paid')
    .forEach(r => assert.strictEqual(String(r.Entry_Kind), ''));
});

test('request ids, message ids, comments and periods all survive', () => {
  const gas = boot();
  apply(gas);
  const rows = ledger(gas);

  ROWS.forEach(source => {
    const m = rows.find(r => String(r.ID) === source[0]);
    assert.strictEqual(String(m.Request_ID), source[10], `${source[0]} request id`);
    assert.strictEqual(String(m.Telegram_Msg_ID), source[9], `${source[0]} message id`);
    assert.strictEqual(String(m.Comment), source[8], `${source[0]} comment`);
    assert.strictEqual(String(m.Period), source[2], `${source[0]} period`);
    assert.strictEqual(String(m.Tenant), source[1], `${source[0]} tenant`);
    assert.strictEqual(Number(m.Amount), source[4], `${source[0]} amount`);
    assert.strictEqual(String(m.Currency), source[5], `${source[0]} currency`);
    assert.strictEqual(String(m.Method), source[6], `${source[0]} method`);
  });
});

test('every row freezes a rate that matches its own converted value', () => {
  const gas = boot();
  apply(gas);

  ledger(gas).forEach(r => {
    const amount = Number(r.Amount);
    const stored = Number(r.Amount_UZS);
    if (String(r.Currency) === 'USD') {
      const used = Number(r.Rate_Used);
      assert.ok(used > 0, `${r.ID} froze a rate`);
      assert.ok(Math.abs(stored - Math.round(amount * used)) <= 1,
        `${r.ID} converted value matches its own frozen rate`);
      assert.ok(used === Number(r.Rate_Buy) || used === Number(r.Rate_Sell),
        `${r.ID} used one of the rates it recorded`);
    } else {
      assert.strictEqual(stored, Math.round(amount), `${r.ID} UZS is unconverted`);
    }
  });
});

// -------------------------------------------------------- what verification catches

test('verification passes on a faithful migration', () => {
  const gas = boot();
  apply(gas);

  const verified = post(gas, { action: 'verify_omad_migration' });
  assert.strictEqual(verified.verification.ok, true,
    JSON.stringify(verified.verification.failures || []));
});

test('verification refuses a target that lost its entry kinds', () => {
  const gas = boot();
  apply(gas);

  // Exactly the damage the old migration did, and the old verification missed:
  // totals, balances and every compared field still agree.
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  const kindColumn = LEDGER_HEADER.indexOf('Entry_Kind') + 1;
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    sheet.getRange(row, kindColumn).setValue('');
  }

  const verified = post(gas, { action: 'verify_omad_migration' });
  assert.strictEqual(verified.verification.ok, false, 'a lost entry kind is a failure');
  assert.ok(verified.verification.failures.some(f => f.indexOf('Entry_Kind') !== -1),
    'and it says so by name');
});

test('verification refuses a target that lost its grouping', () => {
  const gas = boot();
  apply(gas);

  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  const groupColumn = LEDGER_HEADER.indexOf('Entry_Group_ID') + 1;
  // Split one two-line entry into two unrelated rows.
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    if (String(sheet.getRange(row, 1).getValues()[0][0]) === '1786000001000_1') {
      sheet.getRange(row, groupColumn).setValue('grp_split_broken');
    }
  }

  const verified = post(gas, { action: 'verify_omad_migration' });
  assert.strictEqual(verified.verification.ok, false);
  assert.ok(verified.verification.failures.some(f => f.indexOf('Guruh') !== -1),
    'the group check names it');
});

test('verification refuses a comment that was altered', () => {
  const gas = boot();
  apply(gas);

  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  const commentColumn = LEDGER_HEADER.indexOf('Comment') + 1;
  sheet.getRange(2, commentColumn).setValue('boshqa izoh');

  const verified = post(gas, { action: 'verify_omad_migration' });
  assert.strictEqual(verified.verification.ok, false);
  assert.ok(verified.verification.failures.some(f => f.indexOf('Comment') !== -1));
});

// ------------------------------------------------------------------ cutover

test('cutover is refused while verification fails', () => {
  const gas = boot();
  apply(gas);

  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  const kindColumn = LEDGER_HEADER.indexOf('Entry_Kind') + 1;
  // A row that actually carries a kind — clearing an already-empty one would
  // be no damage at all, and would prove nothing.
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    if (String(sheet.getRange(row, 1).getValues()[0][0]) === '1786000002000_0') {
      sheet.getRange(row, kindColumn).setValue('');
    }
  }

  const cutover = post(gas, { action: 'cutover_omad_migration' });
  assert.strictEqual(cutover.status, 'error', 'a failed verification blocks the cutover');

  // ...and the app is still reading the legacy sheet.
  const status = post(gas, { action: 'get_migration_status' });
  assert.strictEqual(status.migration.activeSheet, 'Omad_Transactions');
});

test('the legacy sheet is left intact by apply and by cutover', () => {
  const gas = boot();
  const before = JSON.stringify(gas.__spreadsheet.getSheetByName('Omad_Transactions').data);

  apply(gas);
  assert.strictEqual(
    JSON.stringify(gas.__spreadsheet.getSheetByName('Omad_Transactions').data), before,
    'apply does not touch the source');

  post(gas, { action: 'cutover_omad_migration' });
  assert.strictEqual(
    JSON.stringify(gas.__spreadsheet.getSheetByName('Omad_Transactions').data), before,
    'cutover does not touch the source either, so rollback stays possible');
});

test('after cutover the app reads the ledger and rollback puts it back', () => {
  const gas = boot();
  apply(gas);

  const cutover = post(gas, { action: 'cutover_omad_migration' });
  assert.strictEqual(cutover.status, 'success', cutover.message);

  const read = post(gas, { action: 'get_omad_data' });
  assert.strictEqual(read.status, 'success');
  assert.strictEqual(read.transactions.length, ROWS.length,
    'the same entries are readable through the ledger');

  const paid = read.transactions.filter(t => t.groupId === 'grp_paid');
  assert.strictEqual(paid.length, 2);
  paid.forEach(t => assert.strictEqual(t.entryKind, 'tenant_paid_expense'));

  const back = post(gas, { action: 'rollback_omad_migration' });
  assert.strictEqual(back.status, 'success');
  assert.strictEqual(post(gas, { action: 'get_migration_status' }).migration.activeSheet,
    'Omad_Transactions');
});
