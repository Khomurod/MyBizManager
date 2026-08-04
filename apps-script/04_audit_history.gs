// ============================================================
// Audit history & backups
// ------------------------------------------------------------
// Nothing is ever silently overwritten: every Omad write is preceded by a full
// snapshot, and changed rows are archived.
// ============================================================

function backupOmadState_(doc, configSheet, reason) {
  var backupSheet = doc.getSheetByName("Omad_Backups") || doc.insertSheet("Omad_Backups");
  if (backupSheet.getLastRow() === 0) backupSheet.appendRow(["Timestamp", "Reason", "Snapshot_JSON"]);

  var snapshot = {
    transactions: readOmadTransactions_(doc),
    tenants: safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}),
    templateExpenses: safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), [])
  };

  backupSheet.appendRow([new Date().toISOString(), reason || "omad_write", JSON.stringify(snapshot)]);
}

function archiveChangedOmadTransactions_(doc, existingTransactions, incomingTransactions) {
  var archiveRows = [];
  var incomingById = {};
  for (var i = 0; i < incomingTransactions.length; i++) {
    incomingById[String(incomingTransactions[i].id || "")] = incomingTransactions[i];
  }

  for (var j = 0; j < existingTransactions.length; j++) {
    var existing = normalizeTransaction_(existingTransactions[j]);
    var incoming = incomingById[String(existing.id || "")];
    if (!incoming) {
      archiveRows.push([new Date().toISOString(), "omitted_from_active_payload", existing.id, JSON.stringify(existing)]);
    } else if (JSON.stringify(transactionToRow_(existing)) !== JSON.stringify(transactionToRow_(incoming))) {
      archiveRows.push([new Date().toISOString(), "before_update", existing.id, JSON.stringify(existing)]);
    }
  }

  if (archiveRows.length === 0) return;

  var archiveSheet = doc.getSheetByName("Omad_Transaction_Archive") || doc.insertSheet("Omad_Transaction_Archive");
  if (archiveSheet.getLastRow() === 0) archiveSheet.appendRow(["Timestamp", "Reason", "Transaction_ID", "Transaction_JSON"]);
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, archiveRows.length, archiveRows[0].length).setValues(archiveRows);
}

function auditTelegramSettingsChange_(updatedFields) {
  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    // Only field NAMES are stored - never values, never the token.
    sheet.appendRow([new Date().toISOString(), "telegram_settings_changed", (updatedFields || []).join(",")]);
  } catch (error) {}
}

function debugLog_(doc, eventName, details) {
  try {
    var sheet = doc.getSheetByName("Telegram_Debug_Log") || doc.insertSheet("Telegram_Debug_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), eventName, redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}
