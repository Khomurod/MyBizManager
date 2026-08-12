'use strict';

/**
 * What a Mini App write does, and what it no longer does.
 *
 * Two costs used to sit between tapping Saqlash on a phone and seeing the
 * confirmation: a snapshot of the entire ledger copied into a cell before the
 * entry was even checked, and a Telegram round trip to send the group card.
 * Neither is part of storing the record.
 *
 * The snapshot exists to undo a rewrite, and the ledger is append-only, so
 * there is nothing there to undo. The card is queued and sent by a separate
 * request the client makes without waiting, which is asserted here rather than
 * assumed -- a queued report that never leaves the queue would be a silent
 * regression, since the numbers on screen would all still be right.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';
const ADMIN_KEY = 'mini-write-key';

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const TENANTS = [{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }];

function initData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_q',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

/** Telegram answers, so a message that is sent is observably sent. */
function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { message_id: 11 } })
    }),
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify(TENANTS)]
      ],
      Omad_Transactions: [LEGACY_HEADER]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

function mini(gas, action, payload = {}) {
  return post(gas, Object.assign({ action, initData: initData() }, payload));
}

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

/** On the append-only ledger, which is where production runs. */
function bootOnLedger() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { message_id: 11 } })
    }),
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', JSON.stringify(TENANTS)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER]
    }
  });
}

function backupRows(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Backups');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0]);
}

function pendingJobs(gas) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(r => r[0] && r[4] === 'Pending');
}

function tenantPaid(gas, overrides = {}) {
  return mini(gas, 'mini_tenant_paid', Object.assign({
    tenant: 'Apteka', period: '2026-08', amount: 500000,
    currency: 'UZS', method: 'Naqd', comment: 'Elektrik xizmati',
    requestId: 'mini_req_1', groupId: 'grp_mini_1'
  }, overrides));
}

// ------------------------------------------------------------- the snapshot

test('a tenant-paid pair on the ledger writes no whole-state snapshot', () => {
  const gas = bootOnLedger();
  const before = backupRows(gas).length;

  const saved = tenantPaid(gas);
  assert.strictEqual(saved.status, 'success', saved.message);

  assert.strictEqual(backupRows(gas).length, before,
    'the ledger is append-only, so there is no prior state to restore');
});

test('a refused tenant-paid writes nothing at all', () => {
  const gas = boot();   // legacy sheet, where the snapshot is still warranted
  const before = backupRows(gas).length;

  // An unknown tenant. The snapshot used to be written first, so a typo cost a
  // full copy of the ledger and then refused the entry anyway.
  const refused = tenantPaid(gas, { tenant: 'Yolgon_Ijarachi' });

  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(backupRows(gas).length, before,
    'nothing was stored, so nothing was backed up');
});

test('a tenant-paid pair on the legacy sheet still writes its snapshot', () => {
  const gas = boot();
  const before = backupRows(gas).length;

  assert.strictEqual(tenantPaid(gas).status, 'success');

  // The legacy sheet is genuinely rewritten in place. Dropping its snapshot is
  // not part of this change.
  assert.strictEqual(backupRows(gas).length, before + 1);
});

// ------------------------------------------------------------ the group card

test('the confirmation comes back without waiting for Telegram', () => {
  const gas = bootOnLedger();

  const saved = mini(gas, 'mini_save_transaction', {
    type: 'Income', tenant: 'Apteka', period: '2026-08', amount: 300000,
    currency: 'UZS', method: 'Naqd', comment: 'ijara',
    requestId: 'mini_req_2', groupId: 'grp_mini_2'
  });

  assert.strictEqual(saved.status, 'success');
  assert.deepStrictEqual(Array.from(gas.__sentMessages), [],
    'nothing was sent on the response path');
  assert.strictEqual(pendingJobs(gas).length, 1, 'the card is queued');
});

test('the flush the client sends afterwards is what delivers the card', () => {
  const gas = bootOnLedger();
  mini(gas, 'mini_save_transaction', {
    type: 'Income', tenant: 'Apteka', period: '2026-08', amount: 300000,
    currency: 'UZS', method: 'Naqd', comment: 'ijara',
    requestId: 'mini_req_3', groupId: 'grp_mini_3'
  });

  const flushed = mini(gas, 'mini_flush_reports');

  assert.strictEqual(flushed.status, 'success');
  assert.ok(gas.__sentMessages.length > 0, 'the card went out');
  assert.strictEqual(pendingJobs(gas).length, 0, 'and left the queue');
});

test('a queued card that is never flushed is still sent by the trigger', () => {
  const gas = bootOnLedger();
  mini(gas, 'mini_tenant_paid', {
    tenant: 'Apteka', period: '2026-08', amount: 500000,
    currency: 'UZS', method: 'Naqd', comment: 'Elektrik xizmati',
    requestId: 'mini_req_4', groupId: 'grp_mini_4'
  });

  // The flush is fire-and-forget, so it can be lost: the app closed, the
  // connection dropped. That must cost a delay and never a missing report.
  assert.strictEqual(pendingJobs(gas).length, 1);
  gas.processPendingTelegramJobs();

  assert.ok(gas.__sentMessages.length > 0);
  assert.strictEqual(pendingJobs(gas).length, 0);
});

test('the flush is behind the same signature as everything else', () => {
  const gas = bootOnLedger();
  mini(gas, 'mini_save_transaction', {
    type: 'Income', tenant: 'Apteka', period: '2026-08', amount: 300000,
    currency: 'UZS', method: 'Naqd', comment: 'ijara',
    requestId: 'mini_req_5', groupId: 'grp_mini_5'
  });

  const forged = post(gas, {
    action: 'mini_flush_reports',
    initData: `auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`
  });

  assert.strictEqual(forged.authorized, false);
  assert.strictEqual(pendingJobs(gas).length, 1, 'the queue was not touched');
});
