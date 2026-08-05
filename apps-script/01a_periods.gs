// ============================================================
// Year-month periods
// ------------------------------------------------------------
// The canonical period is "YYYY-MM" ("2026-01"). Month-only values such as
// "Yanvar" are legacy: two Januaries collide, and sorting is meaningless.
//
// Friendly Uzbek labels ("Yanvar 2026") are a *presentation* concern and are
// produced from the canonical value, never stored.
// ============================================================

var UZBEK_MONTHS = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"
];

var UZBEK_MONTHS_SHORT = [
  "Yan", "Fev", "Mar", "Apr", "May", "Iyn",
  "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"
];

var CANONICAL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
var ALL_PERIODS_LABEL = "Jami Davr";

/** Config key holding the year to use for rows whose year cannot be derived. */
var OMAD_FALLBACK_YEAR_KEY = "Omad_Migration_Fallback_Year";

function isCanonicalPeriod_(value) {
  return CANONICAL_PERIOD_PATTERN.test(String(value || ""));
}

/** year + 1-based month -> "YYYY-MM". */
function buildPeriod_(year, month) {
  var y = Number(year);
  var m = Number(month);
  if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return "";
  return String(y) + "-" + (m < 10 ? "0" + m : String(m));
}

function periodYear_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(0, 4)) : 0;
}

/** 1-based month number. */
function periodMonth_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(5, 7)) : 0;
}

/** "2026-01" -> "Yanvar 2026". Anything else is passed through unchanged. */
function formatPeriodLabel_(period) {
  if (!isCanonicalPeriod_(period)) return String(period || "");
  return UZBEK_MONTHS[periodMonth_(period) - 1] + " " + periodYear_(period);
}

function periodFromDate_(date) {
  if (!date || isNaN(date.getTime())) return "";
  return buildPeriod_(date.getFullYear(), date.getMonth() + 1);
}

/**
 * The period held by a Month cell that the spreadsheet turned into a date.
 *
 * The Month column stores "2026-08". A spreadsheet whose column is not text
 * formatted reads that as a date and keeps 1 August instead, which loses the
 * canonical string. The year and month of that date are exactly the period
 * that was intended, so it is recovered rather than discarded - existing rows
 * heal themselves without anyone editing the sheet.
 *
 * Returns "" for month names and anything else that is not a date.
 */
function periodFromDateCell_(value) {
  var date = null;
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    date = value;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(String(value === null || value === undefined ? "" : value))) {
    date = new Date(String(value));
  }
  return date ? periodFromDate_(date) : "";
}

/**
 * Normalises whatever the Month column produced back into a storable value:
 * a canonical period stays as it is, a date cell becomes its period, and a
 * legacy month name is passed through untouched. Never stringifies a date.
 */
function normalizeMonthValue_(value) {
  if (isCanonicalPeriod_(value)) return String(value);
  var recovered = periodFromDateCell_(value);
  if (recovered) return recovered;
  return String(value === null || value === undefined ? "" : value).trim();
}

function currentPeriod_() {
  return periodFromDate_(new Date());
}

/** Shifts a period by whole months, forwards or backwards, across year ends. */
function addMonthsToPeriod_(period, delta) {
  if (!isCanonicalPeriod_(period)) return "";
  var index = periodYear_(period) * 12 + (periodMonth_(period) - 1) + Number(delta || 0);
  return buildPeriod_(Math.floor(index / 12), (index % 12) + 1);
}

/** -1 / 0 / 1. Canonical periods sort correctly as plain strings. */
function comparePeriods_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** "Yanvar" / "yanvar" / "01" / "1" -> 1-based month number, or 0. */
function parseUzbekMonth_(value) {
  var text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return 0;

  for (var i = 0; i < UZBEK_MONTHS.length; i++) {
    if (UZBEK_MONTHS[i].toLowerCase() === text.toLowerCase()) return i + 1;
    if (UZBEK_MONTHS_SHORT[i].toLowerCase() === text.toLowerCase()) return i + 1;
  }

  if (/^\d{1,2}$/.test(text)) {
    var numeric = Number(text);
    if (numeric >= 1 && numeric <= 12) return numeric;
  }
  return 0;
}

/**
 * Reads a year and month out of a stored transaction date.
 *
 * Accepted, in order of preference:
 *   - a real Date value (Sheets returns these for date-formatted cells)
 *   - "dd/MM/yyyy" (what the app writes)
 *   - "yyyy-MM-dd" / ISO 8601
 *
 * Returns null when the value is absent, unparseable or ambiguous. A
 * two-digit year is treated as ambiguous on purpose: guessing the century is
 * exactly the kind of silent damage this migration exists to avoid.
 */
