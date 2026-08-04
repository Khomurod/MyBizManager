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

function getCurrentUzbekMonth_() {
  var months = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];
  return months[new Date().getMonth()];
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

// ----- apps-script/05_exchange_rates.gs ----------------------------------------

// ============================================================
// Exchange rates
// ------------------------------------------------------------
// USD -> UZS conversion and the balances derived from it.
// ============================================================

function getOmadRates_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return {};
  return safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {});
}

function normalizeRateEntry_(rawRate) {
  var defaultRate = 12500;
  if (typeof rawRate === "number") return { buy: rawRate || defaultRate, sell: rawRate || defaultRate };
  if (rawRate && typeof rawRate === "object") {
    var buy = Number(rawRate.buy || rawRate.sell || rawRate.rate) || defaultRate;
    var sell = Number(rawRate.sell || rawRate.buy || rawRate.rate) || defaultRate;
    return { buy: buy, sell: sell };
  }
  return { buy: defaultRate, sell: defaultRate };
}

function getMonthRateByType_(rates, month, rateType) {
  var normalized = normalizeRateEntry_(rates && rates[month]);
  return rateType === "buy" ? normalized.buy : normalized.sell;
}

function toUZS_(amount, currency, month, rates, rateType) {
  var numericAmount = Number(amount) || 0;
  return currency === "USD" ? numericAmount * getMonthRateByType_(rates, month, rateType || "sell") : numericAmount;
}

function calculateBalancesFromTransactions_(transactions, targetMonth) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;

  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    var valueUZS = toUZS_(t.amount, t.currency, t.month, rates, "sell");
    var sign = t.type === "Income" ? 1 : -1;
    allTimeBalance += valueUZS * sign;
    if (t.month === targetMonth) monthBalance += valueUZS * sign;
  }

  return { monthBalance: monthBalance, allTimeBalance: allTimeBalance };
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
      month: String(item.month || getCurrentUzbekMonth_()).trim(),
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
// ============================================================

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
  return {
    id: String(t.id || (Date.now() + "_0")),
    tenant: String(t.tenant || "").trim(),
    month: String(t.month || getCurrentUzbekMonth_()).trim(),
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

function readOmadTransactions_(doc) {
  var txSheet = doc.getSheetByName("Omad_Transactions");
  var transactions = [];
  if (txSheet && txSheet.getLastRow() > 1) {
    var data = txSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      transactions.push({
        id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
        amount: data[i][4], currency: data[i][5], method: data[i][6],
        date: data[i][7], comment: data[i][8], msgId: data[i][9],
        // Legacy 10-column rows simply have no request id.
        requestId: data[i].length > 10 ? data[i][10] : ""
      });
    }
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
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
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
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
  ensureOmadTransactionHeader_(txSheet);
  txSheet.appendRow(transactionToRow_(normalizeTransaction_(transaction)));
}

function updateOmadTransactionMsgId_(doc, transactionId, msgId) {
  if (!msgId) return;
  var txSheet = doc.getSheetByName("Omad_Transactions");
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(transactionId)) {
      txSheet.getRange(i + 1, 10).setValue(msgId);
      return;
    }
  }
}

function safeSaveOmad_(doc, configSheet, payload) {
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
          month: getCurrentUzbekMonth_(),
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
    "*Oy:* " + escapeMarkdown_(transaction.month),
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
  var periodText = String(first.month || "").trim() || "Noma'lum";

  var transferLines = [];
  var total = 0;
  for (var i = 0; i < group.length; i++) {
    var valueUZS = toUZS_(group[i].amount, group[i].currency, periodText, rates, "sell");
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

