// ============================================================
// Telegram Mini App API
// ------------------------------------------------------------
// Every action here is authorized by authorizeMiniAppRequest_ and by nothing
// else. The admin key is never sent to the Mini App and is not accepted from
// it — a phone screen is the wrong place for the key that also unlocks the
// settings and the maintenance actions.
//
// Nothing in this file re-implements a calculation. Figures come from
// 05a_calculations.gs, tenant debt from 06_tenants.gs, tasks from
// 17_tasks_store.gs and the tenant-paid pair from 08a_tenant_paid.gs, so the
// Mini App cannot drift from the numbers the web app and the reports show.
//
// The responses are *summaries*. The café state alone is a third of a
// megabyte; sending it to a phone to be totalled there would be slow and would
// be a second implementation of the same arithmetic.
// ============================================================

var MINI_APP_RECENT_TRANSACTIONS = 15;
var MINI_APP_RECENT_SALES = 10;
var MINI_APP_RECENT_CLOSINGS = 5;

/**
 * Fields the caller may never contribute to — the answer to "who did this".
 *
 * The task engine reads all of these straight off the payload. A Mini App
 * request carries a signature that proves which Telegram account is calling,
 * so that account is the only possible author; any value arriving under these
 * names is somebody else's name being typed into an audit trail. They are
 * deleted from the payload before it reaches the engine, and the verified
 * values are written back afterwards.
 */
var MINI_IDENTITY_FIELDS = {
  completedById: true,
  completedBy: true,
  completedByName: true,
  completedSource: true,
  createdBy: true,
  proofAwaitingUserId: true
};

function isMiniAppAction_(action) {
  return String(action || "").indexOf("mini_") === 0;
}

