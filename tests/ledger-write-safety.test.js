'use strict';

/**
 * No write path may put a legacy row into the ledger.
 *
 * The legacy sheet is thirteen columns; the ledger is twenty-four. Writing the
 * legacy shape into the ledger does not merely misfile a value — the header
 * repair runs first and compares the *legacy* first and last columns, so on a
 * ledger sheet it "fixes" a header that was never broken by stamping thirteen
 * legacy names over Rate_Buy, Rate_Sell, Status and the rest. The row then
 * lands with Tenant in Request_ID and Month in Created_At.
 *
 * The /yangi Telegram conversation reached `appendOmadTransaction_` without
 * checking which schema was live, so one accounting entry after a cutover was
 * enough to do exactly that. These tests pin every path shut.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'ledger-safety-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

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
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }
        ])],
        // The cutover flag: the ledger is live.
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER]
    }
  });
}

function header(gas) {
  return gas.__spreadsheet.getSheetByName('Omad_Transactions_V2')
    .getRange(1, 1, 1, LEDGER_HEADER.length).getValues()[0];
}

function rows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  if (sheet.getLastRow() < 2) return [];
  const all = sheet.getDataRange().getValues();
  return all.slice(1).map(r => {
    const o = {};
    LEDGER_HEADER.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

/**
 * Drives one /yangi entry the way Telegram actually delivers it: a command, a
 * type button, a tenant button, a currency button, then two typed messages.
 * Returns the text sender so a caller can replay the final step.
 */
function runYangi(gas, amount, description) {
  const chat = { id: Number(AUTHORIZED_ID), type: 'private' };
  const from = { id: Number(AUTHORIZED_ID), first_name: 'Xurshid' };
  const secret = gas.getOrCreateWebhookSecret_();

  const send = text => gas.doPost(postEvent(
    { message: { chat, from, text } }, { wh: secret }));
  const press = data => gas.doPost(postEvent({
    callback_query: { id: 'cb_' + data, from, data, message: { chat, message_id: 1 } }
  }, { wh: secret }));

  send('/yangi');
  press('bot_type:Income');
  press('bot_ten:0');
  press('bot_curr:UZS');
  send(amount);
  send(description);
  return send;
}

// --------------------------------------------------------------- the header

test('the legacy header repair refuses to touch the ledger sheet', () => {
  const gas = boot();
  const before = header(gas);

  gas.ensureOmadTransactionHeader_(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2'));

  assert.deepStrictEqual(Array.from(header(gas)), Array.from(before),
    'the twenty-four column header survives');
  assert.strictEqual(header(gas)[12], 'Rate_Sell',
    'column 13 is still Rate_Sell, not Entry_Kind');
});

// ---------------------------------------------------------------- appending

test('appending one transaction while the ledger is live writes a ledger row', () => {
  const gas = boot();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: '1800000000000_0', tenant: 'Apteka', month: '2026-08', type: 'Income',
    amount: 1000000, currency: 'UZS', method: 'Naqd', comment: 'ijara',
    requestId: 'req_1', groupId: 'grp_1', entryKind: ''
  });

  const written = rows(gas);
  assert.strictEqual(written.length, 1);

  const row = written[0];
  assert.strictEqual(String(row.ID), '1800000000000_0');
  assert.strictEqual(String(row.Tenant), 'Apteka', 'the tenant is in Tenant, not Request_ID');
  assert.strictEqual(String(row.Request_ID), 'req_1');
  assert.strictEqual(String(row.Period), '2026-08', 'the period is in Period, not Created_At');
  assert.strictEqual(Number(row.Amount), 1000000);
  assert.strictEqual(String(row.Status), 'Active');
  assert.strictEqual(String(row.Entry_Group_ID), 'grp_1');
  assert.strictEqual(Number(row.Amount_UZS), 1000000, 'the converted value is frozen on the row');
  assert.ok(String(row.Created_At).indexOf('T') !== -1, 'Created_At is an ISO timestamp');

  // ...and the header is untouched.
  assert.strictEqual(header(gas)[12], 'Rate_Sell');
});

