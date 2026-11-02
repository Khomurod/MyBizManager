'use strict';

/**
 * The Supabase store: the storage layer itself (24_supabase_store.gs) and the
 * move from the spreadsheet (25_supabase_import.gs).
 *
 * The rest of the suite already runs against the database with
 * `MBM_STORAGE=supabase` (see scripts/test-supabase.js). These tests pin what
 * only exists because there are two stores: which one is live, that the
 * choice fails closed, that the schema is the one the code assumes, that the
 * move copies everything and is decided on the money, and the rules the
 * database now enforces by itself.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');
const { loadSchema } = require('./supabase-mock');

const ADMIN_KEY = 'correct-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

function ledgerRow(id, overrides = {}) {
  const row = {
    ID: id, Request_ID: 'req_' + id, Created_At: '2026-08-01T09:00:00.000Z', Updated_At: '',
    Created_By: 'tester', Source: 'Web', Period: '2026-08', Tenant: 'Apteka', Type: 'Income',
    Amount: 100, Currency: 'USD', Rate_Buy: 12000, Rate_Sell: 12500, Rate_Used: 12500,
    Rate_Type: 'sell', Amount_UZS: 1250000, Method: 'Naqd', Comment: 'ijara', Status: 'Active',
    Related_ID: '', Telegram_Msg_ID: 602, Schema_Version: 2, Entry_Group_ID: 'grp_' + id, Entry_Kind: ''
  };
  Object.assign(row, overrides);
  return LEDGER_HEADER.map(name => row[name]);
}

/** A live spreadsheet, as production is today, with an empty database beside it. */
function sheetsWithTarget(extraSheets = {}) {
  return loadScript({
    storage: 'sheets',
    supabaseTarget: true,
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    sheets: Object.assign({
      System_Config: [
        ['Type', 'Data JSON'],
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 100, currency: 'USD', active: true }])],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Omad_Read_Model', '{"version":1,"derived":true}'],
        ['Cafe_Inventory_Rev', 47]
      ],
      Omad_Transactions_V2: [
        LEDGER_HEADER,
        ledgerRow('1786000000000_0'),
        ledgerRow('1786000000001_0', { Type: 'Expense', Tenant: 'Umumiy Naqd Puldan', Amount: 300000,
          Currency: 'UZS', Rate_Used: 1, Rate_Type: 'none', Amount_UZS: 300000, Telegram_Msg_ID: '' }),
        ledgerRow('1786000000002_0', { Status: 'Cancelled', Updated_At: '2026-08-02T09:00:00.000Z' })
      ],
      Cafe_Sales: [
        ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'],
        // The oldest receipts are bare arrays and have no ID at all.
        ['2026-04-21T11:06:50.540Z', 'cafe_seller', 12000, 0, '[{"name":"Kola","qty":1}]'],
        ['2026-08-14T05:45:44.506Z', 'cafe_seller', 8000, 2000,
          JSON.stringify({ requestId: 'sale_req_1', items: [{ name: 'Kola', qty: 1 }], stockConsumption: { i1: { qty: 1, cost: 6000 } } }),
          '1786686344506']
      ],
      Telegram_Debug_Log: [['Timestamp', 'Event', 'Details'], ['2026-08-01T10:00:00.000Z', 'telegram_api_sendMessage', '{"ok":true}']],
      Telegram_Debug_Log_Backup_20260812_213721: [['Timestamp', 'Event', 'Details'], ['2026-08-01T09:00:00.000Z', 'old', 'x']]
    }, extraSheets)
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

// ------------------------------------------------------------- the schema

test('every sheet maps on to a table, column for column, in the code\'s own order', () => {
  const gas = loadScript({ storage: 'sheets' });
  const expected = {
    Omad_Transactions_V2: gas.LEDGER_HEADER,
    Omad_Transactions: gas.OMAD_TRANSACTION_HEADER,
    Tasks: gas.TASKS_HEADER,
    Task_Occurrences: gas.TASK_OCC_HEADER,
    Omad_Job_Queue: gas.JOB_QUEUE_HEADER,
    Cafe_Sales: gas.CAFE_SALES_HEADER,
    Cafe_Kun_Yakuni: gas.CAFE_CLOSE_DAY_HEADER,
    Cafe_Stock_Movements: gas.CAFE_MOVEMENTS_HEADER
  };
  Object.keys(expected).forEach(name => {
    const headers = gas.SUPABASE_SHEETS[name].columns.map(c => c[0]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(headers)), JSON.parse(JSON.stringify(expected[name])), name);
  });
});

