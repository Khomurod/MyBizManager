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
    // The outgoing secret during a rotation is still a secret.
    TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS,
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
    webhookSecretConfigured: !!getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET),
    webhookSecretRotatedAt: getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_ROTATED_AT)
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
