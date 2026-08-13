'use strict';

/**
 * Tenant debt must be calculated from the rent that actually applies in the
 * month being viewed, not from the tenant's default rent.
 *
 * The live failure this covers: O'quv Markaz pays 1,400 USD normally but was
 * given a 500 USD exception for August 2026 and paid exactly 500 USD. The
 * dashboard still billed 1,400 and reported ~10.7M UZS of debt, because the
 * frontend read `tenant.rent` directly while the backend used the schedule.
 *
 * Every figure a person can see - the badge on the card, the tenant modal, the
 * debtors list and the total - has to agree with that one effective rent.
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

// The live August 2026 rate, so the figures here are the live figures.
const RATES = {
  '2026-07': { buy: 12000, sell: 11920 },
  '2026-08': { buy: 12050, sell: 11930 },
  '2026-09': { buy: 12050, sell: 11930 }
};
const AUG = '2026-08';
const SELL = 11930;

/** The live O'quv Markaz record: 1,400 default, 500 for August only. */
const OQUV = {
  name: "O'quv Markaz", defaultRent: 1400, rent: 1400, currency: 'USD', active: true,
  startPeriod: '', endPeriod: '',
  rentChanges: [{ fromPeriod: '2026-08', amount: 500 }],
  exceptions: [{ period: '2026-08', amount: 500 }],
  noRentPeriods: [], disabledMonths: []
};

function payment(tenant, amount, currency = 'USD', period = AUG) {
  return {
    id: 'p_' + tenant + '_' + amount, month: period, period, tenant,
    type: 'Income', amount, currency, method: 'Naqd', status: 'Active',
    date: '05/08/2026', comment: 'Ijara', msgId: '', requestId: ''
  };
}

