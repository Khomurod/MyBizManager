// ============================================================
// API routing
// ------------------------------------------------------------
// The only two entry points Apps Script exposes. They validate, dispatch and
// format responses; all business logic lives in the modules above.
// ============================================================

// ------------------------------------------------------------- role sets
//
// Every gated action names the roles that may perform it, here, in one place.
// The three web "roles" used to be a choice of which page opened: the server
// saw one key and one permission level, so a café seller who edited two
// localStorage values could read the ledger and run a migration. These lists
// are what make the roles real, and they are enforced on the server where a
// browser cannot reach them.

/** Anybody who is signed in, whichever role they hold. */
var AUTH_ROLES_ANY = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN, AUTH_ROLE_CAFE_SELLER];

/** The accounting, the settings, the migration, the maintenance, the tasks. */
var AUTH_ROLES_OMAD_ADMIN = [AUTH_ROLE_OMAD_ADMIN];

/** Reading the café: the till, the café manager, and the owner. */
var AUTH_ROLES_CAFE_READ = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN, AUTH_ROLE_CAFE_SELLER];

/** Editing the catalogue: prices, recipes, categories, the daily target. */
var AUTH_ROLES_CAFE_ADMIN = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN];

/** Ringing up, voiding and closing the day. */
var AUTH_ROLES_CAFE_SELL = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_SELLER];

