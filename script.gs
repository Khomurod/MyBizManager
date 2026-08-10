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

/**
 * The period held by a Month cell that the spreadsheet turned into a date.
 *
 * The Month column stores "2026-08". A spreadsheet whose column is not text
 * formatted reads that as a date and keeps 1 August instead, which loses the
 * canonical string. The year and month of that date are exactly the period
 * that was intended, so it is recovered rather than discarded - existing rows
 * heal themselves without anyone editing the sheet.
 *
 * Returns "" for month names and anything else that is not a date.
 */
function periodFromDateCell_(value) {
  var date = null;
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    date = value;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(String(value === null || value === undefined ? "" : value))) {
    date = new Date(String(value));
  }
  return date ? periodFromDate_(date) : "";
}

/**
 * Normalises whatever the Month column produced back into a storable value:
 * a canonical period stays as it is, a date cell becomes its period, and a
 * legacy month name is passed through untouched. Never stringifies a date.
 */
function normalizeMonthValue_(value) {
  if (isCanonicalPeriod_(value)) return String(value);
  var recovered = periodFromDateCell_(value);
  if (recovered) return recovered;
  return String(value === null || value === undefined ? "" : value).trim();
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
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }

  var text = String(value).trim();
  if (!text) return null;

  var dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text);
  if (dmy) {
    var day = Number(dmy[1]);
    var monthDmy = Number(dmy[2]);
    if (monthDmy < 1 || monthDmy > 12) return null;
    if (day < 1 || day > daysInMonth_(Number(dmy[3]), monthDmy)) return null;
    return { year: Number(dmy[3]), month: monthDmy, day: day };
  }

  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    // A full timestamp is an instant, not a calendar date. Reading it in the
    // script's timezone is what makes a value that came back from the sheet
    // round-trip to the same day instead of slipping to the one before.
    if (text.indexOf("T") > 0) {
      var instant = new Date(text);
      if (!isNaN(instant.getTime())) {
        return {
          year: instant.getFullYear(),
          month: instant.getMonth() + 1,
          day: instant.getDate()
        };
      }
    }
    var monthIso = Number(iso[2]);
    if (monthIso < 1 || monthIso > 12) return null;
    if (Number(iso[3]) < 1 || Number(iso[3]) > daysInMonth_(Number(iso[1]), monthIso)) return null;
    return { year: Number(iso[1]), month: monthIso, day: Number(iso[3]) };
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

  // A canonical period the spreadsheet stored as a date. It still says exactly
  // which month was meant, and it is more trustworthy than the Date column,
  // so it is honoured before anything is inferred from the date.
  var periodCell = periodFromDateCell_(monthValue);
  if (periodCell) {
    return { period: periodCell, source: "canonical_date_cell", confident: true };
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
  var fields = ["adminKey", "botToken", "authorizedUserId", "groupChatId", "tasksGroupChatId", "webhookUrl"];
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

/** Like validateTelegramChatId_ but an empty value is allowed (clears it). */
function validateOptionalTelegramChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "";
  return validateTelegramChatId_(value);
}

/**
 * The Tasks group id must be the numeric chat id.
 *
 * Unlike the reporting group - which is only ever a send target - the Tasks
 * group is also compared against `chat.id` on every incoming callback and
 * photo, and Telegram only ever sends the number. An @username would send
 * fine and then silently match nothing.
 */
function validateTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "Vazifalar guruhi ID kiritilmagan.";
  if (!/^-?\d{1,20}$/.test(value)) {
    return "Vazifalar guruhi ID raqam bo'lishi kerak (masalan -1001234567890). @username qo'llab-quvvatlanmaydi.";
  }
  return "";
}

/** Like validateTasksGroupChatId_ but empty is allowed (clears it). */
function validateOptionalTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  return value ? validateTasksGroupChatId_(value) : "";
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

// The Tasks group is stored alongside the reporting group, but is a distinct
// destination: task cards, reminders and completions go here and never mix
// with the accounting reports.
var TELEGRAM_PROP_TASKS_GROUP_CHAT_ID = "TELEGRAM_TASKS_GROUP_CHAT_ID";

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

/**
 * The group task cards, reminders and completions are posted to, in the one
 * form everything can agree on: the numeric chat id. A legacy or hand-edited
 * non-numeric value reads as "not configured" rather than half-working - the
 * settings page still shows what is stored so it can be corrected. "" disables.
 */
function getTasksGroupChatId_() {
  var value = String(getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID) || "").trim();
  return /^-?\d{1,20}$/.test(value) ? value : "";
}

function getOrCreateWebhookSecret_() {
  var existing = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  if (existing) return existing;
  var generated = Utilities.getUuid().split("-").join("") + Utilities.getUuid().split("-").join("");
  setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, generated);
  return generated;
}

/**
 * Every stored value that must never reach a log, a sheet cell or a client.
 * Read defensively: redaction runs inside error paths, where a missing
 * property must not itself throw.
 */
function storedSecretValues_() {
  var names = [
    TELEGRAM_PROP_BOT_TOKEN,
    TELEGRAM_PROP_WEBHOOK_SECRET,
    OMAD_PROP_ADMIN_KEY
  ];
  var values = [];
  for (var i = 0; i < names.length; i++) {
    var value = "";
    try { value = getTelegramSetting_(names[i]); } catch (error) { value = ""; }
    // One-character values would blank out ordinary text.
    if (value && String(value).length >= 8) values.push(String(value));
  }
  return values;
}

/**
 * Removes every credential from a string before it is logged or returned.
 *
 * Covers the configured bot token, the webhook verification secret and the
 * admin key by value, and - because a value can be rotated while an old log
 * line is still being written - anything *shaped* like one of them: a bot
 * token, a `wh=` webhook parameter, a `secret_token` field, or an
 * Authorization header.
 */
function redactSecrets_(value) {
  var text = value === null || value === undefined ? "" : String(value && value.message ? value.message : value);

  var secrets = storedSecretValues_();
  for (var i = 0; i < secrets.length; i++) {
    text = text.split(secrets[i]).join("[REDACTED]");
  }

  var token = "";
  try { token = getBotToken_(); } catch (error) { token = ""; }
  if (token) {
    var tokenId = token.split(":")[0];
    if (tokenId) text = text.split("bot" + tokenId).join("bot[REDACTED]");
  }

  return text
    .replace(TELEGRAM_TOKEN_LIKE_PATTERN, "[REDACTED]")
    // ...wh=<secret> in a URL or query string, however it is quoted.
    .replace(/([?&]wh=)[^&"'\s\\]+/gi, "$1[REDACTED]")
    // ..."secret_token":"<secret>" / secret_token=<secret>
    .replace(/("?secret_token"?\s*[:=]\s*"?)[^",&}\s]+/gi, "$1[REDACTED]")
    // ...Authorization: Bearer <value>
    .replace(/("?authorization"?\s*[:=]\s*"?)(bearer\s+)?[^",&}\s]+/gi, "$1[REDACTED]")
    // ...adminKey carried in a payload that gets logged.
    .replace(/("?adminKey"?\s*[:=]\s*"?)[^",&}\s]+/gi, "$1[REDACTED]");
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
    // The raw stored value, so a bad legacy one stays visible and fixable...
    tasksGroupChatId: getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID),
    // ...alongside whether anything will actually use it.
    tasksGroupChatIdUsable: !!getTasksGroupChatId_(),
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

  // The Tasks group is optional and only validated/stored when supplied, so a
  // legacy client that does not know about it leaves it untouched.
  var hasTasksGroup = Object.prototype.hasOwnProperty.call(payload, "tasksGroupChatId");
  if (hasTasksGroup) {
    var tasksChatError = validateOptionalTasksGroupChatId_(payload.tasksGroupChatId);
    if (tasksChatError) errors.push(tasksChatError);
  }

  if (errors.length > 0) return { status: "error", message: errors.join(" ") };

  if (hasToken) {
    setTelegramSetting_(TELEGRAM_PROP_BOT_TOKEN, String(payload.botToken).trim());
    updated.push("botToken");
  }
  setTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID, String(payload.authorizedUserId).trim());
  setTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID, String(payload.groupChatId).trim());
  updated.push("authorizedUserId", "groupChatId");
  if (hasTasksGroup) {
    // An empty value clears it, disabling the task Telegram integration.
    setTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID, String(payload.tasksGroupChatId || "").trim());
    updated.push("tasksGroupChatId");
  }

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

/**
 * The two figures the Telegram report quotes. Uses the value frozen on each
 * transaction where there is one, so a later rate edit cannot move a report
 * that has already been sent.
 */
function calculateBalancesFromTransactions_(transactions, targetPeriod) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    var period = transactionPeriod_(t);
    var signed = signedTransactionUZS_(t, rates);
    allTimeBalance += signed;
    if (period === String(targetPeriod || "")) monthBalance += signed;
  }

  return { monthBalance: Math.round(monthBalance), allTimeBalance: Math.round(allTimeBalance) };
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

// ----- apps-script/05a_calculations.gs -----------------------------------------

// ============================================================
// Shared money calculations
// ------------------------------------------------------------
// One implementation of every monetary rule, mirrored by
// assets/omad/02b-calc.js. The two must agree, so the rules are stated once,
// here, and both sides are tested against the same expectations.
//
// THE RATE RULE
// -------------
// Every UZS figure the business acts on - income, expenses, cash, bank, total
// balance, tenant payments, tenant debt, reports - uses the **sell** rate.
//
// Projections use the sell rate too. Mixing buy for expected income with sell
// for actual income made debt figures wrong by the spread: a tenant who paid
// exactly their rent could still show a balance. The buy rate is recorded on
// every transaction for history and is never used in a calculation.
// ============================================================

var RATE_TYPE_ACTUAL = "sell";
var RATE_TYPE_PROJECTION = "sell";

/**
 * The UZS value of one transaction.
 *
 * A ledger row carries the value frozen at write time, so editing a rate later
 * cannot move it. Legacy rows have no frozen value and are converted live -
 * which is exactly the drift the ledger removes.
 */
function transactionUZS_(transaction, rates) {
  var t = transaction || {};
  if (t.amountUZS !== undefined && t.amountUZS !== null && t.amountUZS !== "") {
    return Number(t.amountUZS) || 0;
  }
  return toUZS_(t.amount, t.currency, transactionPeriod_(t), rates || getOmadRates_(), RATE_TYPE_ACTUAL);
}

function signedTransactionUZS_(transaction, rates) {
  var value = transactionUZS_(transaction, rates);
  return transaction && transaction.type === "Expense" ? -value : value;
}

/** True when a transaction should be counted. Cancelled and corrected are not. */
function isCountableTransaction_(transaction) {
  var status = (transaction && transaction.status) || TX_STATUS_ACTIVE;
  return status === TX_STATUS_ACTIVE;
}

/**
 * Income, expense, net, and the cash/bank/total balances.
 *
 * `period` scopes income/expense/net. Balances are always all-time: money in
 * the safe does not reset when you change the reporting month.
 */
function calculateActuals_(transactions, period) {
  var rates = getOmadRates_();
  var result = { income: 0, expense: 0, net: 0, cash: 0, bank: 0, total: 0 };
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;

    var value = transactionUZS_(t, rates);
    var signed = t.type === "Expense" ? -value : value;

    if (t.method === "Bank") result.bank += signed; else result.cash += signed;

    if (!period || period === ALL_PERIODS_LABEL || transactionPeriod_(t) === period) {
      if (t.type === "Expense") result.expense += value; else result.income += value;
    }
  }

  result.net = result.income - result.expense;
  result.total = result.cash + result.bank;

  return roundMoneyFields_(result);
}

function roundMoneyFields_(values) {
  var rounded = {};
  Object.keys(values).forEach(function (key) { rounded[key] = Math.round(values[key]); });
  return rounded;
}

/** What a tenant actually paid in a period, at the sell rate. */
function calculateTenantPaid_(transactions, tenantName, period) {
  var rates = getOmadRates_();
  var key = String(tenantName || "").trim();
  var total = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    if (t.type !== "Income") continue;
    if (String(t.tenant || "").trim() !== key) continue;
    if (period && period !== ALL_PERIODS_LABEL && transactionPeriod_(t) !== period) continue;
    total += transactionUZS_(t, rates);
  }
  return Math.round(total);
}

/**
 * The rent expected from a tenant in a period, at the sell rate.
 * The amount comes from the tenant's effective-dated schedule, so a month with
 * an exception, a no-rent month, or a month outside the agreement all resolve
 * correctly - and a historical month keeps the rent that applied then.
 */
function tenantExpectedRentUZS_(tenant, period) {
  var t = tenant || {};
  var rent = effectiveTenantRent_(t, period);
  if (rent <= 0) return 0;
  return Math.round(toUZS_(rent, t.currency, period, getOmadRates_(), RATE_TYPE_PROJECTION));
}

/**
 * A tenant's position for a period.
 * Negative `difference` is debt; positive is an overpayment.
 */
function calculateTenantBalance_(transactions, tenant, period) {
  var expected = tenantExpectedRentUZS_(tenant, period);
  var paid = calculateTenantPaid_(transactions, tenant && tenant.name, period);
  return { expected: expected, paid: paid, difference: paid - expected };
}

/**
 * Expected income and planned expenses for a period.
 *
 * Projections are a plan, not money that moved: a planned expense is never
 * counted as paid. Compare it with `calculateActuals_` rather than adding the
 * two together - see `comparePlanToActual_`.
 */
function calculateProjection_(tenants, plannedExpenses, period) {
  var rates = getOmadRates_();
  var expectedIncome = 0;
  var plannedExpense = 0;

  var tenantList = Array.isArray(tenants) ? tenants : [];
  for (var i = 0; i < tenantList.length; i++) {
    expectedIncome += tenantExpectedRentUZS_(tenantList[i], period);
  }


  // Recurrence decides which expenses fall due, not a stored month. Callers
  // may pass raw records, so they are normalised here.
  var due = plannedExpensesForPeriod_(normalizeTemplateExpenses_(plannedExpenses), period);
  for (var j = 0; j < due.length; j++) {
    plannedExpense += toUZS_(due[j].expense.amount, due[j].expense.currency, period, rates, RATE_TYPE_PROJECTION);
  }

  return roundMoneyFields_({
    expectedIncome: expectedIncome,
    plannedExpense: plannedExpense,
    net: expectedIncome - plannedExpense
  });
}

/**
 * Plan against reality for one period, side by side.
 *
 * `plannedExpense` is what was scheduled; `actualExpense` is what actually
 * left. They are deliberately never summed: a planned expense that has been
 * paid appears in both, and adding them would double-count it. `outstanding`
 * is what is still expected to leave, floored at zero.
 */
function comparePlanToActual_(transactions, tenants, plannedExpenses, period) {
  var projection = calculateProjection_(tenants, plannedExpenses, period);
  var actuals = calculateActuals_(transactions, period);

  return {
    period: period,
    expectedIncome: projection.expectedIncome,
    actualIncome: actuals.income,
    plannedExpense: projection.plannedExpense,
    actualExpense: actuals.expense,
    // What is still expected, not a total.
    outstandingIncome: Math.max(0, projection.expectedIncome - actuals.income),
    outstandingExpense: Math.max(0, projection.plannedExpense - actuals.expense),
    projectedNet: projection.net,
    actualNet: actuals.net
  };
}

// ----- apps-script/06_tenants.gs -----------------------------------------------

// ============================================================
// Tenants & rent schedules
// ------------------------------------------------------------
// A tenant's rent is effective-dated, not a single number.
//
//   defaultRent   what the agreement says
//   startPeriod   when the agreement begins ("" = always has)
//   endPeriod     when it ends ("" = open-ended)
//   rentChanges   [{ fromPeriod, amount }] - a new default from a period on
//   exceptions    [{ period, amount }] - one month at a different amount
//   noRentPeriods ["2026-12"] - one month with no rent at all
//   active        an inactive tenant is owed nothing, and can be reactivated
//
// Resolution order is deliberate: a no-rent month beats an exception, an
// exception beats a scheduled change, and a scheduled change beats the
// default. Anything outside start/end is zero regardless.
//
// Legacy tenants stored `{ name, rent, currency, disabledMonths }`. Those are
// still honoured: `rent` becomes the default and `disabledMonths` keeps
// working as month names that repeat every year.
// ============================================================

