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

/** Stable per-line id that also records the original cart size. */
function batchRequestId_(requestBase, count, index) {
  return String(requestBase) + "__n" + String(count) + "_" + String(index);
}

/**
 * Parses request ids that belong to one batch submission.
 *
 * Counted ids bind an idempotency key to the cart shape itself. The
 * legacy <base>_<line> shape is still recognised so a request written
 * by the immediately previous deployment can be answered safely, but
 * it is never resumed because it does not say how many lines the
 * original request intended to contain.
 */
function parseBatchRequestId_(requestId, requestBase) {
  var value = String(requestId || "");
  var countedPrefix = String(requestBase) + "__n";
  if (value.indexOf(countedPrefix) === 0) {
    var tail = value.slice(countedPrefix.length);
    var separator = tail.indexOf("_");
    if (separator <= 0) return { format: "invalid", count: 0, index: -1 };
    var countText = tail.slice(0, separator);
    var indexText = tail.slice(separator + 1);
    if (!/^\d+$/.test(countText) || !/^\d+$/.test(indexText)) {
      return { format: "invalid", count: 0, index: -1 };
    }
    var declaredCount = Number(countText);
    var countedIndex = Number(indexText);
    if (!isFinite(declaredCount) || !isFinite(countedIndex) ||
        declaredCount < 1 || declaredCount > 50 || countedIndex < 0 ||
        countedIndex >= declaredCount) {
      return { format: "invalid", count: 0, index: -1 };
    }
    return { format: "counted", count: declaredCount, index: countedIndex };
  }

  var legacyPrefix = String(requestBase) + "_";
  if (value.indexOf(legacyPrefix) === 0) {
    var legacyText = value.slice(legacyPrefix.length);
    if (/^\d+$/.test(legacyText)) {
      return { format: "legacy", count: 0, index: Number(legacyText) };
    }
  }
  return null;
}

/**
 * Finds rows already written for this submission using one narrow
 * Request_ID-column pass.
 *
 * A counted request may be a partial rollout fallback and can safely
 * resume because every stored line says the original total line count.
 * A legacy request may only be accepted when every requested line is
 * already present; otherwise changing the cart size could silently
 * expand or shrink a financial request after an uncertain response.
 */
function findExistingBatchLines_(sheet, requestBase, count) {
  var result = {
    lines: new Array(count),
    format: "",
    storedCount: 0,
    conflict: false
  };
  if (!sheet || sheet.getLastRow() < 2) return result;

  var values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var requestId = String(values[i][0] || "");
    var parsed = parseBatchRequestId_(requestId, requestBase);
    if (!parsed) continue;
    if (parsed.format === "invalid") {
      result.conflict = true;
      continue;
    }
    if (result.format && result.format !== parsed.format) {
      result.conflict = true;
      continue;
    }
    result.format = parsed.format;
    if (parsed.format === "counted" && parsed.count !== count) {
      result.conflict = true;
      continue;
    }
    if (parsed.index < 0 || parsed.index >= count) {
      result.conflict = true;
      continue;
    }

    var rowNumber = i + 2;
    var raw = sheet.getRange(rowNumber, 1, 1, LEDGER_HEADER.length).getValues()[0];
    var transaction = ledgerRowToTransaction_(raw, rowNumber);
    if (transaction.status === TX_STATUS_VOID) continue;
    if (result.lines[parsed.index] &&
        result.lines[parsed.index].requestId !== transaction.requestId) {
      result.conflict = true;
      continue;
    }
    result.lines[parsed.index] = transaction;
  }

  for (var j = 0; j < result.lines.length; j++) {
    if (result.lines[j]) result.storedCount++;
  }
  if (result.format === "legacy" && result.storedCount > 0 && result.storedCount !== count) {
    result.conflict = true;
  }
  return result;
}

/** True when an already-written rollout line is exactly the line being retried. */
function batchLineMatches_(transaction, item, groupId, entryKind) {
  if (!transaction || transaction.status !== TX_STATUS_ACTIVE) return false;
  var expectedRateType = item.currency === "USD"
    ? (item.rateType === "buy" ? "buy" : "sell")
    : "none";
  return transaction.groupId === groupId &&
    transaction.entryKind === entryKind &&
    transaction.period === String(item.period) &&
    transaction.tenant === String(item.tenant).trim() &&
    transaction.type === item.type &&
    Number(transaction.amount) === Number(item.amount) &&
    transaction.currency === item.currency &&
    transaction.method === item.method &&
    transaction.rateType === expectedRateType &&
    String(transaction.comment || "") === String(item.comment || "").slice(0, 2000) &&
    transaction.source === (TX_SOURCES[item.source] ? item.source : TX_SOURCE_WEB) &&
    String(transaction.createdBy || "") === String(item.createdBy || "").slice(0, 120);
}

/** Uses one frozen pair of period rates for every line of one business action. */
function batchRateSnapshot_(item, frozenRates) {
  var appliedType = item.rateType === "buy" ? "buy" : "sell";
  var buy = Number(frozenRates.rateBuy) || 0;
  var sell = Number(frozenRates.rateSell) || 0;
  return {
    rateBuy: buy,
    rateSell: sell,
    rateUsed: item.currency === "USD" ? (appliedType === "buy" ? buy : sell) : 1,
    rateType: item.currency === "USD" ? appliedType : "none"
  };
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
 * rows use <requestId>__n<count>_<line>, binding the idempotency key to
 * the cart shape so a lost response can be retried without duplicating,
 * expanding or shrinking any part of the entry.
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
    var existingLookup = findExistingBatchLines_(sheet, requestBase, prepared.length);
    if (existingLookup.conflict) {
      return {
        status: "error",
        code: "batch_retry_conflict",
        message: "Qayta urinish avval saqlangan yozuv shakli bilan mos kelmadi. Ma'lumot o'zgartirilmadi."
      };
    }
    var existingLines = existingLookup.lines;
    var existingCount = 0;
    var firstExisting = null;
    for (var e = 0; e < existingLines.length; e++) {
      if (!existingLines[e]) continue;
      existingCount++;
      if (!firstExisting) firstExisting = existingLines[e];
    }

    if (existingCount > 1) {
      for (var r = 0; r < existingLines.length; r++) {
        if (!existingLines[r] || existingLines[r] === firstExisting) continue;
        if (Number(existingLines[r].rateBuy) !== Number(firstExisting.rateBuy) ||
            Number(existingLines[r].rateSell) !== Number(firstExisting.rateSell)) {
          return {
            status: "error",
            code: "batch_retry_conflict",
            message: "Qayta urinish avval saqlangan kurslar bilan mos kelmadi. Ma'lumot o'zgartirilmadi."
          };
        }
      }
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
    var createdAt = firstExisting ? firstExisting.createdAt : new Date().toISOString();
    var frozenRates;
    if (firstExisting) {
      frozenRates = { rateBuy: firstExisting.rateBuy, rateSell: firstExisting.rateSell };
    } else {
      var initialRates = buildRateSnapshot_(prepared[0].period, "UZS", "sell");
      frozenRates = { rateBuy: initialRates.rateBuy, rateSell: initialRates.rateSell };
    }
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
      var snapshot = batchRateSnapshot_(item, frozenRates);
      var amount = Number(item.amount);
      var transaction = {
        id: stamp + "_" + (startIndex + newCounter),
        requestId: batchRequestId_(requestBase, prepared.length, i),
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