function doPost(e) {
  // Anything memoised for the life of a request starts empty. Apps Script
  // gives each execution a fresh global scope so this is already true in
  // production, but saying it here means the guarantee is in the code rather
  // than in an assumption about the runtime -- and it is what makes the memos
  // safe under a test harness that serves many requests from one load.
  resetRequestMemos_();

  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var isTelegramWebhook = false;

  try {
    var payload = JSON.parse((e.postData && e.postData.contents) || "{}");
    var action = payload.action;
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

    // ---- Telegram webhook -------------------------------------------------
    if (!action && (payload.message || payload.callback_query)) {
      isTelegramWebhook = true;
      // Apps Script cannot read request headers, so Telegram's
      // X-Telegram-Bot-Api-Secret-Token is not observable here. The safest
      // mechanism actually available is a high-entropy secret in the webhook
      // URL itself, which is exactly what setWebhook stores and only Telegram
      // ever learns. Requests without it are dropped before any state changes.
      if (!isVerifiedTelegramWebhookRequest_(e)) {
        debugLog_(doc, "telegram_webhook_rejected", "missing or invalid webhook secret");
        return okHtmlOutput_();
      }
      // Task callbacks and Tasks-group photo/reply messages are handled in
      // their own namespace, entirely separate from the private /yangi flow.
      // Everything else falls through to the accounting handler unchanged.
      if (isTaskTelegramUpdate_(payload)) {
        return handleTaskTelegramUpdate_(payload, doc, configSheet);
      }
      return handleOmadTelegramUpdate_(payload, doc, configSheet);
    }

    // ---- Telegram Mini App ------------------------------------------------
    // Placed before everything else so a mini_* action can never fall through
    // into a handler with a different gate. Authorized by verified Telegram
    // initData only; the admin key is neither sent to it nor accepted from it.
    if (isMiniAppAction_(action)) {
      return handleMiniAppAction_(action, payload, doc);
    }

    // ---- Sign in ----------------------------------------------------------
    // The only unauthenticated action there is. It is routed after the Mini
    // App and before everything else so nothing can reach a gated handler
    // through it, and it never answers with anything but a token.
    if (action === 'login') {
      return jsonOutput_(loginAction_(payload));
    }

    // ---- Task management --------------------------------------------------
    if (isTaskAction_(action)) {
      return handleTaskAction_(action, payload, doc);
    }

    // ---- Session & account ------------------------------------------------
    // verify_access is what a page calls on load to find out whether its stored
    // session is still good and which role it carries, so every signed-in role
    // may call it.
    if (action === 'verify_access' || action === 'change_password') {
      var sessionAuth = authorizeWebRequest_(payload, AUTH_ROLES_ANY);
      if (!sessionAuth.ok) return authRefusal_(sessionAuth);
      if (action === 'change_password') return jsonOutput_(changePasswordAction_(sessionAuth, payload));
      return jsonOutput_({
        status: "success", role: sessionAuth.role, username: sessionAuth.username,
        home: AUTH_ROLE_HOME[sessionAuth.role] || "login.html",
        bootstrap: !!sessionAuth.bootstrap
      });
    }

    if (action === 'set_user_password' || action === 'list_users') {
      var accountAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!accountAuth.ok) return authRefusal_(accountAuth);
      if (action === 'list_users') return jsonOutput_({ status: "success", users: listAuthUsers_() });
      return jsonOutput_(setUserPasswordAction_(payload));
    }

    // ---- Authenticated reads ----------------------------------------------
    // The financial ledger, the tenant list and the whole café state are the
    // business's private data, and the two reads are gated differently: a café
    // seller has no business reading the ledger, and could previously do so by
    // editing one localStorage value.
    if (action === 'get_omad_data' || action === 'get_omad_history') {
      var omadReadAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!omadReadAuth.ok) return authRefusal_(omadReadAuth);
      if (action === 'get_omad_history') return jsonOutput_(readOmadHistoryPage_(doc, payload));
      return jsonOutput_(readOmadPayload_(doc, configSheet, payload));
    }

    // ---- The derived read model -------------------------------------------
    // Reading is what everything else does implicitly; these two exist so an
    // operator can check the summary against the ledger and rebuild it.
    if (action === 'verify_omad_read_model' || action === 'rebuild_omad_read_model') {
      var modelAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!modelAuth.ok) return authRefusal_(modelAuth);
      if (action === 'verify_omad_read_model') {
        return jsonOutput_({ status: "success", readModel: verifyOmadReadModel_(doc, configSheet) });
      }
      return jsonOutput_(rebuildOmadReadModel_(doc, configSheet));
    }

    if (action === 'get_cafe_data') {
      var cafeReadAuth = authorizeWebRequest_(payload, AUTH_ROLES_CAFE_READ);
      if (!cafeReadAuth.ok) return authRefusal_(cafeReadAuth);
      return jsonOutput_(readCafePayloadForScope_(doc, configSheet, payload));
    }

    // ---- Omad ledger ------------------------------------------------------
    // Financial writes are omad_admin only. They were reachable by anyone who
    // knew the /exec URL, which meant anyone could rewrite the whole ledger.
    if (action === 'migrate_omad' || action === 'save_omad') {
      var saveAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!saveAccess.ok) return authRefusal_(saveAccess);
      return saveOmadAction_(action, payload, doc, configSheet);
    }

    if (action === 'tenant_paid_expense') {
      var pairAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!pairAccess.ok) return authRefusal_(pairAccess);
      return tenantPaidExpenseAction_(payload, doc, configSheet);
    }

    // ---- Append-only ledger -----------------------------------------------
    if (isLedgerAction_(action)) {
      var ledgerAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!ledgerAccess.ok) return authRefusal_(ledgerAccess);
      return ledgerAction_(action, payload, doc);
    }

    // ---- Retry queue ------------------------------------------------------
    if (action === 'get_job_queue_status') {
      var queueAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!queueAccess.ok) return authRefusal_(queueAccess);
      return jsonOutput_({ status: "success", queue: buildJobQueueStatus_(doc) });
    }

    if (action === 'process_jobs') {
      var jobsAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!jobsAccess.ok) return authRefusal_(jobsAccess);
      var processed = processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
      return jsonOutput_({ status: "success", processed: processed, queue: buildJobQueueStatus_(doc) });
    }

    // ---- Telegram settings ------------------------------------------------
    // The view carries no secret, but it does carry the authorized user id and
    // both group chat ids -- enough to know exactly who and where to target.
    if (action === 'get_telegram_settings') {
      var settingsAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!settingsAccess.ok) return authRefusal_(settingsAccess);
      return jsonOutput_({ status: "success", settings: buildTelegramSettingsView_() });
    }

    if (isTelegramAdminAction_(action)) {
      return telegramAdminAction_(action, payload);
    }

    // ---- System & data ----------------------------------------------------
    // Counts and event names only, but the audit tail names tasks, people and
    // operations, and the counts describe the size of the business.
    if (action === 'get_system_status') {
      var statusAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!statusAccess.ok) return authRefusal_(statusAccess);
      return jsonOutput_({ status: "success", system: buildSystemStatus_(doc) });
    }

    if (action === 'create_backup' || action === 'retry_failed_jobs') {
      var systemAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!systemAccess.ok) return authRefusal_(systemAccess);
      var systemResult = action === 'create_backup'
        ? createManualBackup_(doc)
        : retryFailedJobs_(doc);
      systemResult.system = buildSystemStatus_(doc);
      return jsonOutput_(systemResult);
    }

    // ---- Maintenance ------------------------------------------------------
    if (isMaintenanceAction_(action)) {
      return maintenanceAction_(action, payload, doc);
    }

    // ---- Health & Mini App configuration ----------------------------------
    if (action === 'get_health' || action === 'configure_mini_app') {
      var healthAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!healthAccess.ok) return authRefusal_(healthAccess);
      if (action === 'configure_mini_app') return jsonOutput_(configureMiniApp_(payload));
      return jsonOutput_({ status: "success", health: buildHealthReport_(doc) });
    }

    // ---- Migration --------------------------------------------------------
    if (action === 'get_migration_status') {
      var migrationRead = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!migrationRead.ok) return authRefusal_(migrationRead);
      return jsonOutput_({ status: "success", migration: getMigrationStatus_(doc) });
    }

    if (isMigrationAction_(action)) {
      var migrationAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!migrationAccess.ok) return authRefusal_(migrationAccess);
      return migrationAction_(action, payload, doc);
    }

    // ---- Café -------------------------------------------------------------
    var cafeResponse = handleCafeAction_(action, payload, doc, configSheet);
    if (cafeResponse) return cafeResponse;

    return jsonOutput_({ status: "error", message: "Unknown action" });
  } catch (error) {
    if (isTelegramWebhook) {
      // Never return a non-200 to Telegram: it would redeliver the update.
      try {
        debugLog_(doc, "telegram_webhook_error", error.toString());
      } catch (logError) {}
      return okHtmlOutput_();
    }
    return jsonOutput_({ status: "error", message: error.toString() });
  }
}