function handleMiniAppAction_(action, payload, doc) {
  var auth = authorizeMiniAppRequest_(payload);
  if (!auth.ok) {
    return jsonOutput_({ status: "error", authorized: false, reason: auth.reason || "", message: auth.message });
  }

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

  // The first screen is Omad, so the first request answers Omad completely and
  // nothing else. It used to also build the café summary and the whole task
  // view — two more full sheet reads for tabs the user had not opened, and in
  // the task case for counts no screen ever rendered. Café and Tasks are
  // fetched when their tab is first opened.
  if (action === 'mini_home' || action === 'mini_omad') {
    var omadCtx = miniOmadContext_(doc, configSheet);
    var response = {
      status: "success", authorized: true,
      omad: buildMiniOmadSummary_(omadCtx, payload.period),
      tenants: buildMiniTenantStatus_(omadCtx, payload.period),
      transactions: buildMiniRecentEntries_(omadCtx, payload.period)
    };
    if (action === 'mini_home') response.user = auth.user;
    return jsonOutput_(response);
  }

  if (action === 'mini_cafe') {
    return jsonOutput_({ status: "success", authorized: true, cafe: buildMiniCafeSummary_(doc, configSheet) });
  }

  if (action === 'mini_tasks') {
    return jsonOutput_({
      status: "success", authorized: true,
      view: buildTaskViews_(doc, Date.now()),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  if (action === 'mini_save_transaction') return miniSaveTransaction_(doc, configSheet, payload);
  if (action === 'mini_tenant_paid') return miniTenantPaid_(doc, configSheet, payload);
  if (action === 'mini_task_action') return miniTaskAction_(doc, payload, auth);

  return jsonOutput_({ status: "error", message: "Unknown action" });
}

// ------------------------------------------------------------------- reading

/**
 * Everything the Omad screens read, fetched once per request.
 *
 * The three builders below each used to call `readOmadTransactions_` for
 * themselves, so answering one Mini App request read the whole ledger three
 * times over — and the tenant list and the rate table with it. They are the
 * same rows every time inside a single request, so they are read once here and
 * passed down.
 */
function miniOmadContext_(doc, configSheet) {
  return {
    doc: doc,
    transactions: readOmadTransactions_(doc),
    tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    rates: getOmadRates_(),
    ledgerActive: isLedgerActive_(doc)
  };
}

/** The month figures, the balances and the tenant debt total, for one period. */
function buildMiniOmadSummary_(ctx, requestedPeriod) {
  var period = isCanonicalPeriod_(requestedPeriod) ? String(requestedPeriod) : currentPeriod_();
  var transactions = ctx.transactions;
  var tenants = ctx.tenants;
  var rates = ctx.rates;
  var actuals = calculateActuals_(transactions, period);

  // calculateTenantBalance_ reports a signed difference: negative is owed.
  // Debt and surplus are derived here rather than re-deriving the rent rules.
  var debt = 0;
  var paidTenants = 0;
  for (var i = 0; i < tenants.length; i++) {
    var balance = calculateTenantBalance_(transactions, tenants[i], period);
    if (balance.difference < 0) debt += -balance.difference;
    else if (balance.expected > 0) paidTenants++;
  }

  var entry = getPeriodRate_(rates, period);
  return {
    period: period,
    periodLabel: formatPeriodLabel_(period),
    income: actuals.income,
    expense: actuals.expense,
    net: actuals.net,
    cash: actuals.cash,
    bank: actuals.bank,
    total: actuals.total,
    tenantDebt: Math.round(debt),
    tenantCount: tenants.length,
    tenantsSettled: paidTenants,
    rate: { buy: entry.buy, sell: entry.sell },
    ledgerActive: ctx.ledgerActive
  };
}

/** Per-tenant expected / paid / debt for the period, smallest debt last. */
function buildMiniTenantStatus_(ctx, requestedPeriod) {
  var period = isCanonicalPeriod_(requestedPeriod) ? String(requestedPeriod) : currentPeriod_();
  var transactions = ctx.transactions;
  var tenants = ctx.tenants;

  var rows = [];
  for (var i = 0; i < tenants.length; i++) {
    if (tenants[i].active === false) continue;
    var balance = calculateTenantBalance_(transactions, tenants[i], period);
    rows.push({
      name: tenants[i].name,
      expected: Math.round(balance.expected),
      paid: Math.round(balance.paid),
      debt: Math.round(balance.difference < 0 ? -balance.difference : 0),
      surplus: Math.round(balance.difference > 0 ? balance.difference : 0)
    });
  }
  rows.sort(function (a, b) { return b.debt - a.debt; });
  return rows;
}

/**
 * Recent activity as *business actions* rather than rows.
 *
 * The Mini App shows the same thing the history tab does: a tenant-paid pair
 * is one entry, and the several lines of one payment are one entry with a
 * total, so the reader is never asked to pair rows up themselves.
 */
function buildMiniRecentEntries_(ctx, requestedPeriod) {
  var transactions = ctx.transactions;
  var period = isCanonicalPeriod_(requestedPeriod) ? String(requestedPeriod) : "";
  var rates = ctx.rates;

  var order = [];
  var groups = {};
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (period && transactionPeriod_(t) !== period) continue;
    var key = String(t.groupId || "");
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(t);
  }

  var entries = [];
  for (var g = 0; g < order.length; g++) {
    var rows = groups[order[g]];
    var first = rows[0];
    var total = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].type === "Income") total += transactionUZS_(rows[r], rates);
    }
    var tenantPaid = isTenantPaidGroup_(rows);
    var income = null;
    for (var q = 0; q < rows.length; q++) if (rows[q].type === "Income") { income = rows[q]; break; }
    var lead = tenantPaid ? (income || first) : first;
    if (!tenantPaid) {
      total = 0;
      for (var s = 0; s < rows.length; s++) total += transactionUZS_(rows[s], rates);
    }

    entries.push({
      groupId: order[g],
      id: lead.id,
      kind: tenantPaid ? ENTRY_KIND_TENANT_PAID : "",
      type: lead.type,
      tenant: lead.tenant,
      period: transactionPeriod_(lead),
      periodLabel: formatPeriodLabel_(transactionPeriod_(lead)),
      date: typeof lead.date === "object" && lead.date ? formatLedgerDate_(lead.date) : String(lead.date || ""),
      amountUZS: Math.round(total),
      currency: lead.currency,
      amount: lead.amount,
      lines: rows.length,
      comment: String(lead.comment || "").slice(0, 300)
    });
  }

  // Newest first, by the timestamp the ids encode.
  entries.sort(function (a, b) {
    return (Number(String(b.id).split("_")[0]) || 0) - (Number(String(a.id).split("_")[0]) || 0);
  });
  return entries.slice(0, MINI_APP_RECENT_TRANSACTIONS);
}

