// ============================================================
// Maintenance
// ------------------------------------------------------------
// One-off, operator-triggered repairs to live data and live configuration.
//
// Everything here is admin-key protected, backs up before it writes, is safe
// to run twice, and reports counts rather than contents. Nothing in this file
// runs on its own.
// ============================================================

// -------------------------------------------------------------- date repair
//
// Older rows show day and month transposed: the app wrote "05/08/2026" as text
// and the spreadsheet read it back through a MM/DD locale, so 5 August became
// 8 May. Writes have since been fixed (08_omad_transactions.gs writes real
// date values), and the Month/period column — not this one — is what every
// figure is calculated from, so the damage is cosmetic.
//
// It is still repairable *provably*, without guessing, because the transaction
// id is "<epochMillis>_<n>" and the app has only ever written today's date. The
// id therefore records the instant the row was created, and the correct date is
// that instant in the script's timezone. A row is corrected only when swapping
// the stored day and month reproduces the id's date exactly. Anything else —
// a row whose date disagrees for some other reason, or whose id carries no
// usable timestamp — is reported and left alone.

/** The Tashkent calendar date an id's epoch prefix refers to, or null. */
function transactionIdDateParts_(transactionId) {
  var base = String(transactionId === null || transactionId === undefined ? "" : transactionId).split("_")[0];
  if (!/^\d{12,16}$/.test(base)) return null;
  var millis = Number(base);
  if (!isFinite(millis) || millis <= 0) return null;

  var stamp = Utilities.formatDate(new Date(millis), Session.getScriptTimeZone(), "dd/MM/yyyy");
  var parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(stamp);
  if (!parts) return null;
  return { day: Number(parts[1]), month: Number(parts[2]), year: Number(parts[3]) };
}

/** The calendar date a stored Date cell holds, or null. */
function storedDateParts_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return null;
    return { day: value.getDate(), month: value.getMonth() + 1, year: value.getFullYear() };
  }
  var parsed = parseTransactionDate_(value);
  if (!parsed) return null;
  var text = String(value || "");
  var dmy = /^(\d{1,2})[\/.-]\d{1,2}[\/.-]\d{4}$/.exec(text);
  return {
    day: dmy ? Number(dmy[1]) : (parsed.day || 1),
    month: parsed.month,
    year: parsed.year
  };
}

function sameDateParts_(a, b) {
  return !!a && !!b && a.day === b.day && a.month === b.month && a.year === b.year;
}

/** True when a and b are the same date with day and month swapped. */
function transposedDateParts_(stored, fromId) {
  if (!stored || !fromId) return false;
  if (sameDateParts_(stored, fromId)) return false;
  return stored.year === fromId.year && stored.day === fromId.month && stored.month === fromId.day;
}

function formatDateParts_(parts) {
  if (!parts) return "";
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return pad(parts.day) + "/" + pad(parts.month) + "/" + parts.year;
}

var DATE_AUDIT_SAMPLE_SIZE = 25;

/**
 * Classifies every row's Date cell against the date its id proves.
 *
 * Writes nothing. The samples are capped so the response stays small; the
 * counts always cover every row.
 */
function auditTransactionDates_(doc) {
  var sheetName = activeTransactionSheetName_(doc);
  var sheet = doc.getSheetByName(sheetName);
  var result = {
    sheet: sheetName,
    total: 0,
    correct: 0,
    transposed: 0,
    unprovable: 0,
    noIdTimestamp: 0,
    transposedSample: [],
    unprovableSample: []
  };
  if (!sheet || sheet.getLastRow() < 2) return result;
  // The ledger stores an ISO Created_At rather than a display date, so it has
  // nothing to transpose.
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return result;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    result.total++;

    var fromId = transactionIdDateParts_(id);
    if (!fromId) { result.noIdTimestamp++; continue; }

    var stored = storedDateParts_(data[i][7]);
    if (sameDateParts_(stored, fromId)) { result.correct++; continue; }

    if (transposedDateParts_(stored, fromId)) {
      result.transposed++;
      if (result.transposedSample.length < DATE_AUDIT_SAMPLE_SIZE) {
        result.transposedSample.push({
          rowNumber: i + 1, id: String(id),
          stored: formatDateParts_(stored), correct: formatDateParts_(fromId)
        });
      }
      continue;
    }

    result.unprovable++;
    if (result.unprovableSample.length < DATE_AUDIT_SAMPLE_SIZE) {
      result.unprovableSample.push({
        rowNumber: i + 1, id: String(id),
        stored: formatDateParts_(stored), fromId: formatDateParts_(fromId)
      });
    }
  }
  return result;
}

