'use strict';

/**
 * A multi-line entry being edited is immutable once Save is pressed.
 *
 * Editing an existing business action is several sequential backend calls — one
 * `correct_transaction` per line that already exists, one `create_transaction`
 * per line that does not, then one `cancel_transaction` per line that was
 * removed — and each of those is a full round trip to Apps Script.
 *
 * The loop used to read the live `cart` between them: `i < cart.length` was
 * re-evaluated every pass and `cart[i]` dereferenced after the previous `await`
 * resumed. `existingIds` was already snapshotted before the loop, so the
 * *targets* were fixed while the *source* moved. Three things followed from that
 * asymmetry, and all three are financial:
 *
 *   * a line removed mid-save shifted every later correction on to the wrong
 *     original, so one row was corrected with another row's amount;
 *   * the cancellation boundary is `for (i = cart.length; i < existingIds.length)`,
 *     so a shorter cart moved it down and **cancelled a row nobody asked to
 *     remove** — money leaving the books through a legitimate-looking
 *     `cancel_transaction`;
 *   * a line added mid-save appended a `create_transaction` for something that
 *     was not on screen when Save was pressed.
 *
 * Nothing prevented any of it: the Save button was disabled for the duration,
 * but `＋`, every line's `✕` and `Bekor qilish` all stayed live, and the
 * full-screen overlay that used to shield the form incidentally was removed with
 * the fast-save work.
 *
 * These tests hold the first backend response open, mutate the form as hard as
 * they can while it is in flight, and then assert on the requests that were
 * actually issued — which is what the ledger ends up recording.
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

function isOmadRead(request) {
  if (request.method() === 'GET') return true;
  try { return JSON.parse(request.postData() || '{}').action === 'get_omad_data'; }
  catch (error) { return false; }
}

/** One row of a three-line business action, all sharing `grp_1`. */
function tx(id, amount, overrides = {}) {
  return {
    id, period: '2026-01', month: '2026-01', periodLabel: 'Yanvar 2026',
    tenant: 'Tehnopark', type: 'Income', amount, currency: 'UZS',
    method: 'Naqd', date: '05/01/2026', comment: 'ijara', msgId: '', requestId: '',
    groupId: 'grp_1', entryGroupId: 'grp_1', status: 'Active', ...overrides
  };
}

const THREE_LINES = [
  tx('1700000000000_0', 100000),
  tx('1700000000000_1', 200000),
  tx('1700000000000_2', 300000)
];

