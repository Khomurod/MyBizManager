'use strict';

/**
 * Café Admin's new catalogue work, in a real browser.
 *
 * What is being held here is the part a unit test cannot see: that the screen
 * sends the *identity* of a recipe rather than a fresh one, that it sends which
 * ingredient and how much rather than what it thinks that is worth, and that a
 * warning is shown as a warning instead of acted on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  chromium = null;
}

const describe = chromium ? test.describe : test.describe.skip;

function startStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const FLOUR = {
  id: 'flour', type: 'ingredient', name: 'Un',
  qty: 10, unit: 'kg', unitCost: 10000, totalCost: 100000
};
const CHEESE = {
  id: 'cheese', type: 'ingredient', name: 'Pishloq',
  qty: 1, unit: 'kg', unitCost: 50000, totalCost: 50000
};

const PIZZA = {
  id: 'rec_1', name: 'Pitsa', category: 'Fast-Food', sellPrice: 30000, active: true,
  baseCost: 13000,
  ingredients: [
    { inventoryId: 'flour', name: 'Un', qty: 0.3, unitCost: 10000, cost: 3000 },
    { inventoryId: 'cheese', name: 'Pishloq', qty: 0.2, unitCost: 50000, cost: 10000 }
  ]
};

const CHEAP = {
  id: 'rec_2', name: 'Zararli', category: 'Fast-Food', sellPrice: 1000, active: false,
  baseCost: 13000, ingredients: [{ inventoryId: 'flour', name: 'Un', qty: 1.3, unitCost: 10000, cost: 13000 }]
};

function adminPayload() {
  return {
    status: 'success', scope: 'admin',
    inventory: [FLOUR, CHEESE], inventoryRev: 4,
    recipes: [PIZZA, CHEAP], catalogueRev: 7,
    categories: ['Ichimliklar', 'Fast-Food'],
    settings: { dailyTarget: 100000 },
    summary: {
      today: { revenue: 0, profit: 0, count: 0, top: '' },
      yesterday: { revenue: 0, profit: 0, count: 0, top: '' },
      month: { revenue: 0, profit: 0, count: 0, top: '' },
      all: { revenue: 0, profit: 0, count: 0, top: '' }
    },
    closeReports: [], closeReportsTotal: 0,
    health: {
      missingIngredients: [{ id: 'rec_9', name: 'Eski', ingredients: ['Shakar'] }],
      duplicates: [{ name: 'Pitsa', recipes: [{ id: 'rec_1' }, { id: 'rec_8' }] }],
      incomplete: [],
      belowCost: [{ id: 'rec_2', name: 'Zararli', sellPrice: 1000, cost: 13000 }],
      extremePrice: [], noPrice: [],
      lowStock: [{ id: 'cheese', name: 'Pishloq', qty: 1, unit: 'kg', threshold: 3, out: false }],
      warnings: 3
    },
    movements: [{
      date: '2026-08-13T09:00:00.000Z', direction: 'out', reason: 'spoilage',
      reasonLabel: 'Buzilgan', inventoryId: 'cheese', name: 'Pishloq',
      qty: 2, unit: 'kg', cost: 100000, remaining: 1, note: 'muzlatkich buzildi', by: 'cafe_admin'
    }],
    movementsTotal: 1,
    closedToday: null
  };
}

describe('Café Admin catalogue (browser)', () => {
  let server; let browser; let baseUrl;

  test.before(async () => {
    server = await startStaticServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function openAdmin(overrides = {}) {
    const sent = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'cafe_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_user', 'cafe_admin');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    });

    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      sent.push(payload);
      const override = overrides[payload.action];
      const body = override
        ? (typeof override === 'function' ? override(payload, sent) : override)
        : (payload.action === 'get_cafe_data' ? adminPayload() : { status: 'success' });
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(body)
      });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await page.goto(`${baseUrl}/cafe_admin.html`);
    await page.waitForFunction(() => state.loaded === true);
    return { page, context, sent, errors, dialogs };
  }

  /**
   * Waits for the page to have sent `action` at least `count` times.
   *
   * The screen's saves are fired without being awaited -- a click returns
   * before the request leaves -- so the assertions wait on the request list
   * rather than on a repaint that may never come.
   */
  async function waitForCall(sent, action, count = 1) {
    const deadline = Date.now() + 15000;
    while (sent.filter(p => p.action === action).length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(sent.filter(p => p.action === action).length >= count,
      `${action} was never sent`);
  }

  test('editing a recipe prefills it and keeps its id', async () => {
    const { page, context, sent } = await openAdmin();

    await page.evaluate(() => editRecipe('rec_1'));
    assert.strictEqual(await page.inputValue('#recipeName'), 'Pitsa');
    assert.strictEqual(await page.inputValue('#recipeSellPrice'), '30000');
    assert.strictEqual(await page.inputValue('#recipeCategory'), 'Fast-Food');
    assert.strictEqual(await page.isChecked('#recipeActive'), true);
    assert.strictEqual(await page.textContent('#recipeCost'), (13000).toLocaleString(),
      'the cost is the ingredients at today\'s prices');

    await page.fill('#recipeSellPrice', '35000');
    await page.click('#recipeSaveBtn');
    await waitForCall(sent, 'save_recipe');

    const save = sent.filter(p => p.action === 'save_recipe').pop();
    assert.ok(save, 'the save happened');
    const edited = save.recipes.find(r => r.id === 'rec_1');
    assert.ok(edited, 'the same recipe id, not a new one');
    assert.strictEqual(edited.sellPrice, 35000);
    assert.strictEqual(save.recipes.length, 2, 'and the other recipe is still in the list');
    assert.strictEqual(save.expectedCatalogueRev, 7, 'quoting the catalogue it read');

    await context.close();
  });

  test('the ingredient lines carry quantities, not costs', async () => {
    const { page, context, sent } = await openAdmin();
    await page.evaluate(() => editRecipe('rec_1'));
    await page.click('#recipeSaveBtn');
    await waitForCall(sent, 'save_recipe');

    const save = sent.filter(p => p.action === 'save_recipe').pop();
    const line = save.recipes.find(r => r.id === 'rec_1').ingredients[0];
    assert.strictEqual(line.inventoryId, 'flour');
    assert.strictEqual(line.qty, 0.3);
    assert.strictEqual(line.cost, undefined, 'what it is worth is the server\'s answer');
    assert.strictEqual(line.unitCost, undefined);

    await context.close();
  });

  test('retiring a recipe is a flag, not a removal', async () => {
    const { page, context, sent } = await openAdmin();
    await page.evaluate(() => retireRecipe('rec_1'));
    await waitForCall(sent, 'save_recipe');

    const save = sent.filter(p => p.action === 'save_recipe').pop();
    assert.strictEqual(save.recipes.length, 2, 'nothing was dropped from the list');
    assert.strictEqual(save.recipes.find(r => r.id === 'rec_1').active, false);

    await context.close();
  });

  test('the warning layer is shown, and nothing is acted on', async () => {
    const { page, context, sent } = await openAdmin();
    const health = await page.textContent('#recipeHealth');

    assert.match(health, /Ingredienti o'chirilgan/);
    assert.match(health, /Shakar/);
    assert.match(health, /Bir xil nomli/);
    assert.match(health, /avtomatik o'chirilmaydi/);
    assert.match(health, /Tannarxdan arzon/);

    assert.ok(!sent.some(p => p.action === 'save_recipe'),
      'showing a warning changes nothing');

    await context.close();
  });

  test('the low-stock card and the movement history are shown', async () => {
    const { page, context } = await openAdmin();
    // Both live on the Ombor screen, which is only displayed when it is open.
    await page.evaluate(() => switchTab('inventory', document.querySelector('[onclick*="inventory"]')));
    assert.strictEqual(await page.isHidden('#lowStockCard'), false);
    assert.match(await page.textContent('#lowStockList'), /Pishloq/);

    const movements = await page.textContent('#movementList');
    assert.match(movements, /Pishloq/);
    assert.match(movements, /Buzilgan/);
    assert.match(movements, /muzlatkich buzildi/);

    await context.close();
  });

  test('a stock outflow needs a quantity and a reason, and is one server call', async () => {
    const { page, context, sent, dialogs } = await openAdmin({
      adjust_cafe_stock: () => ({
        status: 'success', duplicate: false,
        inventory: [FLOUR, Object.assign({}, CHEESE, { qty: 0.5 })], inventoryRev: 5
      })
    });

    await page.evaluate(() => openRemoveStockModal('cheese'));
    await page.click('#removeStockModal button.bg-red-600');
    assert.ok(dialogs.some(d => /Miqdor/.test(d)), 'a missing quantity is refused');

    await page.fill('#removeStockQty', '0.5');
    await page.click('#removeStockModal button.bg-red-600');
    assert.ok(dialogs.some(d => /sabab/i.test(d)), 'a missing reason is refused');

    await page.fill('#removeStockNote', "to'kildi");
    await page.selectOption('#removeStockReason', 'waste');
    await page.click('#removeStockModal button.bg-red-600');
    // The screen reloads from the server after a movement, so the stock it ends
    // up showing is the server's answer rather than the optimistic one. What is
    // being asserted is what was *sent*.
    await page.waitForFunction(() =>
      document.getElementById('removeStockModal').classList.contains('hidden'));

    const moves = sent.filter(p => p.action === 'adjust_cafe_stock');
    assert.strictEqual(moves.length, 1, 'one movement, not a whole-inventory save');
    assert.strictEqual(moves[0].direction, 'out');
    assert.strictEqual(moves[0].reason, 'waste');
    assert.strictEqual(moves[0].qty, 0.5);
    assert.ok(moves[0].requestId, 'idempotent on a retry');
    assert.ok(!sent.some(p => p.action === 'save_inventory'),
      'the browser never writes the whole shelf back for one spill');

    await context.close();
  });

  test('an intake is a movement too', async () => {
    const { page, context, sent } = await openAdmin({
      adjust_cafe_stock: () => ({ status: 'success', inventory: [FLOUR, CHEESE], inventoryRev: 5 })
    });

    await page.evaluate(() => openAddStockModal('flour'));
    await page.fill('#addStockQty', '5');
    await page.fill('#addStockCost', '120000');
    await page.click('#addStockModal button.bg-emerald-600');
    await page.waitForFunction(() => document.getElementById('addStockModal').classList.contains('hidden'));

    const move = sent.filter(p => p.action === 'adjust_cafe_stock').pop();
    assert.ok(move, 'the intake went through the movement path');
    assert.strictEqual(move.direction, 'in');
    assert.strictEqual(move.reason, 'purchase');
    assert.strictEqual(move.qty, 5);
    assert.strictEqual(move.cost, 120000);

    await context.close();
  });

  test('a stale catalogue refusal refreshes the screen instead of overwriting', async () => {
    let saves = 0;
    const { page, context, sent } = await openAdmin({
      save_recipe: () => {
        saves++;
        if (saves === 1) {
          return {
            status: 'error', stale: true, catalogueRev: 9,
            message: "Katalog boshqa joyda o'zgardi."
          };
        }
        return { status: 'success', recipes: [PIZZA], catalogueRev: 10 };
      }
    });

    const readsBefore = sent.filter(p => p.action === 'get_cafe_data').length;
    await page.evaluate(() => retireRecipe('rec_1'));

    // The refusal reloads the screen. Waited for on the Node side, because the
    // requests are what is being asserted and the page has nothing to poll.
    const deadline = Date.now() + 15000;
    while (sent.filter(p => p.action === 'get_cafe_data').length <= readsBefore &&
           Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const reads = sent.filter(p => p.action === 'get_cafe_data');
    assert.ok(reads.length > readsBefore, 'the refusal triggered a refresh');
    assert.strictEqual(sent.filter(p => p.action === 'save_recipe').length, 1,
      'and the save was not repeated behind the operator');

    await context.close();
  });

  test('no page error is raised anywhere in the catalogue screens', async () => {
    const { page, context, errors } = await openAdmin();
    await page.evaluate(() => { switchTab('recipes', document.querySelector('[onclick*="recipes"]')); });
    await page.evaluate(() => { switchTab('inventory', document.querySelector('[onclick*="inventory"]')); });
    await page.evaluate(() => editRecipe('rec_1'));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });
});
