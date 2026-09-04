// ============================================================
// Write-performance API extension
// ------------------------------------------------------------
// Keeps the existing single-row ledger API untouched and adds one explicit
// batch action for a new multi-line business entry. The separate action makes
// the frontend safe while Cloudflare and Apps Script deploy at different times:
// an older backend can say "Unknown action" and the browser can fall back to
// the proven single-row path without changing the meaning of create_transaction.
// ============================================================

var isLedgerActionBeforeWritePerf_ = isLedgerAction_;
isLedgerAction_ = function (action) {
  return action === 'create_transaction_batch' ||
    action === 'create_transaction_bulk' ||
    isLedgerActionBeforeWritePerf_(action);
};

var ledgerActionBeforeWritePerf_ = ledgerAction_;
ledgerAction_ = function (action, payload, doc) {
  if (action === 'create_transaction_bulk') return bulkLedgerAction_(doc, payload);
  if (action !== 'create_transaction_batch') {
    return ledgerActionBeforeWritePerf_(action, payload, doc);
  }

  if (!isLedgerActive_(doc)) {
    return jsonOutput_({
      status: "error",
      message: "Yangi tranzaksiya tizimi hali yoqilmagan. Avval ma'lumotlarni ko'chiring."
    });
  }

  var result = createTransactionBatch_(doc, payload);
  if (result.status === "success") {
    recordLastOperation_(doc, action);
    try {
      // One report for the whole entry. Every row in the batch shares the same
      // group id, so the ordinary create report path already has the right
      // semantics and no new Telegram format is needed.
      result.reportJobId = queueLedgerReport_(doc, 'create_transaction', result) || "";
    } catch (queueError) {
      result.reportJobId = "";
      result.reportQueueError = redactSecrets_(queueError).slice(0, 300);
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
};

/**
 * `create_transaction_bulk`: many business actions, one submission.
 *
 * Routed through `isLedgerAction_` rather than the main action switch, exactly
 * as `create_transaction_batch` is, so it inherits `AUTH_ROLES_OMAD_ADMIN`
 * without a second gate to keep in step with the first.
 */
function bulkLedgerAction_(doc, payload) {
  if (!isLedgerActive_(doc)) {
    return jsonOutput_({
      status: "error",
      message: "Yangi tranzaksiya tizimi hali yoqilmagan. Avval ma'lumotlarni ko'chiring."
    });
  }

  var result = createTransactionBulk_(doc, payload);
  if (result.status === "success") {
    recordLastOperation_(doc, 'create_transaction_bulk');
    try {
      // One card per business action, queued against one read of the job queue.
      // Failing to queue never undoes a save that already succeeded.
      result.reportJobIds = result.duplicate ? [] : enqueueLedgerReportsBatch_(doc, bulkReportTargets_(result));
    } catch (queueError) {
      result.reportJobIds = [];
      result.reportQueueError = redactSecrets_(queueError).slice(0, 300);
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
}

/** `{groupId, baseId}` for each entry a bulk actually wrote. */
function bulkReportTargets_(result) {
  var targets = [];
  var entries = result.entries || [];
  for (var i = 0; i < entries.length; i++) {
    var rows = entries[i] || [];
    if (rows.length === 0) continue;
    targets.push({
      groupId: String(result.groupIds[i] || ""),
      // The same fallback the single-entry report uses, for a job that outlives
      // a deploy and meets a worker reading by base id.
      baseId: String(rows[0].id || "").split("_")[0]
    });
  }
  return targets;
}
