// ============================================================
// API routing
// ------------------------------------------------------------
// The only two entry points Apps Script exposes. They validate, dispatch and
// format responses; all business logic lives in the modules above.
// ============================================================

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

    // ---- Task management --------------------------------------------------
    if (isTaskAction_(action)) {
      return handleTaskAction_(action, payload, doc);
    }

    // ---- Authenticated reads ----------------------------------------------
    // The financial ledger, the tenant list and the whole café state are the
    // business's private data. get_omad / get_cafe still answer an anonymous
    // GET for one release so the deployed frontend cannot break between the
    // static-host and Apps Script rollouts; these are what the UI now calls,
    // and the anonymous routes are removed once the live host serves the
    // current build.
    if (action === 'verify_access' || action === 'get_omad_data' || action === 'get_cafe_data') {
      return authenticatedReadAction_(action, payload, doc, configSheet);
    }

    // ---- Omad ledger ------------------------------------------------------
    // Financial writes take the access key. They were reachable by anyone who
    // knew the /exec URL, which meant anyone could rewrite the whole ledger.
    if (action === 'migrate_omad' || action === 'save_omad') {
      var saveAccessError = checkAdminKey_(payload);
      if (saveAccessError) return jsonOutput_({ status: "error", message: saveAccessError });
      return saveOmadAction_(action, payload, doc, configSheet);
    }

    if (action === 'tenant_paid_expense') {
      var pairAccessError = checkAdminKey_(payload);
      if (pairAccessError) return jsonOutput_({ status: "error", message: pairAccessError });
      return tenantPaidExpenseAction_(payload, doc, configSheet);
    }

    // ---- Append-only ledger -----------------------------------------------
    if (isLedgerAction_(action)) {
      var ledgerAccessError = checkAdminKey_(payload);
      if (ledgerAccessError) return jsonOutput_({ status: "error", message: ledgerAccessError });
      return ledgerAction_(action, payload, doc);
    }

    // ---- Retry queue ------------------------------------------------------
    if (action === 'get_job_queue_status') {
      var queueAccessError = checkAdminKey_(payload);
      if (queueAccessError) return jsonOutput_({ status: "error", message: queueAccessError });
      return jsonOutput_({ status: "success", queue: buildJobQueueStatus_(doc) });
    }

    if (action === 'process_jobs') {
      var jobsAdminError = checkAdminKey_(payload);
      if (jobsAdminError) return jsonOutput_({ status: "error", message: jobsAdminError });
      var processed = processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
      return jsonOutput_({ status: "success", processed: processed, queue: buildJobQueueStatus_(doc) });
    }

    // ---- Telegram settings ------------------------------------------------
    // The view carries no secret, but it does carry the authorized user id and
    // both group chat ids -- enough to know exactly who and where to target.
    if (action === 'get_telegram_settings') {
      var settingsAccessError = checkAdminKey_(payload);
      if (settingsAccessError) return jsonOutput_({ status: "error", message: settingsAccessError });
      return jsonOutput_({ status: "success", settings: buildTelegramSettingsView_() });
    }

    if (isTelegramAdminAction_(action)) {
      return telegramAdminAction_(action, payload);
    }

    // ---- System & data ----------------------------------------------------
    // Counts and event names only, but the audit tail names tasks, people and
    // operations, and the counts describe the size of the business.
    if (action === 'get_system_status') {
      var statusAccessError = checkAdminKey_(payload);
      if (statusAccessError) return jsonOutput_({ status: "error", message: statusAccessError });
      return jsonOutput_({ status: "success", system: buildSystemStatus_(doc) });
    }

    if (action === 'create_backup' || action === 'retry_failed_jobs') {
      var systemAdminError = checkAdminKey_(payload);
      if (systemAdminError) return jsonOutput_({ status: "error", message: systemAdminError });
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
      var healthAdminError = checkAdminKey_(payload);
      if (healthAdminError) return jsonOutput_({ status: "error", message: healthAdminError });
      if (action === 'configure_mini_app') return jsonOutput_(configureMiniApp_(payload));
      return jsonOutput_({ status: "success", health: buildHealthReport_(doc) });
    }

    // ---- Migration --------------------------------------------------------
    if (action === 'get_migration_status') {
      var migrationReadError = checkAdminKey_(payload);
      if (migrationReadError) return jsonOutput_({ status: "error", message: migrationReadError });
      return jsonOutput_({ status: "success", migration: getMigrationStatus_(doc) });
    }

    if (isMigrationAction_(action)) {
      var migrationAdminError = checkAdminKey_(payload);
      if (migrationAdminError) return jsonOutput_({ status: "error", message: migrationAdminError });
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

  var adminError = checkAdminKey_(payload);
  if (adminError) return jsonOutput_({ status: "error", message: adminError });

  if (action === 'save_telegram_settings') return jsonOutput_(saveTelegramSettings_(payload));
  if (action === 'test_telegram_connection') return jsonOutput_(testTelegramConnection_());
  if (action === 'send_telegram_test_message') return jsonOutput_(sendTelegramTestMessage_());
  return jsonOutput_(configureTelegramWebhook_(payload));
}

/**
 * Reads that require the access key.
 *
 * Throttled before the key is compared, exactly as the Telegram admin actions
 * are, so the endpoint cannot be used to guess it.
 */
function authenticatedReadAction_(action, payload, doc, configSheet) {
  var throttled = enforceRateLimit_("read_auth", TELEGRAM_ADMIN_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (throttled) return jsonOutput_({ status: "error", message: throttled });

  var accessError = checkAdminKey_(payload);
  if (accessError) return jsonOutput_({ status: "error", message: accessError });

  if (action === 'verify_access') return jsonOutput_({ status: "success" });
  if (action === 'get_omad_data') return jsonOutput_(readOmadPayload_(doc, configSheet));
  return jsonOutput_(readCafeState_(doc, configSheet));
}

/** The Omad read payload, shared by the authenticated and legacy routes. */
function readOmadPayload_(doc, configSheet) {
  return {
    status: "success",
    transactions: readOmadTransactions_(doc),
    tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), { "Fevral": 12500 }),
    templateExpenses: normalizeTemplateExpenses_(
      safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), []))
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
  var adminError = checkAdminKey_(payload);
  if (adminError) return jsonOutput_({ status: "error", message: adminError });

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
