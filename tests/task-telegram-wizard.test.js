'use strict';

/**
 * The `📋 Vazifa` branch of the private /yangi conversation.
 *
 * Invariant: the private flow may CREATE tasks, through the same four
 * authorization gates that protect the accounting flow, and it never touches
 * money. Tasks still never read or write financial data.
 *
 * Two harness facts shape everything below:
 *
 *   * __sentMessages records only /sendMessage. The wizard edits its card in
 *     place on every button press, so those go to /editMessageText and are
 *     visible only in __fetchCalls — hence `cards()`.
 *   * LockService is a no-op here, so real serialisation is NOT under test.
 *     The idempotency tests drive the deliveries sequentially and prove the
 *     guard logic, not the locking.
 *
 * TELEGRAM_WEBHOOK_SECRET is deliberately unset: with it,
 * isVerifiedTelegramWebhookRequest_ calls enforceRateLimit_, which writes an
 * rl_tg_webhook_* cache key and makes the exhaustive __cache assertions
 * unusable.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = 111222333;
const INTRUDER_ID = 999000111;
const TASKS_GROUP = '-1009998887777';
const REPORT_GROUP = '-1001111111111';

function props(extra) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: String(AUTHORIZED_ID),
    TELEGRAM_GROUP_CHAT_ID: REPORT_GROUP,
    TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
    OMAD_ADMIN_KEY: 'test-admin-key'
  }, extra || {});
}

function boot(options) {
  return loadScript(Object.assign({ properties: props() }, options || {}));
}

// The code under test calls Date.now() (materialisation, pruning), so anything
// date-relative has to be derived from the same clock rather than hardcoded.
function todayKey(gas) { return gas.taskTodayKey_(Date.now()); }
function tomorrowKey(gas) { return gas.taskDateKeyAddDays_(todayKey(gas), 1); }

// ------------------------------------------------------------------ driving

function tap(gas, data, fromId) {
  return gas.doPost(postEvent({
    callback_query: {
      id: 'cb',
      data: data,
      from: { id: fromId === undefined ? AUTHORIZED_ID : fromId },
      message: { chat: { id: AUTHORIZED_ID, type: 'private' }, message_id: 42 }
    }
  }));
}

function say(gas, text, fromId) {
  return gas.doPost(postEvent({
    message: {
      chat: { id: AUTHORIZED_ID, type: 'private' },
      from: { id: fromId === undefined ? AUTHORIZED_ID : fromId },
      message_id: 43,
      text: text
    }
  }));
}

/**
 * Every message the bot put on screen, sent or edited, in order.
 *
 * Note: the harness records each fetch into __fetchCalls twice (the wrapper
 * and the default responder both push), so this list contains consecutive
 * duplicates. Every assertion below is order- or content-based, never a count.
 */
function cards(gas) {
  return gas.__fetchCalls
    .filter(c => /\/(sendMessage|editMessageText)$/.test(c.url))
    .map(c => JSON.parse(c.params.payload));
}

function lastCard(gas) {
  const all = cards(gas);
  return all[all.length - 1];
}

function cardTexts(gas) {
  return cards(gas).map(c => String(c.text || ''));
}

function buttonData(card) {
  const rows = (card && card.reply_markup && card.reply_markup.inline_keyboard) || [];
  return rows.reduce((acc, row) => acc.concat(row.map(b => b.callback_data)), []);
}

// ------------------------------------------------------------------ reading

function tasks(gas) {
  return gas.readTaskRows_(gas.__spreadsheet);
}

function occurrences(gas) {
  return gas.readOccurrenceRows_(gas.__spreadsheet);
}

function jobsOfType(gas, type) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0] && r[2] === type);
}

function sessionKey() { return 'yangi_' + AUTHORIZED_ID; }

// ------------------------------------------------------------- walk helpers

/** The common head, up to and including the photo answer. */
function walkHead(gas, type, title) {
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:' + type);
  say(gas, title);
  tap(gas, 'bot_vz_skip:desc');
  tap(gas, 'bot_vz_skip:resp');
  tap(gas, 'bot_vz_pri:high');
  tap(gas, 'bot_vz_photo:1');
}

// ============================================================ happy paths

