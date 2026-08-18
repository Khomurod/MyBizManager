'use strict';

/**
 * The till proposes; the server decides.
 *
 * The POS used to compute the total, the cost and the profit and send them to
 * be written down verbatim, and it depleted stock only in its own memory --
 * so a refresh restored the stock it had just sold, two devices each tracked a
 * different inventory, and a tampered or simply stale screen could file any
 * figure it liked.
 *
 * These tests pin the reversal: the request names products and quantities, and
 * everything else comes from the catalogue and the recorded sales.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'cafe-authority-key';

/** Kola: sells at 22 500, costs 16 500, ten in stock. */
const INVENTORY = [
  { id: 'i1', name: 'Kola', type: 'product', qty: 10, unit: 'dona', sellPrice: 22500, unitCost: 16500, totalCost: 165000 },
  { id: 'i2', name: 'Sut', type: 'ingredient', qty: 5000, unit: 'ml', unitCost: 4, totalCost: 20000 },
  { id: 'i3', name: 'Kofe doni', type: 'ingredient', qty: 2000, unit: 'gr', unitCost: 90, totalCost: 180000 },
  { id: 'i4', name: 'Un', type: 'product', qty: 10, unit: 'kg', sellPrice: 3000, unitCost: 12000, totalCost: 120000, isBulk: true, gramsPerServing: 250 }
];

const RECIPES = [
  {
    id: 'r1', name: 'Kapuchino', sellPrice: 25000, baseCost: 1000,
    ingredients: [
      { inventoryId: 'i2', qty: 150, cost: 600 },
      { inventoryId: 'i3', qty: 18, cost: 1620 }
    ]
  }
];

function boot(overrides) {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [
        ['Cafe_Inventory', JSON.stringify((overrides && overrides.inventory) || INVENTORY)],
        ['Cafe_Recipes', JSON.stringify(RECIPES)],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 1000000 })]
      ],
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function sell(gas, items, extra) {
  return post(gas, Object.assign({
    action: 'save_sale', date: '2026-08-12T10:00:00.000Z', seller: 'kassir',
    id: 'sale_' + Math.random().toString(36).slice(2, 8),
    requestId: 'req_' + Math.random().toString(36).slice(2, 10),
    items: items
  }, extra || {}));
}

function stock(gas, id) {
  const cafe = post(gas, { action: 'get_cafe_data' });
  const item = cafe.inventory.find(i => i.id === id);
  return item ? item.qty : null;
}

// ------------------------------------------------------------ server pricing

test('the server prices the sale from the catalogue, not from the request', () => {
  const gas = boot();

  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }], {
    // A generous till. All three are ignored.
    total: 999999, profit: 999999, items_total: 1
  });

  assert.strictEqual(answer.status, 'success');
  assert.strictEqual(answer.sale.total, 45000, '2 x 22 500');
  assert.strictEqual(answer.sale.cost, 33000, '2 x 16 500');
  assert.strictEqual(answer.sale.profit, 12000);

  const stored = post(gas, { action: 'get_cafe_data' }).sales[0];
  assert.strictEqual(stored.total, 45000, 'and that is what was written down');
  assert.strictEqual(stored.profit, 12000);
});

test('a line price sent by the client is ignored', () => {
  const gas = boot();
  const answer = sell(gas, [
    { kind: 'product', inventoryId: 'i1', qty: 1, price: 1, baseCost: 0 }
  ]);
  assert.strictEqual(answer.sale.total, 22500);
  assert.strictEqual(answer.sale.profit, 22500 - 16500);
});

test('a recipe is costed from its ingredients', () => {
  const gas = boot();
  const answer = sell(gas, [{ kind: 'recipe', recipeId: 'r1', qty: 2 }]);

  assert.strictEqual(answer.sale.total, 50000, '2 x 25 000');
  assert.strictEqual(answer.sale.cost, 4440, '2 x (600 + 1620)');
  assert.strictEqual(answer.sale.profit, 45560);

  assert.strictEqual(stock(gas, 'i2'), 5000 - 300, 'milk came out of stock');
  assert.strictEqual(stock(gas, 'i3'), 2000 - 36, 'and coffee');
});

