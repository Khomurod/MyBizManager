// ============================================================
// Append-only transaction ledger (schema V2)
// ------------------------------------------------------------
// Financial records are never rewritten in place and never deleted.
//
//   create  -> append one Active row
//   correct -> mark the original Corrected, append a new Active row that
//              points back at it
//   cancel  -> mark the row Cancelled; nothing is removed
//
// Every row carries the exchange rates that were in force when it was written,
// so changing a rate later cannot move a historical value.
// ============================================================

var LEDGER_SCHEMA_VERSION = 2;

var LEDGER_HEADER = [
  "ID",                 //  1 transaction id
  "Request_ID",         //  2 idempotency key
  "Created_At",         //  3 ISO timestamp
  "Updated_At",         //  4 ISO timestamp, set when the status changes
  "Created_By",         //  5 who or what wrote it
  "Source",             //  6 Web | Telegram | Migration
  "Period",             //  7 canonical YYYY-MM
  "Tenant",             //  8 tenant name, or the expense source
  "Type",               //  9 Income | Expense
  "Amount",             // 10 original amount
  "Currency",           // 11 UZS | USD
  "Rate_Buy",           // 12 buy rate available at write time
  "Rate_Sell",          // 13 sell rate available at write time
  "Rate_Used",          // 14 the rate actually applied
  "Rate_Type",          // 15 which of the two was applied
  "Amount_UZS",         // 16 converted value, frozen at write time
  "Method",             // 17 Naqd | Bank
  "Comment",            // 18 free text
  "Status",             // 19 Active | Corrected | Cancelled
  "Related_ID",         // 20 the transaction this one corrects
  "Telegram_Msg_ID",    // 21 group message id
  "Schema_Version",     // 22
  "Entry_Group_ID",     // 23 the business action this row belongs to
  "Entry_Kind"          // 24 what kind of business action that is
];

/** Column 23. Shared by every row of one business action. */
var LEDGER_GROUP_ID_COLUMN = 23;

/** Column 24. Mirrors the legacy sheet's Entry_Kind. */
var LEDGER_ENTRY_KIND_COLUMN = 24;

var TX_STATUS_ACTIVE = "Active";
var TX_STATUS_CORRECTED = "Corrected";
var TX_STATUS_CANCELLED = "Cancelled";
/**
 * A row that was written but never counted.
 *
 * A correction writes its replacement first and only then hides the original.
 * If hiding the original fails, the replacement is marked Void and the whole
 * correction is reported as failed — so the pair can never end up as two
 * Active rows, and the original can never end up hidden with nothing to
 * replace it. Void rows are excluded from every read, exactly like Cancelled
 * ones, and are ignored when a retry looks its request id up.
 */
var TX_STATUS_VOID = "Void";

var TX_SOURCE_WEB = "Web";
var TX_SOURCE_TELEGRAM = "Telegram";
var TX_SOURCE_MIGRATION = "Migration";

var TX_SOURCES = {};
TX_SOURCES[TX_SOURCE_WEB] = true;
TX_SOURCES[TX_SOURCE_TELEGRAM] = true;
TX_SOURCES[TX_SOURCE_MIGRATION] = true;

/** True once the migrated ledger is the sheet reads and writes go to. */
function isLedgerActive_(doc) {
  return activeTransactionSheetName_(doc) === OMAD_TRANSACTIONS_V2_SHEET;
}

function ledgerSheet_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
              doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LEDGER_HEADER);
    return sheet;
  }
  // Upgrades a sheet written before Entry_Group_ID in place. Existing rows keep
  // their values and read back through the deterministic backfill until
  // backfill_entry_group_ids is run against them.
  var firstRow = sheet.getRange(1, 1, 1, LEDGER_HEADER.length).getValues()[0];
  if (firstRow[LEDGER_HEADER.length - 1] !== LEDGER_HEADER[LEDGER_HEADER.length - 1]) {
    sheet.getRange(1, 1, 1, LEDGER_HEADER.length).setValues([LEDGER_HEADER]);
  }
  return sheet;
}

/**
 * Keeps the spreadsheet from reinterpreting the ledger's text columns.
 *
 * Period holds "2026-08" and the two timestamps hold ISO strings. Without a
 * text format the sheet stores all three as dates - the same silent rewrite
 * that put a legacy entry in the wrong month.
 */
