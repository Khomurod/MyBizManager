'use strict';

/**
 * The Mini App against the real task engine.
 *
 * Every test here signs genuine initData and goes in through `doPost`, so the
 * request travels the whole way: the initData gate, the Mini App handler, the
 * parameter translation, the task engine, the occurrence sheet. Nothing is
 * stubbed except Telegram's own HTTP endpoint.
 *
 * That matters because every bug this file pins was invisible to a mocked
 * test. The Mini App and the engine agreed on the wire format and disagreed on
 * the field names inside it: the client said `taskId`, the engine reads `id`,
 * and a mock that returned a canned success proved only that a request was
 * sent.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';
const ADMIN_KEY = 'mini-integration-key';

// The engine's own column order, so the assertions read real cells rather
// than a guess at the layout.
const TASK_HEADER = [
  'ID', 'Type', 'Title', 'Description', 'Responsible', 'Priority', 'Photo_Required',
  'Recurrence_JSON', 'Reminder_Times_JSON', 'Remind_Daily', 'Due_Time',
  'Deadline_Key', 'Deadline_Time', 'Start_Key', 'End_Key', 'Status', 'Steps_JSON',
  'Created_At', 'Updated_At', 'Created_By', 'Meta_JSON'
];

function signInitData(fields, token = BOT_TOKEN) {
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const encoded = Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&');
  return `${encoded}&hash=${hash}`;
}

function initData(userId = AUTHORIZED_ID) {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(userId), first_name: 'Xurshid', username: 'boss' })
  });
}

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_TASKS_GROUP_CHAT_ID: '-1005555555555'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
          { name: 'Tehnopark', defaultRent: 500, currency: 'USD', active: true }
        ])]
      ],
      Omad_Transactions: [[
        'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
        'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
      ]],
      Tasks: [TASK_HEADER]
    }
  });
}

function mini(gas, action, payload = {}) {
  return readJsonOutput(gas.doPost(postEvent(
    Object.assign({ action, initData: initData() }, payload))));
}

function taskAction(gas, taskAction, payload = {}) {
  return mini(gas, 'mini_task_action', Object.assign({ taskAction }, payload));
}

/** Every occurrence the engine has actually materialised. */
function occurrences(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Task_Occurrences');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues();
  const header = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function storedTask(gas, taskId) {
  const rows = gas.__spreadsheet.getSheetByName('Tasks').getDataRange().getValues();
  const header = rows[0];
  const row = rows.slice(1).find(r => r[0] === taskId);
  if (!row) return null;
  const t = {};
  header.forEach((h, i) => { t[h] = row[i]; });
  return t;
}

// --------------------------------------------------------- create and read

test('a task created from the Mini App appears in the Mini App view', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Chiroqni almashtirish', priority: 'high', responsible: 'Diyor'
  });

  assert.strictEqual(created.status, 'success');
  assert.ok(created.taskId, 'the engine returns the id it minted');

  const listed = (created.view.tasks || []).find(t => t.id === created.taskId);
  assert.ok(listed, 'the rebuilt view already contains it');
  assert.strictEqual(listed.title, 'Chiroqni almashtirish');
  assert.strictEqual(listed.priority, 'high');
});

test('the task view the Mini App reads carries lists and counts where the client looks', () => {
  const gas = boot();
  taskAction(gas, 'save_task', { type: 'once', title: 'Bugungi ish' });

  const body = mini(gas, 'mini_tasks');
  assert.strictEqual(body.status, 'success');

  // The client reads view.today.<list> and view.counts.<name>. It used to read
  // view.<name>, which is undefined, so every tab rendered empty.
  assert.ok(body.view.today, 'lists live under today');
  assert.ok(Array.isArray(body.view.today.needsAttention), 'due-today list is needsAttention');
  assert.ok(body.view.counts, 'totals live under counts');
  assert.strictEqual(typeof body.view.counts.dueToday, 'number');
  assert.strictEqual(body.view.counts.dueToday, body.view.today.needsAttention.length);
});

// --------------------------------------------------------------- mutations

