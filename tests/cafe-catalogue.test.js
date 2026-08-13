'use strict';

/**
 * The café catalogue: recipe editing, its cost, its health, and stock that
 * leaves for reasons that are not sales.
 *
 * The claims being pinned:
 *
 *   1. **A recipe's cost is the ingredients' cost now.** It used to be whatever
 *      the browser computed on the day the recipe was written, which drifted
 *      from the stock the sale actually consumes.
 *   2. **An edit keeps the recipe's id.** Sales reference recipes by id; a new
 *      id on every save would orphan the history.
 *   3. **Retiring is not deleting.** An inactive recipe leaves the menu and is
 *      refused by the till; every sale that already named it still reads.
 *   4. **A movement says why.** Spoilage, waste, internal use and corrections
 *      all move stock under the lock and leave a row behind.
 *   5. **Close-day asks before it repeats itself, and before it files nothing.**
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'cafe-catalogue-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const CAFE_SALES_HEADER = ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'];

const INVENTORY = [
  { id: 'flour', name: 'Un', type: 'ingredient', qty: 10, unit: 'kg', totalCost: 100000, unitCost: 10000 },
  { id: 'cheese', name: 'Pishloq', type: 'ingredient', qty: 5, unit: 'kg', totalCost: 250000, unitCost: 50000 },
  { id: 'kola', name: 'Kola', type: 'product', category: 'Ichimliklar', qty: 40, unit: 'dona', totalCost: 240000, unitCost: 6000, sellPrice: 9000 }
];

function boot(extraConfig) {
  // Overrides *replace* the default row rather than following it: getConfig
  // answers with the first match, so an appended row would never be read.
  const config = [
    ['Cafe_Inventory', JSON.stringify(INVENTORY)],
    ['Cafe_Recipes', '[]'],
    ['Cafe_Categories', JSON.stringify(['Ichimliklar', 'Fast-Food'])],
    ['Cafe_Settings', JSON.stringify({ dailyTarget: 500000 })]
  ];
  (extraConfig || []).forEach(([key, value]) => {
    const at = config.findIndex(row => row[0] === key);
    if (at === -1) config.push([key, value]);
    else config[at] = [key, value];
  });

  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    sheets: {
      System_Config: config,
      Cafe_Sales: [CAFE_SALES_HEADER]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function catalogue(gas) {
  return post(gas, { action: 'get_cafe_data', scope: 'admin' });
}

/** A pizza: 0.3 kg flour + 0.2 kg cheese. */
function pizza(overrides) {
  return Object.assign({
    name: 'Pitsa', category: 'Fast-Food', sellPrice: 30000, active: true,
    ingredients: [
      { inventoryId: 'flour', qty: 0.3 },
      { inventoryId: 'cheese', qty: 0.2 }
    ]
  }, overrides || {});
}

// -------------------------------------------------------------- recipe cost

test('a recipe is costed from the inventory, not from what the browser sent', () => {
  const gas = boot();
  const saved = post(gas, {
    action: 'save_recipe',
    // A browser that insists the pizza costs nothing is simply not listened to.
    recipes: [pizza({ baseCost: 1, ingredients: [
      { inventoryId: 'flour', qty: 0.3, cost: 1, unitCost: 1 },
      { inventoryId: 'cheese', qty: 0.2, cost: 0, unitCost: 0 }
    ] })]
  });

  assert.strictEqual(saved.status, 'success');
  // 0.3 × 10 000 + 0.2 × 50 000
  assert.strictEqual(saved.recipes[0].baseCost, 13000);
  assert.strictEqual(saved.recipes[0].ingredients[0].cost, 3000);
  assert.strictEqual(saved.recipes[0].ingredients[1].cost, 10000);
});

test('a restock re-prices the recipe the next time it is saved', () => {
  const gas = boot();
  const first = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  assert.strictEqual(first.recipes[0].baseCost, 13000);

  // Flour doubles in price.
  post(gas, {
    action: 'adjust_cafe_stock', requestId: 'r1', inventoryId: 'flour',
    direction: 'in', reason: 'purchase', qty: 10, cost: 300000
  });

  const again = post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, first.recipes[0], { name: 'Pitsa' })],
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });
  // 20 kg costing 400 000 -> 20 000/kg, so 0.3 kg is 6 000.
  assert.strictEqual(again.recipes[0].ingredients[0].unitCost, 20000);
  assert.strictEqual(again.recipes[0].baseCost, 16000);
});