function normalizeTenantList_(tenants) {
  var source = Array.isArray(tenants) ? tenants : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var tenant = typeof item === "string" ? { name: item } : (item || {});
    var name = String(tenant.name || "").trim();
    if (!name) continue;
    normalized.push(normalizeTenant_(tenant, name));
  }
  return normalized;
}

function normalizeTenant_(tenant, name) {
  var defaultRent = tenant.defaultRent !== undefined
    ? (Number(tenant.defaultRent) || 0)
    : (Number(tenant.rent) || 0);

  return {
    name: name,
    // `rent` is kept in step with `defaultRent` so older readers still work.
    rent: defaultRent,
    defaultRent: defaultRent,
    currency: tenant.currency === "UZS" ? "UZS" : "USD",
    active: tenant.active === undefined ? true : tenant.active !== false,
    startPeriod: isCanonicalPeriod_(tenant.startPeriod) ? tenant.startPeriod : "",
    endPeriod: isCanonicalPeriod_(tenant.endPeriod) ? tenant.endPeriod : "",
    rentChanges: normalizeRentChanges_(tenant.rentChanges),
    exceptions: normalizeRentExceptions_(tenant.exceptions),
    noRentPeriods: normalizePeriodList_(tenant.noRentPeriods),
    disabledMonths: Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : []
  };
}

/** Scheduled default-rent changes, earliest first, one per period. */
function normalizeRentChanges_(changes) {
  var source = Array.isArray(changes) ? changes : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var change = source[i] || {};
    if (!isCanonicalPeriod_(change.fromPeriod)) continue;
    var amount = Number(change.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[change.fromPeriod] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { fromPeriod: period, amount: byPeriod[period] };
  });
}

/** One-month overrides, earliest first, one per period. */
function normalizeRentExceptions_(exceptions) {
  var source = Array.isArray(exceptions) ? exceptions : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var exception = source[i] || {};
    if (!isCanonicalPeriod_(exception.period)) continue;
    var amount = Number(exception.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[exception.period] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { period: period, amount: byPeriod[period] };
  });
}

function normalizePeriodList_(periods) {
  var source = Array.isArray(periods) ? periods : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    if (isCanonicalPeriod_(source[i])) seen[source[i]] = true;
  }
  return Object.keys(seen).sort();
}

/** True when the agreement covers this period at all. */
function isTenantInScheduleForPeriod_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return false;
  if (!isCanonicalPeriod_(period)) return false;
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return false;
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return false;
  return true;
}

/**
 * Legacy month-name switches. A disabled month repeats every year, which is
 * exactly why the schedule fields replace it; it stays honoured so existing
 * tenant records keep behaving as their operator set them up.
 */
function isTenantDisabledForPeriod_(tenant, period) {
  var disabled = (tenant && Array.isArray(tenant.disabledMonths)) ? tenant.disabledMonths : [];
  if (disabled.length === 0) return false;
  if (disabled.indexOf(period) !== -1) return true;
  var month = periodMonth_(period);
  return month > 0 && disabled.indexOf(UZBEK_MONTHS[month - 1]) !== -1;
}

/**
 * The rent actually due from a tenant in one period, in the tenant's own
 * currency. Zero means nothing is owed - which is different from "no rent
 * configured", and both are legitimate.
 */
function effectiveTenantRent_(tenant, period) {
  var t = tenant || {};
  if (!isTenantInScheduleForPeriod_(t, period)) return 0;
  if (isTenantDisabledForPeriod_(t, period)) return 0;

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return 0;

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return Number(exceptions[i].amount) || 0;
  }

  // The latest scheduled change that has already taken effect wins.
  var amount = t.defaultRent !== undefined ? Number(t.defaultRent) || 0 : Number(t.rent) || 0;
  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = 0; j < changes.length; j++) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) amount = Number(changes[j].amount) || 0;
  }
  return amount;
}

/** Why a period resolved the way it did - shown in the schedule editor. */
function tenantRentSource_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return "inactive";
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return "before_start";
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return "after_end";
  if (isTenantDisabledForPeriod_(t, period)) return "disabled_month";

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return "no_rent";

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return "exception";
  }

  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = changes.length - 1; j >= 0; j--) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) return "scheduled_change";
  }
  return "default";
}

/** The whole year at a glance, for the schedule editor. */
function tenantScheduleForYear_(tenant, year) {
  var rows = [];
  for (var month = 1; month <= 12; month++) {
    var period = buildPeriod_(year, month);
    rows.push({
      period: period,
      label: formatPeriodLabel_(period),
      rent: effectiveTenantRent_(tenant, period),
      currency: (tenant && tenant.currency) || "USD",
      source: tenantRentSource_(tenant, period)
    });
  }
  return rows;
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
      // An incoming record replaces the stored one, except that a legacy
      // client which does not know about `disabledMonths` must not wipe them.
      merged[indexByName[incoming.name]] = Object.assign({}, incoming, {
        disabledMonths: Array.isArray(incoming.disabledMonths) && incoming.disabledMonths.length > 0
          ? incoming.disabledMonths
          : (incoming.disabledMonths || existing.disabledMonths || [])
      });
    }
  }
  return merged;
}

/** Tenants whose agreement is live right now - what the Telegram bot offers. */
function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var period = currentPeriod_();
  var names = [];
  for (var i = 0; i < tenants.length; i++) {
    if (tenants[i].active === false) continue;
    if (tenants[i].endPeriod && comparePeriods_(period, tenants[i].endPeriod) > 0) continue;
    names.push(tenants[i].name);
  }
  return names;
}

// ----- apps-script/07_planned_expenses.gs --------------------------------------

// ============================================================
// Planned expenses
// ------------------------------------------------------------
// A planned expense is a *plan*: it says money is expected to leave in given
// periods. It is never money that moved. Nothing here is ever counted as paid
// - only a real expense transaction is - so projected and actual figures are
// reported side by side and never summed.
//
// Frequencies: once, monthly, every 2/3/6/12 months, selected months of the
// year, or a custom interval.
// Ending rules: never, until a period, or after a number of occurrences.
//
// Legacy `{ id, month, name, amount, currency }` records are read as one-time
// expenses in that month, so nothing needs migrating.
// ============================================================

var EXPENSE_FREQ_ONCE = "once";
var EXPENSE_FREQ_MONTHLY = "monthly";
var EXPENSE_FREQ_SELECTED = "selected_months";
var EXPENSE_FREQ_CUSTOM = "custom_interval";

/** Frequency -> the interval in months. 0 means "not interval-based". */
var EXPENSE_FREQUENCY_INTERVALS = {
  once: 0,
  monthly: 1,
  every_2_months: 2,
  every_3_months: 3,
  every_6_months: 6,
  every_12_months: 12,
  selected_months: 0,
  custom_interval: 0
};

var EXPENSE_END_NEVER = "never";
var EXPENSE_END_UNTIL = "until_period";
var EXPENSE_END_COUNT = "after_occurrences";

/** A generous bound so a malformed record can never loop forever. */
var EXPENSE_MAX_LOOKBACK_MONTHS = 1200;

function normalizeTemplateExpenses_(expenses) {
  var source = Array.isArray(expenses) ? expenses : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = normalizePlannedExpense_(source[i], i);
    if (item) normalized.push(item);
  }
  return normalized;
}

function normalizePlannedExpense_(rawExpense, index) {
  var expense = rawExpense && typeof rawExpense === "object" ? rawExpense : {};
  var name = String(expense.name || "").trim();
  if (!name) return null;

  // Legacy records carry `month` and nothing else; they are one-time expenses.
  var startPeriod = isCanonicalPeriod_(expense.startPeriod) ? expense.startPeriod
    : (isCanonicalPeriod_(expense.month) ? expense.month
    : (isCanonicalPeriod_(expense.period) ? expense.period : ""));

  var frequency = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] !== undefined
    ? expense.frequency
    : EXPENSE_FREQ_ONCE;

  var intervalMonths = Math.floor(Number(expense.intervalMonths) || 0);
  if (frequency === EXPENSE_FREQ_CUSTOM && (intervalMonths < 1 || intervalMonths > 120)) {
    // An unusable custom interval degrades to monthly rather than vanishing.
    frequency = EXPENSE_FREQ_MONTHLY;
    intervalMonths = 0;
  }

  return {
    id: String(expense.id || (new Date().getTime() + "_" + index)),
    name: name,
    amount: Number(expense.amount) || 0,
    currency: expense.currency === "USD" ? "USD" : "UZS",
    startPeriod: startPeriod,
    // `month` mirrors the start so older readers keep working.
    month: startPeriod,
    frequency: frequency,
    intervalMonths: frequency === EXPENSE_FREQ_CUSTOM ? intervalMonths : 0,
    selectedMonths: normalizeSelectedMonths_(expense.selectedMonths),
    ending: normalizeExpenseEnding_(expense.ending),
    active: expense.active === undefined ? true : expense.active !== false,
    description: String(expense.description || "").slice(0, 500)
  };
}

function normalizeSelectedMonths_(months) {
  var source = Array.isArray(months) ? months : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    var month = Math.floor(Number(source[i]));
    if (month >= 1 && month <= 12) seen[month] = true;
  }
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
}

function normalizeExpenseEnding_(ending) {
  var value = ending && typeof ending === "object" ? ending : {};

  if (value.type === EXPENSE_END_UNTIL && isCanonicalPeriod_(value.untilPeriod)) {
    return { type: EXPENSE_END_UNTIL, untilPeriod: value.untilPeriod, occurrences: 0 };
  }
  if (value.type === EXPENSE_END_COUNT) {
    var occurrences = Math.floor(Number(value.occurrences) || 0);
    if (occurrences >= 1) return { type: EXPENSE_END_COUNT, untilPeriod: "", occurrences: occurrences };
  }
  return { type: EXPENSE_END_NEVER, untilPeriod: "", occurrences: 0 };
}

/** Whole months between two canonical periods; negative when `to` precedes `from`. */
function monthsBetweenPeriods_(fromPeriod, toPeriod) {
  return (periodYear_(toPeriod) * 12 + periodMonth_(toPeriod)) -
         (periodYear_(fromPeriod) * 12 + periodMonth_(fromPeriod));
}

/** True when the frequency alone puts an occurrence in this period. */
function matchesExpenseFrequency_(expense, period) {
  var offset = monthsBetweenPeriods_(expense.startPeriod, period);
  if (offset < 0) return false;

  if (expense.frequency === EXPENSE_FREQ_ONCE) return offset === 0;
  if (expense.frequency === EXPENSE_FREQ_SELECTED) {
    return expense.selectedMonths.indexOf(periodMonth_(period)) !== -1;
  }
  if (expense.frequency === EXPENSE_FREQ_CUSTOM) {
    return expense.intervalMonths > 0 && offset % expense.intervalMonths === 0;
  }

  var interval = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] || 1;
  return offset % interval === 0;
}

/**
 * The 1-based occurrence number for a period, or 0 when the expense does not
 * fall due then. Needed by the "end after N occurrences" rule, and useful in
 * the UI ("3 of 12").
 */
function plannedExpenseOccurrence_(expense, period) {
  var e = expense || {};
  if (e.active === false) return 0;
  if (!isCanonicalPeriod_(period) || !isCanonicalPeriod_(e.startPeriod)) return 0;
  if (!matchesExpenseFrequency_(e, period)) return 0;

  var ending = e.ending || { type: EXPENSE_END_NEVER };
  if (ending.type === EXPENSE_END_UNTIL && comparePeriods_(period, ending.untilPeriod) > 0) return 0;

  var offset = monthsBetweenPeriods_(e.startPeriod, period);
  if (offset > EXPENSE_MAX_LOOKBACK_MONTHS) return 0;

  // Count the occurrences from the start up to and including this period.
  var occurrence = 0;
  for (var step = 0; step <= offset; step++) {
    if (matchesExpenseFrequency_(e, addMonthsToPeriod_(e.startPeriod, step))) occurrence++;
  }

  if (ending.type === EXPENSE_END_COUNT && occurrence > ending.occurrences) return 0;
  return occurrence;
}

function plannedExpenseAppliesTo_(expense, period) {
  return plannedExpenseOccurrence_(expense, period) > 0;
}

/** Every planned expense that falls due in a period, with its occurrence number. */
function plannedExpensesForPeriod_(expenses, period) {
  var list = Array.isArray(expenses) ? expenses : [];
  var due = [];
  for (var i = 0; i < list.length; i++) {
    var occurrence = plannedExpenseOccurrence_(list[i], period);
    if (occurrence > 0) due.push({ expense: list[i], occurrence: occurrence });
  }
  return due;
}

/**
 * A human-readable summary of when an expense falls due. Kept here so both
 * sides describe a schedule identically.
 */
function describePlannedExpense_(expense) {
  var e = expense || {};
  var labels = {
    once: "Bir marta",
    monthly: "Har oy",
    every_2_months: "Har 2 oyda",
    every_3_months: "Har 3 oyda",
    every_6_months: "Har 6 oyda",
    every_12_months: "Har yili"
  };

  var frequency = labels[e.frequency];
  if (e.frequency === EXPENSE_FREQ_SELECTED) {
    var names = (e.selectedMonths || []).map(function (month) { return UZBEK_MONTHS_SHORT[month - 1]; });
    frequency = names.length ? names.join(", ") : "Oylar tanlanmagan";
  } else if (e.frequency === EXPENSE_FREQ_CUSTOM) {
    frequency = "Har " + e.intervalMonths + " oyda";
  }

  var rule = e.ending || {};
  var ending = "";
  if (rule.type === EXPENSE_END_UNTIL) ending = formatPeriodLabel_(rule.untilPeriod) + " gacha";
  else if (rule.type === EXPENSE_END_COUNT) ending = rule.occurrences + " marta";

  var parts = [formatPeriodLabel_(e.startPeriod) + " dan", frequency];
  if (ending) parts.push(ending);
  return parts.join(" • ");
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

// ----- apps-script/09_telegram_service.gs --------------------------------------

// ============================================================
// Telegram service
// ------------------------------------------------------------
// Everything that talks to api.telegram.org, plus the /yangi conversation.
// There is no generic "send this text" entry point.
// ============================================================

/**
 * A chat id reduced to something recognisable but not reusable: the sign and
 * the last four digits. Enough to tell the group from a private chat in a log.
 */
function maskChatId_(chatId) {
  var text = String(chatId === null || chatId === undefined ? "" : chatId);
  if (!text) return "";
  var negative = text.charAt(0) === "-";
  var digits = text.replace(/[^0-9]/g, "");
  if (digits.length <= 4) return (negative ? "-" : "") + digits;
  return (negative ? "-" : "") + "..." + digits.slice(-4);
}

/** The `description` Telegram returns on failure, redacted, or "". */
function telegramErrorDescription_(responseText) {
  var parsed = safeParseJSON_(responseText, null);
  if (!parsed || parsed.ok) return "";
  return redactSecrets_(String(parsed.description || "")).slice(0, 300);
}

/**
 * True when Telegram is telling us the thing we asked to change is already in
 * the state we wanted. Deleting a message that is already gone is the desired
 * outcome, not a failure to retry.
 */
function isAlreadyDoneTelegramError_(responseText) {
  var parsed = safeParseJSON_(responseText, null);
  if (!parsed || parsed.ok) return false;
  var description = String(parsed.description || "").toLowerCase();
  return description.indexOf("message to delete not found") >= 0 ||
         description.indexOf("message can't be deleted") >= 0 ||
         description.indexOf("message identifier is not specified") >= 0 ||
         description.indexOf("message to edit not found") >= 0;
}

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

  // Only facts that cannot carry a credential. The request body is never
  // logged: setWebhook carries the verification secret in both the URL and
  // secret_token, and that is exactly how it reached the debug sheet before.
  debugLog_(SpreadsheetApp.getActiveSpreadsheet(), "telegram_api_" + method, JSON.stringify({
    code: responseCode,
    chat: maskChatId_(body && body.chat_id),
    messageId: (body && body.message_id) || "",
    ok: responseCode >= 200 && responseCode < 300,
    description: telegramErrorDescription_(responseText)
  }));

  if (responseCode < 200 || responseCode >= 300) {
    var failure = "Telegram API " + method + " failed (HTTP " + responseCode + "): " + responseText;
    recordTelegramError_(method, failure);
    throw new Error(redactSecrets_(failure));
  }

  recordTelegramSuccess_(method);
  return response;
}

