// ============================================================
// Shared money calculations
// ------------------------------------------------------------
// One implementation of every monetary rule, mirrored by
// assets/omad/02b-calc.js. The two must agree, so the rules are stated once,
// here, and both sides are tested against the same expectations.
//
// THE RATE RULE
// -------------
// Every UZS figure the business acts on - income, expenses, cash, bank, total
// balance, tenant payments, tenant debt, reports - uses the **sell** rate.
//
// Projections use the sell rate too. Mixing buy for expected income with sell
// for actual income made debt figures wrong by the spread: a tenant who paid
// exactly their rent could still show a balance. The buy rate is recorded on
// every transaction for history and is never used in a calculation.
// ============================================================

var RATE_TYPE_ACTUAL = "sell";
var RATE_TYPE_PROJECTION = "sell";

/**
 * The UZS value of one transaction.
 *
 * A ledger row carries the value frozen at write time, so editing a rate later
 * cannot move it. Legacy rows have no frozen value and are converted live -
 * which is exactly the drift the ledger removes.
 */
function transactionUZS_(transaction, rates) {
  var t = transaction || {};
  if (t.amountUZS !== undefined && t.amountUZS !== null && t.amountUZS !== "") {
    return Number(t.amountUZS) || 0;
  }
  return toUZS_(t.amount, t.currency, transactionPeriod_(t), rates || getOmadRates_(), RATE_TYPE_ACTUAL);
}

function signedTransactionUZS_(transaction, rates) {
  var value = transactionUZS_(transaction, rates);
  return transaction && transaction.type === "Expense" ? -value : value;
}

/** True when a transaction should be counted. Cancelled and corrected are not. */
function isCountableTransaction_(transaction) {
  var status = (transaction && transaction.status) || TX_STATUS_ACTIVE;
  return status === TX_STATUS_ACTIVE;
}

/**
 * Income, expense, net, and the cash/bank/total balances.
 *
 * `period` scopes income/expense/net. Balances are always all-time: money in
 * the safe does not reset when you change the reporting month.
 */
function calculateActuals_(transactions, period) {
  var rates = getOmadRates_();
  var result = { income: 0, expense: 0, net: 0, cash: 0, bank: 0, total: 0 };
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;

    var value = transactionUZS_(t, rates);
    var signed = t.type === "Expense" ? -value : value;

    if (t.method === "Bank") result.bank += signed; else result.cash += signed;

    if (!period || period === ALL_PERIODS_LABEL || transactionPeriod_(t) === period) {
      if (t.type === "Expense") result.expense += value; else result.income += value;
    }
  }

  result.net = result.income - result.expense;
  result.total = result.cash + result.bank;

  return roundMoneyFields_(result);
}

function roundMoneyFields_(values) {
  var rounded = {};
  Object.keys(values).forEach(function (key) { rounded[key] = Math.round(values[key]); });
  return rounded;
}

/** What a tenant actually paid in a period, at the sell rate. */
function calculateTenantPaid_(transactions, tenantName, period) {
  var rates = getOmadRates_();
  var key = String(tenantName || "").trim();
  var total = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    if (t.type !== "Income") continue;
    if (String(t.tenant || "").trim() !== key) continue;
    if (period && period !== ALL_PERIODS_LABEL && transactionPeriod_(t) !== period) continue;
    total += transactionUZS_(t, rates);
  }
  return Math.round(total);
}

/**
 * What every tenant paid in a period, from one pass over the ledger.
 *
 * `calculateTenantPaid_` walks the whole ledger to answer for one tenant, so
 * asking about sixteen tenants walked it sixteen times. The filter is per
 * tenant but the pass is not, so the pass is done once and the results are
 * bucketed by name. Same rules, same rounding, same answer -- see the test
 * that asserts the two agree tenant by tenant.
 *
 * Keys are the trimmed tenant name, exactly as `calculateTenantPaid_` matches.
 */
