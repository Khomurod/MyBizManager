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

test('get_tasks returns a view without requiring an admin key', () => {
  const gas = loadScript({ properties: base() });
  const body = readJsonOutput(gas.doPost(postEvent({ action: 'get_tasks' })));
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