function sendTelegramMessage_(chatId, text, replyMarkup, parseMode, options) {
  var body = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  if (options && options.replyToMessageId) {
    body.reply_to_message_id = Number(options.replyToMessageId) || options.replyToMessageId;
    // The card can have been deleted; a prompt that cannot attach itself is
    // still better than no prompt at all.
    body.allow_sending_without_reply = true;
  }
  return telegramFetch_("sendMessage", body);
}

function editTelegramMessage_(chatId, messageId, text, replyMarkup) {
  var body = { chat_id: chatId, message_id: messageId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramFetch_("editMessageText", body);
}

/**
 * Deletes a group message, treating "it is already gone" as success.
 *
 * Telegram answers HTTP 400 both for a message that never existed and for one
 * already deleted, and neither can be fixed by trying again. Any other failure
 * still throws, so a genuine outage is retried.
 */
function deleteTelegramMessageIfPresent_(chatId, messageId) {
  var token = getBotToken_();
  if (!token) throw new Error("Telegram bot token is not configured. Set it in Sozlamalar → Telegram.");

  var response;
  try {
    response = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      muteHttpExceptions: true
    });
  } catch (transportError) {
    recordTelegramError_("deleteMessage", transportError);
    throw new Error("Telegram API deleteMessage unreachable: " + redactSecrets_(transportError));
  }

  var responseText = response.getContentText();
  var responseCode = response.getResponseCode();

  debugLog_(SpreadsheetApp.getActiveSpreadsheet(), "telegram_api_deleteMessage", JSON.stringify({
    code: responseCode,
    chat: maskChatId_(chatId),
    messageId: String(messageId),
    ok: responseCode >= 200 && responseCode < 300,
    description: telegramErrorDescription_(responseText)
  }));

  if (responseCode >= 200 && responseCode < 300) {
    recordTelegramSuccess_("deleteMessage");
    return { status: "deleted" };
  }

  if (isAlreadyDoneTelegramError_(responseText)) {
    // The end state is what was asked for, so the job is complete.
    recordTelegramSuccess_("deleteMessage");
    return { status: "already_gone" };
  }

  var failure = "Telegram API deleteMessage failed (HTTP " + responseCode + "): " + responseText;
  recordTelegramError_("deleteMessage", failure);
  throw new Error(redactSecrets_(failure));
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

    if (reportJobId) drainJobQueueQuietly_(doc, null);
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
    // The value stored on the transaction, not today's rate.
    var valueUZS = transactionUZS_(group[i], rates);
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

// Deliberately one. A save returns as soon as the financial record is safely
// stored; at most one queued report rides along, and the time-driven trigger
// picks up everything else. Draining the whole queue inline would make the
// user wait for work they do not care about.
var JOB_QUEUE_INLINE_BATCH = 1;

var JOB_QUEUE_MANUAL_BATCH = 25;

var JOB_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function jobQueueSheet_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET) || doc.insertSheet(JOB_QUEUE_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(JOB_QUEUE_HEADER);
  return sheet;
}

/**
 * True when an identical piece of work is already waiting.
 *
 * Asking twice for the same group message to be deleted is one instruction,
 * not two: the second job could only ever find the message already gone.
 */
function hasPendingJob_(doc, type, relatedId, payload) {
  var read = readJobRows_(doc);
  var wanted = JSON.stringify(payload || {});
  for (var i = 0; i < read.rows.length; i++) {
    var job = read.rows[i];
    if (job.status !== JOB_STATUS_PENDING && job.status !== JOB_STATUS_PROCESSING) continue;
    if (job.type !== String(type)) continue;
    if (job.relatedId !== String(relatedId || "")) continue;
    if (JSON.stringify(job.payload || {}) === wanted) return job.jobId;
  }
  return "";
}

function enqueueJob_(doc, type, relatedId, payload) {
  // Deduplicated before it is written, so a repeated instruction cannot leave
  // a second job behind to fail on its own.
  var duplicate = hasPendingJob_(doc, type, relatedId, payload);
  if (duplicate) return duplicate;

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

function failJob_(sheet, job, error, doc) {
  var attempts = job.attempts + 1;
  var exhausted = attempts >= JOB_MAX_ATTEMPTS;
  var delaySeconds = JOB_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1));
  writeJobField_(sheet, job.rowNumber, 5, exhausted ? JOB_STATUS_FAILED : JOB_STATUS_PENDING);
  writeJobField_(sheet, job.rowNumber, 6, attempts);
  writeJobField_(sheet, job.rowNumber, 7, new Date(new Date().getTime() + delaySeconds * 1000).toISOString());
  writeJobField_(sheet, job.rowNumber, 8, redactSecrets_(error).slice(0, 500));
  if (exhausted) {
    writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
    // Some jobs leave state behind that only makes sense while they are still
    // going to be retried.
    if (doc) {
      try { onJobPermanentlyFailed_(doc, job); } catch (hookError) {}
    }
  }
}

/** Last-chance cleanup when a job will never be attempted again. */
function onJobPermanentlyFailed_(doc, job) {
  if (job.type === "task_proof_prompt") releaseStuckProofPrompt_(doc, job);
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
      failJob_(job.sheet, job, error, doc);
    }
  }
  return processed;
}

/**
 * Best-effort inline drain. Never throws into the caller's response path, and
 * never processes more than one job, so confirming a save stays fast.
 *
 * Pass `deferReports: true` on a request to skip it entirely and leave
 * everything to the trigger.
 */
function drainJobQueueQuietly_(doc, options) {
  if (options && options.deferReports === true) return 0;
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
  if (isTaskJobType_(job.type)) return runTaskJob_(doc, job);
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

  // The resolved period, not the raw Month cell: balances are compared against
  // resolved periods, so passing "Avgust" (or a date cell) matched nothing and
  // every report quoted a month balance of 0.
  var balances = calculateBalancesFromTransactions_(
    readOmadTransactions_(doc), transactionPeriod_(group[0]));
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

/**
 * Removes a group report.
 *
 * Deleting is a statement about the end state, not about who got there first:
 * if the message is already gone the job has nothing left to do and is done.
 * Retrying that forever only produced a permanently failed queue entry, which
 * is what happened when one deletion was requested twice.
 */
function runOmadDeleteReportJob_(job) {
  var messageId = String((job.payload && job.payload.messageId) || "");
  if (!messageId) return;

  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  deleteTelegramMessageIfPresent_(chatId, messageId);
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
  // Queueing the report must never undo a close-day that is already stored.
  var closeJobId = "";
  try {
    closeJobId = queueCafeCloseDayReport_(doc, payload);
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
  drainJobQueueQuietly_(doc, payload);
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
      // Formats first: every migrated row carries a canonical period, and the
      // spreadsheet would otherwise turn all of them into dates on the way in.
      applyLedgerColumnFormats_(target, 2, written.length);
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
/**
 * The UZS value a migrated row *claims*, checked against its own frozen rate.
 *
 * A frozen value must never be re-derived from the current rate table - that
 * is the whole point of freezing it, and doing so would make verification
 * agree with any figure the table happens to produce today. It is instead
 * checked for internal consistency: the amount, the rate recorded on the row,
 * and the stored total have to describe the same conversion.
 */
function frozenAmountFailures_(row) {
  var failures = [];
  var amount = Number(row.amount) || 0;
  var stored = Number(row.amountUZS);
  var used = Number(row.rateUsed) || 0;

  if (!isFinite(stored)) {
    failures.push("Amount_UZS o'qib bo'lmadi: " + row.id);
    return failures;
  }

  if (row.currency === "USD") {
    if (used <= 0) {
      failures.push("Rate_Used yo'q: " + row.id);
    } else if (Math.abs(stored - Math.round(amount * used)) > 1) {
      failures.push("Amount_UZS noto'g'ri (" + row.id + "): " +
                    stored + " != " + Math.round(amount * used));
    }
    // The applied rate must be one of the two recorded on the row.
    var buy = Number(row.rateBuy) || 0;
    var sell = Number(row.rateSell) || 0;
    if (used > 0 && used !== buy && used !== sell) {
      failures.push("Rate_Used saqlangan kurslarga mos emas: " + row.id);
    }
    if (row.rateType === "sell" && sell > 0 && used !== sell) {
      failures.push("Sotish kursi ishlatilmagan: " + row.id);
    }
  } else if (Math.abs(stored - Math.round(amount)) > 1) {
    failures.push("UZS Amount_UZS asl summaga teng emas (" + row.id + "): " +
                  stored + " != " + Math.round(amount));
  }

  return failures;
}

/**
 * Every migrated row against the row it came from, field by field.
 *
 * Totals alone cannot see a swapped tenant, a changed method or a tampered
 * frozen value that happens to keep a period sum intact, so each record is
 * compared directly and the frozen conversion is checked on its own terms.
 */
function verifyMigratedRows_(sourceResolved, ledgerRows) {
  var failures = [];
  var byId = {};
  for (var i = 0; i < ledgerRows.length; i++) byId[String(ledgerRows[i].id)] = ledgerRows[i];

  var matched = {};
  for (var j = 0; j < sourceResolved.length; j++) {
    var source = sourceResolved[j].row;
    var period = sourceResolved[j].period;
    var id = String(source.id);
    var target = byId[id];

    if (!target) {
      failures.push("Yozuv ko'chirilmagan: " + id);
      continue;
    }
    matched[id] = true;

    var normalized = normalizeTransaction_({
      id: source.id, tenant: source.tenant, month: period, type: source.type,
      amount: source.amount, currency: source.currency, method: source.method,
      date: source.date, comment: source.comment, msgId: source.msgId,
      requestId: source.requestId
    });

    var fields = [
      ["Tenant", normalized.tenant, String(target.tenant || "")],
      ["Type", normalized.type, String(target.type || "")],
      ["Amount", String(normalized.amount), String(Number(target.amount) || 0)],
      ["Currency", normalized.currency, String(target.currency || "")],
      ["Method", normalized.method, String(target.method || "")],
      ["Period", period, String(target.period || "")],
      ["Request_ID", String(normalized.requestId || ""), String(target.requestId || "")],
      ["Telegram_Msg_ID", String(normalized.msgId || ""), String(target.msgId || "")],
      ["Status", TX_STATUS_ACTIVE, String(target.status || "")],
      ["Related_ID", "", String(target.relatedId || "")]
    ];

    for (var k = 0; k < fields.length; k++) {
      if (fields[k][1] !== fields[k][2]) {
        failures.push(fields[k][0] + " mos emas (" + id + "): " +
                      fields[k][1] + " -> " + fields[k][2]);
      }
    }

    failures = failures.concat(frozenAmountFailures_(target));
  }

  for (var m = 0; m < ledgerRows.length; m++) {
    var extraId = String(ledgerRows[m].id);
    if (!matched[extraId]) failures.push("Manbada yo'q yozuv: " + extraId);
  }

  return failures;
}

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

  // Row by row, including each frozen value against its own recorded rate.
  // Aggregates alone cannot see a tampered Amount_UZS that leaves a period
  // sum looking correct.
  failures = failures.concat(verifyMigratedRows_(sourceResolved, readLedgerRows_(doc)));

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

/**
 * Keeps the spreadsheet from reinterpreting the ledger's text columns.
 *
 * Period holds "2026-08" and the two timestamps hold ISO strings. Without a
 * text format the sheet stores all three as dates - the same silent rewrite
 * that put a legacy entry in the wrong month.
 */
function applyLedgerColumnFormats_(sheet, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var periodRange = sheet.getRange(startRow, 7, numRows, 1);
  if (typeof periodRange.setNumberFormat !== "function") return;
  periodRange.setNumberFormat("@");
  sheet.getRange(startRow, 3, numRows, 2).setNumberFormat("@");
}

/** Appends one ledger row with its text columns protected first. */
function appendLedgerRow_(sheet, values) {
  var row = sheet.getLastRow() + 1;
  applyLedgerColumnFormats_(sheet, row, 1);
  sheet.getRange(row, 1, 1, LEDGER_HEADER.length).setValues([values]);
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
    // normalizeMonthValue_ recovers a period the sheet stored as a date
    // instead of stringifying it into "Sat Aug 01 2026 ...".
    period: normalizeMonthValue_(row[6]),
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

    appendLedgerRow_(ledgerSheet_(doc), transactionToLedgerRow_(transaction));
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
    appendLedgerRow_(sheet, transactionToLedgerRow_(replacement));

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

// ----- apps-script/15_system_status.gs -----------------------------------------

// ============================================================
// System and data status
// ------------------------------------------------------------
// Everything the "Tizim va Ma'lumotlar" settings section shows: backups,
// migration state, the retry queue, recent audit history, schema version and
// the last successful server operation.
//
// Diagnostics here are deliberately *safe*: counts, timestamps and event names
// only. No secrets, no transaction amounts, no message contents.
// ============================================================

var SYSTEM_LAST_OPERATION_KEY = "Omad_Last_Operation";
var AUDIT_TAIL_SIZE = 20;

/** Records that a server operation completed. Never throws. */
function recordLastOperation_(doc, operation) {
  try {
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
    setConfig(configSheet, SYSTEM_LAST_OPERATION_KEY, JSON.stringify({
      operation: String(operation || ""),
      at: new Date().toISOString()
    }));
  } catch (error) {}
}

function sheetRowCount_(doc, name) {
  var sheet = doc.getSheetByName(name);
  return sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
}

/** The most recent Omad_Backups row, without its snapshot payload. */
function latestBackupInfo_(doc) {
  var sheet = doc.getSheetByName("Omad_Backups");
  if (!sheet || sheet.getLastRow() < 2) return { count: 0, lastAt: "", lastReason: "" };

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(lastRow, 1, 1, 3).getValues()[0];
  var snapshot = safeParseJSON_(values[2], null);

  return {
    count: lastRow - 1,
    lastAt: String(values[0] || ""),
    lastReason: String(values[1] || ""),
    // Size only - the snapshot itself is never returned to the browser.
    lastTransactionCount: snapshot && Array.isArray(snapshot.transactions)
      ? snapshot.transactions.length : 0
  };
}

/** The tail of the audit log: timestamps and event names, details truncated. */
function recentAuditEntries_(doc, limit) {
  var sheet = doc.getSheetByName("Omad_Audit_Log");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var size = Math.min(limit || AUDIT_TAIL_SIZE, sheet.getLastRow() - 1);
  var start = sheet.getLastRow() - size + 1;
  var values = sheet.getRange(start, 1, size, 3).getValues();

  var entries = [];
  for (var i = values.length - 1; i >= 0; i--) {
    entries.push({
      at: String(values[i][0] || ""),
      event: String(values[i][1] || ""),
      details: redactSecrets_(values[i][2]).slice(0, 300)
    });
  }
  return entries;
}

function buildSystemStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var lastOperation = configSheet
    ? safeParseJSON_(getConfig(configSheet, SYSTEM_LAST_OPERATION_KEY), null)
    : null;

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    activeSheet: activeTransactionSheetName_(doc),
    ledgerActive: isLedgerActive_(doc),
    backup: latestBackupInfo_(doc),
    migration: getMigrationStatus_(doc),
    queue: buildJobQueueStatus_(doc),
    audit: recentAuditEntries_(doc, AUDIT_TAIL_SIZE),
    lastOperation: lastOperation,
    counts: {
      legacyTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_SHEET),
      ledgerTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_V2_SHEET),
      archive: sheetRowCount_(doc, "Omad_Transaction_Archive"),
      auditLog: sheetRowCount_(doc, "Omad_Audit_Log"),
      backups: sheetRowCount_(doc, "Omad_Backups"),
      jobs: sheetRowCount_(doc, JOB_QUEUE_SHEET)
    }
  };
}

/** Writes a snapshot on demand and reports the result. */
function createManualBackup_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "manual");
  appendAuditRow_(doc, "manual_backup_created", "");
  recordLastOperation_(doc, "create_backup");
  return { status: "success", backup: latestBackupInfo_(doc) };
}

/**
 * Puts failed jobs back in the queue for one more round of attempts.
 * Used by the "retry" control in System and Data.
 */
function retryFailedJobs_(doc) {
  var read = readJobRows_(doc);
  if (!read.sheet) return { status: "success", retried: 0 };

  var retried = 0;
  for (var i = 0; i < read.rows.length; i++) {
    if (read.rows[i].status !== JOB_STATUS_FAILED) continue;
    writeJobField_(read.sheet, read.rows[i].rowNumber, 5, JOB_STATUS_PENDING);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 6, 0);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 7, new Date().toISOString());
    writeJobField_(read.sheet, read.rows[i].rowNumber, 10, "");
    retried++;
  }

  if (retried > 0) {
    appendAuditRow_(doc, "failed_jobs_retried", String(retried));
    recordLastOperation_(doc, "retry_failed_jobs");
  }
  return { status: "success", retried: retried, queue: buildJobQueueStatus_(doc) };
}

