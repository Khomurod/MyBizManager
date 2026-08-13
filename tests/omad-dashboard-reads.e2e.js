'use strict';

/**
 * What the Omad admin screen actually downloads, in a real browser.
 *
 * The dashboard used to be handed the whole transaction history on every load
 * and derive four figures from it. It now asks for the server's materialised
 * summary and fetches history a page at a time when Tarix is opened.
 *
 * Three things have to stay true, and none of them is visible in a unit test:
 *
 *   1. The first load asks for the summary and never for the ledger.
 *   2. The figures on screen are the summary's figures, and switching months
 *      does not go back to the server.
 *   3. A failed or throttled read still leaves the screen exactly as it was —
 *      the café incident's rule, applied to the new request.
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

const RATES = { '2026-07': { buy: 12000, sell: 12500 }, '2026-08': { buy: 12100, sell: 12600 } };
const TENANTS = [{
  name: 'Apteka', rent: 1000000, defaultRent: 1000000, currency: 'UZS', active: true,
  startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [], noRentPeriods: [], disabledMonths: []
}];

const SUMMARY = {
  builtAt: '2026-08-13T09:00:00.000Z',
  rows: 42,
  balances: { cash: 5000000, bank: 3000000, total: 8000000 },
  periods: {
    '2026-07': { income: 900000, expense: 100000, net: 800000, paid: { Apteka: 900000 }, groups: 3 },
    '2026-08': { income: 1500000, expense: 250000, net: 1250000, paid: { Apteka: 1500000 }, groups: 5 }
  },
  periodList: ['2026-07', '2026-08']
};

const RECENT = [{
  groupId: 'grp_9', id: '1750000000900_0', kind: '', type: 'Income', tenant: 'Apteka',
  period: '2026-08', periodLabel: 'Avgust 2026', date: '12.08.2026',
  amountUZS: 1500000, currency: 'UZS', amount: 1500000, lines: 1, comment: 'ijara'
}];

/** One page of history: two business actions, four rows, and one more page. */
function historyPage(offset) {
  const rows = [];
  const start = offset;
  for (let g = start; g < Math.min(start + 2, 5); g++) {
    rows.push({
      id: `175000000${900 - g}_0`, groupId: `grp_${g}`, tenant: 'Apteka', period: '2026-08',
      periodLabel: 'Avgust 2026', type: 'Income', amount: 100000 + g, currency: 'UZS',
      method: 'Naqd', date: '12.08.2026', comment: '', status: 'Active', entryKind: '', msgId: ''
    });
  }
  return {
    status: 'success', period: '', offset, limit: 2, groupTotal: 5,
    groupCount: rows.length, hasMore: offset + rows.length < 5, transactions: rows
  };
}