test('editing a recipe keeps its id', () => {
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const id = created.recipes[0].id;
  assert.ok(id, 'a new recipe gets an id');

  const edited = post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, created.recipes[0], { name: 'Katta pitsa', sellPrice: 40000 })],
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });
  assert.strictEqual(edited.recipes[0].id, id, 'the same recipe, not a new one');
  assert.strictEqual(edited.recipes[0].name, 'Katta pitsa');
  assert.strictEqual(edited.recipes[0].sellPrice, 40000);
});

test('every editable field survives a round trip', () => {
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const edited = post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, created.recipes[0], {
      name: 'Pitsa Margarita', category: 'Ichimliklar', sellPrice: 35000, active: false,
      ingredients: [{ inventoryId: 'cheese', qty: 0.4 }]
    })],
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });

  const stored = edited.recipes[0];
  assert.strictEqual(stored.name, 'Pitsa Margarita');
  assert.strictEqual(stored.category, 'Ichimliklar');
  assert.strictEqual(stored.sellPrice, 35000);
  assert.strictEqual(stored.active, false);
  assert.strictEqual(stored.ingredients.length, 1);
  assert.strictEqual(stored.ingredients[0].qty, 0.4);
  assert.strictEqual(stored.baseCost, 20000);
});

test('an unrelated save does not delete an incomplete recipe from the Sheet', () => {
  // Normalisation runs over the whole stored array on every save. A rule like
  // "a nameless recipe is not one" would therefore delete live rows as a side
  // effect of editing a different recipe. Nothing is dropped for being
  // incomplete; the health check says so instead.
  const gas = boot([
    ['Cafe_Recipes', JSON.stringify([
      { id: 'legacy_1', name: '', category: '', ingredients: [], sellPrice: 0 },
      { id: 'legacy_2', name: 'Eski', ingredients: [{ inventoryId: 'flour', qty: 0 }] }
    ])]
  ]);

  const saved = post(gas, { action: 'save_recipe', recipes: JSON.parse(JSON.stringify(
    post(gas, { action: 'get_cafe_data', scope: 'admin' }).recipes.concat([pizza()]))) });

  assert.strictEqual(saved.status, 'success');
  const ids = saved.recipes.map(r => r.id);
  assert.ok(ids.indexOf('legacy_1') !== -1, 'the nameless one is still stored');
  assert.ok(ids.indexOf('legacy_2') !== -1, 'so is the one with a zero quantity');

  const reasons = saved.health.incomplete.map(r => r.reason);
  assert.ok(reasons.some(r => r === "nomi yo'q"), reasons.join(' | '));
  assert.ok(reasons.some(r => r.indexOf('miqdorsiz ingredient') === 0), reasons.join(' | '));
});

test('an entry that is not a recipe at all is not kept', () => {
  const gas = boot();
  const saved = post(gas, { action: 'save_recipe', recipes: [null, {}, '', pizza()] });
  assert.strictEqual(saved.recipes.length, 1);
  assert.strictEqual(saved.recipes[0].name, 'Pitsa');
});

// ------------------------------------------------------------ active / POS

test('an inactive recipe leaves the menu but keeps its history', () => {
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const id = created.recipes[0].id;

  const sold = post(gas, {
    action: 'save_sale', requestId: 'sale1', id: 'sale1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'recipe', recipeId: id, qty: 1 }]
  });
  assert.strictEqual(sold.status, 'success', sold.message);

  post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, created.recipes[0], { active: false })],
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });

  const pos = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: '2026-08-12', seller: 'k' });
  assert.strictEqual(pos.recipes.length, 0, 'the till is not offered it');

  const refused = post(gas, {
    action: 'save_sale', requestId: 'sale2', id: 'sale2', seller: 'k',
    date: '2026-08-12T10:00:00.000Z',
    items: [{ kind: 'recipe', recipeId: id, qty: 1 }]
  });
  assert.strictEqual(refused.status, 'error');
  assert.match(refused.message, /sotuvdan olingan/i);

  // The sale that was made while it was on the menu is untouched.
  const salesSheet = gas.__spreadsheet.getSheetByName('Cafe_Sales');
  assert.strictEqual(salesSheet.getLastRow(), 2, 'the recorded sale is still there');
  const stored = post(gas, { action: 'get_cafe_data', scope: 'pos', dateKey: '2026-08-12', seller: 'k' });
  assert.strictEqual(stored.sales.length, 1);
  assert.strictEqual(stored.sales[0].items[0].name, 'Pitsa', 'and its receipt still reads');
});