describe('Effective rent drives tenant debt (browser)', () => {
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

  async function openAdmin(transactions, tenants) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ transactions, tenants, rates: RATES, templateExpenses: [] })
        });
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } })
      });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    return { page, context, pageErrors };
  }

  /** The balance the app computes for one tenant in one period. */
  async function balanceOf(page, name, period = AUG) {
    return page.evaluate(([n, p]) => {
      const t = app.tenants.find(x => x.name === n);
      const b = calculateTenantBalance(countableTransactions(), t, p);
      return { effective: effectiveTenantRent(t, p), expected: b.expected, paid: b.paid, difference: b.difference };
    }, [name, period]);
  }

  // ------------------------------------------------- the exact live failure

  test('an August exception of 500 USD paid in full leaves no debt', async () => {
    const { page, context, pageErrors } = await openAdmin([payment("O'quv Markaz", 500)], [OQUV]);

    const b = await balanceOf(page, "O'quv Markaz");
    assert.strictEqual(b.effective, 500, 'the August exception applies');
    assert.strictEqual(b.expected, 500 * SELL, 'expected is billed at 500 USD, not 1,400');
    assert.strictEqual(b.paid, 500 * SELL);
    assert.strictEqual(b.difference, 0, 'paying the exception in full clears the month');

    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the tenant is absent from the debtors list and adds nothing to the total', async () => {
    const { page, context } = await openAdmin([payment("O'quv Markaz", 500)], [OQUV]);

    const view = await page.evaluate(period => {
      document.getElementById('dashMonthSelect').value = period;
      renderDashboard();
      openDebtListModal();
      return {
        totalDebt: document.getElementById('dash-total-debt').innerText,
        debtorList: document.getElementById('modalContent').innerText
      };
    }, AUG);

    assert.strictEqual(view.totalDebt, '0 UZS', 'the month has no debt at all');
    assert.match(view.debtorList, /Qarzdorlik mavjud emas/, 'nobody is listed as a debtor');
    await context.close();
  });

  test('the card badge, the modal and the calculation use the same effective rent', async () => {
    const { page, context } = await openAdmin([payment("O'quv Markaz", 500)], [OQUV]);

    const shown = await page.evaluate(period => {
      document.getElementById('dashMonthSelect').value = period;
      renderDashboard();
      const badge = document.querySelector('#tenantStatusList .bg-slate-100').innerText;
      document.querySelector('#tenantStatusList > div').onclick();
      return { badge, modalRent: document.getElementById('modalRent').innerText };
    }, AUG);

    assert.match(shown.badge, /Ijara: 500 USD/, 'the card badge shows the August rent');
    assert.match(shown.modalRent, /500 USD/, 'the modal shows the same rent');
    assert.ok(!/1400/.test(shown.badge + shown.modalRent), 'the default rent is never shown for August');
    await context.close();
  });

  // ------------------------------------------------------ the other rules

  test('a legacy disabled month owes nothing', async () => {
    // The live Dilyoraka record: August is a legacy disabled month.
    const dilyora = {
      name: 'Dilyoraka', defaultRent: 400, rent: 400, currency: 'USD', active: true,
      startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [],
      noRentPeriods: [], disabledMonths: ['Iyun', 'Iyul', 'Avgust']
    };
    const { page, context } = await openAdmin([], [dilyora]);

    const b = await balanceOf(page, 'Dilyoraka');
    assert.strictEqual(b.effective, 0);
    assert.strictEqual(b.expected, 0, 'a disabled month bills nothing');
    assert.strictEqual(b.difference, 0, 'and therefore cannot be a debt');
    await context.close();
  });

  test('a no-rent period owes nothing', async () => {
    const t = { ...OQUV, name: 'FreeMonth', exceptions: [], rentChanges: [], noRentPeriods: [AUG] };
    const { page, context } = await openAdmin([], [t]);

    const b = await balanceOf(page, 'FreeMonth');
    assert.strictEqual(b.expected, 0);
    assert.strictEqual(b.difference, 0);
    await context.close();
  });

  test('a tenant outside the agreement window owes nothing', async () => {
    const before = { ...OQUV, name: 'NotStarted', exceptions: [], rentChanges: [], startPeriod: '2026-09' };
    const after = { ...OQUV, name: 'Ended', exceptions: [], rentChanges: [], endPeriod: '2026-07' };
    const { page, context } = await openAdmin([], [before, after]);

    assert.strictEqual((await balanceOf(page, 'NotStarted')).expected, 0, 'before the start date');
    assert.strictEqual((await balanceOf(page, 'Ended')).expected, 0, 'after the end date');
    await context.close();
  });

  test('a future rent change does not rewrite earlier months', async () => {
    const t = {
      ...OQUV, name: 'Rising', exceptions: [],
      rentChanges: [{ fromPeriod: '2026-08', amount: 500 }]
    };
    const { page, context } = await openAdmin([], [t]);

    assert.strictEqual((await balanceOf(page, 'Rising', '2026-07')).effective, 1400, 'July keeps the old rent');
    assert.strictEqual((await balanceOf(page, 'Rising', AUG)).effective, 500, 'August takes the new one');
    await context.close();
  });

  test('an exception applies only to its own month', async () => {
    const { page, context } = await openAdmin([], [{ ...OQUV, name: 'OneOff', rentChanges: [] }]);

    assert.strictEqual((await balanceOf(page, 'OneOff', '2026-07')).effective, 1400);
    assert.strictEqual((await balanceOf(page, 'OneOff', AUG)).effective, 500);
    assert.strictEqual((await balanceOf(page, 'OneOff', '2026-09')).effective, 1400, 'September is back to normal');
    await context.close();
  });

  test('a UZS tenant is billed in UZS without conversion', async () => {
    const t = {
      name: 'UzsShop', defaultRent: 3000000, rent: 3000000, currency: 'UZS', active: true,
      startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [], noRentPeriods: [], disabledMonths: []
    };
    const { page, context } = await openAdmin([payment('UzsShop', 3000000, 'UZS')], [t]);

    const b = await balanceOf(page, 'UzsShop');
    assert.strictEqual(b.expected, 3000000);
    assert.strictEqual(b.difference, 0);
    await context.close();
  });

  test('an overpayment is still reported as an overpayment', async () => {
    const { page, context } = await openAdmin([payment("O'quv Markaz", 600)], [OQUV]);

    const b = await balanceOf(page, "O'quv Markaz");
    assert.strictEqual(b.difference, 100 * SELL, 'paying 600 against a 500 exception is 100 USD over');
    await context.close();
  });
});
