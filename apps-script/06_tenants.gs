// ============================================================
// Tenants & rent schedules
// ------------------------------------------------------------
// A tenant's rent is effective-dated, not a single number.
//
//   defaultRent   what the agreement says
//   startPeriod   when the agreement begins ("" = always has)
//   endPeriod     when it ends ("" = open-ended)
//   rentChanges   [{ fromPeriod, amount }] - a new default from a period on
//   exceptions    [{ period, amount }] - one month at a different amount
//   noRentPeriods ["2026-12"] - one month with no rent at all
//   active        an inactive tenant is owed nothing, and can be reactivated
//
// Resolution order is deliberate: a no-rent month beats an exception, an
// exception beats a scheduled change, and a scheduled change beats the
// default. Anything outside start/end is zero regardless.
//
// Legacy tenants stored `{ name, rent, currency, disabledMonths }`. Those are
// still honoured: `rent` becomes the default and `disabledMonths` keeps
// working as month names that repeat every year.
// ============================================================

function normalizeTenantList_(tenants) {
  var source = Array.isArray(tenants) ? tenants : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var tenant = typeof item === "string" ? { name: item } : (item || {});
    var name = String(tenant.name || "").trim();
    if (!name) continue;
    normalized.push(normalizeTenant_(tenant, name));
  }
  return normalized;
}

function normalizeTenant_(tenant, name) {
  var defaultRent = tenant.defaultRent !== undefined
    ? (Number(tenant.defaultRent) || 0)
    : (Number(tenant.rent) || 0);

  return {
    name: name,
    // `rent` is kept in step with `defaultRent` so older readers still work.
    rent: defaultRent,
    defaultRent: defaultRent,
    currency: tenant.currency === "UZS" ? "UZS" : "USD",
    active: tenant.active === undefined ? true : tenant.active !== false,
    startPeriod: isCanonicalPeriod_(tenant.startPeriod) ? tenant.startPeriod : "",
    endPeriod: isCanonicalPeriod_(tenant.endPeriod) ? tenant.endPeriod : "",
    rentChanges: normalizeRentChanges_(tenant.rentChanges),
    exceptions: normalizeRentExceptions_(tenant.exceptions),
    noRentPeriods: normalizePeriodList_(tenant.noRentPeriods),
    disabledMonths: Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : []
  };
}

/** Scheduled default-rent changes, earliest first, one per period. */
function normalizeRentChanges_(changes) {
  var source = Array.isArray(changes) ? changes : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var change = source[i] || {};
    if (!isCanonicalPeriod_(change.fromPeriod)) continue;
    var amount = Number(change.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[change.fromPeriod] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { fromPeriod: period, amount: byPeriod[period] };
  });
}

/** One-month overrides, earliest first, one per period. */
function normalizeRentExceptions_(exceptions) {
  var source = Array.isArray(exceptions) ? exceptions : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var exception = source[i] || {};
    if (!isCanonicalPeriod_(exception.period)) continue;
    var amount = Number(exception.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[exception.period] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { period: period, amount: byPeriod[period] };
  });
}

function normalizePeriodList_(periods) {
  var source = Array.isArray(periods) ? periods : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    if (isCanonicalPeriod_(source[i])) seen[source[i]] = true;
  }
  return Object.keys(seen).sort();
}

/** True when the agreement covers this period at all. */
function isTenantInScheduleForPeriod_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return false;
  if (!isCanonicalPeriod_(period)) return false;
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return false;
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return false;
  return true;
}

/**
 * Legacy month-name switches. A disabled month repeats every year, which is
 * exactly why the schedule fields replace it; it stays honoured so existing
 * tenant records keep behaving as their operator set them up.
 */
function isTenantDisabledForPeriod_(tenant, period) {
  var disabled = (tenant && Array.isArray(tenant.disabledMonths)) ? tenant.disabledMonths : [];
  if (disabled.length === 0) return false;
  if (disabled.indexOf(period) !== -1) return true;
  var month = periodMonth_(period);
  return month > 0 && disabled.indexOf(UZBEK_MONTHS[month - 1]) !== -1;
}

/**
 * The rent actually due from a tenant in one period, in the tenant's own
 * currency. Zero means nothing is owed - which is different from "no rent
 * configured", and both are legitimate.
 */
function effectiveTenantRent_(tenant, period) {
  var t = tenant || {};
  if (!isTenantInScheduleForPeriod_(t, period)) return 0;
  if (isTenantDisabledForPeriod_(t, period)) return 0;

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return 0;

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return Number(exceptions[i].amount) || 0;
  }

  // The latest scheduled change that has already taken effect wins.
  var amount = t.defaultRent !== undefined ? Number(t.defaultRent) || 0 : Number(t.rent) || 0;
  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = 0; j < changes.length; j++) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) amount = Number(changes[j].amount) || 0;
  }
  return amount;
}

/** Why a period resolved the way it did - shown in the schedule editor. */
function tenantRentSource_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return "inactive";
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return "before_start";
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return "after_end";
  if (isTenantDisabledForPeriod_(t, period)) return "disabled_month";

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return "no_rent";

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return "exception";
  }

  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = changes.length - 1; j >= 0; j--) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) return "scheduled_change";
  }
  return "default";
}

/** The whole year at a glance, for the schedule editor. */
function tenantScheduleForYear_(tenant, year) {
  var rows = [];
  for (var month = 1; month <= 12; month++) {
    var period = buildPeriod_(year, month);
    rows.push({
      period: period,
      label: formatPeriodLabel_(period),
      rent: effectiveTenantRent_(tenant, period),
      currency: (tenant && tenant.currency) || "USD",
      source: tenantRentSource_(tenant, period)
    });
  }
  return rows;
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
      // An incoming record replaces the stored one, except that a legacy
      // client which does not know about `disabledMonths` must not wipe them.
      merged[indexByName[incoming.name]] = Object.assign({}, incoming, {
        disabledMonths: Array.isArray(incoming.disabledMonths) && incoming.disabledMonths.length > 0
          ? incoming.disabledMonths
          : (incoming.disabledMonths || existing.disabledMonths || [])
      });
    }
  }
  return merged;
}

/** Tenants whose agreement is live right now - what the Telegram bot offers. */
function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var period = currentPeriod_();
  var names = [];
  for (var i = 0; i < tenants.length; i++) {
    if (tenants[i].active === false) continue;
    if (tenants[i].endPeriod && comparePeriods_(period, tenants[i].endPeriod) > 0) continue;
    names.push(tenants[i].name);
  }
  return names;
}
