'use strict';

/**
 * Goals behave like the rest of the task system.
 *
 * The rule this file defends, decided in the remediation spec and documented
 * in TASKS.md: a goal's steps are ordinary deadline-less task-occurrences.
 * Each is announced to the Tasks group once, with a completion button and the
 * goal's photo-proof rule (a step may override it). Reminder times set on a
 * goal repeat DAILY while a step is still open, because a step has no
 * deadline of its own to hang a single reminder on - that is what makes the
 * setting mean something instead of nothing. Goal steps stay in the Maqsadlar
 * tab and do not appear in Bugun, which is reserved for dated work.
 *
 * Before this, normalizeGoalSteps_ always wrote photoRequired explicitly, so
 * the inheritance branch was dead code; and the scheduler skipped goals
 * outright, so steps were never announced and reminder times did nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent, readJsonOutput } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const ADMIN_KEY = 'test-admin-key';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent
const DAY_MS = 86400000;

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

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: ADMIN_KEY
    },
    fetch: incrementingFetch()
  });
  return { gas, doc: gas.__spreadsheet };
}

function makeGoal(gas, doc, payload) {
  const result = gas.normalizeTaskInput_(Object.assign({ type: 'goal', title: 'Filial' }, payload), null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, FIXED_NOW);
  return result.task;
}

function steps(gas, doc, taskId) {
  return Array.from(gas.readOccurrenceRows_(doc))
    .filter(o => o.taskId === taskId)
    .sort((a, b) => Number(a.stepIndex) - Number(b.stepIndex));
}

function sends(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/sendMessage') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

/** Run a scheduler pass and drain everything it queued. */
function pass(gas, doc, nowMs) {
  gas.runTaskScheduler_(doc, nowMs);
  gas.processPendingJobs_(doc, 25);
}

// -------------------------------------------------------- the photo rule

test('a goal-level photo requirement reaches every step', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { photoRequired: true, steps: ['A', 'B'] });
  assert.deepStrictEqual(steps(gas, doc, goal.id).map(o => o.photoRequired), [true, true]);
});

test('a step may opt out of the goal\'s photo requirement', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, {
    photoRequired: true, steps: [{ title: 'A', photoRequired: false }, { title: 'B' }]
  });
  assert.deepStrictEqual(steps(gas, doc, goal.id).map(o => o.photoRequired), [false, true]);
});

test('a step may opt in when the goal does not require one', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, {
    photoRequired: false, steps: [{ title: 'A', photoRequired: true }, { title: 'B' }]
  });
  assert.deepStrictEqual(steps(gas, doc, goal.id).map(o => o.photoRequired), [true, false]);
});

// ------------------------------------------------------------ announcing

test('goal steps are announced to the group exactly once', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B'] });

  pass(gas, doc, FIXED_NOW);
  const cards = sends(gas).filter(m => /Yangi vazifa/.test(m.text));
  assert.strictEqual(cards.length, 2, 'one card per step');
  assert.ok(cards.every(c => c.reply_markup.inline_keyboard[0][0].callback_data.indexOf('t_done:') === 0),
    'each card carries a completion button');

  pass(gas, doc, FIXED_NOW + 60000);
  assert.strictEqual(sends(gas).filter(m => /Yangi vazifa/.test(m.text)).length, 2,
    'a second pass announces nothing again');

  assert.strictEqual(steps(gas, doc, goal.id).filter(o => o.notifiedAt).length, 2);
});

test('goal steps stay out of the Bugun view', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B'] });
  const view = gas.buildTaskViews_(doc, FIXED_NOW);

  const today = view.today;
  const all = [].concat(
    Array.from(today.overdue), Array.from(today.needsAttention),
    Array.from(today.waitingProof), Array.from(today.upcoming));
  assert.deepStrictEqual(all.filter(o => o.taskId === goal.id), [],
    'Bugun is reserved for dated work');

  const summary = Array.from(view.tasks).find(t => t.id === goal.id);
  assert.strictEqual(Array.from(summary.stepOccurrences).length, 2, 'they live in Maqsadlar');
});

// ------------------------------------------------------------- reminders

test('goal reminders repeat daily while a step is open', () => {
  const { gas, doc } = setup();
  makeGoal(gas, doc, { steps: ['A', 'B'], reminderTimes: ['08:00'] });

  pass(gas, doc, FIXED_NOW); // 09:00, so 08:00 has passed
  const afterFirst = sends(gas).filter(m => /Eslatma/.test(m.text)).length;
  assert.strictEqual(afterFirst, 2, 'one reminder per open step');

  pass(gas, doc, FIXED_NOW + 3600000); // later the same day
  assert.strictEqual(sends(gas).filter(m => /Eslatma/.test(m.text)).length, afterFirst,
    'the same slot does not fire twice in one day');

  pass(gas, doc, FIXED_NOW + DAY_MS); // the next day
  assert.strictEqual(sends(gas).filter(m => /Eslatma/.test(m.text)).length, afterFirst + 2,
    'a step with no deadline is reminded again the next day');
});