test('every mapped column exists in the migrated schema, with a type that can hold it', () => {
  const gas = loadScript({ storage: 'sheets' });
  const schema = loadSchema();
  const compatible = {
    text: ['text'], textnull: ['text'], datekey: ['text'], timekey: ['text'], period: ['text'],
    datetext: ['text'], num: ['numeric', 'bigint', 'integer'], int: ['integer', 'bigint'],
    bool: ['boolean'], json: ['jsonb'], ts: ['timestamptz']
  };
  Object.keys(gas.SUPABASE_SHEETS).forEach(name => {
    const definition = gas.SUPABASE_SHEETS[name];
    const table = schema[definition.table];
    assert.ok(table, `${name}: no table ${definition.table}`);
    assert.ok(table.columns.seq, `${definition.table} has the seq column rows are ordered by`);
    definition.columns.forEach(([header, column, type]) => {
      assert.ok(table.columns[column], `${name}.${header}: no column ${definition.table}.${column}`);
      assert.ok(compatible[type].includes(table.columns[column].type),
        `${name}.${header}: ${type} cannot live in ${table.columns[column].type}`);
    });
  });
});

// --------------------------------------------------------------- the switch

test('the spreadsheet stays the store until the switch is made, and the database is never called', () => {
  const gas = sheetsWithTarget();
  const body = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(gas.storageMode_(), 'sheets');
  assert.strictEqual(gas.__supabase.requests.length, 0, 'not one request to the database');
});

test('Supabase selected without its credentials fails closed instead of writing to the sheet', () => {
  const gas = loadScript({
    storage: 'sheets',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, OMAD_STORAGE: 'supabase' },
    sheets: { Omad_Transactions_V2: [LEDGER_HEADER], System_Config: [['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']] }
  });
  const body = post(gas, {
    action: 'create_transaction', requestId: 'r1', period: '2026-08', tenant: 'Apteka',
    type: 'Income', amount: 1, currency: 'UZS', method: 'Naqd'
  });
  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /SUPABASE_URL/);
  assert.match(body.message, /SUPABASE_SECRET_KEY/);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length, 1,
    'nothing reached the spreadsheet either');

  // Telegram must still get its 200, or it redelivers the update for ever.
  const webhook = gas.doPost(postEvent({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/yangi' } }));
  assert.ok(webhook.__html, 'the webhook answers OK rather than an error page');
});

test('the database key is a secret: redacted from errors and never shown in the status', () => {
  const gas = sheetsWithTarget();
  assert.doesNotMatch(gas.redactSecrets_('failed with sb_secret_abcDEF123_xyz-9 inside'), /sb_secret_abc/);
  assert.doesNotMatch(gas.redactSecrets_('key ' + gas.__supabase.key), new RegExp(gas.__supabase.key));
  const status = post(gas, { action: 'get_storage_status' });
  assert.strictEqual(status.status, 'success');
  assert.strictEqual(status.storage.mode, 'sheets');
  assert.strictEqual(status.storage.reachable, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(gas.__supabase.key));
});

test('the storage actions are omad_admin only', () => {
  const gas = sheetsWithTarget();
  gas.setUserPassword('kassir', 'kassir-parol-1', 'cafe_seller');
  const login = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: 'kassir', password: 'kassir-parol-1' })));
  ['get_storage_status', 'preview_supabase_import', 'apply_supabase_import',
    'verify_supabase_import', 'rollback_supabase_storage'].forEach(action => {
    const body = readJsonOutput(gas.doPost(postEvent({ action, sessionToken: login.token })));
    assert.strictEqual(body.code, 'forbidden', action);
    const anonymous = readJsonOutput(gas.doPost(postEvent({ action })));
    assert.strictEqual(anonymous.authExpired, true, action);
  });
  assert.strictEqual(gas.storageMode_(), 'sheets');
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 0);
});

