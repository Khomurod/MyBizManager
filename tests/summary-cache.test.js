'use strict';

/**
 * The summary cache and the scoped café reads.
 *
 * Two claims are being tested, and they are the two that make an acceleration
 * layer safe to have at all:
 *
 *   1. **A cached answer is the same answer.** Every scoped or summarised read
 *      has to agree, field for field, with the unscoped one it replaces —
 *      otherwise "faster" means "different", and different is wrong.
 *   2. **A write makes the stale copy unreachable, and losing the cache costs
 *      nothing.** Both directions matter: a summary that survives a write is a
 *      wrong figure on a screen, and a summary that cannot be recomputed is an
 *      outage.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'summary-cache-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const CAFE_SALES_HEADER = ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'];
const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

/** Today and yesterday as the script's timezone sees them. */
function dayKey(offsetDays) {
  const when = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

function receipt(lines) {
  return JSON.stringify({ requestId: 'seed', items: lines });
}

function boot() {
  const today = dayKey(0);
  const yesterday = dayKey(-1);
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
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }])],
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Kola', type: 'product', category: 'Ichimliklar', qty: 50, unit: 'dona', sellPrice: 8000, unitCost: 6000, totalCost: 300000 }
        ])],
        ['Cafe_Recipes', '[]'],
        ['Cafe_Categories', JSON.stringify(['Ichimliklar'])],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 500000 })]
      ],
      Omad_Transactions: [
        LEGACY_HEADER,
        ['1800000000000_0', 'Apteka', '2026-08', 'Income', 1000000, 'UZS', 'Naqd', '12/08/2026', 'ijara', '', 'r0', 'grp_a', '']
      ],
      Cafe_Sales: [
        CAFE_SALES_HEADER,
        [`${today}T09:00:00.000Z`, 'kassir', 40000, 10000, receipt([{ name: 'Kola', qty: 5 }]), 'sale_today_1'],
        [`${today}T10:00:00.000Z`, 'kassir', 16000, 4000, receipt([{ name: 'Kola', qty: 2 }]), 'sale_today_2'],
        [`${today}T11:00:00.000Z`, 'boshqa', 8000, 2000, receipt([{ name: 'Kola', qty: 1 }]), 'sale_today_other'],
        [`${yesterday}T09:00:00.000Z`, 'kassir', 24000, 6000, receipt([{ name: 'Kola', qty: 3 }]), 'sale_yesterday']
      ],
      Cafe_Kun_Yakuni: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Tafsilotlar_JSON']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
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

function miniPost(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ initData: signedInitData() }, body))));
}

