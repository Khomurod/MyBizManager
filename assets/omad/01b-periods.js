'use strict';

// ==========================================================
// Year-month periods
// ----------------------------------------------------------
// The canonical period is "YYYY-MM" ("2026-01"). Friendly Uzbek labels
// ("Yanvar 2026") are produced from it for display and never stored.
//
// This mirrors apps-script/01a_periods.gs. Both sides must agree, so the
// resolution rules are kept deliberately simple and identical.
// ==========================================================

const MONTH_LABELS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
                      "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];

const MONTH_SHORT_LABELS = ["Yan", "Fev", "Mar", "Apr", "May", "Iyn",
                            "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"];

const ALL_PERIODS = "Jami Davr";
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isPeriod(value) {
    return PERIOD_PATTERN.test(String(value || ""));
}

function buildPeriod(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
    return `${y}-${String(m).padStart(2, '0')}`;
}

function periodYear(period) {
    return isPeriod(period) ? Number(String(period).slice(0, 4)) : 0;
}

/** 1-based month number. */
function periodMonth(period) {
    return isPeriod(period) ? Number(String(period).slice(5, 7)) : 0;
}

/** "2026-01" -> "Yanvar 2026". Non-periods (including "Jami Davr") pass through. */
function periodLabel(period) {
    if (!isPeriod(period)) return String(period || "");
    return `${MONTH_LABELS[periodMonth(period) - 1]} ${periodYear(period)}`;
}

/** "2026-01" -> "Yan 2026", for tight spaces. */
function periodShortLabel(period) {
    if (!isPeriod(period)) return String(period || "");
    return `${MONTH_SHORT_LABELS[periodMonth(period) - 1]} ${periodYear(period)}`;
}

function currentPeriod() {
    const now = new Date();
    return buildPeriod(now.getFullYear(), now.getMonth() + 1);
}

function currentYear() {
    return new Date().getFullYear();
}

function addMonthsToPeriod(period, delta) {
    if (!isPeriod(period)) return "";
    const index = periodYear(period) * 12 + (periodMonth(period) - 1) + Number(delta || 0);
    return buildPeriod(Math.floor(index / 12), (index % 12) + 1);
}

/** Canonical periods sort correctly as plain strings. */
function comparePeriods(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function periodsInYear(year) {
    return MONTH_LABELS.map((_, index) => buildPeriod(year, index + 1));
}

/** "Yanvar" / "Yan" / "1" -> 1-based month number, or 0. */
function parseMonthName(value) {
    const text = String(value ?? "").trim();
    if (!text) return 0;
    const lower = text.toLowerCase();

    for (let i = 0; i < MONTH_LABELS.length; i++) {
        if (MONTH_LABELS[i].toLowerCase() === lower) return i + 1;
        if (MONTH_SHORT_LABELS[i].toLowerCase() === lower) return i + 1;
    }
    if (/^\d{1,2}$/.test(text)) {
        const numeric = Number(text);
        if (numeric >= 1 && numeric <= 12) return numeric;
    }
    return 0;
}

/**
 * The period a record belongs to. The backend resolves and attaches `period`
 * to every transaction it serves, so this is normally just a read; the month
 * fallback covers records held only in memory.
 */
function recordPeriod(record) {
    const r = record || {};
    if (isPeriod(r.period)) return r.period;
    if (isPeriod(r.month)) return r.month;
    // A legacy month name with no year cannot be placed on a timeline. Show it
    // as-is rather than inventing a year.
    return String(r.period || r.month || "");
}

/** True when a record belongs to the selected period, or the selection is "all". */
function matchesPeriod(record, selected) {
    if (selected === ALL_PERIODS) return true;
    return recordPeriod(record) === selected;
}

/**
 * Every period the UI should offer: the whole of every year that has data, the
 * current year, and the next year so future rent and expenses can be planned.
 */
function availablePeriods() {
    const years = new Set([currentYear(), currentYear() + 1]);

    const collect = value => {
        const period = isPeriod(value) ? value : "";
        if (period) years.add(periodYear(period));
    };
    // Since the dashboard stopped downloading the ledger, the set of periods
    // that has data comes from the server's summary. `app.transactions` is
    // whatever page of history is loaded, and is still collected so a
    // pre-cutover load — which carries the whole list and no summary — offers
    // exactly the same years it always did.
    summaryPeriods().forEach(collect);
    (app.transactions || []).forEach(t => collect(recordPeriod(t)));
    (app.templateExpenses || []).forEach(e => collect(recordPeriod(e)));
    Object.keys(app.rates || {}).forEach(collect);

    return [...years].sort((a, b) => a - b).flatMap(periodsInYear);
}

/** Years offered by the year selectors, oldest first. */
function availableYears() {
    return [...new Set(availablePeriods().map(periodYear))].sort((a, b) => a - b);
}

/** `<option>` markup for a period selector. */
function periodOptions(selected, { includeAll = false } = {}) {
    const options = includeAll
        ? [`<option value="${ALL_PERIODS}"${selected === ALL_PERIODS ? ' selected' : ''}>${ALL_PERIODS}</option>`]
        : [];

    availablePeriods().forEach(period => {
        options.push(
            `<option value="${period}"${period === selected ? ' selected' : ''}>${periodLabel(period)}</option>`
        );
    });
    return options.join('');
}
