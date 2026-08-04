'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const ADMIN_KEY = 'test-admin-key';

function configured(extra = {}) {
  return Object.assign({
    OMAD_ADMIN_KEY: ADMIN_KEY,
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: '111222333',
    TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
  }, extra);
}

// ---------------------------------------------------------------- validation

test('token validation accepts a well-formed BotFather token', () => {
  const gas = loadScript();
  assert.strictEqual(gas.validateTelegramToken_(VALID_TOKEN), '');
});

test('token validation rejects empty and malformed tokens', () => {
  const gas = loadScript();
  assert.notStrictEqual(gas.validateTelegramToken_(''), '');
  assert.notStrictEqual(gas.validateTelegramToken_('not-a-token'), '');
  assert.notStrictEqual(gas.validateTelegramToken_('123:short'), '');
});

test('user id validation requires a positive integer', () => {
  const gas = loadScript();
  assert.strictEqual(gas.validateTelegramUserId_('123456789'), '');
  assert.notStrictEqual(gas.validateTelegramUserId_(''), '');
  assert.notStrictEqual(gas.validateTelegramUserId_('-5'), '');
  assert.notStrictEqual(gas.validateTelegramUserId_('@someuser'), '');
});

test('chat id validation accepts negative group ids and @usernames', () => {
  const gas = loadScript();
  assert.strictEqual(gas.validateTelegramChatId_('-1001234567890'), '');
  assert.strictEqual(gas.validateTelegramChatId_('@my_channel'), '');
  assert.notStrictEqual(gas.validateTelegramChatId_(''), '');
  assert.notStrictEqual(gas.validateTelegramChatId_('abc'), '');
});

// ------------------------------------------------------------ no hardcoding

test('bot token is empty when no Script Property is set', () => {
  const gas = loadScript();
  assert.strictEqual(gas.getBotToken_(), '');
});

test('group chat id comes from Script Properties, not from code', () => {
  const gas = loadScript({ properties: { TELEGRAM_GROUP_CHAT_ID: '-42' } });
  assert.strictEqual(gas.getOmadGroupChatId_(), '-42');
  assert.strictEqual(loadScript().getOmadGroupChatId_(), '');
});

// ------------------------------------------------------- token never leaks

test('settings view never contains the token', () => {
  const gas = loadScript({ properties: configured() });
  const view = gas.buildTelegramSettingsView_();
  assert.strictEqual(view.tokenConfigured, true);
  assert.ok(!JSON.stringify(view).includes(VALID_TOKEN));
  assert.strictEqual(view.botToken, undefined);
});

test('get_telegram_settings response never contains the token', () => {
  const gas = loadScript({ properties: configured() });
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_telegram_settings' })));
  assert.strictEqual(body.status, 'success');
  assert.ok(!JSON.stringify(body).includes(VALID_TOKEN));
});

test('save_telegram_settings response never echoes the token back', () => {
  const gas = loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY } });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    botToken: VALID_TOKEN,
    authorizedUserId: '111222333',
    groupChatId: '-1001234567890'
  })));
  assert.strictEqual(body.status, 'success');
  assert.ok(!JSON.stringify(body).includes(VALID_TOKEN));
  assert.strictEqual(gas.__properties.TELEGRAM_BOT_TOKEN, VALID_TOKEN);
});

test('redactSecrets_ strips the configured token and token-shaped strings', () => {
  const gas = loadScript({ properties: configured() });
  const text = `failed for https://api.telegram.org/bot${VALID_TOKEN}/getMe`;
  const redacted = gas.redactSecrets_(text);
  assert.ok(!redacted.includes(VALID_TOKEN));
  assert.ok(redacted.includes('[REDACTED]'));

  // Built from parts so this file contains no token-shaped literal of its own.
  const foreignToken = '987654321' + ':' + 'BBOtherTokenValue_9876543210zyxwvu';
  const other = gas.redactSecrets_('leaked ' + foreignToken);
  assert.ok(!other.includes('BBOtherTokenValue'));
  assert.ok(other.includes('[REDACTED]'));
});

test('debug log never records the token', () => {
  const gas = loadScript({ properties: configured() });
  gas.debugLog_(gas.__spreadsheet, 'test_event', `token=${VALID_TOKEN}`);
  const rows = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log').data;
  assert.ok(!JSON.stringify(rows).includes(VALID_TOKEN));
});

test('telegram API failure message is redacted before it is thrown', () => {
  const gas = loadScript({
    properties: configured(),
    fetch: () => ({
      getResponseCode: () => 401,
      getContentText: () => JSON.stringify({ ok: false, description: `Unauthorized for bot${VALID_TOKEN}` })
    })
  });
  const result = gas.testTelegramConnection_();
  assert.strictEqual(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes(VALID_TOKEN));
});

