#!/usr/bin/env node
'use strict';

/**
 * Screenshots of every screen, at every viewport the app has to work at.
 *
 *     node scripts/ui-screenshots.js <out-dir> [filter]
 *
 * The pages are served from this checkout and talk to the real backend
 * (script.gs in the test harness, tests/gas-harness.js) seeded with a
 * realistic business: tenants with debts and surpluses, a ledger across
 * several months, a café with products, ingredients, recipes and sales, and
 * tasks in every state the board can show. Only the network hop is faked.
 *
 * Used for the before/after review of a visual change: look at every image,
 * at every size, before calling a screen done. Not part of CI.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { loadScript, readJsonOutput, postEvent } = require('../tests/gas-harness');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || 'ui-shots');
const FILTER = process.argv[3] || '';
const ADMIN_KEY = 'shots-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'narrow', width: 320, height: 640, mobile: true },
  { name: 'short', width: 390, height: 560, mobile: true }
];

// ------------------------------------------------------------- the business

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const period = back => {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const PERIODS = [5, 4, 3, 2, 1, 0].map(period);
const TENANTS = [
  { name: "O'quv Markaz", defaultRent: 600, currency: 'USD', active: true },
  { name: 'Apteka', defaultRent: 4500000, currency: 'UZS', active: true },
  { name: 'Jahongiraka (Okarachka)', defaultRent: 8435000, currency: 'UZS', active: true },
  { name: 'Tehnopark', defaultRent: 900, currency: 'USD', active: true },
  { name: 'Go\'zallik saloni', defaultRent: 3000000, currency: 'UZS', active: true },
  { name: 'Eski ijarachi', defaultRent: 200, currency: 'USD', active: false }
];
const rates = {};
PERIODS.forEach((p, i) => { rates[p] = { buy: 12500 + i * 40, sell: 12650 + i * 40 }; });

const LEDGER_HEADER = ['ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period', 'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used', 'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID', 'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'];
const ledger = [LEDGER_HEADER];
let n = 0;
function row(p, tenant, type, amount, currency, method, comment, extra = {}) {
  const rate = rates[p].sell;
  const id = `${1780000000000 + n * 3600000}_0`;
  n++;
  ledger.push([id, 'req_' + n, new Date(Date.now() - (400 - n) * 3600e3).toISOString(), '', 'omad_admin', 'Web', p, tenant, type,
    amount, currency, rates[p].buy, rate, currency === 'USD' ? rate : 1, currency === 'USD' ? 'sell' : 'none',
    Math.round(currency === 'USD' ? amount * rate : amount), method, comment, extra.status || 'Active', '', '', 2,
    extra.group || ('grp_shot_' + n), extra.kind || '']);
}
PERIODS.forEach((p, i) => {
  row(p, "O'quv Markaz", 'Income', 600, 'USD', 'Naqd', 'ijara');
  row(p, 'Apteka', 'Income', i === 5 ? 2000000 : 4500000, 'UZS', 'Bank', 'ijara');
  if (i < 5) row(p, 'Jahongiraka (Okarachka)', 'Income', 8435000, 'UZS', 'Bank', 'Ijara to\'lovi');
  row(p, 'Tehnopark', 'Income', i % 2 ? 900 : 1000, 'USD', 'Naqd', '');
  row(p, 'Umumiy Naqd Puldan', 'Expense', 1200000, 'UZS', 'Naqd', 'Elektr energiya');
  row(p, 'Umumiy Bankdan', 'Expense', 850000, 'UZS', 'Bank', 'Soliq');
  if (i === 4) {
    row(p, "Go'zallik saloni", 'Income', 1500000, 'UZS', 'Naqd', 'qisman', { group: 'grp_multi' });
    row(p, "Go'zallik saloni", 'Income', 100, 'USD', 'Naqd', 'qisman', { group: 'grp_multi' });
    row(p, 'Tehnopark', 'Income', 350000, 'UZS', 'Naqd', 'Santexnik', { group: 'grp_tp', kind: 'tenant_paid_expense' });
    row(p, 'Tehnopark', 'Expense', 350000, 'UZS', 'Naqd', 'Santexnik', { group: 'grp_tp', kind: 'tenant_paid_expense' });
  }
});
row(PERIODS[5], 'Umumiy Naqd Puldan', 'Expense', 400000, 'UZS', 'Naqd', 'Bekor qilingan xarajat', { status: 'Cancelled' });

const INVENTORY = [
  { id: 'i1', name: 'Coca-Cola 0.5L', type: 'product', category: 'Ichimliklar', qty: 48, unit: 'dona', sellPrice: 9000, unitCost: 6500, totalCost: 312000 },
  { id: 'i2', name: 'Fanta 0.5L', type: 'product', category: 'Ichimliklar', qty: 3, unit: 'dona', sellPrice: 9000, unitCost: 6500, totalCost: 19500 },
  { id: 'i3', name: 'Suv 1L', type: 'product', category: 'Ichimliklar', qty: 30, unit: 'dona', sellPrice: 5000, unitCost: 2500, totalCost: 75000 },
  { id: 'i4', name: 'Muzqaymoq plombir', type: 'product', category: 'Muzqaymoq', qty: 12, unit: 'dona', sellPrice: 12000, unitCost: 7000, totalCost: 84000 },
  { id: 'i5', name: 'Sosiska', type: 'ingredient', qty: 40, unit: 'dona', unitCost: 3000, totalCost: 120000 },
  { id: 'i6', name: 'Non (hot-dog)', type: 'ingredient', qty: 2, unit: 'dona', unitCost: 1500, totalCost: 3000 },
  { id: 'i7', name: 'Ketchup', type: 'ingredient', qty: 1.2, unit: 'kg', unitCost: 30000, totalCost: 36000 }
];
const RECIPES = [
  { id: 'r1', name: 'Hot Dog', category: 'Fast-Food', sellPrice: 18000, active: true, ingredients: [{ inventoryId: 'i5', qty: 1 }, { inventoryId: 'i6', qty: 1 }, { inventoryId: 'i7', qty: 0.03 }] },
  { id: 'r2', name: 'Ikki sosiskali', category: 'Fast-Food', sellPrice: 24000, active: true, ingredients: [{ inventoryId: 'i5', qty: 2 }, { inventoryId: 'i6', qty: 1 }] }
];

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890', TELEGRAM_TASKS_GROUP_CHAT_ID: '-1009876543210'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(rates)], ['Omad_Tenants', JSON.stringify(TENANTS)],
        ['Omad_Template_Expenses', JSON.stringify([{ id: 'te1', name: 'Soliq', amount: 850000, currency: 'UZS', startPeriod: PERIODS[0], frequency: 'monthly' }])],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2'],
        ['Cafe_Inventory', JSON.stringify(INVENTORY)], ['Cafe_Recipes', JSON.stringify(RECIPES)],
        ['Cafe_Categories', JSON.stringify(['Ichimliklar', 'Fast-Food', 'Muzqaymoq'])],
        ['Cafe_Settings', JSON.stringify({ dailyTarget: 600000 })], ['Cafe_Inventory_Rev', '3'], ['Cafe_Catalogue_Rev', '2']
      ],
      Omad_Transactions_V2: ledger
    }
  });
}

const post = (gas, body) => readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));

function seed(gas) {
  // Café sales today, from the till itself.
  [['i1', 2], ['r1', 1], ['i4', 3], ['r2', 2], ['i3', 1]].forEach(([id, qty], i) => {
    const kind = id.startsWith('r') ? 'recipe' : 'product';
    const item = kind === 'recipe' ? { kind, recipeId: id, qty } : { kind, inventoryId: id, qty };
    post(gas, { action: 'save_sale', requestId: 'shot_sale_' + i, id: 'S' + i, seller: 'kassir', items: [item] });
  });
  // Tasks of every kind.
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  post(gas, { action: 'save_task', type: 'once', title: 'Hisoblagichlarni tekshirish', responsible: 'Ali', priority: 'high', photoRequired: true, deadlineKey: today, deadlineTime: '18:00', deferReports: true });
  post(gas, { action: 'save_task', type: 'once', title: 'Ijara shartnomasini yangilash', responsible: 'Vali', priority: 'urgent', deadlineKey: today, deadlineTime: '08:00', deferReports: true });
  post(gas, { action: 'save_task', type: 'routine', title: 'Kassani topshirish', responsible: 'Kassir', priority: 'normal', recurrence: { freq: 'daily' }, reminderTimes: ['21:00'], deferReports: true });
  post(gas, { action: 'save_task', type: 'routine', title: 'Haftalik tozalash', priority: 'low', photoRequired: true, recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 4] }, reminderTimes: ['10:00'], deferReports: true });
  post(gas, { action: 'save_task', type: 'goal', title: 'Yangi filial ochish', responsible: 'Rahbar', priority: 'high', steps: [{ title: 'Joy topish' }, { title: "Ta'mirlash", photoRequired: true }, { title: 'Jihozlash' }], deferReports: true });
  gas.processTaskSchedules && gas.processTaskSchedules();
  return today;
}

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAF_shots',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid', username: 'boss' })
  };
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return Object.keys(fields).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

// ---------------------------------------------------------------- serving

function startStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/mini' || rel === '/tasks') rel += '.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ shots

const wait = ms => new Promise(r => setTimeout(r, ms));
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await wait(350);
}
const click = async (page, selector) => { await page.locator(selector).first().click(); await settle(page); };
const call = async (page, fn) => { await page.evaluate(fn); await settle(page); };

const ADMIN = { role: 'omad_admin', user: 'omad_admin' };
const SCENES = [
  { name: 'login', page: 'login.html', session: null },
  { name: 'omad-dashboard', page: 'omad_admin.html', session: ADMIN },
  { name: 'omad-debt-modal', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => openDebtListModal()) },
  { name: 'omad-tenant-modal', page: 'omad_admin.html', session: ADMIN, run: p => click(p, '#tenantStatusList > *') },
  { name: 'omad-expense-modal', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => openExpenseModal()) },
  { name: 'omad-entry', page: 'omad_admin.html', session: ADMIN, run: async p => { await call(p, () => switchTab('entry')); await p.fill('#tempAmount', '1500000'); await call(p, () => addToCart()); } },
  { name: 'omad-entry-tenantpaid', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => { switchTab('entry'); setType('TenantPaid'); }) },
  { name: 'omad-bulk', page: 'omad_admin.html', session: ADMIN, run: async p => { await call(p, () => switchTab('bulk')); await call(p, () => fillFromRoster()); } },
  { name: 'omad-history', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => switchTab('history')) },
  { name: 'omad-settings-rates', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => switchTab('settings')) },
  { name: 'omad-settings-tenants', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => { switchTab('settings'); showSettingsSection('tenants'); }) },
  { name: 'omad-settings-expenses', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => { switchTab('settings'); showSettingsSection('expenses'); }) },
  { name: 'omad-settings-telegram', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => { switchTab('settings'); showSettingsSection('telegram'); }) },
  { name: 'omad-settings-system', page: 'omad_admin.html', session: ADMIN, run: p => call(p, () => { switchTab('settings'); showSettingsSection('system'); }) },
  { name: 'cafe-admin-dash', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' } },
  { name: 'cafe-admin-inventory', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' }, run: p => click(p, '[onclick*="inventory"]') },
  { name: 'cafe-admin-recipes', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' }, run: p => click(p, '[onclick*="recipes"]') },
  { name: 'cafe-admin-categories', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' }, run: p => click(p, '[onclick*="categories"]') },
  { name: 'cafe-admin-settings', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' }, run: p => click(p, '[onclick*="\'settings\'"]') },
  { name: 'cafe-admin-reports', page: 'cafe_admin.html', session: { role: 'cafe_admin', user: 'cafe_admin' }, run: p => click(p, '[onclick*="reports"]') },
  { name: 'pos', page: 'cafe_pos.html', session: { role: 'cafe_seller', user: 'kassir' } },
  { name: 'pos-cart', page: 'cafe_pos.html', session: { role: 'cafe_seller', user: 'kassir' }, run: async p => { await click(p, '#itemsGrid button'); await click(p, '#itemsGrid button'); await call(p, () => openCart()); } },
  { name: 'pos-receipts', page: 'cafe_pos.html', session: { role: 'cafe_seller', user: 'kassir' }, run: p => call(p, () => openReceiptsModal()) },
  { name: 'pos-close-day', page: 'cafe_pos.html', session: { role: 'cafe_seller', user: 'kassir' }, run: p => call(p, () => openCloseDayModal()) },
  { name: 'tasks-today', page: 'tasks.html', session: ADMIN },
  { name: 'tasks-tasks', page: 'tasks.html', session: ADMIN, run: p => click(p, '[data-tab="tasks"], #nav-tasks, button:has-text("Vazifalar")') },
  { name: 'tasks-routines', page: 'tasks.html', session: ADMIN, run: p => click(p, '[data-tab="routines"], #nav-routines, button:has-text("Muntazam")') },
  { name: 'tasks-goals', page: 'tasks.html', session: ADMIN, run: p => click(p, '[data-tab="goals"], #nav-goals, button:has-text("Maqsadlar")') },
  { name: 'tasks-history', page: 'tasks.html', session: ADMIN, run: p => click(p, '[data-tab="completed"], #nav-completed, button:has-text("Tarix")') },
  { name: 'tasks-form', page: 'tasks.html', session: ADMIN, run: p => call(p, () => openTaskForm()) },
  { name: 'mini-omad', page: 'mini.html', mini: true },
  { name: 'mini-entry', page: 'mini.html', mini: true, run: p => call(p, () => openEntrySheet('Income')) },
  { name: 'mini-bulk', page: 'mini.html', mini: true, run: p => call(p, () => openBulkSheet()) },
  { name: 'mini-cafe', page: 'mini.html', mini: true, run: p => call(p, () => switchTab('cafe')) },
  { name: 'mini-tasks', page: 'mini.html', mini: true, run: p => call(p, () => switchTab('tasks')) },
  { name: 'mini-dark', page: 'mini.html', mini: true, dark: true }
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const gas = boot();
  seed(gas);
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const initData = signedInitData();
  // Real sessions, minted by the backend's own login, one per role.
  const tokens = {};
  [['omad_admin', 'omad_admin'], ['cafe_admin', 'cafe_admin'], ['kassir', 'cafe_seller']].forEach(([user, role]) => {
    gas.setUserPassword(user, 'shots-password-1', role);
    tokens[user] = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: user, password: 'shots-password-1' }))).token;
  });
  const problems = [];

  for (const scene of SCENES) {
    if (FILTER && !scene.name.includes(FILTER)) continue;
    for (const vp of VIEWPORTS) {
      if (scene.mini && vp.name === 'desktop') continue;     // a phone app
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile,
        colorScheme: scene.dark ? 'dark' : 'light'
      });
      if (scene.session) {
        await context.addInitScript(s => {
          localStorage.setItem('omad_role', s.role);
          localStorage.setItem('omad_session', s.token);
          localStorage.setItem('omad_user', s.user);
          localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
        }, Object.assign({ token: tokens[scene.session.user] }, scene.session));
      }
      if (scene.mini) {
        await context.addInitScript(({ data, dark }) => {
          const theme = dark
            ? { bg_color: '#17212b', secondary_bg_color: '#232e3c', text_color: '#f5f5f5', hint_color: '#708499', button_color: '#5288c1', button_text_color: '#ffffff', link_color: '#6ab3f3' }
            : {};
          window.Telegram = { WebApp: {
            initData: data, initDataUnsafe: { user: { id: 49328655, first_name: 'Xurshid' } }, themeParams: theme,
            colorScheme: dark ? 'dark' : 'light',
            ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, disableVerticalSwipes() {},
            HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
            BackButton: { show() {}, hide() {} }, onEvent() {}, offEvent() {}
          } };
          if (dark) {
            // What Telegram's SDK does: the palette as CSS variables on <html>.
            const apply = () => Object.entries(theme).forEach(([k, v]) =>
              document.documentElement.style.setProperty('--tg-theme-' + k.replace(/_/g, '-'), v));
            if (document.documentElement) apply();
            else document.addEventListener('readystatechange', apply, { once: true });
          }
        }, { data: initData, dark: !!scene.dark });
        await context.route('**telegram.org/**', r => r.abort());
      }
      await context.route('**script.google.com/**', async route => {
        let payload = {};
        try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
        const out = gas.doPost(postEvent(payload));
        await route.fulfill({ status: 200, contentType: 'application/json', body: out.__text || JSON.stringify(out) });
      });
      // Third-party CDNs are unreachable from where this runs.
      await context.route('**cdnjs.cloudflare.com/**', r => r.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => {
        // A blocked third-party request is this harness, not the page.
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().split('\n')[0]);
      });
      await page.goto(`${base}/${scene.page}`);
      await settle(page);
      try {
        if (scene.run) await scene.run(page);
      } catch (e) {
        errors.push('scene: ' + String(e).split('\n')[0]);
      }
      // Against the width asked for: a phone browser widens its layout
      // viewport to fit content that is too wide, which hides the overflow
      // from innerWidth.
      const overflow = await page.evaluate(width => {
        const over = document.documentElement.scrollWidth - width;
        if (over <= 1) return null;
        const culprits = [...document.querySelectorAll('body *')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > width + 1 && getComputedStyle(e).position !== 'fixed'; })
          .filter((e, i, all) => !all.some(other => other !== e && other.contains(e) === false && e.contains(other)))
          .slice(-4)
          .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ').slice(0, 3).join('.')}`);
        return `horizontal overflow ${over}px: ${culprits.join(', ')}`;
      }, vp.width);
      if (overflow) errors.push(overflow);
      await page.screenshot({ path: path.join(OUT, `${scene.name}--${vp.name}.png`), fullPage: true });
      if (errors.length) problems.push(`${scene.name} @ ${vp.name}: ${[...new Set(errors)].join(' | ')}`);
      await context.close();
    }
  }
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(OUT, 'problems.txt'), problems.join('\n') + '\n');
  console.log(`screens in ${OUT}; ${problems.length} with problems`);
  problems.forEach(p => console.log('  ' + p));
})().catch(error => { console.error(error); process.exit(1); });
