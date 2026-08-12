'use strict';

/**
 * Proves that an unauthenticated caller cannot send, edit or delete an
 * arbitrary Telegram message through the Apps Script endpoint.
 *
 * The generic proxy is gone: the browser can only submit *business
 * operations*, and the message text is composed on the server from data the
 * server already stored.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const GROUP_ID = '-1001234567890';
const ADMIN_KEY = 'correct-admin-key';

function configured(extra = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_GROUP_CHAT_ID: GROUP_ID,
    TELEGRAM_AUTHORIZED_USER_ID: '111222333',
    OMAD_ADMIN_KEY: ADMIN_KEY
  }, extra);
}

/** Every Telegram API method the mock fetch was asked to call. */
function telegramMethods(gas) {
  return gas.__fetchCalls.map(call => String(call.url).split('/').pop());
}

// ------------------------------------------------- the proxy actions are gone

test('telegram_send, telegram_edit and telegram_delete are not callable at all', () => {
  const gas = loadScript({ properties: configured() });

  const attempts = [
    { action: 'telegram_send', text: 'Bank hisobiga 100 000 000 UZS o\'tkazing' },
    { action: 'telegram_edit', messageId: '555', text: 'edited' },
    { action: 'telegram_delete', messageId: '555' }
  ];

  for (const attempt of attempts) {
    const body = readJsonOutput(gas.doPost(postEvent(attempt)));
    assert.strictEqual(body.status, 'error', `${attempt.action} must be rejected`);
    assert.strictEqual(body.message, 'Unknown action');
  }

  assert.deepStrictEqual(telegramMethods(gas), [], 'no Telegram API call may happen');
});

test('an unauthenticated caller cannot smuggle text through a save_omad report', () => {
  const gas = loadScript({
    properties: configured(),
    sheets: { System_Config: [['Omad_Tenants', '[]']] }
  });

  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [],
    tenants: [],
    rates: {},
    templateExpenses: [],
    telegramReport: {
      operation: 'transaction_upsert',
      baseId: 'nonexistent',
      // These are the fields an attacker would want honoured.
      text: 'ATTACKER CONTROLLED TEXT',
      chatId: '-100999',
      parseMode: 'HTML'
    }
  })));

  assert.strictEqual(body.status, 'success');
  const sentText = gas.__sentMessages.map(m => m.text).join('\n');
  assert.ok(!sentText.includes('ATTACKER CONTROLLED TEXT'), 'attacker text must never be sent');
  assert.ok(!gas.__sentMessages.some(m => String(m.chat_id) === '-100999'), 'chat id is server-chosen');
});

test('an invalid telegramReport is rejected before anything is written', () => {
  const gas = loadScript({
    properties: configured(),
    sheets: { System_Config: [['Omad_Tenants', '[]']] }
  });

  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [],
    telegramReport: { operation: 'send_anything', text: 'hi' }
  })));

  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /operation/);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Backups'), null, 'nothing may be written');
});

test('a reported transaction group is described from stored data, not from the request', () => {
  const gas = loadScript({
    properties: configured(),
    sheets: { System_Config: [['Omad_Rates', JSON.stringify({ Fevral: { buy: 12000, sell: 12500 } })]] }
  });

  readJsonOutput(gas.doPost(postEvent({
    action: 'save_omad', adminKey: ADMIN_KEY,
    transactions: [{
      id: '1700000000000_0',
      tenant: 'Tehnopark',
      month: 'Fevral',
      type: 'Income',
      amount: 5000000,
      currency: 'UZS',
      method: 'Naqd',
      date: '01/02/2026',
      comment: 'Fevral ijara'
    }],
    tenants: [],
    rates: { Fevral: { buy: 12000, sell: 12500 } },
    templateExpenses: [],
    telegramReport: { operation: 'transaction_upsert', baseId: '1700000000000' }
  })));

  assert.strictEqual(gas.__sentMessages.length, 1);
  const message = gas.__sentMessages[0];
  assert.strictEqual(String(message.chat_id), GROUP_ID);
  assert.match(message.text, /YANGI KIRIM/);
  assert.match(message.text, /Tehnopark/);
  assert.match(message.text, /Fevral ijara/);
});

// --------------------------------------------------------- webhook validation

test('a webhook update without the configured secret changes nothing', () => {
  const gas = loadScript({
    properties: configured({ TELEGRAM_WEBHOOK_SECRET: 'super-secret-value' }),
    sheets: { System_Config: [['Omad_Tenants', '[]']] },
    cache: {
      yangi_111222333: JSON.stringify({
        type: 'Income', tenant: 'Tehnopark', method: 'Naqd',
        currency: 'UZS', amount: 1000, step: 'await_desc', sessionId: 'abc'
      })
    }
  });

  gas.doPost(postEvent(
    { message: { chat: { id: 111222333, type: 'private' }, from: { id: 111222333 }, text: 'izoh' } },
    { wh: 'wrong-secret' }
  ));

  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions'), null, 'no transaction may be written');
  assert.deepStrictEqual(telegramMethods(gas), [], 'no Telegram reply may be sent');
});

