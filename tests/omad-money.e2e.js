'use strict';

/**
 * Monetary input formatting in a real browser: typing, caret position, paste,
 * deletion, decimals and the mobile numeric keyboard.
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

/** Every field that should format money, and the tab it lives on. */
const MONEY_FIELDS = [
  { id: 'tempAmount', open: 'switchTab("entry")' },
  { id: 'settingRateBuyInput', open: 'switchTab("settings"); showSettingsSection("rates")' },
  { id: 'settingRateSellInput', open: 'switchTab("settings"); showSettingsSection("rates")' },
  { id: 'newTenantRent', open: 'switchTab("settings"); showSettingsSection("tenants")' },
  { id: 'templateExpenseAmount', open: 'switchTab("settings"); showSettingsSection("expenses")' }
];

describe('Monetary input (browser)', () => {
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

  async function openAdmin() {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            transactions: [],
            tenants: [{ name: 'Tehnopark', defaultRent: 500, currency: 'USD' }],
            rates: { '2026-01': { buy: 12000, sell: 12500 } },
            templateExpenses: []
          })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(payload.action === 'get_migration_status'
          ? { status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } }
          : { status: 'success' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    return { page, context, requests, pageErrors };
  }

  // ------------------------------------------------------------------ typing

  test('typing groups digits as they are entered', async () => {
    const { page, context, pageErrors } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));

    const steps = [];
    for (const digit of '12500000') {
      await page.type('#tempAmount', digit);
      steps.push(await page.inputValue('#tempAmount'));
    }

    assert.deepStrictEqual(steps, [
      '1', '12', '125', '1 250', '12 500', '125 000', '1 250 000', '12 500 000'
    ]);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the caret stays after the digit that was typed', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '15000');

    const caret = await page.evaluate(() => {
      const input = document.getElementById('tempAmount');
      return { value: input.value, start: input.selectionStart };
    });

    assert.strictEqual(caret.value, '15 000');
    assert.strictEqual(caret.start, 6, 'the caret is at the end, not pushed left by the separator');
    await context.close();
  });

  test('inserting a digit in the middle keeps the caret beside it', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '1000000');

    const result = await page.evaluate(() => {
      const input = document.getElementById('tempAmount');
      // Put the caret right after the leading "1" and type a "2".
      input.setSelectionRange(1, 1);
      input.value = '21 000 000';
      input.setSelectionRange(2, 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { value: input.value, start: input.selectionStart };
    });

    assert.strictEqual(result.value, '21 000 000');
    assert.strictEqual(result.start, 2);
    await context.close();
  });

  // ---------------------------------------------------------------- deletion

  test('deleting digits regroups the remainder', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '12500000');

    await page.focus('#tempAmount');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');

    assert.strictEqual(await page.inputValue('#tempAmount'), '12 500');
    await context.close();
  });

  test('clearing the field leaves it empty', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '12500');
    await page.fill('#tempAmount', '');

    assert.strictEqual(await page.inputValue('#tempAmount'), '');
    await context.close();
  });

  // ------------------------------------------------------------------- paste

  test('a pasted amount is reformatted', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));

    const value = await page.evaluate(async () => {
      const input = document.getElementById('tempAmount');
      input.focus();
      input.value = 'USD 1,250,000';
      input.dispatchEvent(new Event('paste', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 10));
      return input.value;
    });

    assert.strictEqual(value, '1 250 000');
    await context.close();
  });

  test('invalid characters are dropped', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '1a2b3c000');

    assert.strictEqual(await page.inputValue('#tempAmount'), '123 000');
    await context.close();
  });

  // ---------------------------------------------------------------- decimals

  test('a decimal USD amount is accepted and stored cleanly', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '1250.75');

    assert.strictEqual(await page.inputValue('#tempAmount'), '1 250.75');

    const stored = await page.evaluate(() => {
      document.getElementById('tempCurr').value = 'USD';
      addToCart();
      return cart[0];
    });

    assert.strictEqual(stored.amount, 1250.75, 'the stored value has no spaces');
    assert.strictEqual(stored.currency, 'USD');
    await context.close();
  });

  test('a decimal being typed is not truncated', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => switchTab('entry'));
    await page.type('#tempAmount', '1500.');

    assert.strictEqual(await page.inputValue('#tempAmount'), '1 500.');
    await context.close();
  });

  // ------------------------------------------------------------ round trips

  test('a formatted amount is saved as a clean number', async () => {
    const { page, context, requests } = await openAdmin();

    await page.evaluate(() => {
      switchTab('settings');
      showSettingsSection('rates');
      document.getElementById('settingRateBuyInput').value = '';
      document.getElementById('settingRateSellInput').value = '';
    });
    await page.type('#settingRateBuyInput', '13000');
    await page.type('#settingRateSellInput', '13500');

    const displayed = await page.evaluate(() => ({
      buy: document.getElementById('settingRateBuyInput').value,
      sell: document.getElementById('settingRateSellInput').value
    }));
    assert.strictEqual(displayed.buy, '13 000');
    assert.strictEqual(displayed.sell, '13 500');

    await page.evaluate(() => {
      document.getElementById('settingRateYear').value = String(currentYear());
      document.getElementById('settingMonth').value = '5';
      saveRate();
    });

    const period = await page.evaluate(() => buildPeriod(currentYear(), 5));
    const stored = await page.evaluate(p => app.rates[p], period);
    assert.deepStrictEqual(stored, { buy: 13000, sell: 13500 });
    await context.close();
  });

  test('a prefilled amount is shown grouped', async () => {
    const { page, context } = await openAdmin();

    const shown = await page.evaluate(() => {
      switchTab('settings');
      showSettingsSection('tenants');
      app.tenants[0].defaultRent = 12500000;
      editTenant(0);
      return document.getElementById('newTenantRent').value;
    });

    assert.strictEqual(shown, '12 500 000');
    await context.close();
  });

  // ------------------------------------------------------------------ mobile

  test('every money field keeps the mobile numeric keyboard', async () => {
    const { page, context } = await openAdmin();
    await page.setViewportSize({ width: 375, height: 812 });

    for (const field of MONEY_FIELDS) {
      await page.evaluate(open => eval(open), field.open);
      const attributes = await page.evaluate(id => {
        const input = document.getElementById(id);
        return { type: input.getAttribute('type'), inputmode: input.getAttribute('inputmode') };
      }, field.id);

      // A `type="number"` field refuses grouped digits, so these stay text
      // and rely on `inputmode` for the numeric keypad.
      assert.strictEqual(attributes.type, 'text', field.id);
      assert.strictEqual(attributes.inputmode, 'decimal', field.id);
    }
    await context.close();
  });

  test('formatting is attached to every money field', async () => {
    const { page, context } = await openAdmin();

    const attached = await page.evaluate(ids => ids.map(id => {
      const input = document.getElementById(id);
      return { id, attached: input ? input.dataset.moneyFormatted === 'true' : false };
    }), MONEY_FIELDS.map(f => f.id));

    assert.deepStrictEqual(attached.filter(a => !a.attached), []);
    await context.close();
  });
});
