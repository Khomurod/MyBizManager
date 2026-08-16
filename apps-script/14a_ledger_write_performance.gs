// ============================================================
// Ledger write performance
// ------------------------------------------------------------
// Keeps the append-only ledger rules intact while making the hot write path
// proportional to the entry being saved instead of to the whole history.
// ============================================================

/**
 * Fast request-id lookup.
 *
 * The old lookup read all 24 columns of every historical ledger row before
 * each write. Idempotency only needs Request_ID (column B), so read that one
 * column, then fetch the full row only for an exact candidate. Void rows keep
 * the old meaning: they do not satisfy a retry.
 */
var findLedgerRowByRequestIdBeforeWritePerf_ = findLedgerRowByRequestId_;
findLedgerRowByRequestId_ = function (doc, requestId) {
  var wanted = String(requestId || "");
  if (!wanted) return null;

  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var lastRow = sheet.getLastRow();
  var idRange = sheet.getRange(2, 2, lastRow - 1, 1);

  // Production Sheets can let the service find the exact cell without
  // transferring even the one-column index into Apps Script. The test harness
  // deliberately has no TextFinder, so the bounded one-column fallback below
  // keeps the same behaviour everywhere.
  if (typeof idRange.createTextFinder === "function") {
    var matches = idRange.createTextFinder(wanted).matchEntireCell(true).findAll();
    for (var m = 0; m < matches.length; m++) {
      var rowNumber = matches[m].getRow();
      var raw = sheet.getRange(rowNumber, 1, 1, LEDGER_HEADER.length).getValues()[0];
      var found = ledgerRowToTransaction_(raw, rowNumber);
      if (found.status !== TX_STATUS_VOID) return found;
    }
    return null;
  }

  var ids = idRange.getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "") !== wanted) continue;
    var rowNo = i + 2;
    var row = sheet.getRange(rowNo, 1, 1, LEDGER_HEADER.length).getValues()[0];
    var transaction = ledgerRowToTransaction_(row, rowNo);
    if (transaction.status !== TX_STATUS_VOID) return transaction;
  }
  return null;
};

/**
 * IDs are append-only, so only the last ledger row can collide with the
 * millisecond we are minting now. Reading the whole ledger just to choose the
 * suffix made every write slower as history grew.
 */
var nextTransactionIdBeforeWritePerf_ = nextTransactionId_;
nextTransactionId_ = function (doc) {
  var stamp = String(new Date().getTime());
  var index = 0;
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);

  if (sheet && sheet.getLastRow() >= 2) {
    var lastId = String(sheet.getRange(sheet.getLastRow(), 1, 1, 1).getValues()[0][0] || "");
    var prefix = stamp + "_";
    if (lastId.indexOf(prefix) === 0) {
      var previous = Number(lastId.slice(prefix.length));
      if (isFinite(previous) && previous >= 0) index = Math.floor(previous) + 1;
    }
  }
  return stamp + "_" + index;
};

/** Writes the same per-transaction audit events as the single-row path, in one call. */
function appendTransactionCreatedAuditsBatch_(doc, transactions) {
  try {
    var list = Array.isArray(transactions) ? transactions : [];
    if (list.length === 0) return;
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);

    var values = [];
    for (var i = 0; i < list.length; i++) {
      var transaction = list[i];
      values.push([
        new Date().toISOString(),
        "transaction_created",
        redactSecrets_(JSON.stringify({
          id: transaction.id,
          period: transaction.period,
          source: transaction.source,
          amount: transaction.amount,
          currency: transaction.currency
        })).slice(0, 45000)
      ]);
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 3).setValues(values);
  } catch (error) {}
}

/**
 * Creates every line of one new business entry under one lock and one ledger
 * setValues call. The request id is one stable submission id; stored rows use
 * <requestId>_<line>, so a lost response can be retried without duplicating
 * any part of the entry.
 */
