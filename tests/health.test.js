'use strict';

/**
 * The health check, and the one-press Mini App configuration.
 *
 * The health check exists because the things that break here break quietly: a
 * deployment nothing points at, a trigger someone deleted, a queue that has
 * been failing for a week. What is pinned below is that each of those is
 * actually detected, and that none of the answers contains a secret.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'health-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const WEBHOOK_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LIVE_URL = 'https://script.google.com/macros/s/AKfycDEPLOY/exec';
const MINI_URL = 'https://example-frontend.pages.dev/mini';

/** A Telegram that answers everything the way a healthy setup would. */
function healthyTelegram(overrides = {}) {
  return url => {
    const reply = body => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(body) });
    for (const method of Object.keys(overrides)) {
      if (url.indexOf('/' + method) !== -1) return reply(overrides[method]);
    }
    if (url.indexOf('/getMe') !== -1) return reply({ ok: true, result: { id: 1, username: 'omad_bot' } });
    if (url.indexOf('/getChatMenuButton') !== -1) {
      return reply({ ok: true, result: { type: 'web_app', text: '📊 Omad', web_app: { url: MINI_URL } } });
    }
    if (url.indexOf('/getWebhookInfo') !== -1) {
      return reply({ ok: true, result: { url: LIVE_URL + '?wh=x', pending_update_count: 0, last_error_message: '' } });
    }
    return reply({ ok: true, result: {} });
  };
}

function boot(options = {}) {
  return loadScript({
    properties: Object.assign({
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: '49328655',
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_TASKS_GROUP_CHAT_ID: '-1005436835402',
      TELEGRAM_WEBHOOK_URL: LIVE_URL,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_MINI_APP_URL: MINI_URL
    }, options.properties || {}),
    sheets: Object.assign({
      System_Config: [],
      Omad_Transactions: [['ID', 'Tenant']],
      Omad_Backups: [['Timestamp']],
      Omad_Audit_Log: [['Timestamp']],
      Omad_Job_Queue: [['Job_ID', 'Related_ID', 'Type', 'Payload_JSON', 'Status', 'Attempts', 'Next_Attempt_At', 'Last_Error', 'Created_At', 'Completed_At']],
      Cafe_Sales: [['Sana']],
      Tasks: [['ID']]
    }, options.sheets || {}),
    webAppUrl: options.webAppUrl === undefined ? LIVE_URL : options.webAppUrl,
    triggers: options.triggers === undefined ? ['processPendingTelegramJobs'] : options.triggers,
    fetch: options.fetch || healthyTelegram()
  });
}

function health(gas) {
  return readJsonOutput(gas.doPost(postEvent({ action: 'get_health', adminKey: ADMIN_KEY }))).health;
}

function find(report, id) {
  return report.checks.find(c => c.id === id);
}

test('the access check asks the router rather than reading a flag', () => {
  const gas = boot();
  assert.equal(find(health(gas), 'grace').status, 'ok');

  // Re-open the hole the way a careless edit would, and the check must notice.
  // It probes doGet exactly as an outsider with the /exec URL would, so it
  // reports what the deployed router does rather than what the source intends.
  const inert = gas.doGet;
  gas.doGet = (e) => (e && e.parameter && e.parameter.action === 'get_omad'
    ? gas.jsonOutput_({ status: 'success', transactions: [], tenants: [] })
    : inert(e));

  const reopened = find(health(gas), 'grace');
  assert.equal(reopened.status, 'error');
  assert.ok(reopened.message.includes('get_omad'), 'it names the route that answered');
});

test('a healthy system reports green across the board', () => {
  const gas = boot();
  const report = health(gas);
  assert.equal(report.status, 'ok');
  assert.equal(find(report, 'bot').status, 'ok');
  assert.equal(find(report, 'miniapp').status, 'ok');
  assert.equal(find(report, 'webhook').status, 'ok');
  assert.equal(find(report, 'trigger').status, 'ok');
  assert.equal(find(report, 'deployment').status, 'ok');
});

test('the check needs the admin key', () => {
  const gas = boot();
  assert.equal(readJsonOutput(gas.doPost(postEvent({ action: 'get_health' }))).status, 'error');
  assert.equal(readJsonOutput(gas.doPost(postEvent({ action: 'get_health', adminKey: 'wrong' }))).status, 'error');
});

test('nothing in the report is a secret', () => {
  const dump = JSON.stringify(health(boot()));
  assert.ok(!dump.includes(BOT_TOKEN));
  assert.ok(!dump.includes(WEBHOOK_SECRET));
  assert.ok(!dump.includes(ADMIN_KEY));
  assert.ok(!dump.includes('49328655'), 'the authorized user id is reported as configured, not printed');
  assert.ok(!dump.includes('-1005436835402'), 'nor is a chat id');
});

