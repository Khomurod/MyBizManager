'use strict';

/**
 * Money calculations, and the historical-rate guarantee.
 *
 * The rule under test: every UZS figure the business acts on uses the **sell**
 * rate, projections included. Ledger rows carry the value frozen at write time,
 * so editing a rate later cannot move a historical figure.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const plain = value => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const RATES = {
  '2026-01': { buy: 12000, sell: 12500 },
  '2026-02': { buy: 12100, sell: 12600 },
  '2026-12': { buy: 12800, sell: 13000 },
  '2027-01': { buy: 13000, sell: 13500 }
};

function boot(rates = RATES) {
  return loadScript({ sheets: { System_Config: [['Omad_Rates', JSON.stringify(rates)]] } });
}

/** A ledger-shaped transaction with its rates frozen, as the ledger stores it. */
function frozen(overrides = {}) {
  const base = {
    id: 'x', period: '2026-01', tenant: 'Tehnopark', type: 'Income',
    amount: 1000000, currency: 'UZS', method: 'Naqd', status: 'Active',
    rateBuy: 12000, rateSell: 12500, rateUsed: 1, rateType: 'none',
    amountUZS: 1000000
  };
  return { ...base, ...overrides };
}

/** A legacy transaction: no frozen value, converted live. */
function legacy(overrides = {}) {
  return {
    id: 'x', period: '2026-01', tenant: 'Tehnopark', type: 'Income',
    amount: 1000000, currency: 'UZS', method: 'Naqd', ...overrides
  };
}

// ------------------------------------------------------- the historical rule

test('a ledger transaction uses the value frozen when it was written', () => {
  const gas = boot();
  const t = frozen({ currency: 'USD', amount: 100, rateUsed: 12500, rateType: 'sell', amountUZS: 1250000 });
  assert.strictEqual(gas.transactionUZS_(t), 1250000);
});

test('changing a rate afterwards does not move a stored transaction', () => {
  const gas = boot();
  const t = frozen({ currency: 'USD', amount: 100, rateUsed: 12500, rateType: 'sell', amountUZS: 1250000 });

  // The operator corrects January's rate months later.
  gas.setConfig(gas.__spreadsheet.getSheetByName('System_Config'), 'Omad_Rates',
    JSON.stringify({ ...RATES, '2026-01': { buy: 20000, sell: 21000 } }));

  assert.strictEqual(gas.transactionUZS_(t), 1250000, 'the recorded value is unchanged');
  // A future transaction in the same period does use the new rate.
  assert.strictEqual(gas.toUZS_(100, 'USD', '2026-01', gas.getOmadRates_(), 'sell'), 2100000);
});

test('a legacy row with no frozen value is converted live at the sell rate', () => {
  const gas = boot();
  assert.strictEqual(gas.transactionUZS_(legacy({ currency: 'USD', amount: 100 })), 1250000);
});

test('every transaction records both rates, even UZS ones', () => {
  const gas = loadScript({
    properties: {},
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [['ID']]
    }
  });

  const uzs = gas.createTransaction_(gas.__spreadsheet, {
    requestId: 'r1', period: '2026-02', tenant: 'Tehnopark', type: 'Income',
    amount: 5000, currency: 'UZS', method: 'Naqd'
  }).transaction;

  assert.strictEqual(uzs.rateBuy, 12100);
  assert.strictEqual(uzs.rateSell, 12600);
  assert.strictEqual(uzs.rateUsed, 1);
  assert.strictEqual(uzs.rateType, 'none');
  assert.strictEqual(uzs.amountUZS, 5000);
});

// ---------------------------------------------------------------- actuals

test('income, expense and net are scoped to the period', () => {
  const gas = boot();
  const actuals = gas.calculateActuals_([
    frozen({ period: '2026-01', amount: 1000000, amountUZS: 1000000 }),
    frozen({ period: '2026-01', type: 'Expense', amount: 400000, amountUZS: 400000 }),
    frozen({ period: '2027-01', amount: 9000000, amountUZS: 9000000 })
  ], '2026-01');

  assert.strictEqual(actuals.income, 1000000);
  assert.strictEqual(actuals.expense, 400000);
  assert.strictEqual(actuals.net, 600000);
});