/** Today and this month, from the café sheets. Monitoring only. */
function buildMiniCafeSummary_(doc, configSheet) {
  var state = readCafeState_(doc, configSheet);
  var todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var monthKey = todayKey.slice(0, 7);

  var today = { revenue: 0, profit: 0, count: 0 };
  var month = { revenue: 0, profit: 0, count: 0 };
  var recentSales = [];

  for (var i = 0; i < state.sales.length; i++) {
    var sale = state.sales[i];
    var key = cafeDateKey_(sale.date);
    var revenue = Number(sale.total) || 0;
    var profit = Number(sale.profit) || 0;

    if (key.indexOf(monthKey) === 0) { month.revenue += revenue; month.profit += profit; month.count++; }
    if (key === todayKey) { today.revenue += revenue; today.profit += profit; today.count++; }
  }

  for (var s = Math.max(0, state.sales.length - MINI_APP_RECENT_SALES); s < state.sales.length; s++) {
    var recent = state.sales[s];
    recentSales.push({
      id: String(recent.id || ""),
      date: cafeDateKey_(recent.date),
      seller: String(recent.seller || ""),
      total: Number(recent.total) || 0,
      profit: Number(recent.profit) || 0,
      items: Array.isArray(recent.items) ? recent.items.length : 0
    });
  }
  recentSales.reverse();

  var closings = [];
  for (var c = Math.max(0, state.closeReports.length - MINI_APP_RECENT_CLOSINGS); c < state.closeReports.length; c++) {
    var close = state.closeReports[c];
    closings.push({
      date: cafeDateKey_(close.date),
      seller: String(close.seller || ""),
      revenue: Number(close.totalRevenue) || 0,
      profit: Number(close.totalProfit) || 0
    });
  }
  closings.reverse();

  var inventoryValue = 0;
  var lowStock = [];
  for (var v = 0; v < state.inventory.length; v++) {
    var item = state.inventory[v];
    var qty = Number(item.qty) || 0;
    var value = Number(item.totalCost);
    inventoryValue += isFinite(value) && value > 0 ? value : qty * (Number(item.unitCost) || 0);
    if (item.type === "product" && qty <= 3) {
      lowStock.push({ name: String(item.name || ""), qty: qty, unit: String(item.unit || "") });
    }
  }

  var target = Number((state.settings || {}).dailyTarget) || 0;
  return {
    today: { revenue: Math.round(today.revenue), profit: Math.round(today.profit), sales: today.count },
    month: { revenue: Math.round(month.revenue), profit: Math.round(month.profit), sales: month.count, label: monthKey },
    target: {
      daily: target,
      progress: target > 0 ? Math.min(100, Math.round((today.revenue / target) * 100)) : 0
    },
    inventory: {
      value: Math.round(inventoryValue),
      items: state.inventory.length,
      lowStock: lowStock.slice(0, 8)
    },
    recentSales: recentSales,
    recentClosings: closings
  };
}

/**
 * The calendar day a café record belongs to.
 *
 * Sales carry an ISO timestamp; older rows can carry whatever the sheet made
 * of them. Both are reduced to a yyyy-MM-dd key in the script timezone so
 * "today" means the same thing here as it does in the POS.
 */