/**
 * Rewrites the Date cell of every provably transposed row, and nothing else.
 *
 * Backs the whole Omad state up first. Idempotent: a row corrected by an
 * earlier run matches its id's date and is skipped. `dryRun` reports what
 * would change without touching the sheet.
 */
function fixTransposedTransactionDates_(doc, options) {
  var settings = options || {};
  var audit = auditTransactionDates_(doc);
  if (settings.dryRun === true) {
    return { status: "success", dryRun: true, audit: audit, fixed: 0 };
  }
  if (audit.transposed === 0) {
    return { status: "success", dryRun: false, audit: audit, fixed: 0 };
  }

  var sheetName = audit.sheet;
  var sheet = doc.getSheetByName(sheetName);
  if (!sheet) return { status: "error", message: "Tranzaksiya varag'i topilmadi." };

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "fix_transaction_dates");

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var fixed = 0;
  try {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var id = data[i][0];
      if (id === "" || id === null || id === undefined) continue;
      var fromId = transactionIdDateParts_(id);
      if (!fromId) continue;
      if (!transposedDateParts_(storedDateParts_(data[i][7]), fromId)) continue;

      // A real date value, not text: text is what the locale re-read in the
      // first place. The column format is reapplied so it displays day-first.
      applyTransactionColumnFormats_(sheet, i + 1, 1, sheetName);
      sheet.getRange(i + 1, 8).setValue(new Date(fromId.year, fromId.month - 1, fromId.day));
      fixed++;
    }
  } finally {
    lock.releaseLock();
  }

  appendAuditRow_(doc, "transaction_dates_corrected", JSON.stringify({
    fixed: fixed, unprovableLeftAlone: audit.unprovable
  }));
  recordLastOperation_(doc, "fix_transaction_dates");

  return { status: "success", dryRun: false, fixed: fixed, audit: auditTransactionDates_(doc) };
}

// ------------------------------------------------- historical secret cleanup
//
// Request bodies are no longer logged, so a secret cannot reach
// Telegram_Debug_Log any more. Rows written *before* that change can still
// contain the webhook verification secret, because setWebhook carries it twice.
// This re-redacts them in place, after copying the sheet.

var DEBUG_LOG_SHEET = "Telegram_Debug_Log";

/**
 * Anything left that is shaped like a high-entropy credential.
 *
 * The webhook secret is two UUIDs with the dashes removed — 64 hex characters
 * — so a bare occurrence that no `wh=` or `secret_token=` context caught is
 * still removed. Deliberately blunt: this runs over a debug log, where losing
 * a long hex identifier costs nothing and keeping a secret costs everything.
 */
function redactHighEntropyValues_(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]");
}

/** Full redaction for a stored log row: the live rules plus the blunt one. */
function redactStoredLogValue_(value) {
  return redactHighEntropyValues_(redactSecrets_(value));
}

/**
 * Copies Telegram_Debug_Log, then rewrites every Details cell through the
 * redactor. Reports how many rows changed; never returns a cell's contents.
 *
 * Safe to run twice: a row already redacted comes back identical and is left
 * alone. The backup is made once per run and named for the minute it was taken.
 */