test('a bulk product consumes its serving size, not one unit', () => {
  const gas = boot();
  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i4', qty: 4 }]);

  assert.strictEqual(answer.sale.total, 12000, '4 x 3 000');
  // 250g per serving of a 12 000/kg product = 3 000 per serving.
  assert.strictEqual(answer.sale.cost, 12000);
  assert.strictEqual(stock(gas, 'i4'), 10 - 1, 'four 250g servings is one kilo');
});

test('an item that is not in the catalogue is refused', () => {
  const gas = boot();
  const answer = sell(gas, [{ kind: 'product', inventoryId: 'nope', qty: 1, price: 5000 }]);

  assert.strictEqual(answer.status, 'error');
  assert.match(answer.message, /topilmadi/);
  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 0);
});

test('a product with no price cannot be sold', () => {
  const gas = boot({
    inventory: [{ id: 'i9', name: 'Narxsiz', type: 'product', qty: 5, unitCost: 100 }]
  });
  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i9', qty: 1 }]);
  assert.strictEqual(answer.status, 'error');
  assert.match(answer.message, /narxi/);
});

// -------------------------------------------------------------------- stock

test('stock moves on the server when the sale is recorded', () => {
  const gas = boot();
  assert.strictEqual(stock(gas, 'i1'), 10);

  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 3 }]);

  assert.strictEqual(stock(gas, 'i1'), 7,
    'the sheet knows, so a refresh does not restore what was sold');
});

test('a sale beyond the stock on hand is refused and changes nothing', () => {
  const gas = boot();

  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 11 }]);
  assert.strictEqual(answer.status, 'error');
  assert.match(answer.message, /yetarli emas/);

  assert.strictEqual(stock(gas, 'i1'), 10, 'stock untouched');
  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 0, 'no sale filed');
});

test('a recipe beyond its ingredients is refused', () => {
  const gas = boot();
  // 5 000ml of milk at 150ml each is 33 cups; 34 is one too many.
  const answer = sell(gas, [{ kind: 'recipe', recipeId: 'r1', qty: 34 }]);
  assert.strictEqual(answer.status, 'error');
  assert.match(answer.message, /yetarli emas/);
  assert.strictEqual(stock(gas, 'i2'), 5000);
});

// -------------------------------------------------------------- idempotency

test('the same request id cannot ring up two sales', () => {
  const gas = boot();
  const body = {
    action: 'save_sale', date: '2026-08-12T10:00:00.000Z', seller: 'kassir',
    id: 'sale_dup', requestId: 'req_dup',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 2 }]
  };

  const first = post(gas, body);
  const second = post(gas, body);

  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.status, 'success');
  assert.strictEqual(second.duplicate, true, 'the retry resolves to the first sale');

  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 1);
  assert.strictEqual(stock(gas, 'i1'), 8, 'and the stock moved once');
});

test('a sale without a request id is refused', () => {
  const gas = boot();
  const answer = post(gas, {
    action: 'save_sale', date: '2026-08-12T10:00:00.000Z', seller: 'k',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });
  assert.strictEqual(answer.status, 'error');
  assert.match(answer.message, /requestId/);
});

// --------------------------------------------------------------------- void

test('a void restores stock from the stored receipt', () => {
  const gas = boot();
  const sale = sell(gas, [
    { kind: 'product', inventoryId: 'i1', qty: 3 },
    { kind: 'recipe', recipeId: 'r1', qty: 2 }
  ]);
  assert.strictEqual(stock(gas, 'i1'), 7);
  assert.strictEqual(stock(gas, 'i2'), 5000 - 300);

  const voided = post(gas, { action: 'void_sale', id: sale.sale.id });
  assert.strictEqual(voided.status, 'success');
  assert.strictEqual(voided.stockRestored, true);

  assert.strictEqual(stock(gas, 'i1'), 10, 'the product went back');
  assert.strictEqual(stock(gas, 'i2'), 5000, 'and the ingredients');
  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 0);
});

