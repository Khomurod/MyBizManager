// ============================================================
// Migration to canonical year-month periods
// ------------------------------------------------------------
// The original sheet is never overwritten. Migrated rows are written to a new
// versioned sheet, verified, and only then read from. Rollback is a config
// change, not a restore.
//
//   preview  -> what would happen, writing nothing
//   apply    -> write Omad_Transactions_V2 (original untouched)
//   verify   -> row counts, unique ids, per-period totals, balances
//   cutover  -> point reads at V2
//   rollback -> point reads back at the original
// ============================================================

var MIGRATION_STATUS_KEY = "Omad_Migration_Status";
var MIGRATION_SCHEMA_VERSION = LEDGER_SCHEMA_VERSION;

/**
 * Resolves every row without writing anything.
 *
 * Returns the proposed period for each row, a per-year summary, the rows whose
 * year could not be determined, duplicate ids, and the pre-migration financial
 * totals that verification will compare against.
 */
function previewOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var fallbackYear = Number((options && options.fallbackYear) || 0) || getFallbackYear_(configSheet);

  var sourceName = OMAD_TRANSACTIONS_SHEET;
  var sourceSheet = doc.getSheetByName(sourceName);
  var rows = readRawTransactionRows_(sourceSheet);

  var byYear = {};
  var bySource = {};
  var unresolved = [];
  var resolvedRows = [];
  var idCounts = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var resolution = resolveTransactionPeriod_(row, fallbackYear);
    idCounts[String(row.id)] = (idCounts[String(row.id)] || 0) + 1;
    bySource[resolution.source] = (bySource[resolution.source] || 0) + 1;

    if (!resolution.period) {
      unresolved.push({
        rowNumber: row.rowNumber,
        id: String(row.id),
        month: String(row.month),
        date: String(row.date),
        amount: Number(row.amount) || 0,
        currency: String(row.currency),
        reason: resolution.detail || resolution.source
      });
      continue;
    }

    var year = periodYear_(resolution.period);
    byYear[year] = (byYear[year] || 0) + 1;
    resolvedRows.push({ row: row, period: resolution.period, source: resolution.source });
  }

  var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; }).sort();

  return {
    sourceSheet: sourceName,
    targetSheet: OMAD_TRANSACTIONS_V2_SHEET,
    fallbackYear: fallbackYear,
    fallbackYearRequired: bySource.needs_fallback_year > 0 || bySource.conflict > 0,
    totalRows: rows.length,
    resolvedRows: resolvedRows.length,
    byYear: byYear,
    bySource: bySource,
    unresolved: unresolved,
    duplicateIds: duplicateIds,
    // What verification will compare against.
    totalsByPeriod: totalsByPeriod_(resolvedRows),
    balances: balanceTotals_(rows),
    ratePreview: migrateRatesMap_(safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), fallbackYear),
    canApply: rows.length > 0 && unresolved.length === 0 && duplicateIds.length === 0
  };
}

/** Raw rows with their sheet row number, so the operator can find them. */
function readRawTransactionRows_(sheet) {
  var rows = [];
  if (!sheet || sheet.getLastRow() < 2) return rows;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push({
      rowNumber: i + 1,
      id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
      amount: data[i][4], currency: data[i][5], method: data[i][6],
      date: data[i][7], comment: data[i][8], msgId: data[i][9],
      requestId: data[i].length > 10 ? data[i][10] : "",
      groupId: data[i].length > 11 ? data[i][11] : "",
      // Column 13. Absent on rows written before the tenant-paid feature, and
      // the migration cannot carry across what it never read.
      entryKind: data[i].length > 12 ? data[i][12] : ""
    });
  }
  return rows;
}

/** Signed UZS totals per period, using each period's own sell rate. */
function totalsByPeriod_(resolvedRows) {
  var rates = getOmadRates_();
  var totals = {};
  for (var i = 0; i < resolvedRows.length; i++) {
    var entry = resolvedRows[i];
    var value = toUZS_(entry.row.amount, entry.row.currency, entry.period, rates, "sell");
    var sign = entry.row.type === "Income" ? 1 : -1;
    totals[entry.period] = Math.round((totals[entry.period] || 0) + value * sign);
  }
  return totals;
}

