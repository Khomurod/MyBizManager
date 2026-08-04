'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, postEvent } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = 111222333;
const INTRUDER_ID = 999888777;

function props(extra = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: String(AUTHORIZED_ID),
    TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
  }, extra);
}

function tenantSheets() {
  return {
    System_Config: [
      ['Omad_Tenants', JSON.stringify([{ name: 'Tehnopark', rent: 500, currency: 'USD', disabledMonths: [] }])],
      ['Omad_Rates', JSON.stringify({ Fevral: { buy: 12000, sell: 12500 } })]
    ]
  };
}

function message(fromId, text, chatType = 'private') {
  return {
    message: {
      chat: { id: fromId, type: chatType },
      from: { id: fromId, username: 'someone' },
      text
    }
  };
}

function callback(fromId, data, chatType = 'private') {
  return {
    callback_query: {
      id: 'cb1',
      from: { id: fromId, username: 'someone' },
      data,
      message: { message_id: 10, chat: { id: fromId, type: chatType } }
    }
  };
}

function txRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Transactions');
  return sheet ? sheet.data.slice(1) : [];
}

// ------------------------------------------------------------ authorization

test('isAuthorizedTelegramUser_ matches the configured numeric id', () => {
  const gas = loadScript({ properties: props() });
  assert.strictEqual(gas.isAuthorizedTelegramUser_(AUTHORIZED_ID), true);
  assert.strictEqual(gas.isAuthorizedTelegramUser_(String(AUTHORIZED_ID)), true);
  assert.strictEqual(gas.isAuthorizedTelegramUser_(INTRUDER_ID), false);
});

test('nobody is authorized when no user id is configured', () => {
  const gas = loadScript({ properties: { TELEGRAM_BOT_TOKEN: VALID_TOKEN } });
  assert.strictEqual(gas.isAuthorizedTelegramUser_(AUTHORIZED_ID), false);
  assert.strictEqual(gas.isAuthorizedTelegramUser_(''), false);
});

test('updates with a missing, null or zero from.id are refused', () => {
  const cases = [
    { chat: { id: 111222333, type: 'private' }, text: '/yangi' },
    { chat: { id: 111222333, type: 'private' }, from: { id: null }, text: '/yangi' },
    { chat: { id: 111222333, type: 'private' }, from: { id: 0 }, text: '/yangi' }
  ];
  cases.forEach((msg, i) => {
    const gas = loadScript({ properties: props(), sheets: tenantSheets() });
    gas.doPost(postEvent({ message: msg }));
    const texts = gas.__sentMessages.map(m => m.text);
    assert.ok(texts.some(t => t.includes("huquqi yo'q")), `case ${i} was not refused`);
    assert.ok(!texts.some(t => t.includes('operatsiya turini tanlang')), `case ${i} started a flow`);
    assert.deepStrictEqual(Object.keys(gas.__cache), [], `case ${i} created a session`);
  });
});

test('a numeric from.id matches a string-configured user id', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });
  gas.doPost(postEvent({
    message: { chat: { id: AUTHORIZED_ID, type: 'private' }, from: { id: AUTHORIZED_ID }, text: '/yangi' }
  }));
  assert.ok(gas.__sentMessages.some(m => m.text.includes('operatsiya turini tanlang')));
});

test('username is never used for authorization', () => {
  const gas = loadScript({ properties: props() });
  // A user whose username matches but whose numeric id does not stays blocked.
  gas.doPost(postEvent({
    message: {
      chat: { id: INTRUDER_ID, type: 'private' },
      from: { id: INTRUDER_ID, username: 'omad_admin' },
      text: '/yangi'
    }
  }));
  const texts = gas.__sentMessages.map(m => m.text);
  assert.ok(texts.some(t => t.includes("huquqi yo'q")));
  assert.ok(!texts.some(t => t.includes('operatsiya turini tanlang')));
});

// --------------------------------------------------------- /yangi gating

test('authorized user gets the /yangi keyboard', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });
  gas.doPost(postEvent(message(AUTHORIZED_ID, '/yangi')));
  assert.ok(gas.__sentMessages.some(m => m.text.includes('operatsiya turini tanlang')));
});

test('unauthorized /yangi is refused and creates no session', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });
  gas.doPost(postEvent(message(INTRUDER_ID, '/yangi')));
  assert.ok(gas.__sentMessages.some(m => m.text.includes("huquqi yo'q")));
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
  assert.deepStrictEqual(txRows(gas), []);
});

