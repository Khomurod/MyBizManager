'use strict';

/**
 * The photo-proof flow: one claimant, one prompt, one matching reply.
 *
 * Invariants:
 *   * pressing "done" on a photo task claims it. A second presser cannot take
 *     the task, nor overwrite who is recorded as doing it;
 *   * the completion button disappears while a proof is pending — pressing it
 *     again is not how the photo gets delivered;
 *   * a photo is proof only of the thing it replies to. Falling back to "the
 *     user's most recently updated pending proof" is how an unrelated photo
 *     silently completed the wrong task;
 *   * the prompt is a queued job, so a Telegram outage retries it. If it can
 *     never be delivered the claim is released rather than left waiting for a
 *     message nobody ever received.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const REPORTING_GROUP = '-1001111111111';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent

/**
 * Every sent message gets its own id, the way Telegram does. The harness's
 * default stub answers 555 to everything, which would make one card's prompt
 * indistinguishable from another's — exactly the confusion these tests exist
 * to rule out.
 */
function incrementingFetch() {
  let nextMessageId = 1000;
  return () => {
    const messageId = nextMessageId++;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { message_id: messageId } })
    };
  };
}

function setup(options) {
  const gas = loadScript(Object.assign({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      TELEGRAM_GROUP_CHAT_ID: REPORTING_GROUP,
      OMAD_ADMIN_KEY: 'k'
    },
    fetch: incrementingFetch()
  }, options || {}));
  return { gas, doc: gas.__spreadsheet };
}

/** A published, photo-proof occurrence with its card already posted. */
function publish(gas, doc, title) {
  const result = gas.normalizeTaskInput_({ type: 'once', title: title, photoRequired: true }, null);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, FIXED_NOW);
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);
  return Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.taskId === result.task.id)[0];
}

function press(gas, occ, from) {
  gas.doPost(postEvent({
    callback_query: {
      id: 'cb_' + occ.id, data: 't_done:' + occ.id, from: from,
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: Number(occ.msgId) || 555 }
    }
  }));
}

function photo(gas, from, messageId, fileIds, replyToMessageId, chatId) {
  const message = {
    chat: { id: Number(chatId === undefined ? TASKS_GROUP : chatId), type: 'supergroup' },
    from: from, message_id: messageId,
    photo: fileIds.map(id => ({ file_id: id }))
  };
  if (replyToMessageId) message.reply_to_message = { message_id: Number(replyToMessageId) };
  gas.doPost(postEvent({ message: message }));
}

/** Bodies of every sendMessage call, in order. */
function sends(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/sendMessage') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

function edits(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/editMessageText') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

function jobRows(gas, doc) {
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  return data.slice(1).map(row => ({
    type: row[header.indexOf('Type')],
    status: row[header.indexOf('Status')],
    attempts: Number(row[header.indexOf('Attempts')] || 0),
    payload: JSON.parse(row[header.indexOf('Payload_JSON')] || '{}')
  }));
}

/** Claim an occurrence and let its prompt go out; returns the prompt message id. */
function claim(gas, doc, occ, from) {
  press(gas, occ, from);
  gas.processPendingJobs_(doc, 25);
  return gas.findOccurrence_(doc, occ.id).meta.proofPromptMsgId;
}

// ------------------------------------------------------------- the prompt

test('pressing done on a photo task queues a ForceReply prompt', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');

  press(gas, occ, { id: 111, first_name: 'Ali' });
  assert.ok(jobRows(gas, doc).some(j => j.type === 'task_proof_prompt' && j.payload.occurrenceId === occ.id),
    'a task_proof_prompt job was queued');

  gas.processPendingJobs_(doc, 25);
  const prompt = sends(gas).find(m => m.reply_markup && m.reply_markup.force_reply);
  assert.ok(prompt, 'the prompt went out');
  assert.strictEqual(prompt.reply_markup.force_reply, true);
  assert.strictEqual(prompt.reply_markup.selective, true);
  assert.strictEqual(prompt.parse_mode, 'HTML');
  assert.strictEqual(String(prompt.reply_to_message_id), String(occ.msgId));
  assert.match(prompt.text, /tg:\/\/user\?id=111/);
});

test('a second user cannot take over a pending proof', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');
  claim(gas, doc, occ, { id: 111, first_name: 'Ali' });

  const answersBefore = gas.__fetchCalls.filter(c => c.url.indexOf('/answerCallbackQuery') !== -1).length;
  press(gas, occ, { id: 222, first_name: 'Bek' });

  const live = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(String(live.proofAwaitingUserId), '111');
  assert.strictEqual(live.completedByName, 'Ali');
  assert.strictEqual(live.status, gas.TASK_STATUS_WAITING);

  const answers = gas.__fetchCalls
    .filter(c => c.url.indexOf('/answerCallbackQuery') !== -1)
    .slice(answersBefore)
    .map(c => JSON.parse(c.params.payload));
  assert.ok(answers.length >= 1);
  assert.match(answers[answers.length - 1].text, /Ali/, 'the second presser is told who has it');
});

