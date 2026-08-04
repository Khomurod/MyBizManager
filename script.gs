function doPost(e) {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var isTelegramWebhook = false;

  try {
    var payload = JSON.parse((e.postData && e.postData.contents) || "{}");
    var action = payload.action;
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

    if (!action && (payload.message || payload.callback_query)) {
      isTelegramWebhook = true;
      return handleOmadTelegramUpdate_(payload, doc, configSheet);
    }

    // ==========================================
    // 1. OMAD-D (REAL ESTATE) HANDLERS
    // ==========================================
    if (action === 'migrate_omad' || action === 'save_omad') {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        backupOmadState_(doc, configSheet, action);
        safeSaveOmad_(doc, configSheet, payload);
      } finally {
        lock.releaseLock();
      }

      return jsonOutput_({ status: "success" });
    }

    // ==========================================
    // 1b. TELEGRAM SETTINGS & SERVER-SIDE PROXY
    // ==========================================
    if (action === 'get_telegram_settings') {
      return jsonOutput_({ status: "success", settings: buildTelegramSettingsView_() });
    }

    if (action === 'save_telegram_settings' ||
        action === 'test_telegram_connection' ||
        action === 'send_telegram_test_message' ||
        action === 'configure_telegram_webhook') {
      var adminError = checkAdminKey_(payload);
      if (adminError) return jsonOutput_({ status: "error", message: adminError });

      if (action === 'save_telegram_settings') return jsonOutput_(saveTelegramSettings_(payload));
      if (action === 'test_telegram_connection') return jsonOutput_(testTelegramConnection_());
      if (action === 'send_telegram_test_message') return jsonOutput_(sendTelegramTestMessage_());
      return jsonOutput_(configureTelegramWebhook_(payload));
    }

    if (action === 'telegram_send' || action === 'telegram_edit' || action === 'telegram_delete') {
      return jsonOutput_(proxyTelegramGroupCall_(action, payload));
    }

    // ==========================================
    // 2. CAFE ADMIN (INVENTORY, RECIPES, CATEGORIES, SETTINGS)
    // ==========================================
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

    // ==========================================
    // 3. CAFE POS (SALES, VOID & CLOSE DAY)
    // ==========================================
    if (action === 'save_sale') {
      var salesSheet = doc.getSheetByName("Cafe_Sales") || doc.insertSheet("Cafe_Sales");
      if (salesSheet.getLastRow() === 0) {
         salesSheet.appendRow(["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Chek_Tafsilotlari", "ID"]);
      }
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

    if (action === 'void_sale') {
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

    if (action === 'close_day') {
      setConfig(configSheet, "Cafe_Inventory", JSON.stringify(payload.inventory));
      var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni") || doc.insertSheet("Cafe_Kun_Yakuni");
      if (closeSheet.getLastRow() === 0) {
         closeSheet.appendRow(["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Tafsilotlar_JSON"]);
      }
      closeSheet.appendRow([
        payload.date,
        payload.seller,
        payload.totalRevenue,
        payload.totalProfit,
        JSON.stringify(payload.summary)
      ]);
      return jsonOutput_({ status: "success" });
    }

    return jsonOutput_({ status: "error", message: "Unknown action" });
  } catch (error) {
    if (isTelegramWebhook) {
      try {
        debugLog_(doc, "telegram_webhook_error", error.toString());
      } catch (logError) {}
      return okHtmlOutput_();
    }
    return jsonOutput_({ status: "error", message: error.toString() });
  }
}

// ==========================================
// 4. DATA FETCHING (GET REQUESTS)
// ==========================================
function doGet(e) {
  var action = e.parameter.action;
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");

  if (!configSheet) return jsonOutput_({ status: "empty" });

  if (action === 'get_omad') {
    var transactions = readOmadTransactions_(doc);
    var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
    var rates = safeParseJSON_(getConfig(configSheet, "Omad_Rates"), { "Fevral": 12500 });
    var templateExpenses = normalizeTemplateExpenses_(safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), []));
    return jsonOutput_({ transactions: transactions, tenants: tenants, rates: rates, templateExpenses: templateExpenses });
  }

  if (action === 'get_cafe') {
    var inventory = safeParseJSON_(getConfig(configSheet, "Cafe_Inventory"), []);
    var recipes = safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), []);
    var categories = safeParseJSON_(getConfig(configSheet, "Cafe_Categories"), ["Ichimliklar", "Fast-Food", "Muzqaymoq"]);
    var settings = safeParseJSON_(getConfig(configSheet, "Cafe_Settings"), { dailyTarget: 0 });

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

    return jsonOutput_({
      inventory: inventory, recipes: recipes, categories: categories, sales: sales, closeReports: closeReports, settings: settings
    });
  }
  return ContentService.createTextOutput("System Database is Active.");
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

