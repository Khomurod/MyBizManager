'use strict';

/**
 * What happens to an occurrence while a Telegram send is in flight.
 *
 * A queued send is not instantaneous: it reads the occurrence, does a network
 * round trip, and then persists what it learned. Three defects lived in that
 * window, and all three are about the difference between "write what I decided"
 * and "write what I own".
 *
 *   1. **Stale write.** The job wrote its *pre-send* snapshot back over the row,
 *      all 27 columns. A completion, cancellation, skip or edit landing in the
 *      window was erased — status, who did it, when, on-time, the proof file and
 *      the reminder markers with it. The pre-send status checks do not cover
 *      this: they run *before* the send.
 *   2. **Duplicate reminder.** If Telegram accepted the reminder and the row
 *      write then threw, the exception reached the queue, the job was requeued,
 *      and the next tick sent the same reminder again. The only dedup marker
 *      (`Reminders_Sent_JSON`) is written at *enqueue* time and deduplicates
 *      enqueues, not sends — `runTaskReminderJob_` never read `payload.slot`.
 *   3. **Stale queued announcement.** "An occurrence with reminder times gets no
 *      Yangi vazifa card" was decided only at enqueue time. Adding reminders
 *      before the queued job ran still posted the card, and because that set the
 *      message id, the first reminder became an orphan second card that no
 *      completion would ever edit in place.
 *
 * The harness gives us one honest interleave point: `UrlFetchApp.fetch` is
 * called *during* the send, so a fetch stub is exactly "while the message is in
 * flight". These tests mutate the occurrence from inside it. That is not a
 * simulation of the race — it is the race, in the one order that matters.
 *
 * Every assertion reads the persisted row. "A message was sent" is not the
 * question; "what does the sheet say afterwards" is.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent

/**
 * A backend whose Telegram endpoint runs `duringSend` before answering.
 *
 * `duringSend(url, gas)` is called for every send, with the sandbox, so a test
 * can complete or cancel the occurrence at precisely the moment the card is on
 * the wire. Message ids increment so one card is never mistaken for another.
 */
function setup(duringSend) {
  let nextMessageId = 1000;
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: 'k'
    },
    fetch: (url) => {
      if (duringSend) duringSend(url, gas);
      const messageId = nextMessageId++;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: messageId } })
      };
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

/** A saved task and its materialised occurrence, with nothing sent yet. */
function makeTask(gas, doc, input) {
  const built = gas.normalizeTaskInput_(input, null);
  gas.appendTaskRow_(doc, built.task);
  gas.materializeTaskOccurrences_(doc, built.task, FIXED_NOW);
  const occ = gas.readOccurrenceRows_(doc).filter(o => o.taskId === built.task.id)[0];
  return { task: built.task, occ: occ };
}

