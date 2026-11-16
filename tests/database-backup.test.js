'use strict';

/**
 * The daily copy of the database into Google Drive (27_database_backup.gs).
 *
 * What has to hold:
 *   - every business table lands in its own tab, cell for cell what the
 *     storage layer reads -- the layout the Supabase import reads back;
 *   - text stays text: "2026-08" is not turned into a date on the way;
 *   - the files rotate (weekday, and month on the 1st) and are overwritten,
 *     never multiplied, and one the owner deleted is made again;
 *   - the settings never reach a spreadsheet;
 *   - the health check says when the last copy was written, and whether it all was.
 */

const test = require('node:test');
const assert = require('node:assert');

const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'backup-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

function ledgerRow(id, comment) {
  return [id, 'req_' + id, '2026-08-01T09:00:00.000Z', '', 'tester', 'Web', '2026-08', 'Apteka', 'Income',
    100, 'USD', 12000, 12500, 12500, 'sell', 1250000, 'Naqd', comment, 'Active', '', '', 2, 'grp_' + id, ''];
}

function live(options = {}) {
  return loadScript(Object.assign({
    storage: 'supabase',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    triggers: ['processPendingTelegramJobs'],
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 100, currency: 'USD', active: true }])],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER, ledgerRow('1786000000000_0', 'ijara'), ledgerRow('1786000000001_0', '05/08/2026')],
      Omad_Audit_Log: [['Timestamp', 'Event', 'Details'], ['2026-08-01T09:00:00.000Z', 'seed', '']]
    }
  }, options));
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

const files = gas => Object.values(gas.__drive);

test('one run copies every business table into its own tab, as the storage layer reads it', () => {
  const gas = live();
  const result = gas.runDatabaseBackup_(new Date('2026-08-12T22:00:00.000Z')); // Thursday 13th, 03:00 in Tashkent
  assert.strictEqual(result.status, 'success', result.message);
  assert.deepStrictEqual([...result.backup.slots], ['kun 4-payshanba']);

  const [file] = files(gas);
  assert.match(file.title, /MyBizManager zaxira — kun 4-payshanba/);
  const names = file.getSheets().map(sheet => sheet.getName());
  assert.ok(names.includes('Zaxira'), 'a first tab says when and how much');
  assert.ok(!names.includes('Sheet1'), 'the new file\'s own empty tab is gone');
  for (const skipped of ['Omad_Backups', 'Telegram_Debug_Log']) assert.ok(!names.includes(skipped), skipped);

  const doc = gas.appDoc_();
  for (const name of ['System_Config', 'Omad_Transactions_V2', 'Omad_Audit_Log', 'Tasks', 'Cafe_Sales']) {
    const plain = values => JSON.parse(JSON.stringify(values));
    assert.deepStrictEqual(plain(file.getSheetByName(name).getDataRange().getValues()),
      plain(doc.getSheetByName(name).getDataRange().getValues()), name);
  }
  const ledger = file.getSheetByName('Omad_Transactions_V2').getDataRange().getValues();
  assert.strictEqual(ledger[1][6], '2026-08', 'a period is still text, not a date');
  assert.strictEqual(ledger[2][17], '05/08/2026', 'and so is a comment that looks like one');
  assert.strictEqual(ledger[1][9], 100, 'a number is still a number');
});

test('the settings never reach a spreadsheet', () => {
  const gas = live();
  gas.runDatabaseBackup_(new Date('2026-08-12T22:00:00.000Z'));
  const dump = JSON.stringify(files(gas).map(file => file.getSheets().map(sheet => sheet.getDataRange().getValues())));
  assert.ok(!dump.includes(ADMIN_KEY));
  assert.ok(!dump.includes(BOT_TOKEN));
});

test('the files rotate by weekday, and by month on the 1st, and are overwritten rather than multiplied', () => {
  const gas = live();
  gas.runDatabaseBackup_(new Date('2026-08-12T22:00:00.000Z'));
  gas.runDatabaseBackup_(new Date('2026-08-19T22:00:00.000Z')); // the next Thursday
  assert.strictEqual(files(gas).length, 1, 'the same weekday writes the same file');

  const first = gas.runDatabaseBackup_(new Date('2026-08-31T22:00:00.000Z')); // Tuesday 1 September
  assert.deepStrictEqual([...first.backup.slots], ['kun 2-seshanba', 'oy 09']);
  assert.strictEqual(files(gas).length, 3);

  // A row written since is in the next copy; nothing of the old one lingers.
  post(gas, {
    action: 'create_transaction', requestId: 'later', period: '2026-08', tenant: 'Apteka', type: 'Income',
    amount: 5, currency: 'USD', method: 'Naqd', comment: '', deferReports: true
  });
  gas.runDatabaseBackup_(new Date('2026-08-26T22:00:00.000Z'));
  const thursday = files(gas).find(file => /payshanba/.test(file.title));
  assert.strictEqual(thursday.getSheetByName('Omad_Transactions_V2').getDataRange().getValues().length, 4);
});

