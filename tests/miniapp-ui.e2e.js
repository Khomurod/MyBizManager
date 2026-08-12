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

/**
 * The fixtures are produced by the real backend, not written by hand.
 *
 * They used to be literals, and they drifted: they described `view.overdue`
 * and `task.streak`, which buildTaskViews_ has never returned. The browser
 * tests passed against a shape the server does not produce, which is the
 * opposite of what a UI test is for.
 *
 * So a real backend is booted here in the harness, seeded with deterministic
 * data, and its actual responses are what the stubbed transport returns. The
 * browser talks to real server logic; only the network hop is faked.
 */
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');
const crypto = require('crypto');

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid', username: 'boss' })
  };
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

function todayKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function yesterdayKey() {
  const d = new Date(Date.now() - 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const TASKS_HEADER = [
  'ID', 'Type', 'Title', 'Description', 'Responsible', 'Priority', 'Photo_Required',
  'Recurrence_JSON', 'Reminder_Times_JSON', 'Remind_Daily', 'Due_Time',
  'Deadline_Key', 'Deadline_Time', 'Start_Key', 'End_Key', 'Status', 'Steps_JSON',
  'Created_At', 'Updated_At', 'Created_By', 'Meta_JSON'
];

/** Cash 1 200 000 + bank 800 000 = the 2 000 000 total the Omad test reads. */
function bootBackend() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: 'mini-ui-key',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_TASKS_GROUP_CHAT_ID: '-1005555555555'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
          { name: 'Tehnopark', defaultRent: 500000, currency: 'UZS', active: true }
        ])],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 1000000 })],
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Kola 1', type: 'product', qty: 2, unit: 'dona', unitCost: 6000, totalCost: 12000 },
          { id: 'i2', name: 'Choy', type: 'product', qty: 40, unit: 'dona', unitCost: 3000, totalCost: 120000 }
        ])]
      ],
      Omad_Transactions: [LEGACY_HEADER,
        ['1800000000000_0', 'Apteka', '2026-08', 'Income', 1200000, 'UZS', 'Naqd', '11/08/2026',
          'ijara', '', 'req_1', 'grp_plain', ''],
        ['1800000000001_0', 'Tehnopark', '2026-08', 'Income', 800000, 'UZS', 'Bank', '12/08/2026',
          'ijara', '', 'req_2', 'grp_bank', ''],
        ['1800000000002_0', 'Apteka', '2026-08', 'Income', 240000, 'UZS', 'Naqd', '12/08/2026',
          "Ijarachi bizning nomimizdan to'ladi: Elektrik", '', 'req_3_0', 'grp_paid', 'tenant_paid_expense'],
        ['1800000000002_1', 'Umumiy Naqd Puldan', '2026-08', 'Expense', 240000, 'UZS', 'Naqd', '12/08/2026',
          "Elektrik (to'lovchi: Apteka)", '', 'req_3_1', 'grp_paid', 'tenant_paid_expense']
      ],
      Tasks: [TASKS_HEADER],
      // Today's date, because the café summary buckets by the script's own
      // "today" -- a literal date would make this test pass only once.
      Cafe_Sales: [
        ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID'],
        [todayKey(), 'cafe_admin', 241000, 56459, '[]', 's1']
      ],
      Cafe_Kun_Yakuni: [
        ['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Tafsilot'],
        [yesterdayKey(), 'cafe_seller', 900000, 210000, '[]']
      ]
    }
  });
}

const backend = bootBackend();
const VALID_INIT_DATA = signedInitData();

function callBackend(payload) {
  return readJsonOutput(backend.doPost(postEvent(
    Object.assign({}, payload, { initData: VALID_INIT_DATA }))));
}

// Two tasks the tests look for by name, created through the real engine.
callBackend({
  action: 'mini_task_action', taskAction: 'save_task',
  type: 'once', title: 'Bugungi ish', priority: 'normal'
});
callBackend({
  action: 'mini_task_action', taskAction: 'save_task',
  type: 'routine', title: 'Har kungi tekshiruv',
  recurrence: { freq: 'daily', interval: 1 }
});
callBackend({
  action: 'mini_task_action', taskAction: 'save_task',
  type: 'goal', title: 'Yangi filial',
  steps: [{ title: 'Bir' }, { title: 'Ikki' }, { title: 'Uch' }, { title: "To'rt" }]
});

const HOME = callBackend({ action: 'mini_home', period: '2026-08' });
const TASKS = callBackend({ action: 'mini_tasks' });

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

  // Anything not explicitly overridden is answered by the real backend, so a
  // response shape the server does not actually produce cannot pass here.
  const realHandler = payload => callBackend(payload);
  const defaultHandlers = {
    mini_home: realHandler, mini_omad: realHandler,
    mini_cafe: realHandler, mini_tasks: realHandler
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
    // A real occurrence id from the engine, not a literal invented here.
    const dueToday = (TASKS.view.today.needsAttention || []).map(o => o.id);
    assert.ok(dueToday.indexOf(completed.occurrenceId) !== -1,
      'the id sent belongs to an occurrence the server actually returned');

    await context.close();
  });

  test('the overdue filter shows what the server put in the overdue list', async () => {
    const overdue = TASKS.view.today.overdue || [];
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.locator('#nav-tasks').click();
    await page.waitForFunction(() => document.getElementById('tab-tasks').innerText.includes('Bugungi ish'));

    await page.locator('button[role="tab"]:has-text("Muddati")').click();

    // The counts come from view.counts and the rows from view.today.overdue.
    // Reading them off the root -- which the client used to do -- showed an
    // empty tab here whatever the server said.
    const shown = await page.locator('#tab-tasks').innerText();
    if (overdue.length) {
      await page.waitForFunction(
        title => document.getElementById('tab-tasks').innerText.includes(title),
        overdue[0].title);
    } else {
      assert.ok(shown.includes("bo'sh"), 'an empty list says so rather than showing stale rows');
    }

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