describe('The Omad dashboard reads figures, not the ledger', () => {
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

  /**
   * Opens the admin screen against a stub backend.
   * `overrides` maps an action name to a body (or a function returning one).
   */
  async function openAdmin(overrides = {}, options = {}) {
    const seen = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_user', 'omad_admin');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    });

    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (error) { payload = {}; }
      seen.push(payload);

      const override = overrides[payload.action];
      if (override) {
        const body = typeof override === 'function' ? override(payload, seen) : override;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        return;
      }

      if (payload.action === 'get_omad_data') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            status: 'success', scope: 'dashboard', historyMode: 'paged',
            tenants: TENANTS, rates: RATES, templateExpenses: [],
            migration: { state: 'cutover', activeSheet: 'Omad_Transactions_V2' },
            summary: SUMMARY, recent: RECENT
          })
        });
        return;
      }
      if (payload.action === 'get_omad_history') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(historyPage(Number(payload.offset) || 0))
        });
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'success' })
      });
    });

    const page = await context.newPage();
    await page.goto(`${baseUrl}/omad_admin.html`);
    // Not waited for when the answer is a refusal: the page leaves for the
    // login screen, where `app` does not exist.
    if (options.expectSignOut !== true) {
      await page.waitForFunction(() => app.migration !== null);
    }
    return { page, context, seen };
  }

  test('the first load asks for the summary and downloads no transactions', async () => {
    const { page, context, seen } = await openAdmin();

    const read = seen.find(p => p.action === 'get_omad_data');
    assert.ok(read, 'the dashboard read happened');
    assert.strictEqual(read.scope, 'dashboard', 'and it asked for the figures');

    assert.strictEqual(await page.evaluate(() => app.transactions.length), 0,
      'no ledger rows are held');
    assert.strictEqual(await page.evaluate(() => app.historyMode), 'paged');
    assert.ok(!seen.some(p => p.action === 'get_omad_history'),
      'and history is not fetched until somebody opens Tarix');

    await context.close();
  });

  test('the figures on screen are the summary the server sent', async () => {
    const { page, context } = await openAdmin();

    await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-08';
      renderDashboard();
    });

    assert.strictEqual(await page.textContent('#dash-income'), (1500000).toLocaleString());
    assert.strictEqual(await page.textContent('#dash-expense'), (250000).toLocaleString());
    assert.strictEqual(await page.textContent('#dash-cash-total'), (5000000).toLocaleString());
    assert.strictEqual(await page.textContent('#dash-bank'), (3000000).toLocaleString());

    await context.close();
  });

  test('switching months repaints from the summary without a round trip', async () => {
    const { page, context, seen } = await openAdmin();
    const before = seen.length;

    await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-07';
      renderDashboard();
    });

    assert.strictEqual(await page.textContent('#dash-income'), (900000).toLocaleString());
    assert.strictEqual(seen.length, before, 'no request was made to change the month');

    await context.close();
  });

  test("the tenant's debt is the summary's paid total against the stored rent", async () => {
    const { page, context } = await openAdmin();

    const debt = await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-07';
      renderDashboard();
      return document.getElementById('dash-total-debt').textContent;
    });
    // Rent 1 000 000 UZS, paid 900 000 -> 100 000 owed.
    assert.strictEqual(debt, `${(100000).toLocaleString()} UZS`);

    await context.close();
  });

  test('the recent list shows the business actions that arrived with the dashboard', async () => {
    const { page, context } = await openAdmin();
    assert.ok(await page.isVisible('#recentCard'), 'the card is shown');
    const text = await page.textContent('#recentList');
    assert.match(text, /Apteka/);
    assert.match(text, /1[\s ,]?500[\s ,]?000/);
    await context.close();
  });

  test('opening Tarix fetches the first page, and the button fetches the next', async () => {
    const { page, context, seen } = await openAdmin();

    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => app.historyLoaded === true);

    const first = seen.filter(p => p.action === 'get_omad_history');
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].offset, 0);
    assert.strictEqual(await page.evaluate(() => app.transactions.length), 2);
    assert.strictEqual(await page.evaluate(() => app.historyHasMore), true);

    await page.evaluate(() => loadHistoryPage(false));
    await page.waitForFunction(() => app.historyOffset === 4);

    const pages = seen.filter(p => p.action === 'get_omad_history');
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages[1].offset, 2);
    assert.strictEqual(await page.evaluate(() => app.transactions.length), 4,
      'the second page is appended, not swapped in');

    await context.close();
  });

  test('a repeated page cannot show the same entry twice', async () => {
    const { page, context } = await openAdmin({
      get_omad_history: () => historyPage(0)      // always answers page one
    });

    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => app.historyLoaded === true);
    await page.evaluate(() => loadHistoryPage(false));
    await page.waitForFunction(() => app.historyLoading === false);

    const ids = await page.evaluate(() => app.transactions.map(t => t.id));
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicated rows');

    await context.close();
  });

  test('a throttled history read keeps what is on screen and does not sign out', async () => {
    let calls = 0;
    const { page, context } = await openAdmin({
      get_omad_history: () => {
        calls++;
        if (calls === 1) return historyPage(0);
        return { status: 'error', code: 'throttled', authExpired: false, message: "Juda ko'p so'rov" };
      }
    });

    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => app.historyLoaded === true);
    await page.evaluate(() => loadHistoryPage(false));
    await page.waitForFunction(() => app.historyError !== '');

    assert.strictEqual(await page.evaluate(() => app.transactions.length), 2,
      'the loaded page survives the refusal');
    assert.match(page.url(), /omad_admin\.html/, 'and nobody is sent to the login page');
    assert.match(await page.textContent('#historyList'), /Qayta urinish/);

    await context.close();
  });

  test('a failed dashboard read leaves the previous figures alone', async () => {
    let calls = 0;
    const { page, context } = await openAdmin({
      get_omad_data: () => {
        calls++;
        if (calls === 1) {
          return {
            status: 'success', scope: 'dashboard', historyMode: 'paged',
            tenants: TENANTS, rates: RATES, templateExpenses: [],
            migration: { state: 'cutover', activeSheet: 'Omad_Transactions_V2' },
            summary: SUMMARY, recent: RECENT
          };
        }
        return { status: 'error', code: 'throttled', authExpired: false, message: "Juda ko'p so'rov" };
      }
    });

    await page.evaluate(() => {
      document.getElementById('dashMonthSelect').value = '2026-08';
      renderDashboard();
    });
    await page.evaluate(() => syncData());
    await page.waitForFunction(() => app.loadError !== '');

    assert.strictEqual(await page.textContent('#dash-income'), (1500000).toLocaleString(),
      'the figures are still the last true ones');
    assert.match(page.url(), /omad_admin\.html/);
    assert.ok(await page.isVisible('#syncBanner'), 'and the banner says the refresh failed');

    await context.close();
  });

  test('an expired session — and only that — returns to the login page', async () => {
    const { page, context } = await openAdmin({
      get_omad_data: () => ({ status: 'error', authExpired: true, message: 'Sessiya tugadi.' })
    }, { expectSignOut: true });
    await page.waitForURL(/login\.html/, { timeout: 15000 });
    await context.close();
  });

  test('a pre-cutover backend still gets the whole list, and saves it back', async () => {
    const rows = [{
      id: '1750000000900_0', groupId: 'grp_1', tenant: 'Apteka', month: '2026-08',
      period: '2026-08', type: 'Income', amount: 500000, currency: 'UZS', method: 'Naqd',
      date: '12/08/2026', comment: '', msgId: '', entryKind: ''
    }];
    const { page, context, seen } = await openAdmin({
      get_omad_data: () => ({
        status: 'success', scope: 'dashboard', historyMode: 'full',
        transactions: rows, tenants: TENANTS, rates: RATES, templateExpenses: [],
        migration: { state: 'not_started', activeSheet: 'Omad_Transactions' }
      })
    });

    assert.strictEqual(await page.evaluate(() => app.historyMode), 'full');
    assert.strictEqual(await page.evaluate(() => app.transactions.length), 1);

    await page.evaluate(() => saveCloud());
    const save = seen.find(p => p.action === 'save_omad');
    assert.ok(save, 'the settings save happened');
    assert.ok(Array.isArray(save.transactions) && save.transactions.length === 1,
      'and it still carries the whole list the legacy sheet is rewritten from');

    await context.close();
  });

  test('an edit corrects its own rows even after the page they came from is gone', async () => {
    // The entry form used to look its rows up in `app.transactions` at submit
    // time. Since history is paged, a refresh empties that list -- and an edit
    // that cannot find its own rows stops *correcting* them and starts
    // *creating* new ones, which is the entry recorded twice. The form holds
    // what it is editing.
    const { page, context, seen } = await openAdmin();

    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => app.historyLoaded === true);

    const firstId = await page.evaluate(() => app.transactions[0].id);
    await page.evaluate(id => editTx(id), firstId);

    // Whatever emptied it -- a background refresh, a settings save -- the edit
    // in front of the operator must still be an edit.
    await page.evaluate(() => { app.transactions = []; });
    await page.evaluate(() => submitAll());

    const writes = seen.filter(p =>
      p.action === 'correct_transaction' || p.action === 'create_transaction');
    assert.ok(writes.length > 0, 'the save happened');
    assert.strictEqual(writes[0].action, 'correct_transaction',
      'it corrected the row it was editing rather than creating a second one');
    assert.strictEqual(writes[0].transactionId, firstId);

    await context.close();
  });

  test('a paged screen never submits a page of history as the whole list', async () => {
    const { page, context, seen } = await openAdmin();

    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => app.historyLoaded === true);
    await page.evaluate(() => saveCloud());

    const save = seen.find(p => p.action === 'save_omad');
    assert.ok(save, 'the settings save happened');
    assert.strictEqual(save.transactions, undefined,
      'the list is omitted rather than sent short — sending it would delete the rest');

    await context.close();
  });
});
