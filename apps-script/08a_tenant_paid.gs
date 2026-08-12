// ============================================================
// Tenant-paid-on-our-behalf expenses
// ------------------------------------------------------------
// A tenant sometimes settles one of our bills directly — the electrician, say
// — and the amount comes off what they owe us.
//
// That is two accounting facts, and it always was: the tenant paid us
// (income), and the bill was paid (expense). Entering them as two separate
// transactions worked, but nothing recorded that they were the same event, so
// either half could be edited or deleted on its own, the group received two
// unrelated reports, and history showed two rows the reader had to pair up
// mentally.
//
// This is one operation that writes both rows, under one Entry_Group_ID, in a
// single spreadsheet write. Either both exist or neither does.
// ============================================================

/**
 * The expense source that makes the cash impact net to zero.
 *
 * No money passed through our safe or our account: the tenant paid the
 * supplier. Booking the expense against the same method the credit was
 * recorded under leaves cash and bank exactly where they were, which is the
 * whole point — the tenant's balance moves, our cash does not.
 */
function tenantPaidExpenseSource_(method) {
  return method === "Bank" ? "Umumiy Bankdan" : "Umumiy Naqd Puldan";
}

/** The tenant list as configured, through the same reader the app uses. */
function configuredTenants_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return [];
  return normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
}

/** The two source names that are expense buckets rather than tenants. */
function isExpenseSourceName_(name) {
  var text = String(name || "").trim();
  return text === "Umumiy Naqd Puldan" || text === "Umumiy Bankdan";
}

/**
 * The configured tenant of that name, or null.
 *
 * Matched on the trimmed name, which is the identity the whole app already
 * uses: the ledger stores the name, `Omad_Tenants` is keyed by it, and the
 * balance is computed by grouping rows on it. Anything that does not match one
 * of those names has no balance to credit, whatever it is.
 */
function findConfiguredTenant_(tenants, name) {
  var wanted = String(name || "").trim();
  var list = Array.isArray(tenants) ? tenants : [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name || "").trim() === wanted) return list[i];
  }
  return null;
}

/**
 * Whether the tenant's agreement covers this period.
 *
 * Deliberately *not* `isTenantInScheduleForPeriod_`: that also refuses a
 * tenant whose record is marked inactive, which is right for "what should this
 * tenant be billed now" and wrong here. A tenant who moved out in March still
 * legitimately paid a February bill on our behalf, and recording it late — or
 * correcting it a year later — has to stay possible. The agreement window is
 * the honest boundary; the active flag is about today, not about history.
 *
 * A tenant with no window configured is covered for every period, which is how
 * every existing tenant record behaves.
 */
function tenantAgreementCoversPeriod_(tenant, period) {
  var t = tenant || {};
  if (!isCanonicalPeriod_(period)) return false;
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return false;
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return false;
  return true;
}

/**
 * @param {object} input     the request
 * @param {Array}  tenants   the configured tenant list, normalized
 */
function validateTenantPaidInput_(input, tenants) {
  var payload = input || {};

  if (!isCanonicalPeriod_(payload.period)) return "Davr noto'g'ri (masalan 2026-01).";

  var tenant = String(payload.tenant || "").trim();
  if (!tenant) return "Ijarachi tanlanmagan.";
  if (tenant.length > 200) return "Ijarachi nomi juda uzun.";
  // The income half has to land on a tenant's balance. An expense bucket has
  // no balance to credit, and choosing one would silently produce an entry
  // that cancels itself out and means nothing.
  if (isExpenseSourceName_(tenant)) return "Ijarachi tanlang — umumiy kassa bo'lmaydi.";

  // A non-empty string is not a tenant. Until now any text at all was accepted
  // and credited, which invents a balance nobody owes and quietly corrupts the
  // debt figure the whole app is for.
  var configured = findConfiguredTenant_(tenants, tenant);
  if (!configured) return "Bunday ijarachi ro'yxatda yo'q: " + tenant;

  // Backdating is legitimate; backdating outside the agreement is not.
  if (!tenantAgreementCoversPeriod_(configured, payload.period)) {
    return "Bu davr ijarachining shartnomasiga kirmaydi: " + tenant + " (" + payload.period + ").";
  }

  var amount = Number(payload.amount);
  if (!isFinite(amount) || amount <= 0) return "Summa musbat raqam bo'lishi kerak.";
  if (amount > 1e15) return "Summa juda katta.";

  if (payload.currency !== "UZS" && payload.currency !== "USD") return "Valyuta noto'g'ri.";
  if (payload.method !== "Naqd" && payload.method !== "Bank") return "To'lov usuli noto'g'ri.";

  // The purpose is what makes the expense half readable a year from now, so it
  // is required here even though an ordinary entry's comment is optional.
  var purpose = String(payload.comment || "").trim();
  if (!purpose) return "Chiqim maqsadini kiriting.";
  if (purpose.length > 2000) return "Izoh juda uzun.";

  var requestId = String(payload.requestId || "").trim();
  if (!requestId) return "requestId talab qilinadi.";
  if (requestId.length > 128) return "requestId juda uzun.";

  var groupId = String(payload.groupId || "").trim();
  if (groupId.length > 128) return "groupId juda uzun.";

  return "";
}