test('voiding a sale of a retired recipe still puts its stock back', () => {
  // A void undoes a sale. Whether the recipe is still on the menu today has
  // nothing to do with whether the flour that went into it should come back.
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const id = created.recipes[0].id;

  post(gas, {
    action: 'save_sale', requestId: 'sale1', id: 'sale1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'recipe', recipeId: id, qty: 1 }]
  });
  const afterSale = catalogue(gas).inventory.find(i => i.id === 'flour').qty;
  assert.strictEqual(afterSale, 9.7);

  post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, created.recipes[0], { active: false })],
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });

  const voided = post(gas, { action: 'void_sale', id: 'sale1' });
  assert.strictEqual(voided.status, 'success');
  assert.strictEqual(voided.stockRestored, true);
  assert.strictEqual(catalogue(gas).inventory.find(i => i.id === 'flour').qty, 10);
});

test('a recipe dropped from the list does not take its sales with it', () => {
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  post(gas, {
    action: 'save_sale', requestId: 'sale1', id: 'sale1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'recipe', recipeId: created.recipes[0].id, qty: 2 }]
  });

  post(gas, { action: 'save_recipe', recipes: [], expectedCatalogueRev: catalogue(gas).catalogueRev });

  const summary = post(gas, {
    action: 'get_cafe_data', scope: 'admin',
    todayKey: '2026-08-12', yesterdayKey: '2026-08-11', monthKey: '2026-08'
  });
  assert.strictEqual(summary.recipes.length, 0);
  assert.strictEqual(summary.summary.all.count, 1, 'the sale still counts');
  assert.strictEqual(summary.summary.all.revenue, 60000);
});

// ------------------------------------------------------------------ health

test('health reports a recipe whose ingredient has been deleted', () => {
  const gas = boot();
  post(gas, { action: 'save_recipe', recipes: [pizza()] });
  post(gas, {
    action: 'save_inventory',
    inventory: INVENTORY.filter(i => i.id !== 'cheese'),
    expectedRev: post(gas, { action: 'get_cafe_data', scope: 'admin' }).inventoryRev
  });

  const health = catalogue(gas).health;
  assert.strictEqual(health.missingIngredients.length, 1);
  assert.strictEqual(health.missingIngredients[0].name, 'Pitsa');
  assert.deepStrictEqual(Array.from(health.missingIngredients[0].ingredients), ['Pishloq']);
});

test('health flags likely duplicates without touching them', () => {
  const gas = boot();
  post(gas, {
    action: 'save_recipe',
    recipes: [pizza(), pizza({ name: '  pitsa  ', sellPrice: 31000 })]
  });

  const body = catalogue(gas);
  assert.strictEqual(body.recipes.length, 2, 'both are still stored');
  assert.strictEqual(body.health.duplicates.length, 1);
  assert.strictEqual(body.health.duplicates[0].recipes.length, 2);
});

test('health flags a recipe with no ingredients or no category', () => {
  const gas = boot();
  post(gas, {
    action: 'save_recipe',
    recipes: [
      pizza({ name: 'Bo\'sh', ingredients: [] }),
      pizza({ name: 'Kategoriyasiz', category: '' })
    ]
  });

  const reasons = catalogue(gas).health.incomplete.map(r => `${r.name}:${r.reason}`);
  assert.ok(reasons.some(r => r.indexOf("Bo'sh:ingredientlar yo'q") === 0), reasons.join(' | '));
  assert.ok(reasons.some(r => r.indexOf('Kategoriyasiz:kategoriya') === 0), reasons.join(' | '));
});

test('health flags selling below cost, an extreme price and no price', () => {
  const gas = boot();
  post(gas, {
    action: 'save_recipe',
    recipes: [
      pizza({ name: 'Zararli', sellPrice: 5000 }),        // costs 13 000
      pizza({ name: 'Juda qimmat', sellPrice: 400000 }),  // > 20x
      pizza({ name: 'Narxsiz', sellPrice: 0 })
    ]
  });

  const health = catalogue(gas).health;
  assert.ok(health.belowCost.some(r => r.name === 'Zararli'));
  assert.ok(health.extremePrice.some(r => r.name === 'Juda qimmat'));
  assert.ok(health.noPrice.some(r => r.name === 'Narxsiz'));
  assert.ok(health.warnings >= 3, 'and the badge count adds them up');
});

