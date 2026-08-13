'use strict';

/**
 * What the café screens do when a load fails.
 *
 * This is the incident, written down. A café read that came back throttled —
 * or dropped, or unparsable — was treated as "your access is gone": the stored
 * key was deleted, the browser was sent to the login page, and `state` was
 * reset to empty inventory, empty categories and a zeroed daily target. Mid
 * shift, the till showed no products and asked the cashier to sign in again.
 *
 * The rules these tests hold:
 *
 *   1. A network, rate-limit, server or parse failure never ends the session
 *      and never replaces real data with empty data.
 *   2. The failure is *said*, in Uzbek, with a Retry that works.
 *   3. A genuinely empty café is a success and shows the ordinary empty state,
 *      which is a different thing from a failure and must look different.
 *   4. An expired session — and only that — returns to the login page.
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

const COLA = {
  id: 'inv_cola', type: 'product', name: 'Kola', category: 'Ichimliklar',
  qty: 20, unit: 'dona', unitCost: 6000, totalCost: 120000, sellPrice: 8000
};

/** A healthy `scope: "pos"` answer. */
function posPayload() {
  return {
    status: 'success', scope: 'pos', dateKey: '2026-08-13',
    inventory: [COLA], inventoryRev: 4, recipes: [], categories: ['Ichimliklar'],
    settings: { dailyTarget: 100000 }, sales: []
  };
}

/** A healthy `scope: "admin"` answer. */
function adminPayload() {
  return {
    status: 'success', scope: 'admin',
    inventory: [COLA], inventoryRev: 4, recipes: [], categories: ['Ichimliklar'],
    settings: { dailyTarget: 100000 },
    summary: {
      today: { revenue: 48000, profit: 12000, count: 6, top: 'Kola' },
      yesterday: { revenue: 0, profit: 0, count: 0, top: '' },
      month: { revenue: 48000, profit: 12000, count: 6, top: 'Kola' },
      all: { revenue: 96000, profit: 24000, count: 12, top: 'Kola' }
    },
    closeReports: []
  };
}