/**
 * The GET surface, which is now entirely inert.
 *
 * Nothing readable is served over GET at all: a GET puts its parameters in the
 * URL, and the URL is the one place an access key must never be, so every
 * authenticated read is a POST. This exists to answer the browser, the uptime
 * check and the curious with the same sentence.
 */
function doGet(e) {
  // Nothing here reads System_Config today. It is reset anyway so that "every
  // entry point starts with empty memos" stays true of the code rather than of
  // one reading of it.
  resetRequestMemos_();

  var action = (e && e.parameter && e.parameter.action) || "";

  if (action === 'get_tasks') {
    // A GET puts its parameters in the URL, which is exactly where an admin key
    // must never be. Task reads are POST-only.
    return jsonOutput_({
      status: "error",
      message: "Vazifalar ma'lumoti faqat POST va admin kaliti bilan olinadi."
    });
  }

  // `get_omad` and `get_cafe` used to answer here, unauthenticated, and that
  // was the whole exposure: the /exec URL is hardcoded in pages served from a
  // public site, so everyone who had seen the frontend could read the ledger,
  // the tenant list and every café sale with its margin. They are gone. The
  // authenticated replacements are get_omad_data / get_cafe_data over POST,
  // where the key travels in the body instead of the URL.
  //
  // Nothing is special-cased for them: an unknown action falls through to the
  // banner below, so they are indistinguishable from any other name someone
  // might try.
  return ContentService.createTextOutput("System Database is Active.");
}

/**
 * Saves the Omad state and queues the report the browser asked for.
 * The financial write and the report are deliberately separate: the report is
 * a retryable job that can never fail the save and can never duplicate it.
 */
function saveOmadAction_(action, payload, doc, configSheet) {
  var reportError = validateOmadTelegramReport_(payload.telegramReport);
  if (reportError) return jsonOutput_({ status: "error", message: reportError });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    backupOmadState_(doc, configSheet, action);
    safeSaveOmad_(doc, configSheet, payload);
  } finally {
    lock.releaseLock();
  }

  recordLastOperation_(doc, action);

  var queuedJobId = "";
  try {
    queuedJobId = queueOmadTransactionReport_(doc, payload.telegramReport);
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
  drainJobQueueQuietly_(doc, payload);

  return jsonOutput_({ status: "success", reportJobId: queuedJobId || "" });
}