test('a product sold below its own cost is flagged too', () => {
  const gas = boot();
  const rev = catalogue(gas).inventoryRev;
  post(gas, {
    action: 'save_inventory', expectedRev: rev,
    inventory: INVENTORY.map(i => i.id === 'kola' ? Object.assign({}, i, { sellPrice: 1000 }) : i)
  });
  assert.ok(catalogue(gas).health.belowCost.some(r => r.name === 'Kola' && r.product));
});

// ---------------------------------------------------------------- low stock

test('low stock uses the item threshold, then the setting, then the default', () => {
  const gas = boot();
  const rev = catalogue(gas).inventoryRev;
  post(gas, {
    action: 'save_inventory', expectedRev: rev,
    inventory: [
      { id: 'a', name: 'O\'z chegarasi', type: 'ingredient', qty: 4, unit: 'kg', lowStockThreshold: 5 },
      { id: 'b', name: 'Sozlama', type: 'ingredient', qty: 7, unit: 'kg' },
      { id: 'c', name: 'Yetarli', type: 'ingredient', qty: 40, unit: 'kg' },
      { id: 'd', name: 'Tugagan', type: 'product', qty: 0, unit: 'dona', sellPrice: 5000, unitCost: 1000 }
    ]
  });
  post(gas, {
    action: 'save_cafe_settings',
    settings: { dailyTarget: 500000, lowStockThreshold: 8 },
    expectedCatalogueRev: catalogue(gas).catalogueRev
  });

  const low = catalogue(gas).health.lowStock.map(r => r.name);
  assert.ok(low.indexOf("O'z chegarasi") !== -1, 'its own threshold wins');
  assert.ok(low.indexOf('Sozlama') !== -1, "the café's setting applies to the rest");
  assert.ok(low.indexOf('Yetarli') === -1);
  assert.strictEqual(low[0], 'Tugagan', 'the emptiest first');
});

test('a zero threshold means "do not warn me about this one"', () => {
  const gas = boot();
  const rev = catalogue(gas).inventoryRev;
  post(gas, {
    action: 'save_inventory', expectedRev: rev,
    inventory: [{ id: 'a', name: 'Jim', type: 'ingredient', qty: 0, unit: 'kg', lowStockThreshold: 0 }]
  });
  assert.deepStrictEqual(Array.from(catalogue(gas).health.lowStock), []);
});

// --------------------------------------------------------- stock movements

test('a spoilage takes stock and says why', () => {
  const gas = boot();
  const answer = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm1', inventoryId: 'cheese',
    direction: 'out', reason: 'spoilage', qty: 1, note: 'muzlatkich buzildi'
  });

  assert.strictEqual(answer.status, 'success', answer.message);
  const cheese = answer.inventory.find(i => i.id === 'cheese');
  assert.strictEqual(cheese.qty, 4);
  assert.strictEqual(cheese.totalCost, 200000);
  assert.strictEqual(cheese.unitCost, 50000, 'the remaining stock still cost what it cost');

  const movements = catalogue(gas).movements;
  assert.strictEqual(movements.length, 1);
  assert.strictEqual(movements[0].reason, 'spoilage');
  assert.strictEqual(movements[0].direction, 'out');
  assert.strictEqual(movements[0].qty, 1);
  assert.strictEqual(movements[0].note, 'muzlatkich buzildi');
  assert.strictEqual(movements[0].remaining, 4);
});

test('a movement without a reason or a note is refused', () => {
  const gas = boot();
  assert.match(post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm1', inventoryId: 'cheese',
    direction: 'out', qty: 1, note: 'x'
  }).message, /Sabab/);

  assert.match(post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm2', inventoryId: 'cheese',
    direction: 'out', reason: 'waste', qty: 1
  }).message, /sabab/i);

  assert.match(post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm3', inventoryId: 'cheese',
    direction: 'out', reason: 'waste', qty: 0, note: 'x'
  }).message, /Miqdor/);
});

