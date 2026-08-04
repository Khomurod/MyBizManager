// ============================================================
// Omad transactions
// ------------------------------------------------------------
// The financial ledger: read, normalise, append and rewrite.
// ============================================================

var OMAD_TRANSACTION_HEADER = [
  "ID", "Tenant", "Month", "Type", "Amount", "Currency", "Method", "Date", "Comment",
  "Telegram_Msg_ID", "Request_ID"
];

function ensureOmadTransactionHeader_(sheet) {
  var header = OMAD_TRANSACTION_HEADER;
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    return;
  }
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  // Upgrades a legacy 10-column header in place; existing rows keep their data
  // and simply carry an empty Request_ID.
  if (firstRow[0] !== "ID" || firstRow[header.length - 1] !== header[header.length - 1]) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function transactionToRow_(t) {
  return [
    t.id, t.tenant, t.month, t.type, t.amount, t.currency, t.method, t.date,
    t.comment || "", t.msgId || "", t.requestId || ""
  ];
}

function normalizeTransactions_(transactions) {
  var safeTransactions = Array.isArray(transactions) ? transactions : [];
  var normalized = [];
  for (var i = 0; i < safeTransactions.length; i++) normalized.push(normalizeTransaction_(safeTransactions[i]));
  return normalized;
}

function normalizeTransaction_(raw) {
  var t = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(t.id || (Date.now() + "_0")),
    tenant: String(t.tenant || "").trim(),
    month: String(t.month || getCurrentUzbekMonth_()).trim(),
    type: t.type === "Expense" ? "Expense" : "Income",
    amount: Number(t.amount) || 0,
    currency: t.currency === "USD" ? "USD" : "UZS",
    method: t.method === "Bank" ? "Bank" : "Naqd",
    date: t.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
    comment: t.comment || "",
    msgId: t.msgId || "",
    requestId: String(t.requestId || "")
  };
}

function readOmadTransactions_(doc) {
  var txSheet = doc.getSheetByName("Omad_Transactions");
  var transactions = [];
  if (txSheet && txSheet.getLastRow() > 1) {
    var data = txSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      transactions.push({
        id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
        amount: data[i][4], currency: data[i][5], method: data[i][6],
        date: data[i][7], comment: data[i][8], msgId: data[i][9],
        // Legacy 10-column rows simply have no request id.
        requestId: data[i].length > 10 ? data[i][10] : ""
      });
    }
  }
  return transactions;
}

/** Returns the existing transaction for a request id, or null. */
function findTransactionByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var all = readOmadTransactions_(doc);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].requestId || "") === String(requestId)) return all[i];
  }
  return null;
}

/** Transactions whose id is "<baseId>" or "<baseId>_<n>". */
function findTransactionGroup_(doc, baseId) {
  var all = readOmadTransactions_(doc);
  var group = [];
  var prefix = String(baseId) + "_";
  for (var i = 0; i < all.length; i++) {
    var id = String(all[i].id || "");
    if (id === String(baseId) || id.indexOf(prefix) === 0) group.push(all[i]);
  }
  return group;
}

function safeRewriteOmadTransactions_(doc, incomingTransactions) {
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
  ensureOmadTransactionHeader_(txSheet);

  var lastRow = txSheet.getLastRow();
  if (lastRow > 1) {
    txSheet.getRange(2, 1, lastRow - 1, OMAD_TRANSACTION_HEADER.length).clearContent();
  }

  var rows = [];
  for (var i = 0; i < incomingTransactions.length; i++) {
    rows.push(transactionToRow_(incomingTransactions[i]));
  }
  if (rows.length > 0) {
    txSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function appendOmadTransaction_(doc, transaction) {
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
  ensureOmadTransactionHeader_(txSheet);
  txSheet.appendRow(transactionToRow_(normalizeTransaction_(transaction)));
}

function updateOmadTransactionMsgId_(doc, transactionId, msgId) {
  if (!msgId) return;
  var txSheet = doc.getSheetByName("Omad_Transactions");
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(transactionId)) {
      txSheet.getRange(i + 1, 10).setValue(msgId);
      return;
    }
  }
}

function safeSaveOmad_(doc, configSheet, payload) {
  var incomingTransactions = normalizeTransactions_(payload.transactions || []);
  var existingTransactions = readOmadTransactions_(doc);
  if (existingTransactions.length > 0 && incomingTransactions.length === 0 && payload.allowEmptyOmadTransactions !== true) {
    throw new Error("Refusing to overwrite Omad transactions with an empty payload without allowEmptyOmadTransactions=true");
  }
  archiveChangedOmadTransactions_(doc, existingTransactions, incomingTransactions);
  safeRewriteOmadTransactions_(doc, incomingTransactions);
  setConfig(configSheet, "Omad_Tenants", JSON.stringify(mergeTenantsByName_(
    normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    normalizeTenantList_(payload.tenants || [])
  )));
  setConfig(configSheet, "Omad_Rates", JSON.stringify(payload.rates || {}));
  setConfig(configSheet, "Omad_Template_Expenses", JSON.stringify(normalizeTemplateExpenses_(payload.templateExpenses || [])));
}