test('a one-time task is created end to end, announced, and leaves no session', () => {
  const gas = boot();
  const today = todayKey(gas);

  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Kassa hisobotini yopish');
  say(gas, 'Naqd, terminal va Click alohida');
  tap(gas, 'bot_vz_skip:resp');
  tap(gas, 'bot_vz_pri:high');
  tap(gas, 'bot_vz_photo:1');
  tap(gas, 'bot_vz_date:today');
  tap(gas, 'bot_vz_time:20:00');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const all = tasks(gas);
  assert.strictEqual(all.length, 1, 'exactly one task');
  const task = all[0];
  assert.strictEqual(task.type, 'once');
  assert.strictEqual(task.title, 'Kassa hisobotini yopish');
  assert.strictEqual(task.description, 'Naqd, terminal va Click alohida');
  assert.strictEqual(task.responsible, '');
  assert.strictEqual(task.priority, 'high');
  assert.strictEqual(task.photoRequired, true);
  assert.strictEqual(task.deadlineKey, today);
  assert.strictEqual(task.deadlineTime, '20:00');
  assert.strictEqual(task.createdBy, 'telegram:' + AUTHORIZED_ID);
  assert.strictEqual(task.status, 'active');

  const occs = occurrences(gas);
  assert.strictEqual(occs.length, 1, 'the occurrence was materialised');
  assert.strictEqual(occs[0].dateKey, today);

  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 1, 'one notify job');
  assert.ok(gas.__sentMessages.some(m => String(m.chat_id) === TASKS_GROUP),
    'the card reached the Tasks group');

  assert.ok(lastCard(gas).text.includes('yaratildi'), 'the user was told it was created');
  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'no session left behind');
});

