// ============================================================
// System and data status
// ------------------------------------------------------------
// Everything the "Tizim va Ma'lumotlar" settings section shows: backups,
// migration state, the retry queue, recent audit history, schema version and
// the last successful server operation.
//
// Diagnostics here are deliberately *safe*: counts, timestamps and event names
// only. No secrets, no transaction amounts, no message contents.
// ============================================================

var SYSTEM_LAST_OPERATION_KEY = "Omad_Last_Operation";
var AUDIT_TAIL_SIZE = 20;

/** Records that a server operation completed. Never throws. */
function recordLastOperation_(doc, operation) {
  try {
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
    setConfig(configSheet, SYSTEM_LAST_OPERATION_KEY, JSON.stringify({
      operation: String(operation || ""),
      at: new Date().toISOString()
    }));
  } catch (error) {}
}

function sheetRowCount_(doc, name) {
  var sheet = doc.getSheetByName(name);
  return sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
}

/** The most recent Omad_Backups row, without its snapshot payload. */
function latestBackupInfo_(doc) {
  var sheet = doc.getSheetByName("Omad_Backups");
  if (!sheet || sheet.getLastRow() < 2) return { count: 0, lastAt: "", lastReason: "" };

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(lastRow, 1, 1, 3).getValues()[0];
  var snapshot = safeParseJSON_(values[2], null);

  return {
    count: lastRow - 1,
    lastAt: String(values[0] || ""),
    lastReason: String(values[1] || ""),
    // Size only - the snapshot itself is never returned to the browser.
    lastTransactionCount: snapshot && Array.isArray(snapshot.transactions)
      ? snapshot.transactions.length : 0
  };
}

/** The tail of the audit log: timestamps and event names, details truncated. */
function recentAuditEntries_(doc, limit) {
  var sheet = doc.getSheetByName("Omad_Audit_Log");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var size = Math.min(limit || AUDIT_TAIL_SIZE, sheet.getLastRow() - 1);
  var start = sheet.getLastRow() - size + 1;
  var values = sheet.getRange(start, 1, size, 3).getValues();

  var entries = [];
  for (var i = values.length - 1; i >= 0; i--) {
    entries.push({
      at: String(values[i][0] || ""),
      event: String(values[i][1] || ""),
      details: redactSecrets_(values[i][2]).slice(0, 300)
    });
  }
  return entries;
}

function buildSystemStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var lastOperation = configSheet
    ? safeParseJSON_(getConfig(configSheet, SYSTEM_LAST_OPERATION_KEY), null)
    : null;

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    activeSheet: activeTransactionSheetName_(doc),
    ledgerActive: isLedgerActive_(doc),
    backup: latestBackupInfo_(doc),
    migration: getMigrationStatus_(doc),
    queue: buildJobQueueStatus_(doc),
    audit: recentAuditEntries_(doc, AUDIT_TAIL_SIZE),
    lastOperation: lastOperation,
    counts: {
      legacyTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_SHEET),
      ledgerTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_V2_SHEET),
      archive: sheetRowCount_(doc, "Omad_Transaction_Archive"),
      auditLog: sheetRowCount_(doc, "Omad_Audit_Log"),
      backups: sheetRowCount_(doc, "Omad_Backups"),
      jobs: sheetRowCount_(doc, JOB_QUEUE_SHEET)
    }
  };
}

/** Writes a snapshot on demand and reports the result. */
function createManualBackup_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "manual");
  appendAuditRow_(doc, "manual_backup_created", "");
  recordLastOperation_(doc, "create_backup");
  return { status: "success", backup: latestBackupInfo_(doc) };
}

/**
 * Puts failed jobs back in the queue for one more round of attempts.
 * Used by the "retry" control in System and Data.
 */
function retryFailedJobs_(doc) {
  var read = readJobRows_(doc);
  if (!read.sheet) return { status: "success", retried: 0 };

  var retried = 0;
  for (var i = 0; i < read.rows.length; i++) {
    if (read.rows[i].status !== JOB_STATUS_FAILED) continue;
    writeJobField_(read.sheet, read.rows[i].rowNumber, 5, JOB_STATUS_PENDING);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 6, 0);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 7, new Date().toISOString());
    writeJobField_(read.sheet, read.rows[i].rowNumber, 10, "");
    retried++;
  }

  if (retried > 0) {
    appendAuditRow_(doc, "failed_jobs_retried", String(retried));
    recordLastOperation_(doc, "retry_failed_jobs");
  }
  return { status: "success", retried: retried, queue: buildJobQueueStatus_(doc) };
}
