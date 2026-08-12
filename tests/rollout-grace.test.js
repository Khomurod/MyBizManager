'use strict';

/**
 * The compatibility window between the two deploys.
 *
 * Netlify serves the frontend from `main` and CI deploys Apps Script from
 * `main`, but they are not the same pipeline and do not land together. When
 * the backend started requiring an access key and the browser had not yet
 * learned to send one, every save failed — no rent recorded, no café sale rung
 * up. This is the narrow, deliberate and temporary hole that keeps the old
 * frontend working, and the boundary of what it does and does not open.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'rollout-admin-key';

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
      System_Config: [['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })]],
      Omad_Transactions: [LEGACY_HEADER],
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

/** Exactly what the frontend deployed before the key change sends. */
const LEGACY_CALLS = [
  { action: 'save_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [], allowEmptyOmadTransactions: true, deferReports: true },
  { action: 'get_migration_status' },
  { action: 'get_system_status' },
  { action: 'get_telegram_settings' },
  { action: 'get_job_queue_status' },
  { action: 'save_inventory', inventory: [] },
  { action: 'save_recipe', recipes: [] },
  { action: 'save_categories', categories: [] },
  { action: 'save_cafe_settings', settings: {} },
  { action: 'save_sale', date: '2026-08-12', seller: 'x', total: 1000, profit: 100, items: [] },
  { action: 'void_sale', id: 'nope', inventory: [] },
  { action: 'close_day', date: '2026-08-12', seller: 'x', inventory: [], summary: [], totalRevenue: 0, totalProfit: 0, deferReports: true }
];

test('a client with no key at all still works, so the live app keeps saving', () => {
  const gas = boot();
  for (const body of LEGACY_CALLS) {
    assert.notEqual(post(gas, body).status, 'error', `${body.action} refused a pre-key client`);
  }
});

test('a wrong key is still refused — the grace covers absence, not error', () => {
  const gas = boot();
  for (const body of LEGACY_CALLS) {
    const response = post(gas, Object.assign({ adminKey: 'not-the-key' }, body));
    assert.equal(response.status, 'error', `${body.action} accepted a wrong key`);
  }
});

test('the correct key works, which is what the updated frontend sends', () => {
  const gas = boot();
  for (const body of LEGACY_CALLS) {
    const response = post(gas, Object.assign({ adminKey: ADMIN_KEY }, body));
    assert.notEqual(response.status, 'error', `${body.action} refused the correct key`);
  }
});

test('the grace does not extend to anything the old frontend never called', () => {
  const gas = boot();
  const stillStrict = [
    { action: 'get_omad_data' },
    { action: 'get_cafe_data' },
    { action: 'verify_access' },
    { action: 'tenant_paid_expense', tenant: 'Apteka', period: '2026-08', amount: 1, currency: 'UZS', method: 'Naqd', comment: 'x', requestId: 'r', groupId: 'g' },
    { action: 'create_transaction' },
    { action: 'correct_transaction' },
    { action: 'cancel_transaction' },
    { action: 'list_transactions' },
    { action: 'create_backup' },
    { action: 'process_jobs' },
    { action: 'retry_failed_jobs' },
    { action: 'preview_omad_migration' },
    { action: 'apply_omad_migration' },
    { action: 'cutover_omad_migration' },
    { action: 'audit_transaction_dates' },
    { action: 'fix_transaction_dates' },
    { action: 'purge_telegram_debug_secrets' },
    { action: 'rotate_telegram_webhook_secret' },
    { action: 'save_telegram_settings' },
    { action: 'configure_telegram_webhook' },
    { action: 'get_tasks' },
    { action: 'save_task', type: 'once', title: 'x' }
  ];

  for (const body of stillStrict) {
    assert.equal(post(gas, body).status, 'error', `${body.action} was opened by the grace`);
  }
});

test('the Mini App gate is untouched by the grace', () => {
  const gas = boot();
  // No initData, no key: a Mini App request is authorized by a signature or
  // not at all, and nothing about the rollout changes that.
  const response = post(gas, { action: 'mini_home' });
  assert.equal(response.status, 'error');
  assert.equal(response.authorized, false);
  assert.equal(post(gas, { action: 'mini_home', adminKey: ADMIN_KEY }).authorized, false);
});

test('turning the grace off closes it again, with nothing else to change', () => {
  const gas = boot();
  gas.LEGACY_CLIENT_GRACE = false;

  for (const body of LEGACY_CALLS) {
    assert.equal(post(gas, body).status, 'error', `${body.action} still open with the grace off`);
  }
  // ...and the correct key still works, so turning it off is not a cutover.
  for (const body of LEGACY_CALLS) {
    assert.notEqual(post(gas, Object.assign({ adminKey: ADMIN_KEY }, body)).status, 'error', body.action);
  }
});

test('a pre-key save actually stores the transaction rather than half-succeeding', () => {
  const gas = boot();
  const response = post(gas, {
    action: 'save_omad',
    transactions: [{ id: '1800000000000_0', tenant: 'Apteka', month: '2026-08', type: 'Income', amount: 1000000, currency: 'UZS', method: 'Naqd' }],
    tenants: [], rates: {}, templateExpenses: [], deferReports: true
  });

  assert.equal(response.status, 'success');
  const rows = gas.readOmadTransactions_(gas.__spreadsheet);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 1000000);
  // It even gets a group id, so nothing about the old client degrades the data.
  assert.ok(rows[0].groupId);
});
