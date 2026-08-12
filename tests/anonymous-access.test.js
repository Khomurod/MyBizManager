'use strict';

/**
 * What a stranger with the /exec URL can get out of this system.
 *
 * The URL is not a secret and never was: it is hardcoded in three pages served
 * from a public site, so everyone who has opened the app knows it. For one
 * release that was enough to read the whole ledger, the tenant list and every
 * café sale with its margin — the compatibility window that kept the pre-key
 * frontend saving while the two halves deployed separately.
 *
 * That window is closed. This file is the proof, written from the outside: it
 * asks the same questions an intruder would and pins the answers.
 *
 * The one door that stays open is the Telegram Mini App, and it opens on a
 * different key entirely — a signature Telegram computes from the bot token,
 * for one specific user id. The admin key is neither sent to it nor accepted
 * from it.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'anonymous-access-admin-key';
const WRONG_KEY = 'not-the-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';
const INTRUDER_ID = '11112222';

const TENANT = 'Apteka';
const CHAT_ID = '-1001234567890';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

/** Signs initData exactly the way Telegram does. */
function signInitData(fields, token = BOT_TOKEN) {
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const encoded = Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&');
  return `${encoded}&hash=${hash}`;
}

function initDataFor(userId = AUTHORIZED_ID, options = {}) {
  return signInitData({
    auth_date: String(options.authDate || Math.floor(Date.now() / 1000)),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(userId), first_name: 'Xurshid', username: 'boss' })
  }, options.token || BOT_TOKEN);
}

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: CHAT_ID
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: TENANT, defaultRent: 1000000, currency: 'UZS', active: true }])],
        ['Cafe_Inventory', JSON.stringify([{ id: '1', name: 'Kola', type: 'product', qty: 5, unitCost: 6000 }])]
      ],
      Omad_Transactions: [
        LEGACY_HEADER,
        ['1800000000000_0', TENANT, '2026-08', 'Income', 1000000, 'UZS', 'Naqd', '12/08/2026', 'ijara', '', '', 'grp_a', '']
      ],
      Cafe_Sales: [
        ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'],
        ['2026-08-12', 'kassir', 45000, 12000, '[]', 'sale-1']
      ]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

function get(gas, action) {
  return gas.doGet({ parameter: { action } }).getContent();
}

/** The values that must never come back to someone who was refused. */
function assertRevealsNothing(dump, context) {
  [TENANT, CHAT_ID, AUTHORIZED_ID, '1000000', '45000'].forEach(secretish => {
    assert.ok(String(dump).indexOf(secretish) === -1,
      `${context} revealed ${secretish}`);
  });
}

// ------------------------------------------------------------------- reads

test('anonymous Omad read fails', () => {
  const gas = boot();

  // Over GET, which is how it used to work...
  assert.strictEqual(get(gas, 'get_omad'), 'System Database is Active.');
  assertRevealsNothing(get(gas, 'get_omad'), 'the anonymous Omad GET');

  // ...and over POST, which is how the app talks now.
  const posted = post(gas, { action: 'get_omad_data' });
  assert.strictEqual(posted.status, 'error');
  assertRevealsNothing(JSON.stringify(posted), 'the anonymous Omad read');
});

test('anonymous Café read fails', () => {
  const gas = boot();

  assert.strictEqual(get(gas, 'get_cafe'), 'System Database is Active.');
  assertRevealsNothing(get(gas, 'get_cafe'), 'the anonymous café GET');

  const posted = post(gas, { action: 'get_cafe_data' });
  assert.strictEqual(posted.status, 'error');
  assertRevealsNothing(JSON.stringify(posted), 'the anonymous café read');
});

// ------------------------------------------------------------------ writes