// ----- apps-script/16_tasks_recurrence.gs --------------------------------------

// ============================================================
// Tasks — time & recurrence (pure)
// ------------------------------------------------------------
// Everything the task system needs to reason about calendar time, kept as pure
// functions so it behaves identically in Apps Script and under `node --test`.
//
// All task scheduling and display uses Asia/Tashkent. Uzbekistan abolished DST
// in 1992 and has been a fixed UTC+5 ever since, so a constant offset is exact
// and — unlike Utilities.formatDate / the host timezone — fully deterministic.
// Instants are epoch milliseconds (timezone independent); wall-clock is derived
// from them only where a human has to read it.
// ============================================================

var TASHKENT_UTC_OFFSET_MINUTES = 300; // UTC+5, year round.
var TASK_MS_PER_DAY = 86400000;

function taskPad2_(n) {
  var s = String(Math.abs(Number(n) || 0));
  return s.length >= 2 ? s : "0" + s;
}

/** epoch ms -> Tashkent wall-clock parts. */
function taskTzParts_(instant) {
  var ms = (instant instanceof Date ? instant.getTime() : Number(instant));
  if (!isFinite(ms)) ms = 0;
  var shifted = new Date(ms + TASHKENT_UTC_OFFSET_MINUTES * 60000);
  var year = shifted.getUTCFullYear();
  var month = shifted.getUTCMonth() + 1;
  var day = shifted.getUTCDate();
  var hour = shifted.getUTCHours();
  var minute = shifted.getUTCMinutes();
  return {
    year: year,
    month: month,
    day: day,
    hour: hour,
    minute: minute,
    weekday: shifted.getUTCDay(), // 0=Sunday .. 6=Saturday
    dateKey: year + "-" + taskPad2_(month) + "-" + taskPad2_(day),
    timeKey: taskPad2_(hour) + ":" + taskPad2_(minute)
  };
}

/** "now" in Tashkent as a YYYY-MM-DD date key. */
function taskTodayKey_(nowMs) {
  return taskTzParts_(nowMs === undefined ? Date.now() : nowMs).dateKey;
}

function isTaskDateKey_(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isTaskTimeKey_(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

/**
 * A YYYY-MM-DD key from whatever the sheet handed back.
 *
 * Exact text wins. A cell the spreadsheet already turned into a real date is
 * recovered from its local year/month/day - the same convention
 * parseTransactionDate_ uses for the accounting columns - so rows written
 * before these columns were text-formatted still read correctly instead of
 * silently becoming "". Anything else is not a date key and returns "".
 */
function taskDateKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return "";
    return value.getFullYear() + "-" + taskPad2_(value.getMonth() + 1) + "-" + taskPad2_(value.getDate());
  }
  var text = String(value).trim();
  if (isTaskDateKey_(text)) return text;
  // A full timestamp in a date column is an instant, not a calendar date;
  // read it in the same local frame a Date cell would have been read in.
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) {
      return instant.getFullYear() + "-" + taskPad2_(instant.getMonth() + 1) + "-" + taskPad2_(instant.getDate());
    }
  }
  return "";
}

/**
 * An HH:mm key from whatever the sheet handed back. Sheets stores a bare
 * "20:00" as 1899-12-30T20:00, so a time cell arrives as a Date whose clock
 * fields are the only part that means anything.
 */
function taskTimeKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getHours === "function") {
    if (isNaN(value.getTime())) return "";
    return taskPad2_(value.getHours()) + ":" + taskPad2_(value.getMinutes());
  }
  var text = String(value).trim();
  if (isTaskTimeKey_(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) return taskPad2_(instant.getHours()) + ":" + taskPad2_(instant.getMinutes());
  }
  var hm = /^(\d{1,2}):([0-5]\d)/.exec(text);
  if (hm && Number(hm[1]) <= 23) return taskPad2_(hm[1]) + ":" + hm[2];
  return "";
}

/** The epoch ms of a Tashkent wall-clock (dateKey + optional HH:mm). NaN if bad. */
function taskInstantMs_(dateKey, timeKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return NaN;
  var tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeKey || "00:00"));
  var hour = tm ? Number(tm[1]) : 0;
  var minute = tm ? Number(tm[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;
  return Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), hour, minute, 0)
    - TASHKENT_UTC_OFFSET_MINUTES * 60000;
}

/** Midnight UTC anchor for a date key, used only for whole-day arithmetic. */
function taskKeyAnchorMs_(dateKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return NaN;
  return Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
}

function taskKeyFromAnchorMs_(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + "-" + taskPad2_(d.getUTCMonth() + 1) + "-" + taskPad2_(d.getUTCDate());
}

/** Shift a date key by whole days, forwards or backwards, across month ends. */
function taskDateKeyAddDays_(dateKey, days) {
  var anchor = taskKeyAnchorMs_(dateKey);
  if (!isFinite(anchor)) return "";
  return taskKeyFromAnchorMs_(anchor + Number(days || 0) * TASK_MS_PER_DAY);
}

/** Whole days from a to b (b - a); negative when b precedes a. */
function taskDaysBetweenKeys_(a, b) {
  var left = taskKeyAnchorMs_(a);
  var right = taskKeyAnchorMs_(b);
  if (!isFinite(left) || !isFinite(right)) return NaN;
  return Math.round((right - left) / TASK_MS_PER_DAY);
}

/** 0=Sunday .. 6=Saturday for a date key. */
function taskWeekdayOfKey_(dateKey) {
  var anchor = taskKeyAnchorMs_(dateKey);
  if (!isFinite(anchor)) return -1;
  return new Date(anchor).getUTCDay();
}

/** The Monday that starts the ISO week containing this date key. */
function taskWeekStartKey_(dateKey) {
  var weekday = taskWeekdayOfKey_(dateKey);
  if (weekday < 0) return "";
  var back = (weekday + 6) % 7; // days since Monday
  return taskDateKeyAddDays_(dateKey, -back);
}

/** Days in a month, leap years included. */
function taskDaysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalises an admin-supplied recurrence into a canonical shape.
 *
 *   { freq: 'daily'|'weekly'|'monthly'|'custom',
 *     interval: >=1,            // every N days / weeks / months
 *     weekdays: [0..6],         // weekly: which days (0=Sun); [] means "start's weekday"
 *     monthDay: 1..31 | 'last', // monthly: which day of month
 *     intervalDays: >=1 }       // custom: every N days
 */
function normalizeTaskRecurrence_(recurrence) {
  var r = recurrence && typeof recurrence === "object" ? recurrence : {};
  var freq = ["daily", "weekly", "monthly", "custom"].indexOf(String(r.freq)) !== -1 ? String(r.freq) : "daily";
  var weekdays = [];
  if (Array.isArray(r.weekdays)) {
    var seen = {};
    for (var i = 0; i < r.weekdays.length; i++) {
      var wd = Number(r.weekdays[i]);
      if (wd >= 0 && wd <= 6 && !seen[wd]) { seen[wd] = true; weekdays.push(wd); }
    }
    weekdays.sort(function (a, b) { return a - b; });
  }
  var monthDay = r.monthDay === "last" ? "last" : Math.min(31, Math.max(1, Number(r.monthDay) || 1));
  return {
    freq: freq,
    interval: Math.max(1, Math.floor(Number(r.interval) || 1)),
    weekdays: weekdays,
    monthDay: monthDay,
    intervalDays: Math.max(1, Math.floor(Number(r.intervalDays) || Number(r.interval) || 1))
  };
}

/**
 * Whether a routine falls due on a given date, honouring start/end bounds.
 * `recurrence` must already be normalised.
 */
function routineOccursOnKey_(recurrence, startKey, endKey, dateKey) {
  if (!isTaskDateKey_(startKey) || !isTaskDateKey_(dateKey)) return false;
  if (dateKey < startKey) return false;
  if (endKey && isTaskDateKey_(endKey) && dateKey > endKey) return false;

  var r = recurrence || {};
  if (r.freq === "daily") {
    var dailyDiff = taskDaysBetweenKeys_(startKey, dateKey);
    return dailyDiff >= 0 && dailyDiff % r.interval === 0;
  }

  if (r.freq === "weekly") {
    var weekdays = (r.weekdays && r.weekdays.length) ? r.weekdays : [taskWeekdayOfKey_(startKey)];
    if (weekdays.indexOf(taskWeekdayOfKey_(dateKey)) === -1) return false;
    var weekDiff = Math.floor(
      taskDaysBetweenKeys_(taskWeekStartKey_(startKey), taskWeekStartKey_(dateKey)) / 7);
    return weekDiff >= 0 && weekDiff % r.interval === 0;
  }

  if (r.freq === "monthly") {
    var d = taskTzPartsFromKey_(dateKey);
    var s = taskTzPartsFromKey_(startKey);
    var monthDiff = (d.year - s.year) * 12 + (d.month - s.month);
    if (monthDiff < 0 || monthDiff % r.interval !== 0) return false;
    var lastDay = taskDaysInMonth_(d.year, d.month);
    var targetDay = r.monthDay === "last" ? lastDay : Math.min(Number(r.monthDay), lastDay);
    return d.day === targetDay;
  }

  if (r.freq === "custom") {
    var customDiff = taskDaysBetweenKeys_(startKey, dateKey);
    return customDiff >= 0 && customDiff % r.intervalDays === 0;
  }

  return false;
}

/** Cheap year/month/day for a date key, without a timezone shift. */
function taskTzPartsFromKey_(dateKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return { year: 0, month: 0, day: 0 };
  return { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
}

/** Every date a routine falls due within [fromKey, toKey], inclusive. */
function routineOccurrenceKeysInRange_(recurrence, startKey, endKey, fromKey, toKey) {
  var keys = [];
  if (!isTaskDateKey_(fromKey) || !isTaskDateKey_(toKey)) return keys;
  var cursor = fromKey < startKey ? startKey : fromKey;
  var guard = 0;
  while (cursor <= toKey && guard < 1000) {
    guard++;
    if (routineOccursOnKey_(recurrence, startKey, endKey, cursor)) keys.push(cursor);
    cursor = taskDateKeyAddDays_(cursor, 1);
  }
  return keys;
}

/** "2h 14m", "1d 3h 0m", "0m" — never negative. */
function formatTaskDuration_(ms) {
  var totalMinutes = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  var days = Math.floor(totalMinutes / 1440);
  var hours = Math.floor((totalMinutes % 1440) / 60);
  var minutes = totalMinutes % 60;
  var parts = [];
  if (days) parts.push(days + "d");
  if (days || hours) parts.push(hours + "h");
  parts.push(minutes + "m");
  return parts.join(" ");
}

/** Human Tashkent stamp "dd.MM.yyyy HH:mm" from an epoch ms. */
function formatTaskInstant_(instant) {
  var p = taskTzParts_(instant);
  return taskPad2_(p.day) + "." + taskPad2_(p.month) + "." + p.year + " " + p.timeKey;
}

/** Human Tashkent date "dd.MM.yyyy" from a date key. */
function formatTaskDateKey_(dateKey) {
  var p = taskTzPartsFromKey_(dateKey);
  if (!p.year) return String(dateKey || "");
  return taskPad2_(p.day) + "." + taskPad2_(p.month) + "." + p.year;
}

// ----- apps-script/17_tasks_store.gs -------------------------------------------

// ============================================================
// Tasks — storage, occurrences and views
// ------------------------------------------------------------
// Task data lives in its own sheets and never touches the financial ledger.
//
//   Tasks              one row per definition (one-time, routine or goal)
//   Task_Occurrences   one row per completable instance, with its own
//                      completion / proof / reminder history
//
// A routine never "completes"; the scheduler materialises a fresh occurrence
// per due date, so each day has its own row, status and history.
// ============================================================

var TASKS_SHEET = "Tasks";
var TASK_OCCURRENCES_SHEET = "Task_Occurrences";

var TASKS_HEADER = [
  "ID", "Type", "Title", "Description", "Responsible", "Priority", "Photo_Required",
  "Recurrence_JSON", "Reminder_Times_JSON", "Remind_Daily", "Due_Time",
  "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key", "Status", "Steps_JSON",
  "Created_At", "Updated_At", "Created_By", "Meta_JSON"
];

var TASK_OCC_HEADER = [
  "ID", "Task_ID", "Task_Type", "Title", "Date_Key", "Step_Index", "Due_At",
  "Responsible", "Priority", "Photo_Required", "Reminder_Times_JSON", "Remind_Daily",
  "Status", "Reminders_Sent_JSON", "Notified_At", "Telegram_Msg_ID",
  "Completed_By_Id", "Completed_By_Name", "Completed_At", "On_Time", "Late_Ms",
  "Proof_File_Id", "Proof_Msg_Id", "Proof_Awaiting_User_Id",
  "Created_At", "Updated_At", "Meta_JSON"
];

// Occurrence lifecycle states. "Overdue" is a *derived* view of an Open (or
// waiting) occurrence past its deadline, never a stored value, so a completion
// can always be judged on-time vs late against the same deadline.
var TASK_STATUS_OPEN = "Open";
var TASK_STATUS_WAITING = "WaitingProof";
var TASK_STATUS_COMPLETED = "Completed";
var TASK_STATUS_CANCELLED = "Cancelled";
var TASK_STATUS_SKIPPED = "Skipped";

// Task-definition states.
var TASK_DEF_ACTIVE = "active";
var TASK_DEF_PAUSED = "paused";
var TASK_DEF_COMPLETED = "completed";
var TASK_DEF_CANCELLED = "cancelled";

var TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
var TASK_TYPES = ["once", "routine", "goal"];

var TASK_GENERATION_HORIZON_DAYS = 14; // how far ahead routines are materialised
var TASK_STATS_WINDOW = 180;           // occurrences considered for streak / rate

function parseTaskBool_(value) {
  return value === true || value === "TRUE" || value === "true" || value === 1 || value === "1";
}

function taskBoolCell_(value) {
  return value ? "TRUE" : "FALSE";
}

function normalizeTaskPriority_(value) {
  var v = String(value || "").toLowerCase();
  return TASK_PRIORITIES.indexOf(v) !== -1 ? v : "normal";
}

function normalizeTaskTimes_(times) {
  var source = Array.isArray(times) ? times : [];
  var seen = {};
  var out = [];
  for (var i = 0; i < source.length; i++) {
    // Tolerant of a value the spreadsheet already rewrote, so a reminder list
    // that was stored oddly still parses instead of vanishing.
    var t = taskTimeKeyFromCell_(source[i]);
    if (isTaskTimeKey_(t) && !seen[t]) { seen[t] = true; out.push(t); }
  }
  out.sort();
  return out;
}

// ------------------------------------------------------------------ sheets

function tasksSheet_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET) || doc.insertSheet(TASKS_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASKS_HEADER);
  return sheet;
}

function taskOccurrencesSheet_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET) || doc.insertSheet(TASK_OCCURRENCES_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASK_OCC_HEADER);
  return sheet;
}

function taskColumnIndex_(header, name) {
  return header.indexOf(name) + 1; // 1-based sheet column
}

// Columns whose value must reach the sheet as exact text. Everything here is
// a date key, a clock time or an ISO stamp: values a spreadsheet will happily
// reinterpret as a date of its own choosing if the column is not text.
var TASKS_TEXT_COLUMNS = [
  "Due_Time", "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key",
  "Created_At", "Updated_At"
];

var TASK_OCC_TEXT_COLUMNS = [
  "Date_Key", "Notified_At", "Completed_At", "Created_At", "Updated_At"
];

/** Column numbers for `names`, merged into contiguous [start, count] spans. */
function taskTextColumnSpans_(header, names) {
  var cols = [];
  for (var i = 0; i < names.length; i++) {
    var index = header.indexOf(names[i]) + 1;
    if (index > 0) cols.push(index);
  }
  cols.sort(function (a, b) { return a - b; });
  var spans = [];
  for (var c = 0; c < cols.length; c++) {
    var last = spans[spans.length - 1];
    if (last && cols[c] === last[0] + last[1]) last[1]++;
    else spans.push([cols[c], 1]);
  }
  return spans;
}

