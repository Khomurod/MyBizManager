// ============================================================
// Omad transactions
// ------------------------------------------------------------
// The financial ledger: read, normalise, append and rewrite.
//
// Reads are period-aware: every transaction comes back with a canonical
// `period` ("2026-01") resolved from its stored month and date, whether or not
// the sheet itself has been migrated yet. Reads also follow the cutover flag,
// so pointing the app at the migrated V2 sheet is a one-line config change and
// pointing it back is the rollback.
// ============================================================

var OMAD_TRANSACTIONS_SHEET = "Omad_Transactions";
var OMAD_TRANSACTIONS_V2_SHEET = "Omad_Transactions_V2";
/** System_Config key naming the sheet reads and writes go to. */
var OMAD_ACTIVE_TX_SHEET_KEY = "Omad_Active_Transactions_Sheet";

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

/**
 * The value written into the Date column.
 *
 * Text like "05/08/2026" is read back through the spreadsheet's own locale,
 * which is how 5 August became 8 May. A real date carries no ordering to
 * misread, so anything that can be understood is written as one. Text that
 * cannot be interpreted is left exactly as it is rather than guessed at.
 */
function toSheetDateValue_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    return isNaN(value.getTime()) ? "" : value;
  }
  var parsed = parseTransactionDate_(value);
  if (!parsed) return value === null || value === undefined ? "" : value;
  return new Date(parsed.year, parsed.month - 1, parsed.day || 1);
}

/**
 * Stops the spreadsheet reinterpreting what is written.
 *
 * The Month column holds "2026-08"; formatted as text it stays that way
 * instead of collapsing into 1 August. The Date column is given an explicit
 * day/month format so it also reads back the way it was written.
 *
 * These column numbers are the legacy layout's. The ledger has its own shape
 * and its own helper, so callers pass its name to opt out.
 */
function applyTransactionColumnFormats_(sheet, startRow, numRows, sheetName) {
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return;
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var monthRange = sheet.getRange(startRow, 3, numRows, 1);
  if (typeof monthRange.setNumberFormat !== "function") return;
  monthRange.setNumberFormat("@");
  sheet.getRange(startRow, 8, numRows, 1).setNumberFormat("dd/MM/yyyy");
}

function transactionToRow_(t) {
  return [
    t.id, t.tenant, t.month, t.type, t.amount, t.currency, t.method,
    toSheetDateValue_(t.date),
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
  // `month` holds the canonical period for anything written from now on.
  // Legacy month names are preserved verbatim rather than guessed at; the
  // migration is where they get a year, under operator control.
  return {
    id: String(t.id || (Date.now() + "_0")),
    tenant: String(t.tenant || "").trim(),
    // normalizeMonthValue_ keeps a period a period: a Month cell the
    // spreadsheet turned into a date becomes "2026-08" again rather than
    // being stringified into "Sat Aug 01 2026 ...".
    month: normalizeMonthValue_(t.month || t.period || currentPeriod_()),
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

/** The sheet reads and writes go to: the migrated V2 sheet after cutover. */
function activeTransactionSheetName_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return OMAD_TRANSACTIONS_SHEET;
  var configured = String(getConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY) || "").trim();
  if (configured && doc.getSheetByName(configured)) return configured;
  return OMAD_TRANSACTIONS_SHEET;
}

/**
 * Active transactions in the shape the rest of the app expects.
 *
 * After cutover this reads the append-only ledger and returns only Active
 * rows; before cutover it reads the legacy sheet and resolves periods in
 * memory. Callers do not need to know which.
 */
function readOmadTransactions_(doc) {
  if (isLedgerActive_(doc)) return listActiveTransactions_(doc, {});
  return readTransactionsFromSheet_(doc, OMAD_TRANSACTIONS_SHEET);
}

/**
 * Reads a transaction sheet and attaches the resolved canonical period to
 * every row. Used by both normal reads and the migration preview, so the
 * preview shows exactly what the app would compute.
 */
function readTransactionsFromSheet_(doc, sheetName) {
  var txSheet = doc.getSheetByName(sheetName);
  var transactions = [];
  if (!txSheet || txSheet.getLastRow() < 2) return transactions;

  var configSheet = doc.getSheetByName("System_Config");
  var fallbackYear = getFallbackYear_(configSheet);
  var data = txSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    var transaction = {
      id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
      amount: data[i][4], currency: data[i][5], method: data[i][6],
      date: data[i][7], comment: data[i][8], msgId: data[i][9],
      // Legacy 10-column rows simply have no request id.
      requestId: data[i].length > 10 ? data[i][10] : ""
    };
    var resolved = resolveTransactionPeriod_(transaction, fallbackYear);
    transaction.period = resolved.period;
    transaction.periodSource = resolved.source;
    transaction.periodLabel = formatPeriodLabel_(resolved.period);
    transactions.push(transaction);
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
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
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
    applyTransactionColumnFormats_(txSheet, 2, rows.length, sheetName);
    txSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function appendOmadTransaction_(doc, transaction) {
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);

  // Written through a range rather than appendRow so the column formats are
  // in place before the values land - afterwards would be too late.
  var row = txSheet.getLastRow() + 1;
  applyTransactionColumnFormats_(txSheet, row, 1, sheetName);
  txSheet.getRange(row, 1, 1, OMAD_TRANSACTION_HEADER.length)
    .setValues([transactionToRow_(normalizeTransaction_(transaction))]);
}

/**
 * Writes the group message id back onto a transaction. The column differs
 * between the two schemas, so it is chosen from whichever sheet is live -
 * column 10 in the legacy layout, column 21 in the ledger.
 */
function updateOmadTransactionMsgId_(doc, transactionId, msgId) {
  if (!msgId) return;
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var column = sheetName === OMAD_TRANSACTIONS_V2_SHEET ? 21 : 10;
  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(transactionId)) {
      txSheet.getRange(i + 1, column).setValue(msgId);
      return;
    }
  }
}

function safeSaveOmad_(doc, configSheet, payload) {
  // Whole-list rewrites are exactly what the append-only ledger exists to
  // prevent. Once V2 is live, transactions change only through
  // create/correct/cancel.
  if (isLedgerActive_(doc)) {
    return saveOmadSettingsOnly_(doc, configSheet, payload);
  }

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

/**
 * The non-transaction half of a save. Used once the ledger is live, where
 * tenants, rates and planned expenses are still whole-object settings but
 * transactions are not.
 */
function saveOmadSettingsOnly_(doc, configSheet, payload) {
  if (payload.tenants !== undefined) {
    setConfig(configSheet, "Omad_Tenants", JSON.stringify(mergeTenantsByName_(
      normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
      normalizeTenantList_(payload.tenants || [])
    )));
  }
  if (payload.rates !== undefined) {
    setConfig(configSheet, "Omad_Rates", JSON.stringify(payload.rates || {}));
  }
  if (payload.templateExpenses !== undefined) {
    setConfig(configSheet, "Omad_Template_Expenses",
      JSON.stringify(normalizeTemplateExpenses_(payload.templateExpenses || [])));
  }
}
