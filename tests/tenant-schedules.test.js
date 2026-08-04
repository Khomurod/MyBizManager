'use strict';

/**
 * Effective-dated tenant rent schedules.
 *
 * The old model was a single rent plus month-name switches, so a rent change
 * rewrote history and a "disabled" December repeated every year. These tests
 * pin the replacement, including the scenarios from the brief:
 *
 *   $500 January–November 2026, $200 in December 2026,
 *   no rent in one selected month, a new default from January 2027,
 *   and an agreement that ends after a chosen period.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const plain = value => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const RATES = {
  '2026-01': { buy: 12000, sell: 12500 },
  '2026-11': { buy: 12700, sell: 12900 },
  '2026-12': { buy: 12800, sell: 13000 },
  '2027-01': { buy: 13000, sell: 13500 }
};

function boot() {
  return loadScript({ sheets: { System_Config: [['Omad_Rates', JSON.stringify(RATES)]] } });
}

/** The brief's headline tenant. */
function scheduledTenant(overrides = {}) {
  return {
    name: 'Tehnopark',
    defaultRent: 500,
    currency: 'USD',
    active: true,
    startPeriod: '2026-01',
    endPeriod: '',
    exceptions: [{ period: '2026-12', amount: 200 }],
    noRentPeriods: [],
    rentChanges: [{ fromPeriod: '2027-01', amount: 600 }],
    ...overrides
  };
}

function rent(gas, tenant, period) {
  return gas.effectiveTenantRent_(gas.normalizeTenantList_([tenant])[0], period);
}

function source(gas, tenant, period) {
  return gas.tenantRentSource_(gas.normalizeTenantList_([tenant])[0], period);
}

// -------------------------------------------------------- the brief's cases

test('$500 applies from January through November 2026', () => {
  const gas = boot();
  const tenant = scheduledTenant();
  for (let month = 1; month <= 11; month++) {
    const period = `2026-${String(month).padStart(2, '0')}`;
    assert.strictEqual(rent(gas, tenant, period), 500, period);
    assert.strictEqual(source(gas, tenant, period), 'default', period);
  }
});

test('$200 applies in December 2026 only', () => {
  const gas = boot();
  const tenant = scheduledTenant();
  assert.strictEqual(rent(gas, tenant, '2026-12'), 200);
  assert.strictEqual(source(gas, tenant, '2026-12'), 'exception');
  assert.strictEqual(rent(gas, tenant, '2026-11'), 500, 'November is untouched');
});

test('a no-rent month owes nothing', () => {
  const gas = boot();
  const tenant = scheduledTenant({ noRentPeriods: ['2026-07'] });
  assert.strictEqual(rent(gas, tenant, '2026-07'), 0);
  assert.strictEqual(source(gas, tenant, '2026-07'), 'no_rent');
  assert.strictEqual(rent(gas, tenant, '2026-08'), 500);
});

test('a new default rent takes effect from January 2027', () => {
  const gas = boot();
  const tenant = scheduledTenant();
  assert.strictEqual(rent(gas, tenant, '2026-12'), 200, 'the exception still wins for December');
  assert.strictEqual(rent(gas, tenant, '2027-01'), 600);
  assert.strictEqual(rent(gas, tenant, '2027-06'), 600, 'and stays in force');
  assert.strictEqual(source(gas, tenant, '2027-01'), 'scheduled_change');
});

test('an agreement that ends owes nothing afterwards', () => {
  const gas = boot();
  const tenant = scheduledTenant({ endPeriod: '2026-06' });
  assert.strictEqual(rent(gas, tenant, '2026-06'), 500, 'the final month is included');
  assert.strictEqual(rent(gas, tenant, '2026-07'), 0);
  assert.strictEqual(source(gas, tenant, '2026-07'), 'after_end');
});

test('nothing is owed before the agreement starts', () => {
  const gas = boot();
  const tenant = scheduledTenant({ startPeriod: '2026-03' });
  assert.strictEqual(rent(gas, tenant, '2026-02'), 0);
  assert.strictEqual(source(gas, tenant, '2026-02'), 'before_start');
  assert.strictEqual(rent(gas, tenant, '2026-03'), 500);
});

// ------------------------------------------------------------- resolution

