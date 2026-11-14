'use strict';

/**
 * The Omad dashboard after a save, in a real browser, against the real backend.
 *
 * A save used to be followed by a second request for the dashboard -- a whole
 * second Apps Script start-up before the figures moved. The save now asks for
 * them and the screen uses what came back. These tests hold that: one request
 * per save, the figures on screen are the server's after the write, an older
 * backend that sends no figures still gets the refresh, and a multi-line edit
 * asks for them only on its last request.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript, readJsonOutput, postEvent, currentPeriodKey } = require('./gas-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
const describe = chromium ? test.describe : test.describe.skip;

const ROOT = path.join(__dirname, '..');
const PERIOD = currentPeriodKey();
const LEDGER_HEADER = ['ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period', 'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used', 'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID', 'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'];

function boot() {
  const gas = loadScript({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ [PERIOD]: { buy: 12500, sell: 12650 } })],
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 4500000, currency: 'UZS', active: true }])],
        ['Omad_Template_Expenses', '[]'], ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER]
    }
  });
  gas.setUserPassword('omad_admin', 'save-dashboard-password', 'omad_admin');
  const token = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: 'omad_admin', password: 'save-dashboard-password' }))).token;
  return { gas, token };
}

function startStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Omad figures after a save (browser)', () => {
  let server, browser, base;

  test.before(async () => {
    server = await startStaticServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });
  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  /** `oldBackend` strips the figures from every answer, as a backend from before this change would. */
  async function openOmad(backend, options = {}) {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(token => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', token);
      localStorage.setItem('omad_user', 'omad_admin');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    }, backend.token);
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);
      const body = JSON.parse(backend.gas.doPost(postEvent(payload)).__text);
      if (options.oldBackend) delete body.dashboard;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/omad_admin.html`);
    await page.waitForFunction(() => typeof app !== 'undefined' && app.summary && app.summary.periods);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    return { page, context, requests, errors };
  }

  async function saveIncome(page, amounts) {
    await page.evaluate(() => switchTab('entry'));
    await page.selectOption('#entryTenant', 'Apteka');
    for (const amount of amounts) {
      await page.fill('#tempAmount', String(amount));
      await page.evaluate(() => addToCart());
    }
    await page.click('#submitBtn');
  }

  const income = page => page.evaluate(() => app.summary.allTime.income);

  test('a new entry is one request, and the figures on screen are the server\'s after it', async () => {
    const backend = boot();
    const { page, context, requests, errors } = await openOmad(backend);
    requests.length = 0;

    await saveIncome(page, [1500000]);
    await page.waitForFunction(() => app.summary.allTime.income === 1500000);
    await sleep(500);
    assert.deepStrictEqual(requests.map(r => r.action), ['create_transaction_batch'],
      'no second request for the dashboard');
    assert.strictEqual(requests[0].includeDashboard, true);
    assert.ok(await page.evaluate(() => /1[\s,. ]?500[\s,. ]?000/.test(document.getElementById('tab-dash').innerText)),
      'and the dashboard shows the new income');
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  test('an older backend that sends no figures still gets the refresh', async () => {
    const backend = boot();
    const { page, context, requests } = await openOmad(backend, { oldBackend: true });
    requests.length = 0;

    await saveIncome(page, [700000]);
    await page.waitForFunction(() => app.summary.allTime.income === 700000);
    assert.deepStrictEqual(requests.map(r => r.action), ['create_transaction_batch', 'get_omad_data']);
    await context.close();
  });

  test('a multi-line edit asks for the figures only on its last request', async () => {
    const backend = boot();
    const { page, context, requests } = await openOmad(backend);
    await saveIncome(page, [100000, 200000]);
    await page.waitForFunction(() => app.summary.allTime.income === 300000);

    // Edit the entry from Tarix: three lines where there were two.
    await page.evaluate(() => switchTab('history'));
    await page.waitForSelector('#historyList button[aria-label="Tahrirlash"]');
    await page.click('#historyList button[aria-label="Tahrirlash"]');
    await page.fill('#tempAmount', '50000');
    await page.evaluate(() => addToCart());
    requests.length = 0;
    await page.click('#submitBtn');
    await page.waitForFunction(() => app.summary.allTime.income === 350000);
    await sleep(500);

    const writes = requests.filter(r => r.action !== 'get_omad_history');
    assert.deepStrictEqual(writes.map(r => r.action), ['correct_transaction', 'correct_transaction', 'create_transaction']);
    assert.deepStrictEqual(writes.map(r => r.includeDashboard), [false, false, true]);
    await context.close();
  });
});