test('a webhook pointing at a different deployment is an error, not a shrug', () => {
  // The failure this project has actually had: "New deployment" mints a URL
  // nothing calls, so the code looks deployed while the app runs old code.
  const report = health(boot({ webAppUrl: 'https://script.google.com/macros/s/AKfycOTHER/exec' }));
  const check = find(report, 'deployment');
  assert.equal(check.status, 'error');
  assert.ok(check.message.includes('Webhook'));
  assert.equal(report.status, 'error');
});

test('a missing trigger is an error, because nothing would ever be sent', () => {
  const report = health(boot({ triggers: [] }));
  assert.equal(find(report, 'trigger').status, 'error');
});

test('a trigger for some other function does not count', () => {
  const report = health(boot({ triggers: ['someOtherFunction'] }));
  assert.equal(find(report, 'trigger').status, 'error');
});

test('an unconfigured Mini App is a warning with the fix named', () => {
  const report = health(boot({ fetch: healthyTelegram({ getChatMenuButton: { ok: true, result: { type: 'default' } } }) }));
  const check = find(report, 'miniapp');
  assert.equal(check.status, 'warning');
  assert.ok(check.message.includes('sozlash'));
});

test('a Mini App pointing somewhere else is flagged', () => {
  const report = health(boot({
    fetch: healthyTelegram({
      getChatMenuButton: { ok: true, result: { type: 'web_app', web_app: { url: 'https://elsewhere.example/mini' } } }
    })
  }));
  assert.equal(find(report, 'miniapp').status, 'warning');
});

test('a webhook Telegram is failing to deliver to is a warning carrying the reason', () => {
  const report = health(boot({
    fetch: healthyTelegram({
      getWebhookInfo: { ok: true, result: { url: LIVE_URL, pending_update_count: 3, last_error_message: 'Wrong response from the webhook' } }
    })
  }));
  const check = find(report, 'webhook');
  assert.equal(check.status, 'warning');
  assert.ok(check.message.includes('Wrong response'));
});

test('a disconnected webhook is an error', () => {
  const report = health(boot({ fetch: healthyTelegram({ getWebhookInfo: { ok: true, result: {} } }) }));
  assert.equal(find(report, 'webhook').status, 'error');
});

test('a bot that will not answer is an error, and does not take the check down with it', () => {
  const report = health(boot({
    fetch: url => {
      if (url.indexOf('/getMe') !== -1) {
        return { getResponseCode: () => 401, getContentText: () => JSON.stringify({ ok: false, description: 'Unauthorized' }) };
      }
      return healthyTelegram()(url);
    }
  }));
  assert.equal(find(report, 'bot').status, 'error');
  // The rest of the report still arrived.
  assert.ok(find(report, 'sheets'));
  assert.ok(find(report, 'queue'));
});

test('an @username tasks group is an error, a missing one only a warning', () => {
  assert.equal(find(health(boot({ properties: { TELEGRAM_TASKS_GROUP_CHAT_ID: '@omad_tasks' } })), 'tasksGroup').status, 'error');
  assert.equal(find(health(boot({ properties: { TELEGRAM_TASKS_GROUP_CHAT_ID: '' } })), 'tasksGroup').status, 'warning');
});

test('failed queue jobs are an error and pending ones are counted', () => {
  const gas = boot({
    sheets: {
      Omad_Job_Queue: [
        ['Job_ID', 'Related_ID', 'Type', 'Payload_JSON', 'Status', 'Attempts', 'Next_Attempt_At', 'Last_Error', 'Created_At', 'Completed_At'],
        ['j1', '', 'omad_transaction_report', '{}', 'Failed', 5, '', 'boom', '', '']
      ]
    }
  });
  const check = find(health(gas), 'queue');
  assert.equal(check.status, 'error');
  assert.ok(check.message.includes('1'));
});

test('V2 being off is reported as a fact, not a problem', () => {
  const check = find(health(boot()), 'ledger');
  assert.equal(check.status, 'ok');
  assert.ok(check.message.includes("o'chirilgan"));
});

test('a debug row that still looks like a credential is surfaced', () => {
  const gas = boot({
    sheets: {
      Telegram_Debug_Log: [
        ['Timestamp', 'Event', 'Details'],
        ['2026-02-01T00:00:00.000Z', 'telegram_api_setWebhook', 'wh=' + WEBHOOK_SECRET]
      ]
    }
  });
  const check = find(health(gas), 'secrets');
  assert.equal(check.status, 'warning');
  assert.ok(check.message.includes('Tozalash'));
  // The suspect value itself is never echoed back.
  assert.ok(!JSON.stringify(check).includes(WEBHOOK_SECRET));
});

