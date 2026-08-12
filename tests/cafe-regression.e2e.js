'use strict';

/**
 * Café POS regression coverage.
 *
 * `recomputeCloseDay`, `renderCloseDayList` and `submitCloseDay` used to be
 * defined two or three times each, with only the last definition actually
 * running. The duplicates are gone; these tests pin the behaviour of the
 * surviving implementations so the consolidation is provably behaviour-neutral:
 *
 *   - consumption and cost are measured against the *opening* inventory,
 *     not against the running balance, so mid-day restocks do not skew the
 *     cost of goods sold;
 *   - the close-day list shows opening quantity, current balance and portions
 *     sold;
 *   - close-day posts to the server and never composes a Telegram message.
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

/** The café read, whichever route it arrives on. */
function isCafeRead(request) {
  if (request.method() === 'GET') return true;
  try { return JSON.parse(request.postData() || '{}').action === 'get_cafe_data'; }
  catch (error) { return false; }
}


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

/** One bulk product: 10 kg of coffee costing 500 000 UZS, sold at 12 000/portion. */
const COFFEE = {
  id: 'inv_coffee',
  type: 'product',
  name: 'Kofe',
  category: 'Ichimliklar',
  qty: 10,
  unit: 'kg',
  unitCost: 50000,
  totalCost: 500000,
  sellPrice: 12000,
  isBulk: true,
  gramsPerServing: 20
};

