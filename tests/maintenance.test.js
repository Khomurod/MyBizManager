'use strict';

/**
 * Operator maintenance: the historical date repair, the debug-log secret
 * cleanup and the webhook secret rotation.
 *
 * All three touch live data or live credentials, so what is pinned here is
 * mostly what they refuse to do — guess at a date, expose a secret, or leave
 * the bot deaf after a failed rotation.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'maintenance-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const WEBHOOK_URL = 'https://script.google.com/macros/s/AAA/exec';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID'
];

/**
 * A date the harness's Utilities.formatDate will render the same way the audit
 * does, expressed from the same instant the id encodes.
 */
function partsFor(millis) {
  const value = new Date(millis);
  return { day: value.getDate(), month: value.getMonth() + 1, year: value.getFullYear() };
}

function text(parts) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
}

/** The same instant with day and month swapped — the corruption being repaired. */
function swapped(parts) {
  return { day: parts.month, month: parts.day, year: parts.year };
}

function bootDates(rows) {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify({ '2026-02': { buy: 12000, sell: 12500 } })]],
      Omad_Transactions: [LEGACY_HEADER, ...rows]
    }
  });
}

function row(id, dateValue) {
  return [id, 'Tehnopark', '2026-02', 'Income', 1000000, 'UZS', 'Naqd', dateValue, 'ijara', '', '', ''];
}

// A transaction created mid-morning on a day whose number is <= 12, so the
// transposition is representable at all.
const TRANSPOSED_ID = String(Date.UTC(2026, 1, 5, 9, 30));   // 5 February 2026
const CORRECT_ID = String(Date.UTC(2026, 1, 20, 9, 30));     // 20 February 2026

test('a date the id proves is transposed is reported, with the correction it implies', () => {
  const parts = partsFor(Number(TRANSPOSED_ID));
  const gas = bootDates([row(TRANSPOSED_ID + '_0', new Date(parts.year, swapped(parts).month - 1, swapped(parts).day))]);

  const audit = gas.auditTransactionDates_(gas.__spreadsheet);
  assert.equal(audit.total, 1);
  assert.equal(audit.transposed, 1);
  assert.equal(audit.unprovable, 0);
  assert.equal(audit.transposedSample[0].correct, text(parts));
});

test('a date that already agrees with its id is left alone', () => {
  const parts = partsFor(Number(CORRECT_ID));
  const gas = bootDates([row(CORRECT_ID + '_0', new Date(parts.year, parts.month - 1, parts.day))]);

  const audit = gas.auditTransactionDates_(gas.__spreadsheet);
  assert.equal(audit.correct, 1);
  assert.equal(audit.transposed, 0);
});

test('a date that disagrees in some other way is reported but never corrected', () => {
  const gas = bootDates([row(TRANSPOSED_ID + '_0', new Date(2026, 6, 19))]);

  const audit = gas.auditTransactionDates_(gas.__spreadsheet);
  assert.equal(audit.transposed, 0);
  assert.equal(audit.unprovable, 1);

  const fixed = gas.fixTransposedTransactionDates_(gas.__spreadsheet, {});
  assert.equal(fixed.fixed, 0);
  // The cell is exactly as it was: nothing was guessed at.
  assert.equal(gas.__spreadsheet.getSheetByName('Omad_Transactions').data[1][7].getMonth(), 6);
});

test('a row whose id carries no usable timestamp is skipped rather than guessed at', () => {
  const gas = bootDates([row('legacy-row-1', new Date(2026, 4, 2))]);

  const audit = gas.auditTransactionDates_(gas.__spreadsheet);
  assert.equal(audit.noIdTimestamp, 1);
  assert.equal(audit.transposed, 0);
  assert.equal(gas.fixTransposedTransactionDates_(gas.__spreadsheet, {}).fixed, 0);
});

test('the repair corrects only the provable rows, and backs up before it writes', () => {
  const bad = partsFor(Number(TRANSPOSED_ID));
  const good = partsFor(Number(CORRECT_ID));
  const gas = bootDates([
    row(TRANSPOSED_ID + '_0', new Date(bad.year, swapped(bad).month - 1, swapped(bad).day)),
    row(CORRECT_ID + '_0', new Date(good.year, good.month - 1, good.day)),
    row(TRANSPOSED_ID + '_1', new Date(2026, 6, 19))
  ]);

  const result = gas.fixTransposedTransactionDates_(gas.__spreadsheet, {});
  assert.equal(result.status, 'success');
  assert.equal(result.fixed, 1);
  assert.equal(result.audit.transposed, 0, 'nothing transposed is left behind');
  assert.equal(result.audit.unprovable, 1, 'the unprovable row is still reported');

  const stored = gas.__spreadsheet.getSheetByName('Omad_Transactions').data;
  assert.equal(stored[1][7].getDate(), bad.day);
  assert.equal(stored[1][7].getMonth() + 1, bad.month);

  assert.ok(gas.__spreadsheet.getSheetByName('Omad_Backups').data.length > 1, 'a backup is written first');
});