test('a withdrawal larger than the shelf is refused', () => {
  const gas = boot();
  const refused = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm1', inventoryId: 'cheese',
    direction: 'out', reason: 'waste', qty: 99, note: 'hammasi'
  });
  assert.strictEqual(refused.status, 'error');
  assert.match(refused.message, /yetarli emas/);
  assert.strictEqual(catalogue(gas).inventory.find(i => i.id === 'cheese').qty, 5);
});

test('a correction may set a level below what the shelf claims', () => {
  const gas = boot();
  const fixed = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'm1', inventoryId: 'cheese',
    direction: 'out', reason: 'correction', qty: 99, note: 'sanoq xato edi'
  });
  assert.strictEqual(fixed.status, 'success', fixed.message);
  assert.strictEqual(fixed.inventory.find(i => i.id === 'cheese').qty, 0);
});

test('a repeated movement request moves the stock once', () => {
  const gas = boot();
  const first = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'same', inventoryId: 'flour',
    direction: 'out', reason: 'waste', qty: 2, note: 'to\'kildi'
  });
  const second = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'same', inventoryId: 'flour',
    direction: 'out', reason: 'waste', qty: 2, note: 'to\'kildi'
  });

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(catalogue(gas).inventory.find(i => i.id === 'flour').qty, 8);
  assert.strictEqual(catalogue(gas).movements.length, 1);
});

test('an intake adds stock and re-averages the unit cost', () => {
  const gas = boot();
  const answer = post(gas, {
    action: 'adjust_cafe_stock', requestId: 'in1', inventoryId: 'flour',
    direction: 'in', reason: 'purchase', qty: 10, cost: 300000
  });
  const flour = answer.inventory.find(i => i.id === 'flour');
  assert.strictEqual(flour.qty, 20);
  assert.strictEqual(flour.totalCost, 400000);
  assert.strictEqual(flour.unitCost, 20000);
});

test('only a café admin may move stock', () => {
  const gas = boot();
  const refused = readJsonOutput(gas.doPost(postEvent({
    action: 'adjust_cafe_stock', requestId: 'x', inventoryId: 'flour',
    direction: 'out', reason: 'waste', qty: 1, note: 'x'
  })));
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.authExpired, true);
});

// ------------------------------------------------------ catalogue revision

test('a stale catalogue save is refused, and the fresh one is not', () => {
  const gas = boot();
  const first = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const rev = first.catalogueRev;

  // Somebody else saves in between.
  post(gas, { action: 'save_categories', categories: ['Ichimliklar'], expectedCatalogueRev: rev });

  const stale = post(gas, {
    action: 'save_recipe', recipes: [pizza({ name: 'Eski oynadan' })],
    expectedCatalogueRev: rev
  });
  assert.strictEqual(stale.status, 'error');
  assert.strictEqual(stale.stale, true);
  assert.ok(stale.catalogueRev > rev);

  const fresh = post(gas, {
    action: 'save_recipe', recipes: [pizza({ name: 'Yangi oynadan' })],
    expectedCatalogueRev: stale.catalogueRev
  });
  assert.strictEqual(fresh.status, 'success');
});

test('a sale does not make the catalogue stale', () => {
  const gas = boot();
  const created = post(gas, { action: 'save_recipe', recipes: [pizza()] });
  const rev = created.catalogueRev;

  post(gas, {
    action: 'save_sale', requestId: 's1', id: 's1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'product', inventoryId: 'kola', qty: 1 }]
  });

  // The whole point of a separate counter: a busy till must not stop the
  // manager saving a recipe.
  const saved = post(gas, {
    action: 'save_recipe',
    recipes: [Object.assign({}, created.recipes[0], { sellPrice: 32000 })],
    expectedCatalogueRev: rev
  });
  assert.strictEqual(saved.status, 'success', saved.message);
});

