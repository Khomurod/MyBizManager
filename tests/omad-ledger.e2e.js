'use strict';

/**
 * The Omad admin against the append-only ledger, in a real browser.
 *
 * Before cutover the app keeps using the whole-list save; after cutover new
 * entries are submitted as one batch while edits/deletes keep their existing
 * correct/create/cancel semantics. Every write carries stable request ids.
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
      localStorage.setItem('omad_session', 'e2e-session-token');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
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
        } else if (payload.action === 'create_transaction_batch') {
          body = {
            status: 'success',
            transactions: (payload.lines || []).map((line, index) => tx(`created_${index}`, {
              amount: line.amount,
              currency: line.currency,
              method: line.method,
              requestId: `${payload.requestId}_${index}`,
              groupId: payload.groupId
            })),
            reportJobId: 'job_1'
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

  test('a new entry becomes one create_transaction_batch with a stable request id', async () => {
    const { page, context, requests, pageErrors } = await openAdmin();

    await fillEntry(page);
    await page.evaluate(() => submitAll());

    const batches = requests.filter(r => r.action === 'create_transaction_batch');
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].period, '2026-01');
    assert.deepStrictEqual(batches[0].lines.map(line => line.amount), [500000]);
    assert.strictEqual(batches[0].source, 'Web');
    assert.strictEqual(batches[0].createdBy, 'tester');
    assert.strictEqual(batches[0].deferReports, true);
    assert.ok(/^web_\d+_[a-z0-9]+$/.test(batches[0].requestId), batches[0].requestId);

    // The whole-list and per-line create paths are not used on the normal live path.
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
    assert.deepStrictEqual(requests.filter(r => r.action === 'save_omad'), []);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('all cart lines travel in one batch request', async () => {
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

    const batches = requests.filter(r => r.action === 'create_transaction_batch');
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0].lines.map(line => line.amount), [100000, 200000, 300000]);
    assert.ok(batches[0].requestId);
    assert.ok(batches[0].groupId);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
    await context.close();
  });

  test('a double click cannot submit the batch twice', async () => {
    const { page, context, requests } = await openAdmin();

    await fillEntry(page);
    // Three clicks before the first save has come back.
    await page.evaluate(async () => {
      const first = submitAll();
      submitAll();
      submitAll();
      await first;
    });

    assert.strictEqual(requests.filter(r => r.action === 'create_transaction_batch').length, 1);
    await context.close();
  });

  test('a retry after a failure reuses the same batch request id', async () => {
    let failNext = true;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action !== 'create_transaction_batch') return null;
        if (failNext) { failNext = false; return { status: 'error', message: 'temporary' }; }
        return { status: 'success', transactions: [] };
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    await page.evaluate(() => submitAll());

    const batches = requests.filter(r => r.action === 'create_transaction_batch');
    assert.strictEqual(batches.length, 2, 'the submission was retried');
    assert.strictEqual(batches[0].requestId, batches[1].requestId,
      'the retry carries the same request id, so the server de-duplicates it');
    assert.strictEqual(batches[0].groupId, batches[1].groupId,
      'the retry remains the same business entry');
    await context.close();
  });

  test('a browser refresh after a failed batch resubmits with the same request id', async () => {
    const { page, context, requests } = await openAdmin({
      respond: payload => (payload.action === 'create_transaction_batch'
        ? { status: 'error', message: 'connection lost' }
        : null)
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const firstRequestId = requests.filter(r => r.action === 'create_transaction_batch')[0].requestId;

    // Reload. The pending request id survives in sessionStorage.
    await page.reload();
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await fillEntry(page);
    await page.evaluate(() => submitAll());

    const retried = requests.filter(r => r.action === 'create_transaction_batch');
    assert.strictEqual(retried[retried.length - 1].requestId, firstRequestId,
      'the server sees the same request id and de-duplicates it');
    await context.close();
  });

  test('a successful batch save clears the pending request id', async () => {
    const { page, context, requests } = await openAdmin();

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const first = requests.filter(r => r.action === 'create_transaction_batch')[0].requestId;

    await fillEntry(page, { amount: '700000', comment: 'second' });
    await page.evaluate(() => submitAll());
    const second = requests.filter(r => r.action === 'create_transaction_batch')[1].requestId;

    assert.notStrictEqual(first, second, 'the next entry is a new request');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_request'));
    assert.strictEqual(stored, null);
    await context.close();
  });

  test('an older backend falls back to the proven per-line create path', async () => {
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action === 'create_transaction_batch') {
          return { status: 'error', message: 'Unknown action: create_transaction_batch' };
        }
        return null;
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());

    assert.strictEqual(requests.filter(r => r.action === 'create_transaction_batch').length, 1);
    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(creates.length, 1);
    assert.ok(/_0$/.test(creates[0].requestId));
    await context.close();
  });

  test('an uncertain old-backend fallback refuses a changed cart before another line write', async () => {
    let createAttempts = 0;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action === 'create_transaction_batch') {
          return { status: 'error', message: 'Unknown action: create_transaction_batch' };
        }
        if (payload.action === 'create_transaction') {
          createAttempts++;
          if (createAttempts === 1) return { status: 'error', message: 'connection lost' };
          return { status: 'success', transaction: {} };
        }
        return null;
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const firstCreate = requests.filter(r => r.action === 'create_transaction')[0];
    assert.ok(firstCreate, 'the first fallback reaches the old single-row API');

    await page.evaluate(() => {
      cart[0].amount = Number(cart[0].amount) + 1;
      renderCart();
    });
    await page.evaluate(() => submitAll());

    assert.strictEqual(requests.filter(r => r.action === 'create_transaction_batch').length, 2,
      'the harmless capability probe can repeat');
    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1,
      'changed data never reaches the opaque old single-row idempotency API');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_legacy_fallback_fingerprint'));
    assert.ok(stored, 'the uncertain fallback shape stays pinned for a safe retry');
    await context.close();
  });

  test('an uncertain old-backend fallback can retry the exact same submission', async () => {
    let createAttempts = 0;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action === 'create_transaction_batch') {
          return { status: 'error', message: 'Unknown action: create_transaction_batch' };
        }
        if (payload.action === 'create_transaction') {
          createAttempts++;
          if (createAttempts === 1) return { status: 'error', message: 'connection lost' };
          return { status: 'success', transaction: {} };
        }
        return null;
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    await page.evaluate(() => submitAll());

    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(creates.length, 2);
    assert.strictEqual(creates[0].requestId, creates[1].requestId,
      'the exact retry uses the same opaque id on the old backend');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_legacy_fallback_fingerprint'));
    assert.strictEqual(stored, null, 'a successful retry clears the fallback fingerprint');
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
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction_batch'), []);
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