test('a USD append freezes the rate it used', () => {
  const gas = boot();

  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: '1800000000001_0', tenant: 'Apteka', month: '2026-08', type: 'Income',
    amount: 100, currency: 'USD', method: 'Bank', requestId: 'req_usd', groupId: 'grp_usd'
  });

  const row = rows(gas)[0];
  const used = Number(row.Rate_Used);
  assert.ok(used > 0, 'a rate was recorded');
  assert.ok(used === Number(row.Rate_Buy) || used === Number(row.Rate_Sell));
  assert.strictEqual(Number(row.Amount_UZS), Math.round(100 * used));
});

test('the group append refuses outright rather than corrupting the ledger', () => {
  const gas = boot();

  assert.throws(
    () => gas.appendOmadTransactionGroup_(gas.__spreadsheet, [
      { id: '1800000000002_0', tenant: 'Apteka', month: '2026-08', type: 'Income', amount: 1, currency: 'UZS', method: 'Naqd' }
    ]),
    /ledger/i,
    'it names the ledger writer to use instead');

  assert.strictEqual(rows(gas).length, 0, 'nothing was written');
  assert.strictEqual(header(gas)[12], 'Rate_Sell', 'and the header is intact');
});

// ----------------------------------------------------- the Telegram entry point

test('a Telegram /yangi entry lands as a well-formed ledger row', () => {
  const gas = boot();

  // The real conversation: the first three steps are inline buttons, only the
  // amount and the description are typed.
  runYangi(gas, '250000', 'avgust ijara');

  const written = rows(gas);
  assert.strictEqual(written.length, 1, 'the entry was recorded once');

  const row = written[0];
  assert.strictEqual(String(row.Tenant), 'Apteka',
    'the tenant is in Tenant -- it used to land in Request_ID');
  assert.strictEqual(String(row.Type), 'Income');
  assert.strictEqual(Number(row.Amount), 250000);
  assert.strictEqual(String(row.Currency), 'UZS');
  assert.strictEqual(String(row.Method), 'Naqd');
  assert.strictEqual(String(row.Status), 'Active');
  assert.ok(String(row.Period).match(/^\d{4}-\d{2}$/), 'the period is canonical');
  assert.ok(String(row.Entry_Group_ID), 'the entry has a group of its own');

  // The structural check: the header is still the ledger's.
  assert.deepStrictEqual(Array.from(header(gas)), LEDGER_HEADER);
});

test('the same Telegram entry replayed does not write a second row', () => {
  const gas = boot();
  const send = runYangi(gas, '250000', 'avgust ijara');
  const after = rows(gas).length;

  // A redelivered final message resolves to the record the first one created.
  send('avgust ijara');
  assert.strictEqual(rows(gas).length, after, 'no duplicate row');
});

// ------------------------------------------------- the whole-list save is inert

test('a whole-list save changes no transaction while the ledger is live', () => {
  const gas = boot();
  gas.appendOmadTransaction_(gas.__spreadsheet, {
    id: '1800000000003_0', tenant: 'Apteka', month: '2026-08', type: 'Income',
    amount: 500000, currency: 'UZS', method: 'Naqd', requestId: 'req_keep', groupId: 'grp_keep'
  });
  const before = JSON.stringify(rows(gas));

  const saved = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY, deferReports: true,
    // A stale client trying to replace the whole ledger with one row.
    transactions: [{ id: 'x_0', tenant: 'Apteka', month: '2026-08', type: 'Income', amount: 1, currency: 'UZS', method: 'Naqd' }],
    tenants: [{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }],
    rates: { '2026-08': { buy: 12000, sell: 12500 } },
    templateExpenses: []
  })));

  assert.strictEqual(saved.status, 'success', 'the settings half still saves');
  assert.strictEqual(JSON.stringify(rows(gas)), before,
    'not one transaction row changed');
});
