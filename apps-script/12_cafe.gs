// ============================================================
// Café operations
// ------------------------------------------------------------
// Inventory/recipes/categories/settings for cafe_admin.html, and sales, voids
// and close-day for cafe_pos.html. Behaviour is unchanged from the version
// that lived inline in doPost.
// ============================================================

var CAFE_SALES_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Chek_Tafsilotlari", "ID"];
var CAFE_CLOSE_DAY_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Tafsilotlar_JSON"];

var CAFE_MUTATIONS = {
  save_inventory: true, save_recipe: true, save_categories: true,
  save_cafe_settings: true, save_sale: true, void_sale: true, close_day: true
};

function isCafeAction_(action) {
  return CAFE_MUTATIONS[String(action || "")] === true;
}

/**
 * Handles every café action. Returns a ContentService output, or null when the
 * action does not belong to the café, so the router can carry on.
 *
 * Every one of these writes: inventory, recipes, prices, sales, voids and the
 * close-day record. They were reachable by anyone who knew the /exec URL, which
 * meant anyone could rewrite the stock or file a sale. They now take the same
 * key the rest of the business actions take.
 */
function handleCafeAction_(action, payload, doc, configSheet) {
  if (!isCafeAction_(action)) return null;

  var accessError = checkAccessKeyDuringRollout_(payload);
  if (accessError) return jsonOutput_({ status: "error", message: accessError });

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
