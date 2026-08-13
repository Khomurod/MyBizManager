// ============================================================
// The Omad read model
// ------------------------------------------------------------
// A materialised summary of the ledger, stored in System_Config and rebuilt
// from the ledger whenever the ledger has moved.
//
// WHY IT EXISTS
// -------------
// Every figure on the dashboard and on the Mini App's first screen is derived
// from a full pass over the historical ledger. The pass is correct and it is
// cheap in arithmetic, but on Apps Script it is a Sheets RPC that grows with
// the business, and it happened again on every load. `01c_cache.gs` already
// removes the repeat within a 60-second window; the window is short enough
// that almost every *real* load is still a miss, because nobody opens the
// dashboard twice a minute.
//
// So the answer is stored where it survives: one System_Config row, which the
// same request reads anyway for the tenants and the rates, memoised by
// `getConfigOnce_`. Between two ledger writes the dashboard therefore touches
// the ledger sheet not at all.
//
// WHAT MAKES IT SAFE
// ------------------
//   1. **It is not a second source of truth.** Every figure in it is produced
//      by the same functions the full-ledger path uses -- `calculateActuals_`,
//      `tenantPaidTotals_` -- applied to the rows `readOmadTransactions_`
//      returns. There is no second implementation of any monetary rule to
//      drift from the first.
//   2. **It is derived, never authoritative.** Nothing writes a transaction
//      from it, prices anything from it, or decides a save from it. Deleting
//      the row costs one rebuild.
//   3. **It is keyed by the data revision.** Every ledger write bumps
//      `CACHE_SCOPE_OMAD`, and a model whose stored revision is not the current
//      one is discarded rather than trusted. Corrections and cancellations bump
//      it exactly like creations do, so a status change invalidates it too.
//   4. **It fails towards the ledger.** A missing row, an unparsable row, a
//      version bump, a different active sheet, a failed store -- all of them
//      end in "compute it from the ledger", which is the behaviour that
//      existed before this file.
//
// `verify_omad_read_model` rebuilds it from scratch and compares field by
// field with what is stored, so the claim in (1) is checkable against live
// data and not only in tests.
// ============================================================

/** Where the model lives. Excluded from the revision bump -- see below. */
var OMAD_READ_MODEL_KEY = "Omad_Read_Model";

/** Bumped whenever the stored shape changes, which retires every old row. */
var OMAD_READ_MODEL_VERSION = 1;

/** How many recent business actions the model carries. */
var OMAD_READ_MODEL_RECENT = 30;

/**
 * The model as the current ledger would produce it, rebuilding when the stored
 * one no longer describes the ledger.
 *
 * The revision is read *before* the ledger pass, so a write that lands during
 * the pass leaves the stored model looking stale rather than looking current.
 * Being wrong in that direction costs one extra rebuild; being wrong the other
 * way would show a figure that is missing an entry.
 */
function omadReadModel_(doc, configSheet) {
  var revision = dataRevision_(CACHE_SCOPE_OMAD);
  var source = activeTransactionSheetName_(doc);

  var stored = safeParseJSON_(getConfigOnce_(configSheet, OMAD_READ_MODEL_KEY), null);
  if (omadReadModelUsable_(stored, revision, source)) return stored;

  var fresh = buildOmadReadModel_(doc, configSheet, revision, source);
  storeOmadReadModel_(configSheet, fresh);
  return fresh;
}

/** Whether a stored model still describes the ledger as it is now. */
function omadReadModelUsable_(model, revision, source) {
  if (!model || typeof model !== "object") return false;
  if (Number(model.version) !== OMAD_READ_MODEL_VERSION) return false;
  if (String(model.source || "") !== String(source)) return false;
  // An empty revision means the properties service is unavailable, so nothing
  // can be keyed reliably and the ledger is the only honest answer.
  if (!revision) return false;
  return String(model.revision || "") === String(revision);
}

