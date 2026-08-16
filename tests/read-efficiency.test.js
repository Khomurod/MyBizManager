'use strict';

/**
 * How many times one request reads a sheet.
 *
 * Every figure this system shows is derived from a full pass over a sheet, so
 * the count of those passes *is* the response time. The costs were not
 * theoretical: painting the Mini App's first tab read the whole ledger four
 * times across two round trips, every accounting entry read it twice more to
 * compose its Telegram report, and every café sale read the 700-row sales
 * sheet twice.
 *
 * None of that is visible in a correctness test — the answers were right, just
 * expensively. So the counts are asserted here directly, by counting the calls
 * rather than by timing anything, which stays stable on a slow machine.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'read-efficiency-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

/** Twelve transactions, so a wasted pass is a wasted pass over real rows. */
function ledgerRows() {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push([
      `18000000000${String(i).padStart(2, '0')}_0`, 'Apteka', '2026-08', 'Income',
      100000 + i, 'UZS', 'Naqd', '12/08/2026', 'ijara', '', `req_${i}`, `grp_${i}`, ''
    ]);
  }
  return rows;
}

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_q',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

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
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Kola', type: 'product', qty: 50, unit: 'dona', sellPrice: 8000, unitCost: 6000, totalCost: 300000 }
        ])],
        ['Cafe_Recipes', '[]']
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(ledgerRows()),
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

/**
 * Counts full-sheet reads by name while `run` executes.
 *
 * `getDataRange().getValues()` is the whole-sheet pass; a targeted
 * `getRange(...)` is not, and is not counted.
 */
function countSheetReads(gas, run) {
  const counts = {};
  const sheets = gas.__spreadsheet.getSheets();
  const restore = [];

  sheets.forEach(sheet => {
    const name = sheet.getName();
    const original = sheet.getDataRange;
    restore.push(() => { sheet.getDataRange = original; });
    sheet.getDataRange = function () {
      const range = original.call(sheet);
      const inner = range.getValues;
      range.getValues = function () {
        counts[name] = (counts[name] || 0) + 1;
        return inner.call(range);
      };
      return range;
    };
  });

  try { run(); } finally { restore.forEach(fn => fn()); }
  return counts;
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

// ------------------------------------------------------------------ Mini App

test('the Mini App first screen reads the ledger once', () => {
  const gas = boot();
  const initData = signedInitData();

  const counts = countSheetReads(gas, () => {
    const body = readJsonOutput(gas.doPost(postEvent({
      action: 'mini_home', initData, period: '2026-08'
    })));
    assert.strictEqual(body.status, 'success');
    assert.ok(body.omad && body.tenants && body.transactions,
      'and it answers Omad completely');
  });

  assert.strictEqual(counts.Omad_Transactions, 1,
    'the summary, the tenant status and the recent entries share one pass');
  assert.ok(!counts.Cafe_Sales, 'the café sheet is not touched for the Omad tab');
});

test('the Mini App first screen does not build the café or task views', () => {
  const gas = boot();
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_home', initData: signedInitData(), period: '2026-08'
  })));

  assert.ok(!body.cafe, 'café loads when its tab is opened');
  assert.ok(!body.tasks, 'tasks load when their tab is opened');
});

/**
 * Sixteen tenants, which is the order of the real list.
 *
 * The per-tenant work is where the cost hid: the rent table was fetched from
 * System_Config inside the loop, so the count grew with the tenant list even
 * though the answer never changed inside one request.
 */
function bootManyTenants() {
  const tenants = [];
  for (let i = 0; i < 16; i++) {
    tenants.push({ name: `Ijarachi_${i}`, defaultRent: 1000000 + i, currency: 'UZS', active: true });
  }
  const rows = [];
  for (let i = 0; i < 16; i++) {
    rows.push([
      `18000000000${String(i).padStart(2, '0')}_0`, `Ijarachi_${i}`, '2026-08', 'Income',
      500000, 'UZS', 'Naqd', '12/08/2026', 'ijara', '', `req_t${i}`, `grp_t${i}`, ''
    ]);
  }
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
        ['Omad_Tenants', JSON.stringify(tenants)]
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(rows)
    }
  });
}

