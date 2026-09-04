// ============================================================
// Bulk entry
// ------------------------------------------------------------
// `create_transaction_batch` records ONE business action with several amounts:
// one tenant, one type, one period, one comment. That is the right shape for a
// rent payment split across cash and bank, and the wrong shape for the thing
// this business actually does at the start of every month, which is settle ten
// tenants at once.
//
// So this is the other axis. One submission, many *independent* business
// actions -- rent from several tenants, expenses booked against a tenant,
// expenses out of the general cash or bank buckets, and tenant-paid-on-our-
// behalf pairs -- mixed freely, each keeping its own group id, its own period
// and its own frozen rates, and each getting its own Telegram card exactly as
// if it had been entered on its own.
//
// What it does NOT do is invent a new kind of accounting. Every entry is
// validated by the same validator the single-entry path uses, and a tenant-paid
// entry is built by the very same `buildTenantPaidRows_` the single action
// calls. The only thing that is new is that they are written together.
// ============================================================

/** At most this many business actions in one submission. */
var BULK_MAX_ENTRIES = 50;

/**
 * The request id base is short so the derived per-row ids stay inside the
 * 128-character limit `validateTenantPaidInput_` enforces:
 * `<base>__b<count>_<index>_<half>` adds at most 10 characters.
 */
var BULK_MAX_REQUEST_BASE = 100;

var BULK_KIND_ORDINARY = "ordinary";
var BULK_KIND_TENANT_PAID = "tenant_paid";

/**
 * The idempotency key for one entry of one submission.
 *
 * Counted, like the batch's: the key carries the number of entries the client
 * meant to send, so a retry whose list has changed is refused rather than
 * silently expanding or shrinking a financial submission. The letter is `b`
 * where the batch uses `n`, so `parseBatchRequestId_` can never claim one of
 * these and no stored row is ever read by the wrong resume logic.
 */
function bulkRequestId_(requestBase, count, index) {
  return String(requestBase) + "__b" + count + "_" + index;
}

/**
 * Reads a stored row's request id back.
 *
 * Returns `{ count, index, half }` where `half` is -1 for an ordinary row and
 * 0 or 1 for the two halves of a tenant-paid pair (which `buildTenantPaidRows_`
 * appends). `null` means "not from this submission"; `invalid` means it claims
 * to be and is malformed, which is a conflict rather than something to skip.
 */
function parseBulkRequestId_(requestId, requestBase) {
  var value = String(requestId || "");
  var prefix = String(requestBase) + "__b";
  if (value.indexOf(prefix) !== 0) return null;

  var parts = value.slice(prefix.length).split("_");
  if (parts.length < 2 || parts.length > 3) return { invalid: true };
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return { invalid: true };
  }

  var count = Number(parts[0]);
  var index = Number(parts[1]);
  var half = parts.length === 3 ? Number(parts[2]) : -1;
  if (count < 1 || count > BULK_MAX_ENTRIES) return { invalid: true };
  if (index < 0 || index >= count) return { invalid: true };
  if (half > 1) return { invalid: true };

  return { invalid: false, count: count, index: index, half: half };
}

/**
 * The next free `<stamp>_<n>` id slot for this millisecond.
 *
 * Deliberately not `nextBatchIdIndex_`, which reads only the last row and
 * parses the whole suffix as a number. A bulk can end on a tenant-paid half,
 * whose id is `<stamp>_<n>_1` -- `Number("3_1")` is NaN, so that helper would
 * restart at 0 and a second bulk landing in the same millisecond would reuse
 * ids that are already in the ledger. Ids are what a correction, a void and a
 * delete look a row up by, so a duplicate is not cosmetic.
 */
function nextBulkIdIndex_(sheet, stamp) {
  var index = 0;
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return index;

  // Bounded: a same-millisecond burst cannot be longer than one submission's
  // worth of rows, and 200 is comfortably more than the 100 a full bulk writes.
  var howMany = Math.min(lastRow - 1, 200);
  var values = sheet.getRange(lastRow - howMany + 1, 1, howMany, 1).getValues();
  var prefix = stamp + "_";
  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][0] || "");
    if (id.indexOf(prefix) !== 0) continue;
    var tail = id.slice(prefix.length);
    var separator = tail.indexOf("_");
    if (separator >= 0) tail = tail.slice(0, separator);
    var n = Number(tail);
    if (isFinite(n) && n >= index) index = Math.floor(n) + 1;
  }
  return index;
}

