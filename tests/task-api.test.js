'use strict';

/**
 * The task web API: reads are open, mutations are admin-gated, and the Tasks
 * group id rides on the existing Telegram settings without disturbing them.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const ADMIN_KEY = 'test-admin-key';

function base(extra) {
  return Object.assign({
    OMAD_ADMIN_KEY: ADMIN_KEY,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: '111222333',
    TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
  }, extra || {});
}

// ---------------------------------------------- Telegram settings extension

test('the Tasks group id saves alongside the other Telegram settings', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings',
    adminKey: ADMIN_KEY,
    authorizedUserId: '111222333',
    groupChatId: '-1001234567890',
    tasksGroupChatId: '-1009998887777'
  })));
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(gas.__properties.TELEGRAM_TASKS_GROUP_CHAT_ID, '-1009998887777');
  assert.strictEqual(body.settings.tasksGroupChatId, '-1009998887777');
});

test('omitting the Tasks group id leaves the existing one untouched', () => {
  const gas = loadScript({ properties: base({ TELEGRAM_TASKS_GROUP_CHAT_ID: '-1009998887777' }) });
  readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '-1001234567890'
  })));
  assert.strictEqual(gas.__properties.TELEGRAM_TASKS_GROUP_CHAT_ID, '-1009998887777');
});

test('an empty Tasks group id clears it (disables task Telegram integration)', () => {
  const gas = loadScript({ properties: base({ TELEGRAM_TASKS_GROUP_CHAT_ID: '-1009998887777' }) });
  readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '-1001234567890', tasksGroupChatId: ''
  })));
  assert.strictEqual(gas.__properties.TELEGRAM_TASKS_GROUP_CHAT_ID, undefined);
});

test('an @username Tasks group id is rejected', () => {
  // Incoming callbacks and photos only ever carry the numeric chat.id, so an
  // @username would send fine and then match nothing at all.
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '-1001234567890', tasksGroupChatId: '@mygroup'
  })));
  assert.strictEqual(body.status, 'error');
  assert.match(body.message, /@username/);
  assert.strictEqual(gas.__properties.TELEGRAM_TASKS_GROUP_CHAT_ID, undefined);
});

test('the reporting group still accepts an @username', () => {
  // It is a send-only destination, and it is already configured live.
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '@omadgroup'
  })));
  assert.strictEqual(body.status, 'success');
  assert.strictEqual(gas.__properties.TELEGRAM_GROUP_CHAT_ID, '@omadgroup');
});

test('a legacy @username already in Script Properties reads as unconfigured', () => {
  const gas = loadScript({ properties: base({ TELEGRAM_TASKS_GROUP_CHAT_ID: '@old' }) });
  assert.strictEqual(gas.getTasksGroupChatId_(), '');

  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks', adminKey: ADMIN_KEY })));
  assert.strictEqual(body.config.tasksGroupConfigured, false);

  assert.strictEqual(gas.isTaskTelegramUpdate_({
    message: { chat: { id: -1009998887777 }, photo: [{ file_id: 'x' }] }
  }), false, 'nothing is claimed while the id is unusable');

  // It stays visible on the settings page so it can be corrected.
  assert.strictEqual(gas.buildTelegramSettingsView_().tasksGroupChatId, '@old');
  assert.strictEqual(gas.buildTelegramSettingsView_().tasksGroupChatIdUsable, false);
});

test('saving, sending and callbacks agree on one id', () => {
  const gas = loadScript({ properties: base() });
  const doc = gas.__spreadsheet;

  readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '-1001234567890', tasksGroupChatId: '-1009998887777'
  })));

  const result = gas.normalizeTaskInput_({ type: 'once', title: 'Ish' }, null);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, Date.now());
  gas.runTaskScheduler_(doc, Date.now());
  gas.processPendingJobs_(doc, 25);

  const card = gas.__sentMessages.find(m => /Yangi vazifa/.test(m.text));
  assert.ok(card, 'the card went out');
  assert.strictEqual(String(card.chat_id), '-1009998887777');

  const occ = gas.readOccurrenceRows_(doc)[0];
  const callback = chatId => ({
    callback_query: {
      id: 'cb', data: 't_done:' + occ.id, from: { id: 42, first_name: 'Ali' },
      message: { chat: { id: chatId, type: 'supergroup' }, message_id: 555 }
    }
  });

  gas.doPost(postEvent(callback(-1002222222222)));
  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_OPEN,
    'a callback from another chat is refused');

  gas.doPost(postEvent(callback(-1009998887777)));
  assert.strictEqual(gas.findOccurrence_(doc, occ.id).status, gas.TASK_STATUS_COMPLETED,
    'a callback from the configured numeric chat is accepted');
});

test('an invalid Tasks group id is rejected and nothing is written', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_telegram_settings', adminKey: ADMIN_KEY,
    authorizedUserId: '111222333', groupChatId: '-1001234567890', tasksGroupChatId: 'not-a-chat'
  })));
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(gas.__properties.TELEGRAM_TASKS_GROUP_CHAT_ID, undefined);
});

// ------------------------------------------------------------ read access

test('get_tasks refuses an anonymous read', () => {
  // The task board is internal company information, so a read is gated exactly
  // like a mutation. This inverts the original expectation deliberately.
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks' })));
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.view, undefined);
});

test('get_tasks returns a view when the admin key is supplied', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks', adminKey: ADMIN_KEY })));
  assert.strictEqual(body.status, 'success');
  assert.ok(body.view && body.view.today, 'the Today view is present');
  assert.ok(Array.isArray(body.view.tasks));
});

// ------------------------------------------------------- mutation gating

test('save_task is refused without the admin key and writes nothing', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', type: 'once', title: 'Ruxsatsiz'
  })));
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(gas.readTaskRows_(gas.__spreadsheet).length, 0);
});

test('save_task with the admin key creates a task and returns the refreshed view', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', adminKey: ADMIN_KEY,
    type: 'routine', title: 'Kunlik hisobot', recurrence: { freq: 'daily' },
    reminderTimes: ['09:00'], responsible: 'Ali', priority: 'high', photoRequired: true
  })));
  assert.strictEqual(body.status, 'success');
  assert.ok(body.taskId);
  const tasks = gas.readTaskRows_(gas.__spreadsheet);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].photoRequired, true);
  assert.ok(body.view.tasks.some(t => t.id === body.taskId));
});

test('a routine can be paused and an occurrence skipped, both admin-gated', () => {
  const gas = loadScript({ properties: base() });
  const created = readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', adminKey: ADMIN_KEY, type: 'routine', title: 'R', recurrence: { freq: 'daily' }
  })));
  const taskId = created.taskId;
  const occId = gas.readOccurrenceRows_(gas.__spreadsheet)[0].id;

  // Skip requires the key.
  assert.strictEqual(
    readJsonOutput(gas.doPost(postEvent({ action: 'skip_occurrence', occurrenceId: occId }))).status,
    'error');

  assert.strictEqual(
    readJsonOutput(gas.doPost(postEvent({ action: 'skip_occurrence', adminKey: ADMIN_KEY, occurrenceId: occId }))).status,
    'success');
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, occId).status, gas.TASK_STATUS_SKIPPED);

  // Pause the routine.
  readJsonOutput(gas.doPost(postEvent({ action: 'pause_routine', adminKey: ADMIN_KEY, id: taskId })));
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, taskId).status, gas.TASK_DEF_PAUSED);
});

test('cancel_task cancels the task and its open occurrences', () => {
  const gas = loadScript({ properties: base() });
  const created = readJsonOutput(gas.doPost(postEvent({
    action: 'save_task', adminKey: ADMIN_KEY, type: 'once', title: 'Bekor'
  })));
  const taskId = created.taskId;

  readJsonOutput(gas.doPost(postEvent({ action: 'cancel_task', adminKey: ADMIN_KEY, id: taskId })));
  assert.strictEqual(gas.findTask_(gas.__spreadsheet, taskId).status, gas.TASK_DEF_CANCELLED);
  const occs = gas.readOccurrenceRows_(gas.__spreadsheet).filter(o => o.taskId === taskId);
  assert.ok(occs.every(o => o.status === gas.TASK_STATUS_CANCELLED));
});