/** The comment stored on each half, so either row reads correctly alone. */
function tenantPaidComment_(half, tenant, purpose) {
  if (half === "income") return "Ijarachi bizning nomimizdan to'ladi: " + purpose;
  return purpose + " (to'lovchi: " + tenant + ")";
}

/**
 * Creates the linked income/expense pair for one tenant-paid expense.
 *
 * Idempotent on the group id: a double click, a retried request or a
 * redelivered Telegram update all resolve to the pair the first call created,
 * because the client mints the group id once and keeps it. Returns the pair
 * either way, so the caller cannot tell a retry from the original except by
 * the `duplicate` flag.
 */
function createTenantPaidExpense_(doc, input) {
  var validationError = validateTenantPaidInput_(input, configuredTenants_(doc));
  if (validationError) return { status: "error", message: validationError };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var replaceGroupId = String((input && input.replaceGroupId) || "").trim();
    if (replaceGroupId) return replaceTenantPaidExpense_(doc, input, replaceGroupId);

    var groupId = String(input.groupId || "").trim() || newEntryGroupId_();
    var ledgerLive = isLedgerActive_(doc);

    var existing = ledgerLive
      ? findLedgerRowsByGroupId_(doc, groupId).map(ledgerToLegacyShape_)
      : findTransactionsByGroupId_(doc, groupId);
    if (existing.length > 0) {
      return { status: "success", duplicate: true, groupId: groupId, transactions: existing };
    }

    var written = ledgerLive
      ? writeTenantPaidToLedger_(doc, input, groupId)
      : writeTenantPaidToLegacySheet_(doc, input, groupId);

    appendAuditRow_(doc, "tenant_paid_expense_created", JSON.stringify({
      groupId: groupId, tenant: String(input.tenant).trim(),
      amount: Number(input.amount), currency: input.currency, period: String(input.period)
    }));

    return { status: "success", duplicate: false, groupId: groupId, transactions: written };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rewrites an existing pair, as a pair.
 *
 * Both halves go together or neither does — editing one side of a
 * tenant-paid expense is never a coherent thing to want, so the whole group is
 * replaced under the same group id. Keeping the id also keeps the group's
 * Telegram message, so the report is edited in place rather than a second one
 * appearing next to a stale first.
 *
 * Called with the script lock already held.
 */
function replaceTenantPaidExpense_(doc, input, groupId) {
  var ledgerLive = isLedgerActive_(doc);
  var existing = ledgerLive
    ? findLedgerRowsByGroupId_(doc, groupId)
    : findTransactionsByGroupId_(doc, groupId);

  if (existing.length === 0) return { status: "error", message: "O'zgartiriladigan yozuv topilmadi." };
  if (!isTenantPaidGroup_(existing)) {
    return { status: "error", message: "Bu yozuv ijarachi to'lovi emas." };
  }

  var msgId = "";
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].msgId) { msgId = String(existing[i].msgId); break; }
  }

  var replacement;
  if (ledgerLive) {
    // Append-only: the old rows are cancelled, never rewritten.
    for (var c = 0; c < existing.length; c++) {
      if (existing[c].status !== TX_STATUS_ACTIVE) continue;
      setLedgerStatus_(ledgerSheet_(doc), existing[c].rowNumber, TX_STATUS_CANCELLED, new Date().toISOString());
    }
    replacement = writeTenantPaidToLedger_(doc, input, groupId);
  } else {
    var keep = [];
    var all = readOmadTransactions_(doc);
    for (var k = 0; k < all.length; k++) {
      if (String(all[k].groupId || "") !== groupId) keep.push(all[k]);
    }
    replacement = buildLegacyTenantPaidRows_(input, groupId, msgId);
    archiveChangedOmadTransactions_(doc, all, keep.concat(replacement));
    safeRewriteOmadTransactions_(doc, normalizeTransactions_(keep.concat(replacement)));
    replacement = normalizeTransactions_(replacement);
  }

  appendAuditRow_(doc, "tenant_paid_expense_replaced", JSON.stringify({
    groupId: groupId, tenant: String(input.tenant).trim(),
    amount: Number(input.amount), currency: input.currency, period: String(input.period)
  }));

  return {
    status: "success", duplicate: false, replaced: true,
    groupId: groupId, messageId: msgId, transactions: replacement
  };
}