test('a weekly routine keeps its cadence, start date and due time', () => {
  const gas = boot();
  const today = todayKey(gas);

  walkHead(gas, 'routine', 'Kassa hisoboti');
  tap(gas, 'bot_vz_freq:weekly');
  tap(gas, 'bot_vz_wd:1');
  tap(gas, 'bot_vz_wd:3');
  tap(gas, 'bot_vz_wd_done');
  tap(gas, 'bot_vz_start:today');
  tap(gas, 'bot_vz_skip:end');
  tap(gas, 'bot_vz_due:09:00');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const all = tasks(gas);
  assert.strictEqual(all.length, 1);
  const task = all[0];
  assert.strictEqual(task.type, 'routine');
  assert.strictEqual(task.recurrence.freq, 'weekly');
  assert.deepStrictEqual(Array.from(task.recurrence.weekdays), [1, 3]);
  assert.strictEqual(task.startKey, today);
  assert.strictEqual(task.endKey, '');
  assert.strictEqual(task.dueTime, '09:00');
  assert.strictEqual(task.createdBy, 'telegram:' + AUTHORIZED_ID);
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('a goal keeps its steps in order and materialises one occurrence each', () => {
  const gas = boot();

  walkHead(gas, 'goal', 'Yangi filial ochish');
  say(gas, 'Joy topish');
  say(gas, 'Shartnoma imzolash');
  say(gas, 'Jihoz olib kelish');
  tap(gas, 'bot_vz_step_done');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const all = tasks(gas);
  assert.strictEqual(all.length, 1);
  const task = all[0];
  assert.strictEqual(task.type, 'goal');
  assert.deepStrictEqual(Array.from(task.steps).map(s => s.title),
    ['Joy topish', 'Shartnoma imzolash', 'Jihoz olib kelish']);
  assert.ok(Array.from(task.steps).every(s => s.id), 'every step got a stable id');

  const occs = occurrences(gas);
  assert.strictEqual(occs.length, 3, 'one occurrence per step');
  assert.deepStrictEqual(Array.from(occs).map(o => o.stepIndex), [0, 1, 2]);
  assert.ok(Array.from(occs).every(o => o.photoRequired), 'the goal photo rule was inherited');
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('the routine path survives a spreadsheet that coerces dates and times', () => {
  // The wizard is a brand-new write path into the very columns
  // tests/task-date-keys.test.js exists to protect.
  const gas = loadScript({ properties: props(), coerceLikeSheets: true });
  const today = todayKey(gas);

  walkHead(gas, 'routine', 'Har kuni');
  tap(gas, 'bot_vz_freq:daily');
  tap(gas, 'bot_vz_start:today');
  tap(gas, 'bot_vz_skip:end');
  tap(gas, 'bot_vz_due:09:00');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.strictEqual(task.startKey, today, 'the start key survived the sheet');
  assert.strictEqual(task.dueTime, '09:00', 'the due time survived the sheet');
});

test('every optional step can be skipped: a task with only a title', () => {
  const gas = boot();

  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Shunchaki ish');
  tap(gas, 'bot_vz_skip:desc');
  tap(gas, 'bot_vz_skip:resp');
  tap(gas, 'bot_vz_pri:normal');
  tap(gas, 'bot_vz_photo:0');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.strictEqual(task.title, 'Shunchaki ish');
  assert.strictEqual(task.description, '');
  assert.strictEqual(task.responsible, '');
  assert.strictEqual(task.deadlineKey, '', 'skipping the date leaves it deadline-less');
  assert.strictEqual(task.deadlineTime, '', 'skipping the date skips the time too');
  assert.deepStrictEqual(Array.from(task.reminderTimes), []);
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('the responsible list offers names already used, and resolves the pressed index', () => {
  const gas = boot();

  // First task establishes a name.
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Birinchi');
  tap(gas, 'bot_vz_skip:desc');
  tap(gas, 'bot_vz_resp_other');
  say(gas, 'Ali Valiyev');
  tap(gas, 'bot_vz_pri:normal');
  tap(gas, 'bot_vz_photo:0');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  assert.strictEqual(tasks(gas)[0].responsible, 'Ali Valiyev');

  // Second task should be offered that name as a button.
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Ikkinchi');
  tap(gas, 'bot_vz_skip:desc');

  const respCard = lastCard(gas);
  assert.ok(respCard.text.includes("Mas'ul"), 'the responsible step is on screen');
  assert.ok(buttonData(respCard).indexOf('bot_vz_resp:0') !== -1, 'the known name is offered');

  tap(gas, 'bot_vz_resp:0');
  tap(gas, 'bot_vz_pri:normal');
  tap(gas, 'bot_vz_photo:0');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const second = tasks(gas).find(t => t.title === 'Ikkinchi');
  assert.strictEqual(second.responsible, 'Ali Valiyev', 'the index resolved to the right person');
});

test('a typed date and time are accepted and stored', () => {
  const gas = boot();

  walkHead(gas, 'once', 'Qo\'lda sana');
  tap(gas, 'bot_vz_date:other');
  say(gas, '2026-09-15');
  tap(gas, 'bot_vz_time:other');
  say(gas, '9:05');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.strictEqual(task.deadlineKey, '2026-09-15');
  assert.strictEqual(task.deadlineTime, '09:05', 'a single-digit hour is padded');
});

test('reminder times toggle on and off and are stored sorted', () => {
  const gas = boot();

  walkHead(gas, 'once', 'Eslatmali');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_rem:18:00');
  tap(gas, 'bot_vz_rem:09:00');
  tap(gas, 'bot_vz_rem:12:00');
  tap(gas, 'bot_vz_rem:12:00'); // toggled back off
  tap(gas, 'bot_vz_rem_done');
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.deepStrictEqual(Array.from(task.reminderTimes), ['09:00', '18:00']);
  // No deadline to hang a single reminder on, so they can only mean "daily",
  // and there is nothing to ask: the wizard goes straight to the review card.
  assert.strictEqual(task.remindDaily, true);
  assert.match(lastCard(gas).text, /Vazifa yaratildi/);
});

// ======================================================= the repeat question

/**
 * A dated one-time task with reminder times has two honest readings - every
 * day until it is done, or once on the deadline day - so the wizard asks
 * instead of guessing. It used to infer `remindDaily` from whether a deadline
 * existed, which silently gave a dated task the wrong one.
 */

/** Head + a deadline + one reminder time, stopping on the repeat question. */
function walkToRepeatQuestion(gas, title) {
  walkHead(gas, 'once', title || 'Muddatli eslatma');
  tap(gas, 'bot_vz_date:other');
  say(gas, '2026-09-15');
  tap(gas, 'bot_vz_time:other');
  say(gas, '09:00');
  tap(gas, 'bot_vz_rem:09:00');
  tap(gas, 'bot_vz_rem_done');
}

test('a dated one-time task with reminders is asked how they should repeat', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);

  const asked = lastCard(gas);
  assert.match(asked.text, /qanday takrorlansin/, 'the question is put to the user');
  assert.deepStrictEqual(buttonData(asked), ['bot_vz_rd:daily', 'bot_vz_rd:deadline'],
    'both readings are offered, in the bot_vz namespace');
  assert.strictEqual(tasks(gas).length, 0, 'nothing is written before Saqlash');
});

test('choosing "har kuni" stores remindDaily on a dated task', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);
  tap(gas, 'bot_vz_rd:daily');

  assert.match(lastCard(gas).text, /har kuni/, 'the review card states the choice');
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.strictEqual(task.deadlineKey, '2026-09-15');
  assert.strictEqual(task.remindDaily, true);
  assert.deepStrictEqual(Array.from(task.reminderTimes), ['09:00']);
  assert.strictEqual(occurrences(gas)[0].remindDaily, true, 'and reaches the occurrence');
});

test('choosing "faqat muddat kunida" stores the deadline-only reading', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);
  tap(gas, 'bot_vz_rd:deadline');

  assert.match(lastCard(gas).text, /muddat kunida/);
  tap(gas, 'bot_vz_save');

  const task = tasks(gas)[0];
  assert.strictEqual(task.deadlineKey, '2026-09-15');
  assert.strictEqual(task.remindDaily, false, 'never inferred back to daily');
  assert.strictEqual(occurrences(gas)[0].remindDaily, false);
});