function sends(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/sendMessage') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

function jobRows(gas, doc) {
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  return data.slice(1).map((row, i) => ({
    rowNumber: i + 2,
    type: row[header.indexOf('Type')],
    status: row[header.indexOf('Status')],
    attempts: Number(row[header.indexOf('Attempts')] || 0),
    payload: JSON.parse(row[header.indexOf('Payload_JSON')] || '{}')
  }));
}

// ------------------------------------------------------- 1. the stale write

test('completing while the new-task card is in flight is not undone', () => {
  let completedDuringSend = false;
  const { gas, doc } = setup((url, sandbox) => {
    if (completedDuringSend || url.indexOf('/sendMessage') === -1) return;
    completedDuringSend = true;
    // Somebody presses the button in the group while the card is on the wire.
    const live = sandbox.findOccurrence_(doc, made.occ.id);
    sandbox.completeTaskOccurrence_(doc, live, {
      byId: '777', byName: 'Dilnoza', source: 'telegram', nowMs: FIXED_NOW
    });
  });

  const made = makeTask(gas, doc, { type: 'once', title: 'Yetkazib berish' });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  assert.ok(completedDuringSend, 'the interleave actually happened');
  const after = gas.findOccurrence_(doc, made.occ.id);
  assert.strictEqual(after.status, 'Completed', 'the completion survived the send');
  assert.strictEqual(String(after.completedById), '777', 'and so did who did it');
  assert.strictEqual(after.completedByName, 'Dilnoza');
  assert.ok(after.msgId, 'while the card id the send owns was still stored');
});

test('cancelling while a reminder is in flight is not undone', () => {
  let cancelledDuringSend = false;
  const { gas, doc } = setup((url, sandbox) => {
    if (cancelledDuringSend || url.indexOf('/sendMessage') === -1) return;
    cancelledDuringSend = true;
    const live = sandbox.findOccurrence_(doc, made.occ.id);
    live.status = 'Cancelled';
    sandbox.writeOccurrenceRow_(doc, live);
  });

  const made = makeTask(gas, doc, {
    type: 'once', title: 'Hisobot', reminderTimes: ['09:00'], remindDaily: true
  });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  assert.ok(cancelledDuringSend, 'the interleave actually happened');
  const after = gas.findOccurrence_(doc, made.occ.id);
  assert.strictEqual(after.status, 'Cancelled', 'the cancellation survived the reminder');
});

test('a proof photo arriving while the prompt is in flight still counts', () => {
  let proofDuringSend = false;
  const { gas, doc } = setup((url, sandbox) => {
    if (proofDuringSend || url.indexOf('/sendMessage') === -1) return;
    if (gas.__fetchCalls.length < 2) return;      // let the card itself go first
    proofDuringSend = true;
    // The claimant replies with the photo before the prompt is even persisted.
    const live = sandbox.findOccurrence_(doc, made.occ.id);
    sandbox.completeTaskOccurrence_(doc, live, {
      byId: '111', byName: 'Ali', source: 'telegram',
      proofFileId: 'AgACphoto', proofMsgId: 4242, nowMs: FIXED_NOW
    });
  });

  const made = makeTask(gas, doc, { type: 'once', title: 'Rasmli ish', photoRequired: true });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  // Claim it, which queues the ForceReply prompt.
  gas.doPost(postEvent({
    callback_query: {
      id: 'cb1', data: 't_done:' + made.occ.id, from: { id: 111, first_name: 'Ali' },
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: 555 }
    }
  }));
  gas.processPendingJobs_(doc, 25);

  assert.ok(proofDuringSend, 'the interleave actually happened');
  const after = gas.findOccurrence_(doc, made.occ.id);
  assert.strictEqual(after.status, 'Completed', 'the proof was not rolled back to WaitingProof');
  assert.strictEqual(after.proofFileId, 'AgACphoto', 'and the photo is still the proof');
});

// -------------------------------------------------- 2. the duplicate reminder

test('a reminder Telegram accepted is not sent twice when the row write fails', () => {
  const { gas, doc } = setup();
  const made = makeTask(gas, doc, {
    type: 'once', title: 'Hisobot', reminderTimes: ['09:00'], remindDaily: true
  });

  gas.runTaskScheduler_(doc, FIXED_NOW);
  assert.ok(jobRows(gas, doc).some(j => j.type === 'task_reminder'), 'a reminder is queued');

  // The send succeeds and the persistence then fails, exactly once. This is the
  // shape of a Sheets write timing out after Telegram has already delivered.
  const realUpdate = gas.updateOccurrenceFields_;
  let thrown = 0;
  gas.updateOccurrenceFields_ = function (d, id, options) {
    if (thrown === 0) { thrown++; throw new Error('sheet write failed'); }
    return realUpdate(d, id, options);
  };
  gas.processPendingJobs_(doc, 25);
  gas.updateOccurrenceFields_ = realUpdate;

  const reminderSends = sends(gas).filter(m => /Eslatma/.test(m.text));
  assert.strictEqual(reminderSends.length, 1, 'the reminder went out once');

  const failed = jobRows(gas, doc).find(j => j.type === 'task_reminder');
  assert.strictEqual(failed.status, 'Pending', 'and the job is queued to finish its bookkeeping');
  assert.ok(failed.payload.deliveredMsgId, 'having recorded that the message was delivered');

  // The retry must finish the job without sending a second copy.
  const dueRow = jobRows(gas, doc).find(j => j.type === 'task_reminder');
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  sheet.getRange(dueRow.rowNumber, 7).setValue(new Date(Date.now() - 1000).toISOString());
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(sends(gas).filter(m => /Eslatma/.test(m.text)).length, 1,
    'the retry sent nothing a second time');
  const after = gas.findOccurrence_(doc, made.occ.id);
  assert.ok(after.msgId, 'and the message id it owed the occurrence is now stored');
  assert.strictEqual(jobRows(gas, doc).find(j => j.type === 'task_reminder').status, 'Completed');
});