test('a void restores the sale-time recipe consumption after the recipe is edited', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'recipe', recipeId: 'r1', qty: 2 }]);

  assert.strictEqual(stock(gas, 'i2'), 4700, 'the sale used 300ml of milk');
  assert.strictEqual(stock(gas, 'i3'), 1964, 'the sale used 36g of coffee');

  // Change the live recipe after the receipt exists. Recomputing a void from
  // this new recipe would incorrectly restore 600ml of milk and only 20g of coffee.
  const catalogue = post(gas, { action: 'get_cafe_data', scope: 'admin' });
  const changed = post(gas, {
    action: 'save_recipe',
    expectedCatalogueRev: catalogue.catalogueRev,
    recipes: [{
      id: 'r1', name: 'Kapuchino', sellPrice: 25000, baseCost: 1000,
      ingredients: [
        { inventoryId: 'i2', qty: 300 },
        { inventoryId: 'i3', qty: 10 }
      ]
    }]
  });
  assert.strictEqual(changed.status, 'success', changed.message);

  const voided = post(gas, { action: 'void_sale', id: sale.sale.id });
  assert.strictEqual(voided.status, 'success');
  assert.strictEqual(voided.stockRestored, true);
  assert.strictEqual(stock(gas, 'i2'), 5000, 'only the 300ml actually sold came back');
  assert.strictEqual(stock(gas, 'i3'), 2000, 'the exact 36g actually sold came back');
});

test('a void ignores any inventory the caller supplies', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 1 }]);

  post(gas, {
    action: 'void_sale', id: sale.sale.id,
    // A stale screen trying to write the whole stock back.
    inventory: [{ id: 'i1', name: 'Kola', type: 'product', qty: 9999, sellPrice: 1, unitCost: 1 }]
  });

  assert.strictEqual(stock(gas, 'i1'), 10, 'restored from the receipt, not from the payload');
});

// ------------------------------- void when the frozen inventory is gone
//
// The receipt freezes exactly what the sale consumed, by inventory id. An item
// can be deleted from the inventory between the sale and the void, and then
// there is nothing to put its quantity back on to.
//
// `applyCafeStockMovement_` skipped a missing id with a bare `return` and told
// nobody, and `stockRestored` was computed as `!restored.error` -- which on the
// frozen-snapshot path is `true` unconditionally, because that branch builds
// `{consumption}` and has no `error` property at all. So every modern receipt
// reported its stock restored, and the POS said "tovarlar omborga qaytarildi",
// whether or not any of it had gone back. The receipt row was then deleted,
// taking the only record of what should have been restored with it.
//
// The money is still voided. That rule does not change: it is the shelf that
// cannot be put back, not the sale that cannot be undone.

/**
 * Deletes items from the inventory the way the admin screen does.
 *
 * The *live* inventory is filtered, never the fixture constant: `save_inventory`
 * writes what it is given wholesale, so passing the original quantities would
 * quietly undo the sale these tests just made and the void would then look like
 * it had over-restored.
 */
function deleteInventoryItems(gas, ids) {
  const admin = post(gas, { action: 'get_cafe_data', scope: 'admin' });
  return post(gas, {
    action: 'save_inventory',
    expectedRev: admin.inventoryRev,
    inventory: admin.inventory.filter(item => ids.indexOf(item.id) === -1)
  });
}

function auditRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Audit_Log');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .map(row => ({ event: String(row[1]), details: String(row[2]) }));
}

function debugRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .map(row => ({ event: String(row[1]), details: String(row[2]) }));
}

