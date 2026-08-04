'use strict';

/**
 * The Omad admin's year-month behaviour in a real browser.
 *
 * Canonical periods ("2026-01") are what the app stores and filters on; the UI
 * only ever shows friendly Uzbek labels ("Yanvar 2026"). These tests pin both
 * halves, plus the cases month-only values used to get wrong: two Januaries in
 * different years, and December sorting after January.
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

function tx(id, period, overrides = {}) {
  return {
    id, period, month: period, tenant: 'Tehnopark', type: 'Income',
    amount: 1000000, currency: 'UZS', method: 'Naqd',
    date: '05/' + period.slice(5) + '/' + period.slice(0, 4),
    comment: '', msgId: '', requestId: '', ...overrides
  };
}

const REMOTE = {
  transactions: [
    tx('1700000000000_0', '2026-01'),
    tx('1700000000001_0', '2026-12', { amount: 2000000 }),
    tx('1700000000002_0', '2027-01', { amount: 300, currency: 'USD' })
  ],
  tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
  rates: {
    '2026-01': { buy: 12000, sell: 12500 },
    '2026-12': { buy: 12800, sell: 13000 },
    '2027-01': { buy: 13000, sell: 13500 }
  },
  templateExpenses: [{ id: 'e1', month: '2026-01', name: 'Soliq', amount: 500000, currency: 'UZS' }]
};

/**
 * saveCloud() runs in the background, so a POST can still be in flight when
 * the assertion runs. Poll for it rather than assuming it has landed.
 */