/** The two legacy rows of one pair, not yet written anywhere. */
function buildLegacyTenantPaidRows_(input, groupId, msgId) {
  var tenant = String(input.tenant).trim();
  var purpose = String(input.comment).trim();
  var requestId = String(input.requestId).trim();
  var baseId = String(new Date().getTime());

  var common = {
    month: String(input.period),
    amount: Number(input.amount),
    currency: input.currency,
    method: input.method,
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
    msgId: msgId || "",
    groupId: groupId,
    entryKind: ENTRY_KIND_TENANT_PAID
  };

  return [
    Object.assign({}, common, {
      id: baseId + "_0",
      tenant: tenant,
      type: "Income",
      comment: tenantPaidComment_("income", tenant, purpose),
      requestId: requestId + "_0"
    }),
    Object.assign({}, common, {
      id: baseId + "_1",
      tenant: tenantPaidExpenseSource_(input.method),
      type: "Expense",
      comment: tenantPaidComment_("expense", tenant, purpose),
      requestId: requestId + "_1"
    })
  ];
}

/** The pair as two legacy rows, appended in one write. */
function writeTenantPaidToLegacySheet_(doc, input, groupId) {
  return appendOmadTransactionGroup_(doc, buildLegacyTenantPaidRows_(input, groupId, ""));
}

/** The same pair as two ledger rows, also appended in one write. */
function writeTenantPaidToLedger_(doc, input, groupId) {
  var tenant = String(input.tenant).trim();
  var purpose = String(input.comment).trim();
  var amount = Number(input.amount);
  var requestId = String(input.requestId).trim();
  var period = String(input.period);
  var now = new Date().toISOString();
  var snapshot = buildRateSnapshot_(period, input.currency, input.rateType);
  var baseId = String(new Date().getTime());

  var common = {
    createdAt: now,
    updatedAt: "",
    createdBy: String(input.createdBy || "").slice(0, 120),
    source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
    period: period,
    amount: amount,
    currency: input.currency,
    rateBuy: snapshot.rateBuy,
    rateSell: snapshot.rateSell,
    rateUsed: snapshot.rateUsed,
    rateType: snapshot.rateType,
    // Both halves freeze the same converted value, so the pair nets to exactly
    // zero however the rate moves afterwards.
    amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
    method: input.method,
    status: TX_STATUS_ACTIVE,
    relatedId: "",
    msgId: "",
    schemaVersion: LEDGER_SCHEMA_VERSION,
    groupId: groupId,
    entryKind: ENTRY_KIND_TENANT_PAID
  };

  var pair = [
    Object.assign({}, common, {
      id: baseId + "_0",
      requestId: requestId + "_0",
      tenant: tenant,
      type: "Income",
      comment: tenantPaidComment_("income", tenant, purpose)
    }),
    Object.assign({}, common, {
      id: baseId + "_1",
      requestId: requestId + "_1",
      tenant: tenantPaidExpenseSource_(input.method),
      type: "Expense",
      comment: tenantPaidComment_("expense", tenant, purpose)
    })
  ];

  appendLedgerRows_(ledgerSheet_(doc), pair.map(transactionToLedgerRow_));
  return pair.map(ledgerToLegacyShape_);
}

// ------------------------------------------------------------------ reporting

/** True when a group is the linked pair rather than an ordinary entry. */
function isTenantPaidGroup_(group) {
  if (!group || group.length === 0) return false;
  for (var i = 0; i < group.length; i++) {
    if (normalizeEntryKind_(group[i].entryKind) !== ENTRY_KIND_TENANT_PAID) return false;
  }
  return true;
}

/**
 * One report for the pair, not two.
 *
 * Two separate reports were the actual complaint: the group saw an income and
 * an unrelated expense minutes apart and had to work out that they were the
 * same event. This says what happened once, and states the cash impact
 * explicitly, because "we recorded an expense and our cash did not move" is
 * the part that looks wrong until it is spelled out.
 */
function buildTenantPaidReportMessage_(group, balances) {
  var rates = getOmadRates_();
  var income = null;
  var expense = null;
  for (var i = 0; i < group.length; i++) {
    if (group[i].type === "Income") income = group[i];
    else expense = group[i];
  }
  var primary = income || group[0];

  var period = transactionPeriod_(primary);
  var periodText = formatPeriodLabel_(period) || "Noma'lum";
  var valueUZS = transactionUZS_(primary, rates);
  var amountText = Number(primary.amount || 0).toLocaleString() + " " + primary.currency;

  var lines = [
    "🔄 IJARACHI BIZNING NOMIMIZDAN TO'LADI",
    "",
    "🏢 Ijarachi: " + (String(primary.tenant || "").trim() || "Noma'lum"),
    "📅 Davr: " + periodText,
    "💵 Summa: " + amountText,
    "💳 Usul: " + String(primary.method || ""),
    "📝 Maqsad: " + (String((expense && expense.comment) || primary.comment || "").trim() || "Kiritilmagan"),
    "",
    "🟢 Ijarachiga hisoblandi: +" + formatUZS_(valueUZS) + " UZS",
    "🔴 Chiqim yozildi: −" + formatUZS_(valueUZS) + " UZS",
    "⚖️ Kassaga ta'siri: 0 UZS",
    "",
    "📊 HISOBOT:",
    "🔹 " + periodText + " qoldig'i: " + formatUZS_(balances.monthBalance) + " UZS",
    "🏦 Umumiy balans: " + formatUZS_(balances.allTimeBalance) + " UZS"
  ];

  return lines.join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}
