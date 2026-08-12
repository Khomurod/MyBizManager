// ============================================================
// Exchange rates
// ------------------------------------------------------------
// USD -> UZS conversion and the balances derived from it.
//
// Rates are keyed by canonical period ("2026-01"). A legacy month-name key
// ("Fevral") is still honoured on read so the app keeps working before the
// migration runs, but nothing writes one any more.
// ============================================================

var DEFAULT_RATE_UZS = 12500;

/**
 * The rate table.
 *
 * Called from inside the money loops -- once per tenant in the balance
 * calculation, once per transaction in the projection -- so it reads through
 * the per-request memo rather than passing over System_Config each time.
 */
function getOmadRates_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return {};
  return safeParseJSON_(getConfigOnce_(configSheet, "Omad_Rates"), {});
}

function normalizeRateEntry_(rawRate) {
  if (typeof rawRate === "number") {
    return { buy: rawRate || DEFAULT_RATE_UZS, sell: rawRate || DEFAULT_RATE_UZS };
  }
  if (rawRate && typeof rawRate === "object") {
    var buy = Number(rawRate.buy || rawRate.sell || rawRate.rate) || DEFAULT_RATE_UZS;
    var sell = Number(rawRate.sell || rawRate.buy || rawRate.rate) || DEFAULT_RATE_UZS;
    return { buy: buy, sell: sell };
  }
  return { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

/**
 * Looks a rate up by canonical period, falling back to the legacy month-name
 * key for the same month. Returns null when the period has no rate at all, so
 * callers can tell "no rate configured" from "the rate happens to be 12500".
 */
function findRateEntry_(rates, period) {
  if (!rates || typeof rates !== "object") return null;

  var key = String(period || "");
  if (Object.prototype.hasOwnProperty.call(rates, key)) return normalizeRateEntry_(rates[key]);

  if (isCanonicalPeriod_(key)) {
    var legacyKey = UZBEK_MONTHS[periodMonth_(key) - 1];
    if (Object.prototype.hasOwnProperty.call(rates, legacyKey)) {
      return normalizeRateEntry_(rates[legacyKey]);
    }
  }
  return null;
}

function getPeriodRate_(rates, period) {
  return findRateEntry_(rates, period) || { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

function getPeriodRateByType_(rates, period, rateType) {
  var entry = getPeriodRate_(rates, period);
  return rateType === "buy" ? entry.buy : entry.sell;
}

function toUZS_(amount, currency, period, rates, rateType) {
  var numericAmount = Number(amount) || 0;
  if (currency !== "USD") return numericAmount;
  return numericAmount * getPeriodRateByType_(rates, period, rateType || "sell");
}

/** The period a transaction belongs to, whichever field carries it. */
function transactionPeriod_(transaction) {
  var t = transaction || {};
  return String(t.period || t.month || "");
}

/**
 * The two figures the Telegram report quotes. Uses the value frozen on each
 * transaction where there is one, so a later rate edit cannot move a report
 * that has already been sent.
 */
function calculateBalancesFromTransactions_(transactions, targetPeriod) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    var period = transactionPeriod_(t);
    var signed = signedTransactionUZS_(t, rates);
    allTimeBalance += signed;
    if (period === String(targetPeriod || "")) monthBalance += signed;
  }

  return { monthBalance: Math.round(monthBalance), allTimeBalance: Math.round(allTimeBalance) };
}

/**
 * Converts every legacy month-name key to a canonical period using the
 * configured fallback year. Keys that are already canonical are kept as-is.
 */
function migrateRatesMap_(rates, fallbackYear) {
  var source = rates && typeof rates === "object" ? rates : {};
  var migrated = {};
  var unresolved = [];

  Object.keys(source).forEach(function (key) {
    if (isCanonicalPeriod_(key)) {
      migrated[key] = normalizeRateEntry_(source[key]);
      return;
    }
    var period = normalizePeriodValue_(key, fallbackYear);
    if (!period) {
      unresolved.push(key);
      return;
    }
    // An explicit canonical entry always wins over a converted legacy one.
    if (!Object.prototype.hasOwnProperty.call(migrated, period)) {
      migrated[period] = normalizeRateEntry_(source[key]);
    }
  });

  return { rates: migrated, unresolved: unresolved };
}