/** `tenant_paid` or `ordinary`; anything unrecognised is an ordinary entry. */
function normalizeBulkKind_(kind) {
  return String(kind || "") === BULK_KIND_TENANT_PAID ? BULK_KIND_TENANT_PAID : BULK_KIND_ORDINARY;
}

/** How many ledger rows one entry of this kind occupies. */
function bulkEntryRowCount_(kind) {
  return kind === BULK_KIND_TENANT_PAID ? 2 : 1;
}

/**
 * Whether an ordinary entry names something that can carry the amount.
 *
 * `validateTransactionInput_` accepts any non-empty text as the object, which
 * is survivable when a person picks one row from a dropdown and fatal on a
 * grid of fifty: an income credited to a misspelt name invents debt against
 * nobody, and the debt figure is what this whole application is for. Both entry
 * screens already offer exactly this set — configured tenants for an income,
 * plus the two expense buckets for an expense — so this refuses only what no
 * dropdown could have produced. It is the rule `mini_save_transaction` already
 * applies to a single income.
 */
function bulkTenantError_(entry, tenants) {
  var name = String(entry.tenant || "").trim();
  if (isExpenseSourceName_(name)) {
    if (entry.type === "Income") return "Kirim uchun ijarachi tanlang — umumiy kassa bo'lmaydi.";
    return "";
  }
  if (!findConfiguredTenant_(tenants, name)) return "Bunday ijarachi ro'yxatda yo'q: " + name;
  return "";
}

/**
 * Validates every entry before anything is written.
 *
 * All of them, not the first failure's worth: a submission is all-or-nothing,
 * so finding out at entry 9 that entry 3 was wrong must not leave 1 and 2 in
 * the ledger. Returns `{ error, entryIndex }` or `{ prepared }`.
 */
function prepareBulkEntries_(doc, payload, requestBase, count) {
  var entries = payload.entries;
  var tenants = null;
  var prepared = [];

  for (var i = 0; i < count; i++) {
    var raw = entries[i] || {};
    var kind = normalizeBulkKind_(raw.kind);
    var candidate = {
      kind: kind,
      period: raw.period,
      tenant: raw.tenant,
      amount: raw.amount,
      currency: raw.currency,
      method: raw.method,
      comment: raw.comment,
      rateType: raw.rateType || payload.rateType,
      source: payload.source,
      createdBy: payload.createdBy,
      requestId: bulkRequestId_(requestBase, count, i)
    };

    var invalid;
    if (kind === BULK_KIND_TENANT_PAID) {
      // Read once, not once per entry: the tenant list is a config cell and a
      // fifty-entry submission would otherwise parse it fifty times.
      if (tenants === null) tenants = configuredTenants_(doc);
      // The pair's own validator, which is the one that enforces a real
      // configured tenant, the agreement window and a mandatory purpose.
      invalid = validateTenantPaidInput_(candidate, tenants);
    } else {
      candidate.type = raw.type;
      invalid = validateTransactionInput_(candidate);
      if (!invalid) {
        if (tenants === null) tenants = configuredTenants_(doc);
        invalid = bulkTenantError_(candidate, tenants);
      }
    }
    if (invalid) return { error: invalid, entryIndex: i };

    prepared.push(candidate);
  }

  return { prepared: prepared };
}

/**
 * Finds the rows a previous attempt at this submission already wrote.
 *
 * Returns `{ byEntry, conflict, storedEntries }`, where `byEntry[i]` is the
 * array of active rows stored for entry `i`. A conflict means the retry does
 * not describe the same submission, and the caller writes nothing at all.
 */