test('a dated task with no reminder times is never asked', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Eslatmasiz');
  tap(gas, 'bot_vz_date:other');
  say(gas, '2026-09-15');
  tap(gas, 'bot_vz_skip:time');
  tap(gas, 'bot_vz_skip:reminders');

  assert.ok(!/qanday takrorlansin/.test(lastCard(gas).text),
    'there is no repeat rule to choose with no reminders');
  tap(gas, 'bot_vz_save');
  assert.strictEqual(tasks(gas)[0].remindDaily, false);
});

test('routines and goals are never asked - their repeat rule is not a choice', () => {
  for (const type of ['routine', 'goal']) {
    const gas = boot();
    walkHead(gas, type, 'Takrorlanuvchi');
    if (type === 'routine') {
      tap(gas, 'bot_vz_freq:daily');
      tap(gas, 'bot_vz_start:today');
      tap(gas, 'bot_vz_skip:end');
      tap(gas, 'bot_vz_skip:duetime');
    } else {
      say(gas, 'Birinchi qadam');
      tap(gas, 'bot_vz_step_done');
    }
    tap(gas, 'bot_vz_rem:09:00');
    tap(gas, 'bot_vz_rem_done');

    assert.ok(!/qanday takrorlansin/.test(lastCard(gas).text), type + ' is not asked');
    tap(gas, 'bot_vz_save');

    // Neither type carries a task-level daily flag, and neither ever did: a
    // routine's reminders belong to the day they were scheduled for, and a
    // goal's are derived per step by goalRemindDaily_ instead.
    assert.strictEqual(tasks(gas)[0].remindDaily, false, type + ' stores no daily flag');
    assert.strictEqual(occurrences(gas)[0].remindDaily, type === 'goal',
      type + ' occurrences keep their own rule');
  }
});

test('the repeat buttons are inert outside their own step', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Erta bosilgan');

  // Pressed while the wizard is still asking for the deadline.
  tap(gas, 'bot_vz_rd:daily');
  assert.match(lastCard(gas).text, /eskirgan/, 'a stale press is refused');

  // And the draft is untouched: the deadline step is still where we are.
  tap(gas, 'bot_vz_date:other');
  say(gas, '2026-09-15');
  tap(gas, 'bot_vz_skip:time');
  tap(gas, 'bot_vz_rem:09:00');
  tap(gas, 'bot_vz_rem_done');
  tap(gas, 'bot_vz_rd:deadline');
  tap(gas, 'bot_vz_save');
  assert.strictEqual(tasks(gas)[0].remindDaily, false);
});

test('an unrecognised repeat value is refused rather than guessed', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);
  tap(gas, 'bot_vz_rd:sometimes');

  assert.match(lastCard(gas).text, /eskirgan/);
  assert.strictEqual(tasks(gas).length, 0, 'and no task is created');
});

