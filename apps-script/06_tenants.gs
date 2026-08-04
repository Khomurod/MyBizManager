// ============================================================
// Tenants & rent schedules
// ------------------------------------------------------------
// Tenant records and the schedule data the projection reads.
// ============================================================

function normalizeTenantList_(tenants) {
  var source = Array.isArray(tenants) ? tenants : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var tenant = typeof item === "string" ? { name: item } : (item || {});
    var name = String(tenant.name || "").trim();
    if (!name) continue;
    normalized.push({
      name: name,
      rent: Number(tenant.rent) || 0,
      currency: tenant.currency === "UZS" ? "UZS" : "USD",
      disabledMonths: Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : []
    });
  }
  return normalized;
}

function mergeTenantsByName_(existingTenants, incomingTenants) {
  var merged = [];
  var indexByName = {};
  for (var i = 0; i < existingTenants.length; i++) {
    merged.push(existingTenants[i]);
    indexByName[existingTenants[i].name] = i;
  }
  for (var j = 0; j < incomingTenants.length; j++) {
    var incoming = incomingTenants[j];
    if (indexByName[incoming.name] === undefined) {
      indexByName[incoming.name] = merged.length;
      merged.push(incoming);
    } else {
      var existing = merged[indexByName[incoming.name]];
      merged[indexByName[incoming.name]] = {
        name: incoming.name,
        rent: Number(incoming.rent) || 0,
        currency: incoming.currency === "UZS" ? "UZS" : "USD",
        disabledMonths: Array.isArray(incoming.disabledMonths) ? incoming.disabledMonths : (existing.disabledMonths || [])
      };
    }
  }
  return merged;
}

function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var names = [];
  for (var i = 0; i < tenants.length; i++) names.push(tenants[i].name);
  return names;
}
