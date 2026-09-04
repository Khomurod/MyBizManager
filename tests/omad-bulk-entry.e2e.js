'use strict';

/**
 * The Ommaviy tab, driven in a real browser against the real backend.
 *
 * Asserting that the API can record many entries proves nothing about whether
 * anyone can reach it. These tests open `omad_admin.html` in Chromium, press the
 * buttons a person would press, and then read the rows the Apps Script backend
 * actually stored in `Omad_Transactions_V2` — so a screen that renders and
 * submits nothing, or submits something other than what is on it, fails here.
 *
 * The backend is `script.gs` running in the test harness, not a stub: the same
 * validation, the same idempotency, the same append. Only the transport between
 * them is bridged.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript, readJsonOutput, postEvent, currentPeriodKey } = require('./gas-harness');

const ROOT = path.join(__dirname, '..');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  chromium = null;
}

const describe = chromium ? test.describe : test.describe.skip;

const ADMIN_KEY = 'omad-bulk-e2e-key';

// The period must be one `periodOptions` offers, and that list is derived from
// the clock. A literal month is a fixture with an expiry date on it.
const PERIOD = currentPeriodKey();
const PREVIOUS = (() => {
  const [y, m] = PERIOD.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

const TENANTS = [
  { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
  { name: 'Salon', defaultRent: 800000, currency: 'UZS', active: true },
  { name: 'Tehnopark', defaultRent: 500, currency: 'USD', active: true }
];

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

function bootBackend(seedRows) {
  const rates = {};
  rates[PERIOD] = { buy: 12000, sell: 12500 };
  rates[PREVIOUS] = { buy: 11000, sell: 11500 };

  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(rates)],
        ['Omad_Tenants', JSON.stringify(TENANTS)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER].concat(seedRows || [])
    }
  });
}

/** Every stored ledger row as a named object. */
function storedRows(backend) {
  return backend.__spreadsheet.getSheetByName('Omad_Transactions_V2')
    .getDataRange().getValues().slice(1).filter(r => r[0])
    .map(r => {
      const out = {};
      LEDGER_HEADER.forEach((name, i) => { out[name] = r[i]; });
      return out;
    });
}