/**
 * One pass over the ledger, turned into every figure the read screens ask for.
 *
 * The per-period loops walk an in-memory array, not the sheet, so the cost is
 * one Sheets read however many periods the business has. They deliberately go
 * through `calculateActuals_` and `tenantPaidTotals_` rather than adding up
 * anything here: those are the money rules, and this file is not allowed a
 * second opinion about them.
 */
function buildOmadReadModel_(doc, configSheet, revision, source) {
  var rev = revision === undefined ? dataRevision_(CACHE_SCOPE_OMAD) : revision;
  var src = source === undefined ? activeTransactionSheetName_(doc) : source;

  var transactions = readOmadTransactions_(doc);
  var rates = getOmadRates_();

  // Balances are all-time by rule, so they come from the unscoped call.
  var allTime = calculateActuals_(transactions, "");

  // Bucketed by period in one pass, so the per-period work below is linear in
  // the ledger rather than linear in rows × periods. The functions it calls are
  // unchanged: `calculateActuals_` scoped to a period counts only that period's
  // rows anyway, and `tenantPaidTotals_` filters on it too, so handing each one
  // its own bucket is the same arithmetic on the same rows.
  var byPeriod = {};
  for (var i = 0; i < transactions.length; i++) {
    var p = transactionPeriod_(transactions[i]);
    if (!p) continue;
    if (!byPeriod[p]) byPeriod[p] = [];
    byPeriod[p].push(transactions[i]);
  }
  var periodList = Object.keys(byPeriod).sort();

  var periods = {};
  for (var k = 0; k < periodList.length; k++) {
    var period = periodList[k];
    var bucket = byPeriod[period];
    var actuals = calculateActuals_(bucket, period);
    periods[period] = {
      income: actuals.income,
      expense: actuals.expense,
      net: actuals.net,
      paid: tenantPaidTotals_(bucket, period),
      groups: omadPeriodGroupCount_(bucket, period)
    };
  }

  return {
    version: OMAD_READ_MODEL_VERSION,
    source: String(src),
    revision: String(rev),
    builtAt: new Date().toISOString(),
    rows: transactions.length,
    balances: { cash: allTime.cash, bank: allTime.bank, total: allTime.total },
    periods: periods,
    periodList: periodList,
    // Newest business actions across every period, so the commonest recent
    // list is answered without a filter and an older period can still tell
    // whether the slice it gets is the whole story.
    recent: omadRecentEntries_(transactions, rates, "", OMAD_READ_MODEL_RECENT)
  };
}

/** How many distinct business actions a period holds. */
function omadPeriodGroupCount_(transactions, period) {
  var seen = {};
  var count = 0;
  for (var i = 0; i < transactions.length; i++) {
    if (transactionPeriod_(transactions[i]) !== period) continue;
    var key = String(transactions[i].groupId || "");
    if (seen[key]) continue;
    seen[key] = true;
    count++;
  }
  return count;
}

/**
 * Recent activity as *business actions* rather than rows.
 *
 * A tenant-paid pair is one entry, and the several lines of one payment are one
 * entry with a total, so the reader is never asked to pair rows up themselves.
 * `period` empty means every period.
 *
 * This is the one implementation; the Mini App's recent list is this function.
 */