function applyLedgerColumnFormats_(sheet, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var periodRange = sheet.getRange(startRow, 7, numRows, 1);
  if (typeof periodRange.setNumberFormat !== "function") return;
  periodRange.setNumberFormat("@");
  sheet.getRange(startRow, 3, numRows, 2).setNumberFormat("@");
}

/** Appends one ledger row with its text columns protected first. */
function appendLedgerRow_(sheet, values) {
  appendLedgerRows_(sheet, [values]);
}

/**
 * Appends several ledger rows in a single write.
 *
 * One setValues call is one spreadsheet operation, so a business action made
 * of several rows either lands whole or not at all. This is what makes the
 * tenant-paid pair impossible to half-create.
 */
function appendLedgerRows_(sheet, rows) {
  if (!rows || rows.length === 0) return;
  var start = sheet.getLastRow() + 1;
  applyLedgerColumnFormats_(sheet, start, rows.length);
  sheet.getRange(start, 1, rows.length, LEDGER_HEADER.length).setValues(rows);
}

function ledgerRowToTransaction_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    id: String(row[0]),
    requestId: String(row[1] || ""),
    createdAt: String(row[2] || ""),
    updatedAt: String(row[3] || ""),
    createdBy: String(row[4] || ""),
    source: String(row[5] || TX_SOURCE_WEB),
    // normalizeMonthValue_ recovers a period the sheet stored as a date
    // instead of stringifying it into "Sat Aug 01 2026 ...".
    period: normalizeMonthValue_(row[6]),
    tenant: String(row[7] || ""),
    type: row[8] === "Expense" ? "Expense" : "Income",
    amount: Number(row[9]) || 0,
    currency: row[10] === "USD" ? "USD" : "UZS",
    rateBuy: Number(row[11]) || 0,
    rateSell: Number(row[12]) || 0,
    rateUsed: Number(row[13]) || 0,
    rateType: String(row[14] || "sell"),
    amountUZS: Number(row[15]) || 0,
    method: row[16] === "Bank" ? "Bank" : "Naqd",
    comment: String(row[17] || ""),
    status: String(row[18] || TX_STATUS_ACTIVE),
    relatedId: String(row[19] || ""),
    msgId: String(row[20] || ""),
    schemaVersion: Number(row[21]) || LEDGER_SCHEMA_VERSION,
    // Rows written before the column existed fall back to the same
    // deterministic derivation the legacy sheet uses, so grouping is
    // consistent across both schemas and across the migration.
    groupId: String(row[22] || "").trim() || legacyEntryGroupId_(row[0]),
    entryKind: normalizeEntryKind_(row[23])
  };
}

function transactionToLedgerRow_(t) {
  return [
    t.id, t.requestId, t.createdAt, t.updatedAt, t.createdBy, t.source, t.period,
    t.tenant, t.type, t.amount, t.currency, t.rateBuy, t.rateSell, t.rateUsed,
    t.rateType, t.amountUZS, t.method, t.comment, t.status, t.relatedId,
    t.msgId, t.schemaVersion, t.groupId || "", t.entryKind || ""
  ];
}

/** Every row, in sheet order, including corrected and cancelled ones. */
function readLedgerRows_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push(ledgerRowToTransaction_(data[i], i + 1));
  }
  return rows;
}

function findLedgerRow_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === String(transactionId)) return rows[i];
  }
  return null;
}

/**
 * The record a request id produced, or null.
 *
 * Void rows are skipped: they are the discarded half of a correction that
 * failed, so treating one as "already done" would answer a retry with a record
 * that deliberately counts for nothing.
 */
function findLedgerRowByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === TX_STATUS_VOID) continue;
    if (rows[i].requestId && rows[i].requestId === String(requestId)) return rows[i];
  }
  return null;
}

/** Every row of one business action, whatever its status. */
function findLedgerRowsByGroupId_(doc, groupId) {
  var wanted = String(groupId || "").trim();
  if (!wanted) return [];
  var rows = readLedgerRows_(doc);
  var group = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].groupId === wanted) group.push(rows[i]);
  }
  return group;
}

