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