/**
 * One tenant-paid expense: two linked rows, one group, one report.
 *
 * The backup happens before the write for the same reason every other Omad
 * write takes one. The report is queued afterwards and, as everywhere else,
 * failing to queue it never undoes a pair that is already stored.
 */
function tenantPaidExpenseAction_(payload, doc, configSheet) {
  backupOmadState_(doc, configSheet, "tenant_paid_expense");

  var result = createTenantPaidExpense_(doc, payload);
  if (result.status !== "success") return jsonOutput_(result);

  recordLastOperation_(doc, "tenant_paid_expense");

  if (!result.duplicate) {
    try {
      result.reportJobId = enqueueJob_(doc, "omad_transaction_report", result.groupId, {
        groupId: result.groupId,
        baseId: String((result.transactions[0] || {}).id || "").split("_")[0],
        // An edited pair keeps its group message, so the report is edited in
        // place rather than a second one appearing beside a stale first.
        messageId: String(result.messageId || "")
      }) || "";
    } catch (queueError) {
      result.reportJobId = "";
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }

  return jsonOutput_(result);
}

function isTelegramAdminAction_(action) {
  return action === 'save_telegram_settings' ||
         action === 'test_telegram_connection' ||
         action === 'send_telegram_test_message' ||
         action === 'configure_telegram_webhook';
}

/**
 * Rate limited and length-checked *before* the admin key is compared, so the
 * endpoint cannot be used to brute-force the key or to hammer Telegram.
 */
function telegramAdminAction_(action, payload) {
  var throttled = enforceRateLimit_("tg_admin", TELEGRAM_ADMIN_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (throttled) return jsonOutput_({ status: "error", message: throttled });

  var lengthError = validateTelegramPayloadLengths_(payload);
  if (lengthError) return jsonOutput_({ status: "error", message: lengthError });

  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  if (action === 'save_telegram_settings') return jsonOutput_(saveTelegramSettings_(payload));
  if (action === 'test_telegram_connection') return jsonOutput_(testTelegramConnection_());
  if (action === 'send_telegram_test_message') return jsonOutput_(sendTelegramTestMessage_());
  return jsonOutput_(configureTelegramWebhook_(payload));
}

/**
 * Everything omad_admin.html needs on load, in one round trip.
 *
 * `migration` used to be a second request the page fired immediately after
 * this one, which on Apps Script is another cold-start-and-lock round trip
 * before the dashboard can decide whether the ledger is live. It is four
 * Script Property reads, so it rides along.
 */
function readOmadPayload_(doc, configSheet, payload) {
  if (String((payload && payload.scope) || "") === "dashboard") {
    return readOmadDashboardPayload_(doc, configSheet);
  }
  return {
    status: "success",
    transactions: readOmadTransactions_(doc),
    tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), { "Fevral": 12500 }),
    templateExpenses: normalizeTemplateExpenses_(
      safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), [])),
    migration: getMigrationStatus_(doc)
  };
}

/**
 * What the dashboard needs, without the ledger.
 *
 * The whole transaction history used to travel to the browser on every load so
 * that four figures and a tenant list could be derived from it there — hundreds
 * of rows down the wire, and a full pass over the ledger sheet to produce them,
 * for a screen that shows totals. The totals come from the read model instead;
 * the history arrives page by page when somebody opens Tarix.
 *
 * Before cutover this still answers with the whole list, because the legacy
 * save path submits it back: a screen that may have to write the list must be
 * holding all of it. That path is dormant while V2 is live and exists for a
 * rollback, and this is the one place that difference is decided.
 */
