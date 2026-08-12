// ============================================================
// Mini App configuration and system health
// ------------------------------------------------------------
// Two operator tools that exist so nobody has to keep BotFather settings in
// their head, or guess which of twenty deployments is actually live.
//
// Everything here reports *status*, never values. A health check that printed
// a chat id or a URL fragment to prove it was configured would be a slower way
// of leaking the thing it is checking.
// ============================================================

var TELEGRAM_PROP_MINI_APP_URL = "TELEGRAM_MINI_APP_URL";
var TELEGRAM_PROP_MINI_APP_STATUS = "TELEGRAM_MINI_APP_STATUS";

var DEFAULT_MINI_APP_URL = "https://omad-d.netlify.app/mini";
var MINI_APP_MENU_BUTTON_TEXT = "📊 Omad";

var HEALTH_OK = "ok";
var HEALTH_WARN = "warning";
var HEALTH_ERROR = "error";

function check_(id, label, status, message) {
  return { id: id, label: label, status: status, message: message };
}

/** The web-app URL of the deployment currently serving this request. */
function currentWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------- Mini App configuration

/**
 * Points the bot's menu button at the Mini App, and verifies that it stuck.
 *
 * This is the whole of the BotFather setup, done through the Bot API: the
 * menu button is a bot-level setting that `setChatMenuButton` owns, so there
 * is nothing left that has to be typed into a chat with BotFather by hand.
 *
 * Verification is a separate call rather than trusting the write, because
 * `setChatMenuButton` answers `ok: true` for a URL Telegram will later refuse
 * to open.
 */
function configureMiniApp_(payload) {
  if (!getBotToken_()) {
    return { status: "error", message: "Bot token o'rnatilmagan." };
  }

  var url = String((payload && payload.miniAppUrl) || "").trim() ||
            getTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL) ||
            DEFAULT_MINI_APP_URL;
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    return { status: "error", message: "Mini App manzili https:// bilan boshlanishi kerak." };
  }

  var steps = [];
  try {
    var me = safeParseJSON_(telegramFetch_("getMe", {}).getContentText(), {});
    var bot = (me && me.result) || {};
    steps.push(check_("bot", "Bot ulanishi", HEALTH_OK, "@" + (bot.username || "")));

    telegramFetch_("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: MINI_APP_MENU_BUTTON_TEXT,
        web_app: { url: url }
      }
    });

    var current = safeParseJSON_(telegramFetch_("getChatMenuButton", {}).getContentText(), {});
    var button = (current && current.result) || {};
    var installed = button.type === "web_app" && button.web_app && button.web_app.url === url;
    steps.push(check_("menu", "Menyu tugmasi", installed ? HEALTH_OK : HEALTH_ERROR,
      installed ? "Mini App ulandi" : "Telegram tugmani tasdiqlamadi"));

    var authorized = getAuthorizedTelegramUserId_();
    steps.push(check_("user", "Ruxsat etilgan foydalanuvchi",
      authorized ? HEALTH_OK : HEALTH_ERROR,
      authorized ? "O'rnatilgan" : "TELEGRAM_AUTHORIZED_USER_ID o'rnatilmagan"));

    var webhook = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var info = (webhook && webhook.result) || {};
    steps.push(webhookHealthCheck_(info));

    var ready = installed && !!authorized && !!info.url;
    setTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL, url);
    setTelegramSetting_(TELEGRAM_PROP_MINI_APP_STATUS, JSON.stringify({
      configured: installed, ready: ready, checkedAt: new Date().toISOString()
    }));
    auditTelegramSettingsChange_(["miniAppUrl"]);

    return {
      status: "success",
      ready: ready,
      // The URL is not a secret - it is in the bot's menu for anyone to see.
      miniAppUrl: url,
      steps: steps,
      settings: buildTelegramSettingsView_()
    };
  } catch (error) {
    return {
      status: "error",
      message: redactSecrets_(error).slice(0, 300),
      steps: steps,
      settings: buildTelegramSettingsView_()
    };
  }
}

function webhookHealthCheck_(info) {
  if (!info || !info.url) {
    return check_("webhook", "Webhook", HEALTH_ERROR, "Ulanmagan");
  }
  var pending = Number(info.pending_update_count) || 0;
  if (info.last_error_message) {
    return check_("webhook", "Webhook", HEALTH_WARN,
      "Oxirgi xato: " + redactSecrets_(info.last_error_message).slice(0, 120));
  }
  if (pending > 50) {
    return check_("webhook", "Webhook", HEALTH_WARN, pending + " ta yangilanish navbatda");
  }
  return check_("webhook", "Webhook", HEALTH_OK, "Ishlayapti");
}

// ------------------------------------------------------------------- health

var HEALTH_REQUIRED_SHEETS = [
  "System_Config", "Omad_Transactions", "Omad_Backups",
  "Omad_Audit_Log", "Omad_Job_Queue"
];

var HEALTH_TRIGGER_FUNCTION = "processPendingTelegramJobs";

