'use strict';

/**
 * The frontend calculation module against the same expectations as the
 * backend's. Both sides must produce identical figures — a number on screen is
 * the number the server reports.
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

/**
 * The Omad read, whichever route it arrives on.
 *
 * The app now fetches over an authenticated POST (`get_omad_data`) rather than
 * the anonymous GET, because a GET puts its parameters in the URL and that is
 * where an access key must never be.
 */
function isOmadRead(request) {
  if (request.method() === 'GET') return true;
  try { return JSON.parse(request.postData() || '{}').action === 'get_omad_data'; }
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

const RATES = {
  '2026-01': { buy: 12000, sell: 12500 },
  '2027-01': { buy: 13000, sell: 13500 }
};

/** A ledger transaction with its rates frozen. */
function frozen(overrides = {}) {
  return {
    id: 'x_0', period: '2026-01', month: '2026-01', tenant: 'Tehnopark',
    type: 'Income', amount: 1000000, currency: 'UZS', method: 'Naqd',
    status: 'Active', rateBuy: 12000, rateSell: 12500, rateUsed: 1,
    rateType: 'none', amountUZS: 1000000, date: '05/01/2026', comment: '',
    ...overrides
  };
}

describe('Omad admin calculations (browser)', () => {
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

  async function openAdmin(transactions, tenants = [], templateExpenses = []) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    });
    await context.route('**script.google.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isOmadRead(route.request())
        ? { transactions, tenants, rates: RATES, templateExpenses }
        : { status: 'success', migration: { state: 'cutover', activeSheet: 'Omad_Transactions_V2' } })
    }));

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    return { page, context, pageErrors };
  }

  test('a stored transaction keeps its value when the rate is changed', async () => {
    const { page, context } = await openAdmin([
      frozen({ currency: 'USD', amount: 100, rateUsed: 12500, rateType: 'sell', amountUZS: 1250000 })
    ]);

    const values = await page.evaluate(() => {
      const before = transactionUZS(app.transactions[0]);
      app.rates['2026-01'] = { buy: 20000, sell: 21000 };
      return { before, after: transactionUZS(app.transactions[0]) };
    });

    assert.strictEqual(values.before, 1250000);
    assert.strictEqual(values.after, 1250000, 'the recorded value must not move');
    await context.close();
  });

  test('a legacy row with no frozen value converts live at the sell rate', async () => {
    const { page, context } = await openAdmin([
      { id: '1_0', period: '2026-01', month: '2026-01', tenant: 'T', type: 'Income',
        amount: 100, currency: 'USD', method: 'Naqd', date: '05/01/2026', comment: '' }
    ]);

    const value = await page.evaluate(() => transactionUZS(app.transactions[0]));
    assert.strictEqual(value, 1250000);
    await context.close();
  });

  test('income is scoped to the period while balances stay all-time', async () => {
    const { page, context } = await openAdmin([
      frozen({ period: '2026-01', amountUZS: 1000000, method: 'Naqd' }),
      frozen({ period: '2027-01', amountUZS: 2000000, method: 'Bank' }),
      frozen({ period: '2027-01', type: 'Expense', amountUZS: 500000, method: 'Naqd' })
    ]);

    const shown = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return {
        income: document.getElementById('dash-income').innerText,
        expense: document.getElementById('dash-expense').innerText,
        cash: document.getElementById('dash-cash-total').innerText,
        bank: document.getElementById('dash-bank').innerText
      };
    });

    assert.strictEqual(shown.income.replace(/\D/g, ''), '1000000');
    assert.strictEqual(shown.expense.replace(/\D/g, ''), '0');
    assert.strictEqual(shown.cash.replace(/[^\d-]/g, ''), '500000');
    assert.strictEqual(shown.bank.replace(/\D/g, ''), '2000000');
    await context.close();
  });

  test('cancelled records disappear from every figure', async () => {
    const { page, context } = await openAdmin([
      frozen({ id: 'a_0', amountUZS: 1000000 }),
      frozen({ id: 'b_0', amountUZS: 5000000, status: 'Cancelled' })
    ]);

    const shown = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return document.getElementById('dash-income').innerText;
    });
    assert.strictEqual(shown.replace(/\D/g, ''), '1000000');
    await context.close();
  });

  test('paying exactly the rent shows no debt', async () => {
    const { page, context } = await openAdmin(
      [frozen({ tenant: 'Tehnopark', currency: 'USD', amount: 500, rateUsed: 12500, rateType: 'sell', amountUZS: 6250000 })],
      [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }]
    );

    const status = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return {
        list: document.getElementById('tenantStatusList').textContent,
        totalDebt: document.getElementById('dash-total-debt').innerText,
        balance: calculateTenantBalance(countableTransactions(),
          { name: 'Tehnopark', rent: 500, currency: 'USD' }, '2026-01')
      };
    });

    assert.strictEqual(status.balance.expected, 6250000);
    assert.strictEqual(status.balance.paid, 6250000);
    assert.strictEqual(status.balance.difference, 0);
    assert.ok(status.list.includes("To'landi"), status.list);
    assert.strictEqual(status.totalDebt.replace(/\D/g, ''), '0');
    await context.close();
  });

  test('a partial payment is reported as debt', async () => {
    const { page, context } = await openAdmin(
      [frozen({ tenant: 'Tehnopark', currency: 'USD', amount: 300, rateUsed: 12500, rateType: 'sell', amountUZS: 3750000 })],
      [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }]
    );

    const debt = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return document.getElementById('dash-total-debt').innerText;
    });
    assert.strictEqual(debt.replace(/\D/g, ''), '2500000');
    await context.close();
  });

  test('the projection uses the sell rate and stays separate from actuals', async () => {
    const { page, context } = await openAdmin(
      [frozen({ tenant: 'Tehnopark', amountUZS: 400000 })],
      [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
      [{ id: 'e1', month: '2026-01', name: 'Soliq', amount: 200, currency: 'USD' }]
    );

    const shown = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return {
        income: document.getElementById('projection-income').innerText,
        expense: document.getElementById('projection-expense').innerText,
        net: document.getElementById('projection-net').innerText,
        actualIncome: document.getElementById('dash-income').innerText
      };
    });

    assert.strictEqual(shown.income.replace(/\D/g, ''), '6250000', '500 USD at sell 12 500');
    assert.strictEqual(shown.expense.replace(/\D/g, ''), '2500000', '200 USD at sell 12 500');
    assert.strictEqual(shown.net.replace(/\D/g, ''), '3750000');
    assert.strictEqual(shown.actualIncome.replace(/\D/g, ''), '400000',
      'the projection never absorbs the actual');
    await context.close();
  });

  test('the tenant modal shows the rate each payment actually used', async () => {
    const { page, context } = await openAdmin(
      [frozen({ tenant: 'Tehnopark', currency: 'USD', amount: 100, rateUsed: 11111, rateType: 'sell', amountUZS: 1111100 })],
      [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }]
    );

    const detail = await page.evaluate(() => {
      openTenantModal('Tehnopark', '2026-01', 500, 'USD', { buy: 12000, sell: 12500 });
      return document.getElementById('modalContent').textContent;
    });

    assert.ok(detail.includes('11,111'), 'the stored rate, not the current one');
    assert.ok(detail.includes('1,111,100'));
    await context.close();
  });

  test('the same rent costs more in a period with a higher rate', async () => {
    const { page, context } = await openAdmin([],
      [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }]);

    const expected = await page.evaluate(() => ({
      y2026: tenantExpectedRentUZS({ rent: 500, currency: 'USD' }, '2026-01'),
      y2027: tenantExpectedRentUZS({ rent: 500, currency: 'USD' }, '2027-01')
    }));

    assert.strictEqual(expected.y2026, 6250000);
    assert.strictEqual(expected.y2027, 6750000);
    await context.close();
  });

  test('the header shows both rates but calculations use sell', async () => {
    const { page, context, pageErrors } = await openAdmin([]);

    const header = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-01';
      renderDashboard();
      return { text: document.getElementById('headerRate').innerText, actualRule: RATE_TYPE_ACTUAL };
    });

    assert.ok(header.text.includes('12,000'), 'buy is shown for information');
    assert.ok(header.text.includes('12,500'));
    assert.strictEqual(header.actualRule, 'sell');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });
});