/** Cash, bank and total balances - invariants the migration must not move. */
function balanceTotals_(rows) {
  var rates = getOmadRates_();
  var cash = 0;
  var bank = 0;
  var income = 0;
  var expense = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var period = transactionPeriod_(row);
    var value = toUZS_(row.amount, row.currency, period, rates, "sell");
    var sign = row.type === "Income" ? 1 : -1;
    if (row.type === "Income") income += value; else expense += value;
    if (row.method === "Bank") bank += value * sign; else cash += value * sign;
  }

  return {
    cash: Math.round(cash),
    bank: Math.round(bank),
    total: Math.round(cash + bank),
    income: Math.round(income),
    expense: Math.round(expense)
  };
}

/**
 * Writes the migrated rows to the versioned sheet. The source sheet is not
 * touched, which is what makes rollback cheap.
 *
 * The target sheet is rewritten from scratch every time, so an interrupted
 * apply is recovered simply by running it again.
 */
function applyOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var preview = previewOmadMigration_(doc, options);

  if (preview.totalRows === 0) {
    return { status: "error", message: "Ko'chiriladigan yozuv yo'q.", preview: preview };
  }
  if (preview.duplicateIds.length > 0) {
    return {
      status: "error",
      message: "Takrorlangan ID topildi: " + preview.duplicateIds.join(", "),
      preview: preview
    };
  }
  if (preview.unresolved.length > 0 && options.allowUnresolved !== true) {
    return {
      status: "error",
      message: preview.unresolved.length + " ta yozuvning yili aniqlanmadi. " +
               "Zaxira yilni tanlang yoki sanalarni tuzating.",
      preview: preview
    };
  }

  if (preview.fallbackYear) setFallbackYear_(configSheet, preview.fallbackYear);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    backupOmadState_(doc, configSheet, "pre_period_migration");

    // The target is rebuilt from scratch, so an interrupted apply is recovered
    // simply by running it again.
    var target = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
                 doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
    clearSheetRows_(target);
    target.appendRow(LEDGER_HEADER);

    var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
    var migratedAt = new Date().toISOString();
    var written = [];
    for (var i = 0; i < sourceRows.length; i++) {
      var resolution = resolveTransactionPeriod_(sourceRows[i], preview.fallbackYear);
      if (!resolution.period) continue;
      written.push(transactionToLedgerRow_(
        migratedRowToLedger_(sourceRows[i], resolution.period, migratedAt)));
    }
    if (written.length > 0) {
      // Formats first: every migrated row carries a canonical period, and the
      // spreadsheet would otherwise turn all of them into dates on the way in.
      applyLedgerColumnFormats_(target, 2, written.length);
      target.getRange(2, 1, written.length, LEDGER_HEADER.length).setValues(written);
    }

    // Rates carry a month but no date of their own, so they follow the same
    // fallback year. The original map is kept in the audit trail.
    var rateMigration = migrateRatesMap_(
      safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), preview.fallbackYear);
    setConfig(configSheet, "Omad_Rates_V1_Backup", getConfig(configSheet, "Omad_Rates") || "{}");
    setConfig(configSheet, "Omad_Rates", JSON.stringify(rateMigration.rates));

    recordMigrationStatus_(configSheet, {
      state: "applied",
      appliedAt: new Date().toISOString(),
      fallbackYear: preview.fallbackYear,
      sourceRows: preview.totalRows,
      migratedRows: written.length,
      skippedRows: preview.totalRows - written.length,
      schemaVersion: MIGRATION_SCHEMA_VERSION
    });
    appendAuditRow_(doc, "omad_period_migration_applied", JSON.stringify({
      migrated: written.length, skipped: preview.totalRows - written.length,
      fallbackYear: preview.fallbackYear, byYear: preview.byYear
    }));
  } finally {
    lock.releaseLock();
  }

  return { status: "success", preview: preview, verification: verifyOmadMigration_(doc) };
}

/**
 * Compares the migrated sheet against the original: row counts, unique ids,
 * per-period totals and the cash/bank/total balances.
 */
/**
 * The UZS value a migrated row *claims*, checked against its own frozen rate.
 *
 * A frozen value must never be re-derived from the current rate table - that
 * is the whole point of freezing it, and doing so would make verification
 * agree with any figure the table happens to produce today. It is instead
 * checked for internal consistency: the amount, the rate recorded on the row,
 * and the stored total have to describe the same conversion.
 */