// ----------------------------------------------------------------- the move

test('preview converts every row and counts, and writes nothing anywhere', () => {
  const gas = sheetsWithTarget();
  const body = post(gas, { action: 'preview_supabase_import' });
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.preview.ready, true, body.preview.problem);
  assert.strictEqual(body.preview.rows.Omad_Transactions_V2, 3);
  assert.strictEqual(body.preview.rows.System_Config, 4, 'the label row and the derived read model are not settings to copy');
  assert.ok(gas.__supabase.requests.every(r => r.method === 'get'), 'reads only');
  assert.strictEqual(gas.storageMode_(), 'sheets');
});

test('apply copies every sheet, verifies cell by cell and on the money, and only then switches', () => {
  const gas = sheetsWithTarget();
  const body = post(gas, { action: 'apply_supabase_import' });
  assert.strictEqual(body.status, 'success', body.message);
  assert.strictEqual(body.verification.ok, true, JSON.stringify(body.verification));
  assert.strictEqual(body.verification.money.ok, true);
  assert.strictEqual(body.verification.money.rows, 2, 'the two Active rows');
  assert.strictEqual(gas.storageMode_(), 'supabase');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(body.copied)), {
    System_Config: 4, Omad_Transactions_V2: 3, Cafe_Sales: 2, Telegram_Debug_Log: 1,
    Telegram_Debug_Log_Backup_20260812_213721: 1
  });

  const rows = gas.__supabase.rows;
  assert.ok(!rows.system_config.some(r => r.key === 'Omad_Read_Model'), 'a derived cache is rebuilt, not copied');
  assert.ok(!rows.system_config.some(r => r.key === 'Type'), 'the label row is not a setting');
  assert.ok(rows.system_config.some(r => r.key === 'Omad_Storage_Cutover_At'), 'the cutover is recorded in the database');
  assert.strictEqual(rows.system_config.find(r => r.key === 'Cafe_Inventory_Rev').value, '47');
  assert.strictEqual(rows.omad_transactions_v2[0].telegram_msg_id, '602');
  assert.strictEqual(rows.omad_transactions_v2[2].status, 'Cancelled', 'history keeps its status');
  assert.strictEqual(rows.cafe_sales[0].id, null, 'a receipt that never had an ID still has none');
  assert.ok(Array.isArray(rows.cafe_sales[0].receipt), 'the old bare-array receipt survives as it was');
  assert.strictEqual(rows.cafe_sales[1].request_id, 'sale_req_1');
  assert.deepStrictEqual(rows.telegram_debug_log.map(r => r.source_sheet),
    ['Telegram_Debug_Log', 'Telegram_Debug_Log_Backup_20260812_213721']);

  // From now on the application reads the database: the same figures.
  const dashboard = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(dashboard.status, 'success');
  assert.strictEqual(dashboard.summary.balances.total, 1250000 - 300000);
});

test('the copy never touches the spreadsheet', () => {
  const gas = sheetsWithTarget();
  const before = JSON.stringify(Object.keys(gas.__spreadsheet.sheets).map(n => gas.__spreadsheet.sheets[n].data));
  post(gas, { action: 'apply_supabase_import' });
  const after = JSON.stringify(Object.keys(gas.__spreadsheet.sheets).map(n => gas.__spreadsheet.sheets[n].data));
  assert.strictEqual(after, before);
});

test('apply refuses to run into a database that already holds rows', () => {
  const gas = sheetsWithTarget();
  assert.strictEqual(post(gas, { action: 'apply_supabase_import' }).status, 'success');
  assert.strictEqual(post(gas, { action: 'rollback_supabase_storage' }).status, 'success');
  const ledgerRows = gas.__supabase.count('omad_transactions_v2');

  const again = post(gas, { action: 'apply_supabase_import' });
  assert.strictEqual(again.status, 'error');
  assert.match(again.message, /bo'sh emas/);
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), ledgerRows, 'nothing duplicated');
  assert.strictEqual(gas.storageMode_(), 'sheets');
});

