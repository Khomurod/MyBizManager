'use strict';

/**
 * Editing a task reconciles what people actually see.
 *
 * Invariant: the Tasks row is a definition, but the Task_Occurrences rows are
 * the thing the group and the panel act on. Saving an edit that reaches only
 * the definition is not an edit, it is a lie - the occurrence keeps the old
 * title, owner, deadline and photo rule for ever.
 *
 * The three shapes reconcile differently and each has its own history rule:
 *   once     the single live occurrence is moved; a finished one is left alone
 *   goal     steps carry stable ids, so a rename keeps its occurrence and a
 *            removed step keeps its record while dropping out of progress
 *   routine  the unseen future is re-planned; announced days are refreshed in
 *            place and only withdrawn when the new schedule loses their day
 *
 * The task type itself is immutable: a once-task's single occurrence and a
 * routine's dated history are not interchangeable shapes.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent, readJsonOutput } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const ADMIN_KEY = 'test-admin-key';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: ADMIN_KEY
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

function save(gas, payload) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ action: 'save_task', adminKey: ADMIN_KEY }, payload))));
}

function occs(gas, doc, taskId) {
  return Array.from(gas.readOccurrenceRows_(doc)).filter(o => !taskId || o.taskId === taskId);
}

/** Job rows of one type currently on the queue. */
function jobsOfType(gas, doc, type) {
  const sheet = doc.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  return data.slice(1)
    .filter(row => row[header.indexOf('Type')] === type)
    .map(row => JSON.parse(row[header.indexOf('Payload_JSON')] || '{}'));
}

/** The date key the backend itself is using for "today". */
function serverToday(gas) {
  return gas.taskTodayKey_(Date.now());
}

// -------------------------------------------------------------- one-time

test('editing a one-time task moves its live occurrence', () => {
  const { gas, doc } = setup();
  const created = save(gas, {
    type: 'once', title: 'Eski', deadlineKey: '2026-08-12', deadlineTime: '17:00',
    responsible: 'Ali', priority: 'low', photoRequired: false
  });

  save(gas, {
    id: created.taskId, type: 'once', title: 'Yangi', deadlineKey: '2026-08-20', deadlineTime: '10:00',
    responsible: 'Vali', priority: 'urgent', photoRequired: true, reminderTimes: ['09:00']
  });

  const occ = occs(gas, doc, created.taskId)[0];
  assert.strictEqual(occ.title, 'Yangi');
  assert.strictEqual(occ.dateKey, '2026-08-20');
  assert.strictEqual(occ.dueAt, gas.taskInstantMs_('2026-08-20', '10:00'));
  assert.strictEqual(occ.responsible, 'Vali');
  assert.strictEqual(occ.priority, 'urgent');
  assert.strictEqual(occ.photoRequired, true);
  assert.deepStrictEqual(Array.from(occ.reminderTimes), ['09:00']);
});

test('editing a one-time task refreshes the posted card', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'once', title: 'Eski', deadlineKey: '2026-08-12' });

  const occ = occs(gas, doc, created.taskId)[0];
  occ.msgId = '555';
  gas.writeOccurrenceRow_(doc, occ);

  save(gas, { id: created.taskId, type: 'once', title: 'Yangi', deadlineKey: '2026-08-12' });

  const updates = jobsOfType(gas, doc, 'task_update_message').filter(p => p.occurrenceId === occ.id);
  assert.ok(updates.length >= 1, 'the group card is queued for a refresh');
});

test('a completed one-time task is not rewritten by an edit', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'once', title: 'Eski', deadlineKey: '2026-08-12' });
  const occ = occs(gas, doc, created.taskId)[0];

  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: occ.id, completedBy: 'Ali'
  })));
  const done = gas.findOccurrence_(doc, occ.id);

  save(gas, { id: created.taskId, type: 'once', title: 'Yangi', deadlineKey: '2026-08-25' });

  const after = gas.findOccurrence_(doc, occ.id);
  assert.strictEqual(after.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(after.completedAt, done.completedAt);
  assert.strictEqual(after.completedByName, 'Ali');
  assert.strictEqual(after.title, 'Eski', 'history keeps the title it was completed under');
});

// ------------------------------------------------------------------ goals

test('renaming a goal step keeps its occurrence and its history', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });

  const before = occs(gas, doc, created.taskId);
  const b = before.find(o => o.stepIndex === 1);
  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: b.id, completedBy: 'Ali'
  })));

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'B2', 'C'] });

  const after = occs(gas, doc, created.taskId);
  const renamed = after.find(o => o.id === b.id);
  assert.ok(renamed, 'the same occurrence survived the rename');
  assert.strictEqual(renamed.title, 'Filial — B2');
  assert.strictEqual(renamed.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(renamed.completedByName, 'Ali');
  assert.strictEqual(after.length, 3, 'no step was duplicated');
});

