'use strict';

/**
 * Telegram Mini App authentication.
 *
 * The whole security model is one sentence: a request is authorized only if
 * Telegram signed it with a key derived from the bot token AND the signed
 * numeric user id equals TELEGRAM_AUTHORIZED_USER_ID.
 *
 * Everything below is an attempt to get in some other way.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
// A token the backend does not hold. Derived from the fixture rather than
// written out, so the secret scanners keep exactly one allowlisted literal.
const OTHER_TOKEN = BOT_TOKEN.replace('123456789', '987654321').replace('AAFake', 'BBFake');
const AUTHORIZED_ID = '49328655';
const INTRUDER_ID = '11112222';
const ADMIN_KEY = 'mini-admin-key';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

/** Signs initData exactly the way Telegram does. */
function signInitData(fields, token = BOT_TOKEN) {
  const pairs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`);
  const dataCheckString = pairs.join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const encoded = Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`)
    .join('&');
  return `${encoded}&hash=${hash}`;
}

function initDataFor(userId = AUTHORIZED_ID, options = {}) {
  const authDate = options.authDate || Math.floor(Date.now() / 1000);
  return signInitData({
    auth_date: String(authDate),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(userId), first_name: 'Xurshid', username: 'boss' })
  }, options.token || BOT_TOKEN);
}

function boot(options = {}) {
  return loadScript({
    properties: Object.assign({
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    }, options.properties || {}),
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }])],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 1000000 })]
      ],
      Omad_Transactions: [LEGACY_HEADER],
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

// ------------------------------------------------------------ the happy path

test('the authorized user, with a genuine signature, gets data', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', initData: initDataFor() });

  assert.equal(response.status, 'success');
  assert.equal(response.authorized, true);
  assert.equal(response.user.id, AUTHORIZED_ID);

  // The first screen is Omad, so the first request answers Omad completely...
  assert.ok(response.omad);
  assert.ok(Array.isArray(response.tenants));
  assert.ok(Array.isArray(response.transactions));

  // ...and nothing else. Building the café summary and the whole task view for
  // tabs nobody has opened cost two more full sheet reads on every launch.
  assert.ok(!response.cafe, 'the café summary is not built until the tab is opened');
  assert.ok(!response.tasks, 'the task view is not built until the tab is opened');
});

// --------------------------------------------------------------- forgeries

test('a different Telegram user is refused even with a perfect signature', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', initData: initDataFor(INTRUDER_ID) });

  assert.equal(response.status, 'error');
  assert.equal(response.authorized, false);
  assert.equal(response.reason, 'not_authorized');
  assert.ok(!response.omad, 'no data leaks alongside the refusal');
});

test('editing the user id after signing breaks the signature', () => {
  const gas = boot();
  const genuine = initDataFor(INTRUDER_ID);
  // Swap the intruder's id for the authorized one, keeping the original hash.
  const forged = genuine.replace(
    encodeURIComponent(JSON.stringify({ id: Number(INTRUDER_ID), first_name: 'Xurshid', username: 'boss' })),
    encodeURIComponent(JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid', username: 'boss' })));

  const response = post(gas, { action: 'mini_home', initData: forged });
  assert.equal(response.reason, 'bad_signature');
});

test('a payload signed with a different bot token is refused', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID, { token: OTHER_TOKEN }) });
  assert.equal(response.reason, 'bad_signature');
});

test('no initData at all is refused, with the message to open it from the bot', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home' });

  assert.equal(response.status, 'error');
  assert.equal(response.reason, 'missing_init_data');
  assert.ok(response.message.includes('Telegram bot orqali'));
});

test('a user id supplied outside the signature is ignored entirely', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', userId: AUTHORIZED_ID, user: { id: AUTHORIZED_ID } });
  assert.equal(response.status, 'error');
});

test('the admin key does not open the Mini App', () => {
  const gas = boot();
  const response = post(gas, { action: 'mini_home', adminKey: ADMIN_KEY });

  assert.equal(response.status, 'error');
  assert.ok(!response.omad, 'the key that unlocks the web app is not a Mini App credential');
});