test('unauthorized inline callback is refused and creates no session', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });
  gas.doPost(postEvent(callback(INTRUDER_ID, 'bot_type:Income')));
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
  assert.ok(gas.__sentMessages.some(m => m.text.includes("huquqi yo'q")));
});

test('every callback step is gated: type, tenant, currency', () => {
  ['bot_type:Expense', 'bot_ten:0', 'bot_spec:Umumiy Bankdan', 'bot_curr:USD'].forEach(data => {
    const gas = loadScript({ properties: props(), sheets: tenantSheets() });
    gas.doPost(postEvent(callback(INTRUDER_ID, data)));
    assert.deepStrictEqual(Object.keys(gas.__cache), [], `session created for ${data}`);
    assert.deepStrictEqual(txRows(gas), [], `transaction created for ${data}`);
  });
});

test('amount and description steps are gated even with a pre-seeded session', () => {
  // Simulates an attacker whose id somehow has a cached session (e.g. left over
  // from a config change): each text step must still re-check authorization.
  const seeded = {
    ['yangi_' + INTRUDER_ID]: JSON.stringify({
      type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS', step: 'await_amount'
    })
  };
  const gas = loadScript({ properties: props(), sheets: tenantSheets(), cache: seeded });
  gas.doPost(postEvent(message(INTRUDER_ID, '150000')));
  assert.deepStrictEqual(txRows(gas), []);

  const seededDesc = {
    ['yangi_' + INTRUDER_ID]: JSON.stringify({
      type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS', amount: 150000, step: 'await_desc'
    })
  };
  const gas2 = loadScript({ properties: props(), sheets: tenantSheets(), cache: seededDesc });
  gas2.doPost(postEvent(message(INTRUDER_ID, 'ijara')));
  assert.deepStrictEqual(txRows(gas2), []);
});

test('the reporting group cannot be used to enter transactions', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });
  // Even the authorized admin, writing in the group, must not start a session.
  gas.doPost(postEvent(message(AUTHORIZED_ID, '/yangi', 'supergroup')));
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
  assert.deepStrictEqual(gas.__sentMessages, []);
});

// -------------------------------------------------- authorized happy path

test('authorized user completes the full flow and one transaction is saved', () => {
  const gas = loadScript({ properties: props(), sheets: tenantSheets() });

  gas.doPost(postEvent(message(AUTHORIZED_ID, '/yangi')));
  gas.doPost(postEvent(callback(AUTHORIZED_ID, 'bot_type:Income')));
  gas.doPost(postEvent(callback(AUTHORIZED_ID, 'bot_ten:0')));
  gas.doPost(postEvent(callback(AUTHORIZED_ID, 'bot_curr:UZS')));
  gas.doPost(postEvent(message(AUTHORIZED_ID, '150000')));
  gas.doPost(postEvent(message(AUTHORIZED_ID, 'Fevral ijara')));

  const rows = txRows(gas);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], 'Tehnopark');
  assert.strictEqual(rows[0][4], 150000);
  assert.strictEqual(rows[0][5], 'UZS');
  assert.strictEqual(rows[0][8], 'Fevral ijara');
  // Session cleared after the save.
  assert.deepStrictEqual(Object.keys(gas.__cache), []);
});

test('invalid amount is rejected without creating a transaction', () => {
  const gas = loadScript({
    properties: props(),
    sheets: tenantSheets(),
    cache: {
      ['yangi_' + AUTHORIZED_ID]: JSON.stringify({
        type: 'Income', tenant: 'Tehnopark', method: 'Naqd', currency: 'UZS', step: 'await_amount'
      })
    }
  });
  gas.doPost(postEvent(message(AUTHORIZED_ID, 'abc')));
  assert.deepStrictEqual(txRows(gas), []);
  assert.ok(gas.__sentMessages.some(m => m.text.includes("noto'g'ri")));
});

test('a Telegram API failure during the webhook does not surface a 500', () => {
  const gas = loadScript({
    properties: props(),
    sheets: tenantSheets(),
    fetch: () => { throw new Error('network down'); }
  });
  const output = gas.doPost(postEvent(message(AUTHORIZED_ID, '/yangi')));
  assert.ok(output.__html === 'OK');
});
