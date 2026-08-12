'use strict';

/**
 * The historical-secret cleanup must not duplicate the thing it removes.
 *
 * The first implementation copied Telegram_Debug_Log to a backup tab and *then*
 * redacted the original. That leaves the leaked webhook secret sitting in the
 * backup, so a cleanup run made the exposure wider rather than narrower. These
 * tests pin the order: nothing is written anywhere until it has been through
 * the redactor.
 *
 * Every secret here is invented for the test. The real webhook secret is in
 * Script Properties and never appears in this repository.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

// Fixtures only. `whsec_` shaped like the real one (hex, long) so the
// by-shape redaction rules are genuinely exercised.
const FAKE_WEBHOOK_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FAKE_ROTATED_SECRET = '0f9e8d7c6b5a493827160f9e8d7c6b5a493827160f9e8d7c6b5a493827160f9e';
const ADMIN_KEY = 'purge-test-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LOG_HEADER = ['Timestamp', 'Event', 'Details'];

/** A debug row shaped like the ones that actually leaked. */
function leakedRow(when, secret) {
  return [when, 'telegram_api_setWebhook',
    `{"url":"https://script.google.com/macros/s/AAA/exec?wh=${secret}",` +
    `"secret_token":"${secret}"}`];
}

function cleanRow(when) {
  return [when, 'telegram_api_sendMessage', '{"code":200,"chat":"***7890"}'];
}

function boot(sheets) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: Object.assign({ System_Config: [['Omad_Rates', '{}']] }, sheets || {})
  });
}

/** Every cell of every sheet, as one searchable string. */
function everything(gas) {
  return gas.__spreadsheet.getSheets()
    .map(s => `--- ${s.getName()}\n` + s.getDataRange().getValues().map(r => r.join(' ')).join('\n'))
    .join('\n');
}

function sheetNames(gas) {
  return gas.__spreadsheet.getSheets().map(s => s.getName());
}

function backupNames(gas) {
  return sheetNames(gas).filter(n => n.indexOf('Telegram_Debug_Log_Backup_') === 0);
}

/** Just the log and its backups - the sheets the cleanup is allowed to touch. */
function logsAndBackups(gas) {
  return gas.__spreadsheet.getSheets()
    .filter(s => s.getName() === 'Telegram_Debug_Log' || backupNames(gas).indexOf(s.getName()) !== -1)
    .map(s => `--- ${s.getName()}\n` + s.getDataRange().getValues().map(r => r.join(' ')).join('\n'))
    .join('\n');
}

// ------------------------------------------------------------------ the fix

test('the backup is written already redacted, never raw', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  const result = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.redacted, 1);

  const backups = backupNames(gas);
  assert.strictEqual(backups.length, 1, 'one backup was taken');

  const backup = gas.__spreadsheet.getSheetByName(backups[0]);
  const backupText = backup.getDataRange().getValues().map(r => r.join(' ')).join('\n');
  assert.ok(backupText.indexOf(FAKE_WEBHOOK_SECRET) === -1,
    'the secret must not survive in the cleanup backup');
  assert.match(backupText, /REDACTED/, 'the backup still records that the row existed');
});

test('the secret is gone from every sheet in the spreadsheet', () => {
  const gas = boot({
    Telegram_Debug_Log: [
      LOG_HEADER,
      leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET),
      cleanRow('2026-08-01T10:05:00Z'),
      leakedRow('2026-08-02T11:00:00Z', FAKE_ROTATED_SECRET)
    ]
  });

  gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  const text = everything(gas);
  assert.ok(text.indexOf(FAKE_WEBHOOK_SECRET) === -1, 'the stored secret is gone everywhere');
  assert.ok(text.indexOf(FAKE_ROTATED_SECRET) === -1,
    'an already-rotated secret is caught by shape and gone too');
});

test('backups left by an older cleanup are swept as well', () => {
  // Exactly the damage the previous implementation did: a raw copy in a tab.
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, cleanRow('2026-08-03T09:00:00Z')],
    Telegram_Debug_Log_Backup_20260801_120000: [
      LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)
    ]
  });

  const result = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  assert.deepStrictEqual(Array.from(result.backupsSwept),
    ['Telegram_Debug_Log_Backup_20260801_120000']);
  assert.strictEqual(result.backupRowsRedacted, 1);
  assert.ok(everything(gas).indexOf(FAKE_WEBHOOK_SECRET) === -1,
    'the secret is removed from the pre-existing backup too');
});

