'use strict';

/**
 * Planned expenses: frequencies, ending rules, and the rule that a plan is
 * never money that moved.
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

function expense(overrides = {}) {
  return {
    id: 'e1', name: 'Soliq', amount: 1000000, currency: 'UZS',
    startPeriod: '2026-01', frequency: 'monthly',
    ending: { type: 'never' }, active: true, ...overrides
  };
}

/** The periods an expense falls due in, across a span of years. */
function dueIn(gas, raw, fromYear = 2026, toYear = 2028) {
  const normalized = gas.normalizeTemplateExpenses_([raw])[0];
  const due = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 1; month <= 12; month++) {
      const period = `${year}-${String(month).padStart(2, '0')}`;
      if (gas.plannedExpenseAppliesTo_(normalized, period)) due.push(period);
    }
  }
  return due;
}

// ------------------------------------------------------------- frequencies

test('a one-time expense falls due exactly once', () => {
  const gas = boot();
  assert.deepStrictEqual(dueIn(gas, expense({ frequency: 'once' })), ['2026-01']);
});

test('a monthly expense falls due every month', () => {
  const gas = boot();
  const due = dueIn(gas, expense({ frequency: 'monthly' }), 2026, 2026);
  assert.strictEqual(due.length, 12);
  assert.strictEqual(due[0], '2026-01');
  assert.strictEqual(due[11], '2026-12');
});

test('every 2, 3, 6 and 12 months step correctly across the year boundary', () => {
  const gas = boot();

  assert.deepStrictEqual(dueIn(gas, expense({ frequency: 'every_2_months' }), 2026, 2026),
    ['2026-01', '2026-03', '2026-05', '2026-07', '2026-09', '2026-11']);

  assert.deepStrictEqual(dueIn(gas, expense({ frequency: 'every_3_months' }), 2026, 2027),
    ['2026-01', '2026-04', '2026-07', '2026-10', '2027-01', '2027-04', '2027-07', '2027-10']);

  assert.deepStrictEqual(dueIn(gas, expense({ frequency: 'every_6_months' }), 2026, 2027),
    ['2026-01', '2026-07', '2027-01', '2027-07']);

  assert.deepStrictEqual(dueIn(gas, expense({ frequency: 'every_12_months' }), 2026, 2028),
    ['2026-01', '2027-01', '2028-01']);
});

test('an interval starting mid-year keeps its own rhythm', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ startPeriod: '2026-11', frequency: 'every_3_months' }), 2026, 2027),
    ['2026-11', '2027-02', '2027-05', '2027-08', '2027-11']);
});

test('selected months repeat every year from the start', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ frequency: 'selected_months', selectedMonths: [3, 9] }), 2026, 2027),
    ['2026-03', '2026-09', '2027-03', '2027-09']);
});

test('selected months before the start period are skipped', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ startPeriod: '2026-06', frequency: 'selected_months', selectedMonths: [3, 9] }), 2026, 2026),
    ['2026-09']);
});

test('a custom interval is honoured', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ frequency: 'custom_interval', intervalMonths: 4 }), 2026, 2026),
    ['2026-01', '2026-05', '2026-09']);
});

test('an unusable custom interval degrades to monthly rather than vanishing', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([
    expense({ frequency: 'custom_interval', intervalMonths: 0 })
  ])[0];
  assert.strictEqual(normalized.frequency, 'monthly');
  assert.strictEqual(normalized.intervalMonths, 0);
});

test('nothing falls due before the start period', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([expense({ startPeriod: '2026-06' })])[0];
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2026-05'), false);
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2026-06'), true);
});

test('an inactive expense never falls due', () => {
  const gas = boot();
  assert.deepStrictEqual(dueIn(gas, expense({ active: false })), []);
});

// ------------------------------------------------------------ ending rules

test('no ending rule means it runs forever', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([expense()])[0];
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2035-07'), true);
});

