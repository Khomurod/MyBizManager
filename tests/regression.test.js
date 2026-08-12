'use strict';

/**
 * Regression coverage for the business flows that existed before the Telegram
 * hardening change. These must keep behaving exactly as they did.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'correct-admin-key';

/** Business writes now take the access key, so every boot configures one. */
function omadProperties() {
  return { OMAD_ADMIN_KEY: ADMIN_KEY };
}

function omadSheets() {
  return { System_Config: [['Omad_Tenants', '[]']] };
}

const SAMPLE_TX = {
  id: '1700000000000_0',
  tenant: 'Tehnopark',
  month: 'Fevral',
  type: 'Income',
  amount: 6000000,
  currency: 'UZS',
  method: 'Naqd',
  date: '01/02/2026',
  comment: 'Fevral ijara'
};

// ------------------------------------------------------------------ Omad

test('save_omad stores transactions, tenants, rates and template expenses', () => {
  const gas = loadScript({ properties: omadProperties(), sheets: omadSheets() });
  const saved = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [SAMPLE_TX],
    tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
    rates: { Fevral: { buy: 12000, sell: 12500 } },
    templateExpenses: [{ id: 'e1', month: 'Fevral', name: 'Soliq', amount: 1000000, currency: 'UZS' }]
  })));
  assert.strictEqual(saved.status, 'success');

  const loaded = readJsonOutput(gas.doGet({ parameter: { action: 'get_omad' } }));
  assert.strictEqual(loaded.transactions.length, 1);
  assert.strictEqual(loaded.transactions[0].tenant, 'Tehnopark');
  assert.strictEqual(loaded.transactions[0].amount, 6000000);
  assert.strictEqual(loaded.tenants[0].rent, 500);
  assert.strictEqual(loaded.rates.Fevral.sell, 12500);
  assert.strictEqual(loaded.templateExpenses[0].name, 'Soliq');
});

test('save_omad takes a backup snapshot before writing', () => {
  const gas = loadScript({ properties: omadProperties(), sheets: omadSheets() });
  gas.doPost(postEvent({ action: 'save_omad', adminKey: ADMIN_KEY, transactions: [SAMPLE_TX], tenants: [], rates: {}, templateExpenses: [] }));
  const backups = gas.__spreadsheet.getSheetByName('Omad_Backups');
  assert.ok(backups && backups.getLastRow() >= 2, 'a backup row must exist');
});

test('save_omad refuses to wipe existing transactions with an empty payload', () => {
  const gas = loadScript({ properties: omadProperties(), sheets: omadSheets() });
  gas.doPost(postEvent({ action: 'save_omad', adminKey: ADMIN_KEY, transactions: [SAMPLE_TX], tenants: [], rates: {}, templateExpenses: [] }));

  const wiped = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY, transactions: [], tenants: [], rates: {}, templateExpenses: []
  })));
  assert.strictEqual(wiped.status, 'error');

  const loaded = readJsonOutput(gas.doGet({ parameter: { action: 'get_omad' } }));
  assert.strictEqual(loaded.transactions.length, 1, 'existing transactions must survive');
});

test('changed transactions are archived before being overwritten', () => {
  const gas = loadScript({ properties: omadProperties(), sheets: omadSheets() });
  gas.doPost(postEvent({ action: 'save_omad', adminKey: ADMIN_KEY, transactions: [SAMPLE_TX], tenants: [], rates: {}, templateExpenses: [] }));
  gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [Object.assign({}, SAMPLE_TX, { amount: 7000000 })],
    tenants: [], rates: {}, templateExpenses: []
  }));
  const archive = gas.__spreadsheet.getSheetByName('Omad_Transaction_Archive');
  assert.ok(archive && archive.getLastRow() >= 2);
  assert.ok(JSON.stringify(archive.data).includes('before_update'));
});

// ------------------------------------------------------- rate conversion

test('USD converts with the sell rate by default; UZS is unchanged', () => {
  const gas = loadScript();
  const rates = { Fevral: { buy: 12000, sell: 12500 } };
  assert.strictEqual(gas.toUZS_(100, 'USD', 'Fevral', rates), 1250000);
  assert.strictEqual(gas.toUZS_(100, 'USD', 'Fevral', rates, 'buy'), 1200000);
  assert.strictEqual(gas.toUZS_(1250000, 'UZS', 'Fevral', rates), 1250000);
});

test('a legacy numeric rate is treated as both buy and sell', () => {
  const gas = loadScript();
  // Objects built inside the VM live in another realm, so compare by field.
  const numeric = gas.normalizeRateEntry_(12500);
  assert.strictEqual(numeric.buy, 12500);
  assert.strictEqual(numeric.sell, 12500);

  const missing = gas.normalizeRateEntry_(undefined);
  assert.strictEqual(missing.buy, 12500);
  assert.strictEqual(missing.sell, 12500);

  const partial = gas.normalizeRateEntry_({ sell: 13000 });
  assert.strictEqual(partial.buy, 13000, 'buy falls back to sell when absent');
  assert.strictEqual(partial.sell, 13000);
});

