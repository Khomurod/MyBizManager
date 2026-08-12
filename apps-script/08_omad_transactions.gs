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
  "Telegram_Msg_ID", "Request_ID", "Entry_Group_ID", "Entry_Kind"
];

/** Column 12. One business action's rows all carry the same value. */
var OMAD_GROUP_ID_COLUMN = 12;

/**
 * Column 13. *What* business action the group is.
 *
 * "" is an ordinary entry — one or more lines of a single income or expense.
 * A named kind says the group has a shape the reader must respect: the
 * tenant-paid pair is one income and one expense that only make sense
 * together, and reporting and history both need to know that without having
 * to guess it back from the rows.
 */
var OMAD_ENTRY_KIND_COLUMN = 13;

var ENTRY_KIND_ORDINARY = "";
var ENTRY_KIND_TENANT_PAID = "tenant_paid_expense";

var ENTRY_KINDS = {};
ENTRY_KINDS[ENTRY_KIND_TENANT_PAID] = true;

function normalizeEntryKind_(value) {
  var kind = String(value === null || value === undefined ? "" : value).trim();
  return ENTRY_KINDS[kind] ? kind : ENTRY_KIND_ORDINARY;
}

function ensureOmadTransactionHeader_(sheet) {
  var header = OMAD_TRANSACTION_HEADER;
  // Never stamp the thirteen-column legacy header onto the twenty-four column
  // ledger. The check below compares the first and last legacy columns, and on
  // a ledger sheet the last one is Rate_Sell -- so it would "repair" the
  // header by destroying it.
  if (sheet && sheet.getName && sheet.getName() === OMAD_TRANSACTIONS_V2_SHEET) return;
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    return;
  }
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  // Upgrades a legacy 10- or 11-column header in place; existing rows keep
  // their data and simply carry an empty Request_ID / Entry_Group_ID.
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

// ------------------------------------------------------------- entry groups
//
// A business action can be several accounting rows: two currencies on one
// payment, or the tenant-paid-on-our-behalf pair that is one income and one
// expense. Every row keeps its own transaction id; the rows that belong
// together share one immutable Entry_Group_ID.
//
// The group id is *stored*, never inferred. Timestamps collide, and the
// "<epochMillis>_<n>" id prefix cannot express a group whose rows were written
// at different times or under different ids. The only exception is the
// deterministic backfill below, which exists solely to give rows written before
// the column existed a stable identity.

var OMAD_GROUP_ID_PREFIX = "grp_";
var OMAD_LEGACY_GROUP_ID_PREFIX = "grp_legacy_";

/** A fresh, immutable group id for one new business action. */
function newEntryGroupId_() {
  return OMAD_GROUP_ID_PREFIX + Utilities.getUuid().split("-").join("");
}

/**
 * The group id for a row that predates the column.
 *
 * Deterministic, so running the backfill twice — or backfilling a row that a
 * report job already resolved in memory — always produces the same value. The
 * base of "<epochMillis>_<n>" is what the whole-list save has always used to
 * keep the lines of one entry together, so this preserves exactly the grouping
 * the data already had, without ever being consulted for a row that carries a
 * real stored group id.
 */
function legacyEntryGroupId_(transactionId) {
  var base = String(transactionId === null || transactionId === undefined ? "" : transactionId).split("_")[0];
  if (!base) return "";
  return OMAD_LEGACY_GROUP_ID_PREFIX + base;
}

/** The stored group id, or the deterministic backfill when there is none. */
function resolveEntryGroupId_(transaction) {
  var stored = String((transaction && transaction.groupId) || "").trim();
  if (stored) return stored;
  return legacyEntryGroupId_(transaction && transaction.id);
}

function transactionToRow_(t) {
  return [
    t.id, t.tenant, t.month, t.type, t.amount, t.currency, t.method,
    toSheetDateValue_(t.date),
    t.comment || "", t.msgId || "", t.requestId || "", t.groupId || "", t.entryKind || ""
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
    requestId: String(t.requestId || ""),
    // Preserved when the caller supplies one, derived deterministically when it
    // does not, so a row written before the column existed still resolves to a
    // stable group instead of to "".
    groupId: resolveEntryGroupId_(t),
    entryKind: normalizeEntryKind_(t.entryKind)
  };
}

/** The sheet reads and writes go to: the migrated V2 sheet after cutover. */
function activeTransactionSheetName_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return OMAD_TRANSACTIONS_SHEET;
  var configured = String(getConfigOnce_(configSheet, OMAD_ACTIVE_TX_SHEET_KEY) || "").trim();
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
    // Rows written before the column existed resolve to their deterministic
    // group id in memory, so every reader sees a group whether or not the
    // backfill has been run against the sheet.
    transaction.groupId = String((data[i].length > 11 ? data[i][11] : "") || "").trim() ||
      legacyEntryGroupId_(transaction.id);
    transaction.entryKind = normalizeEntryKind_(data[i].length > 12 ? data[i][12] : "");
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

