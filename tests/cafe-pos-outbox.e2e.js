'use strict';

/**
 * The till's sales outbox, in a real browser, against the real backend.
 *
 * Sotish no longer waits for the server: the cart empties at once, the sale is
 * kept on the device and sent behind it. These tests hold the promises that
 * make that safe -- the server still decides every sale, a sale is counted once
 * and only when the server confirms it, a refusal is never lost or resent by
 * itself, a lost answer is resent under the same request id, and the day cannot
 * be closed while a sale is still on the device.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
const describe = chromium ? test.describe : test.describe.skip;

const ROOT = path.join(__dirname, '..');
const ADMIN_KEY = 'pos-outbox-admin';

/** Two products: plenty of cola, one bottle of water. */
const INVENTORY = [
  { id: 'i_cola', name: 'Cola', type: 'product', category: 'Ichimliklar', qty: 40, unit: 'dona', sellPrice: 9000, unitCost: 6000, totalCost: 240000 },
  { id: 'i_water', name: 'Suv', type: 'product', category: 'Ichimliklar', qty: 1, unit: 'dona', sellPrice: 5000, unitCost: 2500, totalCost: 2500 }
];

function boot() {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [
        ['Cafe_Inventory', JSON.stringify(INVENTORY)], ['Cafe_Recipes', '[]'],
        ['Cafe_Categories', JSON.stringify(['Ichimliklar'])], ['Cafe_Settings', JSON.stringify({ dailyTarget: 100000 })]
      ]
    }
  });
  gas.setUserPassword('kassir', 'pos-outbox-password', 'cafe_seller');
  const token = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: 'kassir', password: 'pos-outbox-password' }))).token;
  return { gas, token };
}

/** The sales the server holds, from its own admin read. */
function storedSales(gas) {
  const answer = readJsonOutput(gas.doPost(postEvent({ action: 'get_cafe_data', adminKey: ADMIN_KEY })));
  return (answer.sales || []);
}

function startStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Café POS sales outbox (browser)', () => {
  let server, browser, base;

  test.before(async () => {
    server = await startStaticServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });
  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  /**
   * Opens the till. `sale` decides what happens to each save_sale request:
   * 'answer' (default), 'slow' (answered after a pause), 'lost' (the server
   * stores it, the answer never arrives) or 'offline' (it never arrives).
   */
  async function openPos(backend, options = {}) {
    const control = { sale: options.sale || 'answer', sent: [] };
    const context = await browser.newContext();
    await context.addInitScript(s => {
      localStorage.setItem('omad_role', 'cafe_seller');
      localStorage.setItem('omad_session', s.token);
      localStorage.setItem('omad_user', 'kassir');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      if (s.outbox && !sessionStorage.getItem('__seeded')) {
        s.outbox.forEach(item => localStorage.setItem('cafe_pos_outbox_kassir_' + item.id, JSON.stringify(item)));
        sessionStorage.setItem('__seeded', '1');
      }
      // The outbox cannot be written while this is true; a test can flip it.
      window.__breakOutbox = !!s.brokenStorage;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (window.__breakOutbox && String(key).indexOf('cafe_pos_outbox_') === 0) throw new Error('QuotaExceededError');
        return original.call(this, key, value);
      };
    }, { token: backend.token, outbox: options.outbox || null, brokenStorage: !!options.brokenStorage });
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      if (payload.action === 'save_sale') {
        control.sent.push(payload);
        if (control.sale === 'offline') { await route.abort('failed'); return; }
        const out = backend.gas.doPost(postEvent(payload));
        if (control.sale === 'lost') { await route.abort('failed'); return; }
        if (control.sale === 'slow') await sleep(400);
        await route.fulfill({ status: 200, contentType: 'application/json', body: out.__text });
        return;
      }
      const out = backend.gas.doPost(postEvent(payload));
      await route.fulfill({ status: 200, contentType: 'application/json', body: out.__text });
    });
    const page = await context.newPage();
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/cafe_pos.html`);
    await page.waitForFunction(() => state.loaded && state.menu.length > 0);
    return { page, context, control, dialogs, errors };
  }

  const outbox = page => page.evaluate(() => readPosOutbox().map(item => ({ status: item.status, error: item.error })));

  test('Sotish empties the cart at once; the sale is counted when the server confirms it', async () => {
    const backend = boot();
    const { page, context, errors } = await openPos(backend, { sale: 'slow' });

    const atTap = await page.evaluate(() => {
      addToCart('product_i_cola'); addToCart('product_i_cola');
      window.__sent = sell();
      return {
        cart: state.cart.length,
        unsent: readPosOutbox().length,
        revenue: state.todayRevenue,
        banner: !document.getElementById('posOutboxBanner').classList.contains('hidden'),
        listed: document.querySelectorAll('#receiptsList [data-outbox="pending"]').length
      };
    });
    assert.deepStrictEqual(atTap, { cart: 0, unsent: 1, revenue: 0, banner: true, listed: 1 },
      'the cart is empty before the server answers, and nothing is counted yet');

    await page.evaluate(() => window.__sent);
    const after = await page.evaluate(() => ({
      unsent: readPosOutbox().length,
      revenue: state.todayRevenue,
      receipts: state.sessionSales.length,
      banner: !document.getElementById('posOutboxBanner').classList.contains('hidden')
    }));
    assert.deepStrictEqual(after, { unsent: 0, revenue: 18000, receipts: 1, banner: false });
    assert.strictEqual(storedSales(backend.gas).length, 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  test('a refused sale stays on the till in red with the reason, is never counted, and can go back in the cart', async () => {
    const backend = boot();
    const { page, context, dialogs, control } = await openPos(backend);

    await page.evaluate(async () => { addToCart('product_i_water'); addToCart('product_i_water'); await sell(); });
    const [item] = await outbox(page);
    assert.strictEqual(item.status, 'failed');
    assert.match(item.error, /yetarli emas/i, 'the server said why');
    assert.ok(dialogs.some(text => /Sotuv saqlanmadi/.test(text)), 'and the cashier was told at once');
    assert.strictEqual(await page.evaluate(() => state.todayRevenue), 0);
    assert.strictEqual(storedSales(backend.gas).length, 0);
    assert.ok(await page.evaluate(() =>
      document.getElementById('posOutboxBanner').className.includes('ui-alert-danger')), 'the till itself shows it');

    // Not resent by itself.
    const sentBefore = control.sent.length;
    await page.evaluate(() => drainPosOutbox());
    assert.strictEqual(control.sent.length, sentBefore, 'the refused sale was not sent again');
    assert.strictEqual(storedSales(backend.gas).length, 0);

    const cart = await page.evaluate(() => {
      returnPosSaleToCart(readPosOutbox()[0].id);
      return { lines: state.cart.map(i => `${i.id}x${i.qty}`), unsent: readPosOutbox().length };
    });
    assert.deepStrictEqual(cart, { lines: ['product_i_waterx2'], unsent: 0 });
    await context.close();
  });

  test('a sale whose answer was lost is sent again under the same id and counted once', async () => {
    const backend = boot();
    const { page, context, control } = await openPos(backend, { sale: 'lost' });

    await page.evaluate(async () => { addToCart('product_i_cola'); await sell(); });
    assert.deepStrictEqual(await outbox(page), [{ status: 'pending', error: '' }],
      'a lost answer is not a refusal: the sale waits to be sent again');
    assert.strictEqual(storedSales(backend.gas).length, 1, 'although the server already has it');

    control.sale = 'answer';
    await page.evaluate(() => drainPosOutbox());
    assert.strictEqual(control.sent.length, 2);
    assert.strictEqual(control.sent[0].requestId, control.sent[1].requestId, 'the resend carries the same request id');
    assert.strictEqual(storedSales(backend.gas).length, 1, 'and the server keeps one sale');
    const after = await page.evaluate(() => ({ unsent: readPosOutbox().length, revenue: state.todayRevenue, receipts: state.sessionSales.length }));
    assert.deepStrictEqual(after, { unsent: 0, revenue: 9000, receipts: 1 });
    await context.close();
  });

  test('the day cannot be closed while a sale is still on the device', async () => {
    const backend = boot();
    const { page, context, dialogs } = await openPos(backend, { sale: 'offline' });

    await page.evaluate(async () => { addToCart('product_i_cola'); await sell(); });
    await page.evaluate(() => openCloseDayModal());
    assert.ok(await page.locator('#closeDayModal').isHidden(), 'close-day did not open');
    assert.ok(dialogs.some(text => /yuborilmagan/.test(text)), 'and the cashier is told why');
    await context.close();
  });

  test('a sale an earlier visit left unsent goes out after the next load, without being counted twice', async () => {
    const backend = boot();
    // The earlier visit's request reached the server; only its answer was lost.
    const payload = {
      action: 'save_sale', id: '1790000000000', requestId: 'pos_earlier_visit', date: new Date().toISOString(),
      seller: 'kassir', items: [{ id: 'product_i_cola', kind: 'product', inventoryId: 'i_cola', recipeId: null, name: 'Cola', qty: 1 }]
    };
    readJsonOutput(backend.gas.doPost(postEvent(Object.assign({ sessionToken: backend.token }, payload))));
    const left = [{ id: payload.requestId, payload, lines: payload.items, estimate: 9000, status: 'pending', error: '', at: Date.now() }];

    const { page, context, control } = await openPos(backend, { outbox: left });
    await page.waitForFunction(() => readPosOutbox().length === 0);
    assert.strictEqual(control.sent.length, 1, 'it was sent');
    const figures = await page.evaluate(() => ({ revenue: state.todayRevenue, receipts: state.sessionSales.length }));
    assert.deepStrictEqual(figures, { revenue: 9000, receipts: 1 }, 'the receipt the server already had is not counted again');
    assert.strictEqual(storedSales(backend.gas).length, 1);
    await context.close();
  });

  test('a device that cannot keep the outbox waits for the server, as the till always did', async () => {
    const backend = boot();
    const { page, context } = await openPos(backend, { sale: 'slow', brokenStorage: true });

    const atTap = await page.evaluate(() => {
      addToCart('product_i_cola');
      window.__sent = sell();
      return { label: document.getElementById('sellBtn').textContent, cart: state.cart.length };
    });
    assert.deepStrictEqual(atTap, { label: 'Sotilmoqda...', cart: 1 }, 'the button holds and the cart stays until the answer');
    await page.evaluate(() => window.__sent);
    const after = await page.evaluate(() => ({ cart: state.cart.length, revenue: state.todayRevenue }));
    assert.deepStrictEqual(after, { cart: 0, revenue: 9000 });
    assert.strictEqual(storedSales(backend.gas).length, 1);
    await context.close();
  });

  test('a refusal that cannot be written down is still never resent by itself', async () => {
    const backend = boot();
    const { page, context, control, dialogs } = await openPos(backend);
    // The sale is kept, then storage fills up before the refusal can be recorded.
    await page.evaluate(() => {
      addToCart('product_i_water'); addToCart('product_i_water');
      const sent = sell();
      window.__breakOutbox = true;
      return sent;
    });
    const [item] = await outbox(page);
    assert.strictEqual(item.status, 'failed', 'shown as refused although storage did not take it');
    assert.ok(dialogs.some(text => /xotirasi to'la/.test(text)), 'and the cashier is told why');
    const sentBefore = control.sent.length;
    await page.evaluate(() => drainPosOutbox());
    assert.strictEqual(control.sent.length, sentBefore, 'not sent again by itself');
    await context.close();
  });

  test('a refused sale with an item that has left the menu stays put rather than losing that line', async () => {
    const backend = boot();
    const { page, context, dialogs } = await openPos(backend);
    await page.evaluate(async () => { addToCart('product_i_water'); addToCart('product_i_water'); await sell(); });
    const kept = await page.evaluate(() => {
      state.menu = state.menu.filter(item => item.id !== 'product_i_water');   // retired since
      returnPosSaleToCart(readPosOutbox()[0].id);
      return { unsent: readPosOutbox().length, cart: state.cart.length };
    });
    assert.deepStrictEqual(kept, { unsent: 1, cart: 0 });
    assert.ok(dialogs.some(text => /menyuda yo'q: Suv/.test(text)), 'and it names the item');
    await context.close();
  });

  test('a sale rung up on an earlier day and confirmed today is not counted in today', async () => {
    const backend = boot();
    const yesterday = new Date(Date.now() - 36 * 3600e3).toISOString();
    const payload = {
      action: 'save_sale', id: '1790000000001', requestId: 'pos_yesterday', date: yesterday,
      seller: 'kassir', items: [{ id: 'product_i_cola', kind: 'product', inventoryId: 'i_cola', recipeId: null, name: 'Cola', qty: 1 }]
    };
    const left = [{ id: payload.requestId, payload, lines: payload.items, estimate: 9000, status: 'pending', error: '', at: Date.now() - 36 * 3600e3 }];
    const { page, context } = await openPos(backend, { outbox: left });
    await page.waitForFunction(() => readPosOutbox().length === 0);
    const figures = await page.evaluate(() => ({
      revenue: state.todayRevenue, receipts: state.sessionSales.length,
      stock: state.inventory.find(item => item.id === 'i_cola').qty
    }));
    assert.deepStrictEqual(figures, { revenue: 0, receipts: 0, stock: 39 },
      "yesterday's sale stays out of today's figures, while the stock still follows the server");
    assert.strictEqual(storedSales(backend.gas).length, 1);
    await context.close();
  });

  test('a direct sale whose answer was lost is retried under its id even once storage works again', async () => {
    const backend = boot();
    const { page, context, control } = await openPos(backend, { sale: 'lost', brokenStorage: true });
    await page.evaluate(async () => { addToCart('product_i_cola'); await sell(); });
    assert.strictEqual(await page.evaluate(() => state.cart.length), 1, 'the cart stays for the retry');

    control.sale = 'answer';
    await page.evaluate(async () => { window.__breakOutbox = false; await sell(); });
    assert.strictEqual(control.sent.length, 2);
    assert.strictEqual(control.sent[0].requestId, control.sent[1].requestId, 'the same cart, the same id');
    assert.strictEqual(storedSales(backend.gas).length, 1, 'one checkout, one sale');
    assert.deepStrictEqual(await page.evaluate(() => ({ cart: state.cart.length, revenue: state.todayRevenue, unsent: readPosOutbox().length })),
      { cart: 0, revenue: 9000, unsent: 0 });
    await context.close();
  });

  test('two tabs of the till keep each other\'s unsent sales', async () => {
    const backend = boot();
    const { page, context } = await openPos(backend, { sale: 'offline' });
    const second = await context.newPage();
    await second.goto(`${base}/cafe_pos.html`);
    await second.waitForFunction(() => state.loaded && state.menu.length > 0);

    await page.evaluate(() => { addToCart('product_i_cola'); return sell(); });
    await second.evaluate(() => { addToCart('product_i_water'); return sell(); });
    const seen = await Promise.all([page, second].map(tab => tab.evaluate(() => readPosOutbox().length)));
    assert.deepStrictEqual(seen, [2, 2], 'each tab sees both sales');
    await context.close();
  });
});