function readOmadDashboardPayload_(doc, configSheet) {
  var body = {
    status: "success",
    scope: "dashboard",
    tenants: normalizeTenantList_(safeParseJSON_(getConfigOnce_(configSheet, "Omad_Tenants"), [])),
    rates: safeParseJSON_(getConfigOnce_(configSheet, "Omad_Rates"), { "Fevral": 12500 }),
    templateExpenses: normalizeTemplateExpenses_(
      safeParseJSON_(getConfigOnce_(configSheet, "Omad_Template_Expenses"), [])),
    migration: getMigrationStatus_(doc)
  };

  if (!isLedgerActive_(doc)) {
    body.historyMode = "full";
    body.transactions = readOmadTransactions_(doc);
    return body;
  }

  var model = omadReadModel_(doc, configSheet);
  body.historyMode = "paged";
  body.summary = {
    builtAt: model.builtAt,
    rows: model.rows,
    balances: model.balances,
    periods: model.periods,
    periodList: model.periodList
  };
  body.recent = omadRecentForPeriod_(doc, model, "", OMAD_READ_MODEL_RECENT);
  return body;
}

/** How many business actions one history page carries. */
var OMAD_HISTORY_PAGE_GROUPS = 40;

/**
 * One page of history, as whole business actions.
 *
 * Paged by *group* rather than by row, because a group is what the screen
 * draws and what an edit and a cancellation both operate on: handing back half
 * of a tenant-paid pair would let one side of it be edited alone. Every row of
 * every group on the page is returned, so the client's existing grouping,
 * editing and cancellation code is unchanged — it simply holds a page of the
 * ledger instead of all of it.
 */
function readOmadHistoryPage_(doc, payload) {
  var options = payload || {};
  var period = isCanonicalPeriod_(options.period) ? String(options.period) : "";
  var offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  var limit = Math.min(200, Math.max(1, Math.floor(Number(options.limit) || OMAD_HISTORY_PAGE_GROUPS)));

  var transactions = readOmadTransactions_(doc);
  var order = [];
  var groups = {};
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (period && transactionPeriod_(t) !== period) continue;
    var key = String(t.groupId || "");
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(t);
  }

  // Newest first: the later period wins, and within a period the later id.
  order.sort(function (a, b) {
    var rowsA = groups[a][0];
    var rowsB = groups[b][0];
    var periodOrder = String(transactionPeriod_(rowsB)).localeCompare(String(transactionPeriod_(rowsA)));
    if (periodOrder !== 0) return periodOrder;
    return (Number(String(rowsB.id).split("_")[0]) || 0) - (Number(String(rowsA.id).split("_")[0]) || 0);
  });

  var page = order.slice(offset, offset + limit);
  var rows = [];
  for (var g = 0; g < page.length; g++) {
    var groupRows = groups[page[g]];
    for (var r = 0; r < groupRows.length; r++) rows.push(groupRows[r]);
  }

  return {
    status: "success",
    period: period,
    offset: offset,
    limit: limit,
    groupTotal: order.length,
    groupCount: page.length,
    hasMore: offset + page.length < order.length,
    transactions: rows
  };
}

function isMaintenanceAction_(action) {
  return action === 'audit_transaction_dates' ||
         action === 'fix_transaction_dates' ||
         action === 'backfill_entry_group_ids' ||
         action === 'purge_telegram_debug_secrets' ||
         action === 'audit_telegram_secret_exposure' ||
         action === 'rotate_telegram_webhook_secret';
}

/**
 * One-off repairs to live data and live configuration.
 *
 * Every one of these reads the whole ledger, rewrites stored rows or changes a
 * credential, so all of them take the admin key — including the audit, which
 * would otherwise report on financial rows to anyone who asked.
 */
function maintenanceAction_(action, payload, doc) {
  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  if (action === 'audit_transaction_dates') {
    return jsonOutput_({ status: "success", audit: auditTransactionDates_(doc) });
  }
  if (action === 'fix_transaction_dates') {
    return jsonOutput_(fixTransposedTransactionDates_(doc, { dryRun: payload.dryRun === true }));
  }
  if (action === 'backfill_entry_group_ids') {
    return jsonOutput_(backfillEntryGroupIds_(doc));
  }
  if (action === 'purge_telegram_debug_secrets') {
    return jsonOutput_(purgeTelegramDebugSecrets_(doc));
  }
  if (action === 'audit_telegram_secret_exposure') {
    return jsonOutput_(auditTelegramSecretExposure_(doc));
  }
  return jsonOutput_(rotateTelegramWebhookSecret_(payload));
}

