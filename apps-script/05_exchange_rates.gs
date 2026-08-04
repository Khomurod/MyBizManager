// ============================================================
// Exchange rates
// ------------------------------------------------------------
// USD -> UZS conversion and the balances derived from it.
// ============================================================

function getOmadRates_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return {};
  return safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {});
}

function normalizeRateEntry_(rawRate) {
  var defaultRate = 12500;
  if (typeof rawRate === "number") return { buy: rawRate || defaultRate, sell: rawRate || defaultRate };
  if (rawRate && typeof rawRate === "object") {
    var buy = Number(rawRate.buy || rawRate.sell || rawRate.rate) || defaultRate;
    var sell = Number(rawRate.sell || rawRate.buy || rawRate.rate) || defaultRate;
    return { buy: buy, sell: sell };
  }
  return { buy: defaultRate, sell: defaultRate };
}

function getMonthRateByType_(rates, month, rateType) {
  var normalized = normalizeRateEntry_(rates && rates[month]);
  return rateType === "buy" ? normalized.buy : normalized.sell;
}

function toUZS_(amount, currency, month, rates, rateType) {
  var numericAmount = Number(amount) || 0;
  return currency === "USD" ? numericAmount * getMonthRateByType_(rates, month, rateType || "sell") : numericAmount;
}

function calculateBalancesFromTransactions_(transactions, targetMonth) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;

  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var valueUZS = toUZS_(t.amount, t.currency, t.month, rates, "sell");
    var sign = t.type === "Income" ? 1 : -1;
    allTimeBalance += valueUZS * sign;
    if (t.month === targetMonth) monthBalance += valueUZS * sign;
  }

  return { monthBalance: monthBalance, allTimeBalance: allTimeBalance };
}