describe('Café POS (browser)', () => {
  let server;
  let browser;
  let baseUrl;

  test.before(async () => {
    server = await startStaticServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  /** Opens cafe_pos.html with one bulk product and a mocked backend. */
  async function openPos() {
    const backendRequests = [];
    const telegramRequests = [];
    const context = await browser.newContext();

    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'cafe_seller');
      localStorage.setItem('omad_token', 'cafe_seller_active');
      localStorage.setItem('omad_access_key', 'e2e-access-key');
      localStorage.setItem('omad_user', 'kassir');
    });
    await context.route('**://api.telegram.org/**', route => {
      telegramRequests.push(route.request().url());
      route.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isCafeRead(request)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            inventory: [COFFEE], recipes: [], categories: ['Ichimliklar'],
            sales: [], closeReports: [], settings: { dailyTarget: 100000 }
          })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      backendRequests.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', reportJobId: 'job_1' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/cafe_pos.html`);
    await page.waitForFunction(() => state.menu.length > 0);
    // Playwright auto-dismisses dialogs, which would make confirm() return
    // false and short-circuit the flows under test.
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });

    return { page, context, backendRequests, telegramRequests, pageErrors };
  }

  test('a sale is recorded and posted to the server', async () => {
    const { page, context, backendRequests, telegramRequests, pageErrors } = await openPos();

    await page.evaluate(async () => {
      addToCart('product_inv_coffee');
      addToCart('product_inv_coffee');
      addToCart('product_inv_coffee');
      await sell();
    });

    const sales = backendRequests.filter(r => r.action === 'save_sale');
    assert.strictEqual(sales.length, 1);
    assert.strictEqual(sales[0].total, 36000);
    assert.ok(sales[0].id, 'the sale carries an id so it can be voided');

    const totals = await page.evaluate(() => ({
      revenue: state.todayRevenue,
      sold: state.todaySold['product_inv_coffee']
    }));
    assert.strictEqual(totals.revenue, 36000);
    assert.strictEqual(totals.sold, 3);

    assert.deepStrictEqual(telegramRequests, []);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a voided sale reverses the day totals', async () => {
    const { page, context, backendRequests, pageErrors } = await openPos();

    const remaining = await page.evaluate(async () => {
      addToCart('product_inv_coffee');
      await sell();
      const saleId = state.sessionSales[0].id;
      await voidSale(saleId);
      return { revenue: state.todayRevenue, sold: state.todaySold['product_inv_coffee'] || 0 };
    });

    assert.strictEqual(remaining.revenue, 0);
    assert.strictEqual(remaining.sold, 0);
    assert.strictEqual(backendRequests.filter(r => r.action === 'void_sale').length, 1);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('close-day costs consumption against the opening inventory', async () => {
    const { page, context, pageErrors } = await openPos();

    const rendered = await page.evaluate(() => {
      state.todaySold = { product_inv_coffee: 50 };
      state.todayRevenue = 600000;
      state.todayProfit = 200000;
      openCloseDayModal();
      const row = document.querySelector('#closeDayList > div[data-inventory-id]');
      return { text: row.textContent, initial: row.querySelector('.close-initial').value };
    });

    // The list is driven by the opening snapshot, and prefills it.
    assert.strictEqual(rendered.initial, '10');
    assert.match(rendered.text, /Bugun sotildi/);
    assert.match(rendered.text, /50/);

    const calc = await page.evaluate(() => {
      const row = document.querySelector('#closeDayList > div[data-inventory-id]');
      row.querySelector('.close-leftover').value = '9';
      recomputeCloseDay();
      return row.querySelector('.close-calc').textContent;
    });

    // 1 kg of 10 consumed -> 50 000 UZS of the 500 000 opening cost.
    // 50 portions -> 20 g and 1 000 UZS per portion.
    // Revenue 50 x 12 000 = 600 000, so net profit is 550 000.
    assert.match(calc, /1\.00 kg/);
    assert.match(calc, /20g/);
    assert.match(calc, /1,000 UZS/);
    assert.match(calc, /550,000 UZS/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a mid-day restock does not change the cost of what was consumed', async () => {
    const { page, context, pageErrors } = await openPos();

    const calc = await page.evaluate(() => {
      state.todaySold = { product_inv_coffee: 50 };
      // Someone restocked 10 kg at a higher price during the day. The opening
      // snapshot is what close-day must cost against.
      const inv = state.inventory.find(i => i.id === 'inv_coffee');
      inv.qty = 20;
      inv.totalCost = 1500000;
      inv.unitCost = 75000;

      openCloseDayModal();
      const row = document.querySelector('#closeDayList > div[data-inventory-id]');
      row.querySelector('.close-leftover').value = '9';
      recomputeCloseDay();
      return row.querySelector('.close-calc').textContent;
    });

    // Still 50 000 UZS of opening cost for 1 kg, not 75 000.
    assert.match(calc, /1,000 UZS/, 'cost per portion must come from the opening cost');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('an impossible leftover is rejected instead of producing a number', async () => {
    const { page, context } = await openPos();

    const calc = await page.evaluate(() => {
      openCloseDayModal();
      const row = document.querySelector('#closeDayList > div[data-inventory-id]');
      row.querySelector('.close-leftover').value = '25';
      recomputeCloseDay();
      return row.querySelector('.close-calc').textContent;
    });

    assert.match(calc, /Noto'g'ri qoldiq/);
    await context.close();
  });

  test('submitting close-day updates inventory and posts a server-side report', async () => {
    const { page, context, backendRequests, telegramRequests, pageErrors } = await openPos();

    const after = await page.evaluate(async () => {
      state.todaySold = { product_inv_coffee: 50 };
      state.todayRevenue = 600000;
      state.todayProfit = 200000;
      openCloseDayModal();
      document.querySelector('#closeDayList .close-leftover').value = '9';
      await submitCloseDay();
      const inv = state.inventory.find(i => i.id === 'inv_coffee');
      return {
        qty: inv.qty,
        totalCost: inv.totalCost,
        unitCost: inv.unitCost,
        gramsPerServing: inv.gramsPerServing,
        revenue: state.todayRevenue,
        openingQty: state.openingInventory.find(i => i.id === 'inv_coffee').qty
      };
    });

    // 9 kg left, holding 9/10 of the opening cost.
    assert.strictEqual(after.qty, 9);
    assert.strictEqual(after.totalCost, 450000);
    assert.strictEqual(after.unitCost, 50000);
    assert.strictEqual(after.gramsPerServing, 20, 'the measured portion size is learned back');
    assert.strictEqual(after.revenue, 0, 'the day is reset');
    assert.strictEqual(after.openingQty, 9, 'the opening snapshot rolls forward');

    const closes = backendRequests.filter(r => r.action === 'close_day');
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0].totalRevenue, 600000);
    assert.deepStrictEqual(closes[0].soldItems, [{ name: 'Kofe', qty: 50 }]);
    assert.strictEqual(closes[0].summary[0].consumed, 1);
    assert.strictEqual(closes[0].summary[0].netProfit, 550000);

    // The report is the server's job.
    assert.deepStrictEqual(
      backendRequests.filter(r => String(r.action || '').startsWith('telegram_')), []);
    assert.deepStrictEqual(telegramRequests, []);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('close-day skips rows with no leftover entered', async () => {
    const { page, context, backendRequests } = await openPos();

    await page.evaluate(async () => {
      openCloseDayModal();
      await submitCloseDay();
    });

    const closes = backendRequests.filter(r => r.action === 'close_day');
    assert.strictEqual(closes.length, 1);
    assert.deepStrictEqual(closes[0].summary, [], 'an untouched row is left alone');
    await context.close();
  });
});