/**
 * Stops the spreadsheet reinterpreting what is about to be written.
 *
 * Must run BEFORE the values land: a number format applied afterwards
 * reformats an already-coerced value, it does not recover it.
 */
function applyTaskTextFormats_(sheet, header, names, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var probe = sheet.getRange(startRow, 1, numRows, 1);
  if (typeof probe.setNumberFormat !== "function") return; // older host / test double
  var spans = taskTextColumnSpans_(header, names);
  for (var s = 0; s < spans.length; s++) {
    sheet.getRange(startRow, spans[s][0], numRows, spans[s][1]).setNumberFormat("@");
  }
}

// ------------------------------------------------------------ task records

function taskFromRow_(row) {
  var i = function (name) { return row[TASKS_HEADER.indexOf(name)]; };
  return {
    id: String(i("ID") || ""),
    type: String(i("Type") || "once"),
    title: String(i("Title") || ""),
    description: String(i("Description") || ""),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    recurrence: normalizeTaskRecurrence_(safeParseJSON_(i("Recurrence_JSON"), {})),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    dueTime: taskTimeKeyFromCell_(i("Due_Time")),
    deadlineKey: taskDateKeyFromCell_(i("Deadline_Key")),
    deadlineTime: taskTimeKeyFromCell_(i("Deadline_Time")),
    startKey: taskDateKeyFromCell_(i("Start_Key")),
    endKey: taskDateKeyFromCell_(i("End_Key")),
    status: String(i("Status") || TASK_DEF_ACTIVE),
    steps: normalizeGoalSteps_(safeParseJSON_(i("Steps_JSON"), [])),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    createdBy: String(i("Created_By") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function taskToRow_(task) {
  var map = {
    ID: task.id,
    Type: task.type,
    Title: task.title,
    Description: task.description || "",
    Responsible: task.responsible || "",
    Priority: task.priority || "normal",
    Photo_Required: taskBoolCell_(task.photoRequired),
    Recurrence_JSON: JSON.stringify(task.recurrence || {}),
    Reminder_Times_JSON: JSON.stringify(task.reminderTimes || []),
    Remind_Daily: taskBoolCell_(task.remindDaily),
    Due_Time: task.dueTime || "",
    Deadline_Key: task.deadlineKey || "",
    Deadline_Time: task.deadlineTime || "",
    Start_Key: task.startKey || "",
    End_Key: task.endKey || "",
    Status: task.status || TASK_DEF_ACTIVE,
    Steps_JSON: JSON.stringify(task.steps || []),
    Created_At: task.createdAt || "",
    Updated_At: task.updatedAt || "",
    Created_By: task.createdBy || "",
    Meta_JSON: JSON.stringify(task.meta || {})
  };
  return TASKS_HEADER.map(function (name) { return map[name]; });
}

function newGoalStepId_() {
  return "step_" + Utilities.getUuid().split("-").join("");
}

function normalizeGoalSteps_(steps) {
  var source = Array.isArray(steps) ? steps : [];
  var out = [];
  for (var i = 0; i < source.length; i++) {
    var step = typeof source[i] === "string" ? { title: source[i] } : (source[i] || {});
    var title = String(step.title || "").trim();
    if (!title) continue;
    var entry = { title: title };
    if (step.id) entry.id = String(step.id).slice(0, 64);
    // Absent means "inherit from the goal". Only an explicit value overrides,
    // which is why this key is not written unless one was supplied.
    if (step.photoRequired !== undefined && step.photoRequired !== null && step.photoRequired !== "") {
      entry.photoRequired = parseTaskBool_(step.photoRequired);
    }
    out.push(entry);
  }
  return out;
}

/** The photo rule that actually applies to a step. */
function effectiveStepPhotoRequired_(task, step) {
  if (step && step.photoRequired !== undefined) return !!step.photoRequired;
  return !!task.photoRequired;
}

/** "<goal title> — <step title>", the label a step-occurrence carries. */
function goalStepTitle_(task, step, index) {
  return task.title + " — " + ((step && step.title) || ("Qadam " + (index + 1)));
}

/**
 * Whether a goal's reminder times apply to its steps.
 *
 * A step has no due date, so there is no single moment to remind about. If the
 * admin set reminder times on the goal, the only reading that does what they
 * asked is "every day until the step is done".
 */
function goalRemindDaily_(task) {
  return !!(task.reminderTimes && task.reminderTimes.length);
}

function readTaskRows_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var task = taskFromRow_(data[i]);
    task.rowNumber = i + 1;
    rows.push(task);
  }
  return rows;
}

function findTask_(doc, taskId) {
  if (!taskId) return null;
  var rows = readTaskRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(taskId)) return rows[i];
  return null;
}

function appendTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, row, 1);
  sheet.appendRow(taskToRow_(task));
}

function updateTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  if (!task.rowNumber) return;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, task.rowNumber, 1);
  sheet.getRange(task.rowNumber, 1, 1, TASKS_HEADER.length).setValues([taskToRow_(task)]);
}

// ------------------------------------------------------ occurrence records

function occurrenceFromRow_(row) {
  var i = function (name) { return row[TASK_OCC_HEADER.indexOf(name)]; };
  var dueRaw = i("Due_At");
  return {
    id: String(i("ID") || ""),
    taskId: String(i("Task_ID") || ""),
    taskType: String(i("Task_Type") || ""),
    title: String(i("Title") || ""),
    dateKey: taskDateKeyFromCell_(i("Date_Key")),
    stepIndex: i("Step_Index") === "" || i("Step_Index") === null || i("Step_Index") === undefined
      ? "" : Number(i("Step_Index")),
    dueAt: dueRaw === "" || dueRaw === null || dueRaw === undefined ? "" : Number(dueRaw),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    status: String(i("Status") || TASK_STATUS_OPEN),
    remindersSent: safeParseJSON_(i("Reminders_Sent_JSON"), {}),
    notifiedAt: String(i("Notified_At") || ""),
    msgId: String(i("Telegram_Msg_ID") || ""),
    completedById: String(i("Completed_By_Id") || ""),
    completedByName: String(i("Completed_By_Name") || ""),
    completedAt: String(i("Completed_At") || ""),
    onTime: i("On_Time") === "" ? "" : parseTaskBool_(i("On_Time")),
    lateMs: i("Late_Ms") === "" || i("Late_Ms") === null || i("Late_Ms") === undefined ? "" : Number(i("Late_Ms")),
    proofFileId: String(i("Proof_File_Id") || ""),
    proofMsgId: String(i("Proof_Msg_Id") || ""),
    proofAwaitingUserId: String(i("Proof_Awaiting_User_Id") || ""),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function occurrenceToRow_(occ) {
  var map = {
    ID: occ.id,
    Task_ID: occ.taskId,
    Task_Type: occ.taskType,
    Title: occ.title,
    Date_Key: occ.dateKey || "",
    Step_Index: occ.stepIndex === "" || occ.stepIndex === undefined || occ.stepIndex === null ? "" : occ.stepIndex,
    Due_At: occ.dueAt === "" || occ.dueAt === undefined || occ.dueAt === null ? "" : occ.dueAt,
    Responsible: occ.responsible || "",
    Priority: occ.priority || "normal",
    Photo_Required: taskBoolCell_(occ.photoRequired),
    Reminder_Times_JSON: JSON.stringify(occ.reminderTimes || []),
    Remind_Daily: taskBoolCell_(occ.remindDaily),
    Status: occ.status || TASK_STATUS_OPEN,
    Reminders_Sent_JSON: JSON.stringify(occ.remindersSent || {}),
    Notified_At: occ.notifiedAt || "",
    Telegram_Msg_ID: occ.msgId || "",
    Completed_By_Id: occ.completedById || "",
    Completed_By_Name: occ.completedByName || "",
    Completed_At: occ.completedAt || "",
    On_Time: occ.onTime === "" || occ.onTime === undefined || occ.onTime === null ? "" : taskBoolCell_(occ.onTime),
    Late_Ms: occ.lateMs === "" || occ.lateMs === undefined || occ.lateMs === null ? "" : occ.lateMs,
    Proof_File_Id: occ.proofFileId || "",
    Proof_Msg_Id: occ.proofMsgId || "",
    Proof_Awaiting_User_Id: occ.proofAwaitingUserId || "",
    Created_At: occ.createdAt || "",
    Updated_At: occ.updatedAt || "",
    Meta_JSON: JSON.stringify(occ.meta || {})
  };
  return TASK_OCC_HEADER.map(function (name) { return map[name]; });
}

function readOccurrenceRows_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var occ = occurrenceFromRow_(data[i]);
    occ.rowNumber = i + 1;
    rows.push(occ);
  }
  return rows;
}

function findOccurrence_(doc, occurrenceId) {
  if (!occurrenceId) return null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(occurrenceId)) return rows[i];
  return null;
}

function occurrencesForTask_(rows, taskId) {
  var out = [];
  for (var i = 0; i < rows.length; i++) if (rows[i].taskId === String(taskId)) out.push(rows[i]);
  return out;
}

function appendOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, row, 1);
  sheet.appendRow(occurrenceToRow_(occ));
  occ.rowNumber = row;
}

/** Appends many occurrences in one write, protecting their text columns first. */
function appendOccurrenceRows_(doc, occurrences) {
  if (!occurrences || !occurrences.length) return [];
  var sheet = taskOccurrencesSheet_(doc);
  var startRow = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, startRow, occurrences.length);
  var values = [];
  for (var i = 0; i < occurrences.length; i++) values.push(occurrenceToRow_(occurrences[i]));
  sheet.getRange(startRow, 1, values.length, TASK_OCC_HEADER.length).setValues(values);
  for (var r = 0; r < occurrences.length; r++) occurrences[r].rowNumber = startRow + r;
  return occurrences;
}

/** Rewrites a single occurrence row from an in-memory object. */
function writeOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  if (!occ.rowNumber) return;
  occ.updatedAt = new Date().toISOString();
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, occ.rowNumber, 1);
  sheet.getRange(occ.rowNumber, 1, 1, TASK_OCC_HEADER.length).setValues([occurrenceToRow_(occ)]);
}

// ------------------------------------------------ occurrence materialisation

/**
 * Ensures the occurrence rows that should exist for a task exist, and returns
 * the ones this call created. Idempotent: an occurrence is keyed by
 * (taskId, dateKey) for routines/one-time and (taskId, stepIndex) for goals,
 * so re-running never duplicates and never disturbs completed history.
 *
 * `ctx` is an optional per-pass working set: the occurrence rows already read
 * from the sheet, plus the rows this pass wants to add. Passing one turns a
 * scan-per-task into a single scan and a single append for the whole pass.
 * Called without one it behaves exactly as before.
 */
function materializeTaskOccurrences_(doc, task, nowMs, ctx) {
  if (task.status === TASK_DEF_CANCELLED) return [];
  var todayKey = taskTodayKey_(nowMs);
  var existing = occurrencesForTask_(ctx ? ctx.occurrences : readOccurrenceRows_(doc), task.id);

  var byDate = {};
  var byStep = {};
  for (var e = 0; e < existing.length; e++) {
    if (existing[e].dateKey) byDate[existing[e].dateKey] = existing[e];
    // A removed step's row is history and must not block a new step from
    // taking its index.
    if (existing[e].stepIndex !== "" && !(existing[e].meta && existing[e].meta.removedStep)) {
      byStep[existing[e].stepIndex] = existing[e];
    }
  }

  var created = [];

  if (task.type === "once") {
    // A single occurrence. dateKey/dueAt are empty when the task has no deadline.
    if (existing.length === 0) {
      created.push(buildOccurrenceForOnce_(task));
    }
  } else if (task.type === "goal") {
    for (var s = 0; s < task.steps.length; s++) {
      if (byStep[s] === undefined) created.push(buildOccurrenceForGoalStep_(task, s));
    }
  } else if (task.type === "routine" && task.status === TASK_DEF_ACTIVE) {
    var genFrom = task.startKey && task.startKey > todayKey ? task.startKey : todayKey;
    var genTo = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);
    var dueKeys = routineOccurrenceKeysInRange_(task.recurrence, task.startKey || genFrom, task.endKey, genFrom, genTo);
    for (var k = 0; k < dueKeys.length; k++) {
      if (!byDate[dueKeys[k]]) created.push(buildOccurrenceForRoutine_(task, dueKeys[k]));
    }
  }

  if (ctx) {
    for (var c = 0; c < created.length; c++) { ctx.pending.push(created[c]); ctx.occurrences.push(created[c]); }
  } else {
    for (var a = 0; a < created.length; a++) appendOccurrenceRow_(doc, created[a]);
  }
  return created;
}

function newOccurrenceId_() {
  return "occ_" + Utilities.getUuid().split("-").join("");
}

function baseOccurrence_(task) {
  var nowIso = new Date().toISOString();
  return {
    id: newOccurrenceId_(),
    taskId: task.id,
    taskType: task.type,
    title: task.title,
    dateKey: "",
    stepIndex: "",
    dueAt: "",
    responsible: task.responsible || "",
    priority: task.priority || "normal",
    photoRequired: !!task.photoRequired,
    reminderTimes: task.reminderTimes || [],
    remindDaily: !!task.remindDaily,
    status: TASK_STATUS_OPEN,
    remindersSent: {},
    notifiedAt: "",
    msgId: "",
    completedById: "",
    completedByName: "",
    completedAt: "",
    onTime: "",
    lateMs: "",
    proofFileId: "",
    proofMsgId: "",
    proofAwaitingUserId: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    meta: {}
  };
}

function buildOccurrenceForOnce_(task) {
  var occ = baseOccurrence_(task);
  occ.dateKey = task.deadlineKey || "";
  occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
  return occ;
}

function buildOccurrenceForRoutine_(task, dateKey) {
  var occ = baseOccurrence_(task);
  occ.dateKey = dateKey;
  // A routine with a due time can be late; one without simply "belongs" to the day.
  occ.dueAt = task.dueTime ? taskInstantMs_(dateKey, task.dueTime) : "";
  return occ;
}

function buildOccurrenceForGoalStep_(task, stepIndex) {
  var occ = baseOccurrence_(task);
  var step = task.steps[stepIndex] || {};
  occ.stepIndex = stepIndex;
  occ.title = goalStepTitle_(task, step, stepIndex);
  occ.photoRequired = effectiveStepPhotoRequired_(task, step);
  occ.remindDaily = goalRemindDaily_(task);
  occ.dueAt = "";
  occ.meta = { stepId: step.id || "" };
  return occ;
}

// ---------------------------------------------------------------- views

/**
 * The derived, human-facing status of an occurrence at a moment in time.
 * "Overdue" only ever exists here — it is never written to the sheet.
 */
function occurrenceDisplayStatus_(occ, nowMs) {
  if (occ.status === TASK_STATUS_COMPLETED) return "Completed";
  if (occ.status === TASK_STATUS_CANCELLED) return "Cancelled";
  if (occ.status === TASK_STATUS_SKIPPED) return "Skipped";
  if (occ.status === TASK_STATUS_WAITING) return "WaitingProof";
  if (occ.dueAt !== "" && isFinite(occ.dueAt) && nowMs > occ.dueAt) return "Overdue";
  return "Open";
}

function decorateOccurrence_(occ, nowMs) {
  var display = occurrenceDisplayStatus_(occ, nowMs);
  var view = {
    id: occ.id,
    taskId: occ.taskId,
    taskType: occ.taskType,
    title: occ.title,
    dateKey: occ.dateKey,
    stepIndex: occ.stepIndex,
    responsible: occ.responsible,
    priority: occ.priority,
    photoRequired: occ.photoRequired,
    reminderTimes: occ.reminderTimes,
    status: occ.status,
    displayStatus: display,
    isOverdue: display === "Overdue",
    dueAt: occ.dueAt,
    dueLabel: occ.dueAt !== "" && isFinite(occ.dueAt) ? formatTaskInstant_(occ.dueAt)
      : (occ.dateKey ? formatTaskDateKey_(occ.dateKey) : ""),
    completedAt: occ.completedAt,
    completedByName: occ.completedByName,
    onTime: occ.onTime,
    lateMs: occ.lateMs,
    lateLabel: occ.lateMs !== "" && Number(occ.lateMs) > 0 ? formatTaskDuration_(occ.lateMs) : "",
    msgId: occ.msgId,
    hasProof: !!occ.proofFileId
  };
  return view;
}