test('a void whose frozen item was deleted does not claim the stock came back', () => {
  const gas = boot();
  const sale = sell(gas, [
    { kind: 'product', inventoryId: 'i1', qty: 3 },
    { kind: 'recipe', recipeId: 'r1', qty: 2 }
  ]);
  assert.strictEqual(stock(gas, 'i1'), 7);
  assert.strictEqual(stock(gas, 'i2'), 4700);

  // The manager deletes the Kola line. The receipt still names i1.
  const saved = deleteInventoryItems(gas, ['i1']);
  assert.strictEqual(saved.status, 'success', saved.message);

  const voided = post(gas, { action: 'void_sale', id: sale.sale.id });
  assert.strictEqual(voided.status, 'success', 'the money is voided regardless');
  assert.strictEqual(voided.stockRestored, false, 'and it says so');

  // Named, not implied: the operator has to know what to go and count.
  assert.strictEqual(voided.unrestored.length, 1);
  assert.strictEqual(voided.unrestored[0].id, 'i1');
  assert.strictEqual(voided.unrestored[0].qty, 3, 'the frozen quantity, not a guess');

  // Everything that could go back, did.
  assert.strictEqual(stock(gas, 'i2'), 5000, 'the milk was still restored exactly');
  assert.strictEqual(stock(gas, 'i3'), 2000, 'and the coffee');
  assert.strictEqual(stock(gas, 'i1'), null, 'the deleted item was not resurrected');

  // The sale is gone, so the log is the only remaining record of the shortfall.
  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 0);
  const unrestoredAudit = auditRows(gas)
    .filter(row => row.event === 'cafe_sale_void_stock_unrestored');
  assert.strictEqual(unrestoredAudit.length, 1, 'an audit row records the shortfall');
  assert.match(unrestoredAudit[0].details, /i1/);
  assert.match(unrestoredAudit[0].details, /3/);
  assert.ok(auditRows(gas).some(row => row.event === 'cafe_sale_voided'),
    'alongside the ordinary void row');
  assert.ok(debugRows(gas).some(row => row.event === 'cafe_void_stock_unresolved'),
    'and the debug log says which ids');
});

test('a fully restorable void still reports success and writes no shortfall row', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }]);

  const voided = post(gas, { action: 'void_sale', id: sale.sale.id });
  assert.strictEqual(voided.stockRestored, true);
  assert.deepStrictEqual(voided.unrestored, []);
  assert.strictEqual(stock(gas, 'i1'), 10);
  assert.deepStrictEqual(
    auditRows(gas).filter(row => row.event === 'cafe_sale_void_stock_unrestored'), []);
});

test('a void that can restore nothing at all is still a void', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 4 }]);

  // Every id the receipt names is gone.
  deleteInventoryItems(gas, ['i1']);

  const voided = post(gas, { action: 'void_sale', id: sale.sale.id });
  assert.strictEqual(voided.status, 'success', 'the financial void proceeds');
  assert.strictEqual(voided.stockRestored, false);
  assert.deepStrictEqual(voided.unrestored.map(line => line.id), ['i1']);
  assert.strictEqual(post(gas, { action: 'get_cafe_data' }).sales.length, 0,
    'and the receipt is gone, as it must be for the money to be off the books');
});

test('voiding the same receipt twice does not inflate stock', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }]);

  post(gas, { action: 'void_sale', id: sale.sale.id });
  const second = post(gas, { action: 'void_sale', id: sale.sale.id });

  assert.strictEqual(second.status, 'success');
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(stock(gas, 'i1'), 10, 'still ten, not twelve');
});

// ---------------------------------------------------------------- close day

test('close day totals the sales the server recorded', () => {
  const gas = boot();
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }], { date: '2026-08-12T09:00:00.000Z' });
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 1 }], { date: '2026-08-12T11:00:00.000Z' });

  const closed = post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'kassir', summary: [],
    // A till reporting figures of its own. Ignored.
    totalRevenue: 5, totalProfit: 5
  });

  assert.strictEqual(closed.status, 'success');
  assert.strictEqual(closed.salesCount, 3 === 3 ? 2 : 2, 'two receipts');
  assert.strictEqual(closed.totalRevenue, 67500, '45 000 + 22 500');
  assert.strictEqual(closed.totalProfit, 18000, '12 000 + 6 000');

  const stored = post(gas, { action: 'get_cafe_data' }).closeReports[0];
  assert.strictEqual(stored.totalRevenue, 67500);
  assert.strictEqual(stored.totalProfit, 18000);
});

test('close day counts only the day it is closing', () => {
  const gas = boot();
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 1 }], { date: '2026-08-11T10:00:00.000Z' });
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }], { date: '2026-08-12T10:00:00.000Z' });

  const closed = post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'kassir', summary: []
  });
  assert.strictEqual(closed.totalRevenue, 45000, "yesterday's receipt is not in today's total");
});

test('close day accepts a counted stock level, because only a person can supply it', () => {
  const gas = boot();
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }]);
  assert.strictEqual(stock(gas, 'i1'), 8);

  // Somebody looked in the fridge and found one had been broken.
  post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'kassir', summary: [],
    countedInventory: [{ id: 'i1', name: 'Kola', type: 'product', qty: 7, unit: 'dona', sellPrice: 22500, unitCost: 16500, totalCost: 115500 }]
  });

  assert.strictEqual(stock(gas, 'i1'), 7, 'the count is respected');
});