test('a cell that cannot be stored is named, and the database is left empty', () => {
  const gas = sheetsWithTarget({
    Tasks: [
      ['ID', 'Type', 'Title', 'Description', 'Responsible', 'Priority', 'Photo_Required', 'Recurrence_JSON',
        'Reminder_Times_JSON', 'Remind_Daily', 'Due_Time', 'Deadline_Key', 'Deadline_Time', 'Start_Key', 'End_Key',
        'Status', 'Steps_JSON', 'Created_At', 'Updated_At', 'Created_By', 'Meta_JSON'],
      ['task_1', 'once', 'Bad date', '', '', 'normal', 'FALSE', '{}', '[]', 'FALSE', '', 'not-a-date', '', '', '',
        'active', '[]', '', '', 'admin', '{}']
    ]
  });
  const body = post(gas, { action: 'apply_supabase_import' });
  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /Tasks, 2-qator, Deadline_Key/);
  Object.keys(gas.__supabase.rows).forEach(table => {
    assert.strictEqual(gas.__supabase.count(table), 0, table + ' must stay empty');
  });
  assert.strictEqual(gas.storageMode_(), 'sheets');
});

test('a verification that fails does not switch, and says why', () => {
  const gas = sheetsWithTarget();
  // The database rewrites one figure on the way in: the money no longer agrees.
  const originalHandle = gas.__supabase.handle;
  let tampered = false;
  gas.UrlFetchApp.fetch = (url, params) => {
    if (!tampered && params.method === 'post' && /omad_transactions_v2/.test(url)) {
      const rows = JSON.parse(params.payload);
      rows[0].amount_uzs = 1;
      params = Object.assign({}, params, { payload: JSON.stringify(rows) });
      tampered = true;
    }
    return originalHandle(url, params);
  };
  const body = post(gas, { action: 'apply_supabase_import' });
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.verification.ok, false);
  assert.strictEqual(body.verification.money.ok, false, 'the balances disagree');
  assert.strictEqual(gas.storageMode_(), 'sheets', 'the spreadsheet stays the store');
});

test('rolling back works even when the database cannot be reached', () => {
  const gas = sheetsWithTarget();
  assert.strictEqual(post(gas, { action: 'apply_supabase_import' }).status, 'success');
  gas.__properties.SUPABASE_SECRET_KEY = '';
  const broken = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(broken.status, 'error', 'with the key gone the app fails closed');

  const body = post(gas, { action: 'rollback_supabase_storage' });
  assert.strictEqual(body.status, 'success');
  assert.match(body.warning, /faqat Supabase/);
  assert.strictEqual(gas.storageMode_(), 'sheets');
  assert.strictEqual(post(gas, { action: 'get_omad_data', scope: 'dashboard' }).status, 'success');
});

// ------------------------------------------------- what the database enforces

function liveOnSupabase() {
  return loadScript({
    storage: 'supabase',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Cafe_Inventory', JSON.stringify([{ id: 'i1', name: 'Kola', type: 'product', qty: 10, unit: 'dona', sellPrice: 8000, unitCost: 6000, totalCost: 60000 }])],
        ['Cafe_Recipes', '[]']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER, ledgerRow('1786000000000_0')]
    }
  });
}

test('the ledger cannot be deleted or rewritten through the storage layer', () => {
  const gas = liveOnSupabase();
  const ledger = gas.supabaseDoc_(gas.supabaseCredentials_()).getSheetByName('Omad_Transactions_V2');
  assert.throws(() => ledger.deleteRow(2), /append-only/);
  assert.throws(() => ledger.getRange(2, 10).setValue(999), /append-only/);
  assert.throws(() => gas.clearSheetRows_(ledger), /append-only/);
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 1);

  // ...while the one sanctioned change still works.
  const cancelled = post(gas, { action: 'cancel_transaction', transactionId: '1786000000000_0', requestId: 'c1' });
  assert.strictEqual(cancelled.status, 'success');
  assert.strictEqual(gas.__supabase.rows.omad_transactions_v2[0].status, 'Cancelled');
});

test('the legacy migration cannot be re-applied over a live ledger, in either store', () => {
  [liveOnSupabase(), loadScript({
    storage: 'sheets',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']],
      Omad_Transactions_V2: [LEDGER_HEADER, ledgerRow('1786000000000_0')],
      Omad_Transactions: [['ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment', 'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind']]
    }
  })].forEach(gas => {
    const body = post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
    assert.strictEqual(body.status, 'error');
    assert.match(body.message, /jonli/);
    assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length, 2, 'the live ledger is intact');
  });
});