function cafeDateKey_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    return isNaN(value.getTime()) ? "" : Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  var text = String(value || "");
  if (!text) return "";
  var parsed = new Date(text);
  if (isNaN(parsed.getTime())) return text.slice(0, 10);
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// ------------------------------------------------------------------ writing

/**
 * One income or expense from the Mini App.
 *
 * Written through the same append path the /yangi bot uses, so the row shape,
 * the idempotency and the queued group report are identical. The Mini App is
 * a client of the accounting rules, never a second copy of them.
 */
function miniSaveTransaction_(doc, configSheet, payload) {
  var type = payload.type === "Expense" ? "Expense" : "Income";
  var amount = Number(payload.amount);
  var period = isCanonicalPeriod_(payload.period) ? String(payload.period) : currentPeriod_();
  var tenant = String(payload.tenant || "").trim();
  var requestId = String(payload.requestId || "").trim();
  var groupId = String(payload.groupId || "").trim();

  if (!tenant) return jsonOutput_({ status: "error", message: "Obyekt tanlanmagan." });
  if (!isFinite(amount) || amount <= 0) return jsonOutput_({ status: "error", message: "Summa musbat raqam bo'lishi kerak." });
  if (amount > 1e15) return jsonOutput_({ status: "error", message: "Summa juda katta." });
  if (payload.currency !== "UZS" && payload.currency !== "USD") return jsonOutput_({ status: "error", message: "Valyuta noto'g'ri." });
  if (payload.method !== "Naqd" && payload.method !== "Bank") return jsonOutput_({ status: "error", message: "To'lov usuli noto'g'ri." });
  if (!requestId || requestId.length > 128) return jsonOutput_({ status: "error", message: "requestId talab qilinadi." });
  if (String(payload.comment || "").length > 2000) return jsonOutput_({ status: "error", message: "Izoh juda uzun." });
  // An income has to land on a tenant; only an expense may come from a bucket.
  if (type === "Income" && isExpenseSourceName_(tenant)) {
    return jsonOutput_({ status: "error", message: "Kirim uchun ijarachi tanlang." });
  }
  // ...and it has to be a tenant that exists. An income credits a balance, so
  // an unrecognised name invents debt against nobody -- the same rule the
  // tenant-paid pair already enforces, applied to the ordinary entry too.
  if (type === "Income") {
    var known = findConfiguredTenant_(
      normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])), tenant);
    if (!known) {
      return jsonOutput_({ status: "error", message: "Bunday ijarachi ro'yxatda yo'q: " + tenant });
    }
  }

  if (isLedgerActive_(doc)) {
    var created = createTransaction_(doc, {
      requestId: requestId, groupId: groupId || newEntryGroupId_(), period: period,
      tenant: tenant, type: type, amount: amount, currency: payload.currency,
      method: payload.method, comment: String(payload.comment || ""),
      createdBy: "miniapp", source: TX_SOURCE_TELEGRAM
    });
    if (created.status === "success" && !created.duplicate) {
      queueMiniTransactionReport_(doc, created.transaction);
    }
    return jsonOutput_(created);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var transaction;
  var duplicate = false;
  try {
    var existing = findTransactionByRequestId_(doc, requestId);
    if (existing) {
      transaction = normalizeTransaction_(existing);
      duplicate = true;
    } else {
      backupOmadState_(doc, configSheet, "miniapp_entry");
      transaction = normalizeTransaction_({
        id: new Date().getTime() + "_0",
        tenant: tenant, month: period, type: type, amount: amount,
        currency: payload.currency, method: payload.method,
        date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
        comment: String(payload.comment || ""), msgId: "", requestId: requestId,
        groupId: groupId || newEntryGroupId_()
      });
      appendOmadTransaction_(doc, transaction);
    }
  } finally {
    lock.releaseLock();
  }

  recordLastOperation_(doc, "mini_save_transaction");
  if (!duplicate) queueMiniTransactionReport_(doc, transaction);
  drainJobQueueQuietly_(doc, payload);

  return jsonOutput_({ status: "success", duplicate: duplicate, transaction: transaction });
}

