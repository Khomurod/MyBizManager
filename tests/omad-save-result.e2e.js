'use strict';

/**
 * A save is only successful when the server says so.
 *
 * Apps Script answers HTTP 200 for almost everything, including its own
 * errors, so judging the outcome by the status line told people their money
 * had been recorded when the backend had refused it - and cleared the form,
 * losing what they had typed.
 *
 * On any failure the form, the cart and the request id must survive, so the
 * same entry can be sent again without becoming a second transaction.
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

const RATES = { '2026-08': { buy: 12050, sell: 11930 } };
const TENANTS = [{
  name: 'Tehnopark', rent: 500, defaultRent: 500, currency: 'USD', active: true,
  startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [], noRentPeriods: [], disabledMonths: []
}];

describe('Save results are believed only when the server confirms them', () => {
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
   * @param saveHandler decides what the save POST returns. Receives the parsed
   *        request body and the Playwright route.
   */
  async function openAdmin(saveHandler) {
    const saves = [];
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
          body: JSON.stringify({ transactions: [], tenants: TENANTS, rates: RATES, templateExpenses: [] })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }

      if (payload.action === 'get_migration_status') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } })
        });
        return;
      }

      saves.push(payload);
      await saveHandler(payload, route, saves.length);
    });

    const page = await context.newPage();
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    const alerts = [];
    page.on('dialog', d => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
    return { page, context, saves, alerts };
  }

  /** Fills the entry form with one cash line and presses save. */
  async function submitOneLine(page, comment = 'test yozuv') {
    await page.evaluate(c => {
      switchTab('entry');
      setType('Expense');
      document.getElementById('entryMonth').value = '2026-08';
      document.getElementById('entryTenant').value = 'Umumiy Naqd Puldan';
      document.getElementById('tempAmount').value = '1000';
      document.getElementById('tempMethod').value = 'Naqd';
      addToCart();
      document.getElementById('entryComment').value = c;
    }, comment);
    await page.evaluate(() => submitAll());
  }

  /** What the user can still see after the attempt. */
  function formState(page) {
    return page.evaluate(() => ({
      cartLines: cart.length,
      comment: document.getElementById('entryComment').value,
      pendingEntryBase: sessionStorage.getItem('omad_pending_entry_base') || '',
      transactions: app.transactions.length,
      onEntryTab: document.getElementById('tab-entry').classList.contains('active')
    }));
  }

  const ok = async (payload, route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', reportJobId: 'j1' })
  });

  // -------------------------------------------------------------- failures

  test('HTTP 200 carrying a JSON error is a failure, not a save', async () => {
    const { page, context, alerts } = await openAdmin(async (p, route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'Omad_Transactions yozib bo\'lmadi' })
    }));

    await submitOneLine(page);
    const state = await formState(page);

    assert.strictEqual(state.cartLines, 1, 'the cart is kept');
    assert.strictEqual(state.comment, 'test yozuv', 'the typed comment is kept');
    assert.ok(state.pendingEntryBase, 'the request id is kept for a safe retry');
    assert.strictEqual(state.transactions, 0, 'nothing is added to the local list');
    assert.ok(state.onEntryTab, 'the user is not sent to the dashboard');
    assert.ok(alerts.some(a => /yozib bo'lmadi/.test(a)), 'the server message is shown');
    await context.close();
  });

  test('an HTTP error is a failure', async () => {
    const { page, context, alerts } = await openAdmin(async (p, route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));

    await submitOneLine(page);
    const state = await formState(page);
    assert.strictEqual(state.cartLines, 1);
    assert.strictEqual(state.transactions, 0);
    assert.ok(alerts.length > 0, 'the user is told');
    await context.close();
  });

  test('a 200 that is not JSON is a failure', async () => {
    const { page, context, alerts } = await openAdmin(async (p, route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html>sign in</html>' }));

    await submitOneLine(page);
    const state = await formState(page);
    assert.strictEqual(state.cartLines, 1, 'a login page is never a successful save');
    assert.strictEqual(state.transactions, 0);
    assert.ok(alerts.length > 0);
    await context.close();
  });

  test('a 200 with no status field is a failure', async () => {
    const { page, context } = await openAdmin(async (p, route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ note: 'hello' }) }));

    await submitOneLine(page);
    assert.strictEqual((await formState(page)).cartLines, 1);
    await context.close();
  });

  test('a network failure is a failure', async () => {
    const { page, context, alerts } = await openAdmin(async (p, route) => route.abort('failed'));

    await submitOneLine(page);
    const state = await formState(page);
    assert.strictEqual(state.cartLines, 1, 'the entry survives an outage');
    assert.strictEqual(state.transactions, 0);
    assert.ok(alerts.length > 0);
    await context.close();
  });

  test('a timeout is a failure', async () => {
    const { page, context } = await openAdmin(async (p, route) => {
      await new Promise(r => setTimeout(r, 300));
      await route.abort('timedout');
    });

    await submitOneLine(page);
    assert.strictEqual((await formState(page)).cartLines, 1);
    await context.close();
  });

  // -------------------------------------------------------------- success

  test('a confirmed save clears the form and records the entry', async () => {
    const { page, context, saves } = await openAdmin(ok);

    await submitOneLine(page);
    const state = await formState(page);

    assert.strictEqual(state.cartLines, 0, 'the cart is emptied');
    assert.strictEqual(state.comment, '', 'the form is cleared');
    assert.strictEqual(state.pendingEntryBase, '', 'the request id is released');
    assert.ok(!state.onEntryTab, 'the user is taken to the dashboard');
    assert.ok(saves.some(s => s.action === 'save_omad'), 'the save was sent');
    await context.close();
  });

  // ---------------------------------------------------------- safe retries

  test('retrying after a refused save reuses the same ids, so nothing duplicates', async () => {
    let attempt = 0;
    const { page, context, saves } = await openAdmin(async (p, route) => {
      attempt += 1;
      if (attempt === 1) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'vaqtincha xatolik' })
        });
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' })
      });
    });

    await submitOneLine(page);
    const afterFailure = await formState(page);
    assert.strictEqual(afterFailure.cartLines, 1, 'the entry is still there to retry');

    // The user simply presses save again.
    await page.evaluate(() => submitAll());

    const sent = saves.filter(s => s.action === 'save_omad');
    assert.strictEqual(sent.length, 2, 'two attempts were made');

    const idsOf = s => s.transactions.map(t => t.id).sort();
    assert.deepStrictEqual(idsOf(sent[1]), idsOf(sent[0]),
      'the retry carries the same transaction ids, so the server rewrites one entry');
    assert.strictEqual(sent[1].transactions.length, 1, 'and still only one line');

    assert.strictEqual((await formState(page)).cartLines, 0, 'the successful retry clears the form');
    await context.close();
  });

  test('a second click while a save is in flight does not send it twice', async () => {
    let inFlight = 0;
    const { page, context, saves } = await openAdmin(async (p, route) => {
      inFlight += 1;
      await new Promise(r => setTimeout(r, 250));
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' })
      });
    });

    await page.evaluate(() => {
      switchTab('entry');
      setType('Expense');
      document.getElementById('entryMonth').value = '2026-08';
      document.getElementById('entryTenant').value = 'Umumiy Naqd Puldan';
      document.getElementById('tempAmount').value = '1000';
      addToCart();
    });
    // Two clicks, back to back.
    await page.evaluate(() => { submitAll(); submitAll(); });
    await page.waitForTimeout(700);

    assert.strictEqual(saves.filter(s => s.action === 'save_omad').length, 1,
      'the button is disabled for the duration of the save');
    assert.strictEqual(inFlight, 1);
    await context.close();
  });
});
