'use strict';

/**
 * The redesigned Sozlamalar tab.
 *
 * Five sections, each usable at every width the app is actually opened at.
 * The old exchange-rate row overflowed the viewport at 375px because two
 * `flex-1` inputs plus a button refused to shrink; the layout test below fails
 * if anything like that comes back.
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

const SYSTEM_STATUS = {
  schemaVersion: 2,
  activeSheet: 'Omad_Transactions',
  ledgerActive: false,
  backup: { count: 3, lastAt: '2026-02-01T09:00:00.000Z', lastReason: 'save_omad', lastTransactionCount: 42 },
  migration: {
    state: 'not_started', schemaVersion: 1, fallbackYear: 0,
    activeSheet: 'Omad_Transactions', versionedSheetExists: false,
    versionedSheetRows: 0, sourceSheetRows: 42
  },
  queue: {
    counts: { pending: 2, processing: 0, completed: 11, failed: 1 },
    failures: [{ jobId: 'job_9', type: 'omad_transaction_report', attempts: 5, lastError: 'HTTP 502' }]
  },
  audit: [
    { at: '2026-02-01T09:05:00.000Z', event: 'transaction_created', details: '' },
    { at: '2026-02-01T09:00:00.000Z', event: 'manual_backup_created', details: '' }
  ],
  lastOperation: { operation: 'create_transaction', at: '2026-02-01T09:05:00.000Z' },
  counts: { legacyTransactions: 42, ledgerTransactions: 0, archive: 3, auditLog: 12, backups: 3, jobs: 14 }
};

/** The widths the app is actually opened at. */
const VIEWPORTS = [
  { name: '320px (small phone)', width: 320, height: 720 },
  { name: '375px (iPhone)', width: 375, height: 812 },
  { name: '414px (large phone)', width: 414, height: 896 },
  { name: '768px (tablet)', width: 768, height: 1024 },
  { name: '1280px (desktop)', width: 1280, height: 900 }
];

const SECTIONS = ['rates', 'tenants', 'expenses', 'telegram', 'system'];

