#!/usr/bin/env node
'use strict';

/**
 * What one screen costs to open.
 *
 *   node scripts/bench-reads.js [rows]
 *
 * Three numbers per request, because they are the three that decide how long an
 * Apps Script screen takes to appear:
 *
 *   * **sheet passes** — `getDataRange().getValues()` calls. Each one is a
 *     round trip to the Sheets backend and is the dominant cost by a wide
 *     margin; on a real project it dwarfs everything measured in milliseconds
 *     here.
 *   * **payload bytes** — what has to travel to the phone and be parsed there.
 *   * **ms** — arithmetic only, in Node, against a mocked spreadsheet. Useful
 *     for spotting an accidental O(n²), useless as an absolute.
 *
 * "cold" is the first request after a write, which rebuilds the read model.
 * "warm" is every request after that until the next write. The point of the
 * read model is that real use is almost entirely warm: nobody opens the
 * dashboard twice between two entries, but they do open it twice a day.
 */

const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require(
  path.join(__dirname, '..', 'tests', 'gas-harness.js'));
const crypto = require('crypto');

const ADMIN_KEY = 'bench-key';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';

const ROWS = Math.max(10, Number(process.argv[2]) || 400);

const LEGACY_HEADER = [
  'ID', 'Tenant', 'Month', 'Type', 'Amount', 'Currency', 'Method', 'Date', 'Comment',
  'Telegram_Msg_ID', 'Request_ID', 'Entry_Group_ID', 'Entry_Kind'
];

const TENANTS = [];
for (let i = 0; i < 16; i++) {
  TENANTS.push({ name: `Ijarachi_${i}`, defaultRent: 1000000 + i, currency: 'UZS', active: true });
}

/** Twenty-four months ending with the current one, oldest first. */
const PERIODS = (() => {
  const now = new Date();
  const list = [];
  for (let back = 23; back >= 0; back--) {
    const when = new Date(now.getFullYear(), now.getMonth() - back, 1);
    list.push(`${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`);
  }
  return list;
})();

/**
 * The period a row belongs to.
 *
 * Rows are laid out chronologically — row ids ascend with the calendar, as
 * they do in the real ledger — so "the newest entries" and "this month's
 * entries" are the same rows. A fixture that scattered periods across the ids
 * would make the recent list fall back to the ledger on every request and
 * measure something that never happens.
 */
function periodFor(index) {
  return PERIODS[Math.min(PERIODS.length - 1, Math.floor(index * PERIODS.length / ROWS))];
}

function rows() {
  const out = [];
  for (let i = 0; i < ROWS; i++) {
    out.push([
      `1750000${String(100000 + i)}_0`, TENANTS[i % TENANTS.length].name, periodFor(i),
      i % 5 === 0 ? 'Expense' : 'Income', 200000 + i, 'UZS', i % 2 ? 'Bank' : 'Naqd',
      '12/08/2026', 'bench', '', `req_${i}`, `grp_${i}`, ''
    ]);
  }
  return out;
}

function ratesMap() {
  const map = {};
  PERIODS.forEach((period, i) => { map[period] = { buy: 12000 + i, sell: 12500 + i }; });
  return map;
}

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_GROUP_CHAT_ID: '-1001234567890'
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(ratesMap())],
        ['Omad_Tenants', JSON.stringify(TENANTS)],
        ['Omad_Template_Expenses', '[]']
      ],
      Omad_Transactions: [LEGACY_HEADER].concat(rows())
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(Object.assign({ adminKey: ADMIN_KEY }, body))));
}

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_q',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Bench' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

