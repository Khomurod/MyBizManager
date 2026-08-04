// =============================================================================
// GENERATED FILE - DO NOT EDIT.
//
// Built from apps-script/*.gs by scripts/build-apps-script.js.
// Edit the modules under apps-script/ and run `npm run build`.
//
// Apps Script files share a single global scope, so this bundle behaves
// identically to keeping the modules as separate files in the editor.
// =============================================================================

// ----- apps-script/01_shared_utils.gs ------------------------------------------

// ============================================================
// Shared utilities
// ------------------------------------------------------------
// Tiny helpers with no business meaning of their own.
// ============================================================

function safeParseJSON_(value, fallback) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function okHtmlOutput_() {
  return HtmlService.createHtmlOutput("OK");
}

function setConfig(sheet, key, value) {
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function getConfig(sheet, key) {
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return null;
}

function escapeMarkdown_(value) {
  return String(value || "").replace(/([_*`\[])/g, "\\$1");
}

function escapeTelegramHtml_(value) {
  return String(value === null || value === undefined ? "" : value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;");
}

function formatUZS_(amount) {
  return Math.round(Number(amount) || 0).toLocaleString();
}

/** ISO timestamp -> "dd.MM.yyyy HH:mm" in the script's timezone. */
function formatCloseDayStamp_(value) {
  var raw = String(value || "");
  if (!raw) return "";
  try {
    var parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return raw;
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
  } catch (error) {
    return raw;
  }
}

/** Constant-time-ish comparison; avoids leaking the secret length via timing. */
function secretsMatch_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// ----- apps-script/01a_periods.gs ----------------------------------------------

// ============================================================
// Year-month periods
// ------------------------------------------------------------
// The canonical period is "YYYY-MM" ("2026-01"). Month-only values such as
// "Yanvar" are legacy: two Januaries collide, and sorting is meaningless.
//
// Friendly Uzbek labels ("Yanvar 2026") are a *presentation* concern and are
// produced from the canonical value, never stored.
// ============================================================

var UZBEK_MONTHS = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"
];

var UZBEK_MONTHS_SHORT = [
  "Yan", "Fev", "Mar", "Apr", "May", "Iyn",
  "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"
];

var CANONICAL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
var ALL_PERIODS_LABEL = "Jami Davr";

/** Config key holding the year to use for rows whose year cannot be derived. */
var OMAD_FALLBACK_YEAR_KEY = "Omad_Migration_Fallback_Year";

function isCanonicalPeriod_(value) {
  return CANONICAL_PERIOD_PATTERN.test(String(value || ""));
}

/** year + 1-based month -> "YYYY-MM". */
function buildPeriod_(year, month) {
  var y = Number(year);
  var m = Number(month);
  if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return "";
  return String(y) + "-" + (m < 10 ? "0" + m : String(m));
}

function periodYear_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(0, 4)) : 0;
}

/** 1-based month number. */
function periodMonth_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(5, 7)) : 0;
}

/** "2026-01" -> "Yanvar 2026". Anything else is passed through unchanged. */
function formatPeriodLabel_(period) {
  if (!isCanonicalPeriod_(period)) return String(period || "");
  return UZBEK_MONTHS[periodMonth_(period) - 1] + " " + periodYear_(period);
}

function periodFromDate_(date) {
  if (!date || isNaN(date.getTime())) return "";
  return buildPeriod_(date.getFullYear(), date.getMonth() + 1);
}

function currentPeriod_() {
  return periodFromDate_(new Date());
}

/** Shifts a period by whole months, forwards or backwards, across year ends. */
function addMonthsToPeriod_(period, delta) {
  if (!isCanonicalPeriod_(period)) return "";
  var index = periodYear_(period) * 12 + (periodMonth_(period) - 1) + Number(delta || 0);
  return buildPeriod_(Math.floor(index / 12), (index % 12) + 1);
}

/** -1 / 0 / 1. Canonical periods sort correctly as plain strings. */
function comparePeriods_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** "Yanvar" / "yanvar" / "01" / "1" -> 1-based month number, or 0. */
function parseUzbekMonth_(value) {
  var text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return 0;

  for (var i = 0; i < UZBEK_MONTHS.length; i++) {
    if (UZBEK_MONTHS[i].toLowerCase() === text.toLowerCase()) return i + 1;
    if (UZBEK_MONTHS_SHORT[i].toLowerCase() === text.toLowerCase()) return i + 1;
  }

  if (/^\d{1,2}$/.test(text)) {
    var numeric = Number(text);
    if (numeric >= 1 && numeric <= 12) return numeric;
  }
  return 0;
}

/**
 * Reads a year and month out of a stored transaction date.
 *
 * Accepted, in order of preference:
 *   - a real Date value (Sheets returns these for date-formatted cells)
 *   - "dd/MM/yyyy" (what the app writes)
 *   - "yyyy-MM-dd" / ISO 8601
 *
 * Returns null when the value is absent, unparseable or ambiguous. A
 * two-digit year is treated as ambiguous on purpose: guessing the century is
 * exactly the kind of silent damage this migration exists to avoid.
 */
function parseTransactionDate_(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1 };
  }

  var text = String(value).trim();
  if (!text) return null;

  var dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text);
  if (dmy) {
    var day = Number(dmy[1]);
    var monthDmy = Number(dmy[2]);
    if (monthDmy < 1 || monthDmy > 12) return null;
    if (day < 1 || day > daysInMonth_(Number(dmy[3]), monthDmy)) return null;
    return { year: Number(dmy[3]), month: monthDmy };
  }

  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    var monthIso = Number(iso[2]);
    if (monthIso < 1 || monthIso > 12) return null;
    if (Number(iso[3]) < 1 || Number(iso[3]) > daysInMonth_(Number(iso[1]), monthIso)) return null;
    return { year: Number(iso[1]), month: monthIso };
  }

  return null;
}

/** Leap years included - 2024-02-29 is valid, 2026-02-29 is not. */
function daysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a transaction's canonical period.
 *
 * Precedence, and why:
 *   1. an already-canonical `month` - nothing to guess;
 *   2. a legacy month name plus a valid date whose month agrees - the date
 *      supplies the year;
 *   3. a valid date alone;
 *   4. a legacy month name plus the explicitly configured fallback year;
 *   5. unresolved.
 *
 * Case 2 deliberately requires the months to agree. A row saying "Dekabr"
 * with a January date is a real December-to-January edit and must be flagged,
 * not silently reassigned.
 */
function resolveTransactionPeriod_(transaction, fallbackYear) {
  var raw = transaction || {};
  var monthValue = raw.month;

  if (isCanonicalPeriod_(monthValue)) {
    return { period: String(monthValue), source: "canonical", confident: true };
  }

  var parsedDate = parseTransactionDate_(raw.date);
  var namedMonth = parseUzbekMonth_(monthValue);

  if (namedMonth && parsedDate) {
    if (parsedDate.month === namedMonth) {
      return { period: buildPeriod_(parsedDate.year, namedMonth), source: "date", confident: true };
    }
    // The stored month and the stored date disagree. The month label is what
    // the operator chose, so keep it, but take the year from the date only
    // when the disagreement is the ordinary December/January boundary.
    var yearGuess = disagreementYear_(parsedDate, namedMonth);
    if (yearGuess !== null) {
      return {
        period: buildPeriod_(yearGuess, namedMonth),
        source: "date_boundary",
        confident: true
      };
    }
    return {
      period: fallbackYear ? buildPeriod_(fallbackYear, namedMonth) : "",
      source: "conflict",
      confident: false,
      detail: "month '" + monthValue + "' disagrees with date '" + raw.date + "'"
    };
  }

  if (parsedDate) {
    return {
      period: buildPeriod_(parsedDate.year, parsedDate.month),
      source: "date_only",
      confident: true
    };
  }

  if (namedMonth) {
    if (!fallbackYear) {
      return { period: "", source: "needs_fallback_year", confident: false,
               detail: "month '" + monthValue + "' has no usable date" };
    }
    return { period: buildPeriod_(fallbackYear, namedMonth), source: "fallback", confident: false };
  }

  return { period: "", source: "unresolved", confident: false,
           detail: "no usable month or date" };
}

/**
 * A December row dated in early January (or a January row dated in late
 * December) is a normal late entry: the period belongs to the labelled month
 * of the adjacent year. Any other disagreement is not something to guess at.
 */
function disagreementYear_(parsedDate, namedMonth) {
  if (namedMonth === 12 && parsedDate.month === 1) return parsedDate.year - 1;
  if (namedMonth === 1 && parsedDate.month === 12) return parsedDate.year + 1;
  return null;
}

/** The configured fallback year, or 0 when the operator has not chosen one. */
function getFallbackYear_(configSheet) {
  if (!configSheet) return 0;
  var stored = Number(getConfig(configSheet, OMAD_FALLBACK_YEAR_KEY));
  return isFinite(stored) && stored >= 1970 && stored <= 2999 ? stored : 0;
}

function setFallbackYear_(configSheet, year) {
  setConfig(configSheet, OMAD_FALLBACK_YEAR_KEY, String(Number(year) || ""));
}

/**
 * Normalises any stored period-ish value to canonical form where possible.
 * Used for rates, planned expenses and tenant schedules, which carry a month
 * but no date of their own.
 */
function normalizePeriodValue_(value, fallbackYear) {
  if (isCanonicalPeriod_(value)) return String(value);
  var month = parseUzbekMonth_(value);
  if (month && fallbackYear) return buildPeriod_(fallbackYear, month);
  return "";
}

// ----- apps-script/02_validation.gs --------------------------------------------

// ============================================================
// Validation & rate limiting
// ------------------------------------------------------------
// Every externally supplied value is checked here before it reaches business code.
// ============================================================

// 5b. RATE LIMITING & INPUT-LENGTH VALIDATION
// ------------------------------------------
// There is no generic "send this text to Telegram" endpoint any more. The
// endpoints that must stay externally reachable (settings, webhook) are
// throttled and length-checked so they cannot be abused as an amplifier.
// ==========================================
var TELEGRAM_RATE_WINDOW_SECONDS = 60;

var TELEGRAM_ADMIN_RATE_LIMIT = 10;

var TELEGRAM_WEBHOOK_RATE_LIMIT = 120;

var TELEGRAM_MAX_TEXT_LENGTH = 3500;

var TELEGRAM_MAX_FIELD_LENGTH = 512;

/**
 * Fixed-window counter in the script cache. Returns "" when the call is
 * allowed, or a user-facing error message when the window is exhausted.
 * Cache failures fail open on purpose - throttling must never take the app
 * down, it only has to blunt abuse.
 */
function enforceRateLimit_(bucketKey, maxCalls, windowSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var window = Math.floor(new Date().getTime() / (windowSeconds * 1000));
    var key = "rl_" + bucketKey + "_" + window;
    var used = Number(cache.get(key)) || 0;
    if (used >= maxCalls) {
      return "Juda ko'p so'rov yuborildi. Iltimos, biroz kutib qayta urinib ko'ring.";
    }
    cache.put(key, String(used + 1), windowSeconds + 5);
    return "";
  } catch (error) {
    return "";
  }
}

function validateTelegramPayloadLengths_(payload) {
  var fields = ["adminKey", "botToken", "authorizedUserId", "groupChatId", "webhookUrl"];
  for (var i = 0; i < fields.length; i++) {
    var value = payload && payload[fields[i]];
    if (value !== undefined && value !== null && String(value).length > TELEGRAM_MAX_FIELD_LENGTH) {
      return "Maydon juda uzun: " + fields[i];
    }
  }
  return "";
}

function validateTelegramToken_(token) {
  var value = String(token || "").trim();
  if (!value) return "Bot token bo'sh bo'lishi mumkin emas.";
  if (!TELEGRAM_TOKEN_PATTERN.test(value)) {
    return "Bot token formati noto'g'ri. Namuna: 123456789:AA...";
  }
  return "";
}

function validateTelegramUserId_(userId) {
  var value = String(userId || "").trim();
  if (!value) return "Telegram foydalanuvchi ID kiritilmagan.";
  if (!/^\d{1,20}$/.test(value)) return "Telegram foydalanuvchi ID faqat musbat raqam bo'lishi kerak.";
  return "";
}

function validateTelegramChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "Guruh ID kiritilmagan.";
  if (/^@[A-Za-z0-9_]{4,}$/.test(value)) return "";
  if (!/^-?\d{1,20}$/.test(value)) return "Guruh ID raqam (masalan -1001234567890) yoki @username bo'lishi kerak.";
  return "";
}

// 5e. BUSINESS REPORT JOBS
// ------------------------------------------
// The browser submits a business operation. The message text is composed here,
// on the server, from data the server already stored.
// ==========================================
var OMAD_REPORT_OPERATIONS = { transaction_upsert: true, transaction_delete: true };

function validateOmadTelegramReport_(report) {
  if (report === undefined || report === null) return "";
  if (typeof report !== "object") return "telegramReport noto'g'ri formatda.";
  if (!OMAD_REPORT_OPERATIONS[String(report.operation || "")]) {
    return "telegramReport.operation noto'g'ri.";
  }
  if (String(report.baseId || "").length > 64) return "telegramReport.baseId juda uzun.";
  if (report.messageId !== undefined && report.messageId !== null && report.messageId !== "" &&
      !/^\d{1,20}$/.test(String(report.messageId))) {
    return "telegramReport.messageId noto'g'ri.";
  }
  return "";
}

// ----- apps-script/03_settings.gs ----------------------------------------------

// ============================================================
// Settings & secrets
// ------------------------------------------------------------
// Secrets live ONLY in Script Properties. They are never hardcoded, never
// returned to the browser and never written to logs.
// ============================================================

// 5. TELEGRAM CREDENTIALS & SETTINGS
// ------------------------------------------
// Secrets live ONLY in Apps Script Script Properties. They are never
// hardcoded, never returned to the browser and never written to logs.
// ==========================================
var TELEGRAM_PROP_BOT_TOKEN = "TELEGRAM_BOT_TOKEN";

var TELEGRAM_PROP_AUTHORIZED_USER_ID = "TELEGRAM_AUTHORIZED_USER_ID";

var TELEGRAM_PROP_GROUP_CHAT_ID = "TELEGRAM_GROUP_CHAT_ID";

var TELEGRAM_PROP_WEBHOOK_URL = "TELEGRAM_WEBHOOK_URL";

var TELEGRAM_PROP_WEBHOOK_STATUS = "TELEGRAM_WEBHOOK_STATUS";

var TELEGRAM_PROP_LAST_SUCCESS = "TELEGRAM_LAST_SUCCESS";

var TELEGRAM_PROP_LAST_ERROR = "TELEGRAM_LAST_ERROR";

var OMAD_PROP_ADMIN_KEY = "OMAD_ADMIN_KEY";

// 5c. WEBHOOK VERIFICATION
// ------------------------------------------
// Apps Script web apps cannot read request headers, so Telegram's
// X-Telegram-Bot-Api-Secret-Token header is not observable. The strongest
// mechanism that IS available is a secret embedded in the webhook URL: only
// Telegram is ever told the URL, and setWebhook additionally sends the same
// value as secret_token for defence in depth.
// ==========================================
var TELEGRAM_PROP_WEBHOOK_SECRET = "TELEGRAM_WEBHOOK_SECRET";

var TELEGRAM_WEBHOOK_SECRET_PARAM = "wh";

var TELEGRAM_TOKEN_PATTERN = /^\d{6,16}:[A-Za-z0-9_-]{30,}$/;

var TELEGRAM_TOKEN_LIKE_PATTERN = /\d{6,16}:[A-Za-z0-9_-]{30,}/g;

function scriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function getTelegramSetting_(key) {
  try {
    return scriptProperties_().getProperty(key) || "";
  } catch (error) {
    return "";
  }
}

function setTelegramSetting_(key, value) {
  if (value === null || value === undefined || value === "") {
    scriptProperties_().deleteProperty(key);
    return;
  }
  scriptProperties_().setProperty(key, String(value));
}

function getBotToken_() {
  return getTelegramSetting_(TELEGRAM_PROP_BOT_TOKEN);
}

function getAuthorizedTelegramUserId_() {
  return getTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID);
}

function getOmadGroupChatId_() {
  return getTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID);
}

function getOrCreateWebhookSecret_() {
  var existing = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  if (existing) return existing;
  var generated = Utilities.getUuid().split("-").join("") + Utilities.getUuid().split("-").join("");
  setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, generated);
  return generated;
}

/**
 * Removes anything that looks like a Telegram bot token (and the configured
 * token itself) from any string before it is logged or returned to a client.
 */
function redactSecrets_(value) {
  var text = value === null || value === undefined ? "" : String(value && value.message ? value.message : value);
  var token = "";
  try {
    token = getBotToken_();
  } catch (error) {
    token = "";
  }
  if (token) {
    text = text.split(token).join("[REDACTED]");
    var tokenId = token.split(":")[0];
    if (tokenId) text = text.split("bot" + tokenId).join("bot[REDACTED]");
  }
  return text.replace(TELEGRAM_TOKEN_LIKE_PATTERN, "[REDACTED]");
}

function recordTelegramSuccess_(action) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_LAST_SUCCESS, JSON.stringify({
      action: String(action || ""),
      at: new Date().toISOString()
    }));
  } catch (error) {}
}

function recordTelegramError_(action, error) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_LAST_ERROR, JSON.stringify({
      action: String(action || ""),
      message: redactSecrets_(error).slice(0, 500),
      at: new Date().toISOString()
    }));
  } catch (ignored) {}
}

/**
 * Public-safe view of the Telegram configuration.
 * The token itself is NEVER included - only whether one is configured.
 */
function buildTelegramSettingsView_() {
  return {
    tokenConfigured: !!getBotToken_(),
    authorizedUserId: getTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID),
    groupChatId: getTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID),
    webhookUrl: getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL),
    webhookStatus: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS), null),
    lastSuccess: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_LAST_SUCCESS), null),
    lastError: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_LAST_ERROR), null),
    adminKeyConfigured: !!getTelegramSetting_(OMAD_PROP_ADMIN_KEY),
    // Whether a webhook verification secret exists - never the secret itself.
    webhookSecretConfigured: !!getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET)
  };
}

/**
 * Settings mutations require an admin key stored in Script Properties.
 * Returns "" when authorized, or an error message.
 */
function checkAdminKey_(payload) {
  var expected = getTelegramSetting_(OMAD_PROP_ADMIN_KEY);
  if (!expected) {
    return "OMAD_ADMIN_KEY Script Property o'rnatilmagan. Apps Script → Project Settings → Script Properties orqali qo'shing.";
  }
  var provided = String((payload && payload.adminKey) || "");
  if (provided !== expected) return "Admin kaliti noto'g'ri.";
  return "";
}

function saveTelegramSettings_(payload) {
  var errors = [];
  var updated = [];
  var hasToken = Object.prototype.hasOwnProperty.call(payload, "botToken") && String(payload.botToken || "").trim() !== "";

  if (hasToken) {
    var tokenError = validateTelegramToken_(payload.botToken);
    if (tokenError) errors.push(tokenError);
  }

  var userError = validateTelegramUserId_(payload.authorizedUserId);
  if (userError) errors.push(userError);

  var chatError = validateTelegramChatId_(payload.groupChatId);
  if (chatError) errors.push(chatError);

  if (errors.length > 0) return { status: "error", message: errors.join(" ") };

  if (hasToken) {
    setTelegramSetting_(TELEGRAM_PROP_BOT_TOKEN, String(payload.botToken).trim());
    updated.push("botToken");
  }
  setTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID, String(payload.authorizedUserId).trim());
  setTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID, String(payload.groupChatId).trim());
  updated.push("authorizedUserId", "groupChatId");

  auditTelegramSettingsChange_(updated);
  return { status: "success", settings: buildTelegramSettingsView_() };
}

function testTelegramConnection_() {
  if (!getBotToken_()) return { status: "error", message: "Bot token o'rnatilmagan." };
  try {
    var response = telegramFetch_("getMe", {});
    var data = safeParseJSON_(response.getContentText(), {});
    var bot = (data && data.result) || {};
    return {
      status: "success",
      bot: { id: bot.id || "", username: bot.username || "", firstName: bot.first_name || "" },
      settings: buildTelegramSettingsView_()
    };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

function sendTelegramTestMessage_() {
  var chatId = getOmadGroupChatId_();
  if (!chatId) return { status: "error", message: "Guruh ID o'rnatilmagan." };
  try {
    sendTelegramMessage_(chatId, "✅ MyBizManager: Telegram sozlamalari tekshiruvi muvaffaqiyatli.");
    return { status: "success", settings: buildTelegramSettingsView_() };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

/** Strips any previously appended webhook secret from an operator-entered URL. */
function stripWebhookSecret_(url) {
  var base = String(url || "").trim();
  var cut = base.indexOf("?" + TELEGRAM_WEBHOOK_SECRET_PARAM + "=");
  if (cut !== -1) return base.slice(0, cut);
  cut = base.indexOf("&" + TELEGRAM_WEBHOOK_SECRET_PARAM + "=");
  if (cut !== -1) return base.slice(0, cut);
  return base;
}

function configureTelegramWebhook_(payload) {
  var webhookUrl = stripWebhookSecret_(
    (payload && payload.webhookUrl) || getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || ""
  );
  if (!/^https:\/\/[^\s]+$/.test(webhookUrl)) {
    return { status: "error", message: "Webhook manzili https:// bilan boshlanishi kerak." };
  }
  try {
    // The secret is never returned to the browser. It only ever travels to
    // Telegram inside the setWebhook call, and comes back on each update.
    var secret = getOrCreateWebhookSecret_();
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    var callbackUrl = webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + secret;

    telegramFetch_("setWebhook", {
      url: callbackUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"]
    });
    var info = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var result = (info && info.result) || {};
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL, webhookUrl);
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS, JSON.stringify({
      configured: !!result.url,
      verified: true,
      pendingUpdateCount: result.pending_update_count || 0,
      lastErrorMessage: redactSecrets_(result.last_error_message || ""),
      checkedAt: new Date().toISOString()
    }));
    return { status: "success", settings: buildTelegramSettingsView_() };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

/**
 * Run once from the Apps Script editor to grant the UrlFetch scope.
 * Uses the configured token; nothing is hardcoded.
 */
function authorizeTelegramAccess() {
  if (!getBotToken_()) throw new Error("Set TELEGRAM_BOT_TOKEN in Script Properties first.");
  telegramFetch_("getMe", {});
}

// ----- apps-script/04_audit_history.gs -----------------------------------------

// ============================================================
// Audit history & backups
// ------------------------------------------------------------
// Nothing is ever silently overwritten: every Omad write is preceded by a full
// snapshot, and changed rows are archived.
// ============================================================

function backupOmadState_(doc, configSheet, reason) {
  var backupSheet = doc.getSheetByName("Omad_Backups") || doc.insertSheet("Omad_Backups");
  if (backupSheet.getLastRow() === 0) backupSheet.appendRow(["Timestamp", "Reason", "Snapshot_JSON"]);

  var snapshot = {
    transactions: readOmadTransactions_(doc),
    tenants: safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}),
    templateExpenses: safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), [])
  };

  backupSheet.appendRow([new Date().toISOString(), reason || "omad_write", JSON.stringify(snapshot)]);
}

function archiveChangedOmadTransactions_(doc, existingTransactions, incomingTransactions) {
  var archiveRows = [];
  var incomingById = {};
  for (var i = 0; i < incomingTransactions.length; i++) {
    incomingById[String(incomingTransactions[i].id || "")] = incomingTransactions[i];
  }

  for (var j = 0; j < existingTransactions.length; j++) {
    var existing = normalizeTransaction_(existingTransactions[j]);
    var incoming = incomingById[String(existing.id || "")];
    if (!incoming) {
      archiveRows.push([new Date().toISOString(), "omitted_from_active_payload", existing.id, JSON.stringify(existing)]);
    } else if (JSON.stringify(transactionToRow_(existing)) !== JSON.stringify(transactionToRow_(incoming))) {
      archiveRows.push([new Date().toISOString(), "before_update", existing.id, JSON.stringify(existing)]);
    }
  }

  if (archiveRows.length === 0) return;

  var archiveSheet = doc.getSheetByName("Omad_Transaction_Archive") || doc.insertSheet("Omad_Transaction_Archive");
  if (archiveSheet.getLastRow() === 0) archiveSheet.appendRow(["Timestamp", "Reason", "Transaction_ID", "Transaction_JSON"]);
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, archiveRows.length, archiveRows[0].length).setValues(archiveRows);
}

function auditTelegramSettingsChange_(updatedFields) {
  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    // Only field NAMES are stored - never values, never the token.
    sheet.appendRow([new Date().toISOString(), "telegram_settings_changed", (updatedFields || []).join(",")]);
  } catch (error) {}
}

function debugLog_(doc, eventName, details) {
  try {
    var sheet = doc.getSheetByName("Telegram_Debug_Log") || doc.insertSheet("Telegram_Debug_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), eventName, redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}

/** Appends one row to the append-only audit trail. Never throws. */
function appendAuditRow_(doc, event, details) {
  try {
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), String(event), redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}

// ----- apps-script/05_exchange_rates.gs ----------------------------------------

// ============================================================
// Exchange rates
// ------------------------------------------------------------
// USD -> UZS conversion and the balances derived from it.
//
// Rates are keyed by canonical period ("2026-01"). A legacy month-name key
// ("Fevral") is still honoured on read so the app keeps working before the
// migration runs, but nothing writes one any more.
// ============================================================

var DEFAULT_RATE_UZS = 12500;

function getOmadRates_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return {};
  return safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {});
}

function normalizeRateEntry_(rawRate) {
  if (typeof rawRate === "number") {
    return { buy: rawRate || DEFAULT_RATE_UZS, sell: rawRate || DEFAULT_RATE_UZS };
  }
  if (rawRate && typeof rawRate === "object") {
    var buy = Number(rawRate.buy || rawRate.sell || rawRate.rate) || DEFAULT_RATE_UZS;
    var sell = Number(rawRate.sell || rawRate.buy || rawRate.rate) || DEFAULT_RATE_UZS;
    return { buy: buy, sell: sell };
  }
  return { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

/**
 * Looks a rate up by canonical period, falling back to the legacy month-name
 * key for the same month. Returns null when the period has no rate at all, so
 * callers can tell "no rate configured" from "the rate happens to be 12500".
 */
function findRateEntry_(rates, period) {
  if (!rates || typeof rates !== "object") return null;

  var key = String(period || "");
  if (Object.prototype.hasOwnProperty.call(rates, key)) return normalizeRateEntry_(rates[key]);

  if (isCanonicalPeriod_(key)) {
    var legacyKey = UZBEK_MONTHS[periodMonth_(key) - 1];
    if (Object.prototype.hasOwnProperty.call(rates, legacyKey)) {
      return normalizeRateEntry_(rates[legacyKey]);
    }
  }
  return null;
}

function getPeriodRate_(rates, period) {
  return findRateEntry_(rates, period) || { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

function getPeriodRateByType_(rates, period, rateType) {
  var entry = getPeriodRate_(rates, period);
  return rateType === "buy" ? entry.buy : entry.sell;
}

function toUZS_(amount, currency, period, rates, rateType) {
  var numericAmount = Number(amount) || 0;
  if (currency !== "USD") return numericAmount;
  return numericAmount * getPeriodRateByType_(rates, period, rateType || "sell");
}

/** The period a transaction belongs to, whichever field carries it. */
function transactionPeriod_(transaction) {
  var t = transaction || {};
  return String(t.period || t.month || "");
}

function calculateBalancesFromTransactions_(transactions, targetPeriod) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;

  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var period = transactionPeriod_(t);
    var valueUZS = toUZS_(t.amount, t.currency, period, rates, "sell");
    var sign = t.type === "Income" ? 1 : -1;
    allTimeBalance += valueUZS * sign;
    if (period === String(targetPeriod || "")) monthBalance += valueUZS * sign;
  }

  return { monthBalance: monthBalance, allTimeBalance: allTimeBalance };
}

/**
 * Converts every legacy month-name key to a canonical period using the
 * configured fallback year. Keys that are already canonical are kept as-is.
 */
function migrateRatesMap_(rates, fallbackYear) {
  var source = rates && typeof rates === "object" ? rates : {};
  var migrated = {};
  var unresolved = [];

  Object.keys(source).forEach(function (key) {
    if (isCanonicalPeriod_(key)) {
      migrated[key] = normalizeRateEntry_(source[key]);
      return;
    }
    var period = normalizePeriodValue_(key, fallbackYear);
    if (!period) {
      unresolved.push(key);
      return;
    }
    // An explicit canonical entry always wins over a converted legacy one.
    if (!Object.prototype.hasOwnProperty.call(migrated, period)) {
      migrated[period] = normalizeRateEntry_(source[key]);
    }
  });

  return { rates: migrated, unresolved: unresolved };
}

// ----- apps-script/06_tenants.gs -----------------------------------------------

// ============================================================
// Tenants & rent schedules
// ------------------------------------------------------------
// Tenant records and the schedule data the projection reads.
// ============================================================

function normalizeTenantList_(tenants) {
  var source = Array.isArray(tenants) ? tenants : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var tenant = typeof item === "string" ? { name: item } : (item || {});
    var name = String(tenant.name || "").trim();
    if (!name) continue;
    normalized.push({
      name: name,
      rent: Number(tenant.rent) || 0,
      currency: tenant.currency === "UZS" ? "UZS" : "USD",
      disabledMonths: Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : []
    });
  }
  return normalized;
}

function mergeTenantsByName_(existingTenants, incomingTenants) {
  var merged = [];
  var indexByName = {};
  for (var i = 0; i < existingTenants.length; i++) {
    merged.push(existingTenants[i]);
    indexByName[existingTenants[i].name] = i;
  }
  for (var j = 0; j < incomingTenants.length; j++) {
    var incoming = incomingTenants[j];
    if (indexByName[incoming.name] === undefined) {
      indexByName[incoming.name] = merged.length;
      merged.push(incoming);
    } else {
      var existing = merged[indexByName[incoming.name]];
      merged[indexByName[incoming.name]] = {
        name: incoming.name,
        rent: Number(incoming.rent) || 0,
        currency: incoming.currency === "UZS" ? "UZS" : "USD",
        disabledMonths: Array.isArray(incoming.disabledMonths) ? incoming.disabledMonths : (existing.disabledMonths || [])
      };
    }
  }
  return merged;
}

function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var names = [];
  for (var i = 0; i < tenants.length; i++) names.push(tenants[i].name);
  return names;
}

// ----- apps-script/07_planned_expenses.gs --------------------------------------

// ============================================================
// Planned expenses
// ------------------------------------------------------------
// Template (planned) expenses used by the projection.
// ============================================================

function normalizeTemplateExpenses_(expenses) {
  var source = Array.isArray(expenses) ? expenses : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i] || {};
    var name = String(item.name || "").trim();
    if (!name) continue;
    normalized.push({
      id: String(item.id || (Date.now() + "_" + i)),
      month: String(item.month || item.period || currentPeriod_()).trim(),
      name: name,
      amount: Number(item.amount) || 0,
      currency: item.currency === "USD" ? "USD" : "UZS"
    });
  }
  return normalized;
}

// ----- apps-script/08_omad_transactions.gs -------------------------------------

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
  // `month` holds the canonical period for anything written from now on.
  // Legacy month names are preserved verbatim rather than guessed at; the
  // migration is where they get a year, under operator control.
  return {
    id: String(t.id || (Date.now() + "_0")),
    tenant: String(t.tenant || "").trim(),
    month: String(t.month || t.period || currentPeriod_()).trim(),
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
    txSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function appendOmadTransaction_(doc, transaction) {
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);
  txSheet.appendRow(transactionToRow_(normalizeTransaction_(transaction)));
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

// ----- apps-script/09_telegram_service.gs --------------------------------------

// ============================================================
// Telegram service
// ------------------------------------------------------------
// Everything that talks to api.telegram.org, plus the /yangi conversation.
// There is no generic "send this text" entry point.
// ============================================================

function telegramFetch_(method, body) {
  var token = getBotToken_();
  if (!token) throw new Error("Telegram bot token is not configured. Set it in Sozlamalar → Telegram.");

  var response;
  try {
    response = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (transportError) {
    recordTelegramError_(method, transportError);
    throw new Error("Telegram API " + method + " unreachable: " + redactSecrets_(transportError));
  }

  var responseText = response.getContentText();
  var responseCode = response.getResponseCode();

  debugLog_(SpreadsheetApp.getActiveSpreadsheet(), "telegram_api_" + method, JSON.stringify({
    code: responseCode,
    request: body,
    response: responseText
  }));

  if (responseCode < 200 || responseCode >= 300) {
    var failure = "Telegram API " + method + " failed (HTTP " + responseCode + "): " + responseText;
    recordTelegramError_(method, failure);
    throw new Error(redactSecrets_(failure));
  }

  recordTelegramSuccess_(method);
  return response;
}

function sendTelegramMessage_(chatId, text, replyMarkup, parseMode) {
  var body = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  return telegramFetch_("sendMessage", body);
}

function editTelegramMessage_(chatId, messageId, text, replyMarkup) {
  var body = { chat_id: chatId, message_id: messageId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramFetch_("editMessageText", body);
}

function answerCallbackQuery_(callbackQueryId, text) {
  var body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  telegramFetch_("answerCallbackQuery", body);
}

function extractTelegramMessageId_(response) {
  try {
    var data = JSON.parse(response.getContentText() || "{}");
    return data && data.ok && data.result ? data.result.message_id : "";
  } catch (error) {
    return "";
  }
}

function isVerifiedTelegramWebhookRequest_(e) {
  var expected = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  // No secret configured yet: accept, so an existing deployment keeps working
  // until the operator re-runs "Webhook" in Sozlamalar. buildTelegramSettingsView_
  // surfaces this as an unverified webhook.
  if (!expected) return true;

  var provided = e && e.parameter ? e.parameter[TELEGRAM_WEBHOOK_SECRET_PARAM] : "";
  if (secretsMatch_(provided, expected)) {
    return !enforceRateLimit_("tg_webhook", TELEGRAM_WEBHOOK_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  }
  return false;
}

var TELEGRAM_UNAUTHORIZED_MESSAGE = "⛔️ Sizda bu botdan foydalanish huquqi yo'q.";

/**
 * Single source of truth for /yangi authorization.
 * Uses Telegram's permanent numeric from.id - never the username, which can
 * be changed or impersonated. Returns true only for the configured admin.
 */
function isAuthorizedTelegramUser_(fromId) {
  var configured = getAuthorizedTelegramUserId_();
  if (!configured) return false;
  var actual = String(fromId === null || fromId === undefined ? "" : fromId).trim();
  if (!actual) return false;
  return actual === String(configured).trim();
}

function extractTelegramFromId_(update) {
  if (!update) return "";
  if (update.callback_query && update.callback_query.from) return update.callback_query.from.id;
  if (update.message && update.message.from) return update.message.from.id;
  return "";
}

function handleOmadTelegramUpdate_(update, doc, configSheet) {
  var callback = update.callback_query;
  var message = update.message;
  var chatId = callback ? callback.message.chat.id : message.chat.id;
  var chatType = callback ? callback.message.chat.type : message.chat.type;
  var fromId = extractTelegramFromId_(update);
  var cache = CacheService.getScriptCache();
  // Session key is bound to the authorized user, not just the chat.
  var key = "yangi_" + fromId;
  debugLog_(doc, "telegram_update_received", JSON.stringify({ chatId: chatId, fromId: fromId, chatType: chatType, text: message && message.text, callback: callback && callback.data }));

  // The reporting group receives reports only - never accepts transaction entry.
  if (chatType !== "private") {
    debugLog_(doc, "telegram_non_private_ignored", JSON.stringify({ chatId: chatId, chatType: chatType, text: message && message.text, callback: callback && callback.data }));
    return okHtmlOutput_();
  }

  // Gate #1: every private update, before any session/cache/record is touched.
  if (!isAuthorizedTelegramUser_(fromId)) {
    debugLog_(doc, "telegram_unauthorized_blocked", JSON.stringify({ chatId: chatId, fromId: fromId, callback: callback && callback.data }));
    if (callback) answerCallbackQuery_(callback.id, TELEGRAM_UNAUTHORIZED_MESSAGE);
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return okHtmlOutput_();
  }

  if (callback) {
    answerCallbackQuery_(callback.id);
    processOmadCallback_(callback, chatId, key, cache, configSheet, fromId);
    return okHtmlOutput_();
  }

  var text = String((message && message.text) || "").trim();
  if (text === "/yangi" || text.indexOf("/yangi ") === 0) {
    cache.remove(key);
    debugLog_(doc, "telegram_yangi_triggered", JSON.stringify({ chatId: chatId, fromId: fromId }));
    sendTelegramMessage_(chatId, "Iltimos, operatsiya turini tanlang:", {
      inline_keyboard: [[
        { text: "🟢 Kirim", callback_data: "bot_type:Income" },
        { text: "🔴 Chiqim", callback_data: "bot_type:Expense" }
      ]]
    });
    return okHtmlOutput_();
  }

  processOmadTextStep_(text, chatId, key, cache, doc, configSheet, fromId);
  return okHtmlOutput_();
}

function processOmadCallback_(callback, chatId, key, cache, configSheet, fromId) {
  // Gate #2: re-checked on every inline button callback (type, tenant,
  // expense source and currency selection all arrive through here).
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var data = String(callback.data || "");
  var state = safeParseJSON_(cache.get(key), {});

  if (data.indexOf("bot_type:") === 0) {
    // A fresh session id per entry. It becomes the transaction's request id, so
    // the whole conversation maps to exactly one financial record.
    state = {
      type: data.replace("bot_type:", "") === "Expense" ? "Expense" : "Income",
      sessionId: Utilities.getUuid().split("-").join("")
    };
    cache.put(key, JSON.stringify(state), 21600);
    var tenantNames = getActiveTenantNames_(configSheet);
    var keyboard = [];
    for (var i = 0; i < tenantNames.length; i++) keyboard.push([{ text: tenantNames[i], callback_data: "bot_ten:" + i }]);
    if (state.type === "Expense") {
      keyboard.push([{ text: "🗄️ Umumiy Naqd Puldan", callback_data: "bot_spec:Umumiy Naqd Puldan" }]);
      keyboard.push([{ text: "💳 Umumiy Bankdan", callback_data: "bot_spec:Umumiy Bankdan" }]);
    }
    editTelegramMessage_(chatId, callback.message.message_id, state.type === "Income" ? "Ijarachini tanlang:" : "Chiqim manbasini tanlang:", { inline_keyboard: keyboard });
    return;
  }

  if (data.indexOf("bot_ten:") === 0 || data.indexOf("bot_spec:") === 0) {
    if (!state.type) state.type = "Income";
    if (data.indexOf("bot_ten:") === 0) {
      var index = Number(data.replace("bot_ten:", ""));
      state.tenant = getActiveTenantNames_(configSheet)[index] || "";
    } else {
      state.tenant = data.replace("bot_spec:", "");
    }
    state.method = state.tenant === "Umumiy Bankdan" ? "Bank" : "Naqd";
    cache.put(key, JSON.stringify(state), 21600);
    editTelegramMessage_(chatId, callback.message.message_id, "Valyutani tanlang:", {
      inline_keyboard: [[
        { text: "🇺🇿 UZS", callback_data: "bot_curr:UZS" },
        { text: "🇺🇸 USD", callback_data: "bot_curr:USD" }
      ]]
    });
    return;
  }

  if (data.indexOf("bot_curr:") === 0) {
    state.currency = data.replace("bot_curr:", "") === "USD" ? "USD" : "UZS";
    state.step = "await_amount";
    cache.put(key, JSON.stringify(state), 21600);
    editTelegramMessage_(chatId, callback.message.message_id, "Valyuta tanlandi: " + state.currency, { inline_keyboard: [] });
    sendTelegramMessage_(chatId, "Iltimos, tranzaksiya summasini kiriting (faqat raqam):");
  }
}

function processOmadTextStep_(text, chatId, key, cache, doc, configSheet, fromId) {
  // Gate #3: re-checked on the amount and description steps, immediately
  // before the transaction is written to the sheet.
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var state = safeParseJSON_(cache.get(key), null);
  if (!state || !state.step) return;

  if (state.step === "await_amount") {
    var amount = Number(text.replace(/\s/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      sendTelegramMessage_(chatId, "Summa noto'g'ri. Iltimos, faqat musbat raqam kiriting:");
      return;
    }
    state.amount = amount;
    state.step = "await_desc";
    cache.put(key, JSON.stringify(state), 21600);
    sendTelegramMessage_(chatId, "Tranzaksiya izohini (kommentariya) kiriting:");
    return;
  }

  if (state.step === "await_desc") {
    // Gate #4: final check immediately before the financial record is saved.
    if (!isAuthorizedTelegramUser_(fromId)) {
      cache.remove(key);
      sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
      return;
    }

    // The request id is derived from the session, so replaying the same update
    // - or a retried webhook delivery - resolves to the same transaction.
    // A session started before this field existed simply gets no dedup key,
    // which is safer than risking a collision with a different session.
    var requestId = state.sessionId ? ("tg_" + fromId + "_" + state.sessionId) : "";
    var transaction;

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var existing = findTransactionByRequestId_(doc, requestId);
      if (existing) {
        transaction = normalizeTransaction_(existing);
      } else {
        backupOmadState_(doc, configSheet, "telegram_yangi");
        transaction = normalizeTransaction_({
          id: Date.now() + "_0",
          tenant: state.tenant,
          month: currentPeriod_(),
          type: state.type,
          amount: state.amount,
          currency: state.currency,
          method: state.method,
          date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
          comment: text,
          msgId: "",
          requestId: requestId
        });
        appendOmadTransaction_(doc, transaction);
      }
    } finally {
      lock.releaseLock();
    }

    // The financial record is safely stored. Finalise the session next, so a
    // failure anywhere below can never leave a session that accepts a second
    // submission of the same transaction.
    cache.remove(key);

    // Reporting is a separate retryable job. It cannot fail the transaction and
    // it cannot create a second copy of it.
    var reportJobId = "";
    try {
      reportJobId = enqueueJob_(doc, "omad_transaction_report", transaction.id, {
        baseId: String(transaction.id).split("_")[0],
        messageId: ""
      });
    } catch (queueError) {
      debugLog_(doc, "telegram_report_enqueue_failed", String(queueError));
    }

    // Confirm to the user first - the save is what matters to them.
    sendTelegramMessage_(chatId, buildTelegramConfirmation_(transaction), null, "Markdown");

    if (reportJobId) drainJobQueueQuietly_(doc);
  }
}

function buildTelegramConfirmation_(transaction) {
  return [
    "✅ *Tranzaksiya saqlandi*",
    "_Guruhga hisobot alohida yuboriladi._",
    "",
    "*Turi:* " + (transaction.type === "Income" ? "Kirim" : "Chiqim"),
    "*Obyekt:* " + escapeMarkdown_(transaction.tenant),
    "*Davr:* " + escapeMarkdown_(formatPeriodLabel_(transactionPeriod_(transaction))),
    "*Summa:* " + Number(transaction.amount || 0).toLocaleString() + " " + transaction.currency,
    "*Usul:* " + escapeMarkdown_(transaction.method),
    "*Izoh:* " + escapeMarkdown_(transaction.comment || "Kiritilmagan")
  ].join("\n");
}

/**
 * Report for a whole entry group (the web UI can save several amounts under a
 * single comment). Identical wording to the single-transaction message so the
 * group sees one consistent format.
 */
function buildOmadGroupReportMessage_(group, balances) {
  var rates = getOmadRates_();
  var first = group[0];
  var title = first.type === "Income" ? "🟢 YANGI KIRIM" : "🔴 YANGI CHIQIM";
  var objectText = String(first.tenant || "").trim() || "Noma'lum";
  var period = transactionPeriod_(first);
  var periodText = formatPeriodLabel_(period) || "Noma'lum";

  var transferLines = [];
  var total = 0;
  for (var i = 0; i < group.length; i++) {
    var valueUZS = toUZS_(group[i].amount, group[i].currency, period, rates, "sell");
    total += valueUZS;
    transferLines.push("💵 " + formatUZS_(valueUZS) + " UZS");
  }

  return (title +
    "\n\n🏢 Obyekt: " + objectText +
    "\n📅 Davr: " + periodText +
    "\n\n💸 O'tkazma:\n" + transferLines.join("\n") +
    "\nJami: " + formatUZS_(total) + " UZS" +
    "\n\n📝 Izoh: " + (String(first.comment || "").trim() || "Kiritilmagan") +
    "\n\n📊 HISOBOT:" +
    "\n🔹 " + periodText + " qoldig'i: " + formatUZS_(balances.monthBalance) + " UZS" +
    "\n🏦 Umumiy balans: " + formatUZS_(balances.allTimeBalance) + " UZS"
  ).slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

function buildCafeCloseDayMessage_(payload) {
  var items = Array.isArray(payload.soldItems) && payload.soldItems.length
    ? payload.soldItems
    : (Array.isArray(payload.summary) ? payload.summary : []);

  var lines = [];
  for (var i = 0; i < items.length; i++) {
    var qty = Number(items[i].qty !== undefined ? items[i].qty : items[i].sold) || 0;
    if (qty <= 0) continue;
    lines.push("• " + escapeTelegramHtml_(items[i].name) + ": <b>" + qty.toLocaleString() + "</b>");
  }
  if (lines.length === 0) lines.push("• Sotilgan mahsulotlar topilmadi");

  var stamp = formatCloseDayStamp_(payload.date);
  return [
    "🧾 <b>Kafe Kunlik Yakun Hisoboti</b>",
    "",
    "📅 <b>Sana:</b> " + escapeTelegramHtml_(stamp),
    "👤 <b>Sotuvchi:</b> " + escapeTelegramHtml_(payload.seller),
    "💵 <b>Jami tushum:</b> " + Math.round(Number(payload.totalRevenue) || 0).toLocaleString() + " UZS",
    "📈 <b>Jami foyda:</b> " + Math.round(Number(payload.totalProfit) || 0).toLocaleString() + " UZS",
    "",
    "📦 <b>Yopilgan mahsulotlar (sotilgan miqdor):</b>",
    lines.join("\n")
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

// ----- apps-script/10_retry_queue.gs -------------------------------------------

// ============================================================
// Retry queue
// ------------------------------------------------------------
// Reporting is never on the critical path of a financial write. Jobs are queued
// after the record is committed and retried with backoff.
// ============================================================

// 5d. RETRY QUEUE (Google Sheets backed)
// ------------------------------------------
// Telegram reporting is never on the critical path of a financial write. Jobs
// are queued after the record is committed and retried with backoff.
// ==========================================
var JOB_QUEUE_SHEET = "Omad_Job_Queue";

var JOB_QUEUE_HEADER = [
  "Job_ID", "Related_ID", "Type", "Payload_JSON", "Status",
  "Attempts", "Next_Attempt_At", "Last_Error", "Created_At", "Completed_At"
];

var JOB_STATUS_PENDING = "Pending";

var JOB_STATUS_PROCESSING = "Processing";

var JOB_STATUS_COMPLETED = "Completed";

var JOB_STATUS_FAILED = "Failed";

var JOB_MAX_ATTEMPTS = 5;

var JOB_RETRY_BASE_SECONDS = 30;

var JOB_QUEUE_INLINE_BATCH = 3;

var JOB_QUEUE_MANUAL_BATCH = 25;

var JOB_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function jobQueueSheet_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET) || doc.insertSheet(JOB_QUEUE_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(JOB_QUEUE_HEADER);
  return sheet;
}

function enqueueJob_(doc, type, relatedId, payload) {
  var sheet = jobQueueSheet_(doc);
  var jobId = "job_" + new Date().getTime() + "_" + sheet.getLastRow();
  sheet.appendRow([
    jobId,
    String(relatedId || ""),
    String(type),
    JSON.stringify(payload || {}),
    JOB_STATUS_PENDING,
    0,
    new Date().toISOString(),
    "",
    new Date().toISOString(),
    ""
  ]);
  return jobId;
}

function readJobRows_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheet, rows: [] };
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    rows.push({
      rowNumber: i + 1,
      jobId: String(data[i][0]),
      relatedId: String(data[i][1] || ""),
      type: String(data[i][2] || ""),
      payload: safeParseJSON_(data[i][3], {}),
      status: String(data[i][4] || ""),
      attempts: Number(data[i][5]) || 0,
      nextAttemptAt: String(data[i][6] || ""),
      lastError: String(data[i][7] || ""),
      createdAt: String(data[i][8] || ""),
      completedAt: String(data[i][9] || "")
    });
  }
  return { sheet: sheet, rows: rows };
}

function writeJobField_(sheet, rowNumber, columnIndex, value) {
  sheet.getRange(rowNumber, columnIndex).setValue(value);
}

/**
 * Claims a job by flipping it to Processing under the script lock, so two
 * concurrent workers can never run the same job twice.
 */
function claimDueJobs_(doc, maxJobs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (error) {
    return [];
  }

  var claimed = [];
  try {
    var read = readJobRows_(doc);
    if (!read.sheet) return [];
    var nowMs = new Date().getTime();

    for (var i = 0; i < read.rows.length && claimed.length < maxJobs; i++) {
      var job = read.rows[i];

      // Recover jobs abandoned by a worker that died mid-flight.
      if (job.status === JOB_STATUS_PROCESSING) {
        var startedMs = Date.parse(job.nextAttemptAt) || 0;
        if (nowMs - startedMs < JOB_PROCESSING_TIMEOUT_MS) continue;
      } else if (job.status !== JOB_STATUS_PENDING) {
        continue;
      } else if ((Date.parse(job.nextAttemptAt) || 0) > nowMs) {
        continue;
      }

      writeJobField_(read.sheet, job.rowNumber, 5, JOB_STATUS_PROCESSING);
      writeJobField_(read.sheet, job.rowNumber, 7, new Date(nowMs).toISOString());
      job.status = JOB_STATUS_PROCESSING;
      job.sheet = read.sheet;
      claimed.push(job);
    }
  } finally {
    lock.releaseLock();
  }
  return claimed;
}

function completeJob_(sheet, job) {
  writeJobField_(sheet, job.rowNumber, 5, JOB_STATUS_COMPLETED);
  writeJobField_(sheet, job.rowNumber, 6, job.attempts + 1);
  writeJobField_(sheet, job.rowNumber, 8, "");
  writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
}

function failJob_(sheet, job, error) {
  var attempts = job.attempts + 1;
  var exhausted = attempts >= JOB_MAX_ATTEMPTS;
  var delaySeconds = JOB_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1));
  writeJobField_(sheet, job.rowNumber, 5, exhausted ? JOB_STATUS_FAILED : JOB_STATUS_PENDING);
  writeJobField_(sheet, job.rowNumber, 6, attempts);
  writeJobField_(sheet, job.rowNumber, 7, new Date(new Date().getTime() + delaySeconds * 1000).toISOString());
  writeJobField_(sheet, job.rowNumber, 8, redactSecrets_(error).slice(0, 500));
  if (exhausted) writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
}

function processPendingJobs_(doc, maxJobs) {
  var jobs = claimDueJobs_(doc, maxJobs || JOB_QUEUE_INLINE_BATCH);
  var processed = 0;
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    try {
      runJob_(doc, job);
      completeJob_(job.sheet, job);
      processed++;
    } catch (error) {
      failJob_(job.sheet, job, error);
    }
  }
  return processed;
}

/** Best-effort inline drain. Never throws into the caller's response path. */
function drainJobQueueQuietly_(doc) {
  try {
    return processPendingJobs_(doc, JOB_QUEUE_INLINE_BATCH);
  } catch (error) {
    return 0;
  }
}

/** Entry point for a time-driven trigger (see docs/TELEGRAM_SETUP.md). */
function processPendingTelegramJobs() {
  return processPendingJobs_(SpreadsheetApp.getActiveSpreadsheet(), JOB_QUEUE_MANUAL_BATCH);
}

function buildJobQueueStatus_(doc) {
  var read = readJobRows_(doc);
  var counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  var recentFailures = [];
  for (var i = 0; i < read.rows.length; i++) {
    var job = read.rows[i];
    if (job.status === JOB_STATUS_PENDING) counts.pending++;
    else if (job.status === JOB_STATUS_PROCESSING) counts.processing++;
    else if (job.status === JOB_STATUS_COMPLETED) counts.completed++;
    else if (job.status === JOB_STATUS_FAILED) {
      counts.failed++;
      recentFailures.push({ jobId: job.jobId, type: job.type, attempts: job.attempts, lastError: job.lastError });
    }
  }
  return { counts: counts, failures: recentFailures.slice(-10) };
}

function runJob_(doc, job) {
  if (job.type === "omad_transaction_report") return runOmadTransactionReportJob_(doc, job);
  if (job.type === "omad_transaction_delete_report") return runOmadDeleteReportJob_(job);
  if (job.type === "cafe_close_day_report") return runCafeCloseDayReportJob_(job);
  throw new Error("Unknown job type: " + job.type);
}

// ----- apps-script/11_report_jobs.gs -------------------------------------------

// ============================================================
// Business report jobs
// ------------------------------------------------------------
// The browser submits a business operation. The message text is composed here,
// on the server, from data the server already stored.
// ============================================================

function queueOmadTransactionReport_(doc, report) {
  if (!report || typeof report !== "object") return "";
  var operation = String(report.operation || "");
  if (operation === "transaction_delete") {
    if (!report.messageId) return "";
    return enqueueJob_(doc, "omad_transaction_delete_report", String(report.baseId || ""), {
      messageId: String(report.messageId)
    });
  }
  if (operation === "transaction_upsert") {
    var baseId = String(report.baseId || "");
    if (!baseId) return "";
    return enqueueJob_(doc, "omad_transaction_report", baseId, {
      baseId: baseId,
      messageId: report.messageId ? String(report.messageId) : ""
    });
  }
  return "";
}

function runOmadTransactionReportJob_(doc, job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  var baseId = String(job.payload.baseId || "");
  var group = findTransactionGroup_(doc, baseId);
  if (group.length === 0) {
    // The group was deleted before the report went out. Nothing to report.
    return;
  }

  var balances = calculateBalancesFromTransactions_(readOmadTransactions_(doc), group[0].month);
  var text = buildOmadGroupReportMessage_(group, balances);
  var existingMessageId = String(job.payload.messageId || group[0].msgId || "");

  if (existingMessageId) {
    editTelegramMessage_(chatId, existingMessageId, text);
    applyMsgIdToGroup_(doc, group, existingMessageId);
    return;
  }

  var response = sendTelegramMessage_(chatId, text);
  var newMessageId = extractTelegramMessageId_(response);
  if (newMessageId) applyMsgIdToGroup_(doc, group, newMessageId);
}

function applyMsgIdToGroup_(doc, group, messageId) {
  for (var i = 0; i < group.length; i++) updateOmadTransactionMsgId_(doc, group[i].id, messageId);
}

function runOmadDeleteReportJob_(job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");
  telegramFetch_("deleteMessage", { chat_id: chatId, message_id: job.payload.messageId });
}

function queueCafeCloseDayReport_(doc, payload) {
  return enqueueJob_(doc, "cafe_close_day_report", "", {
    date: String(payload.date || ""),
    seller: String(payload.seller || "").slice(0, TELEGRAM_MAX_FIELD_LENGTH),
    totalRevenue: Number(payload.totalRevenue) || 0,
    totalProfit: Number(payload.totalProfit) || 0,
    summary: Array.isArray(payload.summary) ? payload.summary.slice(0, 200) : [],
    soldItems: Array.isArray(payload.soldItems) ? payload.soldItems.slice(0, 200) : []
  });
}

function runCafeCloseDayReportJob_(job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");
  var text = buildCafeCloseDayMessage_(job.payload);
  sendTelegramMessage_(chatId, text, null, "HTML");
}

// ----- apps-script/12_cafe.gs --------------------------------------------------

// ============================================================
// Café operations
// ------------------------------------------------------------
// Inventory/recipes/categories/settings for cafe_admin.html, and sales, voids
// and close-day for cafe_pos.html. Behaviour is unchanged from the version
// that lived inline in doPost.
// ============================================================

var CAFE_SALES_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Chek_Tafsilotlari", "ID"];
var CAFE_CLOSE_DAY_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Tafsilotlar_JSON"];

/**
 * Handles every café action. Returns a ContentService output, or null when the
 * action does not belong to the café, so the router can carry on.
 */
function handleCafeAction_(action, payload, doc, configSheet) {
  if (action === 'save_inventory') {
    setConfig(configSheet, "Cafe_Inventory", JSON.stringify(payload.inventory));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_recipe') {
    setConfig(configSheet, "Cafe_Recipes", JSON.stringify(payload.recipes));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_categories') {
    setConfig(configSheet, "Cafe_Categories", JSON.stringify(payload.categories));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_cafe_settings') {
    setConfig(configSheet, "Cafe_Settings", JSON.stringify(payload.settings));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_sale') return saveCafeSale_(doc, payload);
  if (action === 'void_sale') return voidCafeSale_(doc, configSheet, payload);
  if (action === 'close_day') return closeCafeDay_(doc, configSheet, payload);
  return null;
}

function saveCafeSale_(doc, payload) {
  var salesSheet = doc.getSheetByName("Cafe_Sales") || doc.insertSheet("Cafe_Sales");
  if (salesSheet.getLastRow() === 0) salesSheet.appendRow(CAFE_SALES_HEADER);

  salesSheet.appendRow([
    payload.date,
    payload.seller,
    payload.total,
    payload.profit,
    JSON.stringify(payload.items),
    payload.id || Date.now().toString()
  ]);
  return jsonOutput_({ status: "success" });
}

function voidCafeSale_(doc, configSheet, payload) {
  var salesSheet = doc.getSheetByName("Cafe_Sales");
  if (salesSheet) {
    var data = salesSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][5] == payload.id) {
        salesSheet.deleteRow(i + 1);
        break;
      }
    }
  }
  setConfig(configSheet, "Cafe_Inventory", JSON.stringify(payload.inventory));
  return jsonOutput_({ status: "success" });
}

function closeCafeDay_(doc, configSheet, payload) {
  setConfig(configSheet, "Cafe_Inventory", JSON.stringify(payload.inventory));

  var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni") || doc.insertSheet("Cafe_Kun_Yakuni");
  if (closeSheet.getLastRow() === 0) closeSheet.appendRow(CAFE_CLOSE_DAY_HEADER);
  closeSheet.appendRow([
    payload.date,
    payload.seller,
    payload.totalRevenue,
    payload.totalProfit,
    JSON.stringify(payload.summary)
  ]);

  // The close-day record is stored. Its Telegram report is queued server-side;
  // the browser never composes a Telegram message.
  var closeJobId = queueCafeCloseDayReport_(doc, payload);
  drainJobQueueQuietly_(doc);
  return jsonOutput_({ status: "success", reportJobId: closeJobId || "" });
}

/** Everything cafe_admin.html and cafe_pos.html need on load. */
function readCafeState_(doc, configSheet) {
  var salesSheet = doc.getSheetByName("Cafe_Sales");
  var sales = [];
  if (salesSheet && salesSheet.getLastRow() > 1) {
    var salesData = salesSheet.getDataRange().getValues();
    for (var j = 1; j < salesData.length; j++) {
      sales.push({
        date: salesData[j][0], seller: salesData[j][1], total: salesData[j][2],
        profit: salesData[j][3], items: safeParseJSON_(salesData[j][4], []), id: salesData[j][5]
      });
    }
  }

  var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni");
  var closeReports = [];
  if (closeSheet && closeSheet.getLastRow() > 1) {
    var closeData = closeSheet.getDataRange().getValues();
    for (var k = 1; k < closeData.length; k++) {
      closeReports.push({
        date: closeData[k][0], seller: closeData[k][1], totalRevenue: closeData[k][2],
        totalProfit: closeData[k][3], summary: safeParseJSON_(closeData[k][4], [])
      });
    }
  }

  return {
    inventory: safeParseJSON_(getConfig(configSheet, "Cafe_Inventory"), []),
    recipes: safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), []),
    categories: safeParseJSON_(getConfig(configSheet, "Cafe_Categories"), ["Ichimliklar", "Fast-Food", "Muzqaymoq"]),
    settings: safeParseJSON_(getConfig(configSheet, "Cafe_Settings"), { dailyTarget: 0 }),
    sales: sales,
    closeReports: closeReports
  };
}

// ----- apps-script/13_migration.gs ---------------------------------------------

// ============================================================
// Migration to canonical year-month periods
// ------------------------------------------------------------
// The original sheet is never overwritten. Migrated rows are written to a new
// versioned sheet, verified, and only then read from. Rollback is a config
// change, not a restore.
//
//   preview  -> what would happen, writing nothing
//   apply    -> write Omad_Transactions_V2 (original untouched)
//   verify   -> row counts, unique ids, per-period totals, balances
//   cutover  -> point reads at V2
//   rollback -> point reads back at the original
// ============================================================

var MIGRATION_STATUS_KEY = "Omad_Migration_Status";
var MIGRATION_SCHEMA_VERSION = LEDGER_SCHEMA_VERSION;

/**
 * Resolves every row without writing anything.
 *
 * Returns the proposed period for each row, a per-year summary, the rows whose
 * year could not be determined, duplicate ids, and the pre-migration financial
 * totals that verification will compare against.
 */
function previewOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var fallbackYear = Number((options && options.fallbackYear) || 0) || getFallbackYear_(configSheet);

  var sourceName = OMAD_TRANSACTIONS_SHEET;
  var sourceSheet = doc.getSheetByName(sourceName);
  var rows = readRawTransactionRows_(sourceSheet);

  var byYear = {};
  var bySource = {};
  var unresolved = [];
  var resolvedRows = [];
  var idCounts = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var resolution = resolveTransactionPeriod_(row, fallbackYear);
    idCounts[String(row.id)] = (idCounts[String(row.id)] || 0) + 1;
    bySource[resolution.source] = (bySource[resolution.source] || 0) + 1;

    if (!resolution.period) {
      unresolved.push({
        rowNumber: row.rowNumber,
        id: String(row.id),
        month: String(row.month),
        date: String(row.date),
        amount: Number(row.amount) || 0,
        currency: String(row.currency),
        reason: resolution.detail || resolution.source
      });
      continue;
    }

    var year = periodYear_(resolution.period);
    byYear[year] = (byYear[year] || 0) + 1;
    resolvedRows.push({ row: row, period: resolution.period, source: resolution.source });
  }

  var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; }).sort();

  return {
    sourceSheet: sourceName,
    targetSheet: OMAD_TRANSACTIONS_V2_SHEET,
    fallbackYear: fallbackYear,
    fallbackYearRequired: bySource.needs_fallback_year > 0 || bySource.conflict > 0,
    totalRows: rows.length,
    resolvedRows: resolvedRows.length,
    byYear: byYear,
    bySource: bySource,
    unresolved: unresolved,
    duplicateIds: duplicateIds,
    // What verification will compare against.
    totalsByPeriod: totalsByPeriod_(resolvedRows),
    balances: balanceTotals_(rows),
    ratePreview: migrateRatesMap_(safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), fallbackYear),
    canApply: rows.length > 0 && unresolved.length === 0 && duplicateIds.length === 0
  };
}

/** Raw rows with their sheet row number, so the operator can find them. */
function readRawTransactionRows_(sheet) {
  var rows = [];
  if (!sheet || sheet.getLastRow() < 2) return rows;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push({
      rowNumber: i + 1,
      id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
      amount: data[i][4], currency: data[i][5], method: data[i][6],
      date: data[i][7], comment: data[i][8], msgId: data[i][9],
      requestId: data[i].length > 10 ? data[i][10] : ""
    });
  }
  return rows;
}

/** Signed UZS totals per period, using each period's own sell rate. */
function totalsByPeriod_(resolvedRows) {
  var rates = getOmadRates_();
  var totals = {};
  for (var i = 0; i < resolvedRows.length; i++) {
    var entry = resolvedRows[i];
    var value = toUZS_(entry.row.amount, entry.row.currency, entry.period, rates, "sell");
    var sign = entry.row.type === "Income" ? 1 : -1;
    totals[entry.period] = Math.round((totals[entry.period] || 0) + value * sign);
  }
  return totals;
}

/** Cash, bank and total balances - invariants the migration must not move. */
function balanceTotals_(rows) {
  var rates = getOmadRates_();
  var cash = 0;
  var bank = 0;
  var income = 0;
  var expense = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var period = transactionPeriod_(row);
    var value = toUZS_(row.amount, row.currency, period, rates, "sell");
    var sign = row.type === "Income" ? 1 : -1;
    if (row.type === "Income") income += value; else expense += value;
    if (row.method === "Bank") bank += value * sign; else cash += value * sign;
  }

  return {
    cash: Math.round(cash),
    bank: Math.round(bank),
    total: Math.round(cash + bank),
    income: Math.round(income),
    expense: Math.round(expense)
  };
}

/**
 * Writes the migrated rows to the versioned sheet. The source sheet is not
 * touched, which is what makes rollback cheap.
 *
 * The target sheet is rewritten from scratch every time, so an interrupted
 * apply is recovered simply by running it again.
 */
function applyOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var preview = previewOmadMigration_(doc, options);

  if (preview.totalRows === 0) {
    return { status: "error", message: "Ko'chiriladigan yozuv yo'q.", preview: preview };
  }
  if (preview.duplicateIds.length > 0) {
    return {
      status: "error",
      message: "Takrorlangan ID topildi: " + preview.duplicateIds.join(", "),
      preview: preview
    };
  }
  if (preview.unresolved.length > 0 && options.allowUnresolved !== true) {
    return {
      status: "error",
      message: preview.unresolved.length + " ta yozuvning yili aniqlanmadi. " +
               "Zaxira yilni tanlang yoki sanalarni tuzating.",
      preview: preview
    };
  }

  if (preview.fallbackYear) setFallbackYear_(configSheet, preview.fallbackYear);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    backupOmadState_(doc, configSheet, "pre_period_migration");

    // The target is rebuilt from scratch, so an interrupted apply is recovered
    // simply by running it again.
    var target = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
                 doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
    clearSheetRows_(target);
    target.appendRow(LEDGER_HEADER);

    var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
    var migratedAt = new Date().toISOString();
    var written = [];
    for (var i = 0; i < sourceRows.length; i++) {
      var resolution = resolveTransactionPeriod_(sourceRows[i], preview.fallbackYear);
      if (!resolution.period) continue;
      written.push(transactionToLedgerRow_(
        migratedRowToLedger_(sourceRows[i], resolution.period, migratedAt)));
    }
    if (written.length > 0) {
      target.getRange(2, 1, written.length, LEDGER_HEADER.length).setValues(written);
    }

    // Rates carry a month but no date of their own, so they follow the same
    // fallback year. The original map is kept in the audit trail.
    var rateMigration = migrateRatesMap_(
      safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), preview.fallbackYear);
    setConfig(configSheet, "Omad_Rates_V1_Backup", getConfig(configSheet, "Omad_Rates") || "{}");
    setConfig(configSheet, "Omad_Rates", JSON.stringify(rateMigration.rates));

    recordMigrationStatus_(configSheet, {
      state: "applied",
      appliedAt: new Date().toISOString(),
      fallbackYear: preview.fallbackYear,
      sourceRows: preview.totalRows,
      migratedRows: written.length,
      skippedRows: preview.totalRows - written.length,
      schemaVersion: MIGRATION_SCHEMA_VERSION
    });
    appendAuditRow_(doc, "omad_period_migration_applied", JSON.stringify({
      migrated: written.length, skipped: preview.totalRows - written.length,
      fallbackYear: preview.fallbackYear, byYear: preview.byYear
    }));
  } finally {
    lock.releaseLock();
  }

  return { status: "success", preview: preview, verification: verifyOmadMigration_(doc) };
}

/**
 * Compares the migrated sheet against the original: row counts, unique ids,
 * per-period totals and the cash/bank/total balances.
 */
function verifyOmadMigration_(doc) {
  var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
  var targetSheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  // The target carries the append-only schema, so it is read as a ledger and
  // then shaped like the source for a like-for-like comparison.
  var targetRows = readLedgerRows_(doc).map(function (t) {
    return {
      id: t.id, tenant: t.tenant, month: t.period, type: t.type, amount: t.amount,
      currency: t.currency, method: t.method, date: t.createdAt, comment: t.comment,
      msgId: t.msgId, requestId: t.requestId, status: t.status
    };
  });
  var failures = [];

  if (!targetSheet) {
    return { ok: false, failures: ["Omad_Transactions_V2 varag'i topilmadi."] };
  }

  var configSheet = doc.getSheetByName("System_Config");
  var fallbackYear = getFallbackYear_(configSheet);

  if (targetRows.length !== sourceRows.length) {
    failures.push("Yozuvlar soni mos emas: " + sourceRows.length + " -> " + targetRows.length);
  }

  var seen = {};
  var duplicates = [];
  for (var i = 0; i < targetRows.length; i++) {
    var id = String(targetRows[i].id);
    if (seen[id]) duplicates.push(id); else seen[id] = true;
    if (!isCanonicalPeriod_(targetRows[i].month)) {
      failures.push("Kanonik bo'lmagan davr: " + targetRows[i].id + " -> " + targetRows[i].month);
    }
  }
  if (duplicates.length > 0) failures.push("Takrorlangan ID: " + duplicates.join(", "));

  // Per-period totals: the source resolves to the same periods the target
  // stores, so the two maps must be identical.
  var sourceResolved = [];
  for (var j = 0; j < sourceRows.length; j++) {
    var resolution = resolveTransactionPeriod_(sourceRows[j], fallbackYear);
    if (resolution.period) sourceResolved.push({ row: sourceRows[j], period: resolution.period });
  }
  var expectedTotals = totalsByPeriod_(sourceResolved);
  var actualTotals = totalsByPeriod_(targetRows.map(function (row) {
    return { row: row, period: String(row.month) };
  }));

  Object.keys(expectedTotals).forEach(function (period) {
    if (expectedTotals[period] !== actualTotals[period]) {
      failures.push("Davr yig'indisi mos emas (" + period + "): " +
                    expectedTotals[period] + " -> " + (actualTotals[period] || 0));
    }
  });
  Object.keys(actualTotals).forEach(function (period) {
    if (!Object.prototype.hasOwnProperty.call(expectedTotals, period)) {
      failures.push("Kutilmagan davr: " + period);
    }
  });

  var expectedBalances = balanceTotals_(sourceResolved.map(function (entry) {
    return Object.assign({}, entry.row, { period: entry.period });
  }));
  var actualBalances = balanceTotals_(targetRows);
  ["cash", "bank", "total", "income", "expense"].forEach(function (key) {
    if (expectedBalances[key] !== actualBalances[key]) {
      failures.push("Balans mos emas (" + key + "): " +
                    expectedBalances[key] + " -> " + actualBalances[key]);
    }
  });

  return {
    ok: failures.length === 0,
    failures: failures,
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    expectedTotals: expectedTotals,
    actualTotals: actualTotals,
    expectedBalances: expectedBalances,
    actualBalances: actualBalances
  };
}

/** Points reads and writes at the verified V2 sheet. */
function cutoverOmadMigration_(doc) {
  var verification = verifyOmadMigration_(doc);
  if (!verification.ok) {
    return { status: "error", message: "Tekshiruv o'tmadi.", verification: verification };
  }

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "pre_period_cutover");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_V2_SHEET);
  recordMigrationStatus_(configSheet, {
    state: "cutover",
    cutoverAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_V2_SHEET,
    schemaVersion: MIGRATION_SCHEMA_VERSION
  });
  appendAuditRow_(doc, "omad_period_migration_cutover", OMAD_TRANSACTIONS_V2_SHEET);

  return { status: "success", verification: verification, activeSheet: OMAD_TRANSACTIONS_V2_SHEET };
}

/**
 * Points reads back at the original sheet. V2 is left in place on purpose:
 * deleting data is never part of a rollback.
 */
function rollbackOmadMigration_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_SHEET);

  var backedUpRates = getConfig(configSheet, "Omad_Rates_V1_Backup");
  if (backedUpRates) setConfig(configSheet, "Omad_Rates", backedUpRates);

  recordMigrationStatus_(configSheet, {
    state: "rolled_back",
    rolledBackAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_SHEET,
    schemaVersion: 1
  });
  appendAuditRow_(doc, "omad_period_migration_rolled_back", OMAD_TRANSACTIONS_SHEET);

  return { status: "success", activeSheet: OMAD_TRANSACTIONS_SHEET };
}

function recordMigrationStatus_(configSheet, status) {
  var previous = safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {});
  setConfig(configSheet, MIGRATION_STATUS_KEY, JSON.stringify(Object.assign({}, previous, status)));
}

function getMigrationStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var stored = configSheet ? safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {}) : {};
  var v2 = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);

  return {
    state: stored.state || "not_started",
    schemaVersion: stored.schemaVersion || 1,
    fallbackYear: getFallbackYear_(configSheet),
    activeSheet: activeTransactionSheetName_(doc),
    versionedSheetExists: !!v2,
    versionedSheetRows: v2 ? Math.max(0, v2.getLastRow() - 1) : 0,
    sourceSheetRows: (function () {
      var source = doc.getSheetByName(OMAD_TRANSACTIONS_SHEET);
      return source ? Math.max(0, source.getLastRow() - 1) : 0;
    })(),
    appliedAt: stored.appliedAt || "",
    cutoverAt: stored.cutoverAt || "",
    rolledBackAt: stored.rolledBackAt || ""
  };
}

/**
 * A legacy row in the append-only schema. The rates in force for the resolved
 * period are frozen onto it, so post-migration rate edits cannot move it.
 */
function migratedRowToLedger_(row, period, migratedAt) {
  var normalized = normalizeTransaction_({
    id: row.id, tenant: row.tenant, month: period, type: row.type,
    amount: row.amount, currency: row.currency, method: row.method,
    date: row.date, comment: row.comment, msgId: row.msgId, requestId: row.requestId
  });
  var snapshot = buildRateSnapshot_(period, normalized.currency, "sell");

  return {
    id: normalized.id,
    requestId: normalized.requestId,
    // The original entry date is what matters; the migration timestamp is
    // recorded separately as the update.
    createdAt: legacyDateToIso_(row.date, period),
    updatedAt: migratedAt,
    createdBy: "migration",
    source: TX_SOURCE_MIGRATION,
    period: period,
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
    schemaVersion: LEDGER_SCHEMA_VERSION
  };
}

/** Best-effort ISO timestamp for a legacy row; falls back to the period start. */
function legacyDateToIso_(dateValue, period) {
  var parsed = parseTransactionDate_(dateValue);
  if (parsed) {
    var day = 1;
    var text = String(dateValue || "");
    var dmy = /^(\d{1,2})[\/.-]\d{1,2}[\/.-]\d{4}$/.exec(text);
    var iso = /^\d{4}-\d{2}-(\d{2})/.exec(text);
    if (dmy) day = Number(dmy[1]);
    else if (iso) day = Number(iso[1]);
    else if (typeof dateValue === "object" && dateValue.getDate) day = dateValue.getDate();
    return new Date(Date.UTC(parsed.year, parsed.month - 1, day)).toISOString();
  }
  return new Date(Date.UTC(periodYear_(period), periodMonth_(period) - 1, 1)).toISOString();
}

function clearSheetRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) sheet.deleteRows(1, lastRow);
}

// ----- apps-script/14_ledger.gs ------------------------------------------------

// ============================================================
// Append-only transaction ledger (schema V2)
// ------------------------------------------------------------
// Financial records are never rewritten in place and never deleted.
//
//   create  -> append one Active row
//   correct -> mark the original Corrected, append a new Active row that
//              points back at it
//   cancel  -> mark the row Cancelled; nothing is removed
//
// Every row carries the exchange rates that were in force when it was written,
// so changing a rate later cannot move a historical value.
// ============================================================

var LEDGER_SCHEMA_VERSION = 2;

var LEDGER_HEADER = [
  "ID",                 //  1 transaction id
  "Request_ID",         //  2 idempotency key
  "Created_At",         //  3 ISO timestamp
  "Updated_At",         //  4 ISO timestamp, set when the status changes
  "Created_By",         //  5 who or what wrote it
  "Source",             //  6 Web | Telegram | Migration
  "Period",             //  7 canonical YYYY-MM
  "Tenant",             //  8 tenant name, or the expense source
  "Type",               //  9 Income | Expense
  "Amount",             // 10 original amount
  "Currency",           // 11 UZS | USD
  "Rate_Buy",           // 12 buy rate available at write time
  "Rate_Sell",          // 13 sell rate available at write time
  "Rate_Used",          // 14 the rate actually applied
  "Rate_Type",          // 15 which of the two was applied
  "Amount_UZS",         // 16 converted value, frozen at write time
  "Method",             // 17 Naqd | Bank
  "Comment",            // 18 free text
  "Status",             // 19 Active | Corrected | Cancelled
  "Related_ID",         // 20 the transaction this one corrects
  "Telegram_Msg_ID",    // 21 group message id
  "Schema_Version"      // 22
];

var TX_STATUS_ACTIVE = "Active";
var TX_STATUS_CORRECTED = "Corrected";
var TX_STATUS_CANCELLED = "Cancelled";

var TX_SOURCE_WEB = "Web";
var TX_SOURCE_TELEGRAM = "Telegram";
var TX_SOURCE_MIGRATION = "Migration";

var TX_SOURCES = {};
TX_SOURCES[TX_SOURCE_WEB] = true;
TX_SOURCES[TX_SOURCE_TELEGRAM] = true;
TX_SOURCES[TX_SOURCE_MIGRATION] = true;

/** True once the migrated ledger is the sheet reads and writes go to. */
function isLedgerActive_(doc) {
  return activeTransactionSheetName_(doc) === OMAD_TRANSACTIONS_V2_SHEET;
}

function ledgerSheet_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
              doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(LEDGER_HEADER);
  return sheet;
}

function ledgerRowToTransaction_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    id: String(row[0]),
    requestId: String(row[1] || ""),
    createdAt: String(row[2] || ""),
    updatedAt: String(row[3] || ""),
    createdBy: String(row[4] || ""),
    source: String(row[5] || TX_SOURCE_WEB),
    period: String(row[6] || ""),
    tenant: String(row[7] || ""),
    type: row[8] === "Expense" ? "Expense" : "Income",
    amount: Number(row[9]) || 0,
    currency: row[10] === "USD" ? "USD" : "UZS",
    rateBuy: Number(row[11]) || 0,
    rateSell: Number(row[12]) || 0,
    rateUsed: Number(row[13]) || 0,
    rateType: String(row[14] || "sell"),
    amountUZS: Number(row[15]) || 0,
    method: row[16] === "Bank" ? "Bank" : "Naqd",
    comment: String(row[17] || ""),
    status: String(row[18] || TX_STATUS_ACTIVE),
    relatedId: String(row[19] || ""),
    msgId: String(row[20] || ""),
    schemaVersion: Number(row[21]) || LEDGER_SCHEMA_VERSION
  };
}

function transactionToLedgerRow_(t) {
  return [
    t.id, t.requestId, t.createdAt, t.updatedAt, t.createdBy, t.source, t.period,
    t.tenant, t.type, t.amount, t.currency, t.rateBuy, t.rateSell, t.rateUsed,
    t.rateType, t.amountUZS, t.method, t.comment, t.status, t.relatedId,
    t.msgId, t.schemaVersion
  ];
}

/** Every row, in sheet order, including corrected and cancelled ones. */
function readLedgerRows_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push(ledgerRowToTransaction_(data[i], i + 1));
  }
  return rows;
}

function findLedgerRow_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === String(transactionId)) return rows[i];
  }
  return null;
}

function findLedgerRowByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].requestId && rows[i].requestId === String(requestId)) return rows[i];
  }
  return null;
}

/**
 * A transaction as the rest of the app expects to see it. `month` is kept
 * alongside `period` so existing readers keep working unchanged.
 */
function ledgerToLegacyShape_(t) {
  return {
    id: t.id,
    tenant: t.tenant,
    month: t.period,
    period: t.period,
    periodLabel: formatPeriodLabel_(t.period),
    periodSource: "canonical",
    type: t.type,
    amount: t.amount,
    currency: t.currency,
    method: t.method,
    date: formatLedgerDate_(t.createdAt),
    comment: t.comment,
    msgId: t.msgId,
    requestId: t.requestId,
    status: t.status,
    relatedId: t.relatedId,
    source: t.source,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    createdBy: t.createdBy,
    rateBuy: t.rateBuy,
    rateSell: t.rateSell,
    rateUsed: t.rateUsed,
    rateType: t.rateType,
    amountUZS: t.amountUZS,
    schemaVersion: t.schemaVersion
  };
}

function formatLedgerDate_(isoTimestamp) {
  try {
    var parsed = new Date(String(isoTimestamp || ""));
    if (isNaN(parsed.getTime())) return "";
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "dd/MM/yyyy");
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------------------ validation

function validateTransactionInput_(input) {
  var payload = input || {};

  if (!isCanonicalPeriod_(payload.period)) return "Davr noto'g'ri (masalan 2026-01).";
  if (!String(payload.tenant || "").trim()) return "Obyekt tanlanmagan.";
  if (String(payload.tenant).length > 200) return "Obyekt nomi juda uzun.";

  var amount = Number(payload.amount);
  if (!isFinite(amount) || amount <= 0) return "Summa musbat raqam bo'lishi kerak.";
  if (amount > 1e15) return "Summa juda katta.";

  if (payload.currency !== "UZS" && payload.currency !== "USD") return "Valyuta noto'g'ri.";
  if (payload.method !== "Naqd" && payload.method !== "Bank") return "To'lov usuli noto'g'ri.";
  if (payload.type !== "Income" && payload.type !== "Expense") return "Operatsiya turi noto'g'ri.";
  if (String(payload.comment || "").length > 2000) return "Izoh juda uzun.";
  if (payload.source && !TX_SOURCES[payload.source]) return "Manba noto'g'ri.";

  return "";
}

/**
 * Freezes the rates in force right now onto the transaction. USD amounts are
 * converted at the sell rate; UZS amounts convert one-to-one and record the
 * rates anyway, so the history is complete.
 */
function buildRateSnapshot_(period, currency, rateType) {
  var rates = getOmadRates_();
  var entry = getPeriodRate_(rates, period);
  var appliedType = rateType === "buy" ? "buy" : "sell";
  var used = currency === "USD" ? (appliedType === "buy" ? entry.buy : entry.sell) : 1;

  return {
    rateBuy: entry.buy,
    rateSell: entry.sell,
    rateUsed: used,
    rateType: currency === "USD" ? appliedType : "none"
  };
}

// -------------------------------------------------------------------- create

/**
 * Appends one Active transaction. Idempotent on `requestId`: the same request
 * always resolves to the same record, so a retry, a refresh or a double-click
 * cannot create a second copy.
 */
function createTransaction_(doc, input) {
  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var requestId = String(input.requestId || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };
  if (requestId.length > 128) return { status: "error", message: "requestId juda uzun." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = findLedgerRowByRequestId_(doc, requestId);
    if (existing) {
      // Not an error: the caller gets exactly the record their request created.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(existing) };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var transaction = {
      id: input.id ? String(input.id) : nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: "",
      msgId: String(input.msgId || ""),
      schemaVersion: LEDGER_SCHEMA_VERSION
    };

    ledgerSheet_(doc).appendRow(transactionToLedgerRow_(transaction));
    appendAuditRow_(doc, "transaction_created", JSON.stringify({
      id: transaction.id, period: transaction.period, source: transaction.source,
      amount: transaction.amount, currency: transaction.currency
    }));

    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(transaction) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ids are "<epochMillis>_<n>". The suffix disambiguates two transactions
 * created inside the same millisecond, which the entry form does routinely.
 */
function nextTransactionId_(doc) {
  var stamp = String(new Date().getTime());
  var rows = readLedgerRows_(doc);
  var used = {};
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id.indexOf(stamp + "_") === 0) used[rows[i].id] = true;
  }
  var index = 0;
  while (used[stamp + "_" + index]) index++;
  return stamp + "_" + index;
}

// ------------------------------------------------------------------- correct

/**
 * Marks the original Corrected and appends a replacement that points back at
 * it. The original row is never edited beyond its status and timestamp, so the
 * audit trail keeps the value that was actually recorded at the time.
 */
function correctTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var alreadyDone = findLedgerRowByRequestId_(doc, requestId);
    if (alreadyDone) {
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(alreadyDone) };
    }

    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };
    if (original.status !== TX_STATUS_ACTIVE) {
      return {
        status: "error",
        message: "Bu tranzaksiya allaqachon " +
                 (original.status === TX_STATUS_CANCELLED ? "bekor qilingan" : "tuzatilgan") + "."
      };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var replacement = {
      id: nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: original.id,
      // The replacement inherits the group message so the report is edited
      // rather than duplicated.
      msgId: original.msgId,
      schemaVersion: LEDGER_SCHEMA_VERSION
    };

    var sheet = ledgerSheet_(doc);
    setLedgerStatus_(sheet, original.rowNumber, TX_STATUS_CORRECTED, now);
    sheet.appendRow(transactionToLedgerRow_(replacement));

    appendAuditRow_(doc, "transaction_corrected", JSON.stringify({
      original: original.id, replacement: replacement.id,
      before: { amount: original.amount, currency: original.currency, period: original.period },
      after: { amount: replacement.amount, currency: replacement.currency, period: replacement.period }
    }));

    return {
      status: "success",
      duplicate: false,
      transaction: ledgerToLegacyShape_(replacement),
      corrected: original.id
    };
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------- cancel

/** Marks a transaction Cancelled. Financial records are never deleted. */
function cancelTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };

    if (original.status === TX_STATUS_CANCELLED) {
      // Cancelling twice is the same outcome as cancelling once.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(original) };
    }
    if (original.status === TX_STATUS_CORRECTED) {
      return { status: "error", message: "Tuzatilgan yozuvni bekor qilib bo'lmaydi. Yangi yozuvni bekor qiling." };
    }

    var now = new Date().toISOString();
    setLedgerStatus_(ledgerSheet_(doc), original.rowNumber, TX_STATUS_CANCELLED, now);

    appendAuditRow_(doc, "transaction_cancelled", JSON.stringify({
      id: original.id, reason: String((input && input.reason) || "").slice(0, 500),
      amount: original.amount, currency: original.currency, period: original.period
    }));

    var cancelled = Object.assign({}, original, { status: TX_STATUS_CANCELLED, updatedAt: now });
    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(cancelled) };
  } finally {
    lock.releaseLock();
  }
}

function setLedgerStatus_(sheet, rowNumber, status, timestamp) {
  sheet.getRange(rowNumber, 19).setValue(status);
  sheet.getRange(rowNumber, 4).setValue(timestamp);
}

// ---------------------------------------------------------------------- read

/** Active transactions only - what the dashboard, reports and balances use. */
function listActiveTransactions_(doc, filters) {
  var options = filters || {};
  var rows = readLedgerRows_(doc);
  var result = [];

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status !== TX_STATUS_ACTIVE) continue;
    if (options.period && rows[i].period !== options.period) continue;
    if (options.tenant && rows[i].tenant !== options.tenant) continue;
    if (options.type && rows[i].type !== options.type) continue;
    result.push(ledgerToLegacyShape_(rows[i]));
  }
  return result;
}

function getTransaction_(doc, transactionId) {
  var found = findLedgerRow_(doc, transactionId);
  return found ? ledgerToLegacyShape_(found) : null;
}

/**
 * The full chain for one transaction: the record itself, whatever it corrected,
 * and whatever corrected it - newest last.
 */
function getTransactionHistory_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  var byId = {};
  for (var i = 0; i < rows.length; i++) byId[rows[i].id] = rows[i];

  var target = byId[String(transactionId)];
  if (!target) return null;

  // Walk back to the first record in the chain.
  var root = target;
  var guard = 0;
  while (root.relatedId && byId[root.relatedId] && guard++ < 1000) root = byId[root.relatedId];

  // Then forward, collecting every link.
  var chain = [root];
  var current = root;
  guard = 0;
  while (guard++ < 1000) {
    var next = null;
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].relatedId === current.id) { next = rows[j]; break; }
    }
    if (!next) break;
    chain.push(next);
    current = next;
  }

  return {
    transactionId: String(transactionId),
    chain: chain.map(ledgerToLegacyShape_),
    current: ledgerToLegacyShape_(chain[chain.length - 1])
  };
}

// ----- apps-script/20_api.gs ---------------------------------------------------

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

    // ---- Append-only ledger -----------------------------------------------
    if (isLedgerAction_(action)) {
      return ledgerAction_(action, payload, doc);
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

    // ---- Migration --------------------------------------------------------
    if (action === 'get_migration_status') {
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
    // The financial record is committed. Reporting is a separate retryable job.
    result.reportJobId = queueLedgerReport_(doc, action, result) || "";
    drainJobQueueQuietly_(doc);
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
    baseId: String(transaction.id).split("_")[0],
    messageId: String(transaction.msgId || "")
  });
}