function omadRecentEntries_(transactions, rates, period, limit) {
  var list = Array.isArray(transactions) ? transactions : [];
  var wanted = isCanonicalPeriod_(period) ? String(period) : "";

  var order = [];
  var groups = {};
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (wanted && transactionPeriod_(t) !== wanted) continue;
    var key = String(t.groupId || "");
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(t);
  }

  var entries = [];
  for (var g = 0; g < order.length; g++) {
    var rows = groups[order[g]];
    var first = rows[0];
    var total = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].type === "Income") total += transactionUZS_(rows[r], rates);
    }
    var tenantPaid = isTenantPaidGroup_(rows);
    var income = null;
    for (var q = 0; q < rows.length; q++) if (rows[q].type === "Income") { income = rows[q]; break; }
    var lead = tenantPaid ? (income || first) : first;
    if (!tenantPaid) {
      total = 0;
      for (var s = 0; s < rows.length; s++) total += transactionUZS_(rows[s], rates);
    }

    entries.push({
      groupId: order[g],
      id: lead.id,
      kind: tenantPaid ? ENTRY_KIND_TENANT_PAID : "",
      type: lead.type,
      tenant: lead.tenant,
      period: transactionPeriod_(lead),
      periodLabel: formatPeriodLabel_(transactionPeriod_(lead)),
      date: typeof lead.date === "object" && lead.date ? formatLedgerDate_(lead.date) : String(lead.date || ""),
      amountUZS: Math.round(total),
      currency: lead.currency,
      amount: lead.amount,
      lines: rows.length,
      comment: String(lead.comment || "").slice(0, 300)
    });
  }

  // Newest first, by the timestamp the ids encode.
  entries.sort(function (a, b) {
    return (Number(String(b.id).split("_")[0]) || 0) - (Number(String(a.id).split("_")[0]) || 0);
  });
  return entries.slice(0, Math.max(1, Number(limit) || OMAD_READ_MODEL_RECENT));
}

/**
 * One period's figures out of the model, in the shape `calculateActuals_`
 * returns them.
 *
 * Balances ride along unscoped because they are all-time by rule: money in the
 * safe does not reset when the reporting month changes.
 */
function omadPeriodFigures_(model, period) {
  var m = model || {};
  var entry = (m.periods || {})[String(period)] || {};
  var balances = m.balances || {};
  return {
    income: Number(entry.income) || 0,
    expense: Number(entry.expense) || 0,
    net: Number(entry.net) || 0,
    cash: Number(balances.cash) || 0,
    bank: Number(balances.bank) || 0,
    total: Number(balances.total) || 0,
    paid: entry.paid || {},
    groups: Number(entry.groups) || 0
  };
}

/**
 * The recent list for one period, from the model where the model can answer it.
 *
 * The stored list is a fixed window of the newest actions across every period.
 * For the period anybody is actually looking at that window contains all of
 * them; for an older period it may not, and answering with a short list would
 * be quietly wrong rather than merely slow. So the model's own group count for
 * the period decides: a slice that is already the whole period, or is as long
 * as was asked for, is the answer; anything shorter falls back to the ledger.
 */
function omadRecentForPeriod_(doc, model, period, limit) {
  var want = Math.max(1, Number(limit) || OMAD_READ_MODEL_RECENT);
  var wanted = isCanonicalPeriod_(period) ? String(period) : "";
  var stored = (model && Array.isArray(model.recent)) ? model.recent : null;

  if (stored && !model.recentDropped) {
    if (!wanted) return stored.slice(0, want);
    var filtered = [];
    for (var i = 0; i < stored.length; i++) {
      if (String(stored[i].period || "") === wanted) filtered.push(stored[i]);
    }
    var groups = omadPeriodFigures_(model, wanted).groups;
    if (filtered.length >= want || filtered.length >= groups) return filtered.slice(0, want);
  }

  return omadRecentEntries_(readOmadTransactions_(doc), getOmadRates_(), wanted, want);
}

/**
 * Stores the model. Failing to store one is not a failure of anything: the
 * caller already has the answer, and the next read simply rebuilds.
 */
function storeOmadReadModel_(configSheet, model) {
  try {
    var body = JSON.stringify(model);
    // The cell has a hard limit and a summary that approaches it is not a
    // summary any more. Dropping the recent list first keeps the figures --
    // the expensive part -- storable for far longer than the list would.
    if (body.length > OMAD_READ_MODEL_MAX_LENGTH) {
      var trimmed = {};
      Object.keys(model).forEach(function (key) { trimmed[key] = model[key]; });
      trimmed.recent = [];
      trimmed.recentDropped = true;
      body = JSON.stringify(trimmed);
      if (body.length > OMAD_READ_MODEL_MAX_LENGTH) return false;
    }
    setConfig(configSheet, OMAD_READ_MODEL_KEY, body);
    return true;
  } catch (error) {
    return false;
  }
}