test('resolution order: no-rent beats exception beats change beats default', () => {
  const gas = boot();
  const tenant = scheduledTenant({
    exceptions: [{ period: '2027-03', amount: 999 }],
    noRentPeriods: ['2027-03'],
    rentChanges: [{ fromPeriod: '2027-01', amount: 600 }]
  });

  assert.strictEqual(rent(gas, tenant, '2027-03'), 0, 'no-rent wins');
  assert.strictEqual(rent(gas, tenant, '2027-02'), 600, 'the change wins over the default');
});

test('the latest applicable change wins', () => {
  const gas = boot();
  const tenant = scheduledTenant({
    rentChanges: [
      { fromPeriod: '2027-01', amount: 600 },
      { fromPeriod: '2027-06', amount: 700 },
      { fromPeriod: '2028-01', amount: 800 }
    ]
  });

  assert.strictEqual(rent(gas, tenant, '2026-05'), 500);
  assert.strictEqual(rent(gas, tenant, '2027-05'), 600);
  assert.strictEqual(rent(gas, tenant, '2027-06'), 700);
  assert.strictEqual(rent(gas, tenant, '2029-01'), 800);
});

test('an inactive tenant is owed nothing, and reactivating restores the schedule', () => {
  const gas = boot();
  assert.strictEqual(rent(gas, scheduledTenant({ active: false }), '2026-05'), 0);
  assert.strictEqual(rent(gas, scheduledTenant({ active: true }), '2026-05'), 500);
});

test('changes and exceptions are de-duplicated and sorted', () => {
  const gas = boot();
  const normalized = gas.normalizeTenantList_([scheduledTenant({
    rentChanges: [
      { fromPeriod: '2027-06', amount: 700 },
      { fromPeriod: '2027-01', amount: 600 },
      { fromPeriod: '2027-01', amount: 650 },
      { fromPeriod: 'Yanvar', amount: 1 },
      { fromPeriod: '2027-02', amount: -5 }
    ],
    exceptions: [{ period: '2026-12', amount: 200 }, { period: '2026-12', amount: 250 }]
  })])[0];

  assert.deepStrictEqual(plain(normalized.rentChanges), [
    { fromPeriod: '2027-01', amount: 650 },
    { fromPeriod: '2027-06', amount: 700 }
  ]);
  assert.deepStrictEqual(plain(normalized.exceptions), [{ period: '2026-12', amount: 250 }]);
});

test('the yearly schedule shows every month with its reason', () => {
  const gas = boot();
  const schedule = gas.tenantScheduleForYear_(gas.normalizeTenantList_([scheduledTenant()])[0], 2026);

  assert.strictEqual(schedule.length, 12);
  assert.strictEqual(schedule[0].label, 'Yanvar 2026');
  assert.strictEqual(schedule[11].rent, 200);
  assert.strictEqual(schedule[11].source, 'exception');
});

// ------------------------------------------------------------ compatibility

test('a legacy tenant with only a rent keeps working', () => {
  const gas = boot();
  const tenant = { name: 'Bunyodbek', rent: 400, currency: 'USD', disabledMonths: [] };

  assert.strictEqual(rent(gas, tenant, '2026-05'), 400);
  assert.strictEqual(rent(gas, tenant, '2029-05'), 400, 'no start or end means always');
});

test('legacy disabled months are still honoured, and still repeat yearly', () => {
  const gas = boot();
  const tenant = { name: 'Bunyodbek', rent: 400, currency: 'USD', disabledMonths: ['Dekabr'] };

  assert.strictEqual(rent(gas, tenant, '2026-12'), 0);
  assert.strictEqual(rent(gas, tenant, '2027-12'), 0, 'which is exactly why schedules replace them');
  assert.strictEqual(rent(gas, tenant, '2026-11'), 400);
  assert.strictEqual(source(gas, tenant, '2026-12'), 'disabled_month');
});

test('normalizing keeps `rent` in step with `defaultRent` for older readers', () => {
  const gas = boot();
  const normalized = gas.normalizeTenantList_([{ name: 'X', defaultRent: 750, currency: 'USD' }])[0];
  assert.strictEqual(normalized.rent, 750);
  assert.strictEqual(normalized.defaultRent, 750);
});

test('merging tenants keeps schedule fields', () => {
  const gas = boot();
  const merged = gas.mergeTenantsByName_(
    gas.normalizeTenantList_([scheduledTenant()]),
    gas.normalizeTenantList_([scheduledTenant({ defaultRent: 550 })]));

  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].defaultRent, 550);
  assert.deepStrictEqual(plain(merged[0].exceptions), [{ period: '2026-12', amount: 200 }]);
});