test('cash, bank and total are all-time regardless of the selected period', () => {
  const gas = boot();
  const actuals = gas.calculateActuals_([
    frozen({ period: '2026-01', amount: 1000000, amountUZS: 1000000, method: 'Naqd' }),
    frozen({ period: '2027-01', amount: 2000000, amountUZS: 2000000, method: 'Bank' }),
    frozen({ period: '2027-01', type: 'Expense', amount: 500000, amountUZS: 500000, method: 'Naqd' })
  ], '2026-01');

  assert.strictEqual(actuals.cash, 500000);
  assert.strictEqual(actuals.bank, 2000000);
  assert.strictEqual(actuals.total, 2500000);
});

test('cancelled and corrected records are excluded from every figure', () => {
  const gas = boot();
  const actuals = gas.calculateActuals_([
    frozen({ amount: 1000000, amountUZS: 1000000 }),
    frozen({ amount: 5000000, amountUZS: 5000000, status: 'Cancelled' }),
    frozen({ amount: 7000000, amountUZS: 7000000, status: 'Corrected' })
  ], '2026-01');

  assert.strictEqual(actuals.income, 1000000);
  assert.strictEqual(actuals.total, 1000000);
});

test('the all-periods view sums every year', () => {
  const gas = boot();
  const actuals = gas.calculateActuals_([
    frozen({ period: '2026-01', amountUZS: 1000000 }),
    frozen({ period: '2027-01', amountUZS: 2000000 })
  ], gas.ALL_PERIODS_LABEL);

  assert.strictEqual(actuals.income, 3000000);
});

test('an empty ledger produces zeroes, not NaN', () => {
  const gas = boot();
  assert.deepStrictEqual(plain(gas.calculateActuals_([], '2026-01')),
    { income: 0, expense: 0, net: 0, cash: 0, bank: 0, total: 0 });
});

// ----------------------------------------------------------- tenant balance

test('tenant payments use the sell rate, matching the rent expectation', () => {
  const gas = boot();
  const tenant = { name: 'Tehnopark', rent: 500, currency: 'USD' };

  // 500 USD of rent, paid in full in USD.
  const transactions = [frozen({
    tenant: 'Tehnopark', currency: 'USD', amount: 500,
    rateUsed: 12500, rateType: 'sell', amountUZS: 6250000
  })];

  const balance = gas.calculateTenantBalance_(transactions, tenant, '2026-01');
  assert.strictEqual(balance.expected, 6250000);
  assert.strictEqual(balance.paid, 6250000);
  assert.strictEqual(balance.difference, 0,
    'paying exactly the rent must show zero, not the buy/sell spread');
});

test('a partial payment shows the shortfall', () => {
  const gas = boot();
  const tenant = { name: 'Tehnopark', rent: 500, currency: 'USD' };
  const transactions = [frozen({
    tenant: 'Tehnopark', currency: 'USD', amount: 300, rateUsed: 12500,
    rateType: 'sell', amountUZS: 3750000
  })];

  const balance = gas.calculateTenantBalance_(transactions, tenant, '2026-01');
  assert.strictEqual(balance.difference, -2500000);
});

test('an overpayment shows a positive difference', () => {
  const gas = boot();
  const tenant = { name: 'Tehnopark', rent: 500, currency: 'USD' };
  const transactions = [frozen({
    tenant: 'Tehnopark', currency: 'USD', amount: 600, rateUsed: 12500,
    rateType: 'sell', amountUZS: 7500000
  })];

  assert.strictEqual(gas.calculateTenantBalance_(transactions, tenant, '2026-01').difference, 1250000);
});

test('a tenant with no rent configured expects nothing', () => {
  const gas = boot();
  assert.strictEqual(gas.tenantExpectedRentUZS_({ name: 'X', rent: 0, currency: 'USD' }, '2026-01'), 0);
});

test('a UZS tenant is not converted', () => {
  const gas = boot();
  assert.strictEqual(gas.tenantExpectedRentUZS_({ rent: 6000000, currency: 'UZS' }, '2026-01'), 6000000);
});

test('the same rent costs more in a period with a higher rate', () => {
  const gas = boot();
  const tenant = { rent: 500, currency: 'USD' };
  assert.strictEqual(gas.tenantExpectedRentUZS_(tenant, '2026-01'), 6250000);
  assert.strictEqual(gas.tenantExpectedRentUZS_(tenant, '2027-01'), 6750000);
});