// ------------------------------------------------------------- stale clients

test('a stale till cannot sell at yesterday\'s price', () => {
  const gas = boot();
  // The price is raised in the admin screen...
  post(gas, {
    action: 'save_inventory',
    inventory: INVENTORY.map(i => (i.id === 'i1' ? Object.assign({}, i, { sellPrice: 30000 }) : i))
  });

  // ...and a till that loaded before the change sells at the old one.
  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 1, price: 22500 }]);

  assert.strictEqual(answer.sale.total, 30000, 'the current price is charged');
});

test('the sale response carries the authoritative stock back to the till', () => {
  const gas = boot();
  const answer = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 4 }]);

  const returned = answer.inventory.find(i => i.id === 'i1');
  assert.strictEqual(returned.qty, 6,
    'so the screen shows what the sheet holds rather than its own guess');
});

// -------------------------------------------------- the admin screen and stock

test('an admin save quoting the current revision is accepted', () => {
  const gas = boot();
  const rev = post(gas, { action: 'get_cafe_data' }).inventoryRev;

  const saved = post(gas, {
    action: 'save_inventory', expectedRev: rev,
    inventory: INVENTORY.map(i => (i.id === 'i1' ? Object.assign({}, i, { qty: 20 }) : i))
  });

  assert.strictEqual(saved.status, 'success');
  assert.strictEqual(saved.inventoryRev, rev + 1, 'the revision moves on');
  assert.strictEqual(stock(gas, 'i1'), 20);
});

test('an admin screen that loaded before a sale cannot put the stock back', () => {
  const gas = boot();

  // The admin opens the screen and reads the stock...
  const openedAt = post(gas, { action: 'get_cafe_data' });
  assert.strictEqual(openedAt.inventory.find(i => i.id === 'i1').qty, 10);

  // ...the till sells three while that screen sits open...
  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 3 }]);
  assert.strictEqual(stock(gas, 'i1'), 7);

  // ...and the admin saves an unrelated edit, carrying its stale copy.
  const stale = post(gas, {
    action: 'save_inventory', expectedRev: openedAt.inventoryRev,
    inventory: openedAt.inventory.map(i => (i.id === 'i2' ? Object.assign({}, i, { name: 'Sut 2' }) : i))
  });

  assert.strictEqual(stale.status, 'error');
  assert.strictEqual(stale.stale, true);
  assert.match(stale.message, /yangilab/);
  assert.strictEqual(stock(gas, 'i1'), 7,
    'the three that were sold stayed sold');
});

test('a sale moves the revision on, so the next stale save is caught too', () => {
  const gas = boot();
  const first = post(gas, { action: 'get_cafe_data' }).inventoryRev;

  sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 1 }]);
  const afterSale = post(gas, { action: 'get_cafe_data' }).inventoryRev;

  assert.ok(afterSale > first, 'the till bumped it');
  assert.strictEqual(
    post(gas, { action: 'save_inventory', expectedRev: first, inventory: INVENTORY }).stale, true);
  assert.strictEqual(
    post(gas, { action: 'save_inventory', expectedRev: afterSale, inventory: INVENTORY }).status,
    'success', 'a screen that reloaded can save again');
});

test('a void and a close-day both move the revision on', () => {
  const gas = boot();
  const sale = sell(gas, [{ kind: 'product', inventoryId: 'i1', qty: 2 }]);
  const afterSale = post(gas, { action: 'get_cafe_data' }).inventoryRev;

  post(gas, { action: 'void_sale', id: sale.sale.id });
  const afterVoid = post(gas, { action: 'get_cafe_data' }).inventoryRev;
  assert.ok(afterVoid > afterSale, 'the void bumped it');

  post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [],
    // The only sale of the day was voided a moment ago, so this close has
    // nothing on it and is refused once. Answering the question is the point
    // here; the refusal itself is covered by tests/cafe-close-day.test.js.
    confirmEmpty: true,
    countedInventory: INVENTORY
  });
  assert.ok(post(gas, { action: 'get_cafe_data' }).inventoryRev > afterVoid,
    'the counted stock bumped it');
});
