'use strict';

/**
 * A synthetic data set for the test Supabase project (mybizmanager-staging).
 *
 * Built by the real import code (25_supabase_import.gs) from invented sheets,
 * through the test harness's in-memory database, so the rows are exactly what
 * the live project's tables hold after a move -- the same columns, the same
 * encodings -- and none of them is real: the tenants, amounts and rates below
 * are made up.
 *
 *   const { stagingTables } = require('./staging-seed');
 *   stagingTables()  ->  { system_config: [...], omad_transactions_v2: [...], ... }
 *
 * Every table is returned, empty ones included; `seq` is left to the database.
 */

const path = require('path');
const { loadScript } = require(path.join(__dirname, '..', 'tests', 'gas-harness'));

const LEDGER_HEADER = [
  'ID', 'Request_ID', 'Created_At', 'Updated_At', 'Created_By', 'Source', 'Period',
  'Tenant', 'Type', 'Amount', 'Currency', 'Rate_Buy', 'Rate_Sell', 'Rate_Used',
  'Rate_Type', 'Amount_UZS', 'Method', 'Comment', 'Status', 'Related_ID',
  'Telegram_Msg_ID', 'Schema_Version', 'Entry_Group_ID', 'Entry_Kind'
];

/** Invented tenants. */
const TENANTS = [
  { name: "Do'kon A", defaultRent: 400, currency: 'USD', active: true },
  { name: 'Ofis B', defaultRent: 3000000, currency: 'UZS', active: true },
  { name: 'Ombor C', defaultRent: 250, currency: 'USD', active: true }
];

/** The last four months up to `now`, as YYYY-MM. */
function recentPeriods(now) {
  const out = [];
  for (let back = 3; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function stagingSheets(now) {
  const periods = recentPeriods(now);
  const rates = {};
  periods.forEach((period, i) => { rates[period] = { buy: 12500 + i * 10, sell: 12600 + i * 10 }; });

  const rows = [LEDGER_HEADER];
  let n = 0;
  const add = (period, tenant, type, amount, currency, method, comment) => {
    const id = String(1786000000000 + n) + '_0';
    const rate = rates[period];
    const used = currency === 'USD' ? rate.sell : 1;
    rows.push([id, 'seed_' + n, period + '-05T09:00:00.000Z', '', 'staging', 'Web', period, tenant, type,
      amount, currency, rate.buy, rate.sell, used, currency === 'USD' ? 'sell' : 'none', amount * used,
      method, comment, 'Active', '', '', 2, 'grp_seed_' + n, '']);
    n++;
  };
  periods.forEach(period => {
    TENANTS.forEach(t => add(period, t.name, 'Income', t.defaultRent, t.currency, n % 3 === 0 ? 'Bank' : 'Naqd', 'ijara'));
    add(period, "Do'kon A", 'Expense', 450000, 'UZS', 'Naqd', 'elektr');
    add(period, 'Ofis B', 'Expense', 20, 'USD', 'Naqd', 'tozalash');
  });

  return {
    System_Config: [
      ['Omad_Rates', JSON.stringify(rates)],
      ['Omad_Tenants', JSON.stringify(TENANTS)],
      ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
    ],
    Omad_Transactions_V2: rows,
    Omad_Audit_Log: [['Timestamp', 'Event', 'Details'], [now.toISOString(), 'staging_seed', 'synthetic data']]
  };
}

/** Every table's rows, as the import wrote them, without `seq`. */
function stagingTables(now = new Date()) {
  const gas = loadScript({ storage: 'supabase', sheets: stagingSheets(now) });
  const rows = gas.__supabase.rows;
  const out = {};
  Object.keys(rows).forEach(table => {
    if (/^app_/.test(table)) return; // settings, the lease and the cache are set up separately
    out[table] = JSON.parse(JSON.stringify(rows[table])).map(row => {
      delete row.seq;
      return row;
    });
  });
  return out;
}

module.exports = { stagingTables, stagingSheets, TENANTS };

if (require.main === module) {
  const tables = stagingTables();
  Object.keys(tables).forEach(name => console.log(name + ': ' + tables[name].length));
}