test('a clean log produces no backup at all', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, cleanRow('2026-08-03T09:00:00Z')]
  });

  const result = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  assert.strictEqual(result.redacted, 0);
  assert.strictEqual(result.backupSheet, '');
  assert.deepStrictEqual(backupNames(gas), [], 'nothing to protect, nothing copied');
});

test('running the cleanup twice changes nothing the second time', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  const first = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  const before = logsAndBackups(gas);
  const backupsAfterFirst = backupNames(gas);
  const second = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  assert.strictEqual(first.redacted, 1);
  assert.strictEqual(second.redacted, 0, 'the second run finds nothing left to do');
  assert.strictEqual(second.backupSheet, '', 'and takes no second copy');
  assert.deepStrictEqual(backupNames(gas), backupsAfterFirst, 'no new backup tab appears');
  assert.strictEqual(logsAndBackups(gas), before, 'the log and its backup are unchanged');
  // The audit trail is append-only and is *expected* to grow: a cleanup that
  // ran and found nothing is a fact worth keeping.
});

test('the row itself is preserved, only the credential is replaced', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  const row = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log').getDataRange().getValues()[1];
  assert.strictEqual(row[0], '2026-08-01T10:00:00Z', 'the timestamp is untouched');
  assert.strictEqual(row[1], 'telegram_api_setWebhook', 'the event name is untouched');
  assert.match(String(row[2]), /REDACTED/, 'the details keep their shape minus the secret');
});

// ----------------------------------------------------------- audit & reporting

test('the audit reports counts, never the offending value', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  const before = gas.auditTelegramSecretExposure_(gas.__spreadsheet);
  assert.strictEqual(before.clean, false);
  assert.strictEqual(before.exposedRows, 1);
  assert.ok(JSON.stringify(before).indexOf(FAKE_WEBHOOK_SECRET) === -1,
    'the audit output carries no secret');

  gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  const after = gas.auditTelegramSecretExposure_(gas.__spreadsheet);
  assert.strictEqual(after.clean, true, 'the audit is clean once the purge has run');
  assert.strictEqual(after.exposedRows, 0);
});

test('the audit sees a leak sitting in a backup tab', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, cleanRow('2026-08-03T09:00:00Z')],
    Telegram_Debug_Log_Backup_20260801_120000: [
      LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)
    ]
  });

  const audit = gas.auditTelegramSecretExposure_(gas.__spreadsheet);
  assert.strictEqual(audit.clean, false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(audit.sheets)),
    [{ sheet: 'Telegram_Debug_Log_Backup_20260801_120000', rows: 1 }]);
});

test('the audit response carries no secret through the API either', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  const response = gas.doPost(postEvent({
    action: 'audit_telegram_secret_exposure', adminKey: ADMIN_KEY
  })).getContent();

  assert.ok(response.indexOf(FAKE_WEBHOOK_SECRET) === -1, 'no secret in the API response');
  assert.match(response, /"exposedRows":1/);
});

test('the purge response carries no secret through the API either', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  const response = gas.doPost(postEvent({
    action: 'purge_telegram_debug_secrets', adminKey: ADMIN_KEY
  })).getContent();

  assert.ok(response.indexOf(FAKE_WEBHOOK_SECRET) === -1, 'no secret in the API response');
  assert.match(response, /"redacted":1/);
});

// ------------------------------------------------------------------- access

test('the cleanup and its audit both require the admin key', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  ['purge_telegram_debug_secrets', 'audit_telegram_secret_exposure'].forEach(action => {
    const anonymous = gas.doPost(postEvent({ action })).getContent();
    assert.match(anonymous, /"status":"error"/, `${action} refuses an anonymous caller`);

    const wrongKey = gas.doPost(postEvent({ action, adminKey: 'not-the-key' })).getContent();
    assert.match(wrongKey, /"status":"error"/, `${action} refuses a wrong key`);
  });

  // ...and the log is untouched by the refused attempts.
  assert.strictEqual(gas.auditTelegramSecretExposure_(gas.__spreadsheet).exposedRows, 1);
});

// --------------------------------------------------------- the audit trail

test('the audit trail records the sweep without naming a secret', () => {
  const gas = boot({
    Telegram_Debug_Log: [LOG_HEADER, leakedRow('2026-08-01T10:00:00Z', FAKE_WEBHOOK_SECRET)]
  });

  gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);

  const history = gas.__spreadsheet.getSheetByName('Omad_Audit_Log');
  assert.ok(history, 'the run is recorded');
  const text = history.getDataRange().getValues().map(r => r.join(' ')).join('\n');
  assert.match(text, /telegram_debug_log_redacted/);
  assert.ok(text.indexOf(FAKE_WEBHOOK_SECRET) === -1, 'the audit trail carries no secret');
});