test('recorded last error is redacted in Script Properties', () => {
  const gas = loadScript({
    properties: configured(),
    fetch: () => ({
      getResponseCode: () => 500,
      getContentText: () => `boom ${VALID_TOKEN}`
    })
  });
  gas.testTelegramConnection_();
  assert.ok(!String(gas.__properties.TELEGRAM_LAST_ERROR || '').includes(VALID_TOKEN));
});

// ------------------------------------------------------------- admin gating

test('settings mutations are rejected without the admin key', () => {
  const gas = loadScript({ properties: configured() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    authorizedUserId: '999',
    groupChatId: '-1'
  })));
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(gas.__properties.TELEGRAM_AUTHORIZED_USER_ID, '111222333');
});

test('settings mutations are rejected when OMAD_ADMIN_KEY is not configured', () => {
  const gas = loadScript({ properties: { TELEGRAM_BOT_TOKEN: VALID_TOKEN } });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: 'anything',
    authorizedUserId: '999',
    groupChatId: '-1'
  })));
  assert.strictEqual(body.status, 'error');
  assert.ok(body.message.includes('OMAD_ADMIN_KEY'));
});

test('invalid settings are rejected and nothing is written', () => {
  const gas = loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY } });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    botToken: 'bad-token',
    authorizedUserId: 'abc',
    groupChatId: 'nope'
  })));
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(gas.__properties.TELEGRAM_BOT_TOKEN, undefined);
  assert.strictEqual(gas.__properties.TELEGRAM_AUTHORIZED_USER_ID, undefined);
});

test('saving without a token keeps the existing token', () => {
  const gas = loadScript({ properties: configured() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    authorizedUserId: '444555666',
    groupChatId: '-1009999999999'
  })));
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(gas.__properties.TELEGRAM_BOT_TOKEN, VALID_TOKEN);
  assert.strictEqual(gas.__properties.TELEGRAM_AUTHORIZED_USER_ID, '444555666');
});

test('audit log records the change without any secret value', () => {
  const gas = loadScript({ properties: configured() });
  gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    botToken: VALID_TOKEN,
    authorizedUserId: '111222333',
    groupChatId: '-1001234567890'
  }));
  const rows = gas.__spreadsheet.getSheetByName('Omad_Audit_Log').data;
  const serialized = JSON.stringify(rows);
  assert.ok(serialized.includes('telegram_settings_changed'));
  assert.ok(!serialized.includes(VALID_TOKEN));
});

// ---------------------------------------------------------- connection/test

test('test connection reports the bot username on success', () => {
  const gas = loadScript({
    properties: configured(),
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { id: 1, username: 'omad_bot', first_name: 'Omad' } })
    })
  });
  const result = gas.testTelegramConnection_();
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.bot.username, 'omad_bot');
  assert.ok(gas.__properties.TELEGRAM_LAST_SUCCESS);
});

test('test connection fails cleanly when no token is configured', () => {
  const gas = loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY } });
  assert.strictEqual(gas.testTelegramConnection_().status, 'error');
});

test('send test message fails cleanly when no group is configured', () => {
  const gas = loadScript({ properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: VALID_TOKEN } });
  assert.strictEqual(gas.sendTelegramTestMessage_().status, 'error');
});

test('webhook configuration stores status and rejects non-https urls', () => {
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
  assert.strictEqual(gas.configureTelegramWebhook_({ webhookUrl: 'http://insecure' }).status, 'error');

  const ok = gas.configureTelegramWebhook_({ webhookUrl: 'https://example.com/exec' });
  assert.strictEqual(ok.status, 'success');
  assert.strictEqual(ok.settings.webhookStatus.configured, true);
});

// -------------------------------------------- public Telegram proxy removed

test('the generic telegram_send/edit/delete proxy no longer exists', () => {
  const gas = loadScript({ properties: configured() });

  for (const action of ['telegram_send', 'telegram_edit', 'telegram_delete']) {
    const body = readJsonOutput(gas.doPost(postEvent({ action, text: 'hello', messageId: 555 })));
    assert.strictEqual(body.status, 'error', `${action} must not be handled`);
    assert.strictEqual(body.message, 'Unknown action');
  }

  assert.deepStrictEqual(gas.__sentMessages, [], 'no Telegram call may be made');
  assert.strictEqual(typeof gas.proxyTelegramGroupCall_, 'undefined');
});