test('the Telegram bot only offers tenants whose agreement has not ended', () => {
  const gas = loadScript({
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify(RATES)],
        ['Omad_Tenants', JSON.stringify([
          { name: 'Live', rent: 500, currency: 'USD' },
          { name: 'Ended', rent: 500, currency: 'USD', endPeriod: '2020-01' },
          { name: 'Inactive', rent: 500, currency: 'USD', active: false }
        ])]
      ]
    }
  });

  const names = gas.getActiveTenantNames_(gas.__spreadsheet.getSheetByName('System_Config'));
  assert.deepStrictEqual(plain(names), ['Live']);
});

// --------------------------------------------------------- debt calculation

test('debt uses the rent that applies in that very period', () => {
  const gas = boot();
  const tenant = gas.normalizeTenantList_([scheduledTenant()])[0];

  // December 2026: $200 at the December sell rate of 13 000.
  assert.strictEqual(gas.tenantExpectedRentUZS_(tenant, '2026-12'), 2600000);
  // November 2026: $500 at 12 900.
  assert.strictEqual(gas.tenantExpectedRentUZS_(tenant, '2026-11'), 6450000);
  // January 2027: $600 at 13 500.
  assert.strictEqual(gas.tenantExpectedRentUZS_(tenant, '2027-01'), 8100000);
});

test('a partial payment against an exception month shows the right shortfall', () => {
  const gas = boot();
  const tenant = gas.normalizeTenantList_([scheduledTenant()])[0];
  const transactions = [{
    tenant: 'Tehnopark', period: '2026-12', type: 'Income', status: 'Active',
    amount: 100, currency: 'USD', method: 'Naqd', amountUZS: 1300000
  }];

  const balance = gas.calculateTenantBalance_(transactions, tenant, '2026-12');
  assert.strictEqual(balance.expected, 2600000, '$200 at the December rate');
  assert.strictEqual(balance.paid, 1300000);
  assert.strictEqual(balance.difference, -1300000);
});

test('an overpayment in a no-rent month is all surplus', () => {
  const gas = boot();
  const tenant = gas.normalizeTenantList_([scheduledTenant({ noRentPeriods: ['2026-07'] })])[0];
  const transactions = [{
    tenant: 'Tehnopark', period: '2026-07', type: 'Income', status: 'Active',
    amount: 1000000, currency: 'UZS', method: 'Naqd', amountUZS: 1000000
  }];

  const balance = gas.calculateTenantBalance_(transactions, tenant, '2026-07');
  assert.strictEqual(balance.expected, 0);
  assert.strictEqual(balance.difference, 1000000);
});

test('a UZS tenant and a USD tenant are both handled', () => {
  const gas = boot();
  const uzs = gas.normalizeTenantList_([{ name: 'A', defaultRent: 6000000, currency: 'UZS' }])[0];
  const usd = gas.normalizeTenantList_([{ name: 'B', defaultRent: 500, currency: 'USD' }])[0];

  assert.strictEqual(gas.tenantExpectedRentUZS_(uzs, '2026-01'), 6000000);
  assert.strictEqual(gas.tenantExpectedRentUZS_(usd, '2026-01'), 6250000);
});

test('the projection sums only the rent actually due', () => {
  const gas = boot();
  const tenants = gas.normalizeTenantList_([
    scheduledTenant(),
    scheduledTenant({ name: 'Ended', endPeriod: '2026-06' }),
    scheduledTenant({ name: 'Inactive', active: false })
  ]);

  // Only the live tenant, at $200 for December 2026.
  assert.strictEqual(gas.calculateProjection_(tenants, [], '2026-12').expectedIncome, 2600000);
});

test('historical periods keep their own rent after a future change is added', () => {
  const gas = boot();
  const before = gas.normalizeTenantList_([scheduledTenant({ rentChanges: [] })])[0];
  const after = gas.normalizeTenantList_([scheduledTenant()])[0];

  assert.strictEqual(gas.effectiveTenantRent_(before, '2026-05'), 500);
  assert.strictEqual(gas.effectiveTenantRent_(after, '2026-05'), 500,
    'scheduling a 2027 change must not rewrite 2026');
});
