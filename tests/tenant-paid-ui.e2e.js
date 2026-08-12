'use strict';

/**
 * The tenant-paid entry mode, in a real browser.
 *
 * The user performs ONE operation. What is pinned here is that the mode sends
 * exactly one request carrying one group id, that a second click cannot send a
 * second one, that the pair comes back as a single history card, and that
 * editing it edits the pair rather than one half.
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

const RATES = { '2026-08': { buy: 12000, sell: 12500 } };
const TENANTS = [{
  name: 'Apteka', rent: 1000000, defaultRent: 1000000, currency: 'UZS', active: true,
  startPeriod: '', endPeriod: '', rentChanges: [], exceptions: [], noRentPeriods: [], disabledMonths: []
}];

/** The pair the server would have stored, in the shape a read returns. */
function storedPair(groupId, amount = 1000000, purpose = 'Elektrik xizmati') {
  const common = {
    month: '2026-08', period: '2026-08', periodLabel: 'Avgust 2026', periodSource: 'canonical',
    amount, currency: 'UZS', method: 'Naqd', date: '12/08/2026',
    msgId: '', requestId: '', groupId, entryKind: 'tenant_paid_expense'
  };
  return [
    Object.assign({ id: '1800000000000_0', tenant: 'Apteka', type: 'Income', comment: "Ijarachi bizning nomimizdan to'ladi: " + purpose }, common),
    Object.assign({ id: '1800000000000_1', tenant: 'Umumiy Naqd Puldan', type: 'Expense', comment: purpose + " (to'lovchi: Apteka)" }, common)
  ];
}