function purgeTelegramDebugSecrets_(doc) {
  var sheet = doc.getSheetByName(DEBUG_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return { status: "success", rows: 0, redacted: 0, backupSheet: "" };
  }

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  var backupName = (DEBUG_LOG_SHEET + "_Backup_" + stamp).slice(0, 95);
  var backup = doc.getSheetByName(backupName) || doc.insertSheet(backupName);
  if (backup.getLastRow() === 0) backup.appendRow(["Timestamp", "Event", "Details"]);
  backup.getRange(backup.getLastRow() + 1, 1, values.length, 3).setValues(values);

  var redacted = 0;
  for (var i = 0; i < values.length; i++) {
    var before = values[i][2];
    var after = redactStoredLogValue_(before);
    if (after === String(before === null || before === undefined ? "" : before)) continue;
    sheet.getRange(i + 2, 3).setValue(after);
    redacted++;
  }

  appendAuditRow_(doc, "telegram_debug_log_redacted", JSON.stringify({
    rows: values.length, redacted: redacted, backupSheet: backupName
  }));
  recordLastOperation_(doc, "purge_telegram_debug_secrets");

  return { status: "success", rows: values.length, redacted: redacted, backupSheet: backupName };
}

// ------------------------------------------------------ webhook secret rotation

var TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS = "TELEGRAM_WEBHOOK_SECRET_PREVIOUS";
var TELEGRAM_PROP_WEBHOOK_ROTATED_AT = "TELEGRAM_WEBHOOK_ROTATED_AT";

function generateWebhookSecret_() {
  return Utilities.getUuid().split("-").join("") + Utilities.getUuid().split("-").join("");
}

/**
 * Replaces the webhook verification secret and re-points Telegram at it.
 *
 * The previous secret stays accepted for the length of the rotation, which is
 * what removes the race: between storing the new value and Telegram learning
 * it, an update signed with either one verifies, so no update is ever dropped.
 * It is cleared the moment Telegram confirms the new URL.
 *
 * If setWebhook or the verification fails, the old secret is put back and the
 * webhook is re-pointed at it, so a failed rotation leaves the bot exactly as
 * it was rather than deaf. The secret itself is never returned or logged.
 */
function rotateTelegramWebhookSecret_(payload) {
  if (!getBotToken_()) return { status: "error", message: "Bot token o'rnatilmagan." };

  var webhookUrl = stripWebhookSecret_(
    (payload && payload.webhookUrl) || getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || ""
  );
  if (!/^https:\/\/[^\s]+$/.test(webhookUrl)) {
    return { status: "error", message: "Webhook manzili https:// bilan boshlanishi kerak." };
  }

  var previous = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  var next = generateWebhookSecret_();

  // Accept both before Telegram is told anything, so neither ordering can drop
  // an update that is already in flight.
  if (previous) setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, previous);
  setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, next);

  try {
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    telegramFetch_("setWebhook", {
      url: webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + next,
      secret_token: next,
      allowed_updates: ["message", "callback_query"]
    });

    var info = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var result = (info && info.result) || {};
    if (!result.url) throw new Error("Telegram webhook manzilini tasdiqlamadi.");

    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, "");
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL, webhookUrl);
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_ROTATED_AT, new Date().toISOString());
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS, JSON.stringify({
      configured: true,
      verified: true,
      pendingUpdateCount: result.pending_update_count || 0,
      lastErrorMessage: redactSecrets_(result.last_error_message || ""),
      checkedAt: new Date().toISOString()
    }));

    auditTelegramSettingsChange_(["webhookSecret"]);
    return { status: "success", rotated: true, settings: buildTelegramSettingsView_() };
  } catch (error) {
    restoreWebhookSecret_(previous, webhookUrl);
    return {
      status: "error",
      message: "Kalitni almashtirib bo'lmadi, eski kalit qaytarildi. " + redactSecrets_(error).slice(0, 200),
      settings: buildTelegramSettingsView_()
    };
  }
}

/** Puts the old secret back and re-points Telegram at it. Never throws. */
function restoreWebhookSecret_(previous, webhookUrl) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, previous || "");
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, "");
    if (!previous) return;
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    telegramFetch_("setWebhook", {
      url: webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + previous,
      secret_token: previous,
      allowed_updates: ["message", "callback_query"]
    });
  } catch (restoreError) {
    // Nothing further is safe to try automatically. The operator's recovery is
    // the Webhook button, which mints and installs a secret from scratch.
    try {
      recordTelegramError_("rotateWebhookSecret", restoreError);
    } catch (ignored) {}
  }
}
