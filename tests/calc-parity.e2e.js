'use strict';

/**
 * Frontend/backend calculation parity.
 *
 * assets/omad/02b-calc.js and apps-script/05a_calculations.gs are two
 * implementations of the same rules. A number on screen is supposed to be the
 * number the server reports, so the two are run over identical inputs here and
 * compared field by field.
 *
 * They had drifted: the frontend billed `tenant.rent` instead of the
 * effective-dated schedule, and its projection matched planned expenses on a
 * stored month rather than on their recurrence.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript } = require('./gas-harness');

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
  '2026-07': { buy: 12000, sell: 11920 },
  '2026-08': { buy: 12050, sell: 11930 },
  '2026-09': { buy: 12100, sell: 12000 }
};
const PERIOD = '2026-08';

// A deliberately awkward set: two currencies, both methods, a cancelled row, a
// frozen ledger row, an exception, a scheduled change, a disabled month and a
// tenant whose agreement has ended.
const TENANTS = [
  {
    name: "O'quv Markaz", rent: 1400, defaultRent: 1400, currency: 'USD', active: true,
    startPeriod: '', endPeriod: '', rentChanges: [{ fromPeriod: '2026-08', amount: 500 }],
    exceptions: [{ period: '2026-08', amount: 500 }], noRentPeriods: [], disabledMonths: []
  },
  {
    name: 'Dilyoraka', rent: 400, defaultRent: 400, currency: 'USD', active: true,
    startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [],
    noRentPeriods: [], disabledMonths: ['Avgust']
  },
  {
    name: 'UzsShop', rent: 3000000, defaultRent: 3000000, currency: 'UZS', active: true,
    startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [],
    noRentPeriods: [], disabledMonths: []
  },
  {
    name: 'Ended', rent: 700, defaultRent: 700, currency: 'USD', active: true,
    startPeriod: '', endPeriod: '2026-07', rentChanges: [], exceptions: [],
    noRentPeriods: [], disabledMonths: []
  },
  {
    name: 'Mirzohidaka', rent: 110, defaultRent: 110, currency: 'USD', active: true,
    startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [],
    noRentPeriods: [], disabledMonths: []
  }
];

const TRANSACTIONS = [
  { id: 'a_0', month: PERIOD, period: PERIOD, tenant: "O'quv Markaz", type: 'Income', amount: 500, currency: 'USD', method: 'Naqd', status: 'Active' },
  { id: 'b_0', month: PERIOD, period: PERIOD, tenant: 'UzsShop', type: 'Income', amount: 3000000, currency: 'UZS', method: 'Bank', status: 'Active' },
  { id: 'c_0', month: PERIOD, period: PERIOD, tenant: 'Umumiy Naqd Puldan', type: 'Expense', amount: 1250000, currency: 'UZS', method: 'Naqd', status: 'Active' },
  { id: 'd_0', month: PERIOD, period: PERIOD, tenant: 'Umumiy Bankdan', type: 'Expense', amount: 100, currency: 'USD', method: 'Bank', status: 'Active' },
  // Cancelled and corrected rows are history, not money - both sides must skip them.
  { id: 'e_0', month: PERIOD, period: PERIOD, tenant: "O'quv Markaz", type: 'Income', amount: 999, currency: 'USD', method: 'Naqd', status: 'Cancelled' },
  { id: 'f_0', month: PERIOD, period: PERIOD, tenant: 'UzsShop', type: 'Income', amount: 777777, currency: 'UZS', method: 'Naqd', status: 'Corrected' },
  // A ledger row with its value frozen: neither side may re-convert it.
  { id: 'g_0', month: PERIOD, period: PERIOD, tenant: 'Mirzohidaka', type: 'Income', amount: 100, currency: 'USD', method: 'Naqd', status: 'Active', amountUZS: 1111111 },
  // A different month, to prove period scoping matches.
  { id: 'h_0', month: '2026-07', period: '2026-07', tenant: "O'quv Markaz", type: 'Income', amount: 1400, currency: 'USD', method: 'Naqd', status: 'Active' }
];

const PLANNED = [
  { id: 'pe1', name: 'Oylik internet', amount: 300000, currency: 'UZS', frequency: 'monthly', startPeriod: '2026-01', selectedMonths: [], ending: { type: 'never' } },
  { id: 'pe2', name: 'Bir martalik', amount: 90, currency: 'USD', frequency: 'once', startPeriod: PERIOD, selectedMonths: [], ending: { type: 'never' } },
  { id: 'pe3', name: 'Boshqa oy', amount: 5000000, currency: 'UZS', frequency: 'once', startPeriod: '2026-09', selectedMonths: [], ending: { type: 'never' } }
];

/**
 * The backend runs inside a VM realm, so its objects carry that realm's
 * prototype and deepStrictEqual would reject them on identity alone. Comparing
 * the data is the point here, so both sides are reduced to plain values.
 */