function frozenAmountFailures_(row) {
  var failures = [];
  var amount = Number(row.amount) || 0;
  var stored = Number(row.amountUZS);
  var used = Number(row.rateUsed) || 0;

  if (!isFinite(stored)) {
    failures.push("Amount_UZS o'qib bo'lmadi: " + row.id);
    return failures;
  }

  if (row.currency === "USD") {
    if (used <= 0) {
      failures.push("Rate_Used yo'q: " + row.id);
    } else if (Math.abs(stored - Math.round(amount * used)) > 1) {
      failures.push("Amount_UZS noto'g'ri (" + row.id + "): " +
                    stored + " != " + Math.round(amount * used));
    }
    // The applied rate must be one of the two recorded on the row.
    var buy = Number(row.rateBuy) || 0;
    var sell = Number(row.rateSell) || 0;
    if (used > 0 && used !== buy && used !== sell) {
      failures.push("Rate_Used saqlangan kurslarga mos emas: " + row.id);
    }
    if (row.rateType === "sell" && sell > 0 && used !== sell) {
      failures.push("Sotish kursi ishlatilmagan: " + row.id);
    }
  } else if (Math.abs(stored - Math.round(amount)) > 1) {
    failures.push("UZS Amount_UZS asl summaga teng emas (" + row.id + "): " +
                  stored + " != " + Math.round(amount));
  }

  return failures;
}

/**
 * Every migrated row against the row it came from, field by field.
 *
 * Totals alone cannot see a swapped tenant, a changed method or a tampered
 * frozen value that happens to keep a period sum intact, so each record is
 * compared directly and the frozen conversion is checked on its own terms.
 */
function verifyMigratedRows_(sourceResolved, ledgerRows) {
  var failures = [];
  var byId = {};
  for (var i = 0; i < ledgerRows.length; i++) byId[String(ledgerRows[i].id)] = ledgerRows[i];

  var matched = {};
  for (var j = 0; j < sourceResolved.length; j++) {
    var source = sourceResolved[j].row;
    var period = sourceResolved[j].period;
    var id = String(source.id);
    var target = byId[id];

    if (!target) {
      failures.push("Yozuv ko'chirilmagan: " + id);
      continue;
    }
    matched[id] = true;

    var normalized = normalizeTransaction_({
      id: source.id, tenant: source.tenant, month: period, type: source.type,
      amount: source.amount, currency: source.currency, method: source.method,
      date: source.date, comment: source.comment, msgId: source.msgId,
      requestId: source.requestId,
      // Compared, so they have to be supplied. Normalizing without them
      // derived a fallback group id and an empty kind, which would have
      // agreed with a migration that dropped both.
      groupId: source.groupId, entryKind: source.entryKind
    });

    var fields = [
      ["Tenant", normalized.tenant, String(target.tenant || "")],
      ["Type", normalized.type, String(target.type || "")],
      ["Amount", String(normalized.amount), String(Number(target.amount) || 0)],
      ["Currency", normalized.currency, String(target.currency || "")],
      ["Method", normalized.method, String(target.method || "")],
      ["Period", period, String(target.period || "")],
      ["Request_ID", String(normalized.requestId || ""), String(target.requestId || "")],
      ["Telegram_Msg_ID", String(normalized.msgId || ""), String(target.msgId || "")],
      ["Status", TX_STATUS_ACTIVE, String(target.status || "")],
      ["Related_ID", "", String(target.relatedId || "")],
      // The three the old check did not look at. A migration that silently
      // dropped the group id or the entry kind passed every aggregate and
      // every field comparison above it.
      ["Entry_Group_ID", String(normalized.groupId || ""), String(target.groupId || "")],
      ["Entry_Kind", String(normalized.entryKind || ""), String(target.entryKind || "")],
      ["Comment", String(normalized.comment || ""), String(target.comment || "")]
    ];

    for (var k = 0; k < fields.length; k++) {
      if (fields[k][1] !== fields[k][2]) {
        failures.push(fields[k][0] + " mos emas (" + id + "): " +
                      fields[k][1] + " -> " + fields[k][2]);
      }
    }

    failures = failures.concat(frozenAmountFailures_(target));
  }

  for (var m = 0; m < ledgerRows.length; m++) {
    var extraId = String(ledgerRows[m].id);
    if (!matched[extraId]) failures.push("Manbada yo'q yozuv: " + extraId);
  }

  return failures.concat(verifyMigratedGroups_(sourceResolved, ledgerRows));
}