/** Counts full-sheet passes by name while `run` executes. */
function countSheetReads(gas, run) {
  const counts = {};
  const restore = [];
  gas.__spreadsheet.getSheets().forEach(sheet => {
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

// ------------------------------------------------------------- scoped reads

test('the POS is sent the catalogue and only this cashier\'s receipts for today', () => {
  const gas = boot();
  const pos = post(gas, {
    action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir'
  });

  assert.strictEqual(pos.status, 'success');
  assert.strictEqual(pos.inventory.length, 1, 'the catalogue is complete');
  assert.ok(Array.isArray(pos.categories) && pos.categories.length);
  assert.strictEqual(pos.settings.dailyTarget, 500000);

  const ids = pos.sales.map(s => s.id).sort();
  assert.deepStrictEqual(ids, ['sale_today_1', 'sale_today_2'],
    'yesterday and the other cashier are not this till\'s business');
  assert.strictEqual(pos.sales[0].items[0].qty, 5, 'the receipts it does get are parsed');
});

test('the POS payload agrees with what the full read would have produced', () => {
  const gas = boot();
  const full = post(gas, { action: 'get_cafe_data' });
  const pos = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });

  assert.deepStrictEqual(pos.inventory, full.inventory);
  assert.deepStrictEqual(pos.recipes, full.recipes);
  assert.deepStrictEqual(pos.categories, full.categories);
  assert.deepStrictEqual(pos.settings, full.settings);
  assert.strictEqual(pos.inventoryRev, full.inventoryRev);

  // The scoped list is exactly the subset the browser used to filter to.
  const expected = full.sales
    .filter(s => s.seller === 'kassir' && String(s.date).startsWith(dayKey(0)))
    .map(s => s.id).sort();
  assert.deepStrictEqual(pos.sales.map(s => s.id).sort(), expected);
});

test('the café dashboard totals match totalling the sales by hand', () => {
  const gas = boot();
  const full = post(gas, { action: 'get_cafe_data' });
  const admin = post(gas, {
    action: 'get_cafe_data', scope: 'admin',
    todayKey: dayKey(0), yesterdayKey: dayKey(-1), monthKey: dayKey(0).slice(0, 7)
  });

  const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const today = full.sales.filter(s => String(s.date).startsWith(dayKey(0)));
  const yesterday = full.sales.filter(s => String(s.date).startsWith(dayKey(-1)));

  assert.strictEqual(admin.summary.today.revenue, sum(today, 'total'));
  assert.strictEqual(admin.summary.today.profit, sum(today, 'profit'));
  assert.strictEqual(admin.summary.today.count, today.length);
  assert.strictEqual(admin.summary.yesterday.revenue, sum(yesterday, 'total'));
  assert.strictEqual(admin.summary.all.revenue, sum(full.sales, 'total'));
  assert.strictEqual(admin.summary.all.count, full.sales.length);
  assert.strictEqual(admin.summary.today.top, 'Kola', 'the best-seller is still named');
});

test('the café dashboard is not sent the sales history it used to total itself', () => {
  const gas = boot();
  const admin = post(gas, {
    action: 'get_cafe_data', scope: 'admin',
    todayKey: dayKey(0), yesterdayKey: dayKey(-1), monthKey: dayKey(0).slice(0, 7)
  });
  assert.strictEqual(admin.sales, undefined, 'no receipt reaches the browser');
  assert.ok(Array.isArray(admin.closeReports), 'the recent closings still do');
});

test('an unscoped read is unchanged, so nothing that already works has to know', () => {
  const gas = boot();
  const full = post(gas, { action: 'get_cafe_data' });
  assert.strictEqual(full.status, 'success');
  assert.strictEqual(full.sales.length, 4);
  assert.ok(full.closeReports);
});

test('a genuinely empty café answers success with empty lists', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: { System_Config: [['Cafe_Inventory', '[]'], ['Cafe_Recipes', '[]'], ['Cafe_Categories', '[]']] }
  });
  const pos = readJsonOutput(gas.doPost(postEvent({
    action: 'get_cafe_data', scope: 'pos', adminKey: ADMIN_KEY, dateKey: dayKey(0), seller: 'kassir'
  })));

  // An empty shop is a success, not a failure - the screen has to be able to
  // tell "nothing to sell yet" from "we could not load the menu".
  assert.strictEqual(pos.status, 'success');
  assert.deepStrictEqual(pos.inventory, []);
  assert.deepStrictEqual(pos.sales, []);
});

// ------------------------------------------------------------------- caching

test('the Mini App home screen is answered from cache on a repeat request', () => {
  const gas = boot();
  const first = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  assert.strictEqual(first.status, 'success');

  const counts = countSheetReads(gas, () => {
    const again = miniPost(gas, { action: 'mini_home', period: '2026-08' });
    assert.strictEqual(again.status, 'success');
    assert.deepStrictEqual(again.omad, first.omad, 'and it is the same answer');
    assert.deepStrictEqual(again.tenants, first.tenants);
  });

  assert.ok(!counts.Omad_Transactions,
    'the ledger is not rescanned to produce a summary nothing has changed');
});

test('a transaction makes the cached Omad summary unreachable', () => {
  const gas = boot();
  const before = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  const beforeIncome = before.omad.income;

  const written = miniPost(gas, {
    action: 'mini_save_transaction', requestId: 'req_cache_1', period: '2026-08',
    tenant: 'Apteka', type: 'Income', amount: 250000, currency: 'UZS', method: 'Naqd', comment: 'test'
  });
  assert.strictEqual(written.status, 'success', written.message);

  const after = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  assert.strictEqual(after.omad.income, beforeIncome + 250000,
    'the figure moved on the very next request, not in a minute');
});

test('a café sale makes the cached café summary and till payload unreachable', () => {
  const gas = boot();
  const before = miniPost(gas, { action: 'mini_cafe' });
  const beforeToday = before.cafe.today.revenue;
  const posBefore = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });

  const sold = post(gas, {
    action: 'save_sale', requestId: 'req_cache_sale', id: 'sale_cache_1',
    date: `${dayKey(0)}T12:00:00.000Z`, seller: 'kassir',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 2 }]
  });
  assert.strictEqual(sold.status, 'success', sold.message);

  const after = miniPost(gas, { action: 'mini_cafe' });
  assert.strictEqual(after.cafe.today.revenue, beforeToday + 16000);

  const posAfter = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });
  assert.strictEqual(posAfter.sales.length, posBefore.sales.length + 1, 'the till sees its own sale');
  assert.strictEqual(posAfter.inventory[0].qty, posBefore.inventory[0].qty - 2, 'and the stock that moved');
});