test('the tenant list does not multiply the config reads', () => {
  const gas = bootManyTenants();

  const counts = countSheetReads(gas, () => {
    const body = readJsonOutput(gas.doPost(postEvent({
      action: 'mini_home', initData: signedInitData(), period: '2026-08'
    })));
    assert.strictEqual(body.status, 'success');
    assert.strictEqual(body.tenants.length, 16, 'all sixteen are answered');
  });

  // Measured on the code before this change: 70 full passes over
  // System_Config to answer one request, because the rate table was fetched
  // again for every tenant's rent and again for every tenant's payments.
  //
  // Six rather than four because this is the request that *builds* the read
  // model: reading the stored one, and then storing the rebuilt one, are two
  // more passes over a fifteen-row sheet — bought in exchange for the ledger
  // pass that every subsequent request no longer makes. See the read-model
  // tests below for the second request, which makes none of them.
  assert.ok(counts.System_Config <= 7,
    `System_Config read ${counts.System_Config} times; the rate table is fetched once per request`);
  assert.strictEqual(counts.Omad_Transactions, 1);
});

test('a saved rate is the rate the next request calculates with', () => {
  const gas = boot();
  // On the ledger, as production is, so `save_omad` takes the settings-only
  // path the settings screen actually uses.
  post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
  assert.strictEqual(post(gas, { action: 'cutover_omad_migration' }).status, 'success');

  // The memo is what makes the counts above possible, so the thing that would
  // make it dangerous is asserted directly: a stale rate would silently move
  // every USD figure on the screen.
  const before = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_home', initData: signedInitData(), period: '2026-08'
  })));
  assert.strictEqual(before.omad.rate.sell, 12500);

  const saved = post(gas, {
    action: 'save_omad',
    rates: { '2026-08': { buy: 13000, sell: 13400 } }
  });
  assert.strictEqual(saved.status, 'success', saved.message);

  const after = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_home', initData: signedInitData(), period: '2026-08'
  })));
  assert.strictEqual(after.omad.rate.sell, 13400, 'the new rate, not the memoised one');
});

test('a config value written mid-request is not read back from the memo', () => {
  const gas = boot();
  const configSheet = gas.__spreadsheet.getSheetByName('System_Config');

  // The dangerous case is inside one execution: a handler that changes a
  // setting and then calculates with it. `cutoverOmadMigration_` does exactly
  // this with the active-sheet key. Asserted on the mechanism itself, because
  // request boundaries would clear the memo anyway and prove nothing.
  assert.strictEqual(gas.getConfigOnce_(configSheet, 'Omad_Rates'),
    JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } }));

  gas.setConfig(configSheet, 'Omad_Rates', JSON.stringify({ '2026-08': { buy: 1, sell: 2 } }));

  assert.strictEqual(gas.getConfigOnce_(configSheet, 'Omad_Rates'),
    JSON.stringify({ '2026-08': { buy: 1, sell: 2 } }),
    'setConfig drops the entry it overwrites');
});

test('every tenant is still answered with the figure the single-tenant path gives', () => {
  const gas = bootManyTenants();
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_home', initData: signedInitData(), period: '2026-08'
  })));

  // The pre-aggregated pass is only worth having if it is the same arithmetic.
  const transactions = gas.readOmadTransactions_(gas.__spreadsheet);
  body.tenants.forEach(row => {
    assert.strictEqual(
      row.paid,
      gas.calculateTenantPaid_(transactions, row.name, '2026-08'),
      `${row.name} disagrees with the per-tenant calculation`
    );
  });
});

// ------------------------------------------------------------- café summary

const CAFE_SALES_HEADER = ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'];

/** Two hundred sales, each with a receipt of five lines, as the real sheet is. */
function bootManySales() {
  const receipt = JSON.stringify([1, 2, 3, 4, 5].map(n => ({
    kind: 'product', inventoryId: `i${n}`, name: `Mahsulot ${n}`,
    qty: n, unitPrice: 8000, unitCost: 6000, lineTotal: 8000 * n, lineProfit: 2000 * n
  })));
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push([
      `2026-08-${String((i % 12) + 1).padStart(2, '0')}T09:00:00.000Z`,
      'kassir', 40000, 10000, receipt, `sale_${i}`
    ]);
  }
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Kola', type: 'product', qty: 50, unit: 'dona', sellPrice: 8000, unitCost: 6000, totalCost: 300000 }
        ])],
        ['Cafe_Recipes', '[]'],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 500000 })]
      ],
      Cafe_Sales: [CAFE_SALES_HEADER].concat(rows)
    }
  });
}

