'use strict';

/**
 * The Omad admin against the append-only ledger, in a real browser.
 *
 * Before cutover the app keeps using the whole-list save; after cutover entry,
 * edit and delete go through create/correct/cancel and carry request ids.
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

function tx(id, overrides = {}) {
  return {
    id, period: '2026-01', month: '2026-01', periodLabel: 'Yanvar 2026',
    tenant: 'Tehnopark', type: 'Income', amount: 1000000, currency: 'UZS',
    method: 'Naqd', date: '05/01/2026', comment: 'ijara', msgId: '', requestId: '',
    status: 'Active', ...overrides
  };
}

describe('Omad admin ledger (browser)', () => {
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

  /**
   * @param {object} options
   * @param {boolean} options.ledgerActive  simulate a completed cutover
   * @param {function} options.respond      override the response per action
   */
  async function openAdmin({ ledgerActive = true, transactions = [tx('1700000000000_0')], respond = null } = {}) {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
      localStorage.setItem('omad_access_key', 'e2e-access-key');
      localStorage.setItem('omad_user', 'tester');
    });

    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            transactions,
            tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
            rates: { '2026-01': { buy: 12000, sell: 12500 } },
            templateExpenses: []
          })
        });
        return;
      }

      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);

      let body = respond && respond(payload);
      if (!body) {
        if (payload.action === 'get_migration_status') {
          body = {
            status: 'success',
            migration: {
              state: ledgerActive ? 'cutover' : 'not_started',
              activeSheet: ledgerActive ? 'Omad_Transactions_V2' : 'Omad_Transactions'
            }
          };
        } else if (payload.action === 'create_transaction' || payload.action === 'correct_transaction') {
          body = { status: 'success', transaction: tx('created_0'), reportJobId: 'job_1' };
        } else {
          body = { status: 'success' };
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    return { page, context, requests, pageErrors };
  }

  async function fillEntry(page, { amount = '500000', comment = 'test' } = {}) {
    await page.evaluate(({ amount, comment }) => {
      switchTab('entry');
      document.getElementById('entryMonth').value = '2026-01';
      document.getElementById('tempAmount').value = amount;
      addToCart();
      document.getElementById('entryComment').value = comment;
    }, { amount, comment });
  }

  // --------------------------------------------------------------- create

  test('a new entry becomes a create_transaction with a request id', async () => {
    const { page, context, requests, pageErrors } = await openAdmin();

    await fillEntry(page);
    await page.evaluate(() => submitAll());

    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(creates.length, 1);
    assert.strictEqual(creates[0].period, '2026-01');
    assert.strictEqual(creates[0].amount, 500000);
    assert.strictEqual(creates[0].source, 'Web');
    assert.strictEqual(creates[0].createdBy, 'tester');
    assert.ok(/^web_\d+_[a-z0-9]+_0$/.test(creates[0].requestId), creates[0].requestId);

    // The whole-list save is not used once the ledger is live.
    assert.deepStrictEqual(requests.filter(r => r.action === 'save_omad'), []);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('each cart line becomes its own transaction with its own request id', async () => {
    const { page, context, requests } = await openAdmin();

    await page.evaluate(async () => {
      switchTab('entry');
      document.getElementById('entryMonth').value = '2026-01';
      for (const amount of ['100000', '200000', '300000']) {
        document.getElementById('tempAmount').value = amount;
        addToCart();
      }
      await submitAll();
    });

    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.deepStrictEqual(creates.map(c => c.amount), [100000, 200000, 300000]);
    assert.strictEqual(new Set(creates.map(c => c.requestId)).size, 3);
    // All three share one submission prefix.
    assert.strictEqual(new Set(creates.map(c => c.requestId.replace(/_\d+$/, ''))).size, 1);
    await context.close();
  });

  test('a double click cannot submit twice', async () => {
    const { page, context, requests } = await openAdmin();

    await fillEntry(page);
    // Three clicks before the first save has come back.
    await page.evaluate(async () => {
      const first = submitAll();
      submitAll();
      submitAll();
      await first;
    });

    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1);
    await context.close();
  });

  test('a retry after a failure reuses the same request id', async () => {
    let failNext = true;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action !== 'create_transaction') return null;
        if (failNext) { failNext = false; return { status: 'error', message: 'temporary' }; }
        return { status: 'success', transaction: tx('created_0') };
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    await page.evaluate(() => submitAll());

    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(creates.length, 2, 'the submission was retried');
    assert.strictEqual(creates[0].requestId, creates[1].requestId,
      'the retry carries the same request id, so the server de-duplicates it');
    await context.close();
  });

  test('a browser refresh mid-save resubmits with the same request id', async () => {
    // The first submit never gets a response - the tab is reloaded first.
    const { page, context, requests } = await openAdmin({
      respond: payload => (payload.action === 'create_transaction'
        ? { status: 'error', message: 'connection lost' }
        : null)
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const firstRequestId = requests.filter(r => r.action === 'create_transaction')[0].requestId;

    // Reload. The pending request id survives in sessionStorage.
    await page.reload();
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await fillEntry(page);
    await page.evaluate(() => submitAll());

    const retried = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(retried[retried.length - 1].requestId, firstRequestId,
      'the server sees the same request id and de-duplicates it');
    await context.close();
  });

  test('a successful save clears the pending request id', async () => {
    const { page, context, requests } = await openAdmin();

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const first = requests.filter(r => r.action === 'create_transaction')[0].requestId;

    await fillEntry(page, { amount: '700000', comment: 'second' });
    await page.evaluate(() => submitAll());
    const second = requests.filter(r => r.action === 'create_transaction')[1].requestId;

    assert.notStrictEqual(first, second, 'the next entry is a new request');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_request'));
    assert.strictEqual(stored, null);
    await context.close();
  });

  // --------------------------------------------------------------- correct

  test('editing an entry corrects the existing transaction', async () => {
    const { page, context, requests } = await openAdmin({
      transactions: [tx('1700000000000_0', { amount: 1000000 })]
    });

    await page.evaluate(async () => {
      editTx('1700000000000_0');
      cart = [{ amount: 1250000, currency: 'UZS', method: 'Naqd' }];
      renderCart();
      await submitAll();
    });

    const corrections = requests.filter(r => r.action === 'correct_transaction');
    assert.strictEqual(corrections.length, 1);
    assert.strictEqual(corrections[0].transactionId, '1700000000000_0');
    assert.strictEqual(corrections[0].amount, 1250000);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
    await context.close();
  });

  test('removing a line from an edited entry cancels it rather than deleting it', async () => {
    const { page, context, requests } = await openAdmin({
      transactions: [
        tx('1700000000000_0', { amount: 100000 }),
        tx('1700000000000_1', { amount: 200000 })
      ]
    });

    await page.evaluate(async () => {
      editTx('1700000000000_0');
      cart = [{ amount: 100000, currency: 'UZS', method: 'Naqd' }];
      renderCart();
      await submitAll();
    });

    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 1);
    const cancels = requests.filter(r => r.action === 'cancel_transaction');
    assert.strictEqual(cancels.length, 1);
    assert.strictEqual(cancels[0].transactionId, '1700000000000_1');
    await context.close();
  });

  test('adding a line to an edited entry creates it', async () => {
    const { page, context, requests } = await openAdmin({
      transactions: [tx('1700000000000_0', { amount: 100000 })]
    });

    await page.evaluate(async () => {
      editTx('1700000000000_0');
      cart = [
        { amount: 100000, currency: 'UZS', method: 'Naqd' },
        { amount: 50000, currency: 'UZS', method: 'Bank' }
      ];
      renderCart();
      await submitAll();
    });

    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 1);
    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1);
    await context.close();
  });

  // ---------------------------------------------------------------- cancel

  test('deleting from history cancels every line of the entry', async () => {
    const { page, context, requests } = await openAdmin({
      transactions: [tx('1700000000000_0'), tx('1700000000000_1')]
    });

    await page.evaluate(() => deleteTx('1700000000000_0'));

    const cancels = requests.filter(r => r.action === 'cancel_transaction');
    assert.deepStrictEqual(cancels.map(c => c.transactionId),
      ['1700000000000_0', '1700000000000_1']);
    assert.ok(cancels.every(c => c.requestId), 'each cancellation carries a request id');
    await context.close();
  });

  // ------------------------------------------------- pre-cutover behaviour

  test('before cutover the app keeps using the whole-list save', async () => {
    const { page, context, requests } = await openAdmin({ ledgerActive: false });

    await fillEntry(page);
    await page.evaluate(() => submitAll());

    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
    const saves = requests.filter(r => r.action === 'save_omad');
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].telegramReport.operation, 'transaction_upsert');
    await context.close();
  });

  test('before cutover deleting still uses the legacy delete report', async () => {
    const { page, context, requests } = await openAdmin({
      ledgerActive: false,
      transactions: [tx('1700000000000_0', { msgId: '999' })]
    });

    await page.evaluate(() => deleteTx('1700000000000_0'));

    assert.deepStrictEqual(requests.filter(r => r.action === 'cancel_transaction'), []);
    const save = requests.filter(r => r.action === 'save_omad').pop();
    assert.strictEqual(save.telegramReport.operation, 'transaction_delete');
    assert.strictEqual(save.telegramReport.messageId, '999');
    await context.close();
  });
});