test('a backup file the owner deleted is made again', () => {
  const gas = live();
  gas.runDatabaseBackup_(new Date('2026-08-12T22:00:00.000Z'));
  const [gone] = Object.keys(gas.__drive);
  delete gas.__drive[gone];
  assert.strictEqual(gas.runDatabaseBackup_(new Date('2026-08-19T22:00:00.000Z')).status, 'success');
  assert.strictEqual(files(gas).length, 1);
});

test('a table larger than a new tab is written whole', () => {
  const rows = [LEDGER_HEADER];
  for (let i = 0; i < 1200; i++) rows.push(ledgerRow('17860000' + String(i).padStart(5, '0') + '_0', 'r' + i));
  const gas = live({ sheets: { Omad_Transactions_V2: rows, System_Config: [['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']] } });
  assert.strictEqual(gas.runDatabaseBackup_(new Date('2026-08-12T22:00:00.000Z')).status, 'success');
  assert.strictEqual(files(gas)[0].getSheetByName('Omad_Transactions_V2').getDataRange().getValues().length, 1201);
});

test('the button runs one now; the nightly run needs the cron secret, and nothing less', () => {
  const gas = live();
  assert.strictEqual(post(gas, { action: 'run_database_backup' }).status, 'success');
  assert.strictEqual(post(gas, { action: 'run_database_backup', adminKey: 'wrong' }).status, 'error');

  const nightly = body => readJsonOutput(gas.doPost(postEvent(Object.assign({ action: 'run_database_backup' }, body))));
  assert.strictEqual(nightly({ cronSecret: 'anything' }).status, 'error', 'no secret configured: refused');
  gas.__supabase.setProperty('EDGE_CRON_SECRET', 'cron-secret-0123456789abcdef');
  gas.resetRequestMemos_();
  assert.strictEqual(nightly({ cronSecret: 'cron-secret-0123456789abcdef' }).status, 'success');
  assert.strictEqual(nightly({ cronSecret: 'cron-secret-0123456789abcdeX' }).status, 'error');
  assert.strictEqual(nightly({ cronSecret: '' }).status, 'error');
});

test('the nightly run is let in before the settings have moved to the database', () => {
  // The data is on Supabase, the settings are still Script Properties, and
  // the cron secret is a row only app_properties holds.
  const gas = live({ propertiesInDatabase: false });
  assert.strictEqual(gas.sharedPropertiesInDatabase_(), false);
  const nightly = body => readJsonOutput(gas.doPost(postEvent(Object.assign({ action: 'run_database_backup' }, body))));
  assert.strictEqual(nightly({ cronSecret: 'cron-secret-0123456789abcdef' }).status, 'error', 'no row yet: refused');
  gas.__supabase.setProperty('EDGE_CRON_SECRET', 'cron-secret-0123456789abcdef');
  assert.strictEqual(nightly({ cronSecret: 'cron-secret-0123456789abcdef' }).status, 'success');
  assert.strictEqual(nightly({ cronSecret: 'cron-secret-0123456789abcdeX' }).status, 'error');
  assert.strictEqual(files(gas).length, 1);
});

test('the health check reports the last copy', () => {
  const gas = live();
  gas.resetRequestMemos_();
  assert.strictEqual(gas.databaseBackupCheck_().status, 'warning', 'none yet');
  gas.runDatabaseBackup_(new Date());
  gas.resetRequestMemos_();
  assert.strictEqual(gas.databaseBackupCheck_().status, 'ok');

  gas.runDatabaseBackup_(new Date(Date.now() - 3 * 24 * 3600 * 1000));
  gas.resetRequestMemos_();
  assert.strictEqual(gas.databaseBackupCheck_().status, 'error', 'three days without one');

  const sheets = loadScript({ storage: 'sheets', properties: { OMAD_ADMIN_KEY: ADMIN_KEY } });
  assert.strictEqual(sheets.databaseBackupCheck_().status, 'ok', 'nothing to copy while the data is in Sheets');
  assert.strictEqual(sheets.runDatabaseBackup_(new Date()).status, 'skipped');
});

test('a copy that could not be written says so, and the health check turns red', () => {
  const gas = live();
  const create = gas.SpreadsheetApp.create;
  gas.SpreadsheetApp.create = () => { throw new Error('Exception: Drive is full'); };
  const result = gas.runDatabaseBackup_(new Date());
  gas.SpreadsheetApp.create = create;
  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /Drive is full/);
  gas.resetRequestMemos_();
  assert.strictEqual(gas.databaseBackupCheck_().status, 'error');
});