test('a clean debug log reports clean', () => {
  const gas = boot({
    sheets: {
      Telegram_Debug_Log: [
        ['Timestamp', 'Event', 'Details'],
        ['2026-02-01T00:00:00.000Z', 'telegram_api_sendMessage', '{"code":200,"ok":true}']
      ]
    }
  });
  assert.equal(find(health(gas), 'secrets').status, 'ok');
});

test('the three data sections report their row counts', () => {
  const gas = boot();
  const report = health(gas);
  for (const id of ['omad', 'cafe', 'tasks']) {
    assert.ok(find(report, id), id + ' is reported');
  }
});

// ----------------------------------------------------- Mini App configuration

test('configuring the Mini App installs the menu button and verifies it', () => {
  const calls = [];
  const gas = boot({
    fetch: (url, params) => {
      calls.push({ url, body: params && params.payload ? JSON.parse(params.payload) : {} });
      return healthyTelegram()(url);
    }
  });

  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_mini_app', adminKey: ADMIN_KEY, miniAppUrl: MINI_URL
  })));

  assert.equal(result.status, 'success');
  assert.equal(result.ready, true);

  const set = calls.find(c => c.url.indexOf('/setChatMenuButton') !== -1);
  assert.ok(set, 'the menu button is set through the Bot API, not BotFather');
  assert.equal(set.body.menu_button.type, 'web_app');
  assert.equal(set.body.menu_button.web_app.url, MINI_URL);

  // Written, then read back: setChatMenuButton answers ok for URLs Telegram
  // will later refuse to open.
  assert.ok(calls.some(c => c.url.indexOf('/getChatMenuButton') !== -1));
  assert.equal(gas.__properties.TELEGRAM_MINI_APP_URL, MINI_URL);
});

test('a menu button Telegram does not confirm is reported as not ready', () => {
  const gas = boot({ fetch: healthyTelegram({ getChatMenuButton: { ok: true, result: { type: 'default' } } }) });
  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_mini_app', adminKey: ADMIN_KEY, miniAppUrl: MINI_URL
  })));

  assert.equal(result.ready, false);
  assert.equal(result.steps.find(s => s.id === 'menu').status, 'error');
});

test('a non-https Mini App URL is refused before anything is called', () => {
  const calls = [];
  const gas = boot({
    fetch: (url) => { calls.push(url); return healthyTelegram()(url); }
  });
  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_mini_app', adminKey: ADMIN_KEY, miniAppUrl: 'http://example-frontend.pages.dev/mini'
  })));

  assert.equal(result.status, 'error');
  assert.equal(calls.length, 0);
});

test('configuring without an authorized user reports it rather than half-succeeding', () => {
  const gas = boot({ properties: { TELEGRAM_AUTHORIZED_USER_ID: '' } });
  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_mini_app', adminKey: ADMIN_KEY, miniAppUrl: MINI_URL
  })));

  assert.equal(result.ready, false);
  assert.equal(result.steps.find(s => s.id === 'user').status, 'error');
});

test('the configuration action needs the admin key', () => {
  const gas = boot();
  assert.equal(readJsonOutput(gas.doPost(postEvent({ action: 'configure_mini_app' }))).status, 'error');
});

test('the Mini App URL is reported in settings, and no secret is', () => {
  const gas = boot();
  gas.doPost(postEvent({ action: 'configure_mini_app', adminKey: ADMIN_KEY, miniAppUrl: MINI_URL }));

  const view = readJsonOutput(gas.doPost(postEvent({ action: 'get_telegram_settings', adminKey: ADMIN_KEY }))).settings;
  assert.equal(view.miniAppUrl, MINI_URL);
  assert.equal(view.miniAppStatus.ready, true);

  const dump = JSON.stringify(view);
  assert.ok(!dump.includes(BOT_TOKEN));
  assert.ok(!dump.includes(WEBHOOK_SECRET));
});

test('configuring with no URL at all is refused rather than defaulted', () => {
  // There used to be a hardcoded Netlify default here. A default that outlives
  // the host it names installs a menu button pointing at a 404, which reads as
  // "configured" in every status view. Nothing is called and nothing is stored.
  const calls = [];
  const gas = boot({
    properties: { TELEGRAM_MINI_APP_URL: '' },
    fetch: (url) => { calls.push(url); return healthyTelegram()(url); }
  });

  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_mini_app', adminKey: ADMIN_KEY
  })));

  assert.equal(result.status, 'error');
  assert.equal(calls.length, 0, 'Telegram is not called with a guessed URL');
});