test('a payload with no hash is refused', () => {
  const gas = boot();
  const response = post(gas, {
    action: 'mini_home',
    initData: `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify({ id: Number(AUTHORIZED_ID) }))}`
  });
  assert.equal(response.reason, 'missing_hash');
});

test('a signed payload carrying no user is refused', () => {
  const gas = boot();
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAF' });
  assert.equal(post(gas, { action: 'mini_home', initData }).reason, 'missing_user');
});

// ------------------------------------------------------------------ freshness

test('a payload older than the window is refused', () => {
  const gas = boot();
  const old = Math.floor(Date.now() / 1000) - (25 * 60 * 60);
  const response = post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID, { authDate: old }) });

  assert.equal(response.reason, 'stale');
  assert.ok(response.message.includes('qaytadan oching'));
});

test('a payload just inside the window is accepted', () => {
  const gas = boot();
  const recent = Math.floor(Date.now() / 1000) - (23 * 60 * 60);
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID, { authDate: recent }) }).status, 'success');
});

test('a payload dated in the future is refused', () => {
  const gas = boot();
  const ahead = Math.floor(Date.now() / 1000) + (60 * 60);
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID, { authDate: ahead }) }).reason, 'auth_date_in_future');
});

test('changing auth_date to refresh a stale payload breaks the signature', () => {
  const gas = boot();
  const old = Math.floor(Date.now() / 1000) - (25 * 60 * 60);
  const stale = initDataFor(AUTHORIZED_ID, { authDate: old });
  const forged = stale.replace(`auth_date=${old}`, `auth_date=${Math.floor(Date.now() / 1000)}`);

  assert.equal(post(gas, { action: 'mini_home', initData: forged }).reason, 'bad_signature');
});

test('with no bot token configured nothing is authorized', () => {
  const gas = boot({ properties: { TELEGRAM_BOT_TOKEN: '' } });
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor() }).reason, 'bot_token_missing');
});

test('with no authorized user configured nothing is authorized', () => {
  const gas = boot({ properties: { TELEGRAM_AUTHORIZED_USER_ID: '' } });
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor() }).reason, 'not_authorized');
});

// ------------------------------------------------------- one source of truth

test('the Mini App follows TELEGRAM_AUTHORIZED_USER_ID, exactly as /yangi does', () => {
  const gas = boot();
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor(INTRUDER_ID) }).status, 'error');

  // Same property, same effect, no second user list anywhere.
  gas.setTelegramSetting_('TELEGRAM_AUTHORIZED_USER_ID', INTRUDER_ID);
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor(INTRUDER_ID) }).status, 'success');
  assert.equal(post(gas, { action: 'mini_home', initData: initDataFor(AUTHORIZED_ID) }).status, 'error');
  assert.equal(gas.isAuthorizedTelegramUser_(INTRUDER_ID), true);
});

// ------------------------------------------------------------------ mutations

test('every Mini App mutation is behind the same gate', () => {
  const gas = boot();
  const mutations = [
    { action: 'mini_save_transaction', type: 'Income', tenant: 'Apteka', period: '2026-08', amount: 1000, currency: 'UZS', method: 'Naqd', requestId: 'r1' },
    { action: 'mini_tenant_paid', tenant: 'Apteka', period: '2026-08', amount: 1000, currency: 'UZS', method: 'Naqd', comment: 'x', requestId: 'r2', groupId: 'g2' },
    { action: 'mini_task_action', taskAction: 'save_task', type: 'once', title: 'x' }
  ];

  for (const body of mutations) {
    assert.equal(post(gas, body).status, 'error', body.action + ' without initData');
    assert.equal(post(gas, Object.assign({}, body, { initData: initDataFor(INTRUDER_ID) })).status, 'error',
      body.action + ' as another user');
  }
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0, 'nothing was written');
});