test('anonymous Omad write fails and changes nothing', () => {
  const gas = boot();
  const before = JSON.stringify(gas.__spreadsheet.getSheetByName('Omad_Transactions').data);

  const attempts = [
    {
      action: 'save_omad',
      transactions: [{ id: '9', tenant: TENANT, month: '2026-08', type: 'Income', amount: 99999999, currency: 'UZS', method: 'Naqd' }],
      tenants: [], rates: {}, templateExpenses: [], deferReports: true
    },
    { action: 'migrate_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [], allowEmptyOmadTransactions: true },
    {
      action: 'tenant_paid_expense', tenant: TENANT, period: '2026-08', amount: 1,
      currency: 'UZS', method: 'Naqd', comment: 'x', requestId: 'r', groupId: 'g'
    },
    { action: 'create_transaction' },
    { action: 'cancel_transaction' }
  ];

  attempts.forEach(body => {
    assert.strictEqual(post(gas, body).status, 'error', `${body.action} accepted an anonymous write`);
  });

  assert.strictEqual(
    JSON.stringify(gas.__spreadsheet.getSheetByName('Omad_Transactions').data), before,
    'the ledger is byte-for-byte unchanged');
});

test('anonymous Café write fails and changes nothing', () => {
  const gas = boot();
  const before = JSON.stringify(gas.__spreadsheet.getSheetByName('Cafe_Sales').data);

  const attempts = [
    { action: 'save_inventory', inventory: [] },
    { action: 'save_recipe', recipes: [] },
    { action: 'save_categories', categories: [] },
    { action: 'save_cafe_settings', settings: {} },
    { action: 'save_sale', date: '2026-08-12', seller: 'x', total: 1, profit: 1, items: [] },
    { action: 'void_sale', id: 'sale-1', inventory: [] },
    { action: 'close_day', date: '2026-08-12', seller: 'x', inventory: [], summary: [], totalRevenue: 0, totalProfit: 0 }
  ];

  attempts.forEach(body => {
    assert.strictEqual(post(gas, body).status, 'error', `${body.action} accepted an anonymous write`);
  });

  assert.strictEqual(
    JSON.stringify(gas.__spreadsheet.getSheetByName('Cafe_Sales').data), before,
    'the sales sheet is unchanged');
  // The void above named a real sale id, so this is the one that matters.
  assert.ok(JSON.stringify(gas.__spreadsheet.getSheetByName('Cafe_Sales').data).indexOf('sale-1') !== -1,
    'the real sale survived an anonymous void');
});

// --------------------------------------------------------------- wrong key

test('a wrong key fails everywhere a right one would work', () => {
  const gas = boot();
  const everything = [
    { action: 'get_omad_data' }, { action: 'get_cafe_data' }, { action: 'verify_access' },
    { action: 'get_system_status' }, { action: 'get_telegram_settings' },
    { action: 'get_migration_status' }, { action: 'get_job_queue_status' },
    { action: 'get_tasks' }, { action: 'get_health' },
    { action: 'save_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [], allowEmptyOmadTransactions: true },
    { action: 'save_sale', date: 'x', seller: 'x', total: 1, profit: 1, items: [] },
    { action: 'purge_telegram_debug_secrets' }, { action: 'rotate_telegram_webhook_secret' },
    { action: 'backfill_entry_group_ids' }, { action: 'fix_transaction_dates' },
    { action: 'create_backup' }
  ];

  everything.forEach(body => {
    const response = post(gas, Object.assign({ adminKey: WRONG_KEY }, body));
    assert.strictEqual(response.status, 'error', `${body.action} accepted the wrong key`);
    assertRevealsNothing(JSON.stringify(response), `${body.action} refused`);
  });
});

test('the wrong key is not distinguishable from no key by the answer', () => {
  const gas = boot();
  // Otherwise the endpoint tells an attacker whether a guess was closer.
  const anonymous = post(gas, { action: 'get_omad_data' });
  const wrong = post(gas, { action: 'get_omad_data', adminKey: WRONG_KEY });
  assert.strictEqual(anonymous.status, 'error');
  assert.strictEqual(wrong.status, 'error');
});

// --------------------------------------------------------------- right key

test('the correct key succeeds', () => {
  const gas = boot();

  assert.strictEqual(post(gas, { action: 'verify_access', adminKey: ADMIN_KEY }).status, 'success');

  const omad = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });
  assert.strictEqual(omad.status, 'success');
  assert.strictEqual(omad.transactions.length, 1);
  assert.strictEqual(omad.tenants[0].name, TENANT);

  const cafe = post(gas, { action: 'get_cafe_data', adminKey: ADMIN_KEY });
  assert.strictEqual(cafe.inventory.length, 1);
  assert.strictEqual(cafe.sales.length, 1);

  const saved = post(gas, {
    action: 'save_omad', adminKey: ADMIN_KEY, deferReports: true,
    transactions: [
      { id: '1800000000000_0', tenant: TENANT, month: '2026-08', type: 'Income', amount: 1000000, currency: 'UZS', method: 'Naqd' },
      { id: '1800000000001_0', tenant: TENANT, month: '2026-08', type: 'Income', amount: 250000, currency: 'UZS', method: 'Naqd' }
    ],
    tenants: [], rates: {}, templateExpenses: []
  });
  assert.strictEqual(saved.status, 'success');
});