async function waitForRequest(requests, action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = requests.filter(r => r.action === action).pop();
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for a ${action} request`);
}

describe('Omad admin periods (browser)', () => {
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

  async function openAdmin(remote = REMOTE) {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        try { requests.push(JSON.parse(request.postData() || '{}')); } catch (e) { requests.push({}); }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(request.method() === 'GET' ? remote : { status: 'success' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.transactions.length > 0 || app.tenants.length > 0);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    return { page, context, requests, pageErrors };
  }

  // ------------------------------------------------------------- selectors

  test('period selectors offer canonical values with Uzbek labels', async () => {
    const { page, context, pageErrors } = await openAdmin();

    const options = await page.evaluate(() =>
      [...document.getElementById('dashMonthSelect').options].map(o => ({ value: o.value, label: o.textContent })));

    assert.strictEqual(options[0].value, 'Jami Davr');
    const january2026 = options.find(o => o.value === '2026-01');
    const january2027 = options.find(o => o.value === '2027-01');
    assert.ok(january2026 && january2027, 'both Januaries are offered');
    assert.strictEqual(january2026.label, 'Yanvar 2026');
    assert.strictEqual(january2027.label, 'Yanvar 2027');

    // Chronological, so December 2026 sits before January 2027.
    const values = options.slice(1).map(o => o.value);
    assert.deepStrictEqual(values, values.slice().sort());
    assert.ok(values.indexOf('2026-12') < values.indexOf('2027-01'));

    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a year with data is offered even when it is in the past', async () => {
    const { page, context } = await openAdmin({
      ...REMOTE,
      transactions: [tx('1_0', '2019-05')]
    });

    const years = await page.evaluate(() => availableYears());
    assert.ok(years.includes(2019), 'the year that has data must be selectable');
    await context.close();
  });

  // ----------------------------------------------------------- filtering

  test('two Januaries in different years do not collide', async () => {
    const { page, context } = await openAdmin();

    const jan2026 = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return document.getElementById('dash-income').innerText;
    });
    const jan2027 = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2027-01';
      renderDashboard();
      return document.getElementById('dash-income').innerText;
    });

    // January 2026: 1 000 000 UZS. January 2027: 300 USD at its own sell rate
    // of 13 500 = 4 050 000 UZS.
    assert.strictEqual(jan2026.replace(/\D/g, ''), '1000000');
    assert.strictEqual(jan2027.replace(/\D/g, ''), '4050000');
    await context.close();
  });

  test('each period converts USD at its own rate', async () => {
    const { page, context } = await openAdmin();
    const converted = await page.evaluate(() => ({
      jan2026: toUZS(100, 'USD', '2026-01', 'sell'),
      jan2027: toUZS(100, 'USD', '2027-01', 'sell'),
      dec2026: toUZS(100, 'USD', '2026-12', 'sell')
    }));

    assert.strictEqual(converted.jan2026, 1250000);
    assert.strictEqual(converted.jan2027, 1350000);
    assert.strictEqual(converted.dec2026, 1300000);
    await context.close();
  });

  test('the all-periods view sums every year', async () => {
    const { page, context } = await openAdmin();
    const total = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = 'Jami Davr';
      renderDashboard();
      return document.getElementById('dash-income').innerText;
    });
    // 1 000 000 + 2 000 000 + 4 050 000
    assert.strictEqual(total.replace(/\D/g, ''), '7050000');
    await context.close();
  });

  test('history is ordered newest period first and labelled in Uzbek', async () => {
    const { page, context } = await openAdmin();
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#historyList .text-\\[10px\\]')]
        .map(e => e.textContent.trim())
        .filter(t => t.includes('•')));

    assert.ok(labels[0].includes('Yanvar 2027'), `expected Yanvar 2027 first, got ${labels[0]}`);
    assert.ok(labels[1].includes('Dekabr 2026'));
    assert.ok(labels[2].includes('Yanvar 2026'));
    await context.close();
  });

  test('the expenses modal filters by period', async () => {
    const { page, context } = await openAdmin({
      ...REMOTE,
      transactions: [
        tx('1_0', '2026-01', { type: 'Expense', amount: 111111 }),
        tx('2_0', '2027-01', { type: 'Expense', amount: 222222 })
      ]
    });

    const shown = await page.evaluate(() => {
      openExpenseModal();
      document.getElementById('expenseMonthFilter').value = '2027-01';
      renderExpenseModal();
      return document.getElementById('expenseList').textContent;
    });

    assert.ok(shown.includes('222,222'));
    assert.ok(!shown.includes('111,111'));
    await context.close();
  });

  // ------------------------------------------------------------- rate editor

  test('the rate editor is a year plus a month and saves a canonical key', async () => {
    const { page, context, requests } = await openAdmin();

    const saved = await page.evaluate(async () => {
      switchTab('settings');
      document.getElementById('settingRateYear').value = '2027';
      document.getElementById('settingMonth').value = '3';
      onRateSelectorChange();
      document.getElementById('settingRateBuyInput').value = '14000';
      document.getElementById('settingRateSellInput').value = '14500';
      saveRate();
      return app.rates['2027-03'];
    });

    assert.deepStrictEqual(saved, { buy: 14000, sell: 14500 });
    const save = await waitForRequest(requests, 'save_omad');
    assert.deepStrictEqual(save.rates['2027-03'], { buy: 14000, sell: 14500 });
    await context.close();
  });

  test('the yearly overview shows every month and marks the missing ones', async () => {
    const { page, context } = await openAdmin();

    const overview = await page.evaluate(() => {
      switchTab('settings');
      document.getElementById('settingRateYear').value = '2026';
      onRateSelectorChange();
      return document.getElementById('ratesList').textContent;
    });

    assert.ok(overview.includes('Yanvar'));
    assert.ok(overview.includes('Dekabr'));
    assert.ok(overview.includes('12,000'), 'the January 2026 buy rate is shown');
    assert.ok(overview.includes('belgilanmagan'), 'months with no rate are called out');
    await context.close();
  });

  test('editing an existing rate asks for confirmation first', async () => {
    const { page, context } = await openAdmin();

    const outcome = await page.evaluate(() => {
      switchTab('settings');
      let asked = false;
      window.confirm = () => { asked = true; return false; };
      document.getElementById('settingRateYear').value = '2026';
      document.getElementById('settingMonth').value = '1';
      onRateSelectorChange();
      document.getElementById('settingRateSellInput').value = '99999';
      saveRate();
      return { asked, sell: app.rates['2026-01'].sell };
    });

    assert.strictEqual(outcome.asked, true);
    assert.strictEqual(outcome.sell, 12500, 'declining the confirmation leaves the rate alone');
    await context.close();
  });

  // --------------------------------------------------------------- entry

  test('a new transaction is saved against the selected canonical period', async () => {
    const { page, context, requests } = await openAdmin();

    await page.evaluate(async () => {
      switchTab('entry');
      document.getElementById('entryMonth').value = '2027-01';
      document.getElementById('tempAmount').value = '500000';
      addToCart();
      document.getElementById('entryComment').value = 'test';
      await submitAll();
    });

    const save = requests.find(r => r.action === 'save_omad');
    const added = save.transactions.find(t => t.comment === 'test');
    assert.strictEqual(added.month, '2027-01');
    await context.close();
  });

  test('editing a transaction reselects its own period', async () => {
    const { page, context } = await openAdmin();
    const selected = await page.evaluate(() => {
      editTx('1700000000001_0');
      return document.getElementById('entryMonth').value;
    });
    assert.strictEqual(selected, '2026-12');
    await context.close();
  });

  test('a planned expense is stored against a canonical period', async () => {
    const { page, context, requests } = await openAdmin();

    await page.evaluate(() => {
      switchTab('settings');
      document.getElementById('templateExpenseMonth').value = '2026-12';
      document.getElementById('templateExpenseName').value = 'Yillik soliq';
      document.getElementById('templateExpenseAmount').value = '750000';
      addTemplateExpense();
    });

    const save = await waitForRequest(requests, 'save_omad');
    const added = save.templateExpenses.find(e => e.name === 'Yillik soliq');
    assert.strictEqual(added.month, '2026-12');
    await context.close();
  });

  // ------------------------------------------------------- legacy tolerance

  test('legacy month-only data still renders while the migration is pending', async () => {
    const { page, context, pageErrors } = await openAdmin({
      ...REMOTE,
      // What the backend serves for an unmigrated sheet: the stored month is a
      // name, and the resolved period comes alongside it.
      transactions: [{
        ...tx('1_0', '2026-02'), month: 'Fevral', period: '2026-02', periodLabel: 'Fevral 2026'
      }],
      rates: { Fevral: { buy: 12000, sell: 12500 } }
    });

    const view = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-02';
      renderDashboard();
      return {
        income: document.getElementById('dash-income').innerText,
        history: document.getElementById('historyList').textContent,
        usd: toUZS(100, 'USD', '2026-02', 'sell')
      };
    });

    assert.strictEqual(view.income.replace(/\D/g, ''), '1000000');
    assert.ok(view.history.includes('Fevral 2026'));
    assert.strictEqual(view.usd, 1250000, 'a legacy month-name rate key still resolves');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });
});
