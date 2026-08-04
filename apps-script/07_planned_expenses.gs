// ============================================================
// Planned expenses
// ------------------------------------------------------------
// Template (planned) expenses used by the projection.
// ============================================================

function normalizeTemplateExpenses_(expenses) {
  var source = Array.isArray(expenses) ? expenses : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i] || {};
    var name = String(item.name || "").trim();
    if (!name) continue;
    normalized.push({
      id: String(item.id || (Date.now() + "_" + i)),
      month: String(item.month || item.period || currentPeriod_()).trim(),
      name: name,
      amount: Number(item.amount) || 0,
      currency: item.currency === "USD" ? "USD" : "UZS"
    });
  }
  return normalized;
}