describe('Tenant-paid expenses are one operation in the browser', () => {
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

  async function openAdmin(options = {}) {
    const posts = [];
    let transactions = options.transactions || [];

    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
    });

    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ transactions, tenants: TENANTS, rates: RATES, templateExpenses: [] })
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

      posts.push(payload);
      if (payload.action === 'tenant_paid_expense') {
        // The server would now hold the pair; later reads must see it.
        transactions = storedPair(payload.groupId, payload.amount, payload.comment);
        if (options.saveHandler) return options.saveHandler(payload, route);
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', duplicate: false, groupId: payload.groupId, transactions })
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' }) });
    });

    const page = await context.newPage();
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    const alerts = [];
    page.on('dialog', d => { alerts.push(d.message()); d.accept().catch(() => {}); });
    return { page, context, posts, alerts };
  }

  async function fillTenantPaid(page, { amount = '1 000 000', purpose = 'Elektrik xizmati' } = {}) {
    await page.evaluate(({ amount, purpose }) => {
      switchTab('entry');
      setType('TenantPaid');
      document.getElementById('entryMonth').value = '2026-08';
      document.getElementById('entryTenant').value = 'Apteka';
      document.getElementById('tempAmount').value = amount;
      document.getElementById('tempCurr').value = 'UZS';
      document.getElementById('tempMethod').value = 'Naqd';
      document.getElementById('entryComment').value = purpose;
    }, { amount, purpose });
  }

  test('the mode hides the cart and offers only real tenants', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => { switchTab('entry'); setType('TenantPaid'); });

    const state = await page.evaluate(() => ({
      addHidden: document.getElementById('addToCartBtn').classList.contains('hidden'),
      noteShown: !document.getElementById('tenantPaidNote').classList.contains('hidden'),
      options: [...document.getElementById('entryTenant').options].map(o => o.value)
    }));

    assert.equal(state.addHidden, true, 'the pair is 1:1, so there is no cart');
    assert.equal(state.noteShown, true, 'the zero cash impact is explained up front');
    assert.deepEqual(state.options, ['Apteka'], 'an expense bucket has no balance to credit');

    await context.close();
  });

  test('one save sends exactly one request, carrying one group id', async () => {
    const { page, context, posts } = await openAdmin();
    await fillTenantPaid(page);
    await page.click('#submitBtn');
    await page.waitForFunction(() => app.transactions.length === 2);

    const entries = posts.filter(p => p.action === 'tenant_paid_expense');
    assert.equal(entries.length, 1, 'one business action, one request');
    assert.equal(entries[0].tenant, 'Apteka');
    assert.equal(entries[0].amount, 1000000);
    assert.equal(entries[0].comment, 'Elektrik xizmati');
    assert.ok(entries[0].groupId, 'a group id is minted client-side');
    assert.ok(entries[0].requestId);
    assert.equal(entries[0].replaceGroupId, '', 'a new entry replaces nothing');

    await context.close();
  });

  test('a second click while the first is in flight cannot create a second pair', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });

    const { page, context, posts } = await openAdmin({
      saveHandler: async (payload, route) => {
        await held;
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', duplicate: false, groupId: payload.groupId, transactions: storedPair(payload.groupId) })
        });
      }
    });

    await fillTenantPaid(page);
    await page.evaluate(() => { document.getElementById('submitBtn').click(); });
    await page.waitForFunction(() => document.getElementById('submitBtn').disabled === true);
    await page.evaluate(() => { document.getElementById('submitBtn').click(); });

    release();
    await page.waitForFunction(() => app.transactions.length === 2);

    assert.equal(posts.filter(p => p.action === 'tenant_paid_expense').length, 1);
    await context.close();
  });

  test('a refused save keeps the form and the ids so it can simply be sent again', async () => {
    const { page, context, posts, alerts } = await openAdmin({
      saveHandler: async (payload, route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'Chiqim maqsadini kiriting.' })
        });
      }
    });

    await fillTenantPaid(page);
    await page.click('#submitBtn');
    await page.waitForFunction(() => document.getElementById('submitBtn').disabled === false);

    assert.ok(alerts.some(a => a.includes('maqsadini')), 'the reason is shown');
    const kept = await page.evaluate(() => ({
      amount: document.getElementById('tempAmount').value,
      comment: document.getElementById('entryComment').value
    }));
    assert.ok(kept.amount, 'what was typed survives');
    assert.equal(kept.comment, 'Elektrik xizmati');

    // Sending again reuses both ids, so the server recognises the retry.
    await page.click('#submitBtn');
    await page.waitForFunction(() => document.getElementById('submitBtn').disabled === false);
    const entries = posts.filter(p => p.action === 'tenant_paid_expense');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].groupId, entries[1].groupId);
    assert.equal(entries[0].requestId, entries[1].requestId);

    await context.close();
  });

  test('history shows the pair as one card, not two rows', async () => {
    const { page, context } = await openAdmin({ transactions: storedPair('grp_pair_1') });
    await page.evaluate(() => { switchTab('history'); renderHistory(); });

    const cards = await page.evaluate(() =>
      [...document.getElementById('historyList').children].map(el => el.innerText));

    assert.equal(cards.length, 1, 'two rows, one business action, one card');
    assert.ok(cards[0].includes('Apteka'));
    assert.ok(cards[0].includes("Bizning nomimizdan to'ladi"));
    assert.ok(cards[0].includes('kassaga 0'));

    await context.close();
  });

  test('an ordinary entry is still shown per row', async () => {
    const { page, context } = await openAdmin({
      transactions: [{
        id: '1800000000001_0', tenant: 'Apteka', month: '2026-08', period: '2026-08',
        periodLabel: 'Avgust 2026', type: 'Income', amount: 500000, currency: 'UZS',
        method: 'Naqd', date: '12/08/2026', comment: 'ijara', msgId: '', requestId: '',
        groupId: 'grp_plain', entryKind: ''
      }]
    });
    await page.evaluate(() => { switchTab('history'); renderHistory(); });

    const cards = await page.evaluate(() =>
      [...document.getElementById('historyList').children].map(el => el.innerText));
    assert.equal(cards.length, 1);
    assert.ok(!cards[0].includes("Bizning nomimizdan"));

    await context.close();
  });

  test('editing the pair reopens it as a pair and replaces the whole group', async () => {
    const { page, context, posts } = await openAdmin({ transactions: storedPair('grp_pair_1') });

    await page.evaluate(() => { switchTab('history'); renderHistory(); editTx('1800000000000_0'); });

    const form = await page.evaluate(() => ({
      mode: currentType,
      tenant: document.getElementById('entryTenant').value,
      comment: document.getElementById('entryComment').value,
      group: editingTenantPaidGroupId
    }));
    assert.equal(form.mode, 'TenantPaid', 'it never opens in the ordinary form');
    assert.equal(form.tenant, 'Apteka');
    assert.equal(form.comment, 'Elektrik xizmati', 'the stored suffix is stripped back off');
    assert.equal(form.group, 'grp_pair_1');

    await page.evaluate(() => { document.getElementById('tempAmount').value = '750 000'; });
    await page.click('#submitBtn');
    await page.waitForFunction(() => app.transactions.some(t => t.amount === 750000));

    const entry = posts.filter(p => p.action === 'tenant_paid_expense').pop();
    assert.equal(entry.replaceGroupId, 'grp_pair_1', 'the whole group is replaced');
    assert.equal(entry.amount, 750000);

    await context.close();
  });

  test('cancelling the pair says both halves are going', async () => {
    const { page, context, alerts } = await openAdmin({ transactions: storedPair('grp_pair_1') });
    await page.evaluate(() => { switchTab('history'); renderHistory(); });
    await page.evaluate(() => deleteTx('1800000000000_0'));
    await page.waitForFunction(() => app.transactions.length === 0);

    assert.ok(alerts.some(a => a.includes('chiqim birga')), 'the confirmation names both halves');
    await context.close();
  });

  test('switching back to an ordinary type restores the cart', async () => {
    const { page, context } = await openAdmin();
    await page.evaluate(() => { switchTab('entry'); setType('TenantPaid'); setType('Expense'); });

    const state = await page.evaluate(() => ({
      addHidden: document.getElementById('addToCartBtn').classList.contains('hidden'),
      noteHidden: document.getElementById('tenantPaidNote').classList.contains('hidden'),
      options: [...document.getElementById('entryTenant').options].map(o => o.value)
    }));

    assert.equal(state.addHidden, false);
    assert.equal(state.noteHidden, true);
    assert.ok(state.options.includes('Umumiy Naqd Puldan'));

    await context.close();
  });
});
