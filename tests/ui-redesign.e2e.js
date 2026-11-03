'use strict';

/**
 * The redesigned screens, in a real browser, against the real backend.
 *
 * The pages are served from this checkout and every request goes to script.gs
 * in the test harness, seeded with a small business, so a screen is checked
 * against the data the server actually produces. What is asserted is
 * reachability, not styling: every destination can be reached from the
 * navigation the screen shows at that size, the actions people depend on are
 * on screen and clickable, and nothing is wider than a 320px phone.
 * tests/ui-parity.test.js separately guards that no id or handler from before
 * the redesign disappeared, and that every icon a page names is in the sprite.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript, readJsonOutput, postEvent, currentPeriodKey } = require('./gas-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
const describe = chromium ? test.describe : test.describe.skip;

const ROOT = path.join(__dirname, '..');
const ADMIN_KEY = 'ui-admin-key';
const PERIOD = currentPeriodKey();

const LEDGER_HEADER = ['ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period', 'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used', 'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID', 'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'];
const ledgerRow = (n, tenant, type, amount, extra = {}) => [
  `${1780000000000 + n}_0`, `req_${n}`, new Date(Date.now() - n * 3600e3).toISOString(), '', 'omad_admin', 'Web', PERIOD,
  tenant, type, amount, 'UZS', 12500, 12650, 1, 'none', amount, 'Naqd', '', 'Active', '', '', 2,
  extra.group || `grp_${n}`, extra.kind || ''];

function boot() {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_TASKS_GROUP_CHAT_ID: '-100456' },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ [PERIOD]: { buy: 12500, sell: 12650 } })],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Apteka', defaultRent: 4500000, currency: 'UZS', active: true },
          { name: 'Jahongiraka (Okarachka)', defaultRent: 8435000, currency: 'UZS', active: true }])],
        ['Omad_Template_Expenses', '[]'], ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Coca-Cola 0.5L', type: 'product', category: 'Ichimliklar', qty: 40, unit: 'dona', sellPrice: 9000, unitCost: 6500, totalCost: 260000 }])],
        ['Cafe_Recipes', '[]'], ['Cafe_Categories', JSON.stringify(['Ichimliklar'])],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 500000 })]
      ],
      Omad_Transactions_V2: [LEDGER_HEADER,
        ledgerRow(1, 'Apteka', 'Income', 2000000),
        ledgerRow(2, 'Umumiy Naqd Puldan', 'Expense', 300000),
        ledgerRow(3, 'Apteka', 'Income', 350000, { group: 'grp_pair', kind: 'tenant_paid_expense' }),
        ledgerRow(4, 'Apteka', 'Expense', 350000, { group: 'grp_pair', kind: 'tenant_paid_expense' })]
    }
  });
  const post = body => readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
  post({ action: 'save_task', type: 'once', title: 'Rasmli ish', photoRequired: true, deadlineKey: new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10), deferReports: true });
  post({ action: 'save_task', type: 'routine', title: 'Kundalik ish', recurrence: { freq: 'daily' }, deferReports: true });
  const tokens = {};
  [['omad_admin', 'omad_admin'], ['cafe_admin', 'cafe_admin'], ['kassir', 'cafe_seller']].forEach(([user, role]) => {
    gas.setUserPassword(user, 'ui-password-123', role);
    tokens[role] = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: user, password: 'ui-password-123' }))).token;
  });
  return { gas, tokens };
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

const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 640 };
const DESKTOP = { width: 1280, height: 860 };

describe('Redesigned screens (browser)', () => {
  let server, browser, base, backend;

  test.before(async () => {
    backend = boot();
    server = await startStaticServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });
  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function open(page, role, viewport) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(s => {
      localStorage.setItem('omad_role', s.role);
      localStorage.setItem('omad_session', s.token);
      localStorage.setItem('omad_user', s.role);
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    }, { role, token: backend.tokens[role] });
    await context.route('**telegram.org/**', route => route.abort());
    await context.route('**script.google.com/**', async route => {
      let payload;
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (error) { payload = {}; }
      const out = backend.gas.doPost(postEvent(payload));
      await route.fulfill({ status: 200, contentType: 'application/json', body: out.__text });
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(String(error)));
    await tab.goto(`${base}/${page}`);
    await tab.waitForLoadState('networkidle');
    return { page: tab, context, errors };
  }

  /** On screen, not covered, and the right size to press. */
  async function assertReachable(page, selector, what) {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    assert.ok(await target.isVisible(), `${what} is visible`);
    const box = await target.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `${what} is within the screen width`);
    assert.ok(box.height >= 36, `${what} is ${box.height}px tall`);
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.closest('button, a, [role="button"], summary, select, input') !== null : false;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert.ok(hit, `${what} is not covered by anything else`);
  }

  async function noOverflow(page, width, what) {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(wide <= width + 1, `${what} is ${wide}px wide on a ${width}px screen`);
  }

  for (const viewport of [PHONE, DESKTOP]) {
    test(`Omad: every section is reachable from the menu at ${viewport.width}px`, async () => {
      const { page, context, errors } = await open('omad_admin.html', 'omad_admin', viewport);
      for (const tab of ['entry', 'bulk', 'history', 'settings', 'dash']) {
        await assertReachable(page, `#nav-${tab}`, `menu item ${tab}`);
        await page.click(`#nav-${tab}`);
        assert.ok(await page.locator(`#tab-${tab}`).isVisible(), `${tab} opens`);
      }
      await page.click('#nav-settings');
      for (const section of ['rates', 'tenants', 'expenses', 'telegram', 'system']) {
        await assertReachable(page, `[data-section="${section}"]`, `settings section ${section}`);
        await page.click(`[data-section="${section}"]`);
        assert.ok(await page.locator(`#settings-${section}`).isVisible(), `settings ${section} opens`);
      }
      assert.deepStrictEqual(errors, []);
      await context.close();
    });
  }

  test('Omad: the history keeps an edit and a cancel on every business action', async () => {
    const { page, context } = await open('omad_admin.html', 'omad_admin', PHONE);
    await page.click('#nav-history');
    await page.waitForSelector('#historyList button[aria-label="Tahrirlash"]');
    const rows = await page.locator('#historyList > .ui-card').count();
    assert.ok(rows >= 3, `${rows} history rows`);
    assert.strictEqual(await page.locator('#historyList button[aria-label="Tahrirlash"]').count(), rows);
    assert.strictEqual(await page.locator('#historyList button[aria-label="Bekor qilish"]').count(), rows);
    await assertReachable(page, '#historyList button[aria-label="Bekor qilish"]', 'the cancel action');
    assert.match(await page.textContent('#historyList'), /Bizning nomimizdan to'ladi/, 'the tenant-paid pair is labelled');
    await context.close();
  });

  test('Omad: the debt list opens as a sheet that can be closed', async () => {
    const { page, context } = await open('omad_admin.html', 'omad_admin', PHONE);
    await assertReachable(page, '#totalDebtCard', 'the debt card');
    await page.click('#totalDebtCard');
    await page.waitForSelector('#detailModal:not(.hidden)');
    assert.match(await page.textContent('#modalContent'), /Jahongiraka/);
    await assertReachable(page, '#detailModal button[aria-label="Yopish"]', 'the close button');
    await page.click('#detailModal button[aria-label="Yopish"]');
    assert.ok(await page.locator('#detailModal').isHidden());
    await context.close();
  });

  for (const viewport of [PHONE, DESKTOP]) {
    test(`Café admin: every section is reachable at ${viewport.width}px`, async () => {
      const { page, context, errors } = await open('cafe_admin.html', 'cafe_admin', viewport);
      for (const tab of ['inventory', 'recipes', 'categories', 'settings', 'reports', 'dash']) {
        const selector = `.ui-tabnav button[onclick*="'${tab}'"]`;
        await assertReachable(page, selector, `section ${tab}`);
        await page.click(selector);
        assert.ok(await page.locator(`#screen-${tab}`).isVisible(), `${tab} opens`);
      }
      await page.click(`.ui-tabnav button[onclick*="'inventory'"]`);
      for (const label of ['Kirim', 'Chiqim', 'Tahrirlash', "O'chirish"]) {
        await assertReachable(page, `#inventoryList button:has-text("${label}")`, `stock action ${label}`);
      }
      assert.deepStrictEqual(errors, []);
      await context.close();
    });
  }

  test('POS: on a phone the total and Sotish are on screen and the cart is a sheet', async () => {
    const { page, context } = await open('cafe_pos.html', 'cafe_seller', PHONE);
    await page.waitForSelector('#itemsGrid button');
    await page.click('#itemsGrid button');
    await assertReachable(page, '#sellBtn', 'Sotish');
    assert.ok(await page.locator('#cartModal').isHidden(), 'the cart starts closed');
    await page.click('button:has-text("Savat jami")');
    await page.waitForSelector('#cartModal:not(.hidden)');
    await assertReachable(page, '#cartList button:has-text("O\'chirish")', 'remove from cart');
    await context.close();
  });

  test('POS: on desktop the cart is always beside the menu', async () => {
    const { page, context } = await open('cafe_pos.html', 'cafe_seller', DESKTOP);
    await page.waitForSelector('#itemsGrid button');
    await page.click('#itemsGrid button');
    assert.ok(await page.locator('#cartList').isVisible(), 'the cart is open without being asked');
    assert.match(await page.textContent('#cartList'), /Coca-Cola/);
    await assertReachable(page, '#sellBtn', 'Sotish');
    await assertReachable(page, 'button:has-text("Kun Yakunlash")', 'Kun Yakunlash');
    await assertReachable(page, 'button[aria-label="Bugungi Cheklar"]', 'today\'s receipts');
    await context.close();
  });

  for (const viewport of [PHONE, DESKTOP]) {
    test(`Tasks: every tab is reachable at ${viewport.width}px and photo proof is unmistakable`, async () => {
      const { page, context, errors } = await open('tasks.html', 'omad_admin', viewport);
      await page.waitForSelector('#panel-today .card');
      for (const tab of ['tasks', 'routines', 'goals', 'completed', 'today']) {
        await assertReachable(page, `nav.nav [data-tab="${tab}"]`, `tab ${tab}`);
        await page.click(`nav.nav [data-tab="${tab}"]`);
        assert.ok(await page.locator(`#panel-${tab}`).isVisible(), `${tab} opens`);
      }
      assert.match(await page.textContent('#panel-today'), /Rasm bilan tasdiqlanadi/);
      await assertReachable(page, '.fab', 'new task');
      assert.deepStrictEqual(errors, []);
      await context.close();
    });
  }

  for (const [page, role] of [['omad_admin.html', 'omad_admin'], ['cafe_admin.html', 'cafe_admin'],
    ['cafe_pos.html', 'cafe_seller'], ['tasks.html', 'omad_admin'], ['login.html', 'omad_admin']]) {
    test(`${page} fits a 320px phone`, async () => {
      const { page: tab, context } = await open(page, role, NARROW);
      await noOverflow(tab, NARROW.width, page);
      await context.close();
    });
  }

});
