'use strict';

/**
 * What the /exec URL will answer to a stranger.
 *
 * Anyone who has ever seen the frontend knows the URL — it is hardcoded in
 * three pages served from a public site. Until this change that was enough to
 * read the whole financial ledger, the tenant list, every café sale and its
 * margin, and to write all of it.
 *
 * These tests are the inventory of what is closed. Nothing is open: the two
 * anonymous reads that briefly survived the rollout, so the deployed frontend
 * could not break while the static host and Apps Script rolled out separately,
 * are gone along with the flag that allowed them.
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
 * Actions that have always refused an anonymous caller.
 *
 * Nothing the pre-key frontend ever called is in here — see FORMERLY_GRACED
 * below, which is now held to exactly the same standard.
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
 * The actions the pre-key frontend used to reach without any key at all.
 *
 * They were opened deliberately and temporarily, because the alternative was a
 * live app that could not record a payment while the two halves deployed
 * separately. That window is closed: they are listed separately only so a
 * regression that re-opens one of them is obvious in the failure output.
 */
const FORMERLY_GRACED = [
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

const GATED = STRICT.concat(FORMERLY_GRACED);

test('no gated action answers a caller with no key', () => {
  const gas = boot();
  for (const body of GATED) {
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

test('there is no flag left that can re-open them', () => {
  const gas = boot();
  // The compatibility layer was a module-level variable and a second access
  // check. Both are gone, so there is nothing to set back to true - and no
  // undocumented bypass for a reader of this file to wonder about.
  assert.strictEqual(gas.LEGACY_CLIENT_GRACE, undefined);
  assert.strictEqual(gas.checkAccessKeyDuringRollout_, undefined);
});

test('a refusal never carries the data it refused', () => {
  const gas = boot();
  for (const action of ['get_omad_data', 'get_cafe_data']) {
    const dump = JSON.stringify(post(gas, { action }));
    assert.ok(!dump.includes('Apteka'), `${action} leaked a tenant name`);
    assert.ok(!dump.includes('49328655'), `${action} leaked the authorized user id`);
    assert.ok(!dump.includes('-1001234567890'), `${action} leaked a chat id`);
  }

  // The formerly-graced reads refuse a wrong key the same way, and say
  // nothing either.
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

test('the authenticated read carries the whole payload the app needs', () => {
  const gas = boot();
  const authenticated = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });

  // This is the only Omad read there is now, so it has to be complete: the
  // ledger, the tenant list, the rates and the expense templates.
  assert.equal(authenticated.status, 'success');
  assert.equal(authenticated.transactions.length, 1);
  assert.equal(authenticated.tenants[0].name, 'Apteka');
  assert.ok(authenticated.rates);
  assert.ok(Array.isArray(authenticated.templateExpenses));
});

test('the anonymous GET routes are gone', () => {
  const gas = boot();
  // These were the exposure: the /exec URL is hardcoded in pages served from a
  // public site, so anyone who had seen the frontend could read all of it.
  ['get_omad', 'get_cafe'].forEach(action => {
    const body = gas.doGet({ parameter: { action } }).getContent();
    assert.equal(body, 'System Database is Active.', `${action} still answers`);
    assert.ok(body.indexOf('Apteka') === -1);
    assert.ok(body.indexOf('transactions') === -1);
  });
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