/**
 * The business meaning of the rows, not just their contents.
 *
 * Every field can match while the ledger still says something different from
 * the source: a group is a claim that several rows are one action, and a
 * tenant-paid pair is a claim that the pair nets to zero against our cash.
 * Neither survives being checked one row at a time, so both are checked here.
 */
function verifyMigratedGroups_(sourceResolved, ledgerRows) {
  var failures = [];

  var group = function (rows, idOf, groupOf) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var key = String(groupOf(rows[i]) || "");
      if (!map[key]) map[key] = [];
      map[key].push(String(idOf(rows[i])));
    }
    Object.keys(map).forEach(function (k) { map[k].sort(); });
    return map;
  };

  var sourceRows = sourceResolved.map(function (entry) {
    return normalizeTransaction_(Object.assign({}, entry.row, { month: entry.period }));
  });

  var sourceGroups = group(sourceRows,
    function (r) { return r.id; }, function (r) { return r.groupId; });
  var targetGroups = group(ledgerRows,
    function (r) { return r.id; }, function (r) { return r.groupId; });

  Object.keys(sourceGroups).forEach(function (key) {
    var before = sourceGroups[key];
    var after = targetGroups[key];
    if (!after) {
      failures.push("Guruh yo'qoldi (" + key + "): " + before.length + " ta yozuv");
      return;
    }
    if (before.join("|") !== after.join("|")) {
      failures.push("Guruh tarkibi o'zgardi (" + key + "): " +
                    before.length + " -> " + after.length + " ta yozuv");
    }
  });
  Object.keys(targetGroups).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(sourceGroups, key)) {
      failures.push("Manbada yo'q guruh: " + key);
    }
  });

  // A tenant-paid pair has to arrive as a tenant-paid pair. If the kind is
  // lost the two halves become unrelated rows that can be edited apart, and
  // the "our cash did not move" property stops being visible anywhere.
  var byGroup = {};
  for (var t = 0; t < ledgerRows.length; t++) {
    var g = String(ledgerRows[t].groupId || "");
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(ledgerRows[t]);
  }
  var sourceByGroup = {};
  for (var s = 0; s < sourceRows.length; s++) {
    var sg = String(sourceRows[s].groupId || "");
    if (!sourceByGroup[sg]) sourceByGroup[sg] = [];
    sourceByGroup[sg].push(sourceRows[s]);
  }

  Object.keys(sourceByGroup).forEach(function (key) {
    if (!isTenantPaidGroup_(sourceByGroup[key])) return;
    var after = byGroup[key] || [];
    if (!isTenantPaidGroup_(after)) {
      failures.push("Ijarachi to'lovi guruhi buzildi (" + key + ")");
      return;
    }
    var income = 0;
    var expense = 0;
    for (var r = 0; r < after.length; r++) {
      var value = Number(after[r].amountUZS);
      if (!isFinite(value)) value = 0;
      if (after[r].type === "Income") income += value; else expense += value;
    }
    if (Math.abs(income - expense) > 1) {
      failures.push("Ijarachi to'lovi kassaga ta'sir qilmasligi kerak (" + key + "): " +
                    income + " != " + expense);
    }
  });

  return failures;
}

