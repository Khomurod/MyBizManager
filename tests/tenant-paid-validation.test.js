'use strict';

/**
 * A tenant-paid expense must name a tenant who actually exists.
 *
 * The feature credits the tenant's balance, so the name is not a label - it is
 * the account being moved. Accepting any non-empty string meant a typo, or a
 * made-up name from a forged request, produced a credit against a tenant who
 * does not exist: money apparently owed to nobody, and a debt figure that no
 * longer reconciles.
 *
 * The rule being pinned is deliberately narrow. Backdating is legitimate -
 * bills are recorded late and corrected later still - so the boundary is the
 * tenant's own agreement window, not "is this tenant current".
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ADMIN_KEY = 'tenant-validation-admin-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const RATES = { '2026-08': { buy: 12000, sell: 12500 } };

/**
 * Four tenants that between them cover the cases that matter: an open-ended
 * current one, one who started late, one who has left, and one still on the
 * books but marked inactive.
 */
const TENANTS = [
  { name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true },
  { name: 'Kafe', defaultRent: 2000000, currency: 'UZS', active: true, startPeriod: '2026-03' },
  { name: 'Eski Ijarachi', defaultRent: 500000, currency: 'UZS', active: true, endPeriod: '2026-05' },
  { name: 'Nofaol', defaultRent: 700000, currency: 'UZS', active: false }
];

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
      TELEGRAM_AUTHORIZED_USER_ID: '49328655'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Tenants', JSON.stringify(TENANTS)]
      ],
      Omad_Transactions: [LEGACY_HEADER]
    }
  });
}

let requestCounter = 0;
function payload(overrides = {}) {
  requestCounter += 1;
  return Object.assign({
    action: 'tenant_paid_expense', adminKey: ADMIN_KEY,
    requestId: `req_${requestCounter}`,
    groupId: `grp_${requestCounter}`,
    tenant: 'Apteka',
    period: '2026-08',
    amount: 1000000,
    currency: 'UZS',
    method: 'Naqd',
    comment: 'Elektrik xizmati',
    source: 'Web',
    createdBy: 'tester',
    deferReports: true
  }, overrides);
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

function rowCount(gas) {
  return gas.__spreadsheet.getSheetByName('Omad_Transactions').getLastRow() - 1;
}

// ------------------------------------------------------------------ accepted

test('a real tenant is accepted', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Apteka' }));

  assert.strictEqual(response.status, 'success');
  assert.strictEqual(rowCount(gas), 2, 'the linked pair is written');
});

test('surrounding whitespace still matches the configured tenant', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: '  Apteka  ' }));
  assert.strictEqual(response.status, 'success');
});

test('a tenant marked inactive can still be credited for a past bill', () => {
  // They are on the books with no end date, so nothing says the payment did
  // not happen. Refusing this would make correcting their history impossible.
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Nofaol', period: '2026-04' }));
  assert.strictEqual(response.status, 'success');
});

// ------------------------------------------------------------------ refused

test('a made-up tenant is refused', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Yolgon Ijarachi' }));

  assert.strictEqual(response.status, 'error');
  assert.match(response.message, /ro'yxatda yo'q/);
  assert.strictEqual(rowCount(gas), 0, 'nothing at all is written');
});

test('a near-miss on the name is refused rather than guessed at', () => {
  const gas = boot();
  // A typo must not silently open a second balance under a similar name.
  const response = post(gas, payload({ tenant: 'Aptekaa' }));
  assert.strictEqual(response.status, 'error');
  assert.strictEqual(rowCount(gas), 0);
});

test('an expense bucket is refused', () => {
  const gas = boot();
  ['Umumiy Naqd Puldan', 'Umumiy Bankdan'].forEach(bucket => {
    const response = post(gas, payload({ tenant: bucket }));
    assert.strictEqual(response.status, 'error', `${bucket} is not a tenant`);
    assert.match(response.message, /umumiy kassa/);
  });
  assert.strictEqual(rowCount(gas), 0);
});