function tenantPaidTotals_(transactions, period) {
  var rates = getOmadRates_();
  var totals = {};
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    if (t.type !== "Income") continue;
    if (period && period !== ALL_PERIODS_LABEL && transactionPeriod_(t) !== period) continue;
    var key = String(t.tenant || "").trim();
    totals[key] = (totals[key] || 0) + transactionUZS_(t, rates);
  }

  Object.keys(totals).forEach(function (key) { totals[key] = Math.round(totals[key]); });
  return totals;
}

/**
 * The rent expected from a tenant in a period, at the sell rate.
 * The amount comes from the tenant's effective-dated schedule, so a month with
 * an exception, a no-rent month, or a month outside the agreement all resolve
 * correctly - and a historical month keeps the rent that applied then.
 */
function tenantExpectedRentUZS_(tenant, period) {
  var t = tenant || {};
  var rent = effectiveTenantRent_(t, period);
  if (rent <= 0) return 0;
  return Math.round(toUZS_(rent, t.currency, period, getOmadRates_(), RATE_TYPE_PROJECTION));
}

/**
 * A tenant's position for a period.
 * Negative `difference` is debt; positive is an overpayment.
 *
 * `paidTotals` is optional: pass the map from `tenantPaidTotals_` when asking
 * about several tenants over the same rows, and the ledger is walked once for
 * all of them instead of once each. Omit it and the single-tenant path runs,
 * which is what every existing caller does.
 */
function calculateTenantBalance_(transactions, tenant, period, paidTotals) {
  var expected = tenantExpectedRentUZS_(tenant, period);
  var name = String((tenant && tenant.name) || "").trim();
  var paid = paidTotals
    ? (paidTotals[name] || 0)
    : calculateTenantPaid_(transactions, tenant && tenant.name, period);
  return { expected: expected, paid: paid, difference: paid - expected };
}

/**
 * Expected income and planned expenses for a period.
 *
 * Projections are a plan, not money that moved: a planned expense is never
 * counted as paid. Compare it with `calculateActuals_` rather than adding the
 * two together - see `comparePlanToActual_`.
 */
function calculateProjection_(tenants, plannedExpenses, period) {
  var rates = getOmadRates_();
  var expectedIncome = 0;
  var plannedExpense = 0;

  var tenantList = Array.isArray(tenants) ? tenants : [];
  for (var i = 0; i < tenantList.length; i++) {
    expectedIncome += tenantExpectedRentUZS_(tenantList[i], period);
  }


  // Recurrence decides which expenses fall due, not a stored month. Callers
  // may pass raw records, so they are normalised here.
  var due = plannedExpensesForPeriod_(normalizeTemplateExpenses_(plannedExpenses), period);
  for (var j = 0; j < due.length; j++) {
    plannedExpense += toUZS_(due[j].expense.amount, due[j].expense.currency, period, rates, RATE_TYPE_PROJECTION);
  }

  return roundMoneyFields_({
    expectedIncome: expectedIncome,
    plannedExpense: plannedExpense,
    net: expectedIncome - plannedExpense
  });
}

/**
 * Plan against reality for one period, side by side.
 *
 * `plannedExpense` is what was scheduled; `actualExpense` is what actually
 * left. They are deliberately never summed: a planned expense that has been
 * paid appears in both, and adding them would double-count it. `outstanding`
 * is what is still expected to leave, floored at zero.
 */
function comparePlanToActual_(transactions, tenants, plannedExpenses, period) {
  var projection = calculateProjection_(tenants, plannedExpenses, period);
  var actuals = calculateActuals_(transactions, period);

  return {
    period: period,
    expectedIncome: projection.expectedIncome,
    actualIncome: actuals.income,
    plannedExpense: projection.plannedExpense,
    actualExpense: actuals.expense,
    // What is still expected, not a total.
    outstandingIncome: Math.max(0, projection.expectedIncome - actuals.income),
    outstandingExpense: Math.max(0, projection.plannedExpense - actuals.expense),
    projectedNet: projection.net,
    actualNet: actuals.net
  };
}