/** Writes deterministic group ids onto ledger rows that predate the column. */
function backfillLedgerEntryGroupIds_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { status: "success", filled: 0, alreadySet: 0 };

  ledgerSheet_(doc);
  var data = sheet.getDataRange().getValues();
  var filled = 0;
  var alreadySet = 0;

  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    if (String((data[i].length > 22 ? data[i][22] : "") || "").trim()) { alreadySet++; continue; }
    var derived = legacyEntryGroupId_(id);
    if (!derived) continue;
    sheet.getRange(i + 1, LEDGER_GROUP_ID_COLUMN).setValue(derived);
    filled++;
  }

  if (filled > 0) appendAuditRow_(doc, "entry_group_ids_backfilled", String(filled));
  return { status: "success", filled: filled, alreadySet: alreadySet };
}

/**
 * A transaction as the rest of the app expects to see it. `month` is kept
 * alongside `period` so existing readers keep working unchanged.
 */
function ledgerToLegacyShape_(t) {
  return {
    id: t.id,
    groupId: t.groupId,
    entryKind: t.entryKind,
    tenant: t.tenant,
    month: t.period,
    period: t.period,
    periodLabel: formatPeriodLabel_(t.period),
    periodSource: "canonical",
    type: t.type,
    amount: t.amount,
    currency: t.currency,
    method: t.method,
    date: formatLedgerDate_(t.createdAt),
    comment: t.comment,
    msgId: t.msgId,
    requestId: t.requestId,
    status: t.status,
    relatedId: t.relatedId,
    source: t.source,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    createdBy: t.createdBy,
    rateBuy: t.rateBuy,
    rateSell: t.rateSell,
    rateUsed: t.rateUsed,
    rateType: t.rateType,
    amountUZS: t.amountUZS,
    schemaVersion: t.schemaVersion
  };
}