/**
 * One pass over everything that can quietly stop working.
 *
 * Green / warning / error with a sentence each. No secret, no chat id, no
 * amount, no URL fragment that would identify a deployment to someone who
 * should not have it.
 */
function buildHealthReport_(doc) {
  var checks = [];

  checks.push(check_("backend", "Backend", HEALTH_OK, "Javob bermoqda"));
  checks.push(deploymentCheck_());
  checks.push(botCheck_());
  checks.push(miniAppCheck_());
  checks.push(authorizedUserCheck_());
  checks.push(liveWebhookCheck_());
  checks.push(tasksGroupCheck_());
  checks.push(triggerCheck_());
  checks.push(queueCheck_(doc));
  checks.push(sheetsCheck_(doc));
  checks.push(ledgerCheck_(doc));
  checks.push(secretLoggingCheck_(doc));
  checks.push(dataCheck_(doc, "omad", "Omad ma'lumotlari", OMAD_TRANSACTIONS_SHEET));
  checks.push(dataCheck_(doc, "cafe", "Kafe ma'lumotlari", "Cafe_Sales"));
  checks.push(dataCheck_(doc, "tasks", "Vazifalar", TASKS_SHEET));

  var worst = HEALTH_OK;
  for (var i = 0; i < checks.length; i++) {
    if (checks[i].status === HEALTH_ERROR) worst = HEALTH_ERROR;
    else if (checks[i].status === HEALTH_WARN && worst !== HEALTH_ERROR) worst = HEALTH_WARN;
  }

  return { status: worst, checkedAt: new Date().toISOString(), checks: checks };
}

/**
 * Whether Telegram is talking to the deployment that is answering.
 *
 * This is the failure this project has actually had, repeatedly: a "New
 * deployment" mints a URL nothing calls, so the code looks deployed while the
 * app keeps running the old version. Comparing the two URLs catches it.
 */
function deploymentCheck_() {
  var live = currentWebAppUrl_();
  var configured = stripWebhookSecret_(getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || "");
  if (!live) return check_("deployment", "Deployment", HEALTH_WARN, "Manzilni aniqlab bo'lmadi");
  if (!configured) return check_("deployment", "Deployment", HEALTH_WARN, "Webhook manzili saqlanmagan");
  if (live === configured) return check_("deployment", "Deployment", HEALTH_OK, "Webhook shu versiyaga ulangan");
  return check_("deployment", "Deployment", HEALTH_ERROR,
    "Telegram boshqa deploymentga ulangan — Webhook tugmasini bosing");
}