test('an authorized income is written through the ordinary accounting path', () => {
  const gas = boot();
  const response = post(gas, {
    action: 'mini_save_transaction', initData: initDataFor(),
    type: 'Income', tenant: 'Apteka', period: '2026-08',
    amount: 500000, currency: 'UZS', method: 'Naqd', comment: 'ijara', requestId: 'mini_r1'
  });

  assert.equal(response.status, 'success');
  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant, 'Apteka');
  assert.ok(rows[0].groupId.startsWith('grp_'), 'it gets a real group id like every other entry');
});

test('the same request id twice does not create a second transaction', () => {
  const gas = boot();
  const body = {
    action: 'mini_save_transaction', initData: initDataFor(),
    type: 'Expense', tenant: 'Umumiy Naqd Puldan', period: '2026-08',
    amount: 200000, currency: 'UZS', method: 'Naqd', requestId: 'mini_dup'
  };
  post(gas, body);
  const second = post(gas, body);

  assert.equal(second.duplicate, true);
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 1);
});

test('an income against an expense bucket is refused', () => {
  const gas = boot();
  const response = post(gas, {
    action: 'mini_save_transaction', initData: initDataFor(),
    type: 'Income', tenant: 'Umumiy Naqd Puldan', period: '2026-08',
    amount: 1000, currency: 'UZS', method: 'Naqd', requestId: 'mini_bad'
  });
  assert.equal(response.status, 'error');
  assert.equal(gas.readOmadTransactions_(gas.__spreadsheet).length, 0);
});

test('the Mini App writes a tenant-paid pair through the shared implementation', () => {
  const gas = boot();
  const response = post(gas, {
    action: 'mini_tenant_paid', initData: initDataFor(),
    tenant: 'Apteka', period: '2026-08', amount: 1000000, currency: 'UZS',
    method: 'Naqd', comment: 'Elektrik xizmati', requestId: 'mini_tp', groupId: 'grp_mini_tp'
  });

  assert.equal(response.status, 'success');
  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.entryKind === 'tenant_paid_expense'));
  assert.equal(gas.calculateActuals_(rows, '2026-08').cash, 0);
});

// -------------------------------------------------------------------- reading

test('the summaries are computed on the server, not shipped raw', () => {
  const gas = boot();
  post(gas, {
    action: 'mini_save_transaction', initData: initDataFor(),
    type: 'Income', tenant: 'Apteka', period: '2026-08',
    amount: 400000, currency: 'UZS', method: 'Naqd', requestId: 'mini_sum'
  });

  const response = post(gas, { action: 'mini_omad', initData: initDataFor(), period: '2026-08' });
  assert.equal(response.omad.income, 400000);
  assert.equal(response.omad.cash, 400000);
  assert.equal(response.omad.tenantDebt, 600000, 'the debt comes from the shared tenant rules');
  assert.equal(response.transactions.length, 1);
  assert.equal(response.tenants[0].name, 'Apteka');
});

test('the café section reports today and the month without shipping every sale', () => {
  const gas = boot();
  const todayIso = new Date().toISOString();
  gas.__spreadsheet.getSheetByName('Cafe_Sales').appendRow([todayIso, 'cafe_admin', 241000, 56459, '[]', 'sale1']);

  const response = post(gas, { action: 'mini_cafe', initData: initDataFor() });
  assert.equal(response.cafe.today.revenue, 241000);
  assert.equal(response.cafe.today.profit, 56459);
  assert.equal(response.cafe.month.revenue, 241000);
  assert.equal(response.cafe.target.daily, 1000000);
  assert.equal(response.cafe.target.progress, 24);
  assert.equal(response.cafe.recentSales.length, 1);
  assert.ok(!JSON.stringify(response).includes('Chek_Tafsilotlari'));
});

test('an unknown mini_ action is refused rather than falling through', () => {
  const gas = boot();
  assert.equal(post(gas, { action: 'mini_nonsense', initData: initDataFor() }).message, 'Unknown action');
  // And still refuses without a signature.
  assert.equal(post(gas, { action: 'mini_nonsense' }).status, 'error');
});