test('the completion button is removed while a proof is pending', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');
  claim(gas, doc, occ, { id: 111, first_name: 'Ali' });

  const all = edits(gas);
  const last = all[all.length - 1];
  assert.ok(last, 'the card was edited');
  assert.deepStrictEqual(last.reply_markup.inline_keyboard, []);
});

test('the claimant pressing again re-prompts without duplicating state', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');
  claim(gas, doc, occ, { id: 111, first_name: 'Ali' });

  press(gas, occ, { id: 111, first_name: 'Ali' });

  const waiting = Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.status === gas.TASK_STATUS_WAITING);
  assert.strictEqual(waiting.length, 1);
  assert.strictEqual(String(waiting[0].proofAwaitingUserId), '111');

  const pending = jobRows(gas, doc).filter(j => j.type === 'task_proof_prompt' && j.status === 'Pending');
  assert.ok(pending.length <= 1, 'the queue de-duplicates an identical pending prompt');
});

// -------------------------------------------------------- matching a photo

test('a photo replying to another task\'s prompt does not complete this one', () => {
  const { gas, doc } = setup();
  const a = publish(gas, doc, 'Ish A');
  const b = publish(gas, doc, 'Ish B');
  const promptA = claim(gas, doc, a, { id: 111, first_name: 'Ali' });
  claim(gas, doc, b, { id: 111, first_name: 'Ali' });

  photo(gas, { id: 111, first_name: 'Ali' }, 900, ['zz'], promptA);

  assert.strictEqual(gas.findOccurrence_(doc, a.id).status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(gas.findOccurrence_(doc, a.id).proofFileId, 'zz');
  assert.strictEqual(gas.findOccurrence_(doc, b.id).status, gas.TASK_STATUS_WAITING);
});

test('an unrelated photo with no reply completes nothing', () => {
  const { gas, doc } = setup();
  const a = publish(gas, doc, 'Ish A');
  const b = publish(gas, doc, 'Ish B');
  claim(gas, doc, a, { id: 111, first_name: 'Ali' });
  claim(gas, doc, b, { id: 111, first_name: 'Ali' });

  const before = sends(gas).length;
  photo(gas, { id: 111, first_name: 'Ali' }, 900, ['zz']);

  assert.strictEqual(gas.findOccurrence_(doc, a.id).status, gas.TASK_STATUS_WAITING);
  assert.strictEqual(gas.findOccurrence_(doc, b.id).status, gas.TASK_STATUS_WAITING);

  const hints = sends(gas).slice(before);
  assert.strictEqual(hints.length, 1, 'exactly one hint, not one per pending proof');
  assert.match(hints[0].text, /javob \(reply\)/i);
});

test('a photo replying to a prompt claimed by someone else is refused', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');
  const prompt = claim(gas, doc, occ, { id: 111, first_name: 'Ali' });

  const before = sends(gas).length;
  photo(gas, { id: 222, first_name: 'Bek' }, 901, ['zz'], prompt);

  const live = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(live.status, gas.TASK_STATUS_WAITING);
  assert.strictEqual(live.proofFileId, '');
  const notices = sends(gas).slice(before);
  assert.strictEqual(notices.length, 1);
  assert.match(notices[0].text, /Ali/);
});