function botCheck_() {
  if (!getBotToken_()) return check_("bot", "Telegram bot", HEALTH_ERROR, "Token o'rnatilmagan");
  try {
    var body = safeParseJSON_(telegramFetch_("getMe", {}).getContentText(), {});
    var bot = (body && body.result) || {};
    if (!bot.username) return check_("bot", "Telegram bot", HEALTH_ERROR, "Javob tushunarsiz");
    return check_("bot", "Telegram bot", HEALTH_OK, "@" + bot.username);
  } catch (error) {
    return check_("bot", "Telegram bot", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function miniAppCheck_() {
  if (!getBotToken_()) return check_("miniapp", "Mini App", HEALTH_ERROR, "Bot token yo'q");
  try {
    var body = safeParseJSON_(telegramFetch_("getChatMenuButton", {}).getContentText(), {});
    var button = (body && body.result) || {};
    if (button.type !== "web_app") {
      return check_("miniapp", "Mini App", HEALTH_WARN, "Sozlanmagan — 'Mini Appni sozlash' tugmasini bosing");
    }
    var expected = getTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL);
    if (expected && button.web_app && button.web_app.url !== expected) {
      return check_("miniapp", "Mini App", HEALTH_WARN, "Boshqa manzilga ulangan — qayta sozlang");
    }
    return check_("miniapp", "Mini App", HEALTH_OK, "Menyu tugmasi ulangan");
  } catch (error) {
    return check_("miniapp", "Mini App", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function authorizedUserCheck_() {
  var value = String(getAuthorizedTelegramUserId_() || "").trim();
  if (!value) return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_ERROR, "O'rnatilmagan");
  if (!/^\d{1,20}$/.test(value)) {
    return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_ERROR, "Raqamli ID bo'lishi kerak");
  }
  return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_OK, "O'rnatilgan");
}

function liveWebhookCheck_() {
  if (!getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET)) {
    return check_("webhook", "Webhook", HEALTH_WARN, "Tekshiruv kaliti yo'q — Webhook tugmasini bosing");
  }
  if (!getBotToken_()) return check_("webhook", "Webhook", HEALTH_ERROR, "Bot token yo'q");
  try {
    var body = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    return webhookHealthCheck_((body && body.result) || {});
  } catch (error) {
    return check_("webhook", "Webhook", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function tasksGroupCheck_() {
  var raw = String(getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID) || "").trim();
  if (!raw) return check_("tasksGroup", "Vazifalar guruhi", HEALTH_WARN, "Sozlanmagan — kartalar yuborilmaydi");
  if (!getTasksGroupChatId_()) {
    return check_("tasksGroup", "Vazifalar guruhi", HEALTH_ERROR, "Raqamli ID emas — @username qabul qilinmaydi");
  }
  return check_("tasksGroup", "Vazifalar guruhi", HEALTH_OK, "Sozlangan");
}

/**
 * The single time-driven trigger that carries both the task scheduler and the
 * report queue. Without it reminders never fire and reports never leave.
 */
function triggerCheck_() {
  var triggers;
  try {
    triggers = ScriptApp.getProjectTriggers() || [];
  } catch (error) {
    return check_("trigger", "Trigger", HEALTH_WARN, "Ro'yxatni o'qib bo'lmadi");
  }
  for (var i = 0; i < triggers.length; i++) {
    var handler = "";
    try { handler = triggers[i].getHandlerFunction(); } catch (error) { handler = ""; }
    if (handler === HEALTH_TRIGGER_FUNCTION) {
      return check_("trigger", "Trigger", HEALTH_OK, HEALTH_TRIGGER_FUNCTION + " o'rnatilgan");
    }
  }
  return check_("trigger", "Trigger", HEALTH_ERROR,
    HEALTH_TRIGGER_FUNCTION + " triggeri yo'q — eslatma va hisobotlar yuborilmaydi");
}

function queueCheck_(doc) {
  var queue = buildJobQueueStatus_(doc);
  var counts = queue.counts || {};
  if (counts.failed > 0) {
    return check_("queue", "Hisobot navbati", HEALTH_ERROR, counts.failed + " ta vazifa muvaffaqiyatsiz");
  }
  if (counts.pending > 20) {
    return check_("queue", "Hisobot navbati", HEALTH_WARN, counts.pending + " ta vazifa kutmoqda");
  }
  return check_("queue", "Hisobot navbati", HEALTH_OK,
    (counts.pending || 0) + " kutmoqda, " + (counts.completed || 0) + " bajarilgan");
}

function sheetsCheck_(doc) {
  var missing = [];
  for (var i = 0; i < HEALTH_REQUIRED_SHEETS.length; i++) {
    if (!doc.getSheetByName(HEALTH_REQUIRED_SHEETS[i])) missing.push(HEALTH_REQUIRED_SHEETS[i]);
  }
  if (missing.length === 0) return check_("sheets", "Varaqlar", HEALTH_OK, "Hammasi mavjud");
  // Every one of these is created on first use, so a missing sheet is normal
  // on a fresh spreadsheet and only worth flagging, not failing.
  return check_("sheets", "Varaqlar", HEALTH_WARN, "Yo'q: " + missing.join(", "));
}

function ledgerCheck_(doc) {
  var active = activeTransactionSheetName_(doc);
  if (active === OMAD_TRANSACTIONS_V2_SHEET) {
    return check_("ledger", "Tranzaksiya varag'i", HEALTH_OK, "V2 (yangi tizim) yoqilgan");
  }
  return check_("ledger", "Tranzaksiya varag'i", HEALTH_OK, active + " — V2 o'chirilgan");
}

/**
 * Whether anything in the recent debug log still looks like a credential.
 *
 * Request bodies stopped being logged, so this should stay clean; if it does
 * not, something new started writing one and the cleanup action is one press
 * away.
 */
function secretLoggingCheck_(doc) {
  var sheet = doc.getSheetByName(DEBUG_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return check_("secrets", "Log himoyasi", HEALTH_OK, "Log bo'sh");
  }
  var size = Math.min(200, sheet.getLastRow() - 1);
  var values = sheet.getRange(sheet.getLastRow() - size + 1, 3, size, 1).getValues();
  var suspicious = 0;
  for (var i = 0; i < values.length; i++) {
    var text = String(values[i][0] || "");
    if (/\b[0-9a-fA-F]{32,}\b/.test(text) || TELEGRAM_TOKEN_LIKE_PATTERN.test(text)) suspicious++;
    TELEGRAM_TOKEN_LIKE_PATTERN.lastIndex = 0;
  }
  if (suspicious > 0) {
    return check_("secrets", "Log himoyasi", HEALTH_WARN,
      suspicious + " ta qatorda maxfiyga o'xshash qiymat — 'Loglarni Tozalash'ni bosing");
  }
  return check_("secrets", "Log himoyasi", HEALTH_OK, "Oxirgi " + size + " qator toza");
}

function dataCheck_(doc, id, label, sheetName) {
  var sheet = doc.getSheetByName(sheetName);
  if (!sheet) return check_(id, label, HEALTH_WARN, "Varaq hali yaratilmagan");
  var rows = Math.max(0, sheet.getLastRow() - 1);
  return check_(id, label, HEALTH_OK, rows + " ta yozuv");
}
