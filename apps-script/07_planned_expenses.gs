// ============================================================
// Planned expenses
// ------------------------------------------------------------
// A planned expense is a *plan*: it says money is expected to leave in given
// periods. It is never money that moved. Nothing here is ever counted as paid
// - only a real expense transaction is - so projected and actual figures are
// reported side by side and never summed.
//
// Frequencies: once, monthly, every 2/3/6/12 months, selected months of the
// year, or a custom interval.
// Ending rules: never, until a period, or after a number of occurrences.
//
// Legacy `{ id, month, name, amount, currency }` records are read as one-time
// expenses in that month, so nothing needs migrating.
// ============================================================

var EXPENSE_FREQ_ONCE = "once";
var EXPENSE_FREQ_MONTHLY = "monthly";
var EXPENSE_FREQ_SELECTED = "selected_months";
var EXPENSE_FREQ_CUSTOM = "custom_interval";

/** Frequency -> the interval in months. 0 means "not interval-based". */
var EXPENSE_FREQUENCY_INTERVALS = {
  once: 0,
  monthly: 1,
  every_2_months: 2,
  every_3_months: 3,
  every_6_months: 6,
  every_12_months: 12,
  selected_months: 0,
  custom_interval: 0
};

var EXPENSE_END_NEVER = "never";
var EXPENSE_END_UNTIL = "until_period";
var EXPENSE_END_COUNT = "after_occurrences";

/** A generous bound so a malformed record can never loop forever. */
var EXPENSE_MAX_LOOKBACK_MONTHS = 1200;

function normalizeTemplateExpenses_(expenses) {
  var source = Array.isArray(expenses) ? expenses : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = normalizePlannedExpense_(source[i], i);
    if (item) normalized.push(item);
  }
  return normalized;
}

function normalizePlannedExpense_(rawExpense, index) {
  var expense = rawExpense && typeof rawExpense === "object" ? rawExpense : {};
  var name = String(expense.name || "").trim();
  if (!name) return null;

  // Legacy records carry `month` and nothing else; they are one-time expenses.
  var startPeriod = isCanonicalPeriod_(expense.startPeriod) ? expense.startPeriod
    : (isCanonicalPeriod_(expense.month) ? expense.month
    : (isCanonicalPeriod_(expense.period) ? expense.period : ""));

  var frequency = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] !== undefined
    ? expense.frequency
    : EXPENSE_FREQ_ONCE;

  var intervalMonths = Math.floor(Number(expense.intervalMonths) || 0);
  if (frequency === EXPENSE_FREQ_CUSTOM && (intervalMonths < 1 || intervalMonths > 120)) {
    // An unusable custom interval degrades to monthly rather than vanishing.
    frequency = EXPENSE_FREQ_MONTHLY;
    intervalMonths = 0;
  }

  return {
    id: String(expense.id || (new Date().getTime() + "_" + index)),
    name: name,
    amount: Number(expense.amount) || 0,
    currency: expense.currency === "USD" ? "USD" : "UZS",
    startPeriod: startPeriod,
    // `month` mirrors the start so older readers keep working.
    month: startPeriod,
    frequency: frequency,
    intervalMonths: frequency === EXPENSE_FREQ_CUSTOM ? intervalMonths : 0,
    selectedMonths: normalizeSelectedMonths_(expense.selectedMonths),
    ending: normalizeExpenseEnding_(expense.ending),
    active: expense.active === undefined ? true : expense.active !== false,
    description: String(expense.description || "").slice(0, 500)
  };
}

function normalizeSelectedMonths_(months) {
  var source = Array.isArray(months) ? months : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    var month = Math.floor(Number(source[i]));
    if (month >= 1 && month <= 12) seen[month] = true;
  }
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
}

function normalizeExpenseEnding_(ending) {
  var value = ending && typeof ending === "object" ? ending : {};

  if (value.type === EXPENSE_END_UNTIL && isCanonicalPeriod_(value.untilPeriod)) {
    return { type: EXPENSE_END_UNTIL, untilPeriod: value.untilPeriod, occurrences: 0 };
  }
  if (value.type === EXPENSE_END_COUNT) {
    var occurrences = Math.floor(Number(value.occurrences) || 0);
    if (occurrences >= 1) return { type: EXPENSE_END_COUNT, untilPeriod: "", occurrences: occurrences };
  }
  return { type: EXPENSE_END_NEVER, untilPeriod: "", occurrences: 0 };
}

