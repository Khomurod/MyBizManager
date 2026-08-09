'use strict';

/**
 * End-to-end browser test for the /tasks UI.
 *
 * Runs the real tasks.html in Chromium with the Apps Script backend replaced by
 * an in-test mock, and asserts the page renders every tab, never calls Telegram
 * directly, and posts a well-formed save_task with the admin key.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADMIN_KEY = 'test-admin-key';

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
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

function mockView() {
  return {
    todayKey: '2026-08-10',
    nowLabel: '10.08.2026 09:00',
    today: {
      overdue: [{ id: 'o1', title: 'Muddati o\'tgan ish', displayStatus: 'Overdue', priority: 'high', responsible: 'Ali', dueLabel: '10.08.2026 08:00', photoRequired: false, lateLabel: '1h 0m' }],
      needsAttention: [{ id: 'o2', title: 'Bugungi ish', displayStatus: 'Open', priority: 'normal', dueLabel: '10.08.2026 20:00', photoRequired: true }],
      waitingProof: [], upcoming: [], completedToday: []
    },
    recentCompleted: [{ id: 'oc', title: 'Bajarilgan ish', displayStatus: 'Completed', priority: 'normal', completedByName: 'Vali', onTime: true, hasProof: true }],
    tasks: [
      { id: 't1', type: 'routine', title: 'Har kunlik hisobot', status: 'active', priority: 'normal', recurrenceLabel: 'Har kuni', reminderTimes: ['09:00'], stats: { streak: 3, completionRate: 80 }, todayOccurrence: { id: 'o2', displayStatus: 'Open' } },
      { id: 't2', type: 'goal', title: 'Yangi filial', status: 'active', progress: { done: 1, total: 2, percent: 50 }, steps: [{ title: 'Joy topish' }, { title: 'Ta\'mirlash' }], stepOccurrences: [{ id: 's1', title: 'Yangi filial — Joy topish', displayStatus: 'Completed' }, { id: 's2', title: 'Yangi filial — Ta\'mirlash', displayStatus: 'Open' }] }
    ],
    counts: { overdue: 1, dueToday: 1, waitingProof: 0, upcoming: 0, completedToday: 0 }
  };
}

describe('Tasks UI (browser)', () => {
  let server, browser, baseUrl;

  test.before(async () => {
    server = await startStaticServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });
  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function open() {
    const backendRequests = [];
    const telegramRequests = [];
    const context = await browser.newContext();
    await context.addInitScript((key) => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
      sessionStorage.setItem('tasks_admin_key', key);
    }, ADMIN_KEY);

    // Stub the render-blocking CDNs so the page loads without any network.
    await context.route('**cdn.tailwindcss.com**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await context.route('**cdnjs.cloudflare.com**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    await context.route('**://api.telegram.org/**', route => {
      telegramRequests.push(route.request().url());
      route.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await context.route('**script.google.com/**', async route => {
      const req = route.request();
      let payload = {};
      if (req.method() === 'POST') { try { payload = JSON.parse(req.postData() || '{}'); } catch (e) { payload = {}; } }
      backendRequests.push(payload);
      let body = { status: 'success', view: mockView(), config: { tasksGroupConfigured: true } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push(String(err)));
    await page.goto(`${baseUrl}/tasks.html`);
    await page.waitForFunction(() => typeof window.renderAllTasks === 'function');
    await page.waitForFunction(() => document.querySelector('#panel-today .card') !== null);
    return { page, context, backendRequests, telegramRequests, consoleErrors };
  }

  test('the Today tab renders overdue and due-today items', async () => {
    const { page, context, telegramRequests, consoleErrors } = await open();
    const today = await page.textContent('#panel-today');
    assert.match(today, /Muddati o'tgan ish/);
    assert.match(today, /Bugungi ish/);
    assert.deepStrictEqual(telegramRequests, [], 'the browser never calls Telegram directly');
    assert.deepStrictEqual(consoleErrors, []);
    await context.close();
  });

  test('the Routines and Goals tabs render their data', async () => {
    const { page, context } = await open();
    await page.click('[data-tab="routines"]');
    const routines = await page.textContent('#panel-routines');
    assert.match(routines, /Har kunlik hisobot/);
    assert.match(routines, /3 kun/); // streak

    await page.click('[data-tab="goals"]');
    const goals = await page.textContent('#panel-goals');
    assert.match(goals, /Yangi filial/);
    assert.match(goals, /50%/); // progress
    await context.close();
  });

  test('creating a task posts a well-formed save_task with the admin key', async () => {
    const { page, context, backendRequests } = await open();
    await page.click('button:has-text("+")');
    await page.waitForSelector('#taskModal:not(.hidden)');
    await page.fill('#fTitle', 'Yangi test vazifa');
    await page.selectOption('#fType', 'once');
    await page.click('#taskSaveBtn');

    await page.waitForFunction(() =>
      window.__lastSaves === undefined ? true : true);
    // Give the request a beat to be recorded.
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.ok(saves.length >= 1, 'a save_task was posted');
    assert.strictEqual(saves[0].title, 'Yangi test vazifa');
    assert.strictEqual(saves[0].type, 'once');
    assert.strictEqual(saves[0].adminKey, ADMIN_KEY);
    await context.close();
  });
});