test('completing a step stops its reminders', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B'], reminderTimes: ['08:00'] });
  pass(gas, doc, FIXED_NOW);

  const a = steps(gas, doc, goal.id)[0];
  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: a.id, completedBy: 'Ali'
  })));

  const before = sends(gas).filter(m => /Eslatma/.test(m.text)).length;
  pass(gas, doc, FIXED_NOW + DAY_MS);
  const fresh = sends(gas).filter(m => /Eslatma/.test(m.text)).slice(before);

  assert.strictEqual(fresh.length, 1, 'only the still-open step is reminded');
  assert.match(fresh[0].text, /— B/);
});

test('a cancelled goal goes silent', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B'], reminderTimes: ['08:00'] });
  pass(gas, doc, FIXED_NOW);

  readJsonOutput(gas.doPost(postEvent({ action: 'cancel_task', adminKey: ADMIN_KEY, id: goal.id })));

  const before = sends(gas).length;
  pass(gas, doc, FIXED_NOW + DAY_MS);
  const fresh = sends(gas).slice(before).filter(m => /Yangi vazifa|Eslatma/.test(m.text));
  assert.deepStrictEqual(fresh, [], 'a cancelled goal announces and reminds nothing');
});

// -------------------------------------------------------------- progress

test('progress ignores cancelled and removed steps', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B', 'C'] });
  const rows = steps(gas, doc, goal.id);

  rows[2].status = gas.TASK_STATUS_CANCELLED;
  gas.writeOccurrenceRow_(doc, rows[2]);

  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: rows[0].id, completedBy: 'Ali'
  })));

  const progress = gas.goalProgress_(gas.readOccurrenceRows_(doc));
  assert.strictEqual(progress.total, 2);
  assert.strictEqual(progress.done, 1);
  assert.strictEqual(progress.percent, 50);
});

test('reopening a step reopens the goal', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { steps: ['A', 'B'] });
  const rows = steps(gas, doc, goal.id);

  rows.forEach(step => readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: step.id, completedBy: 'Ali'
  }))));
  assert.strictEqual(gas.findTask_(doc, goal.id).status, gas.TASK_DEF_COMPLETED);

  readJsonOutput(gas.doPost(postEvent({
    action: 'reopen_occurrence', adminKey: ADMIN_KEY, occurrenceId: rows[0].id
  })));

  assert.strictEqual(gas.findTask_(doc, goal.id).status, gas.TASK_DEF_ACTIVE);
  const progress = gas.goalProgress_(gas.readOccurrenceRows_(doc));
  assert.ok(progress.percent < 100, 'progress reflects the reopened step');
});

test('reopening a step leaves a removed step removed', () => {
  const { gas, doc } = setup();
  const created = readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', adminKey: ADMIN_KEY, type: 'goal', title: 'Filial', steps: ['A', 'B', 'C']
  })));
  const rows = steps(gas, doc, created.taskId);
  const removedId = rows[2].id;

  readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', adminKey: ADMIN_KEY, id: created.taskId, type: 'goal',
    title: 'Filial', steps: ['A', 'B']
  })));
  readJsonOutput(gas.doPost(postEvent({
    action: 'reopen_occurrence', adminKey: ADMIN_KEY, occurrenceId: rows[0].id
  })));

  assert.strictEqual(gas.findOccurrence_(doc, removedId).meta.removedStep, true);
});

// ------------------------------------------------------------ photo proof

test('a goal step photo proof completes through the group', () => {
  const { gas, doc } = setup();
  const goal = makeGoal(gas, doc, { photoRequired: true, steps: ['A', 'B'] });
  pass(gas, doc, FIXED_NOW);

  const a = steps(gas, doc, goal.id)[0];
  assert.ok(a.msgId, 'the step card was posted');

  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 't_done:' + a.id, from: { id: 111, first_name: 'Ali' },
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: Number(a.msgId) }
    }
  }));
  gas.processPendingJobs_(doc, 25);

  const promptId = gas.findOccurrence_(doc, a.id).meta.proofPromptMsgId;
  assert.ok(promptId, 'the ForceReply prompt went out for a goal step too');

  gas.doPost(postEvent({
    message: {
      chat: { id: Number(TASKS_GROUP), type: 'supergroup' },
      from: { id: 111, first_name: 'Ali' }, message_id: 900,
      reply_to_message: { message_id: Number(promptId) },
      photo: [{ file_id: 'small' }, { file_id: 'big' }]
    }
  }));

  const done = gas.findOccurrence_(doc, a.id);
  assert.strictEqual(done.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(done.proofFileId, 'big');
  assert.strictEqual(done.completedByName, 'Ali');
});