test('two users each holding their own proof both complete correctly', () => {
  const { gas, doc } = setup();
  const a = publish(gas, doc, 'Ish A');
  const b = publish(gas, doc, 'Ish B');
  const promptA = claim(gas, doc, a, { id: 111, first_name: 'Ali' });
  const promptB = claim(gas, doc, b, { id: 222, first_name: 'Bek' });

  photo(gas, { id: 111, first_name: 'Ali' }, 900, ['a_small', 'a_big'], promptA);
  photo(gas, { id: 222, first_name: 'Bek' }, 901, ['b_small', 'b_big'], promptB);

  const doneA = gas.findOccurrence_(doc, a.id);
  const doneB = gas.findOccurrence_(doc, b.id);
  assert.strictEqual(doneA.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(String(doneA.completedById), '111');
  assert.strictEqual(doneA.proofFileId, 'a_big');
  assert.strictEqual(String(doneA.proofMsgId), '900');
  assert.strictEqual(doneB.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(String(doneB.completedById), '222');
  assert.strictEqual(doneB.proofFileId, 'b_big');
  assert.strictEqual(String(doneB.proofMsgId), '901');
});

test('the proof records who, which file and when', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');

  // Pin the deadline in the past so "late" is deterministic.
  const live = gas.findOccurrence_(doc, occ.id);
  live.dueAt = Date.now() - 3600000;
  gas.writeOccurrenceRow_(doc, live);

  const prompt = claim(gas, doc, occ, { id: 111, first_name: 'Ali', last_name: 'Valiyev' });
  photo(gas, { id: 111, first_name: 'Ali', last_name: 'Valiyev' }, 900, ['small', 'big'], prompt);

  const done = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(String(done.completedById), '111');
  assert.strictEqual(done.completedByName, 'Ali Valiyev');
  assert.strictEqual(done.proofFileId, 'big', 'the largest photo is the proof');
  assert.strictEqual(String(done.proofMsgId), '900');
  assert.ok(done.completedAt);
  assert.strictEqual(done.onTime, false);
  assert.ok(Number(done.lateMs) > 0);
});

// ------------------------------------------------------ never stuck waiting

test('a failing prompt send is retried, not swallowed', () => {
  const { gas, doc } = setup({
    fetch: (url) => ({
      getResponseCode: () => (url.indexOf('/sendMessage') !== -1 ? 500 : 200),
      getContentText: () => JSON.stringify({ ok: url.indexOf('/sendMessage') === -1, result: { message_id: 555 } })
    })
  });

  // The card cannot be posted either, so build the occurrence directly.
  const result = gas.normalizeTaskInput_({ type: 'once', title: 'Ish A', photoRequired: true }, null);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, FIXED_NOW);
  const occ = gas.readOccurrenceRows_(doc)[0];

  press(gas, occ, { id: 111, first_name: 'Ali' });
  gas.processPendingJobs_(doc, 25);

  const prompt = jobRows(gas, doc).find(j => j.type === 'task_proof_prompt');
  assert.strictEqual(prompt.status, 'Pending', 'it will be tried again');
  assert.strictEqual(prompt.attempts, 1);
  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_WAITING);
});

test('a permanently failed prompt releases the task', () => {
  const { gas, doc } = setup({
    fetch: (url) => ({
      getResponseCode: () => (url.indexOf('/sendMessage') !== -1 ? 500 : 200),
      getContentText: () => JSON.stringify({ ok: url.indexOf('/sendMessage') === -1, result: { message_id: 555 } })
    })
  });

  const result = gas.normalizeTaskInput_({ type: 'once', title: 'Ish A', photoRequired: true }, null);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, FIXED_NOW);
  const occ = gas.readOccurrenceRows_(doc)[0];
  occ.msgId = '555';
  gas.writeOccurrenceRow_(doc, occ);

  press(gas, occ, { id: 111, first_name: 'Ali' });

  // Drive the prompt job to its attempt limit. Each pass re-dates the job into
  // the future, so wind Next_Attempt_At back before every retry.
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  const data = sheet.getDataRange().getValues();
  const nextAttemptCol = data[0].indexOf('Next_Attempt_At') + 1;
  for (let attempt = 0; attempt < gas.JOB_MAX_ATTEMPTS + 1; attempt++) {
    const rows = sheet.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++) {
      sheet.getRange(r + 1, nextAttemptCol, 1, 1).setValue(new Date(Date.now() - 60000).toISOString());
    }
    gas.processPendingJobs_(doc, 25);
  }

  const prompt = jobRows(gas, doc).find(j => j.type === 'task_proof_prompt');
  assert.strictEqual(prompt.status, 'Failed');

  const released = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(released.status, gas.TASK_STATUS_OPEN, 'the claim was released');
  assert.strictEqual(released.proofAwaitingUserId, '');
  assert.ok(jobRows(gas, doc).some(j => j.type === 'task_update_message' && j.payload.occurrenceId === occ.id),
    'the card is queued for a refresh so the button comes back');
});

test('the scheduler releases a claim whose prompt never went out', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');

  const live = gas.findOccurrence_(doc, occ.id);
  live.status = gas.TASK_STATUS_WAITING;
  live.proofAwaitingUserId = '111';
  live.completedByName = 'Ali';
  live.meta = { proofPromptMsgId: '', proofRequestedAt: new Date(FIXED_NOW - 31 * 60000).toISOString() };
  gas.writeOccurrenceRow_(doc, live);

  gas.runTaskScheduler_(doc, FIXED_NOW);

  const after = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(after.status, gas.TASK_STATUS_OPEN);
  assert.strictEqual(after.proofAwaitingUserId, '');
  assert.strictEqual(after.completedByName, '');
});

// ---------------------------------------------------------------- isolation

test('a photo in the reporting group does not touch tasks', () => {
  const { gas, doc } = setup();
  const occ = publish(gas, doc, 'Ish A');
  claim(gas, doc, occ, { id: 111, first_name: 'Ali' });

  const update = {
    message: {
      chat: { id: Number(REPORTING_GROUP), type: 'supergroup' },
      from: { id: 111, first_name: 'Ali' }, message_id: 950,
      photo: [{ file_id: 'zz' }]
    }
  };
  assert.strictEqual(gas.isTaskTelegramUpdate_(update), false,
    'the task namespace only ever claims the Tasks group');

  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_WAITING);
});