test('cancel reaches the task even though the Mini App calls it taskId', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Bekor qilinadi' });

  // Exactly what the client sends: taskId, not id.
  const cancelled = taskAction(gas, 'cancel_task', { taskId: created.taskId });

  assert.strictEqual(cancelled.status, 'success', cancelled.message);
  assert.strictEqual(storedTask(gas, created.taskId).Status, 'cancelled');
});

test('pause and resume reach the routine', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'Har kuni', recurrence: { freq: 'daily', interval: 1 }
  });

  const paused = taskAction(gas, 'pause_routine', { taskId: created.taskId });
  assert.strictEqual(paused.status, 'success', paused.message);
  assert.strictEqual(storedTask(gas, created.taskId).Status, 'paused');

  const resumed = taskAction(gas, 'resume_routine', { taskId: created.taskId });
  assert.strictEqual(resumed.status, 'success', resumed.message);
  assert.strictEqual(storedTask(gas, created.taskId).Status, 'active');
});

test('an edit changes the task instead of creating a second one', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Eski nom' });
  const before = (created.view.tasks || []).length;

  const edited = taskAction(gas, 'save_task', { taskId: created.taskId, title: 'Yangi nom' });

  assert.strictEqual(edited.status, 'success');
  assert.strictEqual(edited.taskId, created.taskId, 'same task, not a new one');
  assert.strictEqual((edited.view.tasks || []).length, before, 'no extra task appeared');
  assert.strictEqual(storedTask(gas, created.taskId).Title, 'Yangi nom');
});

// ------------------------------------------------- routines keep their shape

test('editing a routine does not silently reset its recurrence', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'Dushanba va Juma',
    recurrence: { freq: 'weekly', interval: 2, weekdays: [1, 5] }
  });

  const storedBefore = JSON.parse(storedTask(gas, created.taskId).Recurrence_JSON);
  assert.strictEqual(storedBefore.freq, 'weekly');

  // The Mini App edit sheet shows a title and nothing about cadence, so it
  // sends nothing about cadence. That used to come back as freq: daily.
  const edited = taskAction(gas, 'save_task', { taskId: created.taskId, title: 'Yangi sarlavha' });
  assert.strictEqual(edited.status, 'success');

  const storedAfter = JSON.parse(storedTask(gas, created.taskId).Recurrence_JSON);
  assert.strictEqual(storedAfter.freq, 'weekly', 'the cadence survived the edit');
  assert.strictEqual(storedAfter.interval, 2);
  assert.deepStrictEqual(Array.from(storedAfter.weekdays), [1, 5]);
});

test('a routine cadence can still be changed on purpose', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'O\'zgaradi', recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }
  });

  taskAction(gas, 'save_task', {
    taskId: created.taskId, recurrence: { freq: 'daily', interval: 3 }
  });

  const stored = JSON.parse(storedTask(gas, created.taskId).Recurrence_JSON);
  assert.strictEqual(stored.freq, 'daily', 'an explicit recurrence still replaces it');
  assert.strictEqual(stored.interval, 3);
});

test('editing a once-task does not wipe its deadline', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Muddatli', deadlineKey: '2026-12-31', deadlineTime: '18:00'
  });
  assert.strictEqual(storedTask(gas, created.taskId).Deadline_Key, '2026-12-31');

  taskAction(gas, 'save_task', { taskId: created.taskId, title: 'Nomi o\'zgardi' });

  assert.strictEqual(storedTask(gas, created.taskId).Deadline_Key, '2026-12-31',
    'a field the client never mentioned is left alone');
  assert.strictEqual(storedTask(gas, created.taskId).Deadline_Time, '18:00');
});

test('a deadline can still be cleared deliberately', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Muddat olib tashlanadi', deadlineKey: '2026-12-31'
  });

  taskAction(gas, 'save_task', { taskId: created.taskId, deadlineKey: '' });
  assert.strictEqual(storedTask(gas, created.taskId).Deadline_Key, '',
    'an explicitly empty value still clears it');
});

// ------------------------------------------------------------- completion