/** Counts every whole-sheet pass while `run` executes, by sheet name. */
function measure(gas, label, run) {
  const counts = {};
  const restore = [];
  gas.__spreadsheet.getSheets().forEach(sheet => {
    const name = sheet.getName();
    const original = sheet.getDataRange;
    restore.push(() => { sheet.getDataRange = original; });
    sheet.getDataRange = function () {
      const range = original.call(sheet);
      const inner = range.getValues;
      range.getValues = function () {
        counts[name] = (counts[name] || 0) + 1;
        return inner.call(range);
      };
      return range;
    };
  });

  const started = process.hrtime.bigint();
  let body;
  try { body = run(); } finally { restore.forEach(fn => fn()); }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const ledger = (counts.Omad_Transactions_V2 || 0) + (counts.Omad_Transactions || 0);
  const total = Object.keys(counts).reduce((sum, key) => sum + counts[key], 0);
  return {
    label,
    ledgerPasses: ledger,
    sheetPasses: total,
    bytes: JSON.stringify(body || {}).length,
    ms: Math.round(ms * 100) / 100
  };
}

function report(title, results) {
  console.log(`\n${title}`);
  console.log('  ' + 'request'.padEnd(38) +
    'ledger'.padStart(8) + 'passes'.padStart(8) + 'bytes'.padStart(10) + 'ms'.padStart(9));
  results.forEach(r => {
    console.log('  ' + r.label.padEnd(38) +
      String(r.ledgerPasses).padStart(8) +
      String(r.sheetPasses).padStart(8) +
      String(r.bytes).padStart(10) +
      String(r.ms).padStart(9));
  });
}

const gas = boot();
post(gas, { action: 'apply_omad_migration', fallbackYear: 2026 });
post(gas, { action: 'cutover_omad_migration' });

const initData = signedInitData();
const results = [];

// The shape the dashboard used to ask for: the whole ledger, every load.
results.push(measure(gas, 'get_omad_data (whole ledger)',
  () => post(gas, { action: 'get_omad_data' })));

// The shape it asks for now. First one builds the model.
results.push(measure(gas, 'get_omad_data scope=dashboard (cold)',
  () => post(gas, { action: 'get_omad_data', scope: 'dashboard' })));
results.push(measure(gas, 'get_omad_data scope=dashboard (warm)',
  () => post(gas, { action: 'get_omad_data', scope: 'dashboard' })));

results.push(measure(gas, 'get_omad_history (one page of 40)',
  () => post(gas, { action: 'get_omad_history', limit: 40 })));

// The Mini App's first screen. The summary cache is emptied first so this
// measures the read model rather than the 60-second display cache on top of it.
Object.keys(gas.__cache || {}).forEach(key => { delete gas.__cache[key]; });
const thisMonth = gas.currentPeriod_();
results.push(measure(gas, 'mini_home this month (warm model)',
  () => readJsonOutput(gas.doPost(postEvent({ action: 'mini_home', initData, period: thisMonth })))));

// An old month is the one case the stored recent list cannot answer from its
// window, so it costs a ledger pass. The figures still come from the model.
Object.keys(gas.__cache || {}).forEach(key => { delete gas.__cache[key]; });
results.push(measure(gas, 'mini_home an old month (recent falls back)',
  () => readJsonOutput(gas.doPost(postEvent({ action: 'mini_home', initData, period: periodFor(0) })))));

// ...and what an entry costs the next reader.
post(gas, {
  action: 'create_transaction', requestId: `bench_${Date.now()}`, period: periodFor(0),
  tenant: TENANTS[0].name, type: 'Income', amount: 100000, currency: 'UZS', method: 'Naqd'
});
results.push(measure(gas, 'get_omad_data scope=dashboard (after a write)',
  () => post(gas, { action: 'get_omad_data', scope: 'dashboard' })));

report(`Omad reads over a ${ROWS}-row ledger`, results);

const wholeLedger = results[0];
const warm = results[2];
console.log(`\n  Opening the dashboard: ${wholeLedger.ledgerPasses} ledger pass(es) and ` +
  `${wholeLedger.bytes} bytes before, ${warm.ledgerPasses} and ${warm.bytes} after ` +
  `(${Math.round((1 - warm.bytes / Math.max(1, wholeLedger.bytes)) * 100)}% less to send).\n`);