test('a dry run reports what would change and writes nothing', () => {
  const bad = partsFor(Number(TRANSPOSED_ID));
  const gas = bootDates([row(TRANSPOSED_ID + '_0', new Date(bad.year, swapped(bad).month - 1, swapped(bad).day))]);

  const result = gas.fixTransposedTransactionDates_(gas.__spreadsheet, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.audit.transposed, 1);
  assert.equal(result.fixed, 0);
  assert.equal(gas.__spreadsheet.getSheetByName('Omad_Transactions').data[1][7].getDate(), swapped(bad).day);
  assert.equal(gas.__spreadsheet.getSheetByName('Omad_Backups'), null, 'a dry run does not even back up');
});

test('running the repair twice corrects nothing the second time', () => {
  const bad = partsFor(Number(TRANSPOSED_ID));
  const gas = bootDates([row(TRANSPOSED_ID + '_0', new Date(bad.year, swapped(bad).month - 1, swapped(bad).day))]);

  assert.equal(gas.fixTransposedTransactionDates_(gas.__spreadsheet, {}).fixed, 1);
  assert.equal(gas.fixTransposedTransactionDates_(gas.__spreadsheet, {}).fixed, 0);
});

test('the date actions require the admin key', () => {
  const gas = bootDates([]);
  for (const action of ['audit_transaction_dates', 'fix_transaction_dates', 'backfill_entry_group_ids',
                        'purge_telegram_debug_secrets', 'rotate_telegram_webhook_secret']) {
    const response = readJsonOutput(gas.doPost(postEvent({ action })));
    assert.equal(response.status, 'error', `${action} must refuse an unauthenticated caller`);
  }
});

// ------------------------------------------------------------- log cleanup

const OLD_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function bootLogs(rows) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_URL: WEBHOOK_URL
    },
    sheets: {
      System_Config: [],
      Telegram_Debug_Log: [['Timestamp', 'Event', 'Details'], ...rows]
    }
  });
}

test('a historical row containing the old webhook secret is redacted in place', () => {
  const gas = bootLogs([
    ['2026-02-01T00:00:00.000Z', 'telegram_api_setWebhook',
     `{"url":"${WEBHOOK_URL}?wh=${OLD_SECRET}","secret_token":"${OLD_SECRET}"}`],
    ['2026-02-01T00:01:00.000Z', 'telegram_update_received', '{"chatId":111,"text":"/yangi"}']
  ]);

  const result = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  assert.equal(result.status, 'success');
  assert.equal(result.rows, 2);
  assert.equal(result.redacted, 1);

  const details = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log').data.map(r => r[2]).join('\n');
  assert.ok(!details.includes(OLD_SECRET), 'the secret must be gone from the live sheet');
  assert.ok(details.includes('[REDACTED]'));
  // An ordinary row is untouched.
  assert.ok(details.includes('/yangi'));
});

test('a bare high-entropy value with no surrounding context is still removed', () => {
  const gas = bootLogs([['2026-02-01T00:00:00.000Z', 'telegram_webhook_rejected', `provided ${OLD_SECRET}`]]);

  gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  const details = String(gas.__spreadsheet.getSheetByName('Telegram_Debug_Log').data[1][2]);
  assert.ok(!details.includes(OLD_SECRET));
});

test('the rows are copied to a backup sheet before anything is rewritten', () => {
  const gas = bootLogs([['2026-02-01T00:00:00.000Z', 'telegram_api_setWebhook', `wh=${OLD_SECRET}`]]);

  const result = gas.purgeTelegramDebugSecrets_(gas.__spreadsheet);
  assert.ok(result.backupSheet.startsWith('Telegram_Debug_Log_Backup_'));

  const backup = gas.__spreadsheet.getSheetByName(result.backupSheet);
  assert.ok(backup, 'the backup sheet exists');
  assert.equal(backup.data.length, 2, 'header plus the one copied row');
});

test('running the cleanup twice redacts nothing the second time', () => {
  const gas = bootLogs([['2026-02-01T00:00:00.000Z', 'telegram_api_setWebhook', `wh=${OLD_SECRET}`]]);

  assert.equal(gas.purgeTelegramDebugSecrets_(gas.__spreadsheet).redacted, 1);
  assert.equal(gas.purgeTelegramDebugSecrets_(gas.__spreadsheet).redacted, 0);
});