test('ending at a period stops it there', () => {
  const gas = boot();
  const due = dueIn(gas, expense({
    ending: { type: 'until_period', untilPeriod: '2026-11' }
  }), 2026, 2027);

  assert.strictEqual(due[due.length - 1], '2026-11');
  assert.strictEqual(due.length, 11);
});

test('ending after N occurrences stops after exactly N', () => {
  const gas = boot();
  const due = dueIn(gas, expense({
    frequency: 'every_3_months',
    ending: { type: 'after_occurrences', occurrences: 5 }
  }), 2026, 2028);

  assert.strictEqual(due.length, 5);
  assert.deepStrictEqual(due, ['2026-01', '2026-04', '2026-07', '2026-10', '2027-01']);
});

test('the occurrence number counts up correctly', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([expense({ frequency: 'every_3_months' })])[0];

  assert.strictEqual(gas.plannedExpenseOccurrence_(normalized, '2026-01'), 1);
  assert.strictEqual(gas.plannedExpenseOccurrence_(normalized, '2026-04'), 2);
  assert.strictEqual(gas.plannedExpenseOccurrence_(normalized, '2027-01'), 5);
  assert.strictEqual(gas.plannedExpenseOccurrence_(normalized, '2026-02'), 0, 'not a due month');
});

test('a malformed ending rule falls back to never', () => {
  const gas = boot();
  for (const ending of [null, {}, { type: 'until_period' }, { type: 'after_occurrences', occurrences: 0 }]) {
    const normalized = gas.normalizeTemplateExpenses_([expense({ ending })])[0];
    assert.strictEqual(normalized.ending.type, 'never', JSON.stringify(ending));
  }
});

// --------------------------------------------------------- the brief's cases

test('a monthly loan ending in November 2026', () => {
  const gas = boot();
  const due = dueIn(gas, expense({
    name: 'Kredit', frequency: 'monthly',
    ending: { type: 'until_period', untilPeriod: '2026-11' }
  }), 2026, 2027);

  assert.strictEqual(due.length, 11);
  assert.strictEqual(due[10], '2026-11');
});

test('quarterly taxes', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ name: 'Soliq', frequency: 'every_3_months' }), 2026, 2026),
    ['2026-01', '2026-04', '2026-07', '2026-10']);
});

test('an annual payment', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ name: 'Litsenziya', startPeriod: '2026-05', frequency: 'every_12_months' }), 2026, 2028),
    ['2026-05', '2027-05', '2028-05']);
});

test('a permanent monthly payment', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([expense({ name: 'Internet' })])[0];
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2040-01'), true);
});

test('a selected-month obligation', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ name: 'Sug\'urta', frequency: 'selected_months', selectedMonths: [4, 10] }), 2026, 2026),
    ['2026-04', '2026-10']);
});

test('a one-time expense', () => {
  const gas = boot();
  assert.deepStrictEqual(
    dueIn(gas, expense({ name: "Ta'mirlash", startPeriod: '2026-08', frequency: 'once' })),
    ['2026-08']);
});

// ------------------------------------------------------------- projections

test('the projection sums the expenses due in that period at the sell rate', () => {
  const gas = boot();
  const expenses = [
    expense({ id: 'a', name: 'Internet', amount: 500000, currency: 'UZS', frequency: 'monthly' }),
    expense({ id: 'b', name: 'Soliq', amount: 100, currency: 'USD', frequency: 'every_3_months' })
  ];

  // January 2026: both, with 100 USD at sell 12 500.
  assert.strictEqual(gas.calculateProjection_([], expenses, '2026-01').plannedExpense, 500000 + 1250000);
  // February 2026: only the monthly one.
  assert.strictEqual(gas.calculateProjection_([], expenses, '2026-02').plannedExpense, 500000);
});