/** Streak and completion rate for one routine, over its materialised history. */
function routineStats_(occurrences, nowMs) {
  var todayKey = taskTodayKey_(nowMs);
  var past = [];
  for (var i = 0; i < occurrences.length; i++) {
    var o = occurrences[i];
    if (!o.dateKey || o.dateKey > todayKey) continue;
    // Today is not a miss until it is actually late. An open day that still has
    // hours left on the clock is neither a success nor a failure, so it neither
    // extends the streak nor ends it.
    if (o.dateKey === todayKey &&
        (o.status === TASK_STATUS_OPEN || o.status === TASK_STATUS_WAITING) &&
        occurrenceDisplayStatus_(o, nowMs) !== "Overdue") continue;
    past.push(o);
  }
  past.sort(function (a, b) { return a.dateKey < b.dateKey ? 1 : (a.dateKey > b.dateKey ? -1 : 0); });

  var completed = 0;
  var counted = 0;
  var streak = 0;
  var streakBroken = false;
  for (var j = 0; j < past.length; j++) {
    var status = past[j].status;
    if (status === TASK_STATUS_SKIPPED) continue; // neutral: neither helps nor breaks
    if (status === TASK_STATUS_COMPLETED) {
      completed++; counted++;
      if (!streakBroken) streak++;
    } else {
      counted++;
      streakBroken = true; // an open/overdue past day ends the streak
    }
  }
  return {
    streak: streak,
    completed: completed,
    counted: counted,
    completionRate: counted > 0 ? Math.round((completed / counted) * 100) : null
  };
}

/** Goal progress: fraction of its step-occurrences that are completed. */
function goalProgress_(occurrences) {
  var total = 0;
  var done = 0;
  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    if (occ.stepIndex === "") continue;
    if (occ.meta && occ.meta.removedStep) continue;      // history, not current scope
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;
    total++;
    if (occ.status === TASK_STATUS_COMPLETED) done++;
  }
  return { done: done, total: total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * Everything the /tasks UI renders, computed for a moment in Tashkent time.
 * The Today view is split into what needs attention now, what is overdue,
 * what is coming up and what was completed today.
 */
function buildTaskViews_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);
  var tasks = readTaskRows_(doc);
  var occurrences = readOccurrenceRows_(doc);

  var taskById = {};
  for (var t = 0; t < tasks.length; t++) taskById[tasks[t].id] = tasks[t];

  var overdue = [];
  var dueToday = [];
  var waitingProof = [];
  var upcoming = [];
  var completedToday = [];

  var horizonKey = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);

  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    // Goal steps stay in the Maqsadlar tab, by progress. Bugun is reserved for
    // dated work, and a step has no date - this is the documented rule, not an
    // oversight. They are still announced to the group by the scheduler.
    if (occ.taskType === "goal") continue;
    var view = decorateOccurrence_(occ, now);

    if (occ.status === TASK_STATUS_COMPLETED) {
      var cp = occ.completedAt ? taskTzParts_(Date.parse(occ.completedAt)).dateKey : "";
      if (cp === todayKey) completedToday.push(view);
      continue;
    }
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;

    if (view.displayStatus === "Overdue") { overdue.push(view); continue; }
    if (occ.status === TASK_STATUS_WAITING) { waitingProof.push(view); continue; }

    // Open and not overdue.
    var key = occ.dateKey || todayKey;
    if (key <= todayKey) dueToday.push(view);
    else if (key <= horizonKey) upcoming.push(view);
    else upcoming.push(view);
  }

  var byPriorityThenDue = function (a, b) {
    var pr = TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority);
    if (pr !== 0) return pr;
    var ad = a.dueAt === "" ? Infinity : a.dueAt;
    var bd = b.dueAt === "" ? Infinity : b.dueAt;
    return ad - bd;
  };
  overdue.sort(function (a, b) { return (a.dueAt || 0) - (b.dueAt || 0); });
  dueToday.sort(byPriorityThenDue);
  upcoming.sort(function (a, b) {
    return String(a.dateKey || "").localeCompare(String(b.dateKey || "")) || byPriorityThenDue(a, b);
  });
  completedToday.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });

  var taskSummaries = tasks.map(function (task) {
    var taskOccs = occurrencesForTask_(occurrences, task.id);
    var summary = {
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      responsible: task.responsible,
      priority: task.priority,
      photoRequired: task.photoRequired,
      status: task.status,
      reminderTimes: task.reminderTimes,
      remindDaily: task.remindDaily,
      dueTime: task.dueTime,
      deadlineKey: task.deadlineKey,
      deadlineTime: task.deadlineTime,
      startKey: task.startKey,
      endKey: task.endKey,
      recurrence: task.recurrence,
      recurrenceLabel: describeRecurrence_(task),
      steps: task.steps,
      createdAt: task.createdAt
    };
    if (task.type === "routine") {
      summary.stats = routineStats_(taskOccs, now);
      var todayOcc = null;
      for (var o = 0; o < taskOccs.length; o++) if (taskOccs[o].dateKey === todayKey) todayOcc = taskOccs[o];
      summary.todayOccurrence = todayOcc ? decorateOccurrence_(todayOcc, now) : null;
    }
    if (task.type === "goal") {
      summary.progress = goalProgress_(taskOccs);
      summary.stepOccurrences = taskOccs
        .filter(function (o) { return o.stepIndex !== "" && !(o.meta && o.meta.removedStep); })
        .sort(function (a, b) { return Number(a.stepIndex) - Number(b.stepIndex); })
        .map(function (o) { return decorateOccurrence_(o, now); });
    }
    if (task.type === "once") {
      var once = taskOccs[0];
      if (once) summary.occurrence = decorateOccurrence_(once, now);
    }
    return summary;
  });

  // A recent-completed feed for the Completed tab: newest first, capped.
  var recentCompleted = [];
  for (var rc = 0; rc < occurrences.length; rc++) {
    if (occurrences[rc].status === TASK_STATUS_COMPLETED) recentCompleted.push(occurrences[rc]);
  }
  recentCompleted.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });
  recentCompleted = recentCompleted.slice(0, 50).map(function (o) { return decorateOccurrence_(o, now); });

  return {
    todayKey: todayKey,
    nowLabel: formatTaskInstant_(now),
    today: {
      overdue: overdue,
      needsAttention: dueToday,
      waitingProof: waitingProof,
      upcoming: upcoming,
      completedToday: completedToday
    },
    recentCompleted: recentCompleted,
    tasks: taskSummaries,
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      waitingProof: waitingProof.length,
      upcoming: upcoming.length,
      completedToday: completedToday.length
    }
  };
}

/** A short human description of a routine's cadence, in Uzbek. */
function describeRecurrence_(task) {
  if (task.type !== "routine") return "";
  var r = task.recurrence || {};
  var weekdayNames = ["Yak", "Du", "Se", "Chor", "Pay", "Jum", "Shan"];
  if (r.freq === "daily") return r.interval > 1 ? ("Har " + r.interval + " kunda") : "Har kuni";
  if (r.freq === "weekly") {
    var days = (r.weekdays && r.weekdays.length ? r.weekdays : [taskWeekdayOfKey_(task.startKey)])
      .map(function (d) { return weekdayNames[d] || d; }).join(", ");
    return (r.interval > 1 ? ("Har " + r.interval + " haftada: ") : "Har hafta: ") + days;
  }
  if (r.freq === "monthly") {
    var day = r.monthDay === "last" ? "oxirgi kuni" : (r.monthDay + "-kuni");
    return (r.interval > 1 ? ("Har " + r.interval + " oyda ") : "Har oy ") + day;
  }
  if (r.freq === "custom") return "Har " + r.intervalDays + " kunda";
  return "";
}

// ----- apps-script/18_tasks_service.gs -----------------------------------------

// ============================================================
// Tasks — Telegram namespace
// ------------------------------------------------------------
// Task messages and callbacks are handled in complete isolation from the
// private `/yangi` accounting flow:
//
//   * `/yangi` only ever runs in a PRIVATE chat with the single authorized
//     user; this handler only ever acts on the configured Tasks GROUP.
//   * Task callbacks use their own `t_done:` namespace, distinct from the
//     `bot_type:`/`bot_ten:`/`bot_curr:` accounting callbacks.
//   * A task callback never writes a financial record, and an accounting
//     update never reaches this handler.
//
// Completion is gated by the webhook secret (checked in doPost) and by the
// callback originating in the configured Tasks group. Anyone in that group may
// press the button; who pressed it is recorded.
// ============================================================

var TASK_CALLBACK_PREFIX = "t_";
var TASK_DONE_CALLBACK = "t_done:";
var TASK_DONE_BUTTON_TEXT = "✅ Ish bajarildi";

function taskDoneMarkup_(occurrenceId) {
  return { inline_keyboard: [[{ text: TASK_DONE_BUTTON_TEXT, callback_data: TASK_DONE_CALLBACK + occurrenceId }]] };
}

function taskClearedMarkup_() {
  return { inline_keyboard: [] };
}

function taskPriorityEmoji_(priority) {
  if (priority === "urgent") return "🔴";
  if (priority === "high") return "🟠";
  if (priority === "low") return "⚪️";
  return "🔵";
}

function taskDisplayName_(from) {
  if (!from) return "Noma'lum";
  var name = [from.first_name, from.last_name].filter(function (p) { return p; }).join(" ").trim();
  if (name) return name;
  if (from.username) return "@" + from.username;
  return String(from.id || "Noma'lum");
}

// --------------------------------------------------------- message building

function buildTaskCardBody_(occ) {
  var lines = [];
  lines.push("👤 Mas'ul: " + (occ.responsible || "—"));
  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    lines.push("📅 Muddat: " + formatTaskInstant_(occ.dueAt));
  } else if (occ.dateKey) {
    lines.push("📅 Sana: " + formatTaskDateKey_(occ.dateKey));
  } else {
    lines.push("📅 Muddat: belgilanmagan");
  }
  lines.push("📷 Rasm tasdiqi: " + (occ.photoRequired ? "Ha" : "Yo'q"));
  return lines.join("\n");
}

/** The message posted when a task/occurrence first appears in the group. */
function buildTaskOccurrenceMessage_(occ) {
  return [
    "🆕 " + taskPriorityEmoji_(occ.priority) + " Yangi vazifa",
    "",
    "📌 " + occ.title,
    buildTaskCardBody_(occ)
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

/** The message posted as a reminder for an open occurrence. */
function buildTaskReminderMessage_(occ) {
  return [
    "🔔 " + taskPriorityEmoji_(occ.priority) + " Eslatma",
    "",
    "📌 " + occ.title,
    buildTaskCardBody_(occ)
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

/** The message an occurrence's card is edited into once it reaches an end state. */
function buildTaskStatusMessage_(occ, nowMs) {
  var display = occurrenceDisplayStatus_(occ, nowMs === undefined ? Date.now() : nowMs);

  if (occ.status === TASK_STATUS_COMPLETED) {
    var lines = ["✅ Bajarildi", "", "📌 " + occ.title];
    lines.push("👤 Bajardi: " + (occ.completedByName || "—"));
    if (occ.completedAt) lines.push("🕒 " + formatTaskInstant_(Date.parse(occ.completedAt)));
    if (occ.onTime === false && occ.lateMs !== "" && Number(occ.lateMs) > 0) {
      lines.push("⚠️ " + formatTaskDuration_(occ.lateMs) + " kech bajarildi");
    } else if (occ.onTime === true) {
      lines.push("⏱ O'z vaqtida");
    }
    if (occ.proofFileId) lines.push("📷 Rasm bilan tasdiqlangan");
    return lines.join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
  }

  if (occ.status === TASK_STATUS_WAITING) {
    return ["⏳ Rasm kutilmoqda", "", "📌 " + occ.title,
      "👤 " + (occ.completedByName || "—") + " bajarildi deb belgiladi.",
      "📷 Tasdiqlash uchun rasm yuboring."].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
  }

  if (occ.status === TASK_STATUS_CANCELLED) {
    return ["🚫 Bekor qilindi", "", "📌 " + occ.title].join("\n");
  }
  if (occ.status === TASK_STATUS_SKIPPED) {
    return ["⏭ O'tkazib yuborildi", "", "📌 " + occ.title].join("\n");
  }
  return buildTaskOccurrenceMessage_(occ);
}

/**
 * The ForceReply prompt asking one named person for the proof photo.
 *
 * Titles are capped at 200 characters upstream, so nothing here is truncated -
 * slicing an HTML string could cut an entity in half.
 */
function buildTaskProofPromptMessage_(occ, options) {
  var name = escapeTelegramHtml_((options && options.userName) || occ.completedByName || "");
  var id = options && options.userId ? String(options.userId) : "";
  var mention = id ? '<a href="tg://user?id=' + id + '">' + name + '</a>' : name;
  return "📷 " + mention + ", \"" + escapeTelegramHtml_(occ.title) +
    "\" ni tasdiqlash uchun shu xabarga javob (reply) qilib rasm yuboring.";
}

// ------------------------------------------------------------- completion

/**
 * Marks an occurrence complete, recording who, when, whether it was on time,
 * and any photo proof. Remaining reminders stop automatically because the
 * scheduler and the reminder job both act only on still-open occurrences.
 *
 * Returns the updated occurrence object (already persisted).
 */
function completeTaskOccurrence_(doc, occ, options) {
  var opts = options || {};
  var nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;

  occ.status = TASK_STATUS_COMPLETED;
  occ.completedById = String(opts.byId || "");
  occ.completedByName = String(opts.byName || "");
  occ.completedAt = new Date(nowMs).toISOString();
  occ.proofAwaitingUserId = "";
  if (opts.proofFileId) occ.proofFileId = String(opts.proofFileId);
  if (opts.proofMsgId) occ.proofMsgId = String(opts.proofMsgId);
  occ.meta = occ.meta || {};
  occ.meta.source = opts.source || "telegram";
  // A stale prompt pointer must not be able to match a later photo.
  occ.meta.proofPromptMsgId = "";

  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    if (nowMs > occ.dueAt) { occ.onTime = false; occ.lateMs = nowMs - occ.dueAt; }
    else { occ.onTime = true; occ.lateMs = 0; }
  } else {
    occ.onTime = true; occ.lateMs = "";
  }

  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_occurrence_completed",
    occ.id + " by:" + (occ.completedByName || occ.completedById) + " onTime:" + occ.onTime);

  // Keep the group message current instead of posting a duplicate.
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });

  // Goals derive their progress from their step occurrences.
  if (occ.taskType === "goal") maybeCompleteGoal_(doc, occ.taskId, nowMs);

  return occ;
}

/** Completes the parent goal when every one of its steps is done. */
function maybeCompleteGoal_(doc, taskId, nowMs) {
  var task = findTask_(doc, taskId);
  if (!task || task.type !== "goal" || task.status === TASK_DEF_COMPLETED) return;
  var progress = goalProgress_(occurrencesForTask_(readOccurrenceRows_(doc), taskId));
  if (progress.total > 0 && progress.done >= progress.total) {
    task.status = TASK_DEF_COMPLETED;
    task.updatedAt = new Date(nowMs).toISOString();
    updateTaskRow_(doc, task);
    appendAuditRow_(doc, "task_goal_completed", taskId);
    var chatId = getTasksGroupChatId_();
    if (chatId) {
      try {
        sendTelegramMessage_(chatId, "🎯 Maqsad bajarildi: " + task.title + " (100%)");
      } catch (error) {
        debugLog_(doc, "task_goal_notify_failed", String(error));
      }
    }
  }
}

// --------------------------------------------------------- update routing

/**
 * True when a Telegram update belongs to the task namespace and must be
 * handled here instead of by the accounting `/yangi` flow. Deliberately
 * narrow: task callbacks, and photo/reply messages inside the Tasks group.
 */
function isTaskTelegramUpdate_(update) {
  if (!update) return false;
  if (update.callback_query) {
    return String(update.callback_query.data || "").indexOf(TASK_CALLBACK_PREFIX) === 0;
  }
  var message = update.message;
  if (!message) return false;
  var tasksGroup = getTasksGroupChatId_();
  if (!tasksGroup) return false;
  if (String(message.chat && message.chat.id) !== String(tasksGroup)) return false;
  return !!(message.photo || message.reply_to_message);
}