/** Counts JSON parses while `run` executes, by wrapping the shared helper. */
function countJsonParses(gas, run) {
  let calls = 0;
  const original = gas.safeParseJSON_;
  gas.safeParseJSON_ = function () { calls++; return original.apply(null, arguments); };
  try { run(); } finally { gas.safeParseJSON_ = original; }
  return calls;
}

test('the café tab does not parse every receipt ever written', () => {
  const gas = bootManySales();

  let body;
  const parses = countJsonParses(gas, () => {
    body = readJsonOutput(gas.doPost(postEvent({
      action: 'mini_cafe', initData: signedInitData()
    })));
  });

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.cafe.recentSales.length, 10);
  assert.strictEqual(body.cafe.recentSales[0].items, 5, 'the shown rows still list their lines');

  // Ten shown receipts plus a handful of config values. It used to be one
  // parse per sale in the sheet, however old, to produce a line count for ten.
  assert.ok(parses < 30,
    `${parses} JSON parses for 200 sales; only the ten shown rows need one`);
});

test('the café summary still totals the whole history', () => {
  const gas = bootManySales();
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_cafe', initData: signedInitData()
  })));

  // 200 sales at 40 000, all inside 2026-08.
  assert.strictEqual(body.cafe.month.sales, 200);
  assert.strictEqual(body.cafe.month.revenue, 200 * 40000);
  assert.strictEqual(body.cafe.month.profit, 200 * 10000);
  assert.strictEqual(body.cafe.target.daily, 500000);
});

// -------------------------------------------------------------- report jobs

test('composing a transaction report reads the legacy sheet twice at most', () => {
  const gas = boot();

  const counts = countSheetReads(gas, () => {
    gas.runOmadTransactionReportJob_(gas.__spreadsheet, {
      payload: { groupId: 'grp_3', baseId: '1800000000003', messageId: '' }
    });
  });

  // One pass composes the report -- the group and the balances share it -- and
  // one writes the message id back, because the legacy reader does not carry
  // row numbers. It used to be one pass per line on top of the compose.
  assert.strictEqual(counts.Omad_Transactions, 2,
    'the group and the balances share a pass; the writeback needs its own');
});

test('composing a report on the ledger reads it once, writing back by row number', () => {
  const gas = boot();
  // Cut over to V2, whose reader carries each row's position.
  post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
  assert.strictEqual(post(gas, { action: 'cutover_omad_migration' }).status, 'success');

  const counts = countSheetReads(gas, () => {
    gas.runOmadTransactionReportJob_(gas.__spreadsheet, {
      payload: { groupId: 'grp_3', baseId: '1800000000003', messageId: '' }
    });
  });

  assert.strictEqual(counts.Omad_Transactions_V2, 1,
    'no second pass: the rows already know where they live');
});

// --------------------------------------------------------------------- café

test('a café sale avoids a full sales-sheet pass', () => {
  const gas = boot();
  // One sale already on the sheet, so the idempotency scan is a real pass
  // rather than an early return on an empty sheet.
  post(gas, {
    action: 'save_sale', date: '2026-08-12T09:00:00.000Z', seller: 'kassir',
    id: 'sale_0', requestId: 'req_0',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });

  const counts = countSheetReads(gas, () => {
    const answer = post(gas, {
      action: 'save_sale', date: '2026-08-12T10:00:00.000Z', seller: 'kassir',
      id: 'sale_1', requestId: 'req_1',
      items: [{ kind: 'product', inventoryId: 'i1', qty: 2 }]
    });
    assert.strictEqual(answer.status, 'success');
  });

  assert.ok(!counts.Cafe_Sales,
    'idempotency reads only the receipt-details column; pricing reads the catalogue from config');
});

