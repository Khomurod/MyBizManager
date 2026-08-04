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
  "Schema_Version"      // 22
];

var TX_STATUS_ACTIVE = "Active";
var TX_STATUS_CORRECTED = "Corrected";
var TX_STATUS_CANCELLED = "Cancelled";

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
  if (sheet.getLastRow() === 0) sheet.appendRow(LEDGER_HEADER);
  return sheet;
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
    period: String(row[6] || ""),
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
    schemaVersion: Number(row[21]) || LEDGER_SCHEMA_VERSION
  };
}

function transactionToLedgerRow_(t) {
  return [
    t.id, t.requestId, t.createdAt, t.updatedAt, t.createdBy, t.source, t.period,
    t.tenant, t.type, t.amount, t.currency, t.rateBuy, t.rateSell, t.rateUsed,
    t.rateType, t.amountUZS, t.method, t.comment, t.status, t.relatedId,
    t.msgId, t.schemaVersion
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

function findLedgerRowByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].requestId && rows[i].requestId === String(requestId)) return rows[i];
  }
  return null;
}

/**
 * A transaction as the rest of the app expects to see it. `month` is kept
 * alongside `period` so existing readers keep working unchanged.
 */
function ledgerToLegacyShape_(t) {
  return {
    id: t.id,
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
      schemaVersion: LEDGER_SCHEMA_VERSION
    };

    ledgerSheet_(doc).appendRow(transactionToLedgerRow_(transaction));
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
 * Marks the original Corrected and appends a replacement that points back at
 * it. The original row is never edited beyond its status and timestamp, so the
 * audit trail keeps the value that was actually recorded at the time.
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
      schemaVersion: LEDGER_SCHEMA_VERSION
    };

    var sheet = ledgerSheet_(doc);
    setLedgerStatus_(sheet, original.rowNumber, TX_STATUS_CORRECTED, now);
    sheet.appendRow(transactionToLedgerRow_(replacement));

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
