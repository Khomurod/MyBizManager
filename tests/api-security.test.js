'use strict';

/**
 * What the /exec URL will answer to a stranger.
 *
 * Anyone who has ever seen the frontend knows the URL — it is hardcoded in
 * three pages served from a public site. Until this change that was enough to
 * read the whole financial ledger, the tenant list, every café sale and its
 * margin, and to write all of it.
 *
 * These tests are the inventory of what is now closed, and of the two reads
 * deliberately left open for one release so the deployed frontend cannot break
 * while Netlify and Apps Script roll out separately.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'api-security-key';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_AUTHORIZED_USER_ID: '49328655',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }])],
        ['Cafe_Inventory', JSON.stringify([{ id: '1', name: 'Kola', type: 'product', qty: 5, unitCost: 6000 }])]
      ],
      Omad_Transactions: [
        LEGACY_HEADER,
        ['1800000000000_0', 'Apteka', '2026-08', 'Income', 1000000, 'UZS', 'Naqd', '12/08/2026', 'ijara', '', '', 'grp_a', '']
      ],
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

/**
 * Actions that refuse an anonymous caller outright.
 *
 * Nothing the pre-key frontend ever called is in here — see GRACED below and
 * rollout-grace.test.js for why that distinction exists.
 */
const STRICT = [
  { action: 'get_omad_data' },
  { action: 'get_cafe_data' },
  { action: 'verify_access' },
  { action: 'tenant_paid_expense', tenant: 'Apteka', period: '2026-08', amount: 1, currency: 'UZS', method: 'Naqd', comment: 'x', requestId: 'r', groupId: 'g' },
  { action: 'list_transactions' },
  { action: 'get_transaction', transactionId: '1' },
  { action: 'get_transaction_history', transactionId: '1' },
  { action: 'create_transaction' },
  { action: 'correct_transaction' },
  { action: 'cancel_transaction' },
  { action: 'audit_transaction_dates' },
  { action: 'fix_transaction_dates' },
  { action: 'backfill_entry_group_ids' },
  { action: 'purge_telegram_debug_secrets' },
  { action: 'rotate_telegram_webhook_secret' },
  { action: 'process_jobs' },
  { action: 'create_backup' },
  { action: 'retry_failed_jobs' },
  { action: 'preview_omad_migration' },
  { action: 'apply_omad_migration' },
  { action: 'verify_omad_migration' },
  { action: 'cutover_omad_migration' },
  { action: 'rollback_omad_migration' },
  { action: 'get_tasks' },
  { action: 'save_task', type: 'once', title: 'x' },
  { action: 'complete_occurrence', occurrenceId: 'x' }
];

/**
 * Actions the pre-key frontend calls.
 *
 * A wrong key is refused. A request with no key at all is accepted while
 * LEGACY_CLIENT_GRACE is on, because the alternative was a live app that could
 * not record a payment.
 */