describe('Ommaviy kiritish, in a browser against the real backend', () => {
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
   * Opens the admin with the backend wired in.
   *
   * `hold` keeps every `create_transaction_bulk` request in the air until the
   * test releases it, which is where the frozen-snapshot rules are tested.
   */
  async function openAdmin(options = {}) {
    const backend = options.backend || bootBackend(options.seedRows);
    const submitted = [];
    const waiting = [];
    const context = await browser.newContext({ viewport: { width: 414, height: 896 } });

    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      localStorage.setItem('omad_user', 'tester');
    });

    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }

      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      // The session token the page holds is not one this backend issued, so the
      // break-glass admin key stands in for a signed-in owner.
      const answered = () => readJsonOutput(backend.doPost(postEvent(
        Object.assign({}, payload, { sessionToken: undefined, adminKey: ADMIN_KEY }))));

      if (payload.action === 'create_transaction_bulk') {
        submitted.push(payload);
        if (options.hold) {
          await new Promise(resolve => waiting.push(async () => {
            await route.fulfill({
              status: 200, contentType: 'application/json', body: JSON.stringify(answered())
            });
            resolve();
          }));
          return;
        }
      }

      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(answered())
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    // `app` is a top-level `const`, so it is a lexical global rather than a
    // property of `window` -- a bare identifier is how the other suites read it.
    await page.waitForFunction(() => Array.isArray(app.tenants) && app.tenants.length > 0);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });

    await page.click('#nav-bulk');
    await page.waitForSelector('#tab-bulk.active');
    await page.selectOption('#bulkMonth', PERIOD);

    async function release() {
      while (!waiting.length) await page.waitForTimeout(20);
      await waiting.shift()();
    }
    async function issued(count) {
      const deadline = Date.now() + 5000;
      while (submitted.length < count && Date.now() < deadline) await page.waitForTimeout(20);
      return submitted.length;
    }
    return { page, context, backend, submitted, pageErrors, release, issued };
  }

  /** Waits until the grid holds this many rows. */
  async function rowCount(page) {
    return page.evaluate(() => document.querySelectorAll('.bulk-row').length);
  }

  /** Fills row `index` by hand, the way a person types into it. */
  async function fillRow(page, index, values) {
    const rows = await page.$$('.bulk-row');
    const row = rows[index];
    if (values.kind) {
      await row.$eval('.bulk-kind', (el, v) => {
        el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
      }, values.kind);
    }
    if (values.tenant) await row.$eval('.bulk-tenant', (el, v) => { el.value = v; }, values.tenant);
    if (values.period) await row.$eval('.bulk-period', (el, v) => { el.value = v; }, values.period);
    if (values.amount !== undefined) {
      await row.$eval('.bulk-amount', (el, v) => {
        el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(values.amount));
    }
    if (values.currency) await row.$eval('.bulk-currency', (el, v) => { el.value = v; }, values.currency);
    if (values.method) await row.$eval('.bulk-method', (el, v) => { el.value = v; }, values.method);
    if (values.comment !== undefined) {
      await row.$eval('.bulk-comment', (el, v) => { el.value = v; }, values.comment);
    }
  }

  async function save(page) {
    await page.click('#bulkSubmitBtn');
  }

  async function saveAndSettle(page) {
    await save(page);
    await page.waitForFunction(() => !bulkSaveInFlight);
  }

  // ------------------------------------------------------ the screen exists

  test('the tab is reachable and starts empty', async () => {
    const { page, context, pageErrors } = await openAdmin();

    assert.strictEqual(await page.isVisible('#tab-bulk'), true);
    assert.strictEqual(await rowCount(page), 0);
    assert.strictEqual(await page.isVisible('#bulkEmpty'), true);
    assert.strictEqual(await page.isDisabled('#bulkSubmitBtn'), true, 'nothing to save yet');

    // The fifth nav button did not push the others off the bar.
    const bar = await page.$eval('#nav-bulk', el => el.getBoundingClientRect());
    assert.ok(bar.width > 0 && bar.right <= 414, 'the nav still fits a phone');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  // ------------------------------------------------------------- prefilling

  test('the roster fills a row per tenant who still owes, and only those', async () => {
    const { page, context, pageErrors } = await openAdmin();
    await page.click('#bulkFillRoster');

    const rows = await page.$$eval('.bulk-row', list => list.map(row => ({
      kind: row.querySelector('.bulk-kind').value,
      tenant: row.querySelector('.bulk-tenant').value,
      period: row.querySelector('.bulk-period').value,
      amount: row.querySelector('.bulk-amount').value,
      currency: row.querySelector('.bulk-currency').value
    })));

    assert.strictEqual(rows.length, 3, 'nobody has paid yet, so all three owe');
    assert.deepStrictEqual(rows.map(r => r.tenant).sort(), ['Apteka', 'Salon', 'Tehnopark']);
    assert.ok(rows.every(r => r.kind === 'income' && r.period === PERIOD));

    // A tenant who has paid nothing is filled with their rent in their own
    // currency, straight off the schedule — no conversion, nothing rounded.
    const usd = rows.find(r => r.tenant === 'Tehnopark');
    assert.strictEqual(usd.currency, 'USD');
    assert.strictEqual(usd.amount.replace(/\s/g, ''), '500');

    // Pressing it twice does not double the grid.
    await page.click('#bulkFillRoster');
    assert.strictEqual(await rowCount(page), 3);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a tenant who has already paid is not offered again', async () => {
    const { page, context } = await openAdmin();

    // Pay Apteka in full through the bulk screen itself, then refill.
    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'ijara' });
    await saveAndSettle(page);

    // The screen refreshes out of band after a save, so the roster is read from
    // whatever the last answer said. Waiting for one here makes the assertion
    // about the prefill rather than about the timing of a background request.
    await page.evaluate(() => syncData());
    await page.click('#bulkFillRoster');
    const tenants = await page.$$eval('.bulk-row', list =>
      list.map(row => row.querySelector('.bulk-tenant').value));
    assert.ok(!tenants.includes('Apteka'), 'Apteka is settled and is not offered');
    assert.deepStrictEqual(tenants.sort(), ['Salon', 'Tehnopark']);
    await context.close();
  });

  // ------------------------------------------------------------ what is saved

  test('a mixed grid is stored as the rows it describes', async () => {
    const { page, context, backend, pageErrors } = await openAdmin();

    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, method: 'Naqd', comment: 'Ijara' });
    await page.click('#bulkAddRow');
    await fillRow(page, 1, { kind: 'expense', tenant: 'Umumiy Bankdan', period: PERIOD, amount: 250000, method: 'Bank', comment: 'Internet' });
    await page.click('#bulkAddRow');
    await fillRow(page, 2, { kind: 'tenant_paid', tenant: 'Salon', period: PERIOD, amount: 300000, method: 'Naqd', comment: 'Elektrik' });

    await saveAndSettle(page);

    const stored = storedRows(backend);
    assert.strictEqual(stored.length, 4, 'three entries, four rows — the pair is two');

    const income = stored.find(r => r.Tenant === 'Apteka');
    assert.strictEqual(Number(income.Amount), 1000000);
    assert.strictEqual(income.Type, 'Income');
    assert.strictEqual(income.Comment, 'Ijara');

    const expense = stored.find(r => r.Tenant === 'Umumiy Bankdan');
    assert.strictEqual(expense.Type, 'Expense');
    assert.strictEqual(expense.Method, 'Bank');

    // Each entry is its own group, and the pair's two rows share one.
    const groups = stored.map(r => r.Entry_Group_ID);
    assert.strictEqual(new Set(groups).size, 3);

    // The grid is cleared only because the save succeeded.
    assert.strictEqual(await rowCount(page), 0);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a row edited after prefilling is what gets written', async () => {
    const { page, context, backend } = await openAdmin();
    await page.click('#bulkFillRoster');

    // A part payment: the person types over the prefilled rent.
    const rows = await page.$$eval('.bulk-row', list =>
      list.map(row => row.querySelector('.bulk-tenant').value));
    const index = rows.indexOf('Salon');
    await fillRow(page, index, { amount: 300000, method: 'Bank', comment: 'Qisman' });

    await saveAndSettle(page);

    const salon = storedRows(backend).find(r => r.Tenant === 'Salon');
    assert.strictEqual(Number(salon.Amount), 300000, 'the typed amount, not the prefilled one');
    assert.strictEqual(salon.Method, 'Bank');
    assert.strictEqual(salon.Comment, 'Qisman');
    await context.close();
  });

  test('each row keeps its own month, so three months settle in one submit', async () => {
    const { page, context, backend } = await openAdmin();

    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PREVIOUS, amount: 400000, comment: 'Qarz' });
    await page.click('#bulkAddRow');
    await fillRow(page, 1, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'Joriy oy' });

    await saveAndSettle(page);

    const stored = storedRows(backend);
    assert.strictEqual(stored.length, 2);
    const older = stored.find(r => r.Period === PREVIOUS);
    const now = stored.find(r => r.Period === PERIOD);
    assert.ok(older && now, 'both months landed');

    // Each entry froze its own month's rate — the reason the batch's single
    // shared rate pair could not be reused for this.
    assert.strictEqual(Number(older.Rate_Sell), 11500);
    assert.strictEqual(Number(now.Rate_Sell), 12500);
    await context.close();
  });

  test('repeat-last-month seeds the previous month\'s entries into this one', async () => {
    const { page, context, backend } = await openAdmin();

    // Two entries in the previous month, made through the screen itself.
    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PREVIOUS, amount: 1000000, comment: 'Ijara' });
    await page.click('#bulkAddRow');
    await fillRow(page, 1, { kind: 'expense', tenant: 'Umumiy Naqd Puldan', period: PREVIOUS, amount: 120000, comment: 'Suv' });
    await saveAndSettle(page);

    await page.click('#bulkFillRepeat');
    const rows = await page.$$eval('.bulk-row', list => list.map(row => ({
      kind: row.querySelector('.bulk-kind').value,
      tenant: row.querySelector('.bulk-tenant').value,
      period: row.querySelector('.bulk-period').value,
      comment: row.querySelector('.bulk-comment').value
    })));

    assert.strictEqual(rows.length, 2);
    // Copied into the month being worked on, not the one they came from: this
    // is "the same again", not "the same entry a second time".
    assert.ok(rows.every(r => r.period === PERIOD));
    assert.deepStrictEqual(rows.map(r => r.tenant).sort(), ['Apteka', 'Umumiy Naqd Puldan']);
    assert.deepStrictEqual(rows.map(r => r.kind).sort(), ['expense', 'income']);

    await saveAndSettle(page);
    assert.strictEqual(storedRows(backend).filter(r => r.Period === PERIOD).length, 2);
    await context.close();
  });

  // --------------------------------------------------------------- refusals

  test('an incomplete row is refused in the browser and nothing is sent', async () => {
    const { page, context, backend, submitted } = await openAdmin();

    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', amount: 0 });
    await save(page);
    await page.waitForSelector('#bulkError:not(.hidden)');

    assert.strictEqual(submitted.length, 0, 'the round trip was never made');
    assert.strictEqual(storedRows(backend).length, 0);
    assert.strictEqual(await rowCount(page), 1, 'and the row is still there to fix');
    await context.close();
  });

  test('a refusal from the server keeps the grid and the request id', async () => {
    const { page, context, backend, submitted } = await openAdmin();

    await page.click('#bulkAddRow');
    // A tenant-paid row outside the tenant list: refused by the server, not by
    // the browser, so the round trip really happens.
    await fillRow(page, 0, { kind: 'tenant_paid', tenant: 'Apteka', period: PERIOD, amount: 300000, comment: 'Elektrik' });
    await page.$eval('.bulk-row .bulk-tenant', el => {
      const option = document.createElement('option');
      option.value = 'Nomalum';
      el.appendChild(option);
      el.value = 'Nomalum';
    });

    await saveAndSettle(page);
    await page.waitForSelector('#bulkError:not(.hidden)');

    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(storedRows(backend).length, 0);
    assert.strictEqual(await rowCount(page), 1, 'the grid survived the refusal');

    // Fixing the row and pressing again is a *retry*, under the same id — so a
    // first attempt that actually landed cannot be written a second time.
    const retried = await page.evaluate(() => sessionStorage.getItem('omad_pending_bulk_request'));
    assert.ok(retried, 'the request id is still pending');
    assert.strictEqual(retried, submitted[0].requestId);
    await context.close();
  });

  // ------------------------------------------------- immutable once saving

  test('mutating the grid mid-save changes nothing about what was sent', async () => {
    const { page, context, backend, submitted, release, issued } =
      await openAdmin({ hold: true });

    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'Ijara' });
    await page.click('#bulkAddRow');
    await fillRow(page, 1, { kind: 'income', tenant: 'Salon', period: PERIOD, amount: 800000, comment: 'Ijara' });

    await save(page);
    assert.strictEqual(await issued(1), 1);

    // Everything a person could reach while the spinner is up.
    await page.evaluate(() => {
      addBulkRow({ kind: 'income', tenant: 'Tehnopark', amount: 999999 });
      const first = document.querySelector('.bulk-row .bulk-amount');
      if (first) { first.value = '1'; first.dispatchEvent(new Event('input', { bubbles: true })); }
      const remove = document.querySelectorAll('.bulk-row button');
      if (remove[1]) remove[1].click();
      clearBulkGrid();
    });

    await release();
    await page.waitForFunction(() => !bulkSaveInFlight);

    // One request, describing the two rows that were on screen when the button
    // was pressed. The grid was frozen before the first await and locked behind
    // it — the `submittedCartLines` lesson, applied from the start.
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(submitted[0].entries.length, 2);
    assert.deepStrictEqual(submitted[0].entries.map(e => e.amount), [1000000, 800000]);

    const stored = storedRows(backend);
    assert.strictEqual(stored.length, 2);
    assert.deepStrictEqual(stored.map(r => Number(r.Amount)).sort((a, b) => a - b), [800000, 1000000]);
    await context.close();
  });

  test('a second press while saving does not submit twice', async () => {
    const { page, context, backend, submitted, release, issued } =
      await openAdmin({ hold: true });

    await page.click('#bulkAddRow');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'Ijara' });

    await save(page);
    assert.strictEqual(await issued(1), 1);
    await page.evaluate(() => { submitBulk(); submitBulk(); });

    await release();
    await page.waitForFunction(() => !bulkSaveInFlight);

    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(storedRows(backend).length, 1);
    await context.close();
  });
});