const plain = value => JSON.parse(JSON.stringify(value));

function backendResults() {
  const gas = loadScript({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Tenants', JSON.stringify(TENANTS)]
      ]
    }
  });

  const perTenant = {};
  TENANTS.forEach(t => {
    const b = gas.calculateTenantBalance_(TRANSACTIONS, t, PERIOD);
    perTenant[t.name] = {
      effective: gas.effectiveTenantRent_(t, PERIOD),
      expected: b.expected,
      paid: b.paid,
      difference: b.difference
    };
  });

  return plain({
    actuals: gas.calculateActuals_(TRANSACTIONS, PERIOD),
    countable: TRANSACTIONS.filter(t => gas.isCountableTransaction_(t)).map(t => t.id),
    frozenValue: gas.transactionUZS_(TRANSACTIONS.find(t => t.id === 'g_0')),
    liveValue: gas.transactionUZS_(TRANSACTIONS.find(t => t.id === 'a_0')),
    perTenant,
    projection: gas.calculateProjection_(TENANTS, PLANNED, PERIOD)
  });
}

describe('Frontend/backend calculation parity', () => {
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

  async function frontendResults() {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    });
    await context.route('**script.google.com/**', async route => {
      if (isOmadRead(route.request())) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ transactions: TRANSACTIONS, tenants: TENANTS, rates: RATES, templateExpenses: PLANNED })
        });
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } })
      });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);

    const result = await page.evaluate(period => {
      const perTenant = {};
      app.tenants.forEach(t => {
        const b = calculateTenantBalance(countableTransactions(), t, period);
        perTenant[t.name] = {
          effective: effectiveTenantRent(t, period),
          expected: b.expected, paid: b.paid, difference: b.difference
        };
      });
      return {
        actuals: calculateActuals(app.transactions, period),
        countable: countableTransactions().map(t => t.id),
        frozenValue: transactionUZS(app.transactions.find(t => t.id === 'g_0')),
        liveValue: transactionUZS(app.transactions.find(t => t.id === 'a_0')),
        perTenant,
        projection: calculateProjection(app.tenants, app.templateExpenses, period)
      };
    }, PERIOD);

    await context.close();
    return { result, errors };
  }

  test('both implementations agree on every figure', async () => {
    const backend = backendResults();
    const { result: frontend, errors } = await frontendResults();

    assert.deepStrictEqual(errors, [], 'the page must load without errors');

    assert.deepStrictEqual(frontend.countable, backend.countable,
      'cancelled and corrected rows are excluded identically');
    assert.strictEqual(frontend.frozenValue, backend.frozenValue,
      'a frozen ledger value is never re-converted');
    assert.strictEqual(frontend.liveValue, backend.liveValue,
      'a legacy row converts at the same sell rate');
    assert.deepStrictEqual(frontend.actuals, backend.actuals,
      'income, expense, net, cash, bank and total all agree');
    assert.deepStrictEqual(frontend.perTenant, backend.perTenant,
      'effective rent, expected, paid and difference agree for every tenant');
    assert.deepStrictEqual(frontend.projection, backend.projection,
      'expected income and planned expenses agree');
  });

  test('the parity fixture actually exercises the rules it claims to', async () => {
    const backend = backendResults();

    // Guards: if these stop holding the comparison above proves much less.
    assert.strictEqual(backend.perTenant["O'quv Markaz"].effective, 500, 'exception applied');
    assert.strictEqual(backend.perTenant["O'quv Markaz"].difference, 0, 'exception paid in full');
    assert.strictEqual(backend.perTenant.Dilyoraka.expected, 0, 'disabled month bills nothing');
    assert.strictEqual(backend.perTenant.Ended.expected, 0, 'ended agreement bills nothing');
    assert.strictEqual(backend.perTenant.Mirzohidaka.paid, 1111111, 'frozen value used as-is');
    assert.ok(!backend.countable.includes('e_0'), 'cancelled row skipped');
    assert.ok(!backend.countable.includes('f_0'), 'corrected row skipped');
    // A monthly recurring expense must be due even though its stored month is January.
    assert.ok(backend.projection.plannedExpense > 300000, 'recurring expense counted');
  });
});