test('an unauthorized user cannot answer the repeat question', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);

  const before = tasks(gas).length;
  tap(gas, 'bot_vz_rd:daily', INTRUDER_ID);
  assert.ok(gas.__sentMessages.some(m => m.text.includes("huquqi yo'q")), 'refused');
  assert.strictEqual(tasks(gas).length, before, 'nothing written');

  // The owner's session survives the intruder's press untouched.
  tap(gas, 'bot_vz_rd:daily');
  tap(gas, 'bot_vz_save');
  assert.strictEqual(tasks(gas)[0].remindDaily, true);
});

test('a redelivered save after the repeat question still creates one task', () => {
  const gas = boot();
  walkToRepeatQuestion(gas);
  tap(gas, 'bot_vz_rd:daily');

  tap(gas, 'bot_vz_save');
  tap(gas, 'bot_vz_save'); // Telegram redelivery

  assert.strictEqual(tasks(gas).length, 1, 'the tgRequestId guard still holds');
});

// ============================================================ authorization

test('an unauthorized user pressing Vazifa is refused: no session, no task', () => {
  const gas = boot();
  tap(gas, 'bot_vz_type', INTRUDER_ID);

  assert.ok(gas.__sentMessages.some(m => m.text.includes("huquqi yo'q")), 'refused');
  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'no session');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null, 'the Tasks sheet was never touched');
});

test('an unauthorized user cannot drive a pre-seeded wizard session to a save', () => {
  // The analogue of gate #4: even holding a live session is not enough.
  const gas = boot({
    cache: {
      ['yangi_' + INTRUDER_ID]: JSON.stringify({
        flow: 'task', sessionId: 'sess-x', step: 'vz_confirm', msgId: 42,
        draft: {
          type: 'once', title: 'Intruder', description: '', responsible: '',
          priority: 'normal', photoRequired: false, deadlineKey: '', deadlineTime: '',
          recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: 1, intervalDays: 1 },
          startKey: '', endKey: '', dueTime: '', steps: [], reminderTimes: []
        }
      })
    }
  });

  tap(gas, 'bot_vz_save', INTRUDER_ID);

  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null, 'no task was written');
  assert.ok(gas.__sentMessages.some(m => m.text.includes("huquqi yo'q")));
});

test('the Vazifa button pressed from a group chat does nothing at all', () => {
  const gas = boot();
  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 'bot_vz_type', from: { id: AUTHORIZED_ID },
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: 7 }
    }
  }));

  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'no session');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null, 'no task');
});

test('the /yangi keyboard offers the Vazifa button', () => {
  const gas = boot();
  say(gas, '/yangi');
  const card = lastCard(gas);
  assert.ok(card.text.includes('operatsiya turini tanlang'));
  assert.deepStrictEqual(buttonData(card), ['bot_type:Income', 'bot_type:Expense', 'bot_vz_type']);
});

// ============================================================ input guarding

test('a title over 200 characters is re-prompted, never truncated into the sheet', () => {
  const gas = boot();
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'x'.repeat(201));

  assert.ok(lastCard(gas).text.includes('juda uzun'), 'the user was told why');
  const session = JSON.parse(gas.__cache[sessionKey()]);
  assert.strictEqual(session.step, 'vz_title', 'still on the title step');
  assert.strictEqual(session.draft.title, '', 'nothing was stored');
});

test('an impossible date is refused even though it is syntactically a date key', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Sana tekshiruvi');
  tap(gas, 'bot_vz_date:other');
  say(gas, '2026-13-45');

  assert.ok(lastCard(gas).text.includes("noto'g'ri"));
  const session = JSON.parse(gas.__cache[sessionKey()]);
  assert.strictEqual(session.step, 'vz_date_text', 'still asking');
  assert.strictEqual(session.draft.deadlineKey, '', 'nothing was stored');
});

test('an invalid time is re-prompted', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Vaqt tekshiruvi');
  tap(gas, 'bot_vz_date:today');
  tap(gas, 'bot_vz_time:other');
  say(gas, '25:99');

  assert.ok(lastCard(gas).text.includes("noto'g'ri"));
  assert.strictEqual(JSON.parse(gas.__cache[sessionKey()]).draft.deadlineTime, '');
});

