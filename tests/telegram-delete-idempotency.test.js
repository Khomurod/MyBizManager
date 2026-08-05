'use strict';

/**
 * Deleting a group report says what the end state should be, not who gets
 * there first.
 *
 * A deletion was requested twice on the live system. The first succeeded; the
 * second retried five times against "message to delete not found" and became a
 * permanently failed queue entry, even though the world was already in the
 * requested state.
 *
 * So: an already-gone message is success, a genuine outage is still retried,
 * and an identical instruction does not create a second job.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const GROUP_ID = '-1001234567890';
const MESSAGE_ID = '457';

function boot(fetchImpl) {
  return loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_GROUP_CHAT_ID: GROUP_ID
    },
    sheets: {},
    fetch: fetchImpl
  });
}

const deleted = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: true }) });

const alreadyGone = () => ({
  getResponseCode: () => 400,
  getContentText: () => JSON.stringify({
    ok: false, error_code: 400, description: 'Bad Request: message to delete not found'
  })
});

const outage = () => ({
  getResponseCode: () => 502,
  getContentText: () => JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' })
});

const forbidden = () => ({
  getResponseCode: () => 403,
  getContentText: () => JSON.stringify({
    ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat'
  })
});

const deleteJob = () => ({ payload: { messageId: MESSAGE_ID } });

function jobRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

// ------------------------------------------------------------- the job

test('deleting an existing report succeeds', () => {
  const gas = boot(deleted);
  assert.doesNotThrow(() => gas.runOmadDeleteReportJob_(deleteJob()));
});

test('deleting a report that is already gone also succeeds', () => {
  const gas = boot(alreadyGone);
  assert.doesNotThrow(() => gas.runOmadDeleteReportJob_(deleteJob()),
    'the requested end state is already true, so there is nothing to retry');
});

test('repeating the deletion is harmless', () => {
  let calls = 0;
  const gas = boot(() => { calls += 1; return calls === 1 ? deleted() : alreadyGone(); });

  gas.runOmadDeleteReportJob_(deleteJob());
  assert.doesNotThrow(() => gas.runOmadDeleteReportJob_(deleteJob()), 'the second request is fine');
  assert.strictEqual(calls, 2);
});

test('a temporary Telegram failure still throws, so the queue retries it', () => {
  const gas = boot(outage);
  assert.throws(() => gas.runOmadDeleteReportJob_(deleteJob()), /502/);
});

test('an unrelated permanent failure still throws', () => {
  const gas = boot(forbidden);
  assert.throws(() => gas.runOmadDeleteReportJob_(deleteJob()), /kicked|403/);
});

test('a job with no message id does nothing at all', () => {
  let calls = 0;
  const gas = boot(() => { calls += 1; return deleted(); });
  gas.runOmadDeleteReportJob_({ payload: {} });
  assert.strictEqual(calls, 0, 'nothing is sent to Telegram');
});

// ------------------------------------------------------------- the queue

test('an already-gone message leaves no failed job behind', () => {
  const gas = boot(alreadyGone);
  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });

  gas.processPendingTelegramJobs();

  const rows = jobRows(gas);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][4], gas.JOB_STATUS_COMPLETED,
    'the job completes rather than failing five times');
});

test('the same deletion asked for twice creates one job, not two', () => {
  const gas = boot(deleted);
  const first = gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });
  const second = gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });

  assert.strictEqual(second, first, 'the repeat resolves to the job already queued');
  assert.strictEqual(jobRows(gas).length, 1);
});

test('different deletions are still queued separately', () => {
  const gas = boot(deleted);
  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: '1' });
  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx2', { messageId: '2' });
  assert.strictEqual(jobRows(gas).length, 2);
});

test('a repeat after the first has finished is queued again', () => {
  const gas = boot(deleted);
  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });
  gas.processPendingTelegramJobs();

  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });
  assert.strictEqual(jobRows(gas).length, 2,
    'dedup only protects work that is still waiting, not history');
});

test('a temporary failure is retried and then succeeds', () => {
  let calls = 0;
  const gas = boot(() => { calls += 1; return calls === 1 ? outage() : deleted(); });

  gas.enqueueJob_(gas.__spreadsheet, 'omad_transaction_delete_report', 'tx1', { messageId: MESSAGE_ID });
  gas.processPendingTelegramJobs();
  assert.strictEqual(jobRows(gas)[0][4], gas.JOB_STATUS_PENDING, 'still queued after the outage');

  // The trigger comes round again once the back-off has elapsed
  // (column 7 is Next_Attempt_At).
  gas.__spreadsheet.getSheetByName('Omad_Job_Queue').getRange(2, 7).setValue(new Date(0).toISOString());
  gas.processPendingTelegramJobs();
  assert.strictEqual(jobRows(gas)[0][4], gas.JOB_STATUS_COMPLETED);
});