function findExistingBulkRows_(sheet, requestBase, count) {
  var result = { byEntry: new Array(count), conflict: false, storedEntries: 0 };
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return result;

  var values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var parsed = parseBulkRequestId_(values[i][0], requestBase);
    if (!parsed) continue;
    if (parsed.invalid || parsed.count !== count) { result.conflict = true; continue; }

    var rowNumber = i + 2;
    var transaction = ledgerRowToTransaction_(
      sheet.getRange(rowNumber, 1, 1, LEDGER_HEADER.length).getValues()[0], rowNumber);
    // A voided row is not a row this submission still owns; the entry counts
    // as missing and is written again.
    if (transaction.status === TX_STATUS_VOID) continue;

    var slot = result.byEntry[parsed.index] || (result.byEntry[parsed.index] = []);
    for (var d = 0; d < slot.length; d++) {
      if (slot[d].requestId === transaction.requestId) { result.conflict = true; break; }
    }
    slot.push(transaction);
  }

  for (var e = 0; e < count; e++) {
    if (result.byEntry[e]) result.storedEntries++;
  }
  return result;
}

/**
 * Whether the rows already stored for one entry are that same entry.
 *
 * The rate fields are deliberately not compared: they were frozen when the
 * first attempt wrote them, and freezing them again now can legitimately give
 * a different answer if the period's rate was edited in between. What must
 * match is everything the person actually typed.
 */
function bulkEntryMatches_(stored, entry) {
  var rows = stored || [];
  if (rows.length !== bulkEntryRowCount_(entry.kind)) return false;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status !== TX_STATUS_ACTIVE) return false;
    if (rows[i].period !== String(entry.period)) return false;
    if (Number(rows[i].amount) !== Number(entry.amount)) return false;
    if (rows[i].currency !== entry.currency) return false;
    if (rows[i].method !== entry.method) return false;
    if (String(rows[i].createdBy || "") !== String(entry.createdBy || "").slice(0, 120)) return false;
    if (rows[i].source !== (TX_SOURCES[entry.source] ? entry.source : TX_SOURCE_WEB)) return false;
  }

  var tenant = String(entry.tenant).trim();
  if (entry.kind === BULK_KIND_TENANT_PAID) {
    var purpose = String(entry.comment).trim();
    var income = rows[0].requestId.slice(-2) === "_0" ? rows[0] : rows[1];
    var expense = income === rows[0] ? rows[1] : rows[0];
    return normalizeEntryKind_(income.entryKind) === ENTRY_KIND_TENANT_PAID &&
      income.type === "Income" && expense.type === "Expense" &&
      income.tenant === tenant &&
      expense.tenant === tenantPaidExpenseSource_(entry.method) &&
      income.comment === tenantPaidComment_("income", tenant, purpose) &&
      expense.comment === tenantPaidComment_("expense", tenant, purpose) &&
      income.groupId === expense.groupId;
  }

  return normalizeEntryKind_(rows[0].entryKind) === ENTRY_KIND_ORDINARY &&
    rows[0].tenant === tenant &&
    rows[0].type === entry.type &&
    String(rows[0].comment || "") === String(entry.comment || "").slice(0, 2000);
}

/** The one ordinary ledger row an ordinary entry becomes. */
function buildBulkOrdinaryRow_(entry, groupId, id, createdAt) {
  var snapshot = buildRateSnapshot_(entry.period, entry.currency, entry.rateType);
  var amount = Number(entry.amount);
  return {
    id: id,
    requestId: entry.requestId,
    createdAt: createdAt,
    updatedAt: "",
    createdBy: String(entry.createdBy || "").slice(0, 120),
    source: TX_SOURCES[entry.source] ? entry.source : TX_SOURCE_WEB,
    period: String(entry.period),
    tenant: String(entry.tenant).trim(),
    type: entry.type,
    amount: amount,
    currency: entry.currency,
    rateBuy: snapshot.rateBuy,
    rateSell: snapshot.rateSell,
    rateUsed: snapshot.rateUsed,
    rateType: snapshot.rateType,
    amountUZS: Math.round(entry.currency === "USD" ? amount * snapshot.rateUsed : amount),
    method: entry.method,
    comment: String(entry.comment || "").slice(0, 2000),
    status: TX_STATUS_ACTIVE,
    relatedId: "",
    msgId: "",
    schemaVersion: LEDGER_SCHEMA_VERSION,
    groupId: groupId,
    entryKind: ENTRY_KIND_ORDINARY
  };
}