describe('Café screens under failure (browser)', () => {
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

  /**
   * Opens one café page with a scripted sequence of backend answers.
   *
   * `answers` is consumed one per café read; the last one repeats, so a test
   * can say "succeed, then fail, then succeed" and drive Retry.
   */
  async function openCafe(file, role, answers) {
    const context = await browser.newContext();
    const remaining = answers.slice();
    let served = 0;

    await context.addInitScript(r => {
      localStorage.setItem('omad_role', r);
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      localStorage.setItem('omad_user', 'kassir');
    }, role);

    await context.route('**script.google.com/**', async route => {
      const answer = remaining.length > 1 ? remaining.shift() : remaining[0];
      served++;
      if (answer === 'abort') return route.abort('failed');
      if (answer === 'html') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Moved</html>' });
      }
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(answer)
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/${file}`);
    return { page, context, pageErrors, served: () => served };
  }

  const THROTTLED = {
    status: 'error', code: 'throttled', authExpired: false,
    message: "Juda ko'p so'rov yuborildi. Iltimos, biroz kutib qayta urinib ko'ring."
  };
  const EXPIRED = {
    status: 'error', code: 'auth', authExpired: true,
    message: 'Sessiya muddati tugadi. Qaytadan kiring.'
  };

  // ------------------------------------------------------------------- POS

  test('a rate-limited POS load keeps the session and says so with a Retry', async () => {
    const { page, context, pageErrors } = await openCafe('cafe_pos.html', 'cafe_seller', [THROTTLED]);
    await page.waitForFunction(() => state.loadError !== '');

    assert.strictEqual(page.url().includes('login.html'), false, 'nobody was signed out');
    const session = await page.evaluate(() => localStorage.getItem('omad_session'));
    assert.strictEqual(session, 'e2e-session-token', 'the session is untouched');

    const banner = await page.textContent('#posBanner');
    assert.match(banner, /Juda ko'p so'rov/, 'the reason is shown, in Uzbek');
    assert.ok(await page.isVisible('#posBanner button'), 'and a Retry button with it');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a POS refresh that fails keeps the products that were already loaded', async () => {
    const { page, context, pageErrors } = await openCafe(
      'cafe_pos.html', 'cafe_seller', [posPayload(), THROTTLED]);
    await page.waitForFunction(() => state.menu.length > 0);

    const before = await page.evaluate(() => ({
      menu: state.menu.length, target: state.settings.dailyTarget,
      categories: state.categories.length
    }));
    assert.strictEqual(before.menu, 1);

    await page.evaluate(() => syncMenu());
    await page.waitForFunction(() => state.loadError !== '');

    const after = await page.evaluate(() => ({
      menu: state.menu.length, target: state.settings.dailyTarget,
      categories: state.categories.length,
      grid: document.getElementById('itemsGrid').textContent
    }));
    assert.deepStrictEqual(
      { menu: after.menu, target: after.target, categories: after.categories }, before,
      'the failed refresh changed nothing about the data');
    assert.match(after.grid, /Kola/, 'and the product is still on the screen');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('Retry recovers the till without a reload', async () => {
    const { page, context, pageErrors } = await openCafe(
      'cafe_pos.html', 'cafe_seller', [THROTTLED, posPayload()]);
    await page.waitForFunction(() => state.loadError !== '');

    await page.click('#posBanner button');
    await page.waitForFunction(() => state.menu.length > 0);

    const recovered = await page.evaluate(() => ({
      error: state.loadError,
      bannerHidden: document.getElementById('posBanner').classList.contains('hidden'),
      grid: document.getElementById('itemsGrid').textContent
    }));
    assert.strictEqual(recovered.error, '');
    assert.strictEqual(recovered.bannerHidden, true, 'the warning goes away when it stops being true');
    assert.match(recovered.grid, /Kola/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('an unparsable answer is a failure, not an empty shop', async () => {
    const { page, context, pageErrors } = await openCafe('cafe_pos.html', 'cafe_seller', ['html']);
    await page.waitForFunction(() => state.loadError !== '');

    assert.strictEqual(page.url().includes('login.html'), false);
    assert.match(await page.textContent('#posBanner'), /tushunarsiz/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a dropped connection is a failure, not an empty shop', async () => {
    const { page, context, pageErrors } = await openCafe('cafe_pos.html', 'cafe_seller', ['abort']);
    await page.waitForFunction(() => state.loadError !== '');

    assert.strictEqual(page.url().includes('login.html'), false);
    assert.match(await page.textContent('#posBanner'), /Aloqa yo'q/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a genuinely empty café shows the ordinary empty state, not a warning', async () => {
    const empty = Object.assign(posPayload(), { inventory: [], categories: [], recipes: [] });
    const { page, context, pageErrors } = await openCafe('cafe_pos.html', 'cafe_seller', [empty]);
    await page.waitForFunction(() => state.loaded === true);

    const view = await page.evaluate(() => ({
      error: state.loadError,
      bannerHidden: document.getElementById('posBanner').classList.contains('hidden'),
      grid: document.getElementById('itemsGrid').textContent
    }));
    assert.strictEqual(view.error, '', 'an empty shop is not an error');
    assert.strictEqual(view.bannerHidden, true);
    assert.match(view.grid, /Menyu bo'sh/, 'the empty state is what says so');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('an expired session does return the cashier to the login page', async () => {
    const { page, context } = await openCafe('cafe_pos.html', 'cafe_seller', [EXPIRED]);
    await page.waitForURL(/login\.html/, { timeout: 10000 });

    const cleared = await page.evaluate(() => localStorage.getItem('omad_session'));
    assert.strictEqual(cleared, null, 'and the dead session is cleared');
    await context.close();
  });

  test('the till reopens on its stored catalogue before the network answers', async () => {
    const { page, context } = await openCafe('cafe_pos.html', 'cafe_seller', [posPayload()]);
    await page.waitForFunction(() => state.menu.length > 0);
    await context.close();

    // Same browser profile, and this time the backend is down from the start.
    const second = await openCafe('cafe_pos.html', 'cafe_seller', ['abort']);
    // The snapshot is per-browser-context, so it is written in explicitly here
    // rather than depending on Playwright sharing storage between contexts.
    await second.page.evaluate(payload => {
      localStorage.setItem('omad_snapshot_cafe_pos_kassir',
        JSON.stringify({ savedAt: Date.now(), value: payload }));
    }, posPayload());
    await second.page.evaluate(() => { state.loaded = false; state.menu = []; });
    await second.page.evaluate(() => syncMenu());
    await second.page.waitForFunction(() => state.menu.length > 0);

    const view = await second.page.evaluate(() => ({
      grid: document.getElementById('itemsGrid').textContent,
      banner: document.getElementById('posBanner').textContent
    }));
    assert.match(view.grid, /Kola/, 'the stored catalogue is usable while the network is not');
    assert.match(view.banner, /Aloqa yo'q/, 'and the screen still says the refresh failed');
    await second.context.close();
  });

  test('the day cannot be closed from a snapshot the server never confirmed', async () => {
    const { page, context } = await openCafe('cafe_pos.html', 'cafe_seller', ['abort']);
    await page.evaluate(payload => {
      localStorage.setItem('omad_snapshot_cafe_pos_kassir',
        JSON.stringify({ savedAt: Date.now(), value: payload }));
    }, posPayload());
    await page.evaluate(() => { state.loaded = false; state.menu = []; });
    await page.evaluate(() => syncMenu());
    await page.waitForFunction(() => state.menu.length > 0);

    // Selling is safe on stale data - the server prices it and checks the
    // stock. Close-day is not: it writes a counted inventory back wholesale,
    // and the rows nobody touches are carried over from what is on screen.
    const refused = await page.evaluate(() => {
      const messages = [];
      const realAlert = window.alert;
      window.alert = message => messages.push(String(message));
      openCloseDayModal();
      window.alert = realAlert;
      return {
        messages,
        modalHidden: document.getElementById('closeDayModal').classList.contains('hidden')
      };
    });

    assert.strictEqual(refused.modalHidden, true, 'the close-day sheet did not open');
    assert.ok(refused.messages.some(m => /yangilanmagan/.test(m)), 'and it says why');
    await context.close();
  });

  // ----------------------------------------------------------------- admin

  test('a rate-limited café admin load keeps the catalogue and the session', async () => {
    const { page, context, pageErrors } = await openCafe(
      'cafe_admin.html', 'cafe_admin', [adminPayload(), THROTTLED]);
    await page.waitForFunction(() => state.inventory.length > 0);

    await page.evaluate(() => syncData());
    await page.waitForFunction(() => state.loadError !== '');

    const after = await page.evaluate(() => ({
      inventory: state.inventory.length,
      categories: state.categories.length,
      target: state.settings.dailyTarget,
      list: document.getElementById('inventoryList').textContent,
      banner: document.getElementById('cafeBanner').textContent
    }));
    assert.strictEqual(page.url().includes('login.html'), false);
    assert.strictEqual(after.inventory, 1, 'the stock list survived');
    assert.strictEqual(after.target, 100000, 'and so did the settings');
    assert.match(after.list, /Kola/);
    assert.match(after.banner, /Juda ko'p so'rov/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the café dashboard shows the totals the server computed', async () => {
    const { page, context, pageErrors } = await openCafe(
      'cafe_admin.html', 'cafe_admin', [adminPayload()]);
    await page.waitForFunction(() => state.inventory.length > 0);

    assert.strictEqual((await page.textContent('#dashRevenue')).trim(), '48,000 UZS');
    assert.strictEqual((await page.textContent('#dashProfit')).trim(), '12,000 UZS');
    assert.strictEqual((await page.textContent('#dashTop')).trim(), 'Kola');

    // Switching period reads another bucket of the same answer rather than
    // asking the server again.
    await page.selectOption('#dashFilter', 'all');
    assert.strictEqual((await page.textContent('#dashRevenue')).trim(), '96,000 UZS');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the café dashboard is never handed the sales history', async () => {
    const { page, context } = await openCafe('cafe_admin.html', 'cafe_admin', [adminPayload()]);
    await page.waitForFunction(() => state.inventory.length > 0);

    const holdsSales = await page.evaluate(() => Object.prototype.hasOwnProperty.call(state, 'sales'));
    assert.strictEqual(holdsSales, false, 'the receipts stay on the server');
    await context.close();
  });
});
