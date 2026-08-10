'use strict';

/**
 * Task Telegram callbacks and photo-proof completion.
 *
 * Invariants:
 *   * pressing "Ish bajarildi" with no proof completes immediately and records
 *     who / when / on-time-or-late;
 *   * with proof required it waits for a photo and only then completes;
 *   * the group card is updated in place rather than duplicated;
 *   * a second press is a no-op;
 *   * a press from outside the configured Tasks group is ignored.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent
const TODAY = '2026-08-10';

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      TELEGRAM_GROUP_CHAT_ID: '-1001111111111',
      OMAD_ADMIN_KEY: 'k'
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

function makeTask(gas, payload) {
  const result = gas.normalizeTaskInput_(payload, null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);
  return result.task;
}

/** Materialise, then run the scheduler + queue so the card is posted (msgId set). */
function publishToday(gas, doc, task) {
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);
  return gas.readOccurrenceRows_(doc).find(o => o.taskId === task.id && o.dateKey === TODAY);
}

function doneCallback(occurrenceId, from, messageId) {
  return {
    callback_query: {
      id: 'cb_' + occurrenceId,
      data: 't_done:' + occurrenceId,
      from: from,
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: messageId || 555 }
    }
  };
}

// ----------------------------------------------------- immediate completion

test('a no-proof task completes on the button press and records who and lateness', () => {
  const { gas, doc } = setup();
  const task = makeTask(gas, {
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' }, dueTime: '08:00'
  });
  const occ = publishToday(gas, doc, task);
  assert.ok(occ.msgId, 'the card was posted');

  // The callback records the *real* completion instant, so pin the deadline to
  // a known point in the past to make "late" deterministic regardless of the
  // wall clock when the suite runs.
  const live = gas.findOccurrence_(doc, occ.id);
  live.dueAt = Date.now() - 3600000; // one hour ago
  gas.writeOccurrenceRow_(doc, live);

  gas.doPost(postEvent(doneCallback(occ.id, { id: 4242, first_name: 'Ali' }, occ.msgId)));

  const done = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(done.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(done.completedByName, 'Ali');
  assert.strictEqual(String(done.completedById), '4242');
  assert.strictEqual(done.onTime, false, 'completed after its deadline');
  assert.ok(Number(done.lateMs) > 0);

  // The card was edited in place, not re-posted.
  const edits = gas.__fetchCalls.filter(c => c.url.indexOf('/editMessageText') !== -1);
  assert.ok(edits.length >= 1, 'the group card is updated in place');
});

test('a second press after completion changes nothing', () => {
  const { gas, doc } = setup();
  const task = makeTask(gas, { type: 'once', title: 'Bir martalik' });
  const occId = publishToday(gas, doc, task) || gas.readOccurrenceRows_(doc)[0];
  // A once-task without a deadline has an empty dateKey; fetch it directly.
  const only = gas.readOccurrenceRows_(doc)[0];

  gas.doPost(postEvent(doneCallback(only.id, { id: 1, first_name: 'A' }, only.msgId)));
  const firstCompletedAt = gas.findOccurrence_(doc, only.id).completedAt;

  gas.doPost(postEvent(doneCallback(only.id, { id: 2, first_name: 'B' }, only.msgId)));
  const after = gas.findOccurrence_(doc, only.id);
  assert.strictEqual(after.completedByName, 'A', 'the first completer stands');
  assert.strictEqual(after.completedAt, firstCompletedAt);
});

// --------------------------------------------------------- photo proof flow

test('a proof-required task waits for a photo, then completes with the file id', () => {
  const { gas, doc } = setup();
  const task = makeTask(gas, {
    type: 'routine', title: 'Tozalash', startKey: TODAY, recurrence: { freq: 'daily' },
    dueTime: '20:00', photoRequired: true
  });
  const occ = publishToday(gas, doc, task);

  // Press the button -> Waiting for Proof, not yet complete.
  gas.doPost(postEvent(doneCallback(occ.id, { id: 7777, first_name: 'Vali' }, occ.msgId)));
  let live = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(live.status, gas.TASK_STATUS_WAITING);
  assert.strictEqual(String(live.proofAwaitingUserId), '7777');

  // The prompt is a queued job now, so drain before looking for it.
  gas.processPendingJobs_(doc, 25);
  const prompts = gas.__sentMessages.filter(m => String(m.chat_id) === TASKS_GROUP && /rasm/i.test(m.text));
  assert.ok(prompts.length >= 1, 'the user is asked for a photo');

  const promptMsgId = gas.findOccurrence_(doc, occ.id).meta.proofPromptMsgId;
  assert.ok(promptMsgId, 'the prompt message id was recorded');

  // Send a photo *as a reply to that prompt* -> completed with the largest
  // photo file id. A photo that answers nothing no longer completes anything.
  gas.doPost(postEvent({
    message: {
      chat: { id: Number(TASKS_GROUP), type: 'supergroup' },
      from: { id: 7777, first_name: 'Vali' },
      message_id: 900,
      reply_to_message: { message_id: Number(promptMsgId) },
      photo: [{ file_id: 'small_1' }, { file_id: 'big_2' }]
    }
  }));

  live = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(live.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(live.proofFileId, 'big_2');
  assert.strictEqual(String(live.proofMsgId), '900');
  assert.strictEqual(live.completedByName, 'Vali');
});

test('a photo from someone with nothing awaiting proof is ignored', () => {
  const { gas, doc } = setup();
  const task = makeTask(gas, {
    type: 'routine', title: 'X', startKey: TODAY, recurrence: { freq: 'daily' }, photoRequired: true
  });
  const occ = publishToday(gas, doc, task);
  const before = gas.__sentMessages.length;

  gas.doPost(postEvent({
    message: {
      chat: { id: Number(TASKS_GROUP), type: 'supergroup' },
      from: { id: 9999, first_name: 'Stranger' },
      message_id: 901, photo: [{ file_id: 'x' }]
    }
  }));

  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_OPEN);
  assert.strictEqual(gas.__sentMessages.length, before, 'no acknowledgement is sent');
});

// ------------------------------------------------------------- isolation

test('a done callback from a different chat is refused and completes nothing', () => {
  const { gas, doc } = setup();
  const task = makeTask(gas, { type: 'once', title: 'Guarded' });
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  const occ = gas.readOccurrenceRows_(doc)[0];

  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 't_done:' + occ.id, from: { id: 5, first_name: 'Z' },
      message: { chat: { id: -1002222222222, type: 'supergroup' }, message_id: 5 }
    }
  }));

  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_OPEN);
});

test('a done callback for an unknown occurrence is handled gracefully', () => {
  const { gas } = setup();
  const body = gas.doPost(postEvent(doneCallback('occ_does_not_exist', { id: 1, first_name: 'A' }, 1)));
  assert.ok(body); // no throw, returns the OK html output
});