test('a planned expense is never counted as paid', () => {
  const gas = boot();
  const expenses = [expense({ amount: 1000000, frequency: 'monthly' })];

  const actuals = gas.calculateActuals_([], '2026-01');
  assert.strictEqual(actuals.expense, 0, 'nothing has actually left');
  assert.strictEqual(gas.calculateProjection_([], expenses, '2026-01').plannedExpense, 1000000);
});

test('plan and actual are reported side by side, never summed', () => {
  const gas = boot();
  const expenses = [expense({ amount: 1000000, frequency: 'monthly' })];
  const transactions = [{
    period: '2026-01', type: 'Expense', status: 'Active', method: 'Naqd',
    amount: 400000, currency: 'UZS', amountUZS: 400000
  }];

  const comparison = gas.comparePlanToActual_(transactions, [], expenses, '2026-01');

  assert.strictEqual(comparison.plannedExpense, 1000000);
  assert.strictEqual(comparison.actualExpense, 400000);
  assert.strictEqual(comparison.outstandingExpense, 600000,
    'what is still expected, not 1 400 000');
});

test('paying more than planned leaves nothing outstanding rather than a negative', () => {
  const gas = boot();
  const expenses = [expense({ amount: 1000000, frequency: 'monthly' })];
  const transactions = [{
    period: '2026-01', type: 'Expense', status: 'Active', method: 'Naqd',
    amount: 1500000, currency: 'UZS', amountUZS: 1500000
  }];

  const comparison = gas.comparePlanToActual_(transactions, [], expenses, '2026-01');
  assert.strictEqual(comparison.outstandingExpense, 0);
  assert.strictEqual(comparison.actualExpense, 1500000);
});

// ------------------------------------------------------------ compatibility

test('a legacy template expense is read as a one-time expense in its month', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([
    { id: 'old', month: '2026-03', name: 'Soliq', amount: 500000, currency: 'UZS' }
  ])[0];

  assert.strictEqual(normalized.frequency, 'once');
  assert.strictEqual(normalized.startPeriod, '2026-03');
  assert.strictEqual(normalized.month, '2026-03', 'the legacy field stays in step');
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2026-03'), true);
  assert.strictEqual(gas.plannedExpenseAppliesTo_(normalized, '2026-04'), false);
});

test('an expense with no name is dropped', () => {
  const gas = boot();
  assert.deepStrictEqual(plain(gas.normalizeTemplateExpenses_([{ amount: 100 }])), []);
});

test('selected months are de-duplicated, sorted and range-checked', () => {
  const gas = boot();
  const normalized = gas.normalizeTemplateExpenses_([
    expense({ frequency: 'selected_months', selectedMonths: [9, 3, 3, 0, 13, 'x'] })
  ])[0];
  assert.deepStrictEqual(plain(normalized.selectedMonths), [3, 9]);
});

// -------------------------------------------------------------- description

test('the schedule is described in plain Uzbek', () => {
  const gas = boot();
  const describe = raw => gas.describePlannedExpense_(gas.normalizeTemplateExpenses_([raw])[0]);

  assert.strictEqual(describe(expense({ frequency: 'once' })), 'Yanvar 2026 dan • Bir marta');
  assert.strictEqual(
    describe(expense({ frequency: 'monthly', ending: { type: 'until_period', untilPeriod: '2026-11' } })),
    'Yanvar 2026 dan • Har oy • Noyabr 2026 gacha');
  assert.strictEqual(
    describe(expense({ frequency: 'every_3_months', ending: { type: 'after_occurrences', occurrences: 4 } })),
    'Yanvar 2026 dan • Har 3 oyda • 4 marta');
  assert.strictEqual(
    describe(expense({ frequency: 'selected_months', selectedMonths: [3, 9] })),
    'Yanvar 2026 dan • Mar, Sen');
  assert.strictEqual(
    describe(expense({ frequency: 'custom_interval', intervalMonths: 4 })),
    'Yanvar 2026 dan • Har 4 oyda');
});