function formatLedgerDate_(isoTimestamp) {
  try {
    var parsed = new Date(String(isoTimestamp || ""));
    if (isNaN(parsed.getTime())) return "";
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "dd/MM/yyyy");
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------------------ validation

function validateTransactionInput_(input) {
  var payload = input || {};

  if (!isCanonicalPeriod_(payload.period)) return "Davr noto'g'ri (masalan 2026-01).";
  if (!String(payload.tenant || "").trim()) return "Obyekt tanlanmagan.";
  if (String(payload.tenant).length > 200) return "Obyekt nomi juda uzun.";

  var amount = Number(payload.amount);
  if (!isFinite(amount) || amount <= 0) return "Summa musbat raqam bo'lishi kerak.";
  if (amount > 1e15) return "Summa juda katta.";

  if (payload.currency !== "UZS" && payload.currency !== "USD") return "Valyuta noto'g'ri.";
  if (payload.method !== "Naqd" && payload.method !== "Bank") return "To'lov usuli noto'g'ri.";
  if (payload.type !== "Income" && payload.type !== "Expense") return "Operatsiya turi noto'g'ri.";
  if (String(payload.comment || "").length > 2000) return "Izoh juda uzun.";
  if (payload.source && !TX_SOURCES[payload.source]) return "Manba noto'g'ri.";

  return "";
}

/**
 * Freezes the rates in force right now onto the transaction. USD amounts are
 * converted at the sell rate; UZS amounts convert one-to-one and record the
 * rates anyway, so the history is complete.
 */
function buildRateSnapshot_(period, currency, rateType) {
  var rates = getOmadRates_();
  var entry = getPeriodRate_(rates, period);
  var appliedType = rateType === "buy" ? "buy" : "sell";
  var used = currency === "USD" ? (appliedType === "buy" ? entry.buy : entry.sell) : 1;

  return {
    rateBuy: entry.buy,
    rateSell: entry.sell,
    rateUsed: used,
    rateType: currency === "USD" ? appliedType : "none"
  };
}

// -------------------------------------------------------------------- create

/**
 * Appends one Active transaction. Idempotent on `requestId`: the same request
 * always resolves to the same record, so a retry, a refresh or a double-click
 * cannot create a second copy.
 */
function createTransaction_(doc, input) {
  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var requestId = String(input.requestId || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };
  if (requestId.length > 128) return { status: "error", message: "requestId juda uzun." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = findLedgerRowByRequestId_(doc, requestId);
    if (existing) {
      // Not an error: the caller gets exactly the record their request created.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(existing) };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var transaction = {
      id: input.id ? String(input.id) : nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: "",
      msgId: String(input.msgId || ""),
      schemaVersion: LEDGER_SCHEMA_VERSION,
      // Supplied when this row is one line of a larger business action; its own
      // group when it stands alone. Never derived from the id.
      groupId: String(input.groupId || "").trim() || newEntryGroupId_(),
      entryKind: normalizeEntryKind_(input.entryKind)
    };

    appendLedgerRow_(ledgerSheet_(doc), transactionToLedgerRow_(transaction));
    appendAuditRow_(doc, "transaction_created", JSON.stringify({
      id: transaction.id, period: transaction.period, source: transaction.source,
      amount: transaction.amount, currency: transaction.currency
    }));

    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(transaction) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ids are "<epochMillis>_<n>". The suffix disambiguates two transactions
 * created inside the same millisecond, which the entry form does routinely.
 */
function nextTransactionId_(doc) {
  var stamp = String(new Date().getTime());
  var rows = readLedgerRows_(doc);
  var used = {};
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id.indexOf(stamp + "_") === 0) used[rows[i].id] = true;
  }
  var index = 0;
  while (used[stamp + "_" + index]) index++;
  return stamp + "_" + index;
}

// ------------------------------------------------------------------- correct

/**
 * Replaces a transaction: the replacement is written first, then the original
 * is hidden. The original row is never edited beyond its status and timestamp,
 * so the audit trail keeps the value that was actually recorded at the time.
 *
 * The order is the whole point. Hiding the original first — which is what this
 * used to do — meant a failure between the two writes left the original marked
 * Corrected with no replacement in the sheet: money that silently left the
 * books, in the one operation the append-only design exists to make safe.
 *
 * Writing the replacement first cannot lose money. It can, for exactly as long
 * as the second write takes, double-count it, so the failure path marks the
 * replacement Void and reports the correction as failed. The three outcomes are
 * therefore: both writes land, or neither counts, or — only if the rollback
 * *also* fails, against a spreadsheet that has already failed twice — two
 * Active rows and a loud audit entry naming both ids. Never a hidden original.
 *
 * All of it runs under the script lock, so no other write interleaves.
 */
function correctTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var alreadyDone = findLedgerRowByRequestId_(doc, requestId);
    if (alreadyDone) {
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(alreadyDone) };
    }

    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };
    if (original.status !== TX_STATUS_ACTIVE) {
      return {
        status: "error",
        message: "Bu tranzaksiya allaqachon " +
                 (original.status === TX_STATUS_CANCELLED ? "bekor qilingan" : "tuzatilgan") + "."
      };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var replacement = {
      id: nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: original.id,
      // The replacement inherits the group message so the report is edited
      // rather than duplicated.
      msgId: original.msgId,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      // A correction stays inside the business action it corrects, and cannot
      // change what kind of action that is.
      groupId: original.groupId,
      entryKind: original.entryKind
    };

    var sheet = ledgerSheet_(doc);
    appendLedgerRow_(sheet, transactionToLedgerRow_(replacement));

    var replacementRow = sheet.getLastRow();
    try {
      setLedgerStatus_(sheet, original.rowNumber, TX_STATUS_CORRECTED, now);
    } catch (statusError) {
      voidFailedReplacement_(doc, sheet, replacementRow, replacement, original, statusError);
      return {
        status: "error",
        message: "Tuzatishni saqlab bo'lmadi, asl yozuv o'zgarmadi. Qaytadan urinib ko'ring."
      };
    }

    appendAuditRow_(doc, "transaction_corrected", JSON.stringify({
      original: original.id, replacement: replacement.id,
      before: { amount: original.amount, currency: original.currency, period: original.period },
      after: { amount: replacement.amount, currency: replacement.currency, period: replacement.period }
    }));

    return {
      status: "success",
      duplicate: false,
      transaction: ledgerToLegacyShape_(replacement),
      corrected: original.id
    };
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------- cancel

/** Marks a transaction Cancelled. Financial records are never deleted. */
function cancelTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };

    if (original.status === TX_STATUS_CANCELLED) {
      // Cancelling twice is the same outcome as cancelling once.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(original) };
    }
    if (original.status === TX_STATUS_CORRECTED) {
      return { status: "error", message: "Tuzatilgan yozuvni bekor qilib bo'lmaydi. Yangi yozuvni bekor qiling." };
    }
    if (original.status === TX_STATUS_VOID) {
      // Already counts for nothing; there is nothing to cancel.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(original) };
    }

    var now = new Date().toISOString();
    setLedgerStatus_(ledgerSheet_(doc), original.rowNumber, TX_STATUS_CANCELLED, now);

    appendAuditRow_(doc, "transaction_cancelled", JSON.stringify({
      id: original.id, reason: String((input && input.reason) || "").slice(0, 500),
      amount: original.amount, currency: original.currency, period: original.period
    }));

    var cancelled = Object.assign({}, original, { status: TX_STATUS_CANCELLED, updatedAt: now });
    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(cancelled) };
  } finally {
    lock.releaseLock();
  }
}