test('balances use the sell rate and net income against expenses', () => {
  const gas = loadScript({
    sheets: { System_Config: [['Omad_Rates', JSON.stringify({ Fevral: { buy: 12000, sell: 12500 } })]] }
  });
  const balances = gas.calculateBalancesFromTransactions_([
    { type: 'Income', amount: 100, currency: 'USD', month: 'Fevral' },
    { type: 'Expense', amount: 250000, currency: 'UZS', month: 'Fevral' },
    { type: 'Income', amount: 1000000, currency: 'UZS', month: 'Yanvar' }
  ], 'Fevral');

  assert.strictEqual(balances.monthBalance, 1250000 - 250000);
  assert.strictEqual(balances.allTimeBalance, 1250000 - 250000 + 1000000);
});

// ------------------------------------------------------------------ café

test('café sale, close day and void still work end to end', () => {
  const gas = loadScript({ properties: omadProperties() });

  assert.strictEqual(readJsonOutput(gas.doPost(postEvent({
    action: 'save_sale', adminKey: ADMIN_KEY, date: '2026-01-01', seller: 'kassir', total: 45000, profit: 12000, items: [{ id: 'a', qty: 2 }], id: 'sale-1'
  }))).status, 'success');

  assert.strictEqual(readJsonOutput(gas.doPost(postEvent({
    action: 'close_day', adminKey: ADMIN_KEY, date: '2026-01-01', seller: 'kassir', inventory: [{ id: 'i1', qty: 5 }], summary: [], totalRevenue: 45000, totalProfit: 12000
  }))).status, 'success');

  let cafe = readJsonOutput(gas.doGet({ parameter: { action: 'get_cafe' } }));
  assert.strictEqual(cafe.sales.length, 1);
  assert.strictEqual(cafe.sales[0].total, 45000);
  assert.strictEqual(cafe.closeReports.length, 1);
  assert.strictEqual(cafe.closeReports[0].totalRevenue, 45000);
  assert.strictEqual(cafe.inventory[0].qty, 5);

  assert.strictEqual(readJsonOutput(gas.doPost(postEvent({
    action: 'void_sale', adminKey: ADMIN_KEY, id: 'sale-1', inventory: [{ id: 'i1', qty: 7 }]
  }))).status, 'success');

  cafe = readJsonOutput(gas.doGet({ parameter: { action: 'get_cafe' } }));
  assert.strictEqual(cafe.sales.length, 0, 'voided sale must be removed');
  assert.strictEqual(cafe.inventory[0].qty, 7, 'inventory must be restored');
});

test('café admin saves round-trip through System_Config', () => {
  const gas = loadScript({ properties: omadProperties() });
  gas.doPost(postEvent({ action: 'save_inventory', adminKey: ADMIN_KEY, inventory: [{ id: 'i1', name: 'Kofe', qty: 10 }] }));
  gas.doPost(postEvent({ action: 'save_recipe', adminKey: ADMIN_KEY, recipes: [{ id: 'r1', name: 'Latte' }] }));
  gas.doPost(postEvent({ action: 'save_categories', adminKey: ADMIN_KEY, categories: ['Ichimliklar'] }));
  gas.doPost(postEvent({ action: 'save_cafe_settings', adminKey: ADMIN_KEY, settings: { dailyTarget: 500000 } }));

  const cafe = readJsonOutput(gas.doGet({ parameter: { action: 'get_cafe' } }));
  assert.strictEqual(cafe.inventory[0].name, 'Kofe');
  assert.strictEqual(cafe.recipes[0].name, 'Latte');
  assert.deepStrictEqual(cafe.categories, ['Ichimliklar']);
  assert.strictEqual(cafe.settings.dailyTarget, 500000);
});

// ------------------------------------------------------------ API surface

test('unknown actions are rejected without side effects', () => {
  const gas = loadScript();
  assert.strictEqual(readJsonOutput(gas.doPost(postEvent({ action: 'definitely_not_real' }))).status, 'error');
});

test('doGet without System_Config reports empty rather than throwing', () => {
  const gas = loadScript();
  assert.strictEqual(readJsonOutput(gas.doGet({ parameter: { action: 'get_omad' } })).status, 'empty');
});

test('malformed POST bodies do not throw', () => {
  const gas = loadScript();
  const out = gas.doPost({ postData: { contents: 'not json' } });
  assert.strictEqual(readJsonOutput(out).status, 'error');
});