function isMigrationAction_(action) {
  return action === 'preview_omad_migration' ||
         action === 'apply_omad_migration' ||
         action === 'verify_omad_migration' ||
         action === 'cutover_omad_migration' ||
         action === 'rollback_omad_migration';
}

/**
 * Every migration step is admin-key protected: they read the whole ledger and
 * three of them change which sheet the app reads from.
 */
function migrationAction_(action, payload, doc) {
  var options = {
    fallbackYear: Number(payload.fallbackYear) || 0,
    allowUnresolved: payload.allowUnresolved === true
  };

  if (action === 'preview_omad_migration') {
    return jsonOutput_({ status: "success", preview: previewOmadMigration_(doc, options) });
  }
  if (action === 'apply_omad_migration') {
    var applied = applyOmadMigration_(doc, options);
    applied.migration = getMigrationStatus_(doc);
    return jsonOutput_(applied);
  }
  if (action === 'verify_omad_migration') {
    return jsonOutput_({ status: "success", verification: verifyOmadMigration_(doc) });
  }
  if (action === 'cutover_omad_migration') {
    var cutover = cutoverOmadMigration_(doc);
    cutover.migration = getMigrationStatus_(doc);
    return jsonOutput_(cutover);
  }
  var rolledBack = rollbackOmadMigration_(doc);
  rolledBack.migration = getMigrationStatus_(doc);
  return jsonOutput_(rolledBack);
}

function isLedgerAction_(action) {
  return action === 'create_transaction' ||
         action === 'correct_transaction' ||
         action === 'cancel_transaction' ||
         action === 'list_transactions' ||
         action === 'get_transaction' ||
         action === 'get_transaction_history';
}

/**
 * Individual transaction operations. They require the migrated ledger, because
 * the legacy sheet has no status column and therefore cannot record a
 * correction or a cancellation without losing the original.
 */
function ledgerAction_(action, payload, doc) {
  if (action === 'list_transactions') {
    return jsonOutput_({
      status: "success",
      transactions: isLedgerActive_(doc)
        ? listActiveTransactions_(doc, {
            period: payload.period || "",
            tenant: payload.tenant || "",
            type: payload.type || ""
          })
        : readOmadTransactions_(doc)
    });
  }

  if (action === 'get_transaction') {
    var found = getTransaction_(doc, payload.transactionId);
    if (!found) return jsonOutput_({ status: "error", message: "Tranzaksiya topilmadi." });
    return jsonOutput_({ status: "success", transaction: found });
  }

  if (action === 'get_transaction_history') {
    var history = getTransactionHistory_(doc, payload.transactionId);
    if (!history) return jsonOutput_({ status: "error", message: "Tranzaksiya topilmadi." });
    return jsonOutput_({ status: "success", history: history });
  }

  if (!isLedgerActive_(doc)) {
    return jsonOutput_({
      status: "error",
      message: "Yangi tranzaksiya tizimi hali yoqilmagan. Avval ma'lumotlarni ko'chiring."
    });
  }

  var result;
  if (action === 'create_transaction') result = createTransaction_(doc, payload);
  else if (action === 'correct_transaction') result = correctTransaction_(doc, payload);
  else result = cancelTransaction_(doc, payload);

  if (result.status === "success") {
    recordLastOperation_(doc, action);
    // The financial record is committed. Reporting is a separate retryable job,
    // and even failing to *queue* it must not undo a save the caller was about
    // to be told succeeded.
    try {
      result.reportJobId = queueLedgerReport_(doc, action, result) || "";
    } catch (queueError) {
      result.reportJobId = "";
      result.reportQueueError = redactSecrets_(queueError).slice(0, 300);
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
}

/** Queues the Telegram report that matches the operation just performed. */
function queueLedgerReport_(doc, action, result) {
  if (result.duplicate) return "";
  var transaction = result.transaction || {};

  if (action === 'cancel_transaction') {
    if (!transaction.msgId) return "";
    return enqueueJob_(doc, "omad_transaction_delete_report", transaction.id, {
      messageId: String(transaction.msgId)
    });
  }

  return enqueueJob_(doc, "omad_transaction_report", transaction.id, {
    groupId: String(transaction.groupId || ""),
    baseId: String(transaction.id).split("_")[0],
    messageId: String(transaction.msgId || "")
  });
}