function createTransactionBatch_(doc, input) {
  var payload = input || {};
  var lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length === 0) return { status: "error", message: "Kamida bitta summa kiriting." };
  if (lines.length > 50) return { status: "error", message: "Bir yozuvda juda ko'p qator bor." };

  var requestBase = String(payload.requestId || "").trim();
  if (!requestBase) return { status: "error", message: "requestId talab qilinadi." };
  if (requestBase.length > 120) return { status: "error", message: "requestId juda uzun." };

  var prepared = [];
  for (var v = 0; v < lines.length; v++) {
    var line = lines[v] || {};
    var candidate = {
      period: payload.period,
      tenant: payload.tenant,
      type: payload.type,
      amount: line.amount,
      currency: line.currency,
      method: line.method,
      comment: payload.comment,
      source: payload.source,
      rateType: line.rateType || payload.rateType,
      createdBy: payload.createdBy,
      groupId: payload.groupId
    };
    var validationError = validateTransactionInput_(candidate);
    if (validationError) return { status: "error", message: validationError, lineIndex: v };
    prepared.push(candidate);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = findLedgerRowByRequestId_(doc, requestBase + "_0");
    if (existing) {
      return {
        status: "success",
        duplicate: true,
        transaction: ledgerToLegacyShape_(existing),
        transactions: [ledgerToLegacyShape_(existing)],
        groupId: existing.groupId
      };
    }

    var sheet = ledgerSheet_(doc);
    var stamp = String(new Date().getTime());
    var startIndex = 0;
    if (sheet.getLastRow() >= 2) {
      var lastId = String(sheet.getRange(sheet.getLastRow(), 1, 1, 1).getValues()[0][0] || "");
      var prefix = stamp + "_";
      if (lastId.indexOf(prefix) === 0) {
        var suffix = Number(lastId.slice(prefix.length));
        if (isFinite(suffix) && suffix >= 0) startIndex = Math.floor(suffix) + 1;
      }
    }

    var createdAt = new Date().toISOString();
    var groupId = String(payload.groupId || "").trim() || newEntryGroupId_();
    var transactions = [];
    var rows = [];

    for (var i = 0; i < prepared.length; i++) {
      var item = prepared[i];
      var snapshot = buildRateSnapshot_(item.period, item.currency, item.rateType);
      var amount = Number(item.amount);
      var transaction = {
        id: stamp + "_" + (startIndex + i),
        requestId: requestBase + "_" + i,
        createdAt: createdAt,
        updatedAt: "",
        createdBy: String(item.createdBy || "").slice(0, 120),
        source: TX_SOURCES[item.source] ? item.source : TX_SOURCE_WEB,
        period: String(item.period),
        tenant: String(item.tenant).trim(),
        type: item.type,
        amount: amount,
        currency: item.currency,
        rateBuy: snapshot.rateBuy,
        rateSell: snapshot.rateSell,
        rateUsed: snapshot.rateUsed,
        rateType: snapshot.rateType,
        amountUZS: Math.round(item.currency === "USD" ? amount * snapshot.rateUsed : amount),
        method: item.method,
        comment: String(item.comment || "").slice(0, 2000),
        status: TX_STATUS_ACTIVE,
        relatedId: "",
        msgId: String(payload.msgId || ""),
        schemaVersion: LEDGER_SCHEMA_VERSION,
        groupId: groupId,
        entryKind: normalizeEntryKind_(payload.entryKind)
      };
      transactions.push(transaction);
      rows.push(transactionToLedgerRow_(transaction));
    }

    appendLedgerRows_(sheet, rows);
    appendTransactionCreatedAuditsBatch_(doc, transactions);

    var output = [];
    for (var o = 0; o < transactions.length; o++) output.push(ledgerToLegacyShape_(transactions[o]));
    return {
      status: "success",
      duplicate: false,
      transaction: output[0],
      transactions: output,
      groupId: groupId
    };
  } finally {
    lock.releaseLock();
  }
}

/** Preserve every existing single-row caller; only the explicit `lines` shape batches. */
var createTransactionBeforeWritePerf_ = createTransaction_;
createTransaction_ = function (doc, input) {
  if (input && Array.isArray(input.lines) && input.lines.length > 0) {
    return createTransactionBatch_(doc, input);
  }
  return createTransactionBeforeWritePerf_(doc, input);
};
