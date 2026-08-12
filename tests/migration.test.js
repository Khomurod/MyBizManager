'use strict';

/**
 * Period migration: preview, apply, verify, cutover and rollback.
 *
 * The original sheet is never written. Everything the migration does is either
 * a read or a write to the versioned sheet, which is what makes rollback a
 * config change rather than a restore.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'correct-admin-key';
const plain = value => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const HEADER = ['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method',
                'Date', 'Comment', 'Telegram_Msg_ID', 'Request_ID'];

function row(id, month, date, overrides = {}) {
  const base = {
    tenant: 'Tehnopark', type: 'Income', amount: 1000000, currency: 'UZS',
    method: 'Naqd', comment: '', msgId: '', requestId: ''
  };
  const t = { ...base, ...overrides };
  return [id, t.tenant, month, t.type, t.amount, t.currency, t.method, date, t.comment, t.msgId, t.requestId];
}

const RATES = {
  '2026-01': { buy: 12000, sell: 12500 },
  '2026-02': { buy: 12100, sell: 12600 },
  '2026-12': { buy: 12800, sell: 13000 },
  '2027-01': { buy: 13000, sell: 13500 }
};

function ledger(rows, config = []) {
  return {
    System_Config: [['Omad_Rates', JSON.stringify(RATES)], ...config],
    Omad_Transactions: [HEADER, ...rows]
  };
}

function boot(rows, config) {
  return loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY }, sheets: ledger(rows, config) });
}

function v2Rows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

// ------------------------------------------------------------------ preview

test('preview resolves years from dates and writes nothing', () => {
  const gas = boot([
    row('1_0', 'Yanvar', '05/01/2026'),
    row('2_0', 'Fevral', '10/02/2026'),
    row('3_0', 'Yanvar', '05/01/2027')
  ]);

  const preview = gas.previewOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(preview.totalRows, 3);
  assert.strictEqual(preview.resolvedRows, 3);
  assert.deepStrictEqual(plain(preview.byYear), { 2026: 2, 2027: 1 });
  assert.deepStrictEqual(plain(preview.unresolved), []);
  assert.strictEqual(preview.canApply, true);

  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2'), null,
    'preview must not create the target sheet');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions').getLastRow(), 4,
    'the source sheet is untouched');
});

test('preview lists rows whose year cannot be determined', () => {
  const gas = boot([
    row('1_0', 'Yanvar', '05/01/2026'),
    row('2_0', 'Mart', ''),
    row('3_0', '', '')
  ]);

  const preview = gas.previewOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(preview.unresolved.length, 2);
  assert.strictEqual(preview.unresolved[0].id, '2_0');
  assert.strictEqual(preview.unresolved[0].rowNumber, 3, 'the sheet row number is reported');
  assert.strictEqual(preview.canApply, false);
  assert.strictEqual(preview.fallbackYearRequired, true);
});

test('choosing a fallback year resolves the remaining rows', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('2_0', 'Mart', '')]);

  const preview = gas.previewOmadMigration_(gas.__spreadsheet, { fallbackYear: 2026 });
  assert.strictEqual(preview.unresolved.length, 0);
  assert.deepStrictEqual(plain(preview.byYear), { 2026: 2 });
  assert.strictEqual(preview.bySource.fallback, 1, 'the fallback rows are counted separately');
  assert.strictEqual(preview.canApply, true);
});

test('preview reports duplicate transaction ids', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('1_0', 'Fevral', '05/02/2026')]);
  const preview = gas.previewOmadMigration_(gas.__spreadsheet, {});
  assert.deepStrictEqual(plain(preview.duplicateIds), ['1_0']);
  assert.strictEqual(preview.canApply, false);
});

test('preview reports the pre-migration financial totals', () => {
  const gas = boot([
    row('1_0', 'Yanvar', '05/01/2026', { amount: 1000000, method: 'Naqd' }),
    row('2_0', 'Yanvar', '06/01/2026', { amount: 400000, type: 'Expense', method: 'Bank' }),
    row('3_0', 'Yanvar', '07/01/2026', { amount: 100, currency: 'USD', method: 'Bank' })
  ]);

  const preview = gas.previewOmadMigration_(gas.__spreadsheet, {});
  // 100 USD at the January 2026 sell rate of 12 500.
  assert.strictEqual(preview.totalsByPeriod['2026-01'], 1000000 - 400000 + 1250000);
  assert.strictEqual(preview.balances.cash, 1000000);
  assert.strictEqual(preview.balances.bank, -400000 + 1250000);
  assert.strictEqual(preview.balances.total, 1850000);
});

// -------------------------------------------------------------------- apply

test('apply writes a versioned sheet and leaves the original alone', () => {
  const gas = boot([
    row('1_0', 'Dekabr', '28/12/2026'),
    row('2_0', 'Yanvar', '03/01/2027')
  ]);

  const result = gas.applyOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(result.status, 'success');

  // The versioned sheet carries the append-only schema: period in column 7,
  // status in column 19.
  const migrated = v2Rows(gas);
  assert.strictEqual(migrated.length, 2);
  assert.strictEqual(migrated[0][6], '2026-12');
  assert.strictEqual(migrated[1][6], '2027-01');
  assert.strictEqual(migrated[0][18], 'Active');
  assert.strictEqual(migrated[0][5], 'Migration', 'the source is recorded');
  assert.strictEqual(migrated[0][21], gas.LEDGER_SCHEMA_VERSION);

  const original = gas.__spreadsheet.getSheetByName('Omad_Transactions').getDataRange().getValues();
  assert.strictEqual(original[1][2], 'Dekabr', 'the original month value is preserved');
  assert.strictEqual(original.length, 3);
});

test('apply refuses while rows are unresolved', () => {
  const gas = boot([row('1_0', 'Mart', '')]);
  const result = gas.applyOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /yili aniqlanmadi/);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2'), null);
});

test('apply refuses on duplicate ids', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('1_0', 'Yanvar', '06/01/2026')]);
  const result = gas.applyOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /Takrorlangan ID/);
});

test('apply takes a backup first', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});
  const backups = gas.__spreadsheet.getSheetByName('Omad_Backups');
  assert.ok(backups && backups.getLastRow() >= 2, 'a pre-migration snapshot exists');
});

test('apply migrates the rate map and keeps the original under a backup key', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({ Yanvar: 12000, Fevral: { buy: 12100, sell: 12600 } })]],
      Omad_Transactions: [HEADER, row('1_0', 'Yanvar', '05/01/2026')]
    }
  });

  gas.applyOmadMigration_(gas.__spreadsheet, { fallbackYear: 2026 });
  const config = gas.__spreadsheet.getSheetByName('System_Config').getDataRange().getValues();
  const rates = JSON.parse(config.find(r => r[0] === 'Omad_Rates')[1]);
  const backup = JSON.parse(config.find(r => r[0] === 'Omad_Rates_V1_Backup')[1]);

  assert.deepStrictEqual(Object.keys(rates).sort(), ['2026-01', '2026-02']);
  assert.strictEqual(rates['2026-02'].sell, 12600);
  assert.strictEqual(backup.Yanvar, 12000, 'the pre-migration map is recoverable');
});

test('an interrupted apply is recovered by running it again', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('2_0', 'Fevral', '05/02/2026')]);

  gas.applyOmadMigration_(gas.__spreadsheet, {});
  // Simulate an apply that died half-way, leaving a partial target sheet.
  const target = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  target.deleteRow(3);
  assert.strictEqual(v2Rows(gas).length, 1);

  const second = gas.applyOmadMigration_(gas.__spreadsheet, {});
  assert.strictEqual(second.status, 'success');
  assert.strictEqual(v2Rows(gas).length, 2, 'the target is rebuilt from scratch');
  assert.strictEqual(second.verification.ok, true);
});

// ------------------------------------------------------------------- verify

test('verification passes on a clean migration', () => {
  const gas = boot([
    row('1_0', 'Yanvar', '05/01/2026', { amount: 100, currency: 'USD' }),
    row('2_0', 'Dekabr', '20/12/2026', { amount: 500000, type: 'Expense', method: 'Bank' }),
    row('3_0', 'Yanvar', '05/01/2027')
  ]);

  gas.applyOmadMigration_(gas.__spreadsheet, {});
  const verification = gas.verifyOmadMigration_(gas.__spreadsheet);

  assert.strictEqual(verification.ok, true, verification.failures.join('; '));
  assert.strictEqual(verification.sourceRows, 3);
  assert.strictEqual(verification.targetRows, 3);
  assert.strictEqual(verification.expectedBalances.total, verification.actualBalances.total);
});

test('verification fails when the migrated sheet is tampered with', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('2_0', 'Fevral', '05/02/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});

  // Column 10 is Amount in the ledger schema.
  gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').getRange(2, 10).setValue(999);
  const verification = gas.verifyOmadMigration_(gas.__spreadsheet);

  assert.strictEqual(verification.ok, false);
  assert.ok(verification.failures.some(f => /yig'indisi mos emas/.test(f)));
});

test('verification fails when a row goes missing', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('2_0', 'Fevral', '05/02/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});
  gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').deleteRow(3);

  const verification = gas.verifyOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(verification.ok, false);
  assert.ok(verification.failures.some(f => /soni mos emas/.test(f)));
});

// --------------------------------------------------------- cutover & rollback

test('cutover points reads at the versioned sheet', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});

  assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions');
  const cutover = gas.cutoverOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(cutover.status, 'success');
  assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions_V2');

  const loaded = readJsonOutput(gas.doPost(postEvent({ action: 'get_omad_data', adminKey: ADMIN_KEY })));
  assert.strictEqual(loaded.transactions[0].month, '2026-01');
  assert.strictEqual(loaded.transactions[0].period, '2026-01');
  assert.strictEqual(loaded.transactions[0].periodLabel, 'Yanvar 2026');
});

test('cutover is refused when verification fails', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026'), row('2_0', 'Fevral', '05/02/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});
  gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').deleteRow(3);

  const cutover = gas.cutoverOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(cutover.status, 'error');
  assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions');
});

test('rollback points reads back and keeps the migrated data', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({ Yanvar: 12000 })]],
      Omad_Transactions: [HEADER, row('1_0', 'Yanvar', '05/01/2026')]
    }
  });

  gas.applyOmadMigration_(gas.__spreadsheet, { fallbackYear: 2026 });
  gas.cutoverOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions_V2');

  const rollback = gas.rollbackOmadMigration_(gas.__spreadsheet);
  assert.strictEqual(rollback.status, 'success');
  assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions');
  assert.strictEqual(v2Rows(gas).length, 1, 'rollback never deletes migrated data');

  const config = gas.__spreadsheet.getSheetByName('System_Config').getDataRange().getValues();
  const rates = JSON.parse(config.find(r => r[0] === 'Omad_Rates')[1]);
  assert.strictEqual(rates.Yanvar, 12000, 'the pre-migration rate map is restored');
});

test('reads keep working before the migration runs', () => {
  const gas = boot([row('1_0', 'Fevral', '10/02/2026')]);
  const loaded = readJsonOutput(gas.doPost(postEvent({ action: 'get_omad_data', adminKey: ADMIN_KEY })));

  assert.strictEqual(loaded.transactions[0].month, 'Fevral', 'the stored value is unchanged');
  assert.strictEqual(loaded.transactions[0].period, '2026-02', 'but the period is resolved for the UI');
  assert.strictEqual(loaded.transactions[0].periodLabel, 'Fevral 2026');
});

// ------------------------------------------------------------------- the API

test('migration status needs the access key, and reads correctly with it', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
  assert.strictEqual(
    readJsonOutput(gas.doPost(postEvent({ action: 'get_migration_status', adminKey: 'nope' }))).status, 'error',
    'the ledger size and which sheet is live are not facts a wrong key unlocks');

  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_migration_status', adminKey: ADMIN_KEY })));

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.migration.state, 'not_started');
  assert.strictEqual(body.migration.activeSheet, 'Omad_Transactions');
  assert.strictEqual(body.migration.sourceSheetRows, 1);
  assert.strictEqual(body.migration.versionedSheetExists, false);
});

test('every migration step requires the admin key', () => {
  const actions = ['preview_omad_migration', 'apply_omad_migration', 'verify_omad_migration',
                   'cutover_omad_migration', 'rollback_omad_migration'];

  for (const action of actions) {
    const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
    const denied = readJsonOutput(gas.doPost(postEvent({ action, adminKey: 'wrong' })));
    assert.strictEqual(denied.status, 'error', action);
    assert.match(denied.message, /Admin kaliti/, action);
    assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2'), null, action);
    assert.strictEqual(gas.activeTransactionSheetName_(gas.__spreadsheet), 'Omad_Transactions', action);
  }
});

test('the full preview -> apply -> verify -> cutover flow runs through the API', () => {
  const gas = boot([
    row('1_0', 'Dekabr', '29/12/2026'),
    row('2_0', 'Yanvar', '02/01/2027'),
    row('3_0', 'Yanvar', '15/01/2026')
  ]);

  const preview = readJsonOutput(gas.doPost(postEvent({
    action: 'preview_omad_migration', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(preview.preview.canApply, true);
  assert.deepStrictEqual(plain(preview.preview.byYear), { 2026: 2, 2027: 1 });

  const applied = readJsonOutput(gas.doPost(postEvent({
    action: 'apply_omad_migration', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(applied.status, 'success');
  assert.strictEqual(applied.verification.ok, true);
  assert.strictEqual(applied.migration.state, 'applied');

  const verified = readJsonOutput(gas.doPost(postEvent({
    action: 'verify_omad_migration', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(verified.verification.ok, true);

  const cutover = readJsonOutput(gas.doPost(postEvent({
    action: 'cutover_omad_migration', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(cutover.status, 'success');
  assert.strictEqual(cutover.migration.state, 'cutover');

  const rolledBack = readJsonOutput(gas.doPost(postEvent({
    action: 'rollback_omad_migration', adminKey: ADMIN_KEY
  })));
  assert.strictEqual(rolledBack.migration.state, 'rolled_back');
  assert.strictEqual(rolledBack.migration.activeSheet, 'Omad_Transactions');
});

test('the migration writes an audit trail', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});
  gas.cutoverOmadMigration_(gas.__spreadsheet);

  const audit = gas.__spreadsheet.getSheetByName('Omad_Audit_Log').getDataRange().getValues();
  const events = audit.slice(1).map(r => r[1]);
  assert.ok(events.includes('omad_period_migration_applied'));
  assert.ok(events.includes('omad_period_migration_cutover'));
});

test('after cutover new transactions are written to the versioned sheet', () => {
  const gas = boot([row('1_0', 'Yanvar', '05/01/2026')]);
  gas.applyOmadMigration_(gas.__spreadsheet, {});
  gas.cutoverOmadMigration_(gas.__spreadsheet);

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: '9_0', tenant: 'Bunyodbek', month: '2027-03', type: 'Income',
    amount: 500000, currency: 'UZS', method: 'Naqd', date: '05/03/2027'
  });

  assert.strictEqual(v2Rows(gas).length, 2);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions').getLastRow(), 2,
    'the legacy sheet stops changing');
});