function readOmadTransactions_(doc) {
  var txSheet = doc.getSheetByName("Omad_Transactions");
  var transactions = [];
  if (txSheet && txSheet.getLastRow() > 1) {
    var data = txSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      transactions.push({
        id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
        amount: data[i][4], currency: data[i][5], method: data[i][6],
        date: data[i][7], comment: data[i][8], msgId: data[i][9]
      });
    }
  }
  return transactions;
}

function safeRewriteOmadTransactions_(doc, incomingTransactions) {
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
  ensureOmadTransactionHeader_(txSheet);

  var lastRow = txSheet.getLastRow();
  if (lastRow > 1) {
    txSheet.getRange(2, 1, lastRow - 1, 10).clearContent();
  }

  var rows = [];
  for (var i = 0; i < incomingTransactions.length; i++) {
    rows.push(transactionToRow_(incomingTransactions[i]));
  }
  if (rows.length > 0) {
    txSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
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

function appendOmadTransaction_(doc, transaction) {
  var txSheet = doc.getSheetByName("Omad_Transactions") || doc.insertSheet("Omad_Transactions");
  ensureOmadTransactionHeader_(txSheet);
  txSheet.appendRow(transactionToRow_(normalizeTransaction_(transaction)));
}

function ensureOmadTransactionHeader_(sheet) {
  var header = ["ID", "Tenant", "Month", "Type", "Amount", "Currency", "Method", "Date", "Comment", "Telegram_Msg_ID"];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    return;
  }
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  if (firstRow[0] !== "ID") sheet.getRange(1, 1, 1, header.length).setValues([header]);
}

function transactionToRow_(t) {
  return [t.id, t.tenant, t.month, t.type, t.amount, t.currency, t.method, t.date, t.comment || "", t.msgId || ""];
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
    msgId: t.msgId || ""
  };
}

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
    state = { type: data.replace("bot_type:", "") === "Expense" ? "Expense" : "Income" };
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

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var transaction;
    var groupMessage;
    var groupMsgId = "";
    try {
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
        msgId: ""
      });
      appendOmadTransaction_(doc, transaction);
      var projectedTransactions = readOmadTransactions_(doc);
      var balances = calculateBalancesFromTransactions_(projectedTransactions, transaction.month);
      groupMessage = buildOmadGroupTransactionMessage_(transaction, balances);
      var groupResponse = sendTelegramMessage_(getOmadGroupChatId_(), groupMessage);
      groupMsgId = extractTelegramMessageId_(groupResponse);
      if (groupMsgId) updateOmadTransactionMsgId_(doc, transaction.id, groupMsgId);
    } finally {
      lock.releaseLock();
    }

    cache.remove(key);
    sendTelegramMessage_(chatId, buildTelegramConfirmation_(transaction), null, "Markdown");
  }
}

function getOmadGroupChatId_() {
  return getTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID);
}