test('a café void keeps the receipt in the database, hidden, and still puts the stock back', () => {
  const gas = liveOnSupabase();
  gas.setUserPassword('kassir', 'kassir-parol-1', 'cafe_seller');
  const token = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: 'kassir', password: 'kassir-parol-1' }))).token;
  const sale = readJsonOutput(gas.doPost(postEvent({
    action: 'save_sale', sessionToken: token, requestId: 'sale_1', id: 'S1', seller: 'kassir',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 2 }]
  })));
  assert.strictEqual(sale.status, 'success', sale.message);

  const voided = readJsonOutput(gas.doPost(postEvent({ action: 'void_sale', sessionToken: token, id: 'S1' })));
  assert.strictEqual(voided.status, 'success');
  assert.strictEqual(voided.stockRestored, true);

  const stored = gas.__supabase.rows.cafe_sales;
  assert.strictEqual(stored.length, 1, 'the receipt row still exists');
  assert.ok(stored[0].voided_at, 'stamped as voided');
  assert.ok(stored[0].receipt.stockConsumption.i1, 'with the frozen consumption it carried');
  assert.strictEqual(gas.supabaseDoc_(gas.supabaseCredentials_()).getSheetByName('Cafe_Sales').getLastRow(), 1,
    'and gone from every read');
  assert.strictEqual(JSON.parse(gas.__supabase.rows.system_config.find(r => r.key === 'Cafe_Inventory').value)[0].qty, 10);

  const again = readJsonOutput(gas.doPost(postEvent({ action: 'void_sale', sessionToken: token, id: 'S1' })));
  assert.strictEqual(again.duplicate, true, 'voiding twice is still a no-op');
});

test('a table larger than one page is read whole', () => {
  const gas = liveOnSupabase();
  const doc = gas.supabaseDoc_(gas.supabaseCredentials_());
  const log = doc.getSheetByName('Omad_Audit_Log');
  const values = [];
  for (let i = 0; i < 2350; i++) values.push(['2026-08-01T09:00:00.000Z', 'e' + i, '']);
  log.getRange(2, 1, values.length, 3).setValues(values);

  const fresh = gas.supabaseDoc_(gas.supabaseCredentials_()).getSheetByName('Omad_Audit_Log');
  const rows = fresh.getDataRange().getValues();
  assert.strictEqual(rows.length, 2351, 'header plus every row, past the 1000-row page');
  assert.strictEqual(rows[2350][1], 'e2349');
  assert.strictEqual(fresh.getLastRow(), 2351);
  assert.strictEqual(fresh.getRange(1501, 2).getValues()[0][0], 'e1499', 'positional reads past a page');
});

test('a write by row number lands on the row that was read, even after a row above it was deleted', () => {
  const gas = liveOnSupabase();
  const doc = gas.supabaseDoc_(gas.supabaseCredentials_());
  const sheet = doc.getSheetByName('Task_Occurrences');
  const header = gas.TASK_OCC_HEADER;
  const make = id => header.map(name => (name === 'ID' ? id : name === 'Task_ID' ? 't1' : name === 'Status' ? 'Open' : ''));
  sheet.getRange(2, 1, 3, header.length).setValues([make('occ_a'), make('occ_b'), make('occ_c')]);

  // This request reads occ_c at row 4...
  const reader = gas.supabaseDoc_(gas.supabaseCredentials_()).getSheetByName('Task_Occurrences');
  assert.strictEqual(reader.getRange(4, 1).getValues()[0][0], 'occ_c');
  // ...another request deletes occ_a, which on a spreadsheet shifts occ_c up...
  gas.supabaseDoc_(gas.supabaseCredentials_()).getSheetByName('Task_Occurrences').deleteRow(2);
  // ...and the first request's write to "row 4" still lands on occ_c, not on nothing or a neighbour.
  reader.getRange(4, header.indexOf('Status') + 1).setValue('Completed');

  const rows = gas.__supabase.rows.task_occurrences;
  assert.deepStrictEqual(rows.map(r => [r.id, r.status]), [['occ_b', 'Open'], ['occ_c', 'Completed']]);
});

