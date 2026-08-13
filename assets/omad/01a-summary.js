'use strict';

// ==========================================================
// Where a dashboard figure comes from
// ----------------------------------------------------------
// The screen used to be handed the whole transaction history and derive every
// figure from it in the browser. It now receives the server's materialised
// summary — the same arithmetic, computed once against the ledger's revision
// rather than once per person opening the page — and the history arrives a page
// at a time when Tarix is opened.
//
// Both paths stay live, and that is deliberate rather than transitional:
//
//   * Before the ledger cutover the server still sends the whole list, because
//     the legacy save submits it back. There is no summary in that answer.
//   * A snapshot restored from a previous session may predate this change.
//   * `02b-calc.js` is the mirror of `05a_calculations.gs`, held field-for-field
//     by `tests/calc-parity.e2e.js`. Keeping it as the fallback keeps that
//     comparison honest and keeps a second, independent check on the summary.
//
// So every accessor here answers from the summary when there is one and from
// the local calculation when there is not, and the two must agree.
// ==========================================================

/** True when this load carries the server's materialised figures. */
function hasServerSummary() {
    return !!(app.summary && app.summary.periods);
}

/** Every period the summary knows about, oldest first. */
function summaryPeriods() {
    if (!hasServerSummary()) return [];
    return Array.isArray(app.summary.periodList) ? app.summary.periodList : [];
}

/** One period's stored figures, or an empty set. */
function summaryEntry(period) {
    if (!hasServerSummary()) return null;
    return app.summary.periods[period] || null;
}

/**
 * Income, expense, net and the all-time cash/bank/total for a period.
 *
 * Income and expense are scoped; balances never are — money in the safe does
 * not reset when the reporting month changes. "Jami Davr" totals the periods,
 * which is what a pass over every row would have produced.
 */
function periodActuals(period) {
    if (!hasServerSummary()) return calculateActuals(countableTransactions(), period);

    const balances = app.summary.balances || {};
    let income = 0;
    let expense = 0;

    if (period === ALL_PERIODS) {
        summaryPeriods().forEach(name => {
            const entry = app.summary.periods[name] || {};
            income += Number(entry.income) || 0;
            expense += Number(entry.expense) || 0;
        });
    } else {
        const entry = summaryEntry(period) || {};
        income = Number(entry.income) || 0;
        expense = Number(entry.expense) || 0;
    }

    return roundMoneyFields({
        income,
        expense,
        net: income - expense,
        cash: Number(balances.cash) || 0,
        bank: Number(balances.bank) || 0,
        total: Number(balances.total) || 0
    });
}

/** What one tenant paid in a period, at the sell rate. */
function tenantPaidFor(tenantName, period) {
    if (!hasServerSummary()) return calculateTenantPaid(countableTransactions(), tenantName, period);

    const key = normalizeTenantName(tenantName);
    if (period === ALL_PERIODS) {
        return Math.round(summaryPeriods().reduce((sum, name) => {
            const paid = (app.summary.periods[name] || {}).paid || {};
            return sum + (Number(paid[key]) || 0);
        }, 0));
    }
    const paid = (summaryEntry(period) || {}).paid || {};
    return Math.round(Number(paid[key]) || 0);
}

/**
 * A tenant's position for a period. Negative `difference` is debt.
 *
 * The *expected* half is never summarised: it comes from the tenant's stored
 * effective-dated schedule, which the browser already holds in full, so there
 * is nothing to fetch and nothing that can drift.
 */
function tenantBalanceFor(tenant, period) {
    if (!hasServerSummary()) return calculateTenantBalance(countableTransactions(), tenant, period);
    const expected = tenantExpectedRentUZS(tenant, period);
    const paid = tenantPaidFor(tenant && tenant.name, period);
    return { expected, paid, difference: paid - expected };
}