function verifyOmadMigration_(doc) {
  var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
  var targetSheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  // The target carries the append-only schema, so it is read as a ledger and
  // then shaped like the source for a like-for-like comparison.
  // Read once: the row-by-row check below needs the same rows.
  var ledgerRows = readLedgerRows_(doc);
  var targetRows = ledgerRows.map(function (t) {
    return {
      id: t.id, tenant: t.tenant, month: t.period, type: t.type, amount: t.amount,
      currency: t.currency, method: t.method, date: t.createdAt, comment: t.comment,
      msgId: t.msgId, requestId: t.requestId, status: t.status
    };
  });
  var failures = [];

  if (!targetSheet) {
    return { ok: false, failures: ["Omad_Transactions_V2 varag'i topilmadi."] };
  }

  var configSheet = doc.getSheetByName("System_Config");
  var fallbackYear = getFallbackYear_(configSheet);

  if (targetRows.length !== sourceRows.length) {
    failures.push("Yozuvlar soni mos emas: " + sourceRows.length + " -> " + targetRows.length);
  }

  var seen = {};
  var duplicates = [];
  for (var i = 0; i < targetRows.length; i++) {
    var id = String(targetRows[i].id);
    if (seen[id]) duplicates.push(id); else seen[id] = true;
    if (!isCanonicalPeriod_(targetRows[i].month)) {
      failures.push("Kanonik bo'lmagan davr: " + targetRows[i].id + " -> " + targetRows[i].month);
    }
  }
  if (duplicates.length > 0) failures.push("Takrorlangan ID: " + duplicates.join(", "));

  // Per-period totals: the source resolves to the same periods the target
  // stores, so the two maps must be identical.
  var sourceResolved = [];
  for (var j = 0; j < sourceRows.length; j++) {
    var resolution = resolveTransactionPeriod_(sourceRows[j], fallbackYear);
    if (resolution.period) sourceResolved.push({ row: sourceRows[j], period: resolution.period });
  }
  var expectedTotals = totalsByPeriod_(sourceResolved);
  var actualTotals = totalsByPeriod_(targetRows.map(function (row) {
    return { row: row, period: String(row.month) };
  }));

  Object.keys(expectedTotals).forEach(function (period) {
    if (expectedTotals[period] !== actualTotals[period]) {
      failures.push("Davr yig'indisi mos emas (" + period + "): " +
                    expectedTotals[period] + " -> " + (actualTotals[period] || 0));
    }
  });
  Object.keys(actualTotals).forEach(function (period) {
    if (!Object.prototype.hasOwnProperty.call(expectedTotals, period)) {
      failures.push("Kutilmagan davr: " + period);
    }
  });

  // Row by row, including each frozen value against its own recorded rate.
  // Aggregates alone cannot see a tampered Amount_UZS that leaves a period
  // sum looking correct.
  failures = failures.concat(verifyMigratedRows_(sourceResolved, ledgerRows));

  var expectedBalances = balanceTotals_(sourceResolved.map(function (entry) {
    return Object.assign({}, entry.row, { period: entry.period });
  }));
  var actualBalances = balanceTotals_(targetRows);
  ["cash", "bank", "total", "income", "expense"].forEach(function (key) {
    if (expectedBalances[key] !== actualBalances[key]) {
      failures.push("Balans mos emas (" + key + "): " +
                    expectedBalances[key] + " -> " + actualBalances[key]);
    }
  });

  return {
    ok: failures.length === 0,
    failures: failures,
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    expectedTotals: expectedTotals,
    actualTotals: actualTotals,
    expectedBalances: expectedBalances,
    actualBalances: actualBalances
  };
}

/** Points reads and writes at the verified V2 sheet. */
function cutoverOmadMigration_(doc) {
  var verification = verifyOmadMigration_(doc);
  if (!verification.ok) {
    return { status: "error", message: "Tekshiruv o'tmadi.", verification: verification };
  }

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "pre_period_cutover");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_V2_SHEET);
  recordMigrationStatus_(configSheet, {
    state: "cutover",
    cutoverAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_V2_SHEET,
    schemaVersion: MIGRATION_SCHEMA_VERSION
  });
  appendAuditRow_(doc, "omad_period_migration_cutover", OMAD_TRANSACTIONS_V2_SHEET);

  return { status: "success", verification: verification, activeSheet: OMAD_TRANSACTIONS_V2_SHEET };
}

/**
 * Points reads back at the original sheet. V2 is left in place on purpose:
 * deleting data is never part of a rollback.
 */
function rollbackOmadMigration_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_SHEET);

  var backedUpRates = getConfig(configSheet, "Omad_Rates_V1_Backup");
  if (backedUpRates) setConfig(configSheet, "Omad_Rates", backedUpRates);

  recordMigrationStatus_(configSheet, {
    state: "rolled_back",
    rolledBackAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_SHEET,
    schemaVersion: 1
  });
  appendAuditRow_(doc, "omad_period_migration_rolled_back", OMAD_TRANSACTIONS_SHEET);

  return { status: "success", activeSheet: OMAD_TRANSACTIONS_SHEET };
}