test("payments in one period do not count towards another period's debt", () => {
  const gas = boot();
  const tenant = { name: 'Tehnopark', rent: 500, currency: 'USD' };
  const transactions = [frozen({ tenant: 'Tehnopark', period: '2026-01', amountUZS: 6250000 })];

  assert.strictEqual(gas.calculateTenantBalance_(transactions, tenant, '2026-01').difference, 0);
  assert.strictEqual(gas.calculateTenantBalance_(transactions, tenant, '2027-01').paid, 0);
});

test('a cancelled payment stops counting as paid', () => {
  const gas = boot();
  const tenant = { name: 'Tehnopark', rent: 500, currency: 'USD' };
  const transactions = [frozen({
    tenant: 'Tehnopark', amountUZS: 6250000, status: 'Cancelled'
  })];
  assert.strictEqual(gas.calculateTenantPaid_(transactions, 'Tehnopark', '2026-01'), 0);
});

test('expenses are never counted as tenant payments', () => {
  const gas = boot();
  const transactions = [frozen({ tenant: 'Tehnopark', type: 'Expense', amountUZS: 500000 })];
  assert.strictEqual(gas.calculateTenantPaid_(transactions, 'Tehnopark', '2026-01'), 0);
});

// -------------------------------------------------------------- projection

test('projections use the sell rate, the same as actuals', () => {
  const gas = boot();
  const projection = gas.calculateProjection_(
    [{ name: 'A', rent: 500, currency: 'USD' }, { name: 'B', rent: 1000000, currency: 'UZS' }],
    [{ period: '2026-01', amount: 200, currency: 'USD' }],
    '2026-01');

  // 500 USD at sell 12 500 = 6 250 000, plus 1 000 000 UZS.
  assert.strictEqual(projection.expectedIncome, 7250000);
  // 200 USD at sell 12 500 = 2 500 000.
  assert.strictEqual(projection.plannedExpense, 2500000);
  assert.strictEqual(projection.net, 4750000);
});

test('a planned expense in another period is excluded', () => {
  const gas = boot();
  const projection = gas.calculateProjection_([],
    [{ period: '2027-01', amount: 500000, currency: 'UZS' }], '2026-01');
  assert.strictEqual(projection.plannedExpense, 0);
});

test('projection and actual are separate figures, never summed', () => {
  const gas = boot();
  const projection = gas.calculateProjection_([{ name: 'A', rent: 1000000, currency: 'UZS' }], [], '2026-01');
  const actuals = gas.calculateActuals_([frozen({ tenant: 'A', amountUZS: 400000 })], '2026-01');

  // The tenant is expected to pay 1 000 000 and has paid 400 000. Neither
  // figure absorbs the other.
  assert.strictEqual(projection.expectedIncome, 1000000);
  assert.strictEqual(actuals.income, 400000);
});

// --------------------------------------------------------------- rounding

test('figures are rounded to whole UZS', () => {
  const gas = boot({ '2026-01': { buy: 12333, sell: 12777 } });
  const actuals = gas.calculateActuals_([legacy({ currency: 'USD', amount: 33.33 })], '2026-01');
  assert.strictEqual(actuals.income, Math.round(33.33 * 12777));
  assert.strictEqual(Number.isInteger(actuals.income), true);
});

test('a period with no configured rate falls back to the documented default', () => {
  const gas = boot({});
  assert.strictEqual(gas.transactionUZS_(legacy({ currency: 'USD', amount: 1 })), gas.DEFAULT_RATE_UZS);
  assert.strictEqual(gas.findRateEntry_({}, '2026-01'), null,
    'the absence of a rate is still reportable');
});

// ------------------------------------------------ the Telegram balance report

test('the Telegram balances use the frozen values', () => {
  const gas = boot();
  const balances = gas.calculateBalancesFromTransactions_([
    frozen({ period: '2026-01', currency: 'USD', amount: 100, rateUsed: 12500, amountUZS: 1250000 }),
    frozen({ period: '2026-01', type: 'Expense', amountUZS: 250000 }),
    frozen({ period: '2027-01', amountUZS: 3000000 }),
    frozen({ period: '2026-01', amountUZS: 9999999, status: 'Cancelled' })
  ], '2026-01');

  assert.strictEqual(balances.monthBalance, 1000000);
  assert.strictEqual(balances.allTimeBalance, 4000000);
});