test('a webhook update carrying the configured secret is processed', () => {
  const gas = loadScript({
    properties: configured({ TELEGRAM_WEBHOOK_SECRET: 'super-secret-value' }),
    sheets: { System_Config: [['Omad_Tenants', '[]']] },
    cache: {
      yangi_111222333: JSON.stringify({
        type: 'Income', tenant: 'Tehnopark', method: 'Naqd',
        currency: 'UZS', amount: 1000, step: 'await_desc', sessionId: 'abc'
      })
    }
  });

  gas.doPost(postEvent(
    { message: { chat: { id: 111222333, type: 'private' }, from: { id: 111222333 }, text: 'izoh' } },
    { wh: 'super-secret-value' }
  ));

  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');
  assert.ok(sheet && sheet.getLastRow() === 2, 'exactly one transaction is written');
});

test('the webhook secret is never exposed to the browser', () => {
  const gas = loadScript({ properties: configured({ TELEGRAM_WEBHOOK_SECRET: 'super-secret-value' }) });
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_telegram_settings' , adminKey: ADMIN_KEY,})));
  const serialized = JSON.stringify(body);

  assert.strictEqual(body.settings.webhookSecretConfigured, true);
  assert.ok(!serialized.includes('super-secret-value'), 'the secret itself must never be returned');
  assert.ok(!serialized.includes(VALID_TOKEN), 'the bot token must never be returned');
  assert.ok(!serialized.includes(ADMIN_KEY), 'the admin key must never be returned');
});

test('configuring the webhook appends a server-generated secret to the callback url', () => {
  const gas = loadScript({
    properties: configured(),
    fetch: url => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(
        url.indexOf('getWebhookInfo') !== -1
          ? { ok: true, result: { url: 'https://example.com/exec', pending_update_count: 0 } }
          : { ok: true, result: true }
      )
    })
  });

  const result = readJsonOutput(gas.doPost(postEvent({
    action: 'configure_telegram_webhook',
    adminKey: ADMIN_KEY,
    webhookUrl: 'https://example.com/exec'
  })));

  assert.strictEqual(result.status, 'success');
  const setWebhook = gas.__fetchCalls.find(call => call.url.indexOf('setWebhook') !== -1);
  const body = JSON.parse(setWebhook.params.payload);
  assert.match(body.url, /^https:\/\/example\.com\/exec\?wh=[0-9a-f]{40,}$/);
  assert.strictEqual(body.secret_token, body.url.split('wh=')[1]);
  // Stored settings keep the clean url; the secret lives only in properties.
  assert.strictEqual(result.settings.webhookUrl, 'https://example.com/exec');
  assert.ok(!JSON.stringify(result).includes(body.secret_token));
});

test('re-configuring an already-secret-carrying url does not double-append', () => {
  const gas = loadScript({
    properties: configured({ TELEGRAM_WEBHOOK_SECRET: 'abcdef' }),
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: {} }) })
  });

  gas.configureTelegramWebhook_({ webhookUrl: 'https://example.com/exec?wh=abcdef' });
  const setWebhook = gas.__fetchCalls.find(call => call.url.indexOf('setWebhook') !== -1);
  assert.strictEqual(JSON.parse(setWebhook.params.payload).url, 'https://example.com/exec?wh=abcdef');
});

// ------------------------------------------------- rate limiting & size limits

test('admin Telegram actions are rate limited before the key is compared', () => {
  const gas = loadScript({ properties: configured() });

  let lastMessage = '';
  for (let i = 0; i < gas.TELEGRAM_ADMIN_RATE_LIMIT + 1; i++) {
    lastMessage = readJsonOutput(gas.doPost(postEvent({
      action: 'test_telegram_connection',
      adminKey: 'guess-' + i
    }))).message;
  }

  assert.match(lastMessage, /Juda ko'p so'rov/);
});

test('over-long Telegram settings fields are rejected', () => {
  const gas = loadScript({ properties: configured() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    botToken: 'x'.repeat(5000),
    authorizedUserId: '111222333',
    groupChatId: GROUP_ID
  })));

  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /juda uzun/);
});

test('a queued report message is capped in length', () => {
  const gas = loadScript({ properties: configured() });
  const text = gas.buildCafeCloseDayMessage_({
    date: '2026-02-01T09:00:00.000Z',
    seller: 'Kassir',
    totalRevenue: 1,
    totalProfit: 1,
    soldItems: Array.from({ length: 5000 }, (_, i) => ({ name: 'Mahsulot ' + i, qty: 1 }))
  });
  assert.ok(text.length <= gas.TELEGRAM_MAX_TEXT_LENGTH);
});

test('close-day report escapes HTML from the café payload', () => {
  const gas = loadScript({ properties: configured() });
  const text = gas.buildCafeCloseDayMessage_({
    date: '2026-02-01T09:00:00.000Z',
    seller: '<script>alert(1)</script>',
    totalRevenue: 0,
    totalProfit: 0,
    soldItems: [{ name: '<b>evil</b>', qty: 2 }]
  });
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;b&gt;evil&lt;/b&gt;'));
});