describe('Omad multi-line edit is immutable once saving (browser)', () => {
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
   * Opens the admin with one three-line entry, and holds every write until the
   * test releases it.
   *
   * `release()` lets the queued responses through one at a time, so the test can
   * stand exactly where the old code re-read the cart: after a request has been
   * issued and before its answer arrives.
   */
  async function openAdmin() {
    const requests = [];
    const waiting = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      localStorage.setItem('omad_user', 'tester');
    });

    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            transactions: THREE_LINES,
            tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
            rates: { '2026-01': { buy: 12000, sell: 12500 } },
            templateExpenses: []
          })
        });
        return;
      }

      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }

      if (payload.action === 'get_migration_status') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            migration: { state: 'cutover', activeSheet: 'Omad_Transactions_V2' }
          })
        });
        return;
      }

      requests.push(payload);
      // Every write waits here until the test releases it.
      await new Promise(resolve => waiting.push(async () => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', transaction: tx('new_0', 1), reportJobId: 'j' })
        });
        resolve();
      }));
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });

    /** Answers the oldest still-held request. */
    async function release() {
      while (!waiting.length) await page.waitForTimeout(20);
      await waiting.shift()();
    }
    /** Waits until `count` writes have been issued. */
    async function issued(count) {
      const deadline = Date.now() + 5000;
      while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(20);
      return requests.length;
    }
    return { page, context, requests, pageErrors, release, issued };
  }

  /** Loads the three-line entry into the form, as pressing ✏️ does. */
  async function startEdit(page) {
    await page.evaluate(() => { editTx('1700000000000_0'); });
    await page.waitForFunction(() => cart.length === 3);
  }

  // ------------------------------------------------- removing during a save

  test('a line removed mid-save changes neither the corrections nor the cancellations', async () => {
    const { page, context, requests, pageErrors, release, issued } = await openAdmin();
    await startEdit(page);

    // Save the three lines exactly as they are: three corrections, no cancels.
    await page.evaluate(() => { submitAll(); });
    await issued(1);

    // The first correction is in flight. Try to remove the middle line — by the
    // handler the ✕ button calls, and then by mutating the array directly, which
    // is the worst case a stale client could manage.
    await page.evaluate(() => { removeCartLine(1); });
    assert.strictEqual(await page.evaluate(() => cart.length), 3,
      'the guard refused the removal while the save was reading the list');

    await release();
    await issued(2);
    await release();
    await issued(3);
    await release();
    await page.waitForFunction(() => !entrySaveInFlight);

    const corrections = requests.filter(r => r.action === 'correct_transaction');
    assert.strictEqual(corrections.length, 3, 'all three lines were corrected');
    assert.deepStrictEqual(
      corrections.map(r => [r.transactionId, r.amount]),
      [['1700000000000_0', 100000], ['1700000000000_1', 200000], ['1700000000000_2', 300000]],
      'each correction went to the original it belongs to, with that line\'s amount');

    assert.deepStrictEqual(requests.filter(r => r.action === 'cancel_transaction'), [],
      'and nothing was cancelled: the person removed nothing before pressing Save');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the frozen snapshot survives a cart emptied behind the guard', async () => {
    const { page, context, requests, pageErrors, release, issued } = await openAdmin();
    await startEdit(page);

    await page.evaluate(() => { submitAll(); });
    await issued(1);

    // The guard is the first line of defence; the snapshot is the second. Force
    // the array to empty anyway — a stale or malformed client bypassing the UI —
    // and the save must still describe the action that was submitted.
    await page.evaluate(() => { cart.length = 0; });

    await release(); await issued(2);
    await release(); await issued(3);
    await release();
    await page.waitForFunction(() => !entrySaveInFlight);

    const corrections = requests.filter(r => r.action === 'correct_transaction');
    assert.strictEqual(corrections.length, 3,
      'the loop iterated the snapshot, not the emptied cart');
    assert.deepStrictEqual(corrections.map(r => r.amount), [100000, 200000, 300000]);
    assert.deepStrictEqual(requests.filter(r => r.action === 'cancel_transaction'), [],
      'and the cancellation boundary did not move down to swallow every row');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  // -------------------------------------------------- adding during a save

  test('a line added mid-save is not written into the action being saved', async () => {
    const { page, context, requests, pageErrors, release, issued } = await openAdmin();
    await startEdit(page);

    await page.evaluate(() => { submitAll(); });
    await issued(1);

    await page.evaluate(() => {
      document.getElementById('tempAmount').value = '999000';
      addToCart();
    });
    assert.strictEqual(await page.evaluate(() => cart.length), 3, 'the guard refused the addition');

    await release(); await issued(2);
    await release(); await issued(3);
    await release();
    await page.waitForFunction(() => !entrySaveInFlight);

    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 3);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), [],
      'no unconfirmed fourth line was appended to the group');
    assert.ok(!requests.some(r => r.amount === 999000), 'and its amount reached nothing');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  // -------------------------------- a genuine removal still cancels, once

  test('a line removed before Save is cancelled, and only that line', async () => {
    const { page, context, requests, pageErrors, release, issued } = await openAdmin();
    await startEdit(page);

    // Remove the last line first, then save. This is the real feature, and it
    // must keep working: two corrections and exactly one cancellation.
    await page.evaluate(() => { removeCartLine(2); });
    assert.strictEqual(await page.evaluate(() => cart.length), 2);

    await page.evaluate(() => { submitAll(); });
    await issued(1); await release();
    await issued(2); await release();
    await issued(3); await release();
    await page.waitForFunction(() => !entrySaveInFlight);

    const corrections = requests.filter(r => r.action === 'correct_transaction');
    assert.deepStrictEqual(corrections.map(r => [r.transactionId, r.amount]),
      [['1700000000000_0', 100000], ['1700000000000_1', 200000]]);

    const cancels = requests.filter(r => r.action === 'cancel_transaction');
    assert.strictEqual(cancels.length, 1, 'exactly the removed line');
    assert.strictEqual(cancels[0].transactionId, '1700000000000_2');
    assert.strictEqual(cancels[0].reason, 'entry edited');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  // ------------------------------------------------------------ the lock

  test('every control that changes the action is locked while it saves', async () => {
    const { page, context, release, issued } = await openAdmin();
    await startEdit(page);

    const locked = () => page.evaluate(() => ({
      inFlight: entrySaveInFlight,
      submit: document.getElementById('submitBtn').disabled,
      add: document.getElementById('addToCartBtn').disabled,
      cancelEdit: document.getElementById('cancelEditBtn').disabled,
      amount: document.getElementById('tempAmount').disabled,
      tenant: document.getElementById('entryTenant').disabled,
      month: document.getElementById('entryMonth').disabled,
      comment: document.getElementById('entryComment').disabled,
      removeButtons: Array.from(document.querySelectorAll('#cartList button')).map(b => b.disabled)
    }));

    const before = await locked();
    assert.strictEqual(before.inFlight, false);
    assert.strictEqual(before.add, false, 'nothing is locked before a save');

    await page.evaluate(() => { submitAll(); });
    await issued(1);

    const during = await locked();
    assert.strictEqual(during.inFlight, true);
    assert.strictEqual(during.submit, true);
    assert.strictEqual(during.add, true, 'no new line');
    assert.strictEqual(during.cancelEdit, true, 'and the edit cannot be abandoned mid-write');
    assert.strictEqual(during.amount, true);
    assert.strictEqual(during.tenant, true, 'nor can the action be re-pointed at another tenant');
    assert.strictEqual(during.month, true, 'nor moved to another period');
    assert.strictEqual(during.comment, true);
    assert.deepStrictEqual(during.removeButtons, [true, true, true], 'nor any line dropped');

    await release(); await issued(2);
    await release(); await issued(3);
    await release();
    await page.waitForFunction(() => !entrySaveInFlight);

    const after = await locked();
    assert.strictEqual(after.add, false, 'and everything is released again afterwards');
    assert.strictEqual(after.tenant, false);
    assert.strictEqual(after.comment, false);
    await context.close();
  });

  test('a failed save releases the controls so the same entry can be retried', async () => {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      localStorage.setItem('omad_user', 'tester');
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            transactions: THREE_LINES,
            tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
            rates: { '2026-01': { buy: 12000, sell: 12500 } }, templateExpenses: []
          })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      if (payload.action === 'get_migration_status') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            migration: { state: 'cutover', activeSheet: 'Omad_Transactions_V2' }
          })
        });
        return;
      }
      requests.push(payload);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: 'server said no' })
      });
    });

    const page = await context.newPage();
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await startEdit(page);

    await page.evaluate(() => submitAll());
    await page.waitForFunction(() => !entrySaveInFlight);

    // The cart, the form and the request id all survive a refused save, so the
    // same entry can be sent again without becoming a second entry.
    assert.strictEqual(await page.evaluate(() => cart.length), 3, 'the cart is intact');
    assert.strictEqual(await page.evaluate(() => document.getElementById('addToCartBtn').disabled),
      false, 'and the controls are usable again');
    assert.strictEqual(await page.evaluate(() => document.getElementById('cancelEditBtn').disabled),
      false);
    assert.strictEqual(requests.length, 1, 'it stopped at the refusal');
    await context.close();
  });
});
