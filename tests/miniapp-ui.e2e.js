'use strict';

/**
 * The Mini App in a real browser.
 *
 * The gate is the important part: with no Telegram bridge, or with a backend
 * that refuses, the page must show one sentence and no application — no tabs,
 * no navigation, and no request for data.
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

const HOME = {
  status: 'success',
  authorized: true,
  user: { id: '49328655', firstName: 'Xurshid', username: 'boss' },
  omad: {
    period: '2026-08', periodLabel: 'Avgust 2026',
    income: 5000000, expense: 2000000, net: 3000000,
    cash: 1200000, bank: 800000, total: 2000000,
    tenantDebt: 750000, tenantCount: 3, tenantsSettled: 2,
    rate: { buy: 12000, sell: 12500 }, ledgerActive: false
  },
  cafe: {
    today: { revenue: 241000, profit: 56459, sales: 3 },
    month: { revenue: 1400000, profit: 320000, sales: 18, label: '2026-08' },
    target: { daily: 1000000, progress: 24 },
    inventory: { value: 3500000, items: 17, lowStock: [{ name: 'Kola 1', qty: 2, unit: 'dona' }] },
    recentSales: [{ id: 's1', date: '2026-08-12', seller: 'cafe_admin', total: 241000, profit: 56459, items: 11 }],
    recentClosings: [{ date: '2026-08-11', seller: 'cafe_seller', revenue: 900000, profit: 210000 }]
  },
  tasks: { overdue: 1, today: 2, upcoming: 3, waitingProof: 0, completedToday: 1 }
};

const OMAD_DETAIL = {
  status: 'success', authorized: true,
  omad: HOME.omad,
  tenants: [
    { name: 'Apteka', expected: 1000000, paid: 250000, debt: 750000, surplus: 0 },
    { name: 'Tehnopark', expected: 500000, paid: 500000, debt: 0, surplus: 0 }
  ],
  transactions: [
    { groupId: 'g1', id: '1800000000001_0', kind: 'tenant_paid_expense', type: 'Income',
      tenant: 'Apteka', period: '2026-08', periodLabel: 'Avgust 2026', date: '12/08/2026',
      amountUZS: 1000000, currency: 'UZS', amount: 1000000, lines: 2, comment: 'Elektrik xizmati' },
    { groupId: 'g2', id: '1800000000000_0', kind: '', type: 'Income',
      tenant: 'Tehnopark', period: '2026-08', periodLabel: 'Avgust 2026', date: '11/08/2026',
      amountUZS: 500000, currency: 'UZS', amount: 500000, lines: 1, comment: 'ijara' }
  ]
};

const TASKS = {
  status: 'success', authorized: true,
  view: {
    overdue: [{ id: 'occ1', taskId: 't1', title: 'Kechikkan ish', dateKey: '2026-08-10', priority: 'high', status: 'Open', displayStatus: 'Overdue', photoRequired: false, responsible: 'Ali' }],
    dueToday: [{ id: 'occ2', taskId: 't2', title: 'Bugungi ish', dateKey: '2026-08-12', priority: 'normal', status: 'Open', displayStatus: 'Open', photoRequired: true, responsible: '' }],
    upcoming: [], waitingProof: [], completedToday: [],
    tasks: [
      { id: 't3', type: 'routine', title: 'Har kungi tekshiruv', status: 'active', streak: 4 },
      { id: 't4', type: 'goal', title: 'Yangi filial', stepCount: 4, stepsCompleted: 1 }
    ]
  },
  config: { tasksGroupConfigured: true }
};

describe('The Telegram Mini App', () => {
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
   * @param initData what Telegram would hand the page. "" means the page was
   *        opened in an ordinary browser.
   * @param handlers action -> response body, or a function.
   */
  async function openMini(initData, handlers = {}) {
    const calls = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

    await context.addInitScript(data => {
      // A minimal stand-in for the real bridge. Only what the app touches.
      window.Telegram = {
        WebApp: {
          initData: data,
          initDataUnsafe: { user: { id: 999999, first_name: 'Forged' } },
          ready() {}, expand() {}, setHeaderColor() {}, disableVerticalSwipes() {},
          HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
          BackButton: { show() {}, hide() {} },
          onEvent() {}, offEvent() {}
        }
      };
    }, initData);

    // The page loads Telegram's WebApp SDK from telegram.org. The bridge is
    // stubbed above, so the real script is not needed — but the request still
    // goes out, and waiting on it made every test take as long as the network
    // did. Blocking it keeps the suite hermetic and fast.
    await context.route('**telegram.org/**', route => route.abort());

    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      calls.push(payload);

      const handler = handlers[payload.action];
      const body = typeof handler === 'function' ? handler(payload) : handler;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(body || { status: 'error', message: 'Unknown action' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/mini.html`);
    return { page, context, calls, pageErrors };
  }

  const defaultHandlers = {
    mini_home: HOME, mini_omad: OMAD_DETAIL, mini_cafe: { status: 'success', authorized: true, cafe: HOME.cafe },
    mini_tasks: TASKS
  };

  // ------------------------------------------------------------------ gate

  test('opened outside Telegram it shows one sentence and asks for nothing', async () => {
    const { page, context, calls } = await openMini('');

    await page.waitForFunction(() => document.getElementById('gateText').textContent.includes('Telegram bot orqali'));
    assert.equal(calls.length, 0, 'no request is made without a signature');
    assert.equal(await page.locator('#app').isHidden(), true);
    assert.equal(await page.locator('#nav').isHidden(), true);

    await context.close();
  });

  test('a backend refusal shows the refusal, not a broken app', async () => {
    const { page, context } = await openMini('auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef', {
      mini_home: { status: 'error', authorized: false, reason: 'not_authorized', message: "⛔️ Sizda bu ilovadan foydalanish huquqi yo'q." }
    });

    await page.waitForFunction(() => document.getElementById('gateText').textContent.includes('huquqi'));
    assert.equal(await page.locator('#app').isHidden(), true);
    assert.equal(await page.locator('#nav').isHidden(), true);

    await context.close();
  });

  test('a stale session offers a retry; a refusal does not', async () => {
    const stale = await openMini('auth_date=1&hash=x', {
      mini_home: { status: 'error', authorized: false, reason: 'stale', message: 'Sessiya muddati tugadi. Ilovani qaytadan oching.' }
    });
    await stale.page.waitForFunction(() => !document.getElementById('gateRetry').classList.contains('hidden'));
    await stale.context.close();

    const refused = await openMini('auth_date=1&hash=x', {
      mini_home: { status: 'error', authorized: false, reason: 'not_authorized', message: 'yo\'q' }
    });
    await refused.page.waitForFunction(() => document.getElementById('gateText').textContent.includes('yo'));
    assert.equal(await refused.page.locator('#gateRetry').isHidden(), true);
    await refused.context.close();
  });

  test('initDataUnsafe is never sent, and the signed string is sent verbatim', async () => {
    const initData = 'auth_date=1770000000&user=%7B%22id%22%3A49328655%7D&hash=abc123';
    const { page, context, calls } = await openMini(initData, defaultHandlers);

    await page.waitForSelector('#nav:not(.hidden)');
    assert.equal(calls[0].initData, initData);
    const dump = JSON.stringify(calls);
    assert.ok(!dump.includes('999999'), 'the unsigned copy never leaves the page');
    assert.ok(!dump.includes('adminKey'), 'the Mini App holds no admin key');

    await context.close();
  });

  // ------------------------------------------------------------------ omad

  test('the authorized user lands on Omad with the figures the server computed', async () => {
    const { page, context, pageErrors } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForSelector('#nav:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    const text = await page.locator('#tab-omad').innerText();
    assert.ok(text.includes('Avgust 2026'));
    assert.ok(text.includes('2 000 000'.replace(/ /g, ' ')) || text.includes('2 000 000'));
    assert.ok(text.includes('Apteka'));
    assert.ok(text.includes("Ijarachi to'ladi"), 'a tenant-paid entry is labelled as one');
    assert.deepEqual(pageErrors, []);

    await context.close();
  });

  test('one round trip paints the first screen', async () => {
    const { page, context, calls } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForSelector('#nav:not(.hidden)');

    // mini_home alone is enough to show the app; mini_omad only fills in the
    // lists afterwards.
    assert.equal(calls[0].action, 'mini_home');
    await context.close();
  });

  test('changing the month asks the server rather than recomputing anything', async () => {
    const { page, context, calls } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    await page.locator('button[aria-label="Oldingi oy"]').click();
    await page.waitForFunction(() =>
      window.__seen === undefined && document.getElementById('tab-omad').innerText.length > 0);

    const periods = calls.filter(c => c.action === 'mini_omad').map(c => c.period);
    assert.ok(periods.includes('2026-07'), 'the previous month is requested from the server');

    await context.close();
  });

  test('an income is one request carrying a stable request id and group id', async () => {
    const { page, context, calls } = await openMini('auth_date=1&hash=x', Object.assign({}, defaultHandlers, {
      mini_save_transaction: { status: 'success', authorized: true, duplicate: false, transaction: {} }
    }));
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    await page.locator('button:has-text("Kirim")').first().click();
    await page.waitForSelector('#mAmount');
    await page.fill('#mAmount', '500000');
    await page.fill('#mComment', 'ijara');
    await page.locator('#mSubmit').click();
    await page.waitForFunction(() => !document.querySelector('.sheet'));

    const saves = calls.filter(c => c.action === 'mini_save_transaction');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].amount, 500000);
    assert.equal(saves[0].type, 'Income');
    assert.equal(saves[0].period, '2026-08');
    assert.ok(saves[0].requestId && saves[0].groupId);

    await context.close();
  });

  test('a refused save keeps the sheet open so nothing typed is lost', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', Object.assign({}, defaultHandlers, {
      mini_save_transaction: { status: 'error', message: 'Summa juda katta.' }
    }));
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    await page.locator('button:has-text("Kirim")').first().click();
    await page.fill('#mAmount', '500000');
    await page.locator('#mSubmit').click();
    await page.waitForSelector('.toast.bad');

    assert.ok(await page.locator('.sheet').isVisible(), 'the form stays open');
    assert.ok((await page.inputValue('#mAmount')).length > 0, 'what was typed survives');

    await context.close();
  });

  test('the tenant-paid sheet sends one request with the purpose', async () => {
    const { page, context, calls } = await openMini('auth_date=1&hash=x', Object.assign({}, defaultHandlers, {
      mini_tenant_paid: { status: 'success', authorized: true, duplicate: false, groupId: 'g', transactions: [] }
    }));
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    await page.locator('button:has-text("Ijarachi")').first().click();
    await page.waitForSelector('#mComment');
    await page.fill('#mAmount', '1000000');
    await page.fill('#mComment', 'Elektrik xizmati');
    await page.locator('#mSubmit').click();
    await page.waitForFunction(() => !document.querySelector('.sheet'));

    const pairs = calls.filter(c => c.action === 'mini_tenant_paid');
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].amount, 1000000);
    assert.equal(pairs[0].comment, 'Elektrik xizmati');

    await context.close();
  });

  // ------------------------------------------------------------ cafe & tasks

  test('the café tab shows today, the month, the target and the stock', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForSelector('#nav:not(.hidden)');
    await page.locator('#nav-cafe').click();
    await page.waitForFunction(() => document.getElementById('tab-cafe').innerText.includes('Kunlik reja'));

    const text = await page.locator('#tab-cafe').innerText();
    assert.ok(text.includes('241'), 'today revenue');
    assert.ok(text.includes('24%'), 'target progress');
    assert.ok(text.includes('Kola 1'), 'low stock');
    assert.ok(text.includes('Kun yakunlari'));

    await context.close();
  });

  test('the tasks tab lists occurrences and acts through the shared engine', async () => {
    let completed = null;
    const { page, context } = await openMini('auth_date=1&hash=x', Object.assign({}, defaultHandlers, {
      mini_task_action: payload => {
        completed = payload;
        return { status: 'success', authorized: true, view: TASKS.view };
      }
    }));
    await page.waitForSelector('#nav:not(.hidden)');
    await page.locator('#nav-tasks').click();
    await page.waitForFunction(() => document.getElementById('tab-tasks').innerText.includes('Bugungi ish'));

    const text = await page.locator('#tab-tasks').innerText();
    assert.ok(text.includes('Odatlar'), 'routines are listed');
    assert.ok(text.includes('Maqsadlar'), 'goals are listed');

    await page.locator('button:has-text("Bajarildi")').first().click();
    await page.waitForSelector('.toast');
    assert.equal(completed.taskAction, 'complete_occurrence');
    assert.equal(completed.occurrenceId, 'occ2');

    await context.close();
  });

  test('the overdue filter shows the overdue occurrence', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.locator('#nav-tasks').click();
    await page.waitForFunction(() => document.getElementById('tab-tasks').innerText.includes('Bugungi ish'));

    await page.locator('button[role="tab"]:has-text("Muddati")').click();
    await page.waitForFunction(() => document.getElementById('tab-tasks').innerText.includes('Kechikkan ish'));

    await context.close();
  });

  // ------------------------------------------------------------------ layout

  test('nothing overflows sideways on a small phone', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    for (const tab of ['omad', 'cafe', 'tasks']) {
      await page.locator(`#nav-${tab}`).click();
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${tab} overflows by ${overflow}px at 320px`);
    }

    await context.close();
  });

  test('every tappable control is at least 36px tall', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForFunction(() => document.getElementById('miniTenantList'));

    const small = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ text: b.innerText.slice(0, 20), height: Math.round(b.getBoundingClientRect().height) }))
      .filter(b => b.height < 36));

    assert.deepEqual(small, []);
    await context.close();
  });

  test('the palette follows Telegram rather than being hardcoded', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.waitForSelector('#nav:not(.hidden)');

    // With Telegram's variables set, the page must adopt them.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--tg-theme-bg-color', 'rgb(17, 17, 17)');
      document.documentElement.style.setProperty('--tg-theme-text-color', 'rgb(240, 240, 240)');
    });
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { bg: style.backgroundColor, text: style.color };
    });

    assert.equal(colors.bg, 'rgb(17, 17, 17)');
    assert.equal(colors.text, 'rgb(240, 240, 240)');
    await context.close();
  });
});