function setLedgerStatus_(sheet, rowNumber, status, timestamp) {
  sheet.getRange(rowNumber, 19).setValue(status);
  sheet.getRange(rowNumber, 4).setValue(timestamp);
}

/**
 * Discards a replacement whose correction could not be completed.
 *
 * The original is untouched and still Active, so the books are already correct;
 * this only stops the replacement being counted a second time. If even this
 * write fails the spreadsheet is failing repeatedly, and the one useful thing
 * left is to say so loudly and name both rows — silence here would leave a
 * double count nobody knows to look for.
 */
function voidFailedReplacement_(doc, sheet, rowNumber, replacement, original, cause) {
  try {
    setLedgerStatus_(sheet, rowNumber, TX_STATUS_VOID, new Date().toISOString());
    appendAuditRow_(doc, "transaction_correction_failed", JSON.stringify({
      original: original.id,
      voidedReplacement: replacement.id,
      reason: redactSecrets_(cause).slice(0, 300)
    }));
  } catch (rollbackError) {
    appendAuditRow_(doc, "transaction_correction_rollback_failed", JSON.stringify({
      original: original.id,
      orphanReplacement: replacement.id,
      reason: redactSecrets_(cause).slice(0, 200),
      rollbackReason: redactSecrets_(rollbackError).slice(0, 200)
    }));
  }
}

// ---------------------------------------------------------------------- read

/** Active transactions only - what the dashboard, reports and balances use. */
function listActiveTransactions_(doc, filters) {
  var options = filters || {};
  var rows = readLedgerRows_(doc);
  var result = [];

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status !== TX_STATUS_ACTIVE) continue;
    if (options.period && rows[i].period !== options.period) continue;
    if (options.tenant && rows[i].tenant !== options.tenant) continue;
    if (options.type && rows[i].type !== options.type) continue;
    result.push(ledgerToLegacyShape_(rows[i]));
  }
  return result;
}

function getTransaction_(doc, transactionId) {
  var found = findLedgerRow_(doc, transactionId);
  return found ? ledgerToLegacyShape_(found) : null;
}

/**
 * The full chain for one transaction: the record itself, whatever it corrected,
 * and whatever corrected it - newest last.
 */
function getTransactionHistory_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  var byId = {};
  for (var i = 0; i < rows.length; i++) byId[rows[i].id] = rows[i];

  var target = byId[String(transactionId)];
  if (!target) return null;

  // Walk back to the first record in the chain.
  var root = target;
  var guard = 0;
  while (root.relatedId && byId[root.relatedId] && guard++ < 1000) root = byId[root.relatedId];

  // Then forward, collecting every link.
  var chain = [root];
  var current = root;
  guard = 0;
  while (guard++ < 1000) {
    var next = null;
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].relatedId === current.id) { next = rows[j]; break; }
    }
    if (!next) break;
    chain.push(next);
    current = next;
  }

  return {
    transactionId: String(transactionId),
    chain: chain.map(ledgerToLegacyShape_),
    current: ledgerToLegacyShape_(chain[chain.length - 1])
  };
}