test('a voided sale makes them unreachable too', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', requestId: 'req_void_c', id: 'sale_void_c',
    date: `${dayKey(0)}T12:00:00.000Z`, seller: 'kassir',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });
  const before = miniPost(gas, { action: 'mini_cafe' }).cafe.today.revenue;

  assert.strictEqual(post(gas, { action: 'void_sale', id: 'sale_void_c' }).status, 'success');

  assert.strictEqual(miniPost(gas, { action: 'mini_cafe' }).cafe.today.revenue, before - 8000);
});

test('editing the catalogue makes the till payload unreachable', () => {
  const gas = boot();
  const before = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });

  assert.strictEqual(post(gas, {
    action: 'save_inventory', expectedRev: before.inventoryRev,
    inventory: [Object.assign({}, before.inventory[0], { sellPrice: 9000 })]
  }).status, 'success');

  const after = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });
  assert.strictEqual(after.inventory[0].sellPrice, 9000, 'a stale price is never shown at the till');
});

test('a task write makes the cached board unreachable', () => {
  const gas = boot();
  const before = post(gas, { action: 'get_tasks' });
  assert.strictEqual(before.status, 'success');
  const beforeCount = before.view.tasks.length;

  assert.strictEqual(post(gas, { action: 'save_task', type: 'once', title: 'Yangi vazifa' }).status, 'success');

  const after = post(gas, { action: 'get_tasks' });
  assert.strictEqual(after.view.tasks.length, beforeCount + 1);
});

test('losing every cache entry costs a sheet read and nothing else', () => {
  const gas = boot();
  const withCache = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  const cafeWithCache = miniPost(gas, { action: 'mini_cafe' });

  // Everything the cache held, gone, as an eviction or an incident would leave
  // it. The answers have to be identical, because the cache never held
  // anything the sheets could not produce again.
  Object.keys(gas.__cache).forEach(key => { delete gas.__cache[key]; });

  const rebuilt = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  assert.strictEqual(rebuilt.status, 'success');
  assert.deepStrictEqual(rebuilt.omad, withCache.omad);
  assert.deepStrictEqual(rebuilt.tenants, withCache.tenants);
  assert.deepStrictEqual(rebuilt.transactions, withCache.transactions);
  assert.deepStrictEqual(miniPost(gas, { action: 'mini_cafe' }).cafe, cafeWithCache.cafe);
});

test('a cache that refuses to answer at all is not an outage', () => {
  const gas = boot();
  const expected = miniPost(gas, { action: 'mini_home', period: '2026-08' });

  gas.CacheService.getScriptCache = () => { throw new Error('cache unavailable'); };

  const answered = miniPost(gas, { action: 'mini_home', period: '2026-08' });
  assert.strictEqual(answered.status, 'success');
  assert.deepStrictEqual(answered.omad, expected.omad);
});

test('nothing authoritative is answered from the cache', () => {
  const gas = boot();
  // Warm every summary there is.
  miniPost(gas, { action: 'mini_home', period: '2026-08' });
  miniPost(gas, { action: 'mini_cafe' });
  post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: dayKey(0), seller: 'kassir' });

  // Then poison the lot. A price, a stock check or a balance answered from
  // here would now be wrong; none of them is.
  Object.keys(gas.__cache).forEach(key => { gas.__cache[key] = JSON.stringify({ poisoned: true }); });

  const sold = post(gas, {
    action: 'save_sale', requestId: 'req_poison', id: 'sale_poison',
    date: `${dayKey(0)}T13:00:00.000Z`, seller: 'kassir',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 3 }]
  });
  assert.strictEqual(sold.status, 'success', sold.message);
  assert.strictEqual(sold.sale.total, 24000, 'priced from the catalogue, not from a cached copy');
  assert.strictEqual(sold.inventory[0].qty, 47, 'and the stock came off the stored figure');

  const ledger = post(gas, { action: 'get_omad_data' });
  assert.strictEqual(ledger.transactions.length, 1, 'the ledger read is never cached');
});
