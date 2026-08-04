'use strict';

/**
 * End-to-end browser test for the Telegram settings panel.
 *
 * Runs the real omad_admin.html in Chromium with the Apps Script backend
 * replaced by an in-test mock, and asserts the token never comes back to the
 * browser and that no request ever reaches api.telegram.org.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const ADMIN_KEY = 'test-admin-key';

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  chromium = null;
}

const describe = chromium ? test.describe : test.describe.skip;

/** Static file server for the repo root. */
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

describe('Telegram settings panel (browser)', () => {
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

  /**
   * Opens omad_admin.html with a logged-in admin session and a mocked backend.
   * Returns the page plus the recorded backend requests.
   */
  async function openAdmin(handler) {
    const backendRequests = [];
    const telegramRequests = [];
    const context = await browser.newContext();

    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'omad_admin');
      localStorage.setItem('omad_token', 'omad_admin_active');
      localStorage.setItem('omad_user', 'tester');
    });

    // Any direct hit on Telegram is a failure - record and block it.
    await context.route('**://api.telegram.org/**', route => {
      telegramRequests.push(route.request().url());
      route.fulfill({ status: 200, body: '{"ok":true}' });
    });

    await context.route('**script.google.com/**', async route => {
      const request = route.request();
      let payload = {};
      if (request.method() === 'POST') {
        try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      } else {
        payload = { action: new URL(request.url()).searchParams.get('action') };
      }
      backendRequests.push(payload);
      const body = handler(payload) || { status: 'success' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body)
      });
    });

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => typeof window.loadTelegramSettings === 'function');

    return { page, context, backendRequests, telegramRequests, consoleErrors };
  }

  const savedState = {
    tokenConfigured: false,
    authorizedUserId: '',
    groupChatId: '',
    webhookUrl: '',
    webhookStatus: null,
    lastSuccess: null,
    lastError: null,
    adminKeyConfigured: true
  };

  function backend(state) {
    return payload => {
      if (payload.action === 'get_omad') {
        return { transactions: [], tenants: [], rates: {}, templateExpenses: [] };
      }
      if (payload.action === 'get_telegram_settings') {
        return { status: 'success', settings: state };
      }
      if (payload.action === 'save_telegram_settings') {
        if (payload.adminKey !== ADMIN_KEY) return { status: 'error', message: 'Admin kaliti xato.' };
        // The real backend never echoes the token; neither does the mock.
        state.tokenConfigured = state.tokenConfigured || !!payload.botToken;
        state.authorizedUserId = payload.authorizedUserId;
        state.groupChatId = payload.groupChatId;
        return { status: 'success', settings: state };
      }
      if (payload.action === 'test_telegram_connection') {
        return { status: 'success', bot: { username: 'omad_bot' }, settings: state };
      }
      return { status: 'success', settings: state };
    };
  }

  test('panel loads and reports that no token is configured', async () => {
    const state = { ...savedState };
    const { page, context } = await openAdmin(backend(state));

    await page.click('#nav-settings');
    await page.waitForSelector('#tab-settings.active');
    await page.waitForFunction(() =>
      document.getElementById('tgTokenStatus').textContent.includes("O'rnatilmagan"));

    assert.match(await page.textContent('#tgTokenStatus'), /O'rnatilmagan/);
    await context.close();
  });

  test('saving a token never returns it and clears the input', async () => {
    const state = { ...savedState };
    const { page, context, backendRequests, telegramRequests, consoleErrors } =
      await openAdmin(backend(state));

    await page.click('#nav-settings');
    await page.fill('#tgAdminKey', ADMIN_KEY);
    await page.fill('#tgBotToken', FIXTURE_TOKEN);
    await page.fill('#tgAuthorizedUserId', '111222333');
    await page.fill('#tgGroupChatId', '-1001234567890');
    await page.click('#tgSaveBtn');

    await page.waitForFunction(() =>
      document.getElementById('tgTokenStatus').textContent.includes("O'rnatilgan"));

    // The token was sent up exactly once...
    const saves = backendRequests.filter(r => r.action === 'save_telegram_settings');
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].botToken, FIXTURE_TOKEN);

    // ...and never came back down.
    const reloads = backendRequests.filter(r => r.action === 'get_telegram_settings');
    assert.ok(reloads.length >= 1, 'settings should be reloaded after save');

    // The input is cleared so the token does not linger in the DOM.
    assert.strictEqual(await page.inputValue('#tgBotToken'), '');

    // Nothing in the rendered page contains the token.
    const html = await page.content();
    assert.ok(!html.includes(FIXTURE_TOKEN), 'token must not appear in the DOM');

    // And no in-page JS variable holds it.
    const leaked = await page.evaluate(t =>
      JSON.stringify(window.telegramSettings || {}).includes(t), FIXTURE_TOKEN);
    assert.strictEqual(leaked, false);

    assert.deepStrictEqual(telegramRequests, [], 'browser must not call Telegram directly');
    assert.deepStrictEqual(consoleErrors, []);
    await context.close();
  });

  test('save is rejected and reported when the admin key is wrong', async () => {
    const state = { ...savedState };
    const { page, context } = await openAdmin(backend(state));

    await page.click('#nav-settings');
    await page.fill('#tgAdminKey', 'wrong-key');
    await page.fill('#tgBotToken', FIXTURE_TOKEN);
    await page.fill('#tgAuthorizedUserId', '111222333');
    await page.fill('#tgGroupChatId', '-1001234567890');
    await page.click('#tgSaveBtn');

    await page.waitForFunction(() =>
      document.getElementById('tgMessage').textContent.includes('Admin kaliti'));

    assert.match(await page.getAttribute('#tgMessage', 'class'), /text-red-600/);
    await context.close();
  });

  test('save is blocked client-side when the admin key is empty', async () => {
    const state = { ...savedState };
    const { page, context, backendRequests } = await openAdmin(backend(state));

    await page.click('#nav-settings');
    await page.fill('#tgBotToken', FIXTURE_TOKEN);
    await page.fill('#tgAuthorizedUserId', '111222333');
    await page.fill('#tgGroupChatId', '-1001234567890');
    await page.click('#tgSaveBtn');

    await page.waitForFunction(() =>
      document.getElementById('tgMessage').textContent.includes('Admin kalitini'));

    assert.strictEqual(backendRequests.filter(r => r.action === 'save_telegram_settings').length, 0);
    await context.close();
  });

  test('test-connection button reports the bot username', async () => {
    const state = { ...savedState, tokenConfigured: true };
    const { page, context, telegramRequests } = await openAdmin(backend(state));

    await page.click('#nav-settings');
    await page.fill('#tgAdminKey', ADMIN_KEY);
    await page.click('text=🔌 Ulanish');

    await page.waitForFunction(() =>
      document.getElementById('tgBotStatus').textContent.includes('omad_bot'));

    assert.deepStrictEqual(telegramRequests, []);
    await context.close();
  });

  test('café POS sends its close-day report through the backend proxy', async () => {
    const backendRequests = [];
    const telegramRequests = [];
    const context = await browser.newContext();

    await context.addInitScript(() => {
      localStorage.setItem('omad_role', 'cafe_seller');
      localStorage.setItem('omad_token', 'cafe_seller_active');
      localStorage.setItem('omad_user', 'kassir');
    });
    await context.route('**://api.telegram.org/**', route => {
      telegramRequests.push(route.request().url());
      route.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      backendRequests.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', messageId: 77, inventory: [], recipes: [], categories: [], sales: [], closeReports: [], settings: {} })
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/cafe_pos.html`);
    await page.waitForFunction(() => typeof window.sendTelegramMessage === 'function');

    await page.evaluate(() => window.sendTelegramMessage('Kun yakuni hisoboti'));

    const sends = backendRequests.filter(r => r.action === 'telegram_send');
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, 'Kun yakuni hisoboti');
    assert.strictEqual(sends[0].parseMode, 'HTML');
    assert.strictEqual(sends[0].botToken, undefined);
    assert.deepStrictEqual(telegramRequests, [], 'POS must not call Telegram directly');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('café screens still load without page errors (regression)', async () => {
    for (const [file, role, token] of [
      ['cafe_admin.html', 'cafe_admin', 'cafe_admin_active'],
      ['cafe_pos.html', 'cafe_seller', 'cafe_seller_active']
    ]) {
      const context = await browser.newContext();
      await context.addInitScript(([r, t]) => {
        localStorage.setItem('omad_role', r);
        localStorage.setItem('omad_token', t);
        localStorage.setItem('omad_user', 'tester');
      }, [role, token]);
      await context.route('**script.google.com/**', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ inventory: [], recipes: [], categories: [], sales: [], closeReports: [], settings: {} })
      }));

      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(String(err)));
      await page.goto(`${baseUrl}/${file}`);
      await page.waitForLoadState('networkidle');
      assert.deepStrictEqual(pageErrors, [], `${file} raised page errors`);
      await context.close();
    }
  });

  test('mobile viewport renders the panel without horizontal overflow', async () => {
    const state = { ...savedState };
    const { page, context } = await openAdmin(backend(state));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.click('#nav-settings');
    await page.waitForSelector('#tgBotToken');

    const overflows = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.strictEqual(overflows, false, 'settings panel must not overflow on mobile');

    // Numeric inputs keep the mobile numeric keyboard.
    assert.strictEqual(await page.getAttribute('#tgAuthorizedUserId', 'inputmode'), 'numeric');
    await context.close();
  });
});