function recordMigrationStatus_(configSheet, status) {
  var previous = safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {});
  setConfig(configSheet, MIGRATION_STATUS_KEY, JSON.stringify(Object.assign({}, previous, status)));
}

function getMigrationStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var stored = configSheet ? safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {}) : {};
  var v2 = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);

  return {
    state: stored.state || "not_started",
    schemaVersion: stored.schemaVersion || 1,
    fallbackYear: getFallbackYear_(configSheet),
    activeSheet: activeTransactionSheetName_(doc),
    versionedSheetExists: !!v2,
    versionedSheetRows: v2 ? Math.max(0, v2.getLastRow() - 1) : 0,
    sourceSheetRows: (function () {
      var source = doc.getSheetByName(OMAD_TRANSACTIONS_SHEET);
      return source ? Math.max(0, source.getLastRow() - 1) : 0;
    })(),
    appliedAt: stored.appliedAt || "",
    cutoverAt: stored.cutoverAt || "",
    rolledBackAt: stored.rolledBackAt || ""
  };
}

/**
 * A legacy row in the append-only schema. The rates in force for the resolved
 * period are frozen onto it, so post-migration rate edits cannot move it.
 */
function migratedRowToLedger_(row, period, migratedAt) {
  var normalized = normalizeTransaction_({
    id: row.id, tenant: row.tenant, month: period, type: row.type,
    amount: row.amount, currency: row.currency, method: row.method,
    date: row.date, comment: row.comment, msgId: row.msgId, requestId: row.requestId,
    // Carried across verbatim when the legacy row has one, and derived
    // deterministically when it does not, so a business action that spanned
    // several rows before the migration still spans them after it.
    groupId: row.groupId,
    // What kind of business action that was. Dropping this would turn every
    // tenant-paid pair into two unrelated rows: isTenantPaidGroup_ reads it,
    // so the pair would stop reporting as one entry and either half could be
    // edited on its own -- exactly the state the feature exists to prevent.
    entryKind: row.entryKind
  });
  var snapshot = buildRateSnapshot_(period, normalized.currency, "sell");

  return {
    id: normalized.id,
    requestId: normalized.requestId,
    // The original entry date is what matters; the migration timestamp is
    // recorded separately as the update.
    createdAt: legacyDateToIso_(row.date, period),
    updatedAt: migratedAt,
    createdBy: "migration",
    source: TX_SOURCE_MIGRATION,
    period: period,
    tenant: normalized.tenant,
    type: normalized.type,
    amount: normalized.amount,
    currency: normalized.currency,
    rateBuy: snapshot.rateBuy,
    rateSell: snapshot.rateSell,
    rateUsed: snapshot.rateUsed,
    rateType: snapshot.rateType,
    amountUZS: Math.round(normalized.currency === "USD"
      ? normalized.amount * snapshot.rateUsed : normalized.amount),
    method: normalized.method,
    comment: normalized.comment,
    status: TX_STATUS_ACTIVE,
    relatedId: "",
    msgId: normalized.msgId,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    groupId: normalized.groupId,
    entryKind: normalized.entryKind
  };
}

/** Best-effort ISO timestamp for a legacy row; falls back to the period start. */
function legacyDateToIso_(dateValue, period) {
  var parsed = parseTransactionDate_(dateValue);
  if (parsed) {
    var day = 1;
    var text = String(dateValue || "");
    var dmy = /^(\d{1,2})[\/.-]\d{1,2}[\/.-]\d{4}$/.exec(text);
    var iso = /^\d{4}-\d{2}-(\d{2})/.exec(text);
    if (dmy) day = Number(dmy[1]);
    else if (iso) day = Number(iso[1]);
    else if (typeof dateValue === "object" && dateValue.getDate) day = dateValue.getDate();
    return new Date(Date.UTC(parsed.year, parsed.month - 1, day)).toISOString();
  }
  return new Date(Date.UTC(periodYear_(period), periodMonth_(period) - 1, 1)).toISOString();
}

function clearSheetRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) sheet.deleteRows(1, lastRow);
}