function handleTaskTelegramUpdate_(update, doc, configSheet) {
  try {
    if (update.callback_query) {
      handleTaskCallback_(update.callback_query, doc);
    } else if (update.message) {
      handleTaskGroupMessage_(update.message, doc);
    }
    // Best-effort: reflect the change on the group message promptly. Never
    // throws into the webhook response — Telegram must always get a 200.
    drainJobQueueQuietly_(doc, null);
  } catch (error) {
    debugLog_(doc, "task_update_error", String(error));
  }
  return okHtmlOutput_();
}

function handleTaskCallback_(callback, doc) {
  var data = String(callback.data || "");
  if (data.indexOf(TASK_DONE_CALLBACK) !== 0) {
    answerCallbackQuery_(callback.id);
    return;
  }

  var tasksGroup = getTasksGroupChatId_();
  var chatId = callback.message && callback.message.chat ? callback.message.chat.id : "";
  // Isolation gate: task completions only count inside the configured group.
  if (!tasksGroup || String(chatId) !== String(tasksGroup)) {
    answerCallbackQuery_(callback.id, "Bu tugma bu yerda ishlamaydi.");
    return;
  }

  var occurrenceId = data.slice(TASK_DONE_CALLBACK.length);
  var occ = findOccurrence_(doc, occurrenceId);
  if (!occ) { answerCallbackQuery_(callback.id, "Vazifa topilmadi."); return; }
  if (occ.status === TASK_STATUS_COMPLETED) { answerCallbackQuery_(callback.id, "Allaqachon bajarilgan."); return; }
  if (occ.status === TASK_STATUS_CANCELLED) { answerCallbackQuery_(callback.id, "Bu vazifa bekor qilingan."); return; }
  if (occ.status === TASK_STATUS_SKIPPED) { answerCallbackQuery_(callback.id, "Bu vazifa o'tkazib yuborilgan."); return; }

  var from = callback.from || {};

  if (occ.status === TASK_STATUS_WAITING) {
    // The proof is somebody's to deliver. A second presser must not be able to
    // take the task from them, or to overwrite who is recorded as doing it.
    if (String(occ.proofAwaitingUserId) === String(from.id)) {
      enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
        occurrenceId: occ.id, userId: String(from.id), userName: taskDisplayName_(from)
      });
      answerCallbackQuery_(callback.id, "📷 Rasm kutilmoqda — so'ralgan xabarga javob qiling.");
    } else {
      answerCallbackQuery_(callback.id,
        (occ.completedByName || "Boshqa foydalanuvchi") + " tasdiqlamoqda.");
    }
    return;
  }

  if (occ.photoRequired) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = String(from.id || "");
    occ.completedByName = taskDisplayName_(from);   // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: String(from.id || ""), userName: taskDisplayName_(from)
    });
    answerCallbackQuery_(callback.id, "📷 Iltimos, so'ralgan xabarga rasm bilan javob bering.");
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    return;
  }

  completeTaskOccurrence_(doc, occ, {
    byId: from.id, byName: taskDisplayName_(from), source: "telegram"
  });
  answerCallbackQuery_(callback.id, "✅ Bajarildi.");
}

/**
 * A photo in the Tasks group.
 *
 * Proof is only proof of the thing that was asked for: the photo has to be a
 * reply to that occurrence's prompt (or to its card), and it has to come from
 * the person who claimed it. Guessing "probably their most recent pending
 * task" is how an unrelated photo silently completed the wrong job.
 */
function handleTaskGroupMessage_(message, doc) {
  if (!message.photo || !message.photo.length) return;
  var from = message.from || {};
  var replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : "";

  var pendingForUser = 0;
  var target = null;
  var claimedByOther = null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status !== TASK_STATUS_WAITING) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) pendingForUser++;
    if (!replyTo) continue;
    var meta = occ.meta || {};
    var answersThis = String(meta.proofPromptMsgId || "") === replyTo || String(occ.msgId || "") === replyTo;
    if (!answersThis) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) target = occ;
    else claimedByOther = occ;
  }

  if (!target) {
    if (claimedByOther) {
      trySendTaskGroupMessage_(doc, "⚠️ Bu vazifani " +
        (claimedByOther.completedByName || "boshqa foydalanuvchi") + " tasdiqlamoqda.");
    } else if (pendingForUser > 0) {
      trySendTaskGroupMessage_(doc,
        "⚠️ Rasmni qabul qilish uchun so'ralgan xabarga javob (reply) qilib yuboring.");
    }
    return;   // an unrelated photo is just a photo
  }

  var largest = message.photo[message.photo.length - 1] || {};
  completeTaskOccurrence_(doc, target, {
    byId: from.id,
    byName: taskDisplayName_(from),
    source: "telegram",
    proofFileId: largest.file_id || "",
    proofMsgId: message.message_id
  });
  trySendTaskGroupMessage_(doc, "✅ Rasm qabul qilindi — \"" + target.title + "\" bajarildi.");
}

/** Group chatter is never worth failing a webhook over. */
function trySendTaskGroupMessage_(doc, text) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) return;
  try {
    sendTelegramMessage_(chatId, text);
  } catch (error) {
    debugLog_(doc, "task_group_notice_failed", String(error));
  }
}

// ----- apps-script/19_tasks_scheduler.gs ---------------------------------------

// ============================================================
// Tasks — scheduler, jobs and web API
// ------------------------------------------------------------
// Reuses the existing Omad_Job_Queue for every Telegram send, so a task
// message inherits the same claim-under-lock, exponential backoff and
// deduplication as the accounting reports. The scheduler only ever *decides*
// what is due and enqueues it; the queue does the sending.
//
// Duplicate protection is layered:
//   * a reminder slot is marked sent the moment it is enqueued (under the
//     script lock), so a second scheduler pass — or one that overlaps — cannot
//     enqueue it again, and a completed occurrence never re-fires;
//   * the queue itself refuses a second identical pending job.
// ============================================================

var TASK_REMINDER_MAX_LATE_MS = 3 * 60 * 60 * 1000; // don't blast reminders missed by >3h
var TASK_PROOF_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;  // a claim whose prompt never went out

function enqueueTaskJob_(doc, type, relatedId, payload) {
  return enqueueJob_(doc, type, relatedId, payload || {});
}

function isTaskJobType_(type) {
  return type === "task_notify" || type === "task_reminder" ||
    type === "task_update_message" || type === "task_proof_prompt";
}

function runTaskJob_(doc, job) {
  if (job.type === "task_notify") return runTaskNotifyJob_(doc, job);
  if (job.type === "task_reminder") return runTaskReminderJob_(doc, job);
  if (job.type === "task_update_message") return runTaskUpdateMessageJob_(doc, job);
  if (job.type === "task_proof_prompt") return runTaskProofPromptJob_(doc, job);
  throw new Error("Unknown task job type: " + job.type);
}

/**
 * Asks the user who claimed a photo-proof task to reply with the photo.
 *
 * ForceReply with `selective` plus a mention targets exactly that person, so
 * the reply the group is asked for is unambiguous and the photo that comes
 * back can be matched to this prompt and no other. Sending it as a job means a
 * Telegram outage retries with the queue's backoff instead of leaving the
 * occurrence waiting for a message that was never delivered.
 */
function runTaskProofPromptJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  if (occ.status !== TASK_STATUS_WAITING) return;                                  // already resolved
  if (String(occ.proofAwaitingUserId) !== String(job.payload.userId || "")) return; // superseded

  var sent = sendTelegramMessage_(
    chatId,
    buildTaskProofPromptMessage_(occ, job.payload),
    { force_reply: true, selective: true },
    "HTML",
    { replyToMessageId: occ.msgId }
  );
  var promptId = extractTelegramMessageId_(sent);
  if (promptId) {
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = String(promptId);
    writeOccurrenceRow_(doc, occ);
  }
}

/**
 * Puts an occurrence back the way it was when the prompt asking for its photo
 * could not be delivered. Waiting for a photo nobody was ever asked for is a
 * lie the group cannot act on.
 */
function releaseStuckProofPrompt_(doc, job) {
  var occ = findOccurrence_(doc, String((job.payload || {}).occurrenceId || ""));
  if (!occ || occ.status !== TASK_STATUS_WAITING) return;
  if (occ.meta && occ.meta.proofPromptMsgId) return;   // it did go out
  occ.status = TASK_STATUS_OPEN;
  occ.proofAwaitingUserId = "";
  occ.completedByName = "";
  occ.meta = occ.meta || {};
  occ.meta.proofPromptMsgId = "";
  occ.meta.proofRequestedAt = "";
  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_proof_prompt_released", occ.id);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
}

function runTaskNotifyJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return; // deleted before it went out

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var notifyTask = findTask_(doc, occ.taskId);
  if (notifyTask && (notifyTask.status === TASK_DEF_PAUSED || notifyTask.status === TASK_DEF_CANCELLED)) return;

  // If it already reached an end state before the card was sent, send the
  // status card (no button) rather than a stale "new task" with a live button.
  if (occ.status !== TASK_STATUS_OPEN) {
    var response = sendTelegramMessage_(chatId, buildTaskStatusMessage_(occ, Date.now()), taskClearedMarkup_());
    var doneId = extractTelegramMessageId_(response);
    if (doneId && !occ.msgId) { occ.msgId = String(doneId); writeOccurrenceRow_(doc, occ); }
    return;
  }

  var sent = sendTelegramMessage_(chatId, buildTaskOccurrenceMessage_(occ), taskDoneMarkup_(occ.id));
  var msgId = extractTelegramMessageId_(sent);
  if (msgId) { occ.msgId = String(msgId); writeOccurrenceRow_(doc, occ); }
}

function runTaskReminderJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  // Completion (or cancellation/skip) between enqueue and send stops the ping.
  if (occ.status !== TASK_STATUS_OPEN) return;

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var remindTask = findTask_(doc, occ.taskId);
  if (remindTask && (remindTask.status === TASK_DEF_PAUSED || remindTask.status === TASK_DEF_CANCELLED)) return;

  sendTelegramMessage_(chatId, buildTaskReminderMessage_(occ), taskDoneMarkup_(occ.id));
}

function runTaskUpdateMessageJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ || !occ.msgId) return;

  // The button is live only while the task is genuinely open. While a proof is
  // pending it belongs to one person, and pressing it again is not how they
  // deliver it.
  var showButton = occ.status === TASK_STATUS_OPEN;
  editTelegramMessage_(chatId, occ.msgId, buildTaskStatusMessage_(occ, Date.now()),
    showButton ? taskDoneMarkup_(occ.id) : taskClearedMarkup_());
}

// ---------------------------------------------------------------- scheduler

/**
 * Whether the scheduler may still speak for a task. A paused routine must not
 * announce or remind - not even for the occurrences that were already
 * materialised on to the sheet before it was paused - and an occurrence whose
 * definition has gone is not something to keep pinging a group about.
 */
function isTaskSendable_(taskStatus) {
  return taskStatus === TASK_DEF_ACTIVE;
}

/** True when any reminder slot has already been acted on for this occurrence. */
function hasAnyReminderSent_(occ) {
  var sent = occ.remindersSent || {};
  for (var key in sent) if (Object.prototype.hasOwnProperty.call(sent, key)) return true;
  return false;
}

/** Which reminder dates apply to an occurrence right now. */
function taskReminderDatesFor_(occ, todayKey) {
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  if (occ.remindDaily) return [todayKey];       // rolling daily for no-deadline tasks
  return [];
}

/**
 * The full scheduler pass: materialise due occurrences, announce new ones and
 * fire any reminders that have come due. Everything mutating runs under the
 * script lock so two passes cannot double-send.
 */
function runTaskScheduler_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (error) { return { notified: 0, reminders: 0, generated: 0 }; }

  var generated = 0;
  var notified = 0;
  var reminders = 0;
  try {
    var tasks = readTaskRows_(doc);
    var statusByTaskId = {};
    for (var t = 0; t < tasks.length; t++) statusByTaskId[tasks[t].id] = tasks[t].status;

    // One scan of the occurrence sheet for the whole pass, and one append for
    // everything it decides to create. A daily routine used to cost a full
    // scan per task, every five minutes, for ever.
    var ctx = { occurrences: readOccurrenceRows_(doc), pending: [] };
    for (var g = 0; g < tasks.length; g++) {
      if (tasks[g].status === TASK_DEF_ACTIVE) {
        generated += materializeTaskOccurrences_(doc, tasks[g], now, ctx).length;
      }
    }
    if (ctx.pending.length) appendOccurrenceRows_(doc, ctx.pending);

    // Includes what was just appended, with the row numbers assigned to those
    // very objects - so a writeOccurrenceRow_ later in this pass lands on the
    // right row.
    var occurrences = ctx.occurrences;
    for (var i = 0; i < occurrences.length; i++) {
      var occ = occurrences[i];

      // A paused (or cancelled, or orphaned) definition goes quiet immediately,
      // including for occurrences that were materialised before the pause.
      if (!isTaskSendable_(statusByTaskId[occ.taskId])) continue;

      // Backstop: a claim whose prompt never made it out, and whose job is gone
      // (queue row purged, script killed mid-flight). 30 minutes is comfortably
      // past the queue's own retry ladder, so this never races it.
      if (occ.status === TASK_STATUS_WAITING && !(occ.meta && occ.meta.proofPromptMsgId)) {
        var requestedAt = Date.parse((occ.meta && occ.meta.proofRequestedAt) || "") || 0;
        if (requestedAt && now - requestedAt > TASK_PROOF_PROMPT_TIMEOUT_MS) {
          releaseStuckProofPrompt_(doc, { payload: { occurrenceId: occ.id } });
          continue;
        }
      }

      // Announce.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN) {
        // A goal step and a deadline-less one-time task are the same thing to
        // the group: something to do now, with no date attached.
        var due = occ.taskType === "once" || occ.taskType === "goal" ||
          (occ.dateKey && occ.dateKey <= todayKey);
        if (due) {
          enqueueTaskJob_(doc, "task_notify", occ.id, { occurrenceId: occ.id });
          occ.notifiedAt = new Date(now).toISOString();
          writeOccurrenceRow_(doc, occ);
          notified++;
        }
      }

      // Remind.
      if (occ.status === TASK_STATUS_OPEN && occ.reminderTimes.length) {
        var dates = taskReminderDatesFor_(occ, todayKey);
        var changed = false;
        for (var d = 0; d < dates.length; d++) {
          for (var r = 0; r < occ.reminderTimes.length; r++) {
            var slotKey = dates[d] + " " + occ.reminderTimes[r];
            if (occ.remindersSent[slotKey]) continue;
            var instant = taskInstantMs_(dates[d], occ.reminderTimes[r]);
            if (!isFinite(instant) || now < instant) continue;
            if (now - instant <= TASK_REMINDER_MAX_LATE_MS) {
              enqueueTaskJob_(doc, "task_reminder", occ.id, { occurrenceId: occ.id, slot: slotKey });
              reminders++;
            } else {
              debugLog_(doc, "task_reminder_skipped_stale", occ.id + " " + slotKey);
            }
            occ.remindersSent[slotKey] = new Date(now).toISOString();
            changed = true;
          }
        }
        if (changed) writeOccurrenceRow_(doc, occ);
      }
    }
  } finally {
    lock.releaseLock();
  }

  return { notified: notified, reminders: reminders, generated: generated };
}

/** Time-driven trigger entry point (see docs). Scans, then drains the queue. */
function processTaskSchedules() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  runTaskScheduler_(doc, Date.now());
  return processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
}

// ---------------------------------------------------------------- web API

// The panel does one read per load and one per mutation, so this is generous
// for the admin and mean to anyone guessing keys.
var TASK_READ_RATE_LIMIT = 30;

function isTaskReadAction_(action) {
  return action === "get_tasks";
}

function isTaskMutationAction_(action) {
  return action === "save_task" || action === "cancel_task" ||
    action === "pause_routine" || action === "resume_routine" ||
    action === "skip_occurrence" || action === "complete_occurrence" ||
    action === "reopen_occurrence";
}

function isTaskAction_(action) {
  return isTaskReadAction_(action) || isTaskMutationAction_(action);
}