test('a routine end date before its start date is refused', () => {
  const gas = boot();
  walkHead(gas, 'routine', 'Teskari oraliq');
  tap(gas, 'bot_vz_freq:daily');
  tap(gas, 'bot_vz_start:other');
  say(gas, '2026-09-10');
  tap(gas, 'bot_vz_end:other');
  say(gas, '2026-09-01');

  assert.ok(lastCard(gas).text.includes('oldin'), 'the ordering was explained');
  assert.strictEqual(JSON.parse(gas.__cache[sessionKey()]).draft.endKey, '');
});

test('Tayyor on an empty goal step list refuses and stays put', () => {
  const gas = boot();
  walkHead(gas, 'goal', 'Bosqichsiz maqsad');

  // The button is not even offered while the list is empty ...
  assert.deepStrictEqual(buttonData(lastCard(gas)), [], 'no done button with zero steps');

  // ... and pressing it anyway changes nothing.
  tap(gas, 'bot_vz_step_done');
  assert.strictEqual(JSON.parse(gas.__cache[sessionKey()]).step, 'vz_steps');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null);
});

test('the goal step list caps at twenty', () => {
  const gas = boot();
  walkHead(gas, 'goal', 'Ko\'p bosqich');
  for (let i = 0; i < 21; i++) say(gas, 'Qadam ' + (i + 1));

  assert.ok(lastCard(gas).text.includes('chegarasi'), 'the cap was explained');
  assert.strictEqual(JSON.parse(gas.__cache[sessionKey()]).draft.steps.length, 20);
});

test('the last goal step can be removed', () => {
  const gas = boot();
  walkHead(gas, 'goal', 'Orqaga');
  say(gas, 'Bir');
  say(gas, 'Ikki');
  tap(gas, 'bot_vz_step_undo');

  assert.deepStrictEqual(JSON.parse(gas.__cache[sessionKey()]).draft.steps, ['Bir']);
});

test('text at a button-only step is re-prompted, not swallowed', () => {
  const gas = boot();
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Sarlavha');
  tap(gas, 'bot_vz_skip:desc');
  tap(gas, 'bot_vz_skip:resp');
  say(gas, 'bu tugma emas'); // vz_pri is button-only

  assert.ok(lastCard(gas).text.includes('tugmalardan'), 'the user was nudged');
  assert.strictEqual(JSON.parse(gas.__cache[sessionKey()]).step, 'vz_pri', 'still on the same step');
});

test('a non-text message mid-wizard is re-prompted, not stored', () => {
  const gas = boot();
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');

  gas.doPost(postEvent({
    message: {
      chat: { id: AUTHORIZED_ID, type: 'private' }, from: { id: AUTHORIZED_ID },
      message_id: 44, photo: [{ file_id: 'p' }]
    }
  }));

  const session = JSON.parse(gas.__cache[sessionKey()]);
  assert.strictEqual(session.step, 'vz_title');
  assert.strictEqual(session.draft.title, '', 'a photo did not become the title');
});

test('a slash command never becomes the title', () => {
  const gas = boot();
  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, '/start');

  const session = JSON.parse(gas.__cache[sessionKey()]);
  assert.strictEqual(session.draft.title, '');
  assert.strictEqual(session.step, 'vz_title');
});

// ============================================================ escape hatches

test('Bekor clears the session and writes nothing', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Bekor bo\'ladi');
  tap(gas, 'bot_vz_cancel');

  assert.deepStrictEqual(Object.keys(gas.__cache), []);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null);
  assert.ok(lastCard(gas).text.includes('Bekor qilindi'));
});

test('/bekor mid-wizard clears the session; with no task session it changes nothing', () => {
  const gas = boot();
  walkHead(gas, 'once', 'To\'xtatiladi');
  say(gas, '/bekor');
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null);

  // With an accounting session live instead, /bekor is not intercepted at all:
  // the comment step consumes it exactly as it consumed any other text before
  // this change. That behaviour is pre-existing and deliberately not altered —
  // what matters here is that the wizard did not reach in and change it.
  const other = boot({
    cache: {
      ['yangi_' + AUTHORIZED_ID]: JSON.stringify({
        type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS',
        amount: 5000, step: 'await_desc', sessionId: 'sess-acct'
      })
    }
  });
  say(other, '/bekor');

  const txSheet = other.__spreadsheet.getSheetByName('Omad_Transactions');
  const rows = txSheet.getDataRange().getValues().slice(1).filter(r => r[0]);
  assert.strictEqual(rows.length, 1, 'the accounting flow handled it, unchanged');
  assert.strictEqual(rows[0][8], '/bekor', 'as the comment, exactly as before');
});

