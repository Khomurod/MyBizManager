'use strict';

/**
 * The tenant rent-schedule editor in a real browser.
 *
 * The UI must make the effective rent for every month obvious, and every edit
 * must round-trip through a save.
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

async function waitForRequest(requests, action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = requests.filter(r => r.action === action).pop();
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for a ${action} request`);
}

const TENANT = {
  name: 'Tehnopark',
  defaultRent: 500,
  currency: 'USD',
  active: true,
  startPeriod: '2026-01',
  endPeriod: '',
  exceptions: [{ period: '2026-12', amount: 200 }],
  noRentPeriods: [],
  rentChanges: [{ fromPeriod: '2027-01', amount: 600 }],
  disabledMonths: []
};

describe('Tenant schedules (browser)', () => {
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

  async function openTenants(tenants = [TENANT]) {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
      localStorage.setItem('omad_access_key', 'e2e-access-key');
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            transactions: [], tenants,
            rates: { '2026-12': { buy: 12800, sell: 13000 }, '2027-01': { buy: 13000, sell: 13500 } },
            templateExpenses: []
          })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(payload.action === 'get_migration_status'
          ? { status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } }
          : { status: 'success' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.tenants.length > 0);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await page.click('#nav-settings');
    await page.evaluate(() => showSettingsSection('tenants'));
    return { page, context, requests, pageErrors };
  }

  test('the tenant card shows the agreement window and this month’s rent', async () => {
    const { page, context, pageErrors } = await openTenants();

    const card = await page.evaluate(() => document.getElementById('settingsTenantList').textContent);
    assert.match(card, /Tehnopark/);
    assert.match(card, /Yan 2026/, 'the start of the agreement is shown');
    assert.match(card, /muddatsiz/, 'an open-ended agreement says so');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the schedule shows the effective rent for every month of a year', async () => {
    const { page, context } = await openTenants();

    const rows = await page.evaluate(() => {
      openTenantSchedule(0);
      document.getElementById('scheduleYear').value = '2026';
      renderTenantSchedule();
      return [...document.querySelectorAll('#tenantScheduleList > div')].map(row => ({
        period: row.dataset.period,
        text: row.textContent.replace(/\s+/g, ' ').trim()
      }));
    });

    assert.strictEqual(rows.length, 12);
    assert.match(rows[0].text, /Yanvar.*500 USD/, rows[0].text);
    assert.match(rows[10].text, /Noyabr.*500 USD/, rows[10].text);
    assert.match(rows[11].text, /Dekabr.*200 USD/, rows[11].text);
    assert.match(rows[11].text, /Istisno/, 'the reason is shown');
    await context.close();
  });

  test('the next year picks up the scheduled rent change', async () => {
    const { page, context } = await openTenants();

    const january = await page.evaluate(() => {
      openTenantSchedule(0);
      document.getElementById('scheduleYear').value = '2027';
      renderTenantSchedule();
      return document.querySelector('#tenantScheduleList > div').textContent.replace(/\s+/g, ' ');
    });

    assert.match(january, /600 USD/);
    assert.match(january, /Yangi narx/);
    await context.close();
  });

  test('marking a month as no-rent saves and shows it', async () => {
    const { page, context, requests } = await openTenants();

    const after = await page.evaluate(() => {
      openTenantSchedule(0);
      document.getElementById('scheduleYear').value = '2026';
      renderTenantSchedule();
      toggleNoRentPeriod('2026-07');
      return {
        stored: app.tenants[0].noRentPeriods,
        row: [...document.querySelectorAll('#tenantScheduleList > div')]
          .find(r => r.dataset.period === '2026-07').textContent.replace(/\s+/g, ' ')
      };
    });

    assert.deepStrictEqual(after.stored, ['2026-07']);
    assert.match(after.row, /yo'q/);
    assert.match(after.row, /Ijara yo'q/);

    const save = await waitForRequest(requests, 'save_omad');
    assert.deepStrictEqual(save.tenants[0].noRentPeriods, ['2026-07']);
    await context.close();
  });

  test('a month exception is entered and persisted', async () => {
    const { page, context, requests } = await openTenants();

    await page.evaluate(() => {
      window.prompt = () => '250';
      openTenantSchedule(0);
      document.getElementById('scheduleYear').value = '2026';
      renderTenantSchedule();
      setTenantException('2026-08');
    });

    const save = await waitForRequest(requests, 'save_omad');
    const exception = save.tenants[0].exceptions.find(e => e.period === '2026-08');
    assert.strictEqual(exception.amount, 250);
    await context.close();
  });

  test('clearing an exception restores the default rent', async () => {
    const { page, context } = await openTenants();

    const rent = await page.evaluate(() => {
      window.prompt = () => '';
      openTenantSchedule(0);
      document.getElementById('scheduleYear').value = '2026';
      renderTenantSchedule();
      setTenantException('2026-12');
      return effectiveTenantRent(app.tenants[0], '2026-12');
    });

    assert.strictEqual(rent, 500);
    await context.close();
  });

  test('a future rent change is added and listed', async () => {
    const { page, context, requests } = await openTenants();

    const listed = await page.evaluate(() => {
      openTenantSchedule(0);
      document.getElementById('rentChangeFrom').value = '2028-01';
      document.getElementById('rentChangeAmount').value = '750';
      addTenantRentChange();
      return document.getElementById('rentChangeList').textContent.replace(/\s+/g, ' ');
    });

    assert.match(listed, /Yanvar 2028/);
    assert.match(listed, /750/);

    const save = await waitForRequest(requests, 'save_omad');
    assert.ok(save.tenants[0].rentChanges.some(c => c.fromPeriod === '2028-01' && c.amount === 750));
    await context.close();
  });

  test('an end period stops the rent without deleting the tenant', async () => {
    const { page, context } = await openTenants();

    const result = await page.evaluate(() => {
      editTenant(0);
      document.getElementById('newTenantEnd').value = '2026-06';
      addTenant();
      return {
        tenants: app.tenants.length,
        june: effectiveTenantRent(app.tenants[0], '2026-06'),
        july: effectiveTenantRent(app.tenants[0], '2026-07')
      };
    });

    assert.strictEqual(result.tenants, 1, 'the tenant is still there');
    assert.strictEqual(result.june, 500);
    assert.strictEqual(result.july, 0);
    await context.close();
  });

  test('an end period before the start is rejected', async () => {
    const { page, context } = await openTenants();

    const stored = await page.evaluate(() => {
      let warned = "";
      window.alert = message => { warned = message; };
      editTenant(0);
      document.getElementById('newTenantStart').value = '2026-06';
      document.getElementById('newTenantEnd').value = '2026-01';
      addTenant();
      return { warned, endPeriod: app.tenants[0].endPeriod };
    });

    assert.match(stored.warned, /oldin bo'lishi mumkin emas/);
    assert.strictEqual(stored.endPeriod, '', 'nothing was saved');
    await context.close();
  });

  test('deactivating keeps the tenant and reactivating restores the rent', async () => {
    const { page, context } = await openTenants();

    const result = await page.evaluate(() => {
      removeTenant(0);
      const afterDeactivate = {
        count: app.tenants.length,
        active: app.tenants[0].active,
        rent: effectiveTenantRent(app.tenants[0], '2026-05')
      };
      reactivateTenant(0);
      return {
        afterDeactivate,
        afterReactivate: {
          active: app.tenants[0].active,
          rent: effectiveTenantRent(app.tenants[0], '2026-05')
        }
      };
    });

    assert.strictEqual(result.afterDeactivate.count, 1, 'tenants are never deleted');
    assert.strictEqual(result.afterDeactivate.active, false);
    assert.strictEqual(result.afterDeactivate.rent, 0);
    assert.strictEqual(result.afterReactivate.active, true);
    assert.strictEqual(result.afterReactivate.rent, 500);
    await context.close();
  });

  test('a legacy tenant is migrated in place and keeps working', async () => {
    const { page, context } = await openTenants([
      { name: 'Bunyodbek', rent: 400, currency: 'USD', disabledMonths: ['Dekabr'] }
    ]);

    const result = await page.evaluate(() => ({
      defaultRent: app.tenants[0].defaultRent,
      rent: app.tenants[0].rent,
      may: effectiveTenantRent(app.tenants[0], '2026-05'),
      december: effectiveTenantRent(app.tenants[0], '2026-12'),
      startPeriod: app.tenants[0].startPeriod
    }));

    assert.strictEqual(result.defaultRent, 400);
    assert.strictEqual(result.rent, 400, 'the legacy field stays in step');
    assert.strictEqual(result.may, 400);
    assert.strictEqual(result.december, 0, 'the legacy disabled month is honoured');
    assert.strictEqual(result.startPeriod, '', 'no start means the agreement always applied');
    await context.close();
  });

  test('the schedule editor fits a 320px screen', async () => {
    const { page, context } = await openTenants();
    await page.setViewportSize({ width: 320, height: 720 });

    const overflowing = await page.evaluate(() => {
      openTenantSchedule(0);
      const card = document.getElementById('tenantScheduleCard');
      const cardRight = card.getBoundingClientRect().right;
      return [...card.querySelectorAll('input, select, button')]
        .map(el => ({ id: el.id || el.textContent.trim().slice(0, 12),
                      over: Math.round(el.getBoundingClientRect().right - cardRight) }))
        .filter(x => x.over > 1);
    });

    assert.deepStrictEqual(overflowing, []);
    await context.close();
  });
});

describe('Planned expenses (browser)', () => {
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

  async function openExpenses(templateExpenses = []) {
    const requests = [];
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
      localStorage.setItem('omad_access_key', 'e2e-access-key');
    });
    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      if (isOmadRead(request)) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            transactions: [], tenants: [],
            rates: { '2026-01': { buy: 12000, sell: 12500 } },
            templateExpenses
          })
        });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(payload.action === 'get_migration_status'
          ? { status: 'success', migration: { state: 'not_started', activeSheet: 'Omad_Transactions' } }
          : { status: 'success' })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await page.click('#nav-settings');
    await page.evaluate(() => showSettingsSection('expenses'));
    return { page, context, requests, pageErrors };
  }

  test('the frequency selector offers every supported recurrence', async () => {
    const { page, context, pageErrors } = await openExpenses();

    const values = await page.evaluate(() =>
      [...document.getElementById('templateExpenseFrequency').options].map(o => o.value));

    assert.deepStrictEqual(values, [
      'once', 'monthly', 'every_2_months', 'every_3_months',
      'every_6_months', 'every_12_months', 'selected_months', 'custom_interval'
    ]);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('only the fields the chosen frequency needs are shown', async () => {
    const { page, context } = await openExpenses();

    const visibility = await page.evaluate(() => {
      const read = () => ({
        interval: !document.getElementById('expenseIntervalRow').classList.contains('hidden'),
        months: !document.getElementById('expenseMonthsRow').classList.contains('hidden'),
        ending: !document.getElementById('expenseEndingRow').classList.contains('hidden')
      });
      const set = value => {
        document.getElementById('templateExpenseFrequency').value = value;
        onExpenseFrequencyChange();
        return read();
      };
      return { once: set('once'), monthly: set('monthly'),
               selected: set('selected_months'), custom: set('custom_interval') };
    });

    assert.deepStrictEqual(visibility.once, { interval: false, months: false, ending: false },
      'a one-time expense has nothing to end');
    assert.deepStrictEqual(visibility.monthly, { interval: false, months: false, ending: true });
    assert.deepStrictEqual(visibility.selected, { interval: false, months: true, ending: true });
    assert.deepStrictEqual(visibility.custom, { interval: true, months: false, ending: true });
    await context.close();
  });

  test('a monthly loan ending in November 2026 is saved with its rule', async () => {
    const { page, context, requests } = await openExpenses();

    await page.evaluate(() => {
      document.getElementById('templateExpenseName').value = 'Kredit';
      document.getElementById('templateExpenseAmount').value = '2 000 000';
      document.getElementById('templateExpenseMonth').value = '2026-01';
      document.getElementById('templateExpenseFrequency').value = 'monthly';
      onExpenseFrequencyChange();
      document.getElementById('templateExpenseEndType').value = 'until_period';
      onExpenseFrequencyChange();
      document.getElementById('templateExpenseEndPeriod').value = '2026-11';
      addTemplateExpense();
    });

    const save = await waitForRequest(requests, 'save_omad');
    const saved = save.templateExpenses.find(e => e.name === 'Kredit');
    assert.strictEqual(saved.amount, 2000000, 'spaces are stripped from the amount');
    assert.strictEqual(saved.frequency, 'monthly');
    assert.deepStrictEqual(saved.ending, { type: 'until_period', untilPeriod: '2026-11', occurrences: 0 });
    await context.close();
  });

  test('selected months are captured from the toggles', async () => {
    const { page, context, requests } = await openExpenses();

    await page.evaluate(() => {
      document.getElementById('templateExpenseName').value = "Sug'urta";
      document.getElementById('templateExpenseAmount').value = '500000';
      document.getElementById('templateExpenseMonth').value = '2026-01';
      document.getElementById('templateExpenseFrequency').value = 'selected_months';
      onExpenseFrequencyChange();
      document.querySelectorAll('.expense-month-toggle').forEach(button => {
        if (['4', '10'].includes(button.dataset.month)) toggleExpenseMonth(button);
      });
      addTemplateExpense();
    });

    const save = await waitForRequest(requests, 'save_omad');
    const saved = save.templateExpenses.find(e => e.name === "Sug'urta");
    assert.deepStrictEqual(saved.selectedMonths, [4, 10]);
    await context.close();
  });

  test('selected months with nothing chosen is rejected', async () => {
    const { page, context, requests } = await openExpenses();

    const warned = await page.evaluate(() => {
      let message = "";
      window.alert = text => { message = text; };
      document.getElementById('templateExpenseName').value = 'X';
      document.getElementById('templateExpenseAmount').value = '1000';
      document.getElementById('templateExpenseMonth').value = '2026-01';
      document.getElementById('templateExpenseFrequency').value = 'selected_months';
      onExpenseFrequencyChange();
      addTemplateExpense();
      return message;
    });

    assert.match(warned, /Kamida bitta oyni tanlang/);
    assert.deepStrictEqual(requests.filter(r => r.action === 'save_omad'), []);
    await context.close();
  });

  test('the list describes each schedule and says whether it is due now', async () => {
    const { page, context } = await openExpenses([
      { id: 'e1', name: 'Internet', amount: 300000, currency: 'UZS',
        startPeriod: '2026-01', frequency: 'monthly', ending: { type: 'never' } },
      { id: 'e2', name: 'Litsenziya', amount: 100, currency: 'USD',
        startPeriod: '2026-05', frequency: 'every_12_months', ending: { type: 'never' } }
    ]);

    const text = await page.evaluate(() =>
      document.getElementById('templateExpenseList').textContent.replace(/\s+/g, ' '));

    assert.match(text, /Internet/);
    assert.match(text, /Har oy/);
    assert.match(text, /Litsenziya/);
    assert.match(text, /Har yili/);
    await context.close();
  });

  test('editing an expense keeps its id', async () => {
    const { page, context, requests } = await openExpenses([
      { id: 'e1', name: 'Internet', amount: 300000, currency: 'UZS',
        startPeriod: '2026-01', frequency: 'monthly', ending: { type: 'never' } }
    ]);

    await page.evaluate(() => {
      editTemplateExpense('e1');
      document.getElementById('templateExpenseAmount').value = '350000';
      addTemplateExpense();
    });

    const save = await waitForRequest(requests, 'save_omad');
    assert.strictEqual(save.templateExpenses.length, 1);
    assert.strictEqual(save.templateExpenses[0].id, 'e1');
    assert.strictEqual(save.templateExpenses[0].amount, 350000);
    await context.close();
  });

  test('a legacy template expense still renders', async () => {
    const { page, context, pageErrors } = await openExpenses([
      { id: 'old', month: '2026-03', name: 'Soliq', amount: 500000, currency: 'UZS' }
    ]);

    const state = await page.evaluate(() => ({
      frequency: app.templateExpenses[0].frequency,
      startPeriod: app.templateExpenses[0].startPeriod,
      text: document.getElementById('templateExpenseList').textContent.replace(/\s+/g, ' ')
    }));

    assert.strictEqual(state.frequency, 'once');
    assert.strictEqual(state.startPeriod, '2026-03');
    assert.match(state.text, /Bir marta/);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });
});
