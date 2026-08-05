'use strict';

// ==========================================================
// Shared money calculations
// ----------------------------------------------------------
// Mirrors apps-script/05a_calculations.gs. Both sides are tested against the
// same expectations, so a figure on screen is the figure the server reports.
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
// ==========================================================

const RATE_TYPE_ACTUAL = 'sell';
const RATE_TYPE_PROJECTION = 'sell';

/**
 * The UZS value of one transaction.
 *
 * A ledger row carries the value frozen at write time, so editing a rate later
 * cannot move it. Legacy rows have no frozen value and are converted live.
 */
function transactionUZS(transaction) {
    const t = transaction || {};
    if (t.amountUZS !== undefined && t.amountUZS !== null && t.amountUZS !== '') {
        return Number(t.amountUZS) || 0;
    }
    return toUZS(t.amount, t.currency, recordPeriod(t), RATE_TYPE_ACTUAL);
}

/** Cancelled and corrected records are history, not money. */
function isCountableTransaction(transaction) {
    const status = (transaction && transaction.status) || 'Active';
    return status === 'Active';
}

function countableTransactions() {
    return (app.transactions || []).filter(isCountableTransaction);
}

/**
 * Income, expense, net, and the cash/bank/total balances.
 *
 * `period` scopes income/expense/net. Balances are always all-time: money in
 * the safe does not reset when you change the reporting month.
 */
function calculateActuals(transactions, period) {
    const result = { income: 0, expense: 0, net: 0, cash: 0, bank: 0, total: 0 };

    (transactions || []).filter(isCountableTransaction).forEach(t => {
        const value = transactionUZS(t);
        const signed = t.type === 'Expense' ? -value : value;

        if (t.method === 'Bank') result.bank += signed; else result.cash += signed;

        if (!period || period === ALL_PERIODS || recordPeriod(t) === period) {
            if (t.type === 'Expense') result.expense += value; else result.income += value;
        }
    });

    result.net = result.income - result.expense;
    result.total = result.cash + result.bank;
    return roundMoneyFields(result);
}

function roundMoneyFields(values) {
    const rounded = {};
    Object.keys(values).forEach(key => { rounded[key] = Math.round(values[key]); });
    return rounded;
}

/** What a tenant actually paid in a period, at the sell rate. */
function calculateTenantPaid(transactions, tenantName, period) {
    const key = normalizeTenantName(tenantName);

    return Math.round((transactions || [])
        .filter(isCountableTransaction)
        .filter(t => t.type === 'Income')
        .filter(t => normalizeTenantName(t.tenant) === key)
        .filter(t => !period || period === ALL_PERIODS || recordPeriod(t) === period)
        .reduce((sum, t) => sum + transactionUZS(t), 0));
}

/**
 * The rent expected from a tenant in a period, at the sell rate.
 *
 * The amount comes from the tenant's effective-dated schedule, so a month with
 * an exception, a no-rent month, or a month outside the agreement all resolve
 * correctly - and a historical month keeps the rent that applied then. Reading
 * `tenant.rent` directly ignored every one of those rules, which billed a
 * tenant their full default rent in a month they had been given a lower one.
 */
function tenantExpectedRentUZS(tenant, period) {
    const t = tenant || {};
    const rent = effectiveTenantRent(t, period);
    if (rent <= 0) return 0;
    return Math.round(toUZS(rent, t.currency, period, RATE_TYPE_PROJECTION));
}

/**
 * A tenant's position for a period.
 * Negative `difference` is debt; positive is an overpayment.
 */
function calculateTenantBalance(transactions, tenant, period) {
    const expected = tenantExpectedRentUZS(tenant, period);
    const paid = calculateTenantPaid(transactions, tenant && tenant.name, period);
    return { expected, paid, difference: paid - expected };
}

/**
 * Expected income and planned expenses for a period.
 *
 * Projections are a plan, not money that moved: a planned expense is never
 * counted as paid. Compare it with `calculateActuals` rather than adding the
 * two together.
 */
function calculateProjection(tenants, plannedExpenses, period) {
    // No disabled-month filter: the effective-dated schedule already returns 0
    // for a month a tenant owes nothing, and filtering as well made this
    // disagree with the backend for exceptions and no-rent periods.
    const expectedIncome = (tenants || [])
        .reduce((sum, tenant) => sum + tenantExpectedRentUZS(tenant, period), 0);

    // Recurrence decides which expenses fall due, not a stored month - matching
    // calculateProjection_. Filtering on the stored month alone dropped every
    // repeating expense from the projection.
    const plannedExpense = plannedExpensesForPeriod(
            (plannedExpenses || []).map(normalizeTemplateExpense), period)
        .reduce((sum, due) => sum + toUZS(due.expense.amount, due.expense.currency, period, RATE_TYPE_PROJECTION), 0);

    return roundMoneyFields({
        expectedIncome,
        plannedExpense,
        net: expectedIncome - plannedExpense
    });
}
