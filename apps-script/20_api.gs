// ============================================================
// API routing
// ------------------------------------------------------------
// The only two entry points Apps Script exposes. They validate, dispatch and
// format responses; all business logic lives in the modules above.
// ============================================================

function doPost(e) {
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
      return handleOmadTelegramUpdate_(payload, doc, configSheet);
    }

    // ---- Omad ledger ------------------------------------------------------
    if (action === 'migrate_omad' || action === 'save_omad') {
      return saveOmadAction_(action, payload, doc, configSheet);
    }

    // ---- Retry queue ------------------------------------------------------
    if (action === 'get_job_queue_status') {
      return jsonOutput_({ status: "success", queue: buildJobQueueStatus_(doc) });
    }

    if (action === 'process_jobs') {
      var jobsAdminError = checkAdminKey_(payload);
      if (jobsAdminError) return jsonOutput_({ status: "error", message: jobsAdminError });
      var processed = processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
      return jsonOutput_({ status: "success", processed: processed, queue: buildJobQueueStatus_(doc) });
    }

    // ---- Telegram settings ------------------------------------------------
    if (action === 'get_telegram_settings') {
      return jsonOutput_({ status: "success", settings: buildTelegramSettingsView_() });
    }

    if (isTelegramAdminAction_(action)) {
      return telegramAdminAction_(action, payload);
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

function doGet(e) {
  var action = e.parameter.action;
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");

  if (!configSheet) return jsonOutput_({ status: "empty" });

  if (action === 'get_omad') {
    return jsonOutput_({
      transactions: readOmadTransactions_(doc),
      tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
      rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), { "Fevral": 12500 }),
      templateExpenses: normalizeTemplateExpenses_(
        safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), []))
    });
  }

  if (action === 'get_cafe') {
    return jsonOutput_(readCafeState_(doc, configSheet));
  }

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

  var queuedJobId = queueOmadTransactionReport_(doc, payload.telegramReport);
  drainJobQueueQuietly_(doc);

  return jsonOutput_({ status: "success", reportJobId: queuedJobId || "" });
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