test('an empty tenant is refused', () => {
  const gas = boot();
  [undefined, '', '   ', null].forEach(value => {
    const response = post(gas, payload({ tenant: value }));
    assert.strictEqual(response.status, 'error');
    assert.match(response.message, /tanlanmagan/);
  });
  assert.strictEqual(rowCount(gas), 0);
});

// --------------------------------------------------- historical / backdating

test('a period inside a departed tenant\'s agreement is accepted', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Eski Ijarachi', period: '2026-04' }));

  assert.strictEqual(response.status, 'success',
    'they were still a tenant in April, so the April bill is theirs');
  assert.strictEqual(rowCount(gas), 2);
});

test('a period after a departed tenant left is refused', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Eski Ijarachi', period: '2026-08' }));

  assert.strictEqual(response.status, 'error');
  assert.match(response.message, /shartnomasiga kirmaydi/);
  assert.strictEqual(rowCount(gas), 0);
});

test('a period before a tenant moved in is refused', () => {
  const gas = boot();
  const response = post(gas, payload({ tenant: 'Kafe', period: '2026-01' }));

  assert.strictEqual(response.status, 'error');
  assert.match(response.message, /shartnomasiga kirmaydi/);
});

test('the first and last periods of an agreement are inside it', () => {
  const gas = boot();
  assert.strictEqual(post(gas, payload({ tenant: 'Kafe', period: '2026-03' })).status, 'success',
    'the month they moved in counts');
  assert.strictEqual(post(gas, payload({ tenant: 'Eski Ijarachi', period: '2026-05' })).status, 'success',
    'the month they moved out counts');
});

test('a tenant with no window configured is accepted for any period', () => {
  const gas = boot();
  assert.strictEqual(post(gas, payload({ tenant: 'Apteka', period: '2024-01' })).status, 'success');
  assert.strictEqual(post(gas, payload({ tenant: 'Apteka', period: '2027-12' })).status, 'success');
});

// ------------------------------------------------------- every entry point

test('the Mini App is held to the same rule', () => {
  const gas = boot();
  // Through the Mini App handler rather than the web action, because a second
  // door into the same write is exactly how a validation rule gets bypassed.
  const result = gas.createTenantPaidExpense_(gas.__spreadsheet, {
    requestId: 'mini_1', groupId: 'grp_mini_1',
    tenant: 'Yolgon Ijarachi', period: '2026-08',
    amount: 500000, currency: 'UZS', method: 'Naqd',
    comment: 'Elektrik', createdBy: 'miniapp'
  });

  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /ro'yxatda yo'q/);
  assert.strictEqual(rowCount(gas), 0);
});

test('an edit cannot rewrite a real pair onto an invented tenant', () => {
  const gas = boot();
  const created = post(gas, payload({ tenant: 'Apteka', groupId: 'grp_edit_me' }));
  assert.strictEqual(created.status, 'success');

  const edited = post(gas, payload({
    tenant: 'Yolgon Ijarachi', groupId: 'grp_edit_me', replaceGroupId: 'grp_edit_me'
  }));

  assert.strictEqual(edited.status, 'error');
  assert.strictEqual(rowCount(gas), 2, 'the original pair is untouched');
  const tenants = gas.__spreadsheet.getSheetByName('Omad_Transactions')
    .getDataRange().getValues().slice(1).map(r => r[1]);
  assert.ok(tenants.indexOf('Yolgon Ijarachi') === -1, 'the invented name reached no row');
});

// --------------------------------------------------------- no config at all

test('with no tenants configured nothing can be credited', () => {
  const gas = loadScript({
    properties: { OMAD_ADMIN_KEY: ADMIN_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    sheets: {
      System_Config: [['Omad_Rates', JSON.stringify(RATES)]],
      Omad_Transactions: [LEGACY_HEADER]
    }
  });

  const response = post(gas, payload({ tenant: 'Apteka' }));
  assert.strictEqual(response.status, 'error',
    'an unverifiable name is refused rather than trusted');
});