test('/yangi mid-wizard restarts cleanly', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Birinchi urinish');
  say(gas, '/yangi');

  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'the draft was wiped');
  assert.ok(lastCard(gas).text.includes('operatsiya turini tanlang'));
});

test('a stale button with no session is refused and does not resurrect a draft', () => {
  const gas = boot();
  tap(gas, 'bot_vz_pri:high');

  assert.ok(gas.__sentMessages.some(m => m.text.includes('Sessiya tugagan')));
  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'nothing was resurrected');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Tasks'), null);
});

test('a stale tap belonging to an earlier step re-renders instead of mutating', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Eskirgan tugma');
  // vz_date is on screen; a priority button from two steps ago arrives late.
  tap(gas, 'bot_vz_pri:low');

  const session = JSON.parse(gas.__cache[sessionKey()]);
  assert.strictEqual(session.draft.priority, 'high', 'the draft was not mutated');
  assert.strictEqual(session.step, 'vz_date', 'still where the user actually is');
  assert.ok(lastCard(gas).text.includes('eskirgan'));
});

// ============================================================ idempotency

test('a double-tap on Saqlash creates exactly one task', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Ikki marta bosildi');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');

  tap(gas, 'bot_vz_save');
  tap(gas, 'bot_vz_save');

  assert.strictEqual(tasks(gas).length, 1, 'exactly one task');
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('a redelivery that finds the session still there is caught by the stored request id', () => {
  // The case the session guard alone cannot catch: the task was written, then
  // the script died before the session could be removed. Without the durable
  // meta.tgRequestId this creates a second task.
  const gas = boot();
  walkHead(gas, 'once', 'Qayta yetkazildi');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');

  const revived = gas.__cache[sessionKey()];
  assert.ok(revived, 'the confirm session exists before saving');

  tap(gas, 'bot_vz_save');
  assert.strictEqual(tasks(gas).length, 1);

  // Simulate cache.remove having failed: the very same session is back.
  gas.__cache[sessionKey()] = revived;
  tap(gas, 'bot_vz_save');

  assert.strictEqual(tasks(gas).length, 1, 'still exactly one task');
  assert.deepStrictEqual(Object.keys(gas.__cache), [], 'and the stuck session was cleared');
  assert.ok(lastCard(gas).text.includes('yaratildi'), 'the user is told it succeeded, not that it expired');
});

test('the stored request id is written onto the task row', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Meta tekshiruvi');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const meta = tasks(gas)[0].meta;
  assert.strictEqual(meta.source, 'telegram');
  assert.ok(/^tg_111222333_/.test(meta.tgRequestId), 'the request id identifies the conversation');
});

// ============================================================ isolation

test('a wizard step id can never fall through into the accounting flow', () => {
  // Seeding an accounting step id on a task-flow session must not write a
  // financial row. Nothing else in the suite catches this collision.
  const gas = boot({
    cache: {
      ['yangi_' + AUTHORIZED_ID]: JSON.stringify({
        flow: 'task', sessionId: 'sess-collide', step: 'await_desc', msgId: 42,
        draft: {
          type: 'once', title: 'Collision', description: '', responsible: '',
          priority: 'normal', photoRequired: false, deadlineKey: '', deadlineTime: '',
          recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: 1, intervalDays: 1 },
          startKey: '', endKey: '', dueTime: '', steps: [], reminderTimes: []
        }
      })
    }
  });

  say(gas, 'bu izoh emas');

  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions'), null,
    'no financial sheet was even created');
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Backups'), null);
});

test('a full wizard run writes no financial record of any kind', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Pulga tegmaydi');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  assert.strictEqual(tasks(gas).length, 1);
  // Sheet absence, not row counts: these sheets are created lazily, so `null`
  // proves "never touched" where an empty list cannot.
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions'), null);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Transactions_V2'), null);
  assert.strictEqual(gas.__spreadsheet.getSheetByName('Omad_Backups'), null);
  assert.strictEqual(jobsOfType(gas, 'omad_transaction_report').length, 0);
});