test('the revision check, the write and the bump are one locked step', () => {
  // Reading the counter, writing the array and bumping the counter as three
  // separate steps would let two saves that quoted the *same* revision both
  // pass the check, after which the second whole-array write silently replaces
  // the first -- the exact accident the counter exists to stop, arriving
  // exactly when two people save at once. Asserted on the lock rather than by
  // racing, because the harness runs one execution at a time.
  const gas = boot();
  let held = 0;
  let maxHeld = 0;
  const realLock = gas.LockService.getScriptLock;
  gas.LockService.getScriptLock = function () {
    const lock = realLock();
    return {
      waitLock: function (ms) { held++; maxHeld = Math.max(maxHeld, held); return lock.waitLock(ms); },
      releaseLock: function () { held--; return lock.releaseLock(); }
    };
  };

  let revDuringWrite = null;
  const realBump = gas.bumpCafeCatalogueRev_;
  gas.bumpCafeCatalogueRev_ = function (sheet) {
    revDuringWrite = held;                       // the lock is still held here
    return realBump(sheet);
  };

  try {
    assert.strictEqual(post(gas, { action: 'save_recipe', recipes: [pizza()] }).status, 'success');
  } finally {
    gas.LockService.getScriptLock = realLock;
    gas.bumpCafeCatalogueRev_ = realBump;
  }

  assert.strictEqual(maxHeld, 1, 'the save took the script lock');
  assert.strictEqual(revDuringWrite, 1, 'and still held it when it bumped the revision');
  assert.strictEqual(held, 0, 'and gave it back');
});

test('a client that quotes no revision is still allowed to save', () => {
  // Older pages, and the editor, cannot quote a counter they do not know about.
  const gas = boot();
  post(gas, { action: 'save_recipe', recipes: [pizza()] });
  assert.strictEqual(post(gas, { action: 'save_categories', categories: ['X'] }).status, 'success');
});

// ------------------------------------------------------------- close-day

test('a second close for the same day is refused once, then confirmed', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', requestId: 's1', id: 's1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'product', inventoryId: 'kola', qty: 1 }]
  });

  const first = post(gas, { action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [] });
  assert.strictEqual(first.status, 'success');

  const second = post(gas, { action: 'close_day', date: '2026-08-12T21:00:00.000Z', seller: 'k', summary: [] });
  assert.strictEqual(second.status, 'error');
  assert.strictEqual(second.code, 'duplicate_close');
  assert.strictEqual(second.existing.totalRevenue, 9000);

  const confirmed = post(gas, {
    action: 'close_day', date: '2026-08-12T21:00:00.000Z', seller: 'k', summary: [],
    confirmDuplicate: true
  });
  assert.strictEqual(confirmed.status, 'success', 'a deliberate correction is never blocked');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Cafe_Kun_Yakuni').getLastRow(), 3);
});

test('a close with no sales at all is refused once, then confirmed', () => {
  const gas = boot();
  const refused = post(gas, { action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [] });
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.code, 'empty_close');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Cafe_Kun_Yakuni'), null,
    'and nothing was written');

  const confirmed = post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [],
    confirmEmpty: true
  });
  assert.strictEqual(confirmed.status, 'success');
});

test('a normal close of a day with sales asks nothing', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', requestId: 's1', id: 's1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'product', inventoryId: 'kola', qty: 3 }]
  });
  const closed = post(gas, { action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [] });
  assert.strictEqual(closed.status, 'success');
  assert.strictEqual(closed.totalRevenue, 27000);
  assert.strictEqual(closed.salesCount, 1);
});

test('a counted stock level leaves a movement behind', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', requestId: 's1', id: 's1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'product', inventoryId: 'kola', qty: 1 }]
  });

  const counted = catalogue(gas).inventory.map(item =>
    item.id === 'kola' ? Object.assign({}, item, { qty: 30 }) : item);

  const closed = post(gas, {
    action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [],
    countedInventory: counted
  });
  assert.strictEqual(closed.status, 'success');

  const recount = catalogue(gas).movements.filter(m => m.reason === 'recount');
  assert.strictEqual(recount.length, 1, 'the count is recorded as what moved it');
  assert.strictEqual(recount[0].direction, 'out');
  assert.strictEqual(recount[0].remaining, 30);
});

test('the admin screen says whether today has already been closed', () => {
  const gas = boot();
  post(gas, {
    action: 'save_sale', requestId: 's1', id: 's1', seller: 'k',
    date: '2026-08-12T09:00:00.000Z',
    items: [{ kind: 'product', inventoryId: 'kola', qty: 1 }]
  });
  post(gas, { action: 'close_day', date: '2026-08-12T20:00:00.000Z', seller: 'k', summary: [] });

  const body = post(gas, {
    action: 'get_cafe_data', scope: 'admin',
    todayKey: '2026-08-12', yesterdayKey: '2026-08-11', monthKey: '2026-08'
  });
  assert.ok(body.closedToday, 'the screen can say so before the button is pressed');
  assert.strictEqual(body.closedToday.totalRevenue, 9000);
});
