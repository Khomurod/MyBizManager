'use strict';

/**
 * Retry-queue behaviour: statuses, attempt counting, backoff, worker claiming
 * and recovery. Telegram reporting rides on this queue, so a Telegram outage
 * degrades into "the report is late", never "the money is wrong".
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const GROUP_ID = '-1001234567890';
const ADMIN_KEY = 'correct-admin-key';

function props() {
  return {
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_GROUP_CHAT_ID: GROUP_ID,
    OMAD_ADMIN_KEY: ADMIN_KEY
  };
}

function alwaysFails() {
  return () => ({ getResponseCode: () => 502, getContentText: () => 'bad gateway' });
}

function queueRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0]);
}

/** Rewinds a job's next-attempt time so it is due again immediately. */
function makeDue(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    sheet.getRange(row, 7).setValue(new Date(0).toISOString());
  }
}

function enqueueCloseDay(gas) {
  return gas.enqueueJob_(gas.__spreadsheet, 'cafe_close_day_report', '', {
    date: '2026-02-01T09:00:00.000Z',
    seller: 'Kassir',
    totalRevenue: 100,
    totalProfit: 10,
    soldItems: [{ name: 'Kofe', qty: 3 }]
  });
}

// --------------------------------------------------------------- basics

test('the queue sheet carries the documented columns', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);
  // Array.from: the sheet rows are created inside the script sandbox realm.
  const header = Array.from(gas.__spreadsheet.getSheetByName('Omad_Job_Queue').getDataRange().getValues()[0]);
  assert.deepStrictEqual(header, [
    'Job_ID', 'Related_ID', 'Type', 'Payload_JSON', 'Status',
    'Attempts', 'Next_Attempt_At', 'Last_Error', 'Created_At', 'Completed_At'
  ]);
});

test('a job runs once and is marked completed', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);

  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 1);
  const [job] = queueRows(gas);
  assert.strictEqual(job[4], gas.JOB_STATUS_COMPLETED);
  assert.strictEqual(job[5], 1);
  assert.ok(String(job[9]).length > 0, 'completion is timestamped');
  assert.strictEqual(gas.__sentMessages.length, 1);
});

test('a completed job is never run twice', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);

  gas.processPendingJobs_(gas.__spreadsheet, 10);
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 0);
  assert.strictEqual(gas.__sentMessages.length, 1);
});

// ------------------------------------------------------- failure & retry

test('a temporary failure leaves the job pending with backoff and a redacted error', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);
  gas.processPendingJobs_(gas.__spreadsheet, 10);

  const [job] = queueRows(gas);
  assert.strictEqual(job[4], gas.JOB_STATUS_PENDING);
  assert.strictEqual(job[5], 1);
  assert.ok(Date.parse(job[6]) > Date.now(), 'the retry is scheduled in the future');
  assert.ok(String(job[7]).includes('502'));
  assert.ok(!String(job[7]).includes(VALID_TOKEN));
});

test('a job that is not yet due is skipped', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);
  gas.processPendingJobs_(gas.__spreadsheet, 10);

  // Immediately after the first failure the retry is still in the future.
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 0);
  assert.strictEqual(queueRows(gas)[0][5], 1, 'the attempt count did not grow');
});

test('the retry delay grows with each attempt', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);

  const delays = [];
  for (let i = 0; i < 3; i++) {
    makeDue(gas);
    const before = Date.now();
    gas.processPendingJobs_(gas.__spreadsheet, 10);
    delays.push(Date.parse(queueRows(gas)[0][6]) - before);
  }

  assert.ok(delays[0] >= gas.JOB_RETRY_BASE_SECONDS * 1000);
  assert.ok(delays[1] > delays[0]);
  assert.ok(delays[2] > delays[1]);
});

test('a job that exhausts its attempts becomes Failed', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);

  for (let i = 0; i < gas.JOB_MAX_ATTEMPTS; i++) {
    makeDue(gas);
    gas.processPendingJobs_(gas.__spreadsheet, 10);
  }

  const [job] = queueRows(gas);
  assert.strictEqual(job[4], gas.JOB_STATUS_FAILED);
  assert.strictEqual(job[5], gas.JOB_MAX_ATTEMPTS);

  // A failed job is terminal: further worker runs leave it alone.
  makeDue(gas);
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 0);
});

test('a job recovers once the downstream service comes back', () => {
  let telegramDown = true;
  const gas = loadScript({
    properties: props(),
    fetch: () => (telegramDown
      ? { getResponseCode: () => 502, getContentText: () => 'bad gateway' }
      : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { message_id: 9 } }) })
  });

  enqueueCloseDay(gas);
  gas.processPendingJobs_(gas.__spreadsheet, 10);
  assert.strictEqual(queueRows(gas)[0][4], gas.JOB_STATUS_PENDING);

  telegramDown = false;
  makeDue(gas);
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 1);
  assert.strictEqual(queueRows(gas)[0][4], gas.JOB_STATUS_COMPLETED);
});