function handleTaskAction_(action, payload, doc) {
  if (isTaskReadAction_(action)) {
    // The task board is internal company information: who is responsible for
    // what, when it is due, and who has been missing deadlines. It is gated
    // like a mutation, and throttled before the key is compared so the
    // endpoint cannot be used to guess it.
    var throttled = enforceRateLimit_("tasks_read", TASK_READ_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (throttled) return jsonOutput_({ status: "error", message: throttled });
    var readError = checkAdminKey_(payload);
    if (readError) return jsonOutput_({ status: "error", message: readError });
    return jsonOutput_({
      status: "success",
      view: buildTaskViews_(doc, Date.now()),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  var adminError = checkAdminKey_(payload);
  if (adminError) return jsonOutput_({ status: "error", message: adminError });

  var result;
  if (action === "save_task") result = saveTaskAction_(doc, payload);
  else if (action === "cancel_task") result = cancelTaskAction_(doc, payload);
  else if (action === "pause_routine") result = setRoutinePausedAction_(doc, payload, true);
  else if (action === "resume_routine") result = setRoutinePausedAction_(doc, payload, false);
  else if (action === "skip_occurrence") result = skipOccurrenceAction_(doc, payload);
  else if (action === "complete_occurrence") result = completeOccurrenceAction_(doc, payload);
  else result = reopenOccurrenceAction_(doc, payload);

  if (result.status === "success") {
    recordLastOperation_(doc, action);
    // Announce/refresh promptly, then let the trigger handle the rest.
    try { runTaskScheduler_(doc, Date.now()); } catch (error) { debugLog_(doc, "task_scheduler_inline_failed", String(error)); }
    drainJobQueueQuietly_(doc, payload);
    result.view = buildTaskViews_(doc, Date.now());
    result.config = { tasksGroupConfigured: !!getTasksGroupChatId_() };
  }
  return jsonOutput_(result);
}

/** Builds a validated task object from a web payload. Returns {task} or {error}. */
function normalizeTaskInput_(payload, existing) {
  // The type decides which columns mean anything and what an occurrence even
  // is. There is no safe migration from one shape to another - a once-task's
  // single occurrence and a routine's dated history are not interchangeable -
  // so an existing task keeps the type it was created with.
  var type = existing ? existing.type : (TASK_TYPES.indexOf(String(payload.type)) !== -1 ? String(payload.type) : "");
  if (TASK_TYPES.indexOf(type) === -1) return { error: "Vazifa turi noto'g'ri." };

  var title = String(payload.title || (existing ? existing.title : "")).trim();
  if (!title) return { error: "Sarlavha kiritilmagan." };
  if (title.length > 200) return { error: "Sarlavha juda uzun." };

  var nowIso = new Date().toISOString();
  var task = {
    id: existing ? existing.id : ("task_" + Utilities.getUuid().split("-").join("")),
    type: type,
    title: title,
    description: String(payload.description || (existing ? existing.description : "")).slice(0, 2000),
    responsible: String(payload.responsible || (existing ? existing.responsible : "")).slice(0, 200),
    priority: normalizeTaskPriority_(payload.priority !== undefined ? payload.priority : (existing ? existing.priority : "normal")),
    photoRequired: payload.photoRequired !== undefined ? !!payload.photoRequired : (existing ? existing.photoRequired : false),
    reminderTimes: normalizeTaskTimes_(payload.reminderTimes !== undefined ? payload.reminderTimes : (existing ? existing.reminderTimes : [])),
    remindDaily: payload.remindDaily !== undefined ? !!payload.remindDaily : (existing ? existing.remindDaily : false),
    dueTime: "",
    deadlineKey: "",
    deadlineTime: "",
    startKey: "",
    endKey: "",
    status: existing ? existing.status : TASK_DEF_ACTIVE,
    steps: [],
    recurrence: {},
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso,
    createdBy: existing ? existing.createdBy : String(payload.createdBy || "admin"),
    meta: existing ? existing.meta : {}
  };

  if (type === "once") {
    if (payload.deadlineKey && !isTaskDateKey_(payload.deadlineKey)) return { error: "Muddat sanasi noto'g'ri." };
    if (payload.deadlineTime && !isTaskTimeKey_(payload.deadlineTime)) return { error: "Muddat vaqti noto'g'ri." };
    task.deadlineKey = isTaskDateKey_(payload.deadlineKey) ? String(payload.deadlineKey) : "";
    task.deadlineTime = isTaskTimeKey_(payload.deadlineTime) ? String(payload.deadlineTime) : "";
  } else if (type === "routine") {
    task.recurrence = normalizeTaskRecurrence_(payload.recurrence);
    task.startKey = isTaskDateKey_(payload.startKey) ? String(payload.startKey) : (existing && existing.startKey ? existing.startKey : taskTodayKey_(Date.now()));
    if (payload.endKey && !isTaskDateKey_(payload.endKey)) return { error: "Tugash sanasi noto'g'ri." };
    task.endKey = isTaskDateKey_(payload.endKey) ? String(payload.endKey) : "";
    if (task.endKey && task.endKey < task.startKey) return { error: "Tugash sanasi boshlanish sanasidan oldin." };
    task.dueTime = isTaskTimeKey_(payload.dueTime) ? String(payload.dueTime) : "";
  } else if (type === "goal") {
    task.steps = normalizeGoalSteps_(payload.steps);
    if (task.steps.length === 0) return { error: "Maqsad uchun kamida bitta qadam kiriting." };
  }

  return { task: task };
}

function saveTaskAction_(doc, payload) {
  var existing = payload.id ? findTask_(doc, payload.id) : null;
  if (payload.id && !existing) return { status: "error", message: "Vazifa topilmadi." };
  if (existing && payload.type && String(payload.type) !== existing.type) {
    return { status: "error", message: "Vazifa turini o'zgartirib bo'lmaydi. Yangi vazifa yarating." };
  }

  var normalized = normalizeTaskInput_(payload, existing);
  if (normalized.error) return { status: "error", message: normalized.error };
  var task = normalized.task;
  var nowMs = Date.now();
  var todayKey = taskTodayKey_(nowMs);
  var previousSteps = existing ? (existing.steps || []) : [];

  if (task.type === "goal") task.steps = mergeGoalSteps_(previousSteps, task.steps);

  if (existing) {
    task.rowNumber = existing.rowNumber;
    updateTaskRow_(doc, task);
    if (task.type === "routine") reconcileRoutineOccurrences_(doc, task, todayKey);
    else if (task.type === "once") reconcileOnceOccurrence_(doc, task);
    else reconcileGoalOccurrences_(doc, task, previousSteps);
    appendAuditRow_(doc, "task_updated", task.id + " " + task.type);
  } else {
    appendTaskRow_(doc, task);
    appendAuditRow_(doc, "task_created", task.id + " " + task.type);
  }

  materializeTaskOccurrences_(doc, task, nowMs);
  // Removing the last unfinished step is a completion just as much as ticking
  // it off is.
  if (task.type === "goal") maybeCompleteGoal_(doc, task.id, nowMs);
  return { status: "success", taskId: task.id };
}

/**
 * Pushes an edited one-time task on to the occurrence that is still live.
 *
 * The occurrence is what people actually see and complete; leaving it on the
 * old deadline, the old owner and the old photo rule is the difference between
 * an edit and a lie. History (completed / cancelled / skipped) is never
 * rewritten.
 */
function reconcileOnceOccurrence_(doc, task) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_COMPLETED || occ.status === TASK_STATUS_CANCELLED ||
        occ.status === TASK_STATUS_SKIPPED) continue;

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dateKey = task.deadlineKey || "";
    occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/**
 * Pairs the submitted step list with the steps that already exist, so an
 * occurrence keeps belonging to the same piece of work across an edit.
 *
 * Matching order matters:
 *   1. an id the client sent back - unambiguous;
 *   2. an unchanged title - survives inserting or deleting a step in the middle,
 *      which position alone cannot;
 *   3. the same position - which is what a plain rename looks like once the
 *      unchanged titles have been claimed;
 *   4. anything still unmatched is genuinely new and gets a fresh id.
 */
function mergeGoalSteps_(existingSteps, incomingSteps) {
  var existing = Array.isArray(existingSteps) ? existingSteps : [];
  var incoming = Array.isArray(incomingSteps) ? incomingSteps : [];
  var byId = {};
  var used = {};
  for (var e = 0; e < existing.length; e++) if (existing[e].id) byId[existing[e].id] = existing[e];

  var out = new Array(incoming.length);
  var pending = [];

  for (var i = 0; i < incoming.length; i++) {
    var id = incoming[i].id;
    if (id && byId[id] && !used[id]) { used[id] = true; out[i] = { id: id }; }
    else pending.push(i);
  }
  for (var t = 0; t < pending.length; t++) {
    var ti = pending[t];
    for (var x = 0; x < existing.length; x++) {
      if (!existing[x].id || used[existing[x].id]) continue;
      if (existing[x].title === incoming[ti].title) { used[existing[x].id] = true; out[ti] = { id: existing[x].id }; break; }
    }
  }
  for (var p = 0; p < pending.length; p++) {
    var pi = pending[p];
    if (out[pi]) continue;
    var atPosition = existing[pi];
    if (atPosition && atPosition.id && !used[atPosition.id]) { used[atPosition.id] = true; out[pi] = { id: atPosition.id }; }
  }
  for (var n = 0; n < out.length; n++) {
    if (!out[n]) out[n] = { id: newGoalStepId_() };
    out[n].title = incoming[n].title;
    if (incoming[n].photoRequired !== undefined) out[n].photoRequired = incoming[n].photoRequired;
  }
  return out;
}

/**
 * Re-points a goal's step-occurrences at the edited step list.
 *
 * Completed work is never deleted or re-scored: a step that disappears keeps
 * its row (and its proof, and who did it) and is simply taken out of the
 * goal's progress. An unfinished step that disappears is cancelled, so the
 * group card is withdrawn rather than left hanging.
 */
function reconcileGoalOccurrences_(doc, task, previousSteps) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  var idByOldIndex = {};
  for (var p = 0; p < previousSteps.length; p++) idByOldIndex[p] = previousSteps[p].id || "";
  var newIndexById = {};
  for (var n = 0; n < task.steps.length; n++) newIndexById[task.steps[n].id] = n;

  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.stepIndex === "") continue;
    occ.meta = occ.meta || {};
    var stepId = occ.meta.stepId || idByOldIndex[Number(occ.stepIndex)] || "";
    var newIndex = (stepId && newIndexById[stepId] !== undefined) ? newIndexById[stepId] : undefined;

    if (newIndex === undefined) {
      occ.meta.removedStep = true;
      if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
        occ.status = TASK_STATUS_CANCELLED;
        occ.proofAwaitingUserId = "";
      }
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    var step = task.steps[newIndex];
    occ.meta.stepId = step.id;
    delete occ.meta.removedStep;
    occ.stepIndex = newIndex;
    occ.title = goalStepTitle_(task, step, newIndex);
    if (occ.status !== TASK_STATUS_COMPLETED) {
      occ.responsible = task.responsible || "";
      occ.priority = task.priority || "normal";
      occ.photoRequired = effectiveStepPhotoRequired_(task, step);
      occ.reminderTimes = task.reminderTimes || [];
      occ.remindDaily = goalRemindDaily_(task);
    }
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId && occ.status === TASK_STATUS_OPEN) {
      enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
}

/**
 * Re-plans a routine after an edit.
 *
 * Anything from today forward that nobody has seen is replaced outright, so a
 * changed cadence, owner or due time takes effect. Anything already announced
 * is history in progress: its fields are refreshed in place, and it is only
 * withdrawn when the new schedule no longer contains its day.
 */
function reconcileRoutineOccurrences_(doc, task, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(task.id) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
      occ.dateKey && occ.dateKey >= todayKey;
  });

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (!occ.dateKey || occ.dateKey < todayKey) continue;   // the past is history
    if (occ.status !== TASK_STATUS_OPEN) continue;          // waiting/done/skipped stay put

    if (!routineOccursOnKey_(task.recurrence, task.startKey, task.endKey, occ.dateKey)) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dueAt = task.dueTime ? taskInstantMs_(occ.dateKey, task.dueTime) : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/** Removes upcoming routine occurrences that have neither been sent nor acted on. */
function pruneReplaceableRoutineOccurrences_(doc, taskId, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(taskId) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
      occ.dateKey && occ.dateKey > todayKey;
  });
}

function deleteOccurrenceRowsWhere_(doc, predicate) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var rows = readOccurrenceRows_(doc);
  var toDelete = [];
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) toDelete.push(rows[i].rowNumber);
  toDelete.sort(function (a, b) { return b - a; }); // bottom-up so row numbers stay valid
  for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
  return toDelete.length;
}

function cancelTaskAction_(doc, payload) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  task.status = TASK_DEF_CANCELLED;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
  appendAuditRow_(doc, "task_cancelled", task.id);
  return { status: "success" };
}

function setRoutinePausedAction_(doc, payload, paused) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  if (task.type !== "routine") return { status: "error", message: "Faqat takrorlanuvchi vazifani to'xtatish mumkin." };
  if (task.status === TASK_DEF_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  task.status = paused ? TASK_DEF_PAUSED : TASK_DEF_ACTIVE;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);

  if (paused) {
    // Pre-generated days nobody has seen are not history; leaving them on the
    // sheet would keep a paused routine visible in "Kelgusi" and would revive
    // it the moment the guard is bypassed. Announced days, completed days and
    // skipped days are history and stay exactly as they are.
    pruneReplaceableRoutineOccurrences_(doc, task.id, taskTodayKey_(Date.now()));
  }

  appendAuditRow_(doc, paused ? "routine_paused" : "routine_resumed", task.id);
  return { status: "success" };
}

/** An occurrence dated after today - work that has not come round yet. */
function isFutureOccurrence_(occ, todayKey) {
  return !!occ.dateKey && occ.dateKey > todayKey;
}

function skipOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "error", message: "Allaqachon bajarilgan." };
  // Skipping ahead is legitimate ("nobody is in on Friday"), it just has to be
  // deliberate rather than a misclick on a card in the Kelgusi list.
  var todayKey = taskTodayKey_(Date.now());
  if (isFutureOccurrence_(occ, todayKey) && payload.confirmFuture !== true) {
    return { status: "error", needsFutureConfirm: true, dateKey: occ.dateKey,
      message: "Kelgusi kunni (" + formatTaskDateKey_(occ.dateKey) + ") o'tkazib yuborishni tasdiqlang." };
  }
  occ.status = TASK_STATUS_SKIPPED;
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  appendAuditRow_(doc, "task_occurrence_skipped", occ.id);
  return { status: "success" };
}

function completeOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "success" }; // idempotent
  if (occ.status === TASK_STATUS_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  if (isFutureOccurrence_(occ, taskTodayKey_(Date.now()))) {
    return { status: "error",
      message: "Kelgusi kun uchun vazifani oldindan bajarilgan deb belgilab bo'lmaydi." };
  }
  completeTaskOccurrence_(doc, occ, {
    byId: "",
    byName: String(payload.completedBy || "Admin (panel)"),
    source: "web"
  });
  return { status: "success" };
}

function reopenOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  occ.status = TASK_STATUS_OPEN;
  occ.completedById = "";
  occ.completedByName = "";
  occ.completedAt = "";
  occ.onTime = "";
  occ.lateMs = "";
  occ.proofFileId = "";
  occ.proofMsgId = "";
  occ.proofAwaitingUserId = "";
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  if (occ.taskType === "goal") {
    var task = findTask_(doc, occ.taskId);
    if (task && task.status === TASK_DEF_COMPLETED) {
      task.status = TASK_DEF_ACTIVE;
      task.updatedAt = new Date().toISOString();
      updateTaskRow_(doc, task);
    }
  }
  appendAuditRow_(doc, "task_occurrence_reopened", occ.id);
  return { status: "success" };
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
      // Task callbacks and Tasks-group photo/reply messages are handled in
      // their own namespace, entirely separate from the private /yangi flow.
      // Everything else falls through to the accounting handler unchanged.
      if (isTaskTelegramUpdate_(payload)) {
        return handleTaskTelegramUpdate_(payload, doc, configSheet);
      }
      return handleOmadTelegramUpdate_(payload, doc, configSheet);
    }

    // ---- Task management --------------------------------------------------
    if (isTaskAction_(action)) {
      return handleTaskAction_(action, payload, doc);
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

    // ---- System & data ----------------------------------------------------
    if (action === 'get_system_status') {
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

  if (action === 'get_tasks') {
    // A GET puts its parameters in the URL, which is exactly where an admin key
    // must never be. Task reads are POST-only.
    return jsonOutput_({
      status: "error",
      message: "Vazifalar ma'lumoti faqat POST va admin kaliti bilan olinadi."
    });
  }

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
    baseId: String(transaction.id).split("_")[0],
    messageId: String(transaction.msgId || "")
  });
}