/**
 * Records many independent business actions in one submission.
 *
 * The guarantees, in the order they are enforced:
 *
 *   1. **Nothing is written until everything validates.** The whole list goes
 *      through the ordinary validators before the lock is taken.
 *   2. **One group per entry.** Each keeps its own `Entry_Group_ID`, so a
 *      correction a month later edits that one entry and its one Telegram
 *      card, exactly as if it had been entered alone.
 *   3. **Rates are frozen per entry, on that entry's own period.** This is why
 *      the batch's single shared rate pair could not be reused: settling three
 *      months at once must use each month's rate.
 *   4. **One append.** Every row of every entry goes in a single
 *      `appendLedgerRows_` call, so a bulk cannot be half-created.
 *   5. **A retry is resolved, never re-run.** The counted request id binds the
 *      key to the submitted shape; a retry with a changed list is refused.
 */
function createTransactionBulk_(doc, input) {
  var payload = input || {};
  var entries = Array.isArray(payload.entries) ? payload.entries : [];
  var count = entries.length;
  if (count === 0) return { status: "error", message: "Kamida bitta yozuv kiriting." };
  if (count > BULK_MAX_ENTRIES) {
    return { status: "error", message: "Bir yuborishda " + BULK_MAX_ENTRIES + " tadan ko'p yozuv bo'lmaydi." };
  }

  var requestBase = String(payload.requestId || "").trim();
  if (!requestBase) return { status: "error", message: "requestId talab qilinadi." };
  if (requestBase.length > BULK_MAX_REQUEST_BASE) return { status: "error", message: "requestId juda uzun." };

  var validated = prepareBulkEntries_(doc, payload, requestBase, count);
  if (validated.error) {
    return {
      status: "error",
      message: validated.error,
      // Which row to put the message under. The screen keeps everything the
      // person typed and points at the one that is wrong.
      entryIndex: validated.entryIndex
    };
  }
  var prepared = validated.prepared;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = ledgerSheet_(doc);
    var existing = findExistingBulkRows_(sheet, requestBase, count);
    var conflict = {
      status: "error",
      code: "bulk_retry_conflict",
      message: "Qayta urinish avval saqlangan yozuvlar bilan mos kelmadi. Ma'lumot o'zgartirilmadi."
    };
    if (existing.conflict) return conflict;

    for (var v = 0; v < count; v++) {
      if (!existing.byEntry[v]) continue;
      if (!bulkEntryMatches_(existing.byEntry[v], prepared[v])) return conflict;
    }

    var groupIds = new Array(count);
    var transactionsByEntry = new Array(count);
    if (existing.storedEntries === count) {
      for (var s = 0; s < count; s++) {
        groupIds[s] = existing.byEntry[s][0].groupId;
        transactionsByEntry[s] = existing.byEntry[s].map(ledgerToLegacyShape_);
      }
      return {
        status: "success", duplicate: true, resumed: false,
        groupIds: groupIds, entries: transactionsByEntry
      };
    }

    var stamp = String(new Date().getTime());
    var slot = nextBulkIdIndex_(sheet, stamp);
    var createdAt = new Date().toISOString();
    var newTransactions = [];

    for (var i = 0; i < count; i++) {
      if (existing.byEntry[i]) {
        groupIds[i] = existing.byEntry[i][0].groupId;
        transactionsByEntry[i] = existing.byEntry[i].map(ledgerToLegacyShape_);
        continue;
      }

      var entry = prepared[i];
      var groupId = newEntryGroupId_();
      var id = stamp + "_" + slot;
      slot++;

      var rows = entry.kind === BULK_KIND_TENANT_PAID
        // The identical pair the single tenant-paid action writes: same comment
        // wording, same shared frozen amountUZS, same expense bucket.
        ? buildTenantPaidRows_(entry, groupId, id, createdAt)
        : [buildBulkOrdinaryRow_(entry, groupId, id, createdAt)];

      groupIds[i] = groupId;
      transactionsByEntry[i] = rows.map(ledgerToLegacyShape_);
      for (var r = 0; r < rows.length; r++) newTransactions.push(rows[r]);
    }

    appendLedgerRows_(sheet, newTransactions.map(transactionToLedgerRow_));
    appendTransactionCreatedAuditsBatch_(doc, newTransactions);

    return {
      status: "success",
      duplicate: false,
      resumed: existing.storedEntries > 0,
      groupIds: groupIds,
      entries: transactionsByEntry
    };
  } finally {
    lock.releaseLock();
  }
}