/** Sheets refuses a cell over 50 000 characters; stay well clear of it. */
var OMAD_READ_MODEL_MAX_LENGTH = 45000;

/** Drops the stored model, so the next read rebuilds it from the ledger. */
function invalidateOmadReadModel_(configSheet) {
  try {
    setConfig(configSheet, OMAD_READ_MODEL_KEY, "");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Rebuilds the model from the ledger and stores it, whatever was there before.
 *
 * The operator-facing repair, and what the tests use to prove the derived
 * figures are the ledger's own.
 */
function rebuildOmadReadModel_(doc, configSheet) {
  var model = buildOmadReadModel_(doc, configSheet);
  var stored = storeOmadReadModel_(configSheet, model);
  return {
    status: "success",
    stored: stored,
    rows: model.rows,
    periods: model.periodList.length,
    builtAt: model.builtAt
  };
}

/**
 * Compares what is stored against a fresh full-ledger build, field by field.
 *
 * This is the check that "the summary is the ledger" is true of the live data
 * rather than only of the code. It never repairs anything on its own -- a
 * difference is something to look at, and `rebuild_omad_read_model` is the
 * separate, deliberate action that fixes it.
 */
function verifyOmadReadModel_(doc, configSheet) {
  var stored = safeParseJSON_(getConfig(configSheet, OMAD_READ_MODEL_KEY), null);
  var fresh = buildOmadReadModel_(doc, configSheet);
  var differences = [];

  if (!stored || typeof stored !== "object") {
    return {
      ok: true, present: false, differences: [],
      message: "Saqlangan xulosa yo'q; keyingi o'qishda qayta quriladi.",
      rows: fresh.rows
    };
  }

  var note = function (field, storedValue, freshValue) {
    differences.push({ field: field, stored: storedValue, expected: freshValue });
  };

  ["cash", "bank", "total"].forEach(function (key) {
    if (Math.round(Number((stored.balances || {})[key]) || 0) !== fresh.balances[key]) {
      note("balances." + key, (stored.balances || {})[key], fresh.balances[key]);
    }
  });

  var storedPeriods = stored.periods || {};
  var names = {};
  Object.keys(storedPeriods).forEach(function (p) { names[p] = true; });
  Object.keys(fresh.periods).forEach(function (p) { names[p] = true; });

  Object.keys(names).sort().forEach(function (period) {
    var a = storedPeriods[period] || {};
    var b = fresh.periods[period] || {};
    ["income", "expense", "net"].forEach(function (key) {
      if ((Number(a[key]) || 0) !== (Number(b[key]) || 0)) {
        note(period + "." + key, a[key], b[key]);
      }
    });
    var paidA = a.paid || {};
    var paidB = b.paid || {};
    var tenants = {};
    Object.keys(paidA).forEach(function (n) { tenants[n] = true; });
    Object.keys(paidB).forEach(function (n) { tenants[n] = true; });
    Object.keys(tenants).forEach(function (name) {
      if ((Number(paidA[name]) || 0) !== (Number(paidB[name]) || 0)) {
        note(period + ".paid." + name, paidA[name], paidB[name]);
      }
    });
  });

  return {
    ok: differences.length === 0,
    present: true,
    stale: !omadReadModelUsable_(stored, dataRevision_(CACHE_SCOPE_OMAD), fresh.source),
    rows: fresh.rows,
    storedRows: Number(stored.rows) || 0,
    builtAt: String(stored.builtAt || ""),
    // Bounded: a broken model would otherwise answer with one entry per period
    // per tenant, and the point is to say *that* it disagrees.
    differences: differences.slice(0, 50),
    differenceCount: differences.length
  };
}