test('a new-task card Telegram accepted is not posted twice on retry', () => {
  const { gas, doc } = setup();
  const made = makeTask(gas, doc, { type: 'once', title: 'Yetkazib berish' });
  gas.runTaskScheduler_(doc, FIXED_NOW);

  const realUpdate = gas.updateOccurrenceFields_;
  let thrown = 0;
  gas.updateOccurrenceFields_ = function (d, id, options) {
    if (thrown === 0) { thrown++; throw new Error('sheet write failed'); }
    return realUpdate(d, id, options);
  };
  gas.processPendingJobs_(doc, 25);
  gas.updateOccurrenceFields_ = realUpdate;

  const cards = () => sends(gas).filter(m => /Yangi vazifa/.test(m.text));
  assert.strictEqual(cards().length, 1);

  const row = jobRows(gas, doc).find(j => j.type === 'task_notify');
  doc.getSheetByName('Omad_Job_Queue')
    .getRange(row.rowNumber, 7).setValue(new Date(Date.now() - 1000).toISOString());
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(cards().length, 1, 'the card was not posted a second time');
  assert.ok(gas.findOccurrence_(doc, made.occ.id).msgId, 'and its id was recovered');
});

// ------------------------------------------ 3. the stale queued announcement

test('adding reminders before the queued card goes out cancels the card', () => {
  const { gas, doc } = setup();
  // No reminder times, so the scheduler queues the ordinary announcement.
  const made = makeTask(gas, doc, { type: 'once', title: 'Yetkazib berish' });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  assert.ok(jobRows(gas, doc).some(j => j.type === 'task_notify'), 'a notify is queued');

  // The admin adds reminder times before the queue drains. Reminder times are
  // the notification schedule, so the first reminder is now meant to be the
  // occurrence's first card -- and this queued one is obsolete.
  const answer = gas.saveTaskAction_(doc, {
    id: made.task.id, type: 'once', title: 'Yetkazib berish',
    reminderTimes: ['18:00'], remindDaily: true
  });
  assert.strictEqual(answer.status, 'success');

  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(sends(gas).filter(m => /Yangi vazifa/.test(m.text)).length, 0,
    'no obsolete Yangi vazifa card was posted');
  assert.strictEqual(gas.findOccurrence_(doc, made.occ.id).msgId, '',
    'so the first reminder is still free to become the card');
});

test('an occurrence that never gained reminders still gets its card', () => {
  const { gas, doc } = setup();
  const made = makeTask(gas, doc, { type: 'once', title: 'Yetkazib berish' });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  assert.strictEqual(sends(gas).filter(m => /Yangi vazifa/.test(m.text)).length, 1);
  assert.ok(gas.findOccurrence_(doc, made.occ.id).msgId);
});

test('a card that can never be delivered is announced again, exactly once', () => {
  // Telegram refuses permanently. The queue gives up after JOB_MAX_ATTEMPTS and
  // `Notified_At` used to stay stamped, so the scheduler's `!occ.notifiedAt`
  // check suppressed the announcement for ever and the card was lost silently.
  //
  // `__fetchCalls` records an attempt whether or not it succeeded, so the failed
  // attempts have to be counted out here: what matters is how many cards the
  // group actually received.
  let allow = false;
  const delivered = [];
  const { gas, doc } = setup((url) => {
    if (url.indexOf('/sendMessage') === -1) return;
    if (!allow) throw new Error('telegram down');
    delivered.push(url);
  });
  const made = makeTask(gas, doc, { type: 'once', title: 'Yetkazib berish' });
  gas.runTaskScheduler_(doc, FIXED_NOW);

  const sheet = doc.getSheetByName('Omad_Job_Queue');
  for (let attempt = 0; attempt < gas.JOB_MAX_ATTEMPTS; attempt++) {
    const row = jobRows(gas, doc).find(j => j.type === 'task_notify');
    if (!row || row.status === 'Failed') break;
    sheet.getRange(row.rowNumber, 7).setValue(new Date(Date.now() - 1000).toISOString());
    gas.processPendingJobs_(doc, 25);
  }
  assert.strictEqual(jobRows(gas, doc).find(j => j.type === 'task_notify').status, 'Failed');

  const released = gas.findOccurrence_(doc, made.occ.id);
  assert.strictEqual(released.notifiedAt, '', 'the announcement is owed again');
  assert.ok(released.meta.notifyFailedAt, 'and marked so it can only be owed once');

  // Telegram recovers: one more announcement, and then no more for ever.
  allow = true;
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);
  assert.strictEqual(delivered.length, 1, 'the card was announced once on recovery');
  assert.ok(gas.findOccurrence_(doc, made.occ.id).msgId, 'and the group card is now known');

  gas.runTaskScheduler_(doc, FIXED_NOW + 60000);
  gas.processPendingJobs_(doc, 25);
  assert.strictEqual(delivered.length, 1, 'and a later pass does not announce it a third time');
});