test('a café void reads the sales sheet once', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', date: '2026-08-12T10:00:00.000Z', seller: 'kassir',
    id: 'sale_2', requestId: 'req_2',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });

  const counts = countSheetReads(gas, () => {
    assert.strictEqual(post(gas, { action: 'void_sale', id: 'sale_2' }).status, 'success');
  });

  assert.strictEqual(counts.Cafe_Sales, 1);
});

// ---------------------------------------------------------------- migration

test('verifying the migration reads the ledger once', () => {
  const gas = boot();
  post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });

  const counts = countSheetReads(gas, () => {
    const verified = post(gas, { action: 'verify_omad_migration' });
    assert.strictEqual(verified.verification.ok, true,
      JSON.stringify(verified.verification.failures || []));
  });

  assert.strictEqual(counts.Omad_Transactions_V2, 1,
    'the totals and the row-by-row check share one pass');
});

// ------------------------------------------------------------- scoped café

/**
 * How much of the sales sheet each café screen actually costs.
 *
 * Both screens used to be handed every sale ever made, with every receipt
 * parsed, and then derived four figures from it in the browser. The counts
 * below are what stops that coming back: they are asserted directly rather
 * than timed, so they stay stable on a slow machine.
 */
test('the till payload parses only the receipts it is going to show', () => {
  const gas = bootManySales();
  // One sale today for this cashier, among two hundred historical ones.
  const today = gas.Utilities.formatDate(new Date(), 'Asia/Tashkent', 'yyyy-MM-dd');
  post(gas, {
    action: 'save_sale', date: `${today}T09:00:00.000Z`, seller: 'kassir',
    id: 'sale_today', requestId: 'req_today',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });

  let body;
  const parses = countJsonParses(gas, () => {
    body = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: today, seller: 'kassir' });
  });

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.sales.length, 1, "only today's, and only this cashier's");
  // One receipt plus a handful of config values. Unscoped it is one parse per
  // sale in the sheet, however old, and all of them go down the wire.
  assert.ok(parses < 15, `${parses} JSON parses for 201 sales; only the shown row needs one`);
});

test('the café dashboard sends totals rather than the sales they came from', () => {
  const gas = bootManySales();
  const today = gas.Utilities.formatDate(new Date(), 'Asia/Tashkent', 'yyyy-MM-dd');

  const counts = countSheetReads(gas, () => {
    const body = post(gas, {
      action: 'get_cafe_data', scope: 'admin',
      todayKey: today, yesterdayKey: today, monthKey: today.slice(0, 7)
    });
    assert.strictEqual(body.status, 'success');
    assert.strictEqual(body.sales, undefined, 'no receipt reaches the browser');
    assert.ok(body.summary.all.count > 0, 'the totals are still over the whole history');
  });

  assert.strictEqual(counts.Cafe_Sales, 1, 'one pass answers all four periods');
});

test('the café dashboard says how many closings it is not showing', () => {
  const gas = bootManySales();
  const today = gas.Utilities.formatDate(new Date(), 'Asia/Tashkent', 'yyyy-MM-dd');
  const body = post(gas, {
    action: 'get_cafe_data', scope: 'admin',
    todayKey: today, yesterdayKey: today, monthKey: today.slice(0, 7)
  });

  // A page rather than everything, and a count rather than a silent cap.
  assert.ok(Array.isArray(body.closeReports));
  assert.strictEqual(typeof body.closeReportsTotal, 'number');
  assert.ok(body.closeReports.length <= body.closeReportsTotal || body.closeReportsTotal === 0);
});

// ----------------------------------------------------------------- round trips

test('the Omad screen learns the migration state without a second request', () => {
  const gas = boot();
  const body = post(gas, { action: 'get_omad_data' });

  // This used to be a second Apps Script round trip, fired the moment the first
  // returned, before the dashboard could decide whether the ledger was live.
  assert.strictEqual(body.status, 'success');
  assert.ok(body.migration, 'the migration status rides along with the data');
  assert.ok(body.migration.activeSheet, 'and it is the same shape the separate call returns');
  assert.deepStrictEqual(body.migration, post(gas, { action: 'get_migration_status' }).migration);
});