test('adding a goal step creates exactly one new occurrence', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B'] });
  const beforeIds = occs(gas, doc, created.taskId).map(o => o.id);

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });

  const after = occs(gas, doc, created.taskId);
  assert.strictEqual(after.length, 3);
  const fresh = after.filter(o => beforeIds.indexOf(o.id) === -1);
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].title, 'Filial — C');
});

test('inserting a step in the middle does not steal another step\'s occurrence', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });
  const before = occs(gas, doc, created.taskId);
  const bId = before.find(o => o.stepIndex === 1).id;
  const cId = before.find(o => o.stepIndex === 2).id;

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'NEW', 'B', 'C'] });

  const after = occs(gas, doc, created.taskId);
  assert.strictEqual(after.length, 4);
  const b = after.find(o => o.id === bId);
  const c = after.find(o => o.id === cId);
  assert.strictEqual(b.stepIndex, 2, 'B moved down a slot but kept its row');
  assert.strictEqual(b.title, 'Filial — B');
  assert.strictEqual(c.stepIndex, 3);
  assert.strictEqual(c.title, 'Filial — C');
});

test('deleting an unfinished goal step cancels it and frees its slot', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });
  const bId = occs(gas, doc, created.taskId).find(o => o.stepIndex === 1).id;

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'C'] });

  const b = gas.findOccurrence_(doc, bId);
  assert.strictEqual(b.status, gas.TASK_STATUS_CANCELLED);
  assert.strictEqual(b.meta.removedStep, true);

  const progress = gas.goalProgress_(gas.readOccurrenceRows_(doc));
  assert.strictEqual(progress.total, 2);
  assert.strictEqual(progress.done, 0);

  // Materialising again must not resurrect B into the freed slot.
  const countBefore = occs(gas, doc, created.taskId).length;
  gas.materializeTaskOccurrences_(doc, gas.findTask_(doc, created.taskId), FIXED_NOW);
  assert.strictEqual(occs(gas, doc, created.taskId).length, countBefore);
});

test('deleting a completed goal step keeps the record but drops it from progress', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });
  const bId = occs(gas, doc, created.taskId).find(o => o.stepIndex === 1).id;

  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: bId, completedBy: 'Ali'
  })));

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'C'] });

  const b = gas.findOccurrence_(doc, bId);
  assert.strictEqual(b.status, gas.TASK_STATUS_COMPLETED, 'the record of the work done stands');
  assert.strictEqual(b.completedByName, 'Ali');
  assert.strictEqual(b.meta.removedStep, true);

  const progress = gas.goalProgress_(gas.readOccurrenceRows_(doc));
  assert.strictEqual(progress.total, 2);
});

test('removing the last unfinished step completes the goal', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B'] });
  const aId = occs(gas, doc, created.taskId).find(o => o.stepIndex === 0).id;

  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: aId, completedBy: 'Ali'
  })));

  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A'] });

  assert.strictEqual(gas.findTask_(doc, created.taskId).status, gas.TASK_DEF_COMPLETED);
});

test('the goal progress bar is right after a mixed edit', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'goal', title: 'Filial', steps: ['A', 'B', 'C'] });
  const aId = occs(gas, doc, created.taskId).find(o => o.stepIndex === 0).id;

  readJsonOutput(gas.doPost(postEvent({
    action: 'complete_occurrence', adminKey: ADMIN_KEY, occurrenceId: aId, completedBy: 'Ali'
  })));

  // Rename B, delete C, add D — the surviving current scope is A, B2, D.
  save(gas, { id: created.taskId, type: 'goal', title: 'Filial', steps: ['A', 'B2', 'D'] });

  const view = gas.buildTaskViews_(doc, FIXED_NOW);
  const goal = Array.from(view.tasks).find(t => t.id === created.taskId);
  assert.strictEqual(goal.progress.total, 3);
  assert.strictEqual(goal.progress.done, 1);
  assert.strictEqual(goal.progress.percent, 33);
  assert.deepStrictEqual(
    Array.from(goal.stepOccurrences).map(o => o.title),
    ['Filial — A', 'Filial — B2', 'Filial — D']);
});

// --------------------------------------------------------------- routines

test('a routine edit re-plans the unseen future', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const created = save(gas, {
    type: 'routine', title: 'Kassa', startKey: today, recurrence: { freq: 'daily' }
  });
  assert.ok(occs(gas, doc, created.taskId).length > 5, 'a daily horizon exists');

  save(gas, {
    id: created.taskId, type: 'routine', title: 'Kassa', startKey: today,
    recurrence: { freq: 'weekly', weekdays: [1] }
  });

  const future = occs(gas, doc, created.taskId)
    .filter(o => o.dateKey > today && o.status === gas.TASK_STATUS_OPEN);
  assert.ok(future.length >= 1, 'the new schedule produced days');
  future.forEach(o => assert.strictEqual(gas.taskWeekdayOfKey_(o.dateKey), 1,
    o.dateKey + ' is not a Monday'));
});