/** Whole months between two canonical periods; negative when `to` precedes `from`. */
function monthsBetweenPeriods_(fromPeriod, toPeriod) {
  return (periodYear_(toPeriod) * 12 + periodMonth_(toPeriod)) -
         (periodYear_(fromPeriod) * 12 + periodMonth_(fromPeriod));
}

/** True when the frequency alone puts an occurrence in this period. */
function matchesExpenseFrequency_(expense, period) {
  var offset = monthsBetweenPeriods_(expense.startPeriod, period);
  if (offset < 0) return false;

  if (expense.frequency === EXPENSE_FREQ_ONCE) return offset === 0;
  if (expense.frequency === EXPENSE_FREQ_SELECTED) {
    return expense.selectedMonths.indexOf(periodMonth_(period)) !== -1;
  }
  if (expense.frequency === EXPENSE_FREQ_CUSTOM) {
    return expense.intervalMonths > 0 && offset % expense.intervalMonths === 0;
  }

  var interval = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] || 1;
  return offset % interval === 0;
}

/**
 * The 1-based occurrence number for a period, or 0 when the expense does not
 * fall due then. Needed by the "end after N occurrences" rule, and useful in
 * the UI ("3 of 12").
 */
function plannedExpenseOccurrence_(expense, period) {
  var e = expense || {};
  if (e.active === false) return 0;
  if (!isCanonicalPeriod_(period) || !isCanonicalPeriod_(e.startPeriod)) return 0;
  if (!matchesExpenseFrequency_(e, period)) return 0;

  var ending = e.ending || { type: EXPENSE_END_NEVER };
  if (ending.type === EXPENSE_END_UNTIL && comparePeriods_(period, ending.untilPeriod) > 0) return 0;

  var offset = monthsBetweenPeriods_(e.startPeriod, period);
  if (offset > EXPENSE_MAX_LOOKBACK_MONTHS) return 0;

  // Count the occurrences from the start up to and including this period.
  var occurrence = 0;
  for (var step = 0; step <= offset; step++) {
    if (matchesExpenseFrequency_(e, addMonthsToPeriod_(e.startPeriod, step))) occurrence++;
  }

  if (ending.type === EXPENSE_END_COUNT && occurrence > ending.occurrences) return 0;
  return occurrence;
}

function plannedExpenseAppliesTo_(expense, period) {
  return plannedExpenseOccurrence_(expense, period) > 0;
}

/** Every planned expense that falls due in a period, with its occurrence number. */
function plannedExpensesForPeriod_(expenses, period) {
  var list = Array.isArray(expenses) ? expenses : [];
  var due = [];
  for (var i = 0; i < list.length; i++) {
    var occurrence = plannedExpenseOccurrence_(list[i], period);
    if (occurrence > 0) due.push({ expense: list[i], occurrence: occurrence });
  }
  return due;
}

/**
 * A human-readable summary of when an expense falls due. Kept here so both
 * sides describe a schedule identically.
 */
function describePlannedExpense_(expense) {
  var e = expense || {};
  var labels = {
    once: "Bir marta",
    monthly: "Har oy",
    every_2_months: "Har 2 oyda",
    every_3_months: "Har 3 oyda",
    every_6_months: "Har 6 oyda",
    every_12_months: "Har yili"
  };

  var frequency = labels[e.frequency];
  if (e.frequency === EXPENSE_FREQ_SELECTED) {
    var names = (e.selectedMonths || []).map(function (month) { return UZBEK_MONTHS_SHORT[month - 1]; });
    frequency = names.length ? names.join(", ") : "Oylar tanlanmagan";
  } else if (e.frequency === EXPENSE_FREQ_CUSTOM) {
    frequency = "Har " + e.intervalMonths + " oyda";
  }

  var rule = e.ending || {};
  var ending = "";
  if (rule.type === EXPENSE_END_UNTIL) ending = formatPeriodLabel_(rule.untilPeriod) + " gacha";
  else if (rule.type === EXPENSE_END_COUNT) ending = rule.occurrences + " marta";

  var parts = [formatPeriodLabel_(e.startPeriod) + " dan", frequency];
  if (ending) parts.push(ending);
  return parts.join(" • ");
}
