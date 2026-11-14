'use strict';

/**
 * The task board's instant parts, in a real browser, against the real backend.
 *
 * Opening the board paints the last list that loaded on this device, and
 * "Bajarildi" moves the card the moment it is pressed, with the completion
 * sent behind it. These tests hold the promises that make that safe: the
 * stored list is display only and nothing can be changed from it; a tick is
 * confirmed by the server, several quick ticks are all sent rather than all but
 * one refused, and a refusal puts the card back with the reason.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
const describe = chromium ? test.describe : test.describe.skip;

const ROOT = path.join(__dirname, '..');
const ADMIN_KEY = 'tasks-instant-admin';

/** Three one-off tasks due today, so the board has three "Bajarildi" buttons. */
function boot() {
  const gas = loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY } });
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  ['Kassa', 'Ombor', 'Hisobot'].forEach(title => {
    readJsonOutput(gas.doPost(postEvent({
      adminKey: ADMIN_KEY, action: 'save_task', type: 'once', title, deadlineKey: today, deadlineTime: '23:00', deferReports: true
    })));
  });
  gas.setUserPassword('omad_admin', 'tasks-instant-password', 'omad_admin');
  const token = readJsonOutput(gas.doPost(postEvent({ action: 'login', username: 'omad_admin', password: 'tasks-instant-password' }))).token;
  return { gas, token };
}

function completedOnServer(gas) {
  const view = readJsonOutput(gas.doPost(postEvent({ adminKey: ADMIN_KEY, action: 'get_tasks' }))).view;
  return view.today.completedToday.map(occ => occ.title).sort();
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

describe('Task board, instant (browser)', () => {
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

  /**
   * `complete`: 'answer' (after a pause), or 'refuse' to refuse the next one.
   * `load`: 'answer', or 'never' to keep get_tasks from ever arriving.
   */
  async function openBoard(backend, context, options = {}) {
    const control = { complete: options.complete || 'answer', load: options.load || 'answer', sent: [] };
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      if (payload.action === 'get_tasks' && control.load === 'never') return;   // left hanging
      if (payload.action === 'get_tasks' && control.load === 'late') {
        // Read now, delivered only when the test says so.
        const early = backend.gas.doPost(postEvent(payload)).__text;
        await new Promise(release => { control.release = release; });
        await route.fulfill({ status: 200, contentType: 'application/json', body: early });
        return;
      }
      if (payload.action === 'complete_occurrence') {
        control.sent.push(payload.occurrenceId);
        await sleep(300);
        if (control.complete === 'refuse') {
          control.complete = 'answer';
          await route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ status: 'error', message: 'Bu vazifani hozir belgilab bo\'lmaydi.' }) });
          return;
        }
      }
      const out = backend.gas.doPost(postEvent(payload));
      await route.fulfill({ status: 200, contentType: 'application/json', body: out.__text });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/tasks.html`);
    return { page, control, errors };
  }

  async function newContext(backend) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(token => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_session', token);
      localStorage.setItem('omad_user', 'omad_admin');
      localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
    }, backend.token);
    return context;
  }

  const openTitles = page => page.$$eval('#panel-today .sec:not(.fold) .t-title', nodes => nodes.map(n => n.textContent));
  const doneButtons = page => page.locator('#panel-today button:has-text("Bajarildi")');

  test('Bajarildi moves the card at once, and the server confirms it', async () => {
    const backend = boot();
    const context = await newContext(backend);
    const { page, errors } = await openBoard(backend, context);
    await page.waitForSelector('#panel-today button:has-text("Bajarildi")');

    const before = await doneButtons(page).count();
    await page.evaluate(() => { window.__done = tasksCompleteOcc(TASKS_STATE.view.today.needsAttention[0].id); });
    // Before the server has answered.
    assert.strictEqual(await doneButtons(page).count(), before - 1, 'the card left the open list at once');
    assert.match(await page.textContent('#panel-today'), /Saqlanmoqda/, 'and says it is being saved');

    await page.evaluate(() => window.__done);
    assert.strictEqual(await doneButtons(page).count(), before - 1, 'and stays done once confirmed');
    assert.strictEqual(completedOnServer(backend.gas).length, 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  test('three quick ticks are three completions, not one', async () => {
    const backend = boot();
    const context = await newContext(backend);
    const { page, control } = await openBoard(backend, context);
    await page.waitForSelector('#panel-today button:has-text("Bajarildi")');

    for (let i = 0; i < 3; i++) await doneButtons(page).first().click();
    assert.strictEqual(await doneButtons(page).count(), 0, 'every card moved at once');
    await page.evaluate(() => taskCompletionDrain);
    await page.waitForFunction(() => !taskMutationInFlight && pendingTaskCompletions.length === 0);
    assert.strictEqual(control.sent.length, 3, 'each tick was sent');
    assert.deepStrictEqual(completedOnServer(backend.gas), ['Hisobot', 'Kassa', 'Ombor']);
    await context.close();
  });

  test('a refused tick puts the card back and says why', async () => {
    const backend = boot();
    const context = await newContext(backend);
    const { page } = await openBoard(backend, context, { complete: 'refuse' });
    await page.waitForSelector('#panel-today button:has-text("Bajarildi")');
    const titles = await openTitles(page);

    await page.evaluate(() => tasksCompleteOcc(TASKS_STATE.view.today.needsAttention[0].id));
    assert.deepStrictEqual(await openTitles(page), titles, 'the card is back where it was');
    assert.match(await page.textContent('#toast'), /belgilab bo'lmaydi/);
    assert.deepStrictEqual(completedOnServer(backend.gas), []);
    await context.close();
  });

  test('the board opens on the last list before the network answers, and nothing changes from it', async () => {
    const backend = boot();
    const context = await newContext(backend);
    const first = await openBoard(backend, context);
    await first.page.waitForSelector('#panel-today button:has-text("Bajarildi")');
    await first.page.close();

    // Second visit: the live list never arrives.
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    const { page, control } = await openBoard(backend, context, { load: 'never' });
    await page.waitForSelector('#panel-today button:has-text("Bajarildi")', { timeout: 5000 });
    assert.match(await page.textContent('#loadWarn'), /Saqlangan ro'yxat/, 'it says the list is the stored one');
    assert.ok(await page.locator('#loader').isHidden(), 'no full-screen loader over it');

    await doneButtons(page).first().click();
    assert.match(await page.textContent('#toast'), /yangilanmadi/, 'a press waits for the live list');
    assert.deepStrictEqual(control.sent, [], 'and nothing was sent');
    await context.close();
  });

  test('a first load overtaken by a confirmed change does not put the older board back', async () => {
    const backend = boot();
    const context = await newContext(backend);
    const { page, control } = await openBoard(backend, context, { load: 'late' });
    await page.waitForFunction(() => typeof tasksSave === 'function');
    while (!control.release) await sleep(20);

    // A task saved from the form while the first list is still on its way.
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    await page.evaluate(day => tasksSave({ type: 'once', title: 'Yangi ish', deadlineKey: day, deadlineTime: '22:00' }), today);
    control.release();
    await page.waitForFunction(() => document.getElementById('loader').style.display === 'none');
    await sleep(200);
    const board = await page.evaluate(() => ({
      titles: TASKS_STATE.view.tasks.map(t => t.title),
      stale: TASKS_STATE.snapshotAt
    }));
    assert.ok(board.titles.includes('Yangi ish'), 'the saved task is still on the board');
    assert.strictEqual(board.stale, 0, 'and the board counts as live');
    await context.close();
  });
});
