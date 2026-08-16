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
  return action === 'create_transaction_batch' || isLedgerActionBeforeWritePerf_(action);
};

var ledgerActionBeforeWritePerf_ = ledgerAction_;
ledgerAction_ = function (action, payload, doc) {
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