test('the speed check times the same reads on both stores, and writes nothing', () => {
  const gas = sheetsWithTarget();
  assert.strictEqual(post(gas, { action: 'apply_supabase_import' }).status, 'success');
  assert.strictEqual(post(gas, { action: 'rollback_supabase_storage' }).status, 'success');

  const before = gas.__supabase.requests.filter(r => r.method !== 'get').length;
  const body = post(gas, { action: 'get_storage_status', benchmark: true });
  assert.strictEqual(body.status, 'success');
  const b = body.benchmark;
  assert.strictEqual(b.sheets.ledgerRows, 3);
  assert.strictEqual(b.supabase.ledgerRows, 3, 'the same ledger, read from the database');
  ['oneSettingMs', 'wholeLedgerMs'].forEach(key => {
    assert.ok(b.sheets[key] >= 0 && b.supabase[key] >= 0, key);
  });
  assert.strictEqual(gas.__supabase.requests.filter(r => r.method !== 'get').length, before, 'read-only');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(gas.__supabase.key));

  // Without the flag the status stays cheap.
  assert.strictEqual(post(gas, { action: 'get_storage_status' }).benchmark, undefined);
});

// ------------------------------------------- one round trip per business action

const { supabaseRoundTrips } = require('./gas-harness');

function liveWithTenants(options = {}) {
  return loadScript(Object.assign({
    storage: 'supabase',
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_GROUP_CHAT_ID: '-100123' },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 100, currency: 'USD', active: true }])],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Cafe_Recipes', '[]']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER, ledgerRow('1786000000000_0')]
    }
  }, options));
}

function newIncome(requestId) {
  return {
    action: 'create_transaction_batch', requestId, groupId: 'g_' + requestId, period: '2026-08',
    tenant: 'Apteka', type: 'Income', comment: 'ijara', source: 'Web', createdBy: 'tester', deferReports: true,
    lines: [{ amount: 100, currency: 'USD', method: 'Naqd' }, { amount: 500000, currency: 'UZS', method: 'Bank' }]
  };
}

test('a business action reaches the database as one write: all of it, or none of it', () => {
  const gas = liveWithTenants();
  const before = gas.__supabase.requests.length;
  const saved = post(gas, newIncome('r1'));
  assert.strictEqual(saved.status, 'success', saved.message);

  const sent = gas.__supabase.requests.slice(before);
  const batches = sent.filter(r => r.table === 'rpc/mbm_apply');
  const ops = batches.flatMap(r => r.body.ops);
  assert.ok(ops.some(op => op.op === 'insert' && op.table === 'omad_transactions_v2' && op.rows.length === 2));
  assert.ok(ops.some(op => op.op === 'insert' && op.table === 'omad_audit_log'));
  assert.ok(batches.some(r => r.body.ops.some(op => op.table === 'omad_transactions_v2') &&
    r.body.ops.some(op => op.table === 'omad_audit_log')), 'the ledger rows and their audit lines travel together');
  assert.ok(!sent.some(r => r.method === 'post' && (r.table === 'omad_transactions_v2' || r.table === 'omad_audit_log')),
    'no row of the action is sent on its own');
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 3);

  // The database refuses the next action's batch: nothing of it is stored.
  const audits = gas.__supabase.count('omad_audit_log');
  const restore = gas.__supabase.fail(r => r.table === 'rpc/mbm_apply' && 'database restarting');
  const refused = post(gas, newIncome('r2'));
  restore();
  assert.strictEqual(refused.status, 'error');
  assert.match(refused.message, /restarting/);
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 3, 'no ledger row');
  assert.strictEqual(gas.__supabase.count('omad_audit_log'), audits, 'and no audit line for a save that did not happen');

  // ...and the retry, with the same request id, records it once.
  assert.strictEqual(post(gas, newIncome('r2')).status, 'success');
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 5);
});

