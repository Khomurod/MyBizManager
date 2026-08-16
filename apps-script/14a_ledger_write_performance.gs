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
  // keeps the same behaviour everywhere. Request ids have always been
  // case-sensitive strings, so TextFinder is told to preserve that rule.
  if (typeof idRange.createTextFinder === "function") {
    var finder = idRange.createTextFinder(wanted).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
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
 * Finds any rows already written by the old line-by-line browser during a
 * frontend/backend rollout. One narrow Request_ID-column read answers every
 * expected line, so recovering a partial legacy submission does not re-create
 * the full-ledger scan this module removes.
 */
function findExistingBatchLines_(sheet, requestBase, count) {
  var found = new Array(count);
  if (!sheet || sheet.getLastRow() < 2) return found;

  var wanted = {};
  for (var w = 0; w < count; w++) wanted[requestBase + "_" + w] = w;

  var values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var requestId = String(values[i][0] || "");
    if (wanted[requestId] === undefined) continue;
    var rowNumber = i + 2;
    var raw = sheet.getRange(rowNumber, 1, 1, LEDGER_HEADER.length).getValues()[0];
    var transaction = ledgerRowToTransaction_(raw, rowNumber);
    if (transaction.status !== TX_STATUS_VOID) found[wanted[requestId]] = transaction;
  }
  return found;
}

/** True when an already-written rollout line is exactly the line being retried. */
function batchLineMatches_(transaction, item, groupId, entryKind) {
  if (!transaction || transaction.status !== TX_STATUS_ACTIVE) return false;
  return transaction.groupId === groupId &&
    transaction.entryKind === entryKind &&
    transaction.period === String(item.period) &&
    transaction.tenant === String(item.tenant).trim() &&
    transaction.type === item.type &&
    Number(transaction.amount) === Number(item.amount) &&
    transaction.currency === item.currency &&
    transaction.method === item.method &&
    String(transaction.comment || "") === String(item.comment || "").slice(0, 2000) &&
    transaction.source === (TX_SOURCES[item.source] ? item.source : TX_SOURCE_WEB) &&
    String(transaction.createdBy || "") === String(item.createdBy || "").slice(0, 120);
}

/** Next suffix for a group of rows written together right now. */
function nextBatchIdIndex_(sheet, stamp) {
  var index = 0;
  if (!sheet || sheet.getLastRow() < 2) return index;
  var lastId = String(sheet.getRange(sheet.getLastRow(), 1, 1, 1).getValues()[0][0] || "");
  var prefix = stamp + "_";
  if (lastId.indexOf(prefix) !== 0) return index;
  var suffix = Number(lastId.slice(prefix.length));
  if (isFinite(suffix) && suffix >= 0) index = Math.floor(suffix) + 1;
  return index;
}

/**
 * Creates every line of one new business entry under one lock and normally one
 * ledger setValues call. The request id is one stable submission id; stored
 * rows use <requestId>_<line>, so a lost response can be retried without
 * duplicating any part of the entry.
 *
 * There is one deliberate recovery exception to the one-write rule. During a
 * deployment the new frontend can briefly meet the old backend and fall back
 * to the old line-by-line API. If that connection dies halfway through, the
 * later batch request verifies those exact already-written lines and appends
 * only the missing remainder. It never assumes that seeing line 0 means the
 * whole entry landed.
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
    var sheet = ledgerSheet_(doc);
    var existingLines = findExistingBatchLines_(sheet, requestBase, prepared.length);
    var existingCount = 0;
    var firstExisting = null;
    for (var e = 0; e < existingLines.length; e++) {
      if (!existingLines[e]) continue;
      existingCount++;
      if (!firstExisting) firstExisting = existingLines[e];
    }

    var requestedGroupId = String(payload.groupId || "").trim();
    var groupId = requestedGroupId || (firstExisting ? firstExisting.groupId : newEntryGroupId_());
    var entryKind = normalizeEntryKind_(payload.entryKind);

    if (existingCount > 0) {
      for (var c = 0; c < prepared.length; c++) {
        if (!existingLines[c]) continue;
        if (!batchLineMatches_(existingLines[c], prepared[c], groupId, entryKind)) {
          return {
            status: "error",
            code: "batch_retry_conflict",
            message: "Qayta urinish avval saqlangan yozuv bilan mos kelmadi. Ma'lumot o'zgartirilmadi."
          };
        }
      }

      if (existingCount === prepared.length) {
        var duplicateOutput = [];
        for (var d = 0; d < existingLines.length; d++) duplicateOutput.push(ledgerToLegacyShape_(existingLines[d]));
        return {
          status: "success",
          duplicate: true,
          transaction: duplicateOutput[0],
          transactions: duplicateOutput,
          groupId: groupId
        };
      }
    }

    var stamp = String(new Date().getTime());
    var startIndex = nextBatchIdIndex_(sheet, stamp);
    var createdAt = new Date().toISOString();
    var newTransactions = [];
    var newRows = [];
    var outputByLine = new Array(prepared.length);
    var newCounter = 0;

    for (var i = 0; i < prepared.length; i++) {
      if (existingLines[i]) {
        outputByLine[i] = ledgerToLegacyShape_(existingLines[i]);
        continue;
      }

      var item = prepared[i];
      var snapshot = buildRateSnapshot_(item.period, item.currency, item.rateType);
      var amount = Number(item.amount);
      var transaction = {
        id: stamp + "_" + (startIndex + newCounter),
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
        entryKind: entryKind
      };
      newCounter++;
      newTransactions.push(transaction);
      newRows.push(transactionToLedgerRow_(transaction));
      outputByLine[i] = ledgerToLegacyShape_(transaction);
    }

    appendLedgerRows_(sheet, newRows);
    appendTransactionCreatedAuditsBatch_(doc, newTransactions);

    return {
      status: "success",
      duplicate: false,
      resumed: existingCount > 0,
      transaction: outputByLine[0],
      transactions: outputByLine,
      groupId: groupId
    };
  } finally {
    lock.releaseLock();
  }
}