const GRACED = [
  { action: 'get_system_status' },
  { action: 'get_telegram_settings' },
  { action: 'get_migration_status' },
  { action: 'get_job_queue_status' },
  { action: 'save_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [], allowEmptyOmadTransactions: true, deferReports: true },
  { action: 'migrate_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [], allowEmptyOmadTransactions: true, deferReports: true },
  { action: 'save_inventory', inventory: [] },
  { action: 'save_recipe', recipes: [] },
  { action: 'save_categories', categories: [] },
  { action: 'save_cafe_settings', settings: {} },
  { action: 'save_sale', date: 'x', seller: 'x', total: 1, profit: 1, items: [] },
  { action: 'void_sale', id: '1', inventory: [] },
  { action: 'close_day', date: 'x', seller: 'x', inventory: [], summary: [], totalRevenue: 0, totalProfit: 0, deferReports: true }
];

const GATED = STRICT.concat(GRACED);

test('no strictly gated action answers a caller with no key', () => {
  const gas = boot();
  for (const body of STRICT) {
    const response = post(gas, body);
    assert.equal(response.status, 'error', `${body.action} answered an anonymous caller`);
  }
});

test('no gated action answers a caller with the wrong key', () => {
  const gas = boot();
  for (const body of GATED) {
    const response = post(gas, Object.assign({ adminKey: 'not-the-key' }, body));
    assert.equal(response.status, 'error', `${body.action} accepted a wrong key`);
  }
});

test('with the rollout grace off, every gated action refuses an anonymous caller', () => {
  const gas = boot();
  gas.LEGACY_CLIENT_GRACE = false;
  for (const body of GATED) {
    assert.equal(post(gas, body).status, 'error', `${body.action} answered an anonymous caller`);
  }
});

test('a refusal never carries the data it refused', () => {
  const gas = boot();
  for (const action of ['get_omad_data', 'get_cafe_data']) {
    const dump = JSON.stringify(post(gas, { action }));
    assert.ok(!dump.includes('Apteka'), `${action} leaked a tenant name`);
    assert.ok(!dump.includes('49328655'), `${action} leaked the authorized user id`);
    assert.ok(!dump.includes('-1001234567890'), `${action} leaked a chat id`);
  }

  // The graced reads refuse a wrong key the same way, and say nothing either.
  for (const action of ['get_system_status', 'get_telegram_settings']) {
    const dump = JSON.stringify(post(gas, { action, adminKey: 'not-the-key' }));
    assert.ok(!dump.includes('Apteka'), `${action} leaked a tenant name`);
    assert.ok(!dump.includes('49328655'), `${action} leaked the authorized user id`);
    assert.ok(!dump.includes('-1001234567890'), `${action} leaked a chat id`);
  }
});

test('the correct key opens the authenticated reads', () => {
  const gas = boot();

  const omad = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });
  assert.equal(omad.status, 'success');
  assert.equal(omad.transactions.length, 1);
  assert.equal(omad.tenants[0].name, 'Apteka');

  const cafe = post(gas, { action: 'get_cafe_data', adminKey: ADMIN_KEY });
  assert.equal(cafe.inventory.length, 1);

  assert.equal(post(gas, { action: 'verify_access', adminKey: ADMIN_KEY }).status, 'success');
});

test('the authenticated read returns exactly what the legacy GET returns', () => {
  const gas = boot();
  const legacy = JSON.parse(gas.doGet({ parameter: { action: 'get_omad' } }).__text);
  const authenticated = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });

  // Same payload, one extra status field: the frontend can switch without any
  // change to what it does with the answer.
  assert.deepEqual(authenticated.transactions, legacy.transactions);
  assert.deepEqual(authenticated.tenants, legacy.tenants);
  assert.deepEqual(authenticated.rates, legacy.rates);
  assert.deepEqual(authenticated.templateExpenses, legacy.templateExpenses);
});

test('the anonymous GET routes still answer, for exactly one release', () => {
  const gas = boot();
  // Deliberate: Netlify and Apps Script deploy separately, so removing these
  // in the same change could leave the live frontend calling a route that no
  // longer exists. They are removed once the new path is confirmed live.
  const omad = JSON.parse(gas.doGet({ parameter: { action: 'get_omad' } }).__text);
  assert.equal(omad.transactions.length, 1);
  const cafe = JSON.parse(gas.doGet({ parameter: { action: 'get_cafe' } }).__text);
  assert.ok(Array.isArray(cafe.inventory));
});

test('the task board is still POST-only, and a GET is refused by name', () => {
  const gas = boot();
  const body = JSON.parse(gas.doGet({ parameter: { action: 'get_tasks' } }).__text);
  assert.equal(body.status, 'error');
});

test('the key is compared after the rate limit, so the endpoint cannot be used to guess it', () => {
  const gas = boot();
  let refusals = 0;
  for (let i = 0; i < 40; i++) {
    if (post(gas, { action: 'get_omad_data', adminKey: 'guess-' + i }).status === 'error') refusals++;
  }
  assert.equal(refusals, 40);

  // The throttle has engaged, so even the correct key is refused for now -
  // which is the point: guessing costs the guesser the endpoint.
  const now = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });
  assert.equal(now.status, 'error');
});

test('the Telegram webhook is unaffected by any of this', () => {
  const gas = boot();
  gas.setTelegramSetting_('TELEGRAM_WEBHOOK_SECRET', 'wh-secret-value-0123456789');

  // No key, no initData: a Telegram update is authorized by the webhook secret
  // and the authorized-user gate, exactly as before.
  const output = gas.doPost({
    postData: { contents: JSON.stringify({ message: { chat: { id: 111, type: 'private' }, from: { id: 49328655 }, text: '/yangi' } }) },
    parameter: { wh: 'wh-secret-value-0123456789' }
  });
  assert.ok(output.__html !== undefined, 'the webhook still answers 200 HTML');
  assert.ok(gas.__sentMessages.some(m => String(m.text || '').includes('operatsiya turini')));
});