function parseTransactionDate_(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }

  var text = String(value).trim();
  if (!text) return null;

  var dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text);
  if (dmy) {
    var day = Number(dmy[1]);
    var monthDmy = Number(dmy[2]);
    if (monthDmy < 1 || monthDmy > 12) return null;
    if (day < 1 || day > daysInMonth_(Number(dmy[3]), monthDmy)) return null;
    return { year: Number(dmy[3]), month: monthDmy, day: day };
  }

  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    // A full timestamp is an instant, not a calendar date. Reading it in the
    // script's timezone is what makes a value that came back from the sheet
    // round-trip to the same day instead of slipping to the one before.
    if (text.indexOf("T") > 0) {
      var instant = new Date(text);
      if (!isNaN(instant.getTime())) {
        return {
          year: instant.getFullYear(),
          month: instant.getMonth() + 1,
          day: instant.getDate()
        };
      }
    }
    var monthIso = Number(iso[2]);
    if (monthIso < 1 || monthIso > 12) return null;
    if (Number(iso[3]) < 1 || Number(iso[3]) > daysInMonth_(Number(iso[1]), monthIso)) return null;
    return { year: Number(iso[1]), month: monthIso, day: Number(iso[3]) };
  }

  return null;
}

/** Leap years included - 2024-02-29 is valid, 2026-02-29 is not. */
function daysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a transaction's canonical period.
 *
 * Precedence, and why:
 *   1. an already-canonical `month` - nothing to guess;
 *   2. a legacy month name plus a valid date whose month agrees - the date
 *      supplies the year;
 *   3. a valid date alone;
 *   4. a legacy month name plus the explicitly configured fallback year;
 *   5. unresolved.
 *
 * Case 2 deliberately requires the months to agree. A row saying "Dekabr"
 * with a January date is a real December-to-January edit and must be flagged,
 * not silently reassigned.
 */
function resolveTransactionPeriod_(transaction, fallbackYear) {
  var raw = transaction || {};
  var monthValue = raw.month;

  if (isCanonicalPeriod_(monthValue)) {
    return { period: String(monthValue), source: "canonical", confident: true };
  }

  // A canonical period the spreadsheet stored as a date. It still says exactly
  // which month was meant, and it is more trustworthy than the Date column,
  // so it is honoured before anything is inferred from the date.
  var periodCell = periodFromDateCell_(monthValue);
  if (periodCell) {
    return { period: periodCell, source: "canonical_date_cell", confident: true };
  }

  var parsedDate = parseTransactionDate_(raw.date);
  var namedMonth = parseUzbekMonth_(monthValue);

  if (namedMonth && parsedDate) {
    if (parsedDate.month === namedMonth) {
      return { period: buildPeriod_(parsedDate.year, namedMonth), source: "date", confident: true };
    }
    // The stored month and the stored date disagree. The month label is what
    // the operator chose, so keep it, but take the year from the date only
    // when the disagreement is the ordinary December/January boundary.
    var yearGuess = disagreementYear_(parsedDate, namedMonth);
    if (yearGuess !== null) {
      return {
        period: buildPeriod_(yearGuess, namedMonth),
        source: "date_boundary",
        confident: true
      };
    }
    return {
      period: fallbackYear ? buildPeriod_(fallbackYear, namedMonth) : "",
      source: "conflict",
      confident: false,
      detail: "month '" + monthValue + "' disagrees with date '" + raw.date + "'"
    };
  }

  if (parsedDate) {
    return {
      period: buildPeriod_(parsedDate.year, parsedDate.month),
      source: "date_only",
      confident: true
    };
  }

  if (namedMonth) {
    if (!fallbackYear) {
      return { period: "", source: "needs_fallback_year", confident: false,
               detail: "month '" + monthValue + "' has no usable date" };
    }
    return { period: buildPeriod_(fallbackYear, namedMonth), source: "fallback", confident: false };
  }

  return { period: "", source: "unresolved", confident: false,
           detail: "no usable month or date" };
}

/**
 * A December row dated in early January (or a January row dated in late
 * December) is a normal late entry: the period belongs to the labelled month
 * of the adjacent year. Any other disagreement is not something to guess at.
 */
function disagreementYear_(parsedDate, namedMonth) {
  if (namedMonth === 12 && parsedDate.month === 1) return parsedDate.year - 1;
  if (namedMonth === 1 && parsedDate.month === 12) return parsedDate.year + 1;
  return null;
}

/** The configured fallback year, or 0 when the operator has not chosen one. */
function getFallbackYear_(configSheet) {
  if (!configSheet) return 0;
  var stored = Number(getConfig(configSheet, OMAD_FALLBACK_YEAR_KEY));
  return isFinite(stored) && stored >= 1970 && stored <= 2999 ? stored : 0;
}

function setFallbackYear_(configSheet, year) {
  setConfig(configSheet, OMAD_FALLBACK_YEAR_KEY, String(Number(year) || ""));
}

/**
 * Normalises any stored period-ish value to canonical form where possible.
 * Used for rates, planned expenses and tenant schedules, which carry a month
 * but no date of their own.
 */
function normalizePeriodValue_(value, fallbackYear) {
  if (isCanonicalPeriod_(value)) return String(value);
  var month = parseUzbekMonth_(value);
  if (month && fallbackYear) return buildPeriod_(fallbackYear, month);
  return "";
}