function extractTelegramMessageId_(response) {
  try {
    var data = JSON.parse(response.getContentText() || "{}");
    return data && data.ok && data.result ? data.result.message_id : "";
  } catch (error) {
    return "";
  }
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

function formatUZS_(amount) {
  return Math.round(Number(amount) || 0).toLocaleString();
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

function buildOmadGroupTransactionMessage_(transaction, balances) {
  var rates = getOmadRates_();
  var title = transaction.type === "Income" ? "🟢 YANGI KIRIM" : "🔴 YANGI CHIQIM";
  var objectText = String(transaction.tenant || "").trim() || "Noma'lum";
  var periodText = String(transaction.month || "").trim() || "Noma'lum";
  var transferUZS = toUZS_(transaction.amount, transaction.currency, periodText, rates, "sell");
  var transferLines = "💵 " + formatUZS_(transferUZS) + " UZS";

  return title +
    "\n\n🏢 Obyekt: " + objectText +
    "\n📅 Davr: " + periodText +
    "\n\n💸 O'tkazma:\n" + transferLines +
    "\nJami: " + formatUZS_(transferUZS) + " UZS" +
    "\n\n📝 Izoh: " + (String(transaction.comment || "").trim() || "Kiritilmagan") +
    "\n\n📊 HISOBOT:" +
    "\n🔹 " + periodText + " qoldig'i: " + formatUZS_(balances.monthBalance) + " UZS" +
    "\n🏦 Umumiy balans: " + formatUZS_(balances.allTimeBalance) + " UZS";
}

function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var names = [];
  for (var i = 0; i < tenants.length; i++) names.push(tenants[i].name);
  return names;
}

function buildTelegramConfirmation_(transaction) {
  return [
    "✅ *Tranzaksiya saqlandi*",
    "",
    "*Turi:* " + (transaction.type === "Income" ? "Kirim" : "Chiqim"),
    "*Obyekt:* " + escapeMarkdown_(transaction.tenant),
    "*Oy:* " + escapeMarkdown_(transaction.month),
    "*Summa:* " + Number(transaction.amount || 0).toLocaleString() + " " + transaction.currency,
    "*Usul:* " + escapeMarkdown_(transaction.method),
    "*Izoh:* " + escapeMarkdown_(transaction.comment || "Kiritilmagan")
  ].join("\n");
}

function getCurrentUzbekMonth_() {
  var months = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];
  return months[new Date().getMonth()];
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

// ==========================================
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
    adminKeyConfigured: !!getTelegramSetting_(OMAD_PROP_ADMIN_KEY)
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

function auditTelegramSettingsChange_(updatedFields) {
  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    // Only field NAMES are stored - never values, never the token.
    sheet.appendRow([new Date().toISOString(), "telegram_settings_changed", (updatedFields || []).join(",")]);
  } catch (error) {}
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

function configureTelegramWebhook_(payload) {
  var webhookUrl = String((payload && payload.webhookUrl) || getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || "").trim();
  if (!/^https:\/\/[^\s]+$/.test(webhookUrl)) {
    return { status: "error", message: "Webhook manzili https:// bilan boshlanishi kerak." };
  }
  try {
    telegramFetch_("setWebhook", { url: webhookUrl, allowed_updates: ["message", "callback_query"] });
    var info = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var result = (info && info.result) || {};
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL, webhookUrl);
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS, JSON.stringify({
      configured: !!result.url,
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
 * Server-side proxy so the browser never needs a bot token.
 * Always posts to the configured reporting group.
 */
function proxyTelegramGroupCall_(action, payload) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) return { status: "error", message: "Telegram guruh ID o'rnatilmagan." };

  try {
    if (action === "telegram_send") {
      var sendBody = { chat_id: chatId, text: String(payload.text || ""), disable_web_page_preview: true };
      if (payload.parseMode) sendBody.parse_mode = payload.parseMode;
      var response = telegramFetch_("sendMessage", sendBody);
      return { status: "success", messageId: extractTelegramMessageId_(response) };
    }
    if (action === "telegram_edit") {
      if (!payload.messageId) return { status: "error", message: "messageId talab qilinadi." };
      telegramFetch_("editMessageText", {
        chat_id: chatId,
        message_id: payload.messageId,
        text: String(payload.text || ""),
        parse_mode: payload.parseMode || undefined
      });
      return { status: "success", messageId: payload.messageId };
    }
    if (action === "telegram_delete") {
      if (!payload.messageId) return { status: "error", message: "messageId talab qilinadi." };
      telegramFetch_("deleteMessage", { chat_id: chatId, message_id: payload.messageId });
      return { status: "success" };
    }
    return { status: "error", message: "Unknown telegram action" };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error) };
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

function debugLog_(doc, eventName, details) {
  try {
    var sheet = doc.getSheetByName("Telegram_Debug_Log") || doc.insertSheet("Telegram_Debug_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), eventName, redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}

function escapeMarkdown_(value) {
  return String(value || "").replace(/([_*`\[])/g, "\\$1");
}

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


