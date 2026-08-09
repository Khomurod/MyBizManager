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