test('a completion is attributed to the Telegram user, not to the panel', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Bajariladi' });
  const occ = occurrences(gas).find(o => o.Task_ID === created.taskId);
  assert.ok(occ, 'the engine materialised an occurrence');

  const done = taskAction(gas, 'complete_occurrence', { occurrenceId: occ.ID });
  assert.strictEqual(done.status, 'success', done.message);

  const after = occurrences(gas).find(o => o.ID === occ.ID);
  assert.strictEqual(after.Status, 'Completed');
  assert.strictEqual(String(after.Completed_By_Name), 'Xurshid',
    'the signed-in Telegram name, not "Admin (panel)"');
  assert.strictEqual(String(after.Completed_By_Id), AUTHORIZED_ID);
});

test('reopening puts it back', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Qaytariladi' });
  const occ = occurrences(gas).find(o => o.Task_ID === created.taskId);

  taskAction(gas, 'complete_occurrence', { occurrenceId: occ.ID });
  const reopened = taskAction(gas, 'reopen_occurrence', { occurrenceId: occ.ID });

  assert.strictEqual(reopened.status, 'success');
  assert.strictEqual(occurrences(gas).find(o => o.ID === occ.ID).Status, 'Open');
});

test('a photo-required task waits for proof instead of completing on a tap', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Rasm kerak', photoRequired: true
  });
  const occ = occurrences(gas).find(o => o.Task_ID === created.taskId);

  const pressed = taskAction(gas, 'complete_occurrence', { occurrenceId: occ.ID });

  assert.strictEqual(pressed.status, 'success');
  assert.strictEqual(pressed.awaitingProof, true, 'the client is told it is not finished');

  const after = occurrences(gas).find(o => o.ID === occ.ID);
  assert.strictEqual(after.Status, 'WaitingProof', 'the group card rule applies here too');
  assert.strictEqual(String(after.Proof_Awaiting_User_Id), AUTHORIZED_ID);
});

// ------------------------------------------------------------------- skip

test('skipping a future day is refused once and asks for confirmation', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'Kelgusi kun', recurrence: { freq: 'daily', interval: 1 }
  });

  const future = occurrences(gas)
    .filter(o => o.Task_ID === created.taskId)
    .sort((a, b) => String(b.Date_Key).localeCompare(String(a.Date_Key)))[0];
  assert.ok(future, 'the routine materialised days ahead');

  const refused = taskAction(gas, 'skip_occurrence', { occurrenceId: future.ID });
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.needsFutureConfirm, true, 'the client can turn this into a question');
  assert.ok(refused.dateKey, 'and knows which day it is asking about');
  assert.strictEqual(occurrences(gas).find(o => o.ID === future.ID).Status, 'Open');

  const confirmed = taskAction(gas, 'skip_occurrence', {
    occurrenceId: future.ID, confirmFuture: true
  });
  assert.strictEqual(confirmed.status, 'success');
  assert.strictEqual(occurrences(gas).find(o => o.ID === future.ID).Status, 'Skipped');
});

// -------------------------------------------------------- routine and goal

test('a routine reports the statistics the Mini App renders', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'Statistikali', recurrence: { freq: 'daily', interval: 1 }
  });

  const summary = (mini(gas, 'mini_tasks').view.tasks || []).find(t => t.id === created.taskId);
  assert.ok(summary.stats, 'stats is where the streak lives, not task.streak');
  assert.strictEqual(typeof summary.stats.streak, 'number');
  assert.ok(summary.recurrenceLabel, 'and the cadence has a readable label');
});

test('a goal reports progress where the Mini App renders it', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'goal', title: 'Maqsad',
    steps: [{ title: 'Birinchi' }, { title: 'Ikkinchi' }]
  });

  const summary = (mini(gas, 'mini_tasks').view.tasks || []).find(t => t.id === created.taskId);
  assert.ok(summary.progress, 'progress is an object, not stepCount/stepsCompleted');
  assert.strictEqual(summary.progress.total, 2);
  assert.strictEqual(summary.progress.done, 0);
  assert.strictEqual(summary.progress.percent, 0);

  const step = occurrences(gas).find(o => o.Task_ID === created.taskId && String(o.Step_Index) === '0');
  taskAction(gas, 'complete_occurrence', { occurrenceId: step.ID });

  const after = (mini(gas, 'mini_tasks').view.tasks || []).find(t => t.id === created.taskId);
  assert.strictEqual(after.progress.done, 1);
  assert.strictEqual(after.progress.percent, 50);
});

