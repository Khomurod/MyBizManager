'use strict';

/**
 * assets/backend.js in a real browser: which server a request goes to, and
 * when it is sent a second time.
 *
 * The two servers are both intercepted here, so the test sees every request
 * either of them would have received:
 *   - the Edge function (`/functions/v1/api`), answering as told per test;
 *   - Apps Script (`script.google.com`), always answering.
 *
 * The rules being held:
 *   1. Pages served from this machine use Apps Script unless told otherwise,
 *      so no browser test can reach the live Edge function.
 *   2. Edge first. A read, or a write with a requestId, that the Edge function
 *      did not answer is repeated on Apps Script, and the device then uses
 *      Apps Script for a while.
 *   3. Any other write is never sent twice, and goes to the Edge function only
 *      once it has answered on this tab.
 *   4. The backend's own answer -- whatever its status -- is final.
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-MBM-Runtime'
};

describe('which server answers (assets/backend.js)', () => {
  let browser;
  let server;
  let baseUrl;

  test.before(async () => {
    server = await startStaticServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  /**
   * A page with backend.js loaded. `edge(route, body)` decides each Edge
   * answer; Apps Script always answers success.
   */
  async function open({ choice = 'edge', edge } = {}) {
    const context = await browser.newContext();
    await context.route('**cdn.tailwindcss.com**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    const seen = { edge: [], appsScript: [] };
    await context.route(/\/functions\/v1\/api/, async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      seen.edge.push(body.action);
      await edge(route, body);
    });
    await context.route('**script.google.com/**', async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      seen.appsScript.push(body.action);
      await route.fulfill({
        status: 200, contentType: 'application/json', headers: CORS,
        body: JSON.stringify({ status: 'success', from: 'apps-script', action: body.action })
      });
    });
    if (choice) {
      await context.addInitScript(value => {
        try { localStorage.setItem('mbm_backend', value); } catch (error) {}
      }, choice);
    }
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login.html`);
    const post = payload => page.evaluate(async body => {
      try {
        const res = await backendPost(GOOGLE_APP_URL, JSON.stringify(body));
        return { status: res.status, runtime: res.headers.get('X-MBM-Runtime'), json: JSON.parse(await res.text()) };
      } catch (error) {
        return { thrown: String(error && error.message || error) };
      }
    }, payload);
    const storage = () => page.evaluate(() => ({
      down: Number(localStorage.getItem('mbm_edge_down_until') || 0) > Date.now(),
      seen: !!sessionStorage.getItem('mbm_edge_seen_at')
    }));
    return { context, page, seen, post, storage };
  }

  const answer = (status = 200, runtime = 'edge', extra = {}) => route => route.fulfill({
    status, contentType: 'application/json',
    headers: runtime ? Object.assign({ 'X-MBM-Runtime': runtime }, CORS) : CORS,
    body: JSON.stringify(Object.assign({ status: status < 300 ? 'success' : 'error', from: 'edge' }, extra))
  });

  test('a page served from this machine talks to Apps Script', async () => {
    const { context, seen, post } = await open({ choice: null, edge: answer() });
    const res = await post({ action: 'get_tasks' });
    assert.strictEqual(res.json.from, 'apps-script');
    assert.deepStrictEqual(seen.edge, []);
    await context.close();
  });

  test('the Edge function is asked first, and its answer is the answer', async () => {
    const { context, seen, post, storage } = await open({ edge: answer() });
    const res = await post({ action: 'get_tasks' });
    assert.strictEqual(res.json.from, 'edge');
    assert.strictEqual(res.runtime, 'edge', 'the header is readable across origins');
    assert.deepStrictEqual(seen.appsScript, []);
    assert.deepStrictEqual(await storage(), { down: false, seen: true });
    await context.close();
  });

  test('a read the Edge function never received goes to Apps Script, and so does the next one', async () => {
    const { context, seen, post, storage } = await open({ edge: route => route.abort('connectionrefused') });
    const res = await post({ action: 'get_omad_data', scope: 'dashboard' });
    assert.strictEqual(res.json.from, 'apps-script');
    assert.deepStrictEqual(seen.edge, ['get_omad_data']);
    assert.strictEqual((await storage()).down, true);
    await post({ action: 'get_tasks' });
    assert.deepStrictEqual(seen.edge, ['get_omad_data'], 'not asked again while it is marked down');
    assert.deepStrictEqual(seen.appsScript, ['get_omad_data', 'get_tasks']);
    await context.close();
  });

  test('the platform\'s own error page is not an answer: a write with a requestId is repeated on Apps Script', async () => {
    const { context, seen, post } = await open({ edge: answer(503, null, { code: 'BOOT_ERROR' }) });
    const res = await post({ action: 'create_transaction', requestId: 'r-1' });
    assert.strictEqual(res.json.from, 'apps-script');
    assert.deepStrictEqual(seen.edge, ['create_transaction']);
    assert.deepStrictEqual(seen.appsScript, ['create_transaction']);
    await context.close();
  });

  test('a write without a requestId is not sent to the Edge function before it has answered on this tab', async () => {
    const { context, seen, post } = await open({ edge: answer() });
    await post({ action: 'save_task', task: { title: 'x' } });
    assert.deepStrictEqual(seen.edge, []);
    assert.deepStrictEqual(seen.appsScript, ['save_task']);
    await post({ action: 'get_tasks' });
    await post({ action: 'save_task', task: { title: 'y' } });
    assert.deepStrictEqual(seen.edge, ['get_tasks', 'save_task'], 'after a read, it is');
    await context.close();
  });

  test('a write without a requestId that may have arrived is never sent twice', async () => {
    let calls = 0;
    const { context, seen, post, storage } = await open({
      edge: route => (++calls === 1 ? answer()(route) : route.abort('connectionreset'))
    });
    await post({ action: 'get_tasks' });
    const res = await post({ action: 'save_task', task: { title: 'x' } });
    assert.ok(res.thrown, 'it fails, as it would have against Apps Script');
    assert.deepStrictEqual(seen.appsScript, [], 'and Apps Script never received it');
    assert.strictEqual((await storage()).seen, false);
    await post({ action: 'save_task', task: { title: 'x' } });
    assert.deepStrictEqual(seen.appsScript, ['save_task'], 'the retry goes to Apps Script');
    await context.close();
  });

  test('"unconfigured" means nothing was done, so any write goes to Apps Script', async () => {
    let calls = 0;
    const { context, seen, post } = await open({
      edge: route => (++calls === 1 ? answer()(route) : answer(503, 'unconfigured')(route))
    });
    await post({ action: 'get_tasks' });
    const res = await post({ action: 'save_task', task: { title: 'x' } });
    assert.strictEqual(res.json.from, 'apps-script');
    assert.deepStrictEqual(seen.appsScript, ['save_task']);
    await context.close();
  });

  test('the backend\'s own error, with its header, is final whatever the status', async () => {
    const { context, seen, post, storage } = await open({ edge: answer(500, 'edge', { message: 'Edge: boom' }) });
    const res = await post({ action: 'get_tasks' });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.json.message, 'Edge: boom');
    assert.deepStrictEqual(seen.appsScript, []);
    assert.strictEqual((await storage()).down, false);
    await context.close();
  });

  test('"apps-script" on this device skips the Edge function entirely', async () => {
    const { context, seen, post } = await open({ choice: 'apps-script', edge: answer() });
    await post({ action: 'get_tasks' });
    assert.deepStrictEqual(seen.edge, []);
    await context.close();
  });
});