describe('Sozlamalar (browser)', () => {
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

  async function openSettings(overrides = {}) {
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
            transactions: [],
            tenants: [{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }],
            rates: { '2026-01': { buy: 12000, sell: 12500 } },
            templateExpenses: [{ id: 'e1', month: '2026-01', name: 'Soliq', amount: 500000, currency: 'UZS' }]
          })
        });
        return;
      }

      let payload = {};
      try { payload = JSON.parse(request.postData() || '{}'); } catch (e) { payload = {}; }
      requests.push(payload);

      const responders = {
        get_migration_status: () => ({ status: 'success', migration: SYSTEM_STATUS.migration }),
        get_system_status: () => ({ status: 'success', system: { ...SYSTEM_STATUS, ...(overrides.system || {}) } }),
        get_telegram_settings: () => ({ status: 'success', settings: { tokenConfigured: true, adminKeyConfigured: true } })
      };
      const body = (overrides.respond && overrides.respond(payload)) ||
                   (responders[payload.action] ? responders[payload.action]() : { status: 'success' });

      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${baseUrl}/omad_admin.html`);
    await page.waitForFunction(() => app.migration !== null);
    await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; });
    await page.click('#nav-settings');
    return { page, context, requests, pageErrors };
  }

  // ---------------------------------------------------------------- sections

  test('the five sections are present and only one is open at a time', async () => {
    const { page, context, pageErrors } = await openSettings();

    for (const section of SECTIONS) {
      await page.evaluate(name => showSettingsSection(name), section);
      const visible = await page.evaluate(names => names.filter(name =>
        !document.getElementById('settings-' + name).classList.contains('hidden')), SECTIONS);
      assert.deepStrictEqual(visible, [section], `only ${section} should be open`);
    }

    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the open section is marked in the navigation', async () => {
    const { page, context } = await openSettings();
    await page.evaluate(() => showSettingsSection('telegram'));

    const active = await page.evaluate(() =>
      [...document.querySelectorAll('.settings-nav-btn.active')].map(b => b.dataset.section));
    assert.deepStrictEqual(active, ['telegram']);
    await context.close();
  });

  test('the section stays open across a tab switch', async () => {
    const { page, context } = await openSettings();

    await page.evaluate(() => showSettingsSection('system'));
    await page.evaluate(() => switchTab('dash'));
    await page.evaluate(() => switchTab('settings'));

    const open = await page.evaluate(() => activeSettingsSection);
    assert.strictEqual(open, 'system');
    await context.close();
  });

  // ------------------------------------------------------------ System & Data

  test('System and Data shows backup, queue, migration, version and last operation', async () => {
    const { page, context } = await openSettings();
    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    const panel = await page.evaluate(() => ({
      overview: document.getElementById('systemOverview').textContent,
      backup: document.getElementById('backupStatus').textContent,
      queue: document.getElementById('jobQueueStatus').textContent,
      migration: document.getElementById('migrationStatus').textContent,
      audit: document.getElementById('auditList').textContent
    }));

    assert.match(panel.overview, /v2/, 'schema version');
    assert.match(panel.overview, /create_transaction/, 'last successful server operation');
    assert.match(panel.backup, /3/, 'backup count');
    assert.match(panel.queue, /HTTP 502/, 'failed jobs are named');
    assert.match(panel.migration, /Boshlanmagan/, 'migration status');
    assert.match(panel.audit, /transaction_created/, 'audit history');
    await context.close();
  });

  test('the system panel never shows a secret', async () => {
    const { page, context } = await openSettings();
    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    const html = await page.content();
    for (const secret of ['TELEGRAM_BOT_TOKEN', 'Snapshot_JSON', '123456789:']) {
      assert.ok(!html.includes(secret), `${secret} must not appear`);
    }
    await context.close();
  });

  test('admin-key actions are blocked until a key is entered', async () => {
    const { page, context, requests } = await openSettings();
    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    await page.evaluate(async () => {
      await createBackup();
      await processPendingJobs();
      await retryFailedJobs();
      await applyMigration();
    });

    for (const action of ['create_backup', 'process_jobs', 'retry_failed_jobs', 'apply_omad_migration']) {
      assert.deepStrictEqual(requests.filter(r => r.action === action), [], action);
    }
    await context.close();
  });

  test('with a key, the backup and retry controls call the server', async () => {
    const { page, context, requests } = await openSettings();
    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    await page.evaluate(async () => {
      document.getElementById('tgAdminKey').value = 'secret-key';
      await createBackup();
      await retryFailedJobs();
    });

    const backup = requests.find(r => r.action === 'create_backup');
    assert.strictEqual(backup.adminKey, 'secret-key');
    assert.ok(requests.find(r => r.action === 'retry_failed_jobs'));
    await context.close();
  });

  test('the migration preview reports the per-year breakdown and unresolved rows', async () => {
    const { page, context } = await openSettings({
      respond: payload => (payload.action === 'preview_omad_migration' ? {
        status: 'success',
        preview: {
          totalRows: 5, byYear: { 2026: 4, 2027: 1 },
          unresolved: [{ rowNumber: 7, id: '3_0', month: 'Mart', date: '' }],
          duplicateIds: [], canApply: false
        }
      } : null)
    });

    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    const preview = await page.evaluate(async () => {
      document.getElementById('tgAdminKey').value = 'secret-key';
      await previewMigration();
      return document.getElementById('migrationPreview').textContent;
    });

    assert.match(preview, /Jami 5 ta yozuv/);
    assert.match(preview, /2026/);
    assert.match(preview, /Qator 7/, 'the unresolved row is identified by sheet row');
    assert.match(preview, /Hali ko'chirib bo'lmaydi/);
    await context.close();
  });

  test('the migration controls dim once the cutover is done', async () => {
    const { page, context } = await openSettings({
      system: {
        ledgerActive: true,
        activeSheet: 'Omad_Transactions_V2',
        migration: { ...SYSTEM_STATUS.migration, state: 'cutover', activeSheet: 'Omad_Transactions_V2' }
      }
    });

    await page.evaluate(() => showSettingsSection('system'));
    await page.waitForFunction(() => systemStatus !== null);

    const state = await page.evaluate(() => ({
      dimmed: document.getElementById('migrationCard').classList.contains('opacity-60'),
      status: document.getElementById('migrationStatus').textContent,
      overview: document.getElementById('systemOverview').textContent
    }));

    assert.strictEqual(state.dimmed, true);
    assert.match(state.status, /Yoqilgan/);
    assert.match(state.overview, /Yangi \(V2\)/);
    await context.close();
  });

  // ----------------------------------------------------------------- layout

  for (const viewport of VIEWPORTS) {
    test(`every section fits at ${viewport.name}`, async () => {
      const { page, context, pageErrors } = await openSettings();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const section of SECTIONS) {
        await page.evaluate(name => showSettingsSection(name), section);
        if (section === 'system') await page.waitForFunction(() => systemStatus !== null);

        // Nothing may stick out past the right edge of its own card. Measuring
        // against the container rather than the viewport keeps this meaningful
        // whether or not the Tailwind CDN is reachable.
        const overflowing = await page.evaluate(name => {
          const panel = document.getElementById('settings-' + name);
          const offenders = [];
          panel.querySelectorAll('.card').forEach(card => {
            const cardRight = card.getBoundingClientRect().right;
            card.querySelectorAll('input, select, button, textarea').forEach(el => {
              const over = Math.round(el.getBoundingClientRect().right - cardRight);
              if (over > 1) offenders.push({ id: el.id || el.textContent.trim().slice(0, 20), over });
            });
          });
          return offenders;
        }, section);

        assert.deepStrictEqual(overflowing, [], `${section} overflows at ${viewport.width}px`);
      }

      assert.deepStrictEqual(pageErrors, []);
      await context.close();
    });
  }

  test('every control is visible and enabled at 320px', async () => {
    const { page, context } = await openSettings();
    await page.setViewportSize({ width: 320, height: 720 });

    const controls = {
      rates: ['#settingRateYear', '#settingMonth', '#settingRateBuyInput', '#settingRateSellInput'],
      tenants: ['#newTenantName', '#newTenantRent', '#newTenantCurr', '#addTenantBtn'],
      expenses: ['#templateExpenseName', '#templateExpenseAmount', '#templateExpenseCurr', '#templateExpenseMonth'],
      telegram: ['#tgAdminKey', '#tgBotToken', '#tgAuthorizedUserId', '#tgGroupChatId', '#tgSaveBtn'],
      system: ['#migrationFallbackYear']
    };

    for (const [section, selectors] of Object.entries(controls)) {
      await page.evaluate(name => showSettingsSection(name), section);
      for (const selector of selectors) {
        assert.ok(await page.isVisible(selector), `${selector} hidden at 320px`);
        assert.ok(await page.isEnabled(selector), `${selector} disabled at 320px`);
      }
    }
    await context.close();
  });

  test('numeric fields keep the mobile numeric keyboard', async () => {
    const { page, context } = await openSettings();

    const modes = await page.evaluate(() => ({
      buy: document.getElementById('settingRateBuyInput').getAttribute('inputmode'),
      sell: document.getElementById('settingRateSellInput').getAttribute('inputmode'),
      rent: document.getElementById('newTenantRent').getAttribute('inputmode'),
      expense: document.getElementById('templateExpenseAmount').getAttribute('inputmode'),
      userId: document.getElementById('tgAuthorizedUserId').getAttribute('inputmode')
    }));

    assert.deepStrictEqual(modes, {
      buy: 'decimal', sell: 'decimal', rent: 'decimal', expense: 'decimal', userId: 'numeric'
    });
    await context.close();
  });

  test('secret fields stay masked', async () => {
    const { page, context } = await openSettings();
    await page.evaluate(() => showSettingsSection('telegram'));

    assert.strictEqual(await page.getAttribute('#tgAdminKey', 'type'), 'password');
    assert.strictEqual(await page.getAttribute('#tgBotToken', 'type'), 'password');
    await context.close();
  });
});