test('a routine edit refreshes today\'s announced occurrence', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const created = save(gas, {
    type: 'routine', title: 'Eski', startKey: today, recurrence: { freq: 'daily' },
    responsible: 'Ali', priority: 'low', dueTime: '20:00'
  });

  const todayOcc = occs(gas, doc, created.taskId).find(o => o.dateKey === today);
  todayOcc.notifiedAt = new Date(FIXED_NOW).toISOString();
  todayOcc.msgId = '555';
  gas.writeOccurrenceRow_(doc, todayOcc);

  save(gas, {
    id: created.taskId, type: 'routine', title: 'Yangi', startKey: today,
    recurrence: { freq: 'daily' }, responsible: 'Vali', priority: 'urgent', dueTime: '10:00'
  });

  const after = gas.findOccurrence_(doc, todayOcc.id);
  assert.ok(after, 'the announced row was updated, not replaced');
  assert.strictEqual(after.title, 'Yangi');
  assert.strictEqual(after.responsible, 'Vali');
  assert.strictEqual(after.priority, 'urgent');
  assert.strictEqual(after.dueAt, gas.taskInstantMs_(today, '10:00'));
  assert.strictEqual(after.notifiedAt, todayOcc.notifiedAt, 'it is still announced');
});

test('a routine edit withdraws announced days the new schedule dropped', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const created = save(gas, {
    type: 'routine', title: 'Kassa', startKey: today, recurrence: { freq: 'daily' }
  });

  const far = gas.taskDateKeyAddDays_(today, 10);
  const farOcc = occs(gas, doc, created.taskId).find(o => o.dateKey === far);
  farOcc.notifiedAt = new Date(FIXED_NOW).toISOString();
  farOcc.msgId = '777';
  gas.writeOccurrenceRow_(doc, farOcc);

  // Shorten the routine so that announced day is no longer in the schedule.
  save(gas, {
    id: created.taskId, type: 'routine', title: 'Kassa', startKey: today,
    endKey: gas.taskDateKeyAddDays_(today, 3), recurrence: { freq: 'daily' }
  });

  const after = gas.findOccurrence_(doc, farOcc.id);
  assert.strictEqual(after.status, gas.TASK_STATUS_CANCELLED);
  const updates = jobsOfType(gas, doc, 'task_update_message').filter(p => p.occurrenceId === farOcc.id);
  assert.ok(updates.length >= 1, 'the group card is withdrawn rather than left hanging');
});

test('a routine edit preserves completed and skipped history', () => {
  const { gas, doc } = setup();
  const today = serverToday(gas);
  const created = save(gas, {
    type: 'routine', title: 'Kassa', startKey: today, recurrence: { freq: 'daily' }
  });

  const rows = occs(gas, doc, created.taskId);
  const doneRow = rows.find(o => o.dateKey === gas.taskDateKeyAddDays_(today, 2));
  doneRow.status = gas.TASK_STATUS_COMPLETED;
  doneRow.completedByName = 'Ali';
  gas.writeOccurrenceRow_(doc, doneRow);

  const skipRow = rows.find(o => o.dateKey === gas.taskDateKeyAddDays_(today, 3));
  skipRow.status = gas.TASK_STATUS_SKIPPED;
  gas.writeOccurrenceRow_(doc, skipRow);

  save(gas, {
    id: created.taskId, type: 'routine', title: 'Butunlay boshqa', startKey: today,
    recurrence: { freq: 'weekly', weekdays: [1] }
  });

  const done = gas.findOccurrence_(doc, doneRow.id);
  assert.strictEqual(done.status, gas.TASK_STATUS_COMPLETED);
  assert.strictEqual(done.completedByName, 'Ali');
  assert.strictEqual(done.title, 'Kassa', 'a finished day keeps the title it was finished under');

  const skipped = gas.findOccurrence_(doc, skipRow.id);
  assert.strictEqual(skipped.status, gas.TASK_STATUS_SKIPPED);
  assert.strictEqual(skipped.title, 'Kassa');
});

// ------------------------------------------------------------------- type

test('the task type cannot be changed', () => {
  const { gas, doc } = setup();
  const created = save(gas, { type: 'once', title: 'T', deadlineKey: '2026-08-12' });
  const before = occs(gas, doc, created.taskId).length;

  const result = save(gas, {
    id: created.taskId, type: 'routine', title: 'T',
    startKey: serverToday(gas), recurrence: { freq: 'daily' }
  });

  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /turini/i);
  assert.strictEqual(gas.findTask_(doc, created.taskId).type, 'once');
  assert.strictEqual(occs(gas, doc, created.taskId).length, before, 'no routine horizon was created');
});
