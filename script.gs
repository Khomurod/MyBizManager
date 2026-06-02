function doPost(e) {
  var doc = SpreadsheetApp.getActiveSpreadsheet();

  try {
    var payload = JSON.parse((e.postData && e.postData.contents) || "{}");
    var action = payload.action;
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

    if (!action && (payload.message || payload.callback_query)) {
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

function handleOmadTelegramUpdate_(update, doc, configSheet) {
  var callback = update.callback_query;
  var message = update.message;
  var chatId = callback ? callback.message.chat.id : message.chat.id;
  var cache = CacheService.getScriptCache();
  var key = "yangi_" + chatId;

  if (callback) {
    answerCallbackQuery_(callback.id);
    processOmadCallback_(callback, chatId, key, cache, configSheet);
    return jsonOutput_({ status: "success" });
  }

  var text = String((message && message.text) || "").trim();
  if (text === "/yangi" || text.indexOf("/yangi ") === 0) {
    cache.remove(key);
    sendTelegramMessage_(chatId, "Iltimos, operatsiya turini tanlang:", {
      inline_keyboard: [[
        { text: "🟢 Kirim", callback_data: "bot_type:Income" },
        { text: "🔴 Chiqim", callback_data: "bot_type:Expense" }
      ]]
    });
    return jsonOutput_({ status: "success" });
  }

  processOmadTextStep_(text, chatId, key, cache, doc, configSheet);
  return jsonOutput_({ status: "success" });
}

function processOmadCallback_(callback, chatId, key, cache, configSheet) {
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

function processOmadTextStep_(text, chatId, key, cache, doc, configSheet) {
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
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var transaction;
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
    } finally {
      lock.releaseLock();
    }

    cache.remove(key);
    sendTelegramMessage_(chatId, buildTelegramConfirmation_(transaction), null, "Markdown");
  }
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

function answerCallbackQuery_(callbackQueryId) {
  telegramFetch_("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

function telegramFetch_(method, body) {
  var token = getBotToken_();
  if (!token) throw new Error("Telegram bot token is missing");
  return UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
}

function getBotToken_() {
  var hardcodedToken = "7752185432:AAGJqGlLE2Ze0jHfGftTXyC2yic-EvffHGg";
  if (hardcodedToken) return hardcodedToken;
  if (typeof BOT_TOKEN !== "undefined" && BOT_TOKEN) return BOT_TOKEN;
  return PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || "";
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
