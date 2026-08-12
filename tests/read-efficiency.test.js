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
  assert.ok(counts.System_Config <= 4,
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

test('a café sale reads the sales sheet once', () => {
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

  assert.strictEqual(counts.Cafe_Sales, 1,
    'the idempotency scan is the only pass; pricing reads the catalogue from config');
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