// ------------------------------------------------------- worker exclusion

test('a job already claimed by another worker is not picked up again', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);

  // Worker A claims the job but has not finished it yet.
  const claimed = gas.claimDueJobs_(gas.__spreadsheet, 10);
  assert.strictEqual(claimed.length, 1);

  // Worker B starts at the same moment.
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 0);
  assert.strictEqual(gas.__sentMessages.length, 0);
});

test('a job abandoned by a dead worker is recovered after the timeout', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);
  gas.claimDueJobs_(gas.__spreadsheet, 10);

  // The claiming worker never came back; rewind its claim stamp past the
  // processing timeout.
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  sheet.getRange(2, 7).setValue(new Date(Date.now() - gas.JOB_PROCESSING_TIMEOUT_MS - 1000).toISOString());

  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 1);
  assert.strictEqual(queueRows(gas)[0][4], gas.JOB_STATUS_COMPLETED);
});

test('an unknown job type fails the job instead of the request', () => {
  const gas = loadScript({ properties: props() });
  gas.enqueueJob_(gas.__spreadsheet, 'not_a_real_type', '', {});
  assert.strictEqual(gas.processPendingJobs_(gas.__spreadsheet, 10), 0);
  assert.match(String(queueRows(gas)[0][7]), /Unknown job type/);
});

// ------------------------------------------------------------- visibility

test('queue status needs the access key, and reports the backlog with it', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);
  gas.processPendingJobs_(gas.__spreadsheet, 10);

  assert.strictEqual(
    readJsonOutput(gas.doPost(postEvent({ action: 'get_job_queue_status' }))).status, 'error',
    'an anonymous caller is not told what is waiting to be sent');

  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_job_queue_status', adminKey: ADMIN_KEY })));
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(body.queue.counts.pending, 1);
  assert.strictEqual(body.queue.counts.completed, 0);
});

test('manual retry processing requires the admin key', () => {
  const gas = loadScript({ properties: props() });
  enqueueCloseDay(gas);

  const denied = readJsonOutput(gas.doPost(postEvent({ action: 'process_jobs', adminKey: 'wrong' })));
  assert.strictEqual(denied.status, 'error');
  assert.strictEqual(gas.__sentMessages.length, 0);

  const allowed = readJsonOutput(gas.doPost(postEvent({ action: 'process_jobs', adminKey: ADMIN_KEY })));
  assert.strictEqual(allowed.status, 'success');
  assert.strictEqual(allowed.processed, 1);
  assert.strictEqual(allowed.queue.counts.completed, 1);
});

test('failed jobs are surfaced in the queue status with their last error', () => {
  const gas = loadScript({ properties: props(), fetch: alwaysFails() });
  enqueueCloseDay(gas);
  for (let i = 0; i < gas.JOB_MAX_ATTEMPTS; i++) {
    makeDue(gas);
    gas.processPendingJobs_(gas.__spreadsheet, 10);
  }

  const status = gas.buildJobQueueStatus_(gas.__spreadsheet);
  assert.strictEqual(status.counts.failed, 1);
  assert.strictEqual(status.failures.length, 1);
  assert.strictEqual(status.failures[0].type, 'cafe_close_day_report');
  assert.ok(!JSON.stringify(status).includes(VALID_TOKEN));
});

// ------------------------------------------- close-day is queued, not inline

test('close_day stores the record and queues its report', () => {
  const gas = loadScript({ properties: props(), sheets: { System_Config: [] } });

  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'close_day', adminKey: ADMIN_KEY,
    date: '2026-02-01T09:00:00.000Z',
    seller: 'Kassir',
    inventory: [],
    summary: [{ inventoryId: 'i1', name: 'Kofe', sold: 3, netProfit: 1000 }],
    soldItems: [{ name: 'Kofe', qty: 3 }],
    totalRevenue: 300000,
    totalProfit: 90000
  })));

  assert.strictEqual(body.status, 'success');
  assert.ok(body.reportJobId, 'a report job is queued');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Cafe_Kun_Yakuni').getLastRow(), 2);
  assert.match(gas.__sentMessages[0].text, /Kafe Kunlik Yakun Hisoboti/);
  assert.match(gas.__sentMessages[0].text, /Kofe/);
});

test('close_day still succeeds when Telegram is unavailable', () => {
  const gas = loadScript({ properties: props(), sheets: { System_Config: [] }, fetch: alwaysFails() });

  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'close_day', adminKey: ADMIN_KEY,
    date: '2026-02-01T09:00:00.000Z',
    seller: 'Kassir',
    inventory: [],
    summary: [],
    soldItems: [{ name: 'Kofe', qty: 1 }],
    totalRevenue: 1,
    totalProfit: 1
  })));

  assert.strictEqual(body.status, 'success');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Cafe_Kun_Yakuni').getLastRow(), 2, 'the record is stored');
  assert.strictEqual(queueRows(gas)[0][4], gas.JOB_STATUS_PENDING, 'the report is retried later');
});
