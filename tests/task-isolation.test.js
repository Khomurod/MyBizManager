'use strict';

/**
 * The task Telegram namespace must not disturb the private `/yangi` accounting
 * flow or the financial ledger — even when the Tasks group and the reporting
 * group are the same chat.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = 111222333;
const REPORT_GROUP = '-1001111111111';
const TASKS_GROUP = '-1009998887777';
const TODAY = '2026-08-10';
const NOW = Date.UTC(2026, 7, 10, 4, 0, 0);

function props(tasksGroup) {
  return {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: String(AUTHORIZED_ID),
    TELEGRAM_GROUP_CHAT_ID: REPORT_GROUP,
    TELEGRAM_TASKS_GROUP_CHAT_ID: tasksGroup,
    OMAD_ADMIN_KEY: 'k'
  };
}

function sheets() {
  return {
    System_Config: [
      ['Omad_Tenants', JSON.stringify([{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }])],
      ['Omad_Rates', JSON.stringify({ Fevral: { buy: 12000, sell: 12500 } })]
    ]
  };
}

function readyToSaveCache() {
  return {
    ['yangi_' + AUTHORIZED_ID]: JSON.stringify({
      type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS',
      amount: 5000000, step: 'await_desc', sessionId: 'sess-iso'
    })
  };
}

function transactionRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

function makeOccurrence(gas) {
  const r = gas.normalizeTaskInput_({ type: 'once', title: 'Isolated' }, null);
  gas.appendTaskRow_(gas.__spreadsheet, r.task);
  gas.materializeTaskOccurrences_(gas.__spreadsheet, r.task, NOW);
  return gas.readOccurrenceRows_(gas.__spreadsheet)[0];
}

test('the private /yangi flow still saves exactly one transaction when a Tasks group is configured', () => {
  const gas = loadScript({ properties: props(TASKS_GROUP), sheets: sheets(), cache: readyToSaveCache() });
  gas.doPost(postEvent({
    message: { chat: { id: AUTHORIZED_ID, type: 'private' }, from: { id: AUTHORIZED_ID }, text: 'Fevral ijara' }
  }));

  assert.strictEqual(transactionRows(gas).length, 1, 'one financial record');
  const reportJobs = gas.__spreadsheet.getSheetByName('Omad_Job_Queue')
    .getDataRange().getValues().slice(1).filter(r => r[0] && r[2] === 'omad_transaction_report');
  assert.strictEqual(reportJobs.length, 1, 'one accounting report job, no task jobs mixed in');
});

test('a task done callback never writes a financial transaction', () => {
  const gas = loadScript({ properties: props(TASKS_GROUP), sheets: sheets() });
  const occ = makeOccurrence(gas);

  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 't_done:' + occ.id, from: { id: 555, first_name: 'X' },
      message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, message_id: 1 }
    }
  }));

  assert.strictEqual(transactionRows(gas).length, 0, 'no transaction is created by a task completion');
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, occ.id).status, gas.TASK_STATUS_COMPLETED);
});

test('an accounting callback still reaches the accounting handler, not the task one', () => {
  const gas = loadScript({ properties: props(TASKS_GROUP), sheets: sheets() });
  // bot_type: is the accounting namespace; it must start a /yangi session, and
  // it must not be swallowed by the task router.
  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 'bot_type:Income', from: { id: AUTHORIZED_ID },
      message: { chat: { id: AUTHORIZED_ID, type: 'private' }, message_id: 10 }
    }
  }));
  const session = JSON.parse(gas.__cache['yangi_' + AUTHORIZED_ID] || '{}');
  assert.strictEqual(session.type, 'Income', 'the accounting session was started');
});

test('a photo in the Tasks group with nothing awaiting proof starts no /yangi and writes nothing', () => {
  const gas = loadScript({ properties: props(TASKS_GROUP), sheets: sheets() });
  makeOccurrence(gas);

  gas.doPost(postEvent({
    message: {
      chat: { id: Number(TASKS_GROUP), type: 'supergroup' },
      from: { id: 999, first_name: 'Rando' }, message_id: 5, photo: [{ file_id: 'p' }]
    }
  }));

  assert.strictEqual(transactionRows(gas).length, 0);
  assert.strictEqual(gas.__cache['yangi_999'], undefined, 'no accounting session is created');
});

test('even when the Tasks group IS the reporting group, /yangi and completion stay separate', () => {
  const gas = loadScript({ properties: props(REPORT_GROUP), sheets: sheets(), cache: readyToSaveCache() });
  const occ = makeOccurrence(gas);

  // A task completion in the shared group.
  gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 't_done:' + occ.id, from: { id: 777, first_name: 'Y' },
      message: { chat: { id: Number(REPORT_GROUP), type: 'supergroup' }, message_id: 1 }
    }
  }));
  assert.strictEqual(transactionRows(gas).length, 0, 'the shared group completion writes no transaction');

  // The private /yangi still completes normally.
  gas.doPost(postEvent({
    message: { chat: { id: AUTHORIZED_ID, type: 'private' }, from: { id: AUTHORIZED_ID }, text: 'izoh' }
  }));
  assert.strictEqual(transactionRows(gas).length, 1, 'the private accounting flow is unaffected');
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, occ.id).status, gas.TASK_STATUS_COMPLETED);
});

test('a plain text message in the Tasks group is ignored and starts nothing', () => {
  const gas = loadScript({ properties: props(TASKS_GROUP), sheets: sheets() });
  const body = gas.doPost(postEvent({
    message: { chat: { id: Number(TASKS_GROUP), type: 'supergroup' }, from: { id: 42 }, text: 'salom' }
  }));
  assert.ok(body);
  assert.strictEqual(transactionRows(gas).length, 0);
});