test('the whole wizard runs with an empty System_Config', () => {
  // Structural proof that no tenant or rate configuration is read: if any were,
  // this could not complete.
  const gas = loadScript({ properties: props(), sheets: { System_Config: [] } });
  walkHead(gas, 'once', 'Konfiguratsiyasiz');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  assert.strictEqual(tasks(gas).length, 1, 'the task was created without any accounting config');
});

test('an accounting entry immediately after a wizard run still saves exactly one transaction', () => {
  // The two flows share one session key; this proves the sharing is safe.
  const gas = loadScript({
    properties: props(),
    sheets: {
      System_Config: [
        ['Omad_Tenants', JSON.stringify([{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }])],
        ['Omad_Rates', JSON.stringify({ Fevral: { buy: 12000, sell: 12500 } })]
      ]
    }
  });

  walkHead(gas, 'once', 'Avval vazifa');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  // Now a normal income entry through the very same session key.
  say(gas, '/yangi');
  tap(gas, 'bot_type:Income');
  tap(gas, 'bot_ten:0');
  tap(gas, 'bot_curr:UZS');
  say(gas, '5000000');
  say(gas, 'Fevral ijara');

  const txSheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');
  const rows = txSheet.getDataRange().getValues().slice(1).filter(r => r[0]);
  assert.strictEqual(rows.length, 1, 'exactly one transaction');
  assert.strictEqual(tasks(gas).length, 1, 'and still exactly one task');
});

// ============================================================ announcing

test('with no Tasks group configured the task is still created and the webhook still returns OK', () => {
  const gas = loadScript({ properties: props({ TELEGRAM_TASKS_GROUP_CHAT_ID: '' }) });

  walkHead(gas, 'once', 'Guruhsiz');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  const body = tap(gas, 'bot_vz_save');

  assert.ok(body, 'the webhook answered');
  assert.strictEqual(tasks(gas).length, 1, 'the task exists regardless');
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('the confirmation promises the group card will be sent, never that it was', () => {
  const gas = boot();
  walkHead(gas, 'once', 'So\'z tanlash');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const text = lastCard(gas).text;
  assert.ok(text.includes('yuboriladi'), 'future tense');
  assert.ok(!text.includes('yuborildi'), 'never claims it already went out');
});

test('the confirm card summarises what will be saved', () => {
  const gas = boot();
  const today = todayKey(gas);

  say(gas, '/yangi');
  tap(gas, 'bot_vz_type');
  tap(gas, 'bot_vz_t:once');
  say(gas, 'Hisobot');
  say(gas, 'Batafsil izoh');
  tap(gas, 'bot_vz_resp_other');
  say(gas, 'Bekzod');
  tap(gas, 'bot_vz_pri:urgent');
  tap(gas, 'bot_vz_photo:1');
  tap(gas, 'bot_vz_date:today');
  tap(gas, 'bot_vz_time:20:00');
  tap(gas, 'bot_vz_skip:reminders');

  const card = lastCard(gas);
  assert.ok(card.text.includes('Hisobot'));
  assert.ok(card.text.includes('Bekzod'));
  assert.ok(card.text.includes('Batafsil izoh'));
  assert.ok(card.text.includes(gas.formatTaskDateKey_(today)));
  assert.ok(card.text.includes('20:00'));
  assert.deepStrictEqual(buttonData(card), ['bot_vz_save', 'bot_vz_cancel']);
  // Plain text: no parse_mode anywhere in the wizard, so free-form titles can
  // never break the send.
  assert.strictEqual(card.parse_mode, undefined);
});

test('no wizard message uses a parse mode', () => {
  const gas = boot();
  walkHead(gas, 'once', 'Ali & Vali <test>');
  tap(gas, 'bot_vz_skip:date');
  tap(gas, 'bot_vz_skip:reminders');
  tap(gas, 'bot_vz_save');

  const wizardCards = cards(gas).filter(c => String(c.chat_id) === String(AUTHORIZED_ID));
  assert.ok(wizardCards.length > 0);
  assert.ok(wizardCards.every(c => c.parse_mode === undefined),
    'the private conversation is plain text end to end');
  assert.strictEqual(tasks(gas)[0].title, 'Ali & Vali <test>', 'stored verbatim');
});