/** Queueing a report must never undo a transaction that is already stored. */
function queueMiniTransactionReport_(doc, transaction) {
  try {
    enqueueJob_(doc, "omad_transaction_report", transaction.id, {
      groupId: String(transaction.groupId || ""),
      baseId: String(transaction.id).split("_")[0],
      messageId: ""
    });
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
}

/** The tenant-paid pair, through exactly the same code path the web app uses. */
function miniTenantPaid_(doc, configSheet, payload) {
  backupOmadState_(doc, configSheet, "miniapp_tenant_paid");
  var result = createTenantPaidExpense_(doc, {
    requestId: payload.requestId, groupId: payload.groupId,
    tenant: payload.tenant, period: payload.period, amount: payload.amount,
    currency: payload.currency, method: payload.method, comment: payload.comment,
    createdBy: "miniapp", source: TX_SOURCE_TELEGRAM
  });
  if (result.status !== "success") return jsonOutput_(result);

  recordLastOperation_(doc, "mini_tenant_paid");
  if (!result.duplicate) {
    try {
      enqueueJob_(doc, "omad_transaction_report", result.groupId, {
        groupId: result.groupId,
        baseId: String((result.transactions[0] || {}).id || "").split("_")[0],
        messageId: ""
      });
    } catch (queueError) {
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
}

/**
 * A task mutation from the Mini App.
 *
 * Delegates to the same handlers the /tasks board uses — the reminder
 * scheduling, the group cards and the occurrence bookkeeping are the existing
 * engine's, unchanged. Only the gate differs: verified initData here, the
 * admin key there.
 */
function miniTaskAction_(doc, payload, auth) {
  var taskAction = String(payload.taskAction || "");
  if (!isTaskMutationAction_(taskAction)) {
    return jsonOutput_({ status: "error", message: "Unknown action" });
  }

  var displayName = String(auth.user.firstName || "").trim() ||
    String(auth.user.username || "").trim() || String(auth.userId);

  // Who did this is decided here and nowhere else.
  //
  // These fields used to be read as `payload.completedById || auth.userId` --
  // the browser's value winning whenever it sent one. A request is just JSON,
  // so anyone who could reach this endpoint with a valid signature could file
  // a completion under somebody else's name and id, and the audit trail would
  // record it as fact. The signature proves who is calling; nothing else may
  // contribute to that answer.
  //
  // Stripped rather than overwritten, so a field added to the engine later
  // cannot quietly become spoofable by being forwarded before this runs.
  var forwarded = {};
  Object.keys(payload || {}).forEach(function (key) {
    if (MINI_IDENTITY_FIELDS[key]) return;
    forwarded[key] = payload[key];
  });

  forwarded.action = taskAction;
  // The task engine identifies a *task* by `id` and an *occurrence* by
  // `occurrenceId`. The Mini App speaks in `taskId` because that is what its
  // own view calls the field, so it is translated here rather than in four
  // separate places on the client. Without this, save/cancel/pause/resume
  // all reported "Vazifa topilmadi" and an edit silently created a second
  // task instead of changing the one on screen.
  forwarded.id = payload.id || payload.taskId || "";
  forwarded.completedById = auth.userId;
  forwarded.completedBy = displayName;
  forwarded.completedByName = displayName;
  forwarded.completedSource = "miniapp";
  // `save_task` keeps the original author when editing, so this only lands on
  // newly created tasks. `proofAwaitingUserId` is deliberately not set: the
  // engine derives it from the verified completer, and the only thing the
  // client could do with it is hand a photo-proof slot to another account.
  forwarded.createdBy = "tg:" + auth.userId;

  return runTaskAction_(taskAction, forwarded, doc);
}