test('a correction the database refuses leaves the original Active and adds nothing', () => {
  const gas = liveWithTenants();
  const restore = gas.__supabase.fail(r => r.table === 'rpc/mbm_apply' &&
    r.body.ops.some(op => op.op === 'update' && op.table === 'omad_transactions_v2') && 'database restarting');
  const corrected = post(gas, {
    action: 'correct_transaction', transactionId: '1786000000000_0', requestId: 'c1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 150, currency: 'USD', method: 'Naqd', deferReports: true
  });
  restore();
  assert.strictEqual(corrected.status, 'error');
  const rows = gas.__supabase.rows.omad_transactions_v2;
  assert.deepStrictEqual(rows.map(r => [r.id, r.status]), [['1786000000000_0', 'Active']],
    'the original is untouched and no replacement exists to double-count');
});

test('kept writes are read back, and are stored before Telegram hears of them', () => {
  let storedWhenSent = -1;
  const gas = liveWithTenants({
    fetch: () => {
      storedWhenSent = gas.__supabase.count('omad_audit_log');
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"result":{"message_id":1}}' };
    }
  });
  gas.resetRequestMemos_();
  const log = gas.appDoc_().getSheetByName('Omad_Audit_Log');
  const stored = () => gas.__supabase.count('omad_audit_log');
  const start = stored();

  gas.withBatchedWrites_(() => {
    log.appendRow(['2026-08-01T09:00:00.000Z', 'first', '']);
    assert.strictEqual(stored(), start, 'kept, not sent yet');
    const rows = log.getDataRange().getValues();
    assert.strictEqual(rows[rows.length - 1][1], 'first', 'a read of the table sees its own write');
    assert.strictEqual(stored(), start + 1, 'because the read sent it first');

    log.appendRow(['2026-08-01T09:00:00.000Z', 'second', '']);
    gas.sendTelegramMessage_('-100123', 'hello');
    assert.strictEqual(storedWhenSent, start + 2, 'the message left only after the row was stored');
  });
});

test('releasing the lock sends the batch, even inside a larger one', () => {
  const gas = liveWithTenants();
  gas.resetRequestMemos_();
  const log = gas.appDoc_().getSheetByName('Omad_Audit_Log');
  const stored = () => gas.__supabase.count('omad_audit_log');
  const start = stored();

  gas.withBatchedWrites_(() => {
    const lock = gas.appScriptLock_();
    lock.waitLock(1000);
    log.appendRow(['2026-08-01T09:00:00.000Z', 'locked', '']);
    assert.strictEqual(stored(), start);
    lock.releaseLock();
    assert.strictEqual(stored(), start + 1, 'another execution may read it once the lock is gone');
    log.appendRow(['2026-08-01T09:00:00.000Z', 'after', '']);
    assert.strictEqual(stored(), start + 1);
  });
  assert.strictEqual(stored(), start + 2);
});

test('taking the lock re-reads what another execution may have changed meanwhile', () => {
  const gas = liveWithTenants();
  gas.resetRequestMemos_();
  const config = gas.appDoc_().getSheetByName('System_Config');
  assert.strictEqual(gas.getConfig(config, 'Cafe_Recipes'), '[]');

  // Another execution changes the setting.
  gas.__supabase.rows.system_config.find(r => r.key === 'Cafe_Recipes').value = '[{"id":"r1"}]';
  assert.strictEqual(gas.getConfig(config, 'Cafe_Recipes'), '[]', 'outside the lock, one view per request');

  const lock = gas.appScriptLock_();
  lock.waitLock(1000);
  try {
    assert.strictEqual(gas.getConfig(config, 'Cafe_Recipes'), '[{"id":"r1"}]', 'under the lock, the stored value');
  } finally {
    lock.releaseLock();
  }
});

test('a database without the batched-writes migration still works, one call at a time', () => {
  const gas = liveWithTenants();
  gas.__supabase.disableRpc();
  const saved = post(gas, newIncome('r1'));
  assert.strictEqual(saved.status, 'success', saved.message);
  assert.strictEqual(gas.__supabase.count('omad_transactions_v2'), 3);
  const dashboard = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(dashboard.status, 'success', dashboard.message);
});