/**
 * Every row of one business action, found by its stored group id.
 *
 * This is the grouping reporting, editing, cancellation and history use. It
 * asks the data what belongs together rather than deducing it from an id
 * shape, which is what lets one entry span two transaction types.
 */
function findTransactionsByGroupId_(doc, groupId) {
  var wanted = String(groupId || "").trim();
  if (!wanted) return [];
  var all = readOmadTransactions_(doc);
  var group = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].groupId || "") === wanted) group.push(all[i]);
  }
  return group;
}

/**
 * Transactions whose id is "<baseId>" or "<baseId>_<n>".
 *
 * Kept for queued jobs written before group ids existed: a job sitting on
 * Omad_Job_Queue across the deploy carries only a baseId, and must still find
 * its rows. New work goes through findTransactionsByGroupId_.
 */
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

/**
 * Appends several rows of one business action in a single write.
 *
 * One setValues call is one spreadsheet operation: either every row of the
 * group lands or none of them does. That is what makes a two-entry action —
 * the tenant-paid-on-our-behalf pair — impossible to half-create.
 */
function appendOmadTransactionGroup_(doc, transactions) {
  var rows = Array.isArray(transactions) ? transactions : [];
  if (rows.length === 0) return [];

  // The ledger has its own writer for a group -- writeTenantPaidToLedger_ --
  // because a ledger row carries a frozen rate this function has no way to
  // produce. Every caller already branches on isLedgerActive_; refusing is
  // how the next one finds out rather than discovering it in the sheet.
  if (isLedgerActive_(doc)) {
    throw new Error("appendOmadTransactionGroup_ legacy varaq uchun. Ledger uchun writeTenantPaidToLedger_ ishlating.");
  }

  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);

  var normalized = [];
  var values = [];
  for (var i = 0; i < rows.length; i++) {
    var transaction = normalizeTransaction_(rows[i]);
    normalized.push(transaction);
    values.push(transactionToRow_(transaction));
  }

  var startRow = txSheet.getLastRow() + 1;
  applyTransactionColumnFormats_(txSheet, startRow, values.length, sheetName);
  txSheet.getRange(startRow, 1, values.length, OMAD_TRANSACTION_HEADER.length).setValues(values);
  return normalized;
}

/**
 * Writes the deterministic group id onto rows that predate the column.
 *
 * Idempotent: a row that already carries a group id is left exactly as it is,
 * so this can be run repeatedly and can never re-group anything.
 */
function backfillEntryGroupIds_(doc) {
  var sheetName = activeTransactionSheetName_(doc);
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return backfillLedgerEntryGroupIds_(doc);

  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return { status: "success", filled: 0, alreadySet: 0 };

  ensureOmadTransactionHeader_(txSheet);
  var data = txSheet.getDataRange().getValues();
  var filled = 0;
  var alreadySet = 0;

  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    var current = String((data[i].length > 11 ? data[i][11] : "") || "").trim();
    if (current) { alreadySet++; continue; }
    var derived = legacyEntryGroupId_(id);
    if (!derived) continue;
    txSheet.getRange(i + 1, OMAD_GROUP_ID_COLUMN).setValue(derived);
    filled++;
  }

  if (filled > 0) appendAuditRow_(doc, "entry_group_ids_backfilled", String(filled));
  return { status: "success", filled: filled, alreadySet: alreadySet };
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

/**
 * Appends one transaction to whichever schema is live.
 *
 * The legacy row is thirteen columns and the ledger row is twenty-four, so
 * writing the legacy shape into the ledger does not merely misfile a value --
 * `ensureOmadTransactionHeader_` would first overwrite the ledger's header
 * with the legacy one, and the row would then land with Tenant in Request_ID
 * and Month in Created_At. One Telegram entry after a cutover was enough to
 * corrupt the sheet structurally.
 *
 * Callers that already branch on `isLedgerActive_` never reach the legacy path
 * below. This exists for the ones that do not: the /yangi conversation is the
 * live example, and any future caller inherits the same protection rather than
 * having to remember.
 */
function appendOmadTransaction_(doc, transaction) {
  if (isLedgerActive_(doc)) {
    var normalized = normalizeTransaction_(transaction);
    var snapshot = buildRateSnapshot_(
      transactionPeriod_(normalized), normalized.currency, transaction.rateType);
    var now = new Date().toISOString();

    appendLedgerRows_(ledgerSheet_(doc), [transactionToLedgerRow_({
      id: normalized.id,
      requestId: normalized.requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(transaction.createdBy || "").slice(0, 120),
      source: TX_SOURCES[transaction.source] ? transaction.source : TX_SOURCE_TELEGRAM,
      period: transactionPeriod_(normalized),
      tenant: normalized.tenant,
      type: normalized.type,
      amount: normalized.amount,
      currency: normalized.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(normalized.currency === "USD"
        ? normalized.amount * snapshot.rateUsed : normalized.amount),
      method: normalized.method,
      comment: normalized.comment,
      status: TX_STATUS_ACTIVE,
      relatedId: "",
      msgId: normalized.msgId,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      groupId: normalized.groupId,
      entryKind: normalized.entryKind
    })]);
    return;
  }

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
