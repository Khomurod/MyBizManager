'use strict';

/**
 * Failure-injection and duplicate-update coverage for the Telegram /yangi flow.
 *
 * The invariants under test:
 *   1. the financial transaction is saved exactly once;
 *   2. the session is finalised only after the transaction is accepted;
 *   3. Telegram reporting is a separate retryable job;
 *   4. a Telegram failure can never produce a second copy;
 *   5. replaying the same update can never produce a second copy;
 *   6. the user is told the transaction was saved even when the report is
 *      still pending.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = 111222333;
const GROUP_ID = '-1001234567890';

function props() {
  return {
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: String(AUTHORIZED_ID),
    TELEGRAM_GROUP_CHAT_ID: GROUP_ID
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

function readyToSaveCache(sessionId = 'session-1') {
  return {
    ['yangi_' + AUTHORIZED_ID]: JSON.stringify({
      type: 'Income',
      tenant: 'Tehnopark',
      method: 'Naqd',
      currency: 'UZS',
      amount: 5000000,
      step: 'await_desc',
      sessionId
    })
  };
}

function descriptionUpdate(text = 'Fevral ijara') {
  return {
    message: {
      chat: { id: AUTHORIZED_ID, type: 'private' },
      from: { id: AUTHORIZED_ID, username: 'admin' },
      text
    }
  };
}

function transactionRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0]);
}

function jobRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0]);
}

// --------------------------------------------------------- the happy path

test('a completed /yangi entry saves exactly one transaction and queues one report', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache() });
  gas.doPost(postEvent(descriptionUpdate()));

  assert.strictEqual(transactionRows(gas).length, 1);

  const jobs = jobRows(gas);
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0][2], 'omad_transaction_report');
  assert.strictEqual(jobs[0][4], gas.JOB_STATUS_COMPLETED);

  // The report reached the group, and the user was confirmed.
  const groupMessages = gas.__sentMessages.filter(m => String(m.chat_id) === GROUP_ID);
  assert.strictEqual(groupMessages.length, 1);
  const userMessages = gas.__sentMessages.filter(m => String(m.chat_id) === String(AUTHORIZED_ID));
  assert.ok(userMessages.some(m => m.text.includes('Tranzaksiya saqlandi')));
});

test('the session is cleared once the transaction is stored', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache() });
  gas.doPost(postEvent(descriptionUpdate()));
  assert.strictEqual(gas.__cache['yangi_' + AUTHORIZED_ID], undefined);
});

// ------------------------------------------------------- failure injection

test('a Telegram group-report failure still saves the transaction exactly once', () => {
  const gas = loadScript({
    properties: props(),
    sheets: sheets(),
    cache: readyToSaveCache(),
    fetch: (url, params) => {
      const body = JSON.parse(params.payload);
      if (String(body.chat_id) === GROUP_ID) {
        return { getResponseCode: () => 500, getContentText: () => 'Telegram is down' };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } }) };
    }
  });

  gas.doPost(postEvent(descriptionUpdate()));

  assert.strictEqual(transactionRows(gas).length, 1, 'the transaction is saved once');

  const jobs = jobRows(gas);
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0][4], gas.JOB_STATUS_PENDING, 'the report stays queued for retry');
  assert.ok(String(jobs[0][7]).length > 0, 'the failure reason is recorded');
  assert.ok(!String(jobs[0][7]).includes(VALID_TOKEN), 'the token is never written to the queue');

  // The user is still told the transaction was saved.
  const userMessages = gas.__sentMessages.filter(m => String(m.chat_id) === String(AUTHORIZED_ID));
  assert.ok(userMessages.some(m => m.text.includes('Tranzaksiya saqlandi')));
  assert.strictEqual(gas.__cache['yangi_' + AUTHORIZED_ID], undefined, 'the session is still finalised');
});

test('a Telegram outage during the confirmation cannot duplicate the transaction', () => {
  const gas = loadScript({
    properties: props(),
    sheets: sheets(),
    cache: readyToSaveCache(),
    fetch: () => { throw new Error('network down'); }
  });

  // The whole webhook handler is wrapped, so a hard transport failure is
  // absorbed rather than surfacing to Telegram as a 500 (which would make
  // Telegram redeliver the update).
  gas.doPost(postEvent(descriptionUpdate()));

  assert.strictEqual(transactionRows(gas).length, 1);
  assert.strictEqual(gas.__cache['yangi_' + AUTHORIZED_ID], undefined);
});

// ------------------------------------------------------- duplicate updates

test('replaying the same description update does not create a second transaction', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache() });

  gas.doPost(postEvent(descriptionUpdate()));
  // Telegram redelivers the identical update.
  gas.doPost(postEvent(descriptionUpdate()));
  gas.doPost(postEvent(descriptionUpdate()));

  assert.strictEqual(transactionRows(gas).length, 1);
});

test('a redelivered update against a still-open session resolves to the same record', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache('stable-session') });

  gas.doPost(postEvent(descriptionUpdate()));
  const firstId = transactionRows(gas)[0][0];

  // Simulate the session surviving (e.g. the cache removal itself failed) and
  // the same update arriving again.
  gas.__cache['yangi_' + AUTHORIZED_ID] = JSON.stringify({
    type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS',
    amount: 5000000, step: 'await_desc', sessionId: 'stable-session'
  });
  gas.doPost(postEvent(descriptionUpdate()));

  const rows = transactionRows(gas);
  assert.strictEqual(rows.length, 1, 'the request id de-duplicates the write');
  assert.strictEqual(rows[0][0], firstId);
});

test('the stored transaction carries its request id', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache('abc123') });
  gas.doPost(postEvent(descriptionUpdate()));

  const header = gas.__spreadsheet.getSheetByName('Omad_Transactions').getDataRange().getValues()[0];
  assert.strictEqual(header[10], 'Request_ID');
  assert.strictEqual(transactionRows(gas)[0][10], 'tg_' + AUTHORIZED_ID + '_abc123');
});

test('two different sessions produce two transactions', () => {
  const gas = loadScript({ properties: props(), sheets: sheets(), cache: readyToSaveCache('session-a') });

  gas.doPost(postEvent(descriptionUpdate('birinchi')));
  gas.__cache['yangi_' + AUTHORIZED_ID] = JSON.stringify({
    type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS',
    amount: 7000000, step: 'await_desc', sessionId: 'session-b'
  });
  gas.doPost(postEvent(descriptionUpdate('ikkinchi')));

  assert.strictEqual(transactionRows(gas).length, 2);
});

test('a repeated callback query does not start a duplicate save', () => {
  const gas = loadScript({ properties: props(), sheets: sheets() });

  const currencyCallback = {
    callback_query: {
      id: 'cb1',
      data: 'bot_curr:UZS',
      from: { id: AUTHORIZED_ID },
      message: { chat: { id: AUTHORIZED_ID, type: 'private' }, message_id: 10 }
    }
  };

  gas.doPost(postEvent({
    callback_query: {
      id: 'cb0', data: 'bot_type:Income', from: { id: AUTHORIZED_ID },
      message: { chat: { id: AUTHORIZED_ID, type: 'private' }, message_id: 10 }
    }
  }));
  gas.doPost(postEvent(currencyCallback));
  gas.doPost(postEvent(currencyCallback));

  assert.strictEqual(transactionRows(gas).length, 0, 'callbacks never write a transaction');
});

test('each /yangi run gets a distinct session id', () => {
  const gas = loadScript({ properties: props(), sheets: sheets() });

  const typeCallback = () => gas.doPost(postEvent({
    callback_query: {
      id: 'cb', data: 'bot_type:Income', from: { id: AUTHORIZED_ID },
      message: { chat: { id: AUTHORIZED_ID, type: 'private' }, message_id: 10 }
    }
  }));

  typeCallback();
  const first = JSON.parse(gas.__cache['yangi_' + AUTHORIZED_ID]).sessionId;
  typeCallback();
  const second = JSON.parse(gas.__cache['yangi_' + AUTHORIZED_ID]).sessionId;

  assert.ok(first && second);
  assert.notStrictEqual(first, second);
});