// ------------------------------------------------------------- the Mini App

test('an authorized Telegram Mini App request succeeds', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID) });

  assert.notStrictEqual(response.status, 'error');
  assert.notStrictEqual(response.authorized, false);
});

test('an unauthorized Telegram user fails', () => {
  const gas = boot();
  // Correctly signed by the real bot, but the wrong person. There is one
  // authorized id and no second user list.
  const response = post(gas, { action: 'mini_home', initData: initDataFor(INTRUDER_ID) });

  assert.strictEqual(response.authorized, false);
  assertRevealsNothing(JSON.stringify(response), 'an unauthorized Mini App request');
});

test('forged initData fails', () => {
  const gas = boot();
  const forgeries = [
    // Signed with a token the backend does not hold.
    initDataFor(AUTHORIZED_ID, { token: BOT_TOKEN.replace('123456789', '987654321').replace('AAFake', 'BBFake') }),
    // The right user, no signature at all.
    `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify({ id: Number(AUTHORIZED_ID) }))}`,
    // A real signature with the user swapped underneath it.
    initDataFor(INTRUDER_ID).replace(String(INTRUDER_ID), String(AUTHORIZED_ID)),
    ''
  ];

  forgeries.forEach((initData, i) => {
    const response = post(gas, { action: 'mini_home', initData });
    assert.strictEqual(response.authorized, false, `forgery ${i} was accepted`);
  });
});

test('stale initData fails', () => {
  const gas = boot();
  // Genuinely signed, genuinely the right user, and two days old. A captured
  // payload must not be replayable forever.
  const stale = initDataFor(AUTHORIZED_ID, { authDate: Math.floor(Date.now() / 1000) - 172800 });
  const response = post(gas, { action: 'mini_home', initData: stale });

  assert.strictEqual(response.authorized, false);
});

test('the admin key opens nothing in the Mini App', () => {
  const gas = boot();
  // The Mini App runs in Telegram's webview on a phone. Shipping the admin key
  // to it would put the key on a device, so it is authorized by signature only
  // and the key is not an accepted substitute.
  const response = post(gas, { action: 'mini_home', adminKey: ADMIN_KEY });

  assert.strictEqual(response.authorized, false);
  assertRevealsNothing(JSON.stringify(response), 'a Mini App request carrying the admin key');
});

// ------------------------------------------------- /mini in a normal browser

test('direct browser access to /mini reveals no private data', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'mini.html'), 'utf8');

  // The page is static and ships no data. Everything it shows arrives later,
  // over a request that has to carry Telegram's signature.
  assertRevealsNothing(page, 'mini.html as served');
  assert.ok(page.indexOf('adminKey') === -1, 'the page never mentions the admin key');
  assert.ok(page.indexOf(ADMIN_KEY) === -1);
  assert.ok(page.indexOf('omad_access_key') === -1,
    'and it never reads the key the web app stores in localStorage');

  // Opened outside Telegram there is no initData, so the server is asked for
  // nothing it would answer.
  const gas = boot();
  const response = post(gas, { action: 'mini_home', initData: '' });
  assert.strictEqual(response.authorized, false);
});