// -------------------------------------------------------- secret rotation

function bootRotation(fetchImpl) {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_URL: WEBHOOK_URL,
      TELEGRAM_WEBHOOK_SECRET: OLD_SECRET
    },
    sheets: { System_Config: [] },
    fetch: fetchImpl
  });
}

const okFetch = () => ({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({ ok: true, result: { url: WEBHOOK_URL + '?wh=x', pending_update_count: 0 } })
});

test('a successful rotation installs a new secret and never returns it', () => {
  const gas = bootRotation(okFetch);

  const result = gas.rotateTelegramWebhookSecret_({});
  assert.equal(result.status, 'success');

  const stored = gas.__properties.TELEGRAM_WEBHOOK_SECRET;
  assert.ok(stored && stored !== OLD_SECRET, 'the secret changed');
  assert.ok(!JSON.stringify(result).includes(stored), 'the new secret is never in the response');
  assert.ok(!JSON.stringify(result).includes(OLD_SECRET), 'nor is the old one');
  assert.ok(result.settings.webhookSecretConfigured);
  assert.ok(result.settings.webhookSecretRotatedAt);
});

test('the outgoing secret stops being accepted once the new one is confirmed', () => {
  const gas = bootRotation(okFetch);
  gas.rotateTelegramWebhookSecret_({});

  assert.ok(!gas.__properties.TELEGRAM_WEBHOOK_SECRET_PREVIOUS);
  assert.equal(gas.isVerifiedTelegramWebhookRequest_({ parameter: { wh: OLD_SECRET } }), false);
  assert.equal(gas.isVerifiedTelegramWebhookRequest_({ parameter: { wh: gas.__properties.TELEGRAM_WEBHOOK_SECRET } }), true);
});

test('both secrets verify during the rotation, so no update is dropped mid-flight', () => {
  // setWebhook succeeds, the confirming getWebhookInfo has not happened yet.
  const gas = bootRotation((url) => {
    if (url.includes('/getWebhookInfo')) {
      // Freeze the rotation here and check what an update would see.
      assert.equal(gas.isVerifiedTelegramWebhookRequest_({ parameter: { wh: OLD_SECRET } }), true);
      assert.equal(gas.isVerifiedTelegramWebhookRequest_({
        parameter: { wh: gas.__properties.TELEGRAM_WEBHOOK_SECRET }
      }), true);
    }
    return okFetch();
  });

  assert.equal(gas.rotateTelegramWebhookSecret_({}).status, 'success');
});

test('a rotation Telegram refuses puts the old secret back and re-points the webhook', () => {
  const calls = [];
  const gas = bootRotation((url, params) => {
    calls.push({ url, params });
    if (url.includes('/setWebhook') && calls.filter(c => c.url.includes('/setWebhook')).length === 1) {
      return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ ok: false, description: 'Bad Request' }) };
    }
    return okFetch();
  });

  const result = gas.rotateTelegramWebhookSecret_({});
  assert.equal(result.status, 'error');
  assert.equal(gas.__properties.TELEGRAM_WEBHOOK_SECRET, OLD_SECRET, 'the working secret is restored');
  assert.ok(!gas.__properties.TELEGRAM_WEBHOOK_SECRET_PREVIOUS);

  // The bot is not left deaf: Telegram is pointed back at the secret that works.
  const restore = calls.filter(c => c.url.includes('/setWebhook')).pop();
  assert.ok(String(restore.params.payload).includes(OLD_SECRET));
  assert.equal(gas.isVerifiedTelegramWebhookRequest_({ parameter: { wh: OLD_SECRET } }), true);
});

test('a rotation Telegram cannot confirm is treated as failed', () => {
  const gas = bootRotation((url) => {
    if (url.includes('/getWebhookInfo')) {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { url: '' } }) };
    }
    return okFetch();
  });

  assert.equal(gas.rotateTelegramWebhookSecret_({}).status, 'error');
  assert.equal(gas.__properties.TELEGRAM_WEBHOOK_SECRET, OLD_SECRET);
});

test('the rotated secret is redacted out of anything that gets logged', () => {
  const gas = bootRotation(okFetch);
  gas.rotateTelegramWebhookSecret_({});

  const current = gas.__properties.TELEGRAM_WEBHOOK_SECRET;
  assert.ok(!gas.redactSecrets_(`leaked ${current} here`).includes(current));

  const debug = gas.__spreadsheet.getSheetByName('Telegram_Debug_Log');
  if (debug) {
    const dump = debug.data.map(r => r.join(' ')).join('\n');
    assert.ok(!dump.includes(current), 'the debug log never receives the secret');
    assert.ok(!dump.includes(OLD_SECRET));
  }
});
