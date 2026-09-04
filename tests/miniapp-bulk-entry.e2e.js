'use strict';

/**
 * Ommaviy kiritish on a phone, driven in a real browser against the real
 * backend.
 *
 * The Mini App can only be trusted for this if the *screen* can do it: an API
 * that accepts fifty entries is worth nothing if the sheet renders one row and
 * submits none. These tests open `mini.html` in an emulated handset, press what
 * a person would press, and then read the rows the Apps Script backend actually
 * stored — including on a 320px screen, which is the narrowest phone anyone
 * still opens Telegram on.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

// The sheet offers the current month and the three before it, built from the
// clock. A literal month is a fixture with an expiry date on it.
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
  { name: 'Salon', defaultRent: 800000, currency: 'UZS', active: true }
];

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid', username: 'boss' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

const VALID_INIT_DATA = signedInitData();

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
      OMAD_ADMIN_KEY: 'mini-bulk-key',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { message_id: 77 } })
    }),
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

function storedRows(backend) {
  return backend.__spreadsheet.getSheetByName('Omad_Transactions_V2')
    .getDataRange().getValues().slice(1).filter(r => r[0])
    .map(r => {
      const out = {};
      LEDGER_HEADER.forEach((name, i) => { out[name] = r[i]; });
      return out;
    });
}

describe('Mini App bulk entry', () => {
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

  async function openOmad(options = {}) {
    const backend = options.backend || bootBackend(options.seedRows);
    const call = payload => readJsonOutput(backend.doPost(postEvent(
      Object.assign({}, payload, { initData: VALID_INIT_DATA }))));

    const viewport = options.viewport || { width: 390, height: 844 };
    const sent = [];
    const waiting = [];
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });

    await context.addInitScript(data => {
      window.Telegram = {
        WebApp: {
          initData: data,
          initDataUnsafe: { user: { id: 999999, first_name: 'Forged' } },
          ready() {}, expand() {}, setHeaderColor() {}, disableVerticalSwipes() {},
          HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
          BackButton: { show() {}, hide() {} },
          onEvent() {}, offEvent() {},
          showConfirm(message, callback) { callback(true); }
        }
      };
    }, VALID_INIT_DATA);

    await context.route('**telegram.org/**', route => route.abort());
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      sent.push(payload);

      if (payload.action === 'mini_bulk_entry' && options.hold) {
        await new Promise(resolve => waiting.push(async () => {
          await route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify(call(payload))
          });
          resolve();
        }));
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(call(payload))
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/mini.html`);
    await page.waitForFunction(() => state.omad !== null);

    async function release() {
      while (!waiting.length) await page.waitForTimeout(20);
      await waiting.shift()();
    }
    async function issued(count) {
      const deadline = Date.now() + 5000;
      const bulks = () => sent.filter(p => p.action === 'mini_bulk_entry').length;
      while (bulks() < count && Date.now() < deadline) await page.waitForTimeout(20);
      return bulks();
    }
    return { page, context, backend, sent, pageErrors, release, issued };
  }

  async function openBulk(page) {
    await page.click('button[onclick="openBulkSheet()"]');
    await page.waitForSelector('#mBulkSubmit');
  }

  async function rowCount(page) {
    return page.evaluate(() => document.querySelectorAll('.bulk-row').length);
  }

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

  async function saveAndSettle(page) {
    await page.click('#mBulkSubmit');
    await page.waitForFunction(() => !miniBulkSaveInFlight);
  }

  // -------------------------------------------------------- the sheet opens

  test('the Omad tab offers bulk entry, and the sheet opens empty', async () => {
    const { page, context, pageErrors } = await openOmad();
    await openBulk(page);

    assert.strictEqual(await rowCount(page), 0);
    assert.strictEqual(await page.isVisible('#mBulkEmpty'), true);
    assert.strictEqual(await page.isDisabled('#mBulkSubmit'), true, 'nothing to save yet');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the debt list fills a row per tenant who owes', async () => {
    const { page, context, pageErrors } = await openOmad();
    await openBulk(page);
    await page.click('#mBulkFill');

    const rows = await page.$$eval('.bulk-row', list => list.map(row => ({
      kind: row.querySelector('.bulk-kind').value,
      tenant: row.querySelector('.bulk-tenant').value,
      period: row.querySelector('.bulk-period').value,
      currency: row.querySelector('.bulk-currency').value,
      amount: row.querySelector('.bulk-amount').value
    })));

    assert.strictEqual(rows.length, 2, 'nobody has paid, so both owe');
    assert.deepStrictEqual(rows.map(r => r.tenant).sort(), ['Apteka', 'Salon']);
    assert.ok(rows.every(r => r.kind === 'income' && r.period === PERIOD));
    // The phone is only ever sent UZS figures, so the rows open in UZS.
    assert.ok(rows.every(r => r.currency === 'UZS'));
    assert.ok(rows.find(r => r.tenant === 'Apteka').amount.replace(/\s/g, '').startsWith('1000000'));

    // Pressing it twice does not double the sheet.
    await page.click('#mBulkFill');
    assert.strictEqual(await rowCount(page), 2);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  // ------------------------------------------------------------ what lands

  test('a mixed sheet is stored as the rows it describes, attributed to the phone', async () => {
    const { page, context, backend, pageErrors } = await openOmad();
    await openBulk(page);

    await page.click('#mBulkAdd');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'Ijara' });
    await page.click('#mBulkAdd');
    await fillRow(page, 1, { kind: 'expense', tenant: 'Umumiy Naqd Puldan', period: PERIOD, amount: 150000, comment: 'Suv' });
    await page.click('#mBulkAdd');
    await fillRow(page, 2, { kind: 'tenant_paid', tenant: 'Salon', period: PERIOD, amount: 300000, comment: 'Elektrik' });

    await saveAndSettle(page);
    await page.waitForFunction(() => !document.getElementById('mBulkSubmit'), { timeout: 5000 });

    const stored = storedRows(backend);
    assert.strictEqual(stored.length, 4, 'three entries, four rows');
    assert.ok(stored.every(r => r.Created_By === 'miniapp'), 'attributed to the verified identity');
    assert.ok(stored.every(r => r.Source === 'Telegram'));

    // Each entry is its own group; the pair's two rows share one.
    assert.strictEqual(new Set(stored.map(r => r.Entry_Group_ID)).size, 3);

    // The pair moves no cash: both halves froze the same converted value.
    const pair = stored.filter(r => r.Entry_Kind === 'tenant_paid_expense');
    assert.strictEqual(pair.length, 2);
    assert.strictEqual(Number(pair[0].Amount_UZS) - Number(pair[1].Amount_UZS), 0);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a row keeps the month it was given', async () => {
    const { page, context, backend } = await openOmad();
    await openBulk(page);

    await page.click('#mBulkAdd');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PREVIOUS, amount: 500000, comment: 'Qarz' });
    await page.click('#mBulkAdd');
    await fillRow(page, 1, { kind: 'income', tenant: 'Salon', period: PERIOD, amount: 800000, comment: 'Joriy' });

    await saveAndSettle(page);

    const stored = storedRows(backend);
    const older = stored.find(r => r.Period === PREVIOUS);
    const now = stored.find(r => r.Period === PERIOD);
    assert.ok(older && now, 'both months landed from one submit');
    // Each froze its own month's rate.
    assert.strictEqual(Number(older.Rate_Sell), 11500);
    assert.strictEqual(Number(now.Rate_Sell), 12500);
    await context.close();
  });

  test('every entry gets its own Telegram card', async () => {
    const { page, context, backend } = await openOmad();
    await openBulk(page);
    await page.click('#mBulkFill');
    await saveAndSettle(page);

    // The flush is fire-and-forget, so it is waited for here rather than
    // assumed. One card per business action, not one for the lot.
    await page.waitForFunction(() => true);
    const deadline = Date.now() + 5000;
    while (backend.__sentMessages.length < 2 && Date.now() < deadline) {
      await page.waitForTimeout(50);
    }
    assert.strictEqual(backend.__sentMessages.length, 2);
    await context.close();
  });

  // --------------------------------------------------------------- refusals

  test('an incomplete row is refused on the phone and nothing is sent', async () => {
    const { page, context, backend, sent } = await openOmad();
    await openBulk(page);

    await page.click('#mBulkAdd');
    await fillRow(page, 0, { kind: 'tenant_paid', tenant: 'Apteka', period: PERIOD, amount: 300000, comment: '' });
    await page.click('#mBulkSubmit');
    await page.waitForTimeout(200);

    assert.strictEqual(sent.filter(p => p.action === 'mini_bulk_entry').length, 0);
    assert.strictEqual(storedRows(backend).length, 0);
    assert.strictEqual(await rowCount(page), 1, 'the row is still there to fix');
    await context.close();
  });

  // ------------------------------------------------- immutable once saving

  test('editing the sheet mid-save changes nothing about what was sent', async () => {
    const { page, context, backend, sent, release, issued } = await openOmad({ hold: true });
    await openBulk(page);

    await page.click('#mBulkAdd');
    await fillRow(page, 0, { kind: 'income', tenant: 'Apteka', period: PERIOD, amount: 1000000, comment: 'Ijara' });
    await page.click('#mBulkAdd');
    await fillRow(page, 1, { kind: 'income', tenant: 'Salon', period: PERIOD, amount: 800000, comment: 'Ijara' });

    await page.click('#mBulkSubmit');
    assert.strictEqual(await issued(1), 1);

    await page.evaluate(() => {
      addBulkRow({ kind: 'income', tenant: 'Apteka', amount: 999999 });
      const first = document.querySelector('.bulk-row .bulk-amount');
      if (first) { first.value = '1'; first.dispatchEvent(new Event('input', { bubbles: true })); }
      const remove = document.querySelectorAll('.bulk-row .btn-sm');
      if (remove[1]) remove[1].click();
      submitBulk();
    });

    await release();
    await page.waitForFunction(() => !miniBulkSaveInFlight);

    const bulks = sent.filter(p => p.action === 'mini_bulk_entry');
    assert.strictEqual(bulks.length, 1, 'one request, however hard the sheet was poked');
    assert.deepStrictEqual(bulks[0].entries.map(e => e.amount), [1000000, 800000]);
    assert.strictEqual(storedRows(backend).length, 2);
    await context.close();
  });

  // ------------------------------------------------------------- narrow phone

  test('the sheet is usable on a 320px screen', async () => {
    const { page, context, pageErrors } = await openOmad({ viewport: { width: 320, height: 640 } });
    await openBulk(page);
    await page.click('#mBulkFill');

    // Nothing overflows sideways: a form whose fields run off the edge of the
    // screen cannot be filled in, however correct the code behind it is.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px`);

    const wide = await page.$$eval('.bulk-row *', nodes =>
      nodes.filter(n => n.getBoundingClientRect().right > 321).length);
    assert.strictEqual(wide, 0, 'every control is inside the screen');

    // The footer stays reachable: the body scrolls, the actions do not.
    assert.strictEqual(await page.isVisible('#mBulkSubmit'), true);
    const submit = await page.$eval('#mBulkSubmit', el => el.getBoundingClientRect());
    assert.ok(submit.bottom <= 640, 'the save button is on screen without scrolling to it');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });
});