test('the common actions stay within their round-trip budget', () => {
  const gas = liveWithTenants();
  post(gas, { action: 'get_omad_data', scope: 'dashboard' });

  // Settings and row counts arrive together, in parallel: one round trip.
  assert.ok(supabaseRoundTrips(gas, () => post(gas, { action: 'get_omad_data', scope: 'dashboard' })) <= 2);
  // Read under the lock, one batch of writes, the last-operation stamp and the report job.
  assert.ok(supabaseRoundTrips(gas, () => post(gas, newIncome('budget'))) <= 6);
  // The task, its occurrences, its audit line and the stamp in one batch; the
  // board read after it fetches both task tables at once.
  assert.ok(supabaseRoundTrips(gas, () => post(gas, {
    action: 'save_task', type: 'routine', title: 'Budget', recurrence: { freq: 'daily' },
    reminderTimes: ['18:00'], deferReports: true
  })) <= 3);
});

// ------------------------------------------------------ the moment of the switch

test('a writer that waited for the lock across a switch refuses, and writes nothing', () => {
  const gas = sheetsWithTarget();
  gas.resetRequestMemos_();
  const doc = gas.appDoc_();                       // this request chose the spreadsheet...
  gas.__properties.OMAD_STORAGE = 'supabase';      // ...and the move switched while it waited
  const before = gas.__sheetsSpreadsheet
    ? gas.__sheetsSpreadsheet.getSheetByName('Omad_Transactions_V2').data.length
    : gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length;
  assert.throws(() => gas.createTransaction_(doc, {
    requestId: 'late', period: '2026-08', tenant: 'Apteka', type: 'Income', amount: 100,
    currency: 'USD', method: 'Naqd', comment: '', createdBy: 'tester', source: 'Web'
  }), /almashtirildi/);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2').data.length, before,
    'no payment lands in the store nobody reads any more');
});

test('while the move copies, every other request is turned away; a stale marker is not', () => {
  const gas = sheetsWithTarget();
  gas.__properties.OMAD_STORAGE = 'moving:' + Date.now() + ':other';
  const during = post(gas, { action: 'get_omad_data', scope: 'dashboard' });
  assert.strictEqual(during.status, 'error');
  assert.match(during.message, /ko'chirilmoqda/);
  assert.match(post(gas, { action: 'apply_supabase_import' }).message, /davom etmoqda/, 'and a second move is refused');

  // An execution killed mid-move cannot leave the app shut.
  gas.__properties.OMAD_STORAGE = 'moving:' + (Date.now() - 11 * 60 * 1000) + ':dead';
  assert.strictEqual(gas.storageMode_(), 'sheets');
  assert.strictEqual(post(gas, { action: 'get_omad_data', scope: 'dashboard' }).status, 'success');
});

test('a copy that stops halfway says how to reset, and the spreadsheet stays the store', () => {
  const gas = sheetsWithTarget();
  gas.__supabase.fail(r => r.table === 'cafe_sales' && r.method === 'post' && 'connection reset');
  const body = post(gas, { action: 'apply_supabase_import' });
  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /reset_before_cutover\.sql/);
  assert.match(body.message, /connection reset/);
  assert.strictEqual(gas.storageMode_(), 'sheets');
  assert.strictEqual(gas.__properties.OMAD_STORAGE, 'sheets', 'the move marker is cleared');
  assert.ok(body.importStatus.failedAt);
  assert.strictEqual(post(gas, { action: 'get_omad_data', scope: 'dashboard' }).status, 'success');
});

test('a cache revision is bumped again once the batch it announced is stored', () => {
  const gas = liveWithTenants();
  gas.resetRequestMemos_();
  const log = gas.appDoc_().getSheetByName('Omad_Audit_Log');
  const lock = gas.appScriptLock_();
  lock.waitLock(1000);
  log.appendRow(['2026-08-01T09:00:00.000Z', 'kept', '']);
  gas.bumpDataRevision_('OMAD');
  // A lock-free reader here would see this revision with the row not stored yet.
  const announced = Number(gas.dataRevision_('OMAD'));
  lock.releaseLock();
  assert.ok(Number(gas.dataRevision_('OMAD')) > announced, 'so whatever it cached under it is never used');

  // A bump with nothing unsent is not repeated.
  const settled = Number(gas.dataRevision_('OMAD'));
  gas.bumpDataRevision_('OMAD');
  gas.flushPendingWrites_();
  assert.strictEqual(Number(gas.dataRevision_('OMAD')), settled + 1);
});
