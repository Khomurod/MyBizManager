'use strict';

/**
 * No credential may ever reach the debug sheet.
 *
 * The live Telegram_Debug_Log had recorded the webhook verification secret,
 * because every Telegram API call logged its whole request body and setWebhook
 * carries that secret twice - once inside the callback URL as `wh=`, and once
 * as `secret_token`.
 *
 * Two defences are tested here: the request body is no longer logged at all,
 * and redaction removes credentials by value *and* by shape, so a value that
 * has been rotated since a log line was composed is still caught.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

// The one fixture token allowlisted by scripts/scan-secrets.js.
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const WEBHOOK_SECRET = 'whsec_5f3a9c2e8b7d41a6bc0e9f2d7a4b1c8e';
const ADMIN_KEY = 'admin_key_9f2b7c4d1e';
const GROUP_ID = '-1001234567890';

function props(extra) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OMAD_ADMIN_KEY: ADMIN_KEY,
    TELEGRAM_GROUP_CHAT_ID: GROUP_ID,
    TELEGRAM_AUTHORIZED_USER_ID: '49328655'
  }, extra || {});
}

function boot(options) {
  return loadScript(Object.assign({
    properties: props(),
    sheets: { System_Config: [['Omad_Rates', JSON.stringify({ Avgust: { buy: 12050, sell: 11930 } })]] }
  }, options || {}));
}

/** Everything ever written to the debug sheet, as one string. */
function debugText(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log');
  if (!sheet) return '';
  return sheet.getDataRange().getValues().map(r => r.join(' ')).join('\n');
}

const SECRETS = { 'bot token': BOT_TOKEN, 'webhook secret': WEBHOOK_SECRET, 'admin key': ADMIN_KEY };

function assertNoSecrets(text, context) {
  Object.keys(SECRETS).forEach(name => {
    assert.ok(text.indexOf(SECRETS[name]) === -1, `the ${name} must not appear in ${context}`);
  });
}

// --------------------------------------------------------- direct redaction

test('every stored credential is removed by value', () => {
  const gas = boot();
  const text = gas.redactSecrets_(
    `url=https://x/exec?wh=${WEBHOOK_SECRET} token=${BOT_TOKEN} adminKey=${ADMIN_KEY}`);
  assertNoSecrets(text, 'redacted text');
  assert.match(text, /\[REDACTED\]/);
});

test('a credential is removed by shape even when it is not the stored one', () => {
  const gas = boot();
  // An unknown secret - e.g. one already rotated - still must not survive.
  const unknown = 'ZZZunknownsecretvalue999';
  // Assembled at runtime so this file never itself contains something shaped
  // like a bot token - the secret scanner cannot tell a fixture from a leak.
  const tokenShaped = '9999999999' + ':' + 'BBCC' + 'ddeeffgghhiijjkkllmmnnooppqqrrss';
  const text = gas.redactSecrets_(
    `https://script.google.com/macros/s/AAA/exec?wh=${unknown}&x=1 ` +
    `{"secret_token":"${unknown}","authorization":"Bearer ${unknown}"} ` +
    tokenShaped);

  assert.ok(text.indexOf(unknown) === -1, 'an unknown secret is still redacted by shape');
  assert.ok(text.indexOf(tokenShaped) === -1, 'a token-shaped value is redacted');
  assert.match(text, /wh=\[REDACTED\]/);
});

test('redaction survives a missing or unreadable property store', () => {
  const gas = loadScript({ properties: {}, sheets: {} });
  assert.strictEqual(gas.redactSecrets_('nothing secret here'), 'nothing secret here');
  assert.doesNotThrow(() => gas.redactSecrets_(null));
});

test('ordinary text is left readable', () => {
  const gas = boot();
  assert.strictEqual(gas.redactSecrets_('Bad Request: message to delete not found'),
    'Bad Request: message to delete not found');
});

// ------------------------------------------------- what actually gets logged

test('configuring the webhook never writes the secret to the debug sheet', () => {
  const gas = boot({
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { url: 'https://x/exec', pending_update_count: 0 } })
    })
  });

  gas.doPost(postEvent({
    action: 'configure_telegram_webhook',
    adminKey: ADMIN_KEY,
    webhookUrl: 'https://script.google.com/macros/s/AAA/exec'
  }));

  const logged = debugText(gas);
  assert.ok(logged.length > 0, 'the call was logged at all');
  assertNoSecrets(logged, 'the debug log');
  assert.ok(logged.indexOf('secret_token') === -1, 'no secret_token field is logged');
  assert.ok(!/wh=[A-Za-z0-9_-]{8,}/.test(logged), 'no wh= value is logged');
});

test('a sent report logs the outcome but not the request body', () => {
  const gas = boot();
  gas.sendTelegramMessage_(GROUP_ID, 'YANGI CHIQIM 1000 UZS');

  const logged = debugText(gas);
  assertNoSecrets(logged, 'the debug log');
  assert.ok(logged.indexOf('YANGI CHIQIM') === -1, 'the message body is not logged');
  assert.match(logged, /telegram_api_sendMessage/, 'the operation is logged');
  assert.match(logged, /"code":200/, 'the result is logged');
  assert.ok(logged.indexOf(GROUP_ID) === -1, 'the raw chat id is masked');
  assert.match(logged, /7890/, 'but it is still recognisable');
});

test('a Telegram failure logs only the redacted description', () => {
  const gas = boot({
    fetch: () => ({
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({
        ok: false, error_code: 400,
        description: `Bad Request: bad webhook ?wh=${WEBHOOK_SECRET}`
      })
    })
  });

  try { gas.sendTelegramMessage_(GROUP_ID, 'x'); } catch (e) { /* expected */ }

  const logged = debugText(gas);
  assertNoSecrets(logged, 'the debug log after a failure');
  assert.match(logged, /Bad Request/, 'the useful part of the error survives');
});

test('an unauthorized webhook hit is logged without the secret it presented', () => {
  const gas = boot();
  gas.doPost(postEvent(
    { message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/yangi' } },
    { wh: 'wrong-secret-value-here' }
  ));

  const logged = debugText(gas);
  assert.ok(logged.indexOf('wrong-secret-value-here') === -1,
    'even a rejected secret is not written down');
});