// ------------------------------------------------------- forged identities

/**
 * A signature says who is calling. Nothing else in the request may.
 *
 * The Mini App handler used to read `payload.completedById || auth.userId` and
 * friends, so a caller who sent those fields decided them. That is a signed
 * request writing an unsigned name into the permanent record of who did the
 * work — the audit trail would show the wrong person, with no trace that it
 * had been supplied rather than derived. Every field the task engine reads for
 * attribution is now stripped from the payload before the engine sees it.
 */

const IMPOSTOR_ID = '99999999';

test('a forged completer id is ignored; the signature decides who completed it', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Kim bajardi?' });
  const occ = occurrences(gas).find(o => o.Task_ID === created.taskId);

  const done = taskAction(gas, 'complete_occurrence', {
    occurrenceId: occ.ID,
    completedById: IMPOSTOR_ID,
    completedBy: 'Boshqa odam',
    completedByName: 'Boshqa odam',
    completedSource: 'web'
  });
  assert.strictEqual(done.status, 'success', done.message);

  const after = occurrences(gas).find(o => o.ID === occ.ID);
  assert.strictEqual(String(after.Completed_By_Id), AUTHORIZED_ID,
    'the id comes from the verified initData, not from the body');
  assert.notStrictEqual(String(after.Completed_By_Id), IMPOSTOR_ID);
  assert.strictEqual(after.Completed_By_Name, 'Xurshid',
    'and so does the name shown in the history');
});

test('a forged proof-awaiting id cannot hand the photo slot to another account', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Rasm kerak', photoRequired: true
  });
  const occ = occurrences(gas).find(o => o.Task_ID === created.taskId);

  taskAction(gas, 'complete_occurrence', {
    occurrenceId: occ.ID,
    proofAwaitingUserId: IMPOSTOR_ID,
    completedById: IMPOSTOR_ID
  });

  // Whoever holds this slot is the account whose next photo closes the task.
  const after = occurrences(gas).find(o => o.ID === occ.ID);
  assert.strictEqual(String(after.Proof_Awaiting_User_Id), AUTHORIZED_ID);
});

test('a forged author is ignored when a task is created', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', {
    type: 'once', title: 'Kim yaratdi?', createdBy: 'tg:' + IMPOSTOR_ID
  });

  assert.strictEqual(storedTask(gas, created.taskId).Created_By, 'tg:' + AUTHORIZED_ID);
});

test('the rest of the payload still reaches the engine untouched', () => {
  const gas = boot();
  // Stripping is by name, so it must not swallow the fields that carry the
  // actual work: only the attribution fields go.
  const created = taskAction(gas, 'save_task', {
    type: 'routine', title: 'Ish qoladi', description: 'Tafsilot',
    responsible: 'Diyor', priority: 'high',
    recurrence: { freq: 'weekly', interval: 1, weekdays: [1] },
    completedById: IMPOSTOR_ID
  });

  const stored = storedTask(gas, created.taskId);
  assert.strictEqual(stored.Title, 'Ish qoladi');
  assert.strictEqual(stored.Description, 'Tafsilot');
  assert.strictEqual(stored.Responsible, 'Diyor');
  assert.strictEqual(stored.Priority, 'high');
  assert.strictEqual(JSON.parse(stored.Recurrence_JSON).freq, 'weekly');
});

// --------------------------------------------------------------- the gate

test('none of this is reachable without a genuine signature', () => {
  const gas = boot();
  const created = taskAction(gas, 'save_task', { type: 'once', title: 'Himoyalangan' });

  const forged = readJsonOutput(gas.doPost(postEvent({
    action: 'mini_task_action', taskAction: 'cancel_task',
    taskId: created.taskId,
    initData: `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify({ id: Number(AUTHORIZED_ID) }))}&hash=deadbeef`
  })));

  assert.strictEqual(forged.authorized, false);
  assert.strictEqual(storedTask(gas, created.taskId).Status, 'active', 'the task is untouched');
});
