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
 * A counter bumped on every inventory write, whoever makes it.
 *
 * The admin screen edits stock and prices as a whole object, and the till now
 * depletes stock on the server. Without a version to check against, an admin
 * page opened this morning and saved this evening would put back everything
 * the day had sold -- silently, and in a way that only shows up as a stock
 * count that no longer matches the shelf.
 */
var CAFE_INVENTORY_REV_KEY = "Cafe_Inventory_Rev";

function cafeInventoryRev_(configSheet) {
  return Number(getConfig(configSheet, CAFE_INVENTORY_REV_KEY)) || 0;
}

/** The one place inventory is written, so the revision cannot be forgotten. */
function writeCafeInventory_(configSheet, inventory) {
  setConfig(configSheet, "Cafe_Inventory", JSON.stringify(inventory || []));
  var next = cafeInventoryRev_(configSheet) + 1;
  setConfig(configSheet, CAFE_INVENTORY_REV_KEY, String(next));
  return next;
}

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

  var accessError = checkAdminKey_(payload);
  if (accessError) return jsonOutput_({ status: "error", message: accessError });

  if (action === 'save_inventory') {
    // Optimistic concurrency. The screen says which version it was looking at;
    // anything else means stock moved underneath it and its copy is a
    // rollback waiting to happen.
    var currentRev = cafeInventoryRev_(configSheet);
    if (currentRev > 0 && Number(payload.expectedRev) !== currentRev) {
      return jsonOutput_({
        status: "error", stale: true, inventoryRev: currentRev,
        message: "Ombor boshqa joyda o'zgardi. Sahifani yangilab, qaytadan kiriting."
      });
    }
    return jsonOutput_({
      status: "success",
      inventoryRev: writeCafeInventory_(configSheet, payload.inventory)
    });
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
  if (action === 'save_sale') return saveCafeSale_(doc, configSheet, payload);
  if (action === 'void_sale') return voidCafeSale_(doc, configSheet, payload);
  if (action === 'close_day') return closeCafeDay_(doc, configSheet, payload);
  return null;
}

// ------------------------------------------------------- authoritative pricing
//
// The browser used to decide what a sale was worth. It sent the total, the
// cost and the profit, and the server wrote them down; it also depleted stock
// only in its own memory, so a refresh restored the stock it had just sold and
// two devices each tracked a different inventory.
//
// Everything below computes those figures from what is stored: the price on
// the product or recipe, the recipe's ingredients, and the stock on hand. The
// client says which items and how many; the server decides the rest.

var CAFE_STOCK_EPSILON = 0.0001;

/**
 * Just the catalogue: what can be sold and what it costs.
 *
 * `readCafeState_` also reads the whole Cafe_Sales sheet and the whole
 * close-day sheet. Pricing a sale needs neither, and a sale already scans the
 * sales sheet once for its request id -- reading it a second time to find the
 * price of a bottle of cola is hundreds of rows of work per transaction, and
 * grows with every sale ever made.
 */
function cafeCatalogue_(configSheet) {
  return {
    inventory: safeParseJSON_(getConfig(configSheet, "Cafe_Inventory"), []),
    recipes: safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), [])
  };
}

/** Rounds a quantity the way the POS does, so stock stays comparable. */
function cafeRoundQty_(value) {
  var n = Number(value) || 0;
  return Math.round(n * 10000) / 10000;
}

/** Index inventory by id once, rather than scanning per line. */
function cafeInventoryIndex_(inventory) {
  var map = {};
  for (var i = 0; i < inventory.length; i++) {
    map[String(inventory[i].id)] = inventory[i];
  }
  return map;
}

function cafeRecipeIndex_(recipes) {
  var map = {};
  for (var i = 0; i < recipes.length; i++) map[String(recipes[i].id)] = recipes[i];
  return map;
}

/** What one unit of a product costs us, honouring bulk servings. */
function cafeProductUnitCost_(product) {
  if (product.isBulk && Number(product.gramsPerServing) > 0) {
    return Math.round((Number(product.unitCost) || 0) * (Number(product.gramsPerServing) / 1000));
  }
  return Number(product.unitCost) || 0;
}

/** How much stock one sold unit consumes. */
function cafeProductStockPerUnit_(product) {
  if (product.isBulk && Number(product.gramsPerServing) > 0) {
    return Number(product.gramsPerServing) / 1000;
  }
  return 1;
}

/**
 * Turns the requested items into priced lines, or explains why it cannot.
 *
 * Nothing on the request is trusted for money: `price` and `baseCost` are read
 * from the stored product or recipe, never from the payload. An item the
 * catalogue does not contain is refused rather than sold at whatever the
 * caller suggested.
 */
function resolveCafeSaleLines_(state, items) {
  var requested = Array.isArray(items) ? items : [];
  if (requested.length === 0) return { error: "Savat bo'sh." };
  if (requested.length > 200) return { error: "Savatda juda ko'p mahsulot." };

  var inventory = cafeInventoryIndex_(state.inventory);
  var recipes = cafeRecipeIndex_(state.recipes);
  var lines = [];
  var consumption = {};   // inventory id -> { qty, cost }

  var consume = function (id, qty, cost) {
    var key = String(id);
    if (!consumption[key]) consumption[key] = { qty: 0, cost: 0 };
    consumption[key].qty += qty;
    consumption[key].cost += cost;
  };

  for (var i = 0; i < requested.length; i++) {
    var item = requested[i] || {};
    var qty = Number(item.qty);
    if (!isFinite(qty) || qty <= 0) return { error: "Miqdor musbat bo'lishi kerak." };
    if (qty > 100000) return { error: "Miqdor juda katta." };

    var kind = String(item.kind || "");

    if (kind === "recipe") {
      var recipe = recipes[String(item.recipeId)];
      if (!recipe) return { error: "Retsept topilmadi: " + String(item.name || item.recipeId || "") };
      var recipePrice = Number(recipe.sellPrice) || 0;
      if (recipePrice <= 0) return { error: "Retsept narxi belgilanmagan: " + String(recipe.name || "") };

      var recipeCost = 0;
      var ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      for (var g = 0; g < ingredients.length; g++) {
        var ing = ingredients[g] || {};
        var ingQty = (Number(ing.qty) || 0) * qty;
        var ingCost = (Number(ing.cost) || 0) * qty;
        recipeCost += ingCost;
        if (ing.inventoryId) consume(ing.inventoryId, ingQty, ingCost);
      }
      // A recipe may record its own cost; the ingredients are the truth when
      // they exist, because that is what the stock movement will charge.
      if (ingredients.length === 0) recipeCost = (Number(recipe.baseCost) || 0) * qty;

      lines.push({
        id: String(item.id || ("recipe_" + recipe.id)),
        kind: "recipe", recipeId: String(recipe.id),
        name: String(recipe.name || ""), qty: qty,
        price: recipePrice, baseCost: ingredients.length ? Math.round(recipeCost / qty) : (Number(recipe.baseCost) || 0),
        lineTotal: Math.round(recipePrice * qty),
        lineCost: Math.round(recipeCost)
      });
      continue;
    }

    var product = inventory[String(item.inventoryId)];
    if (!product) return { error: "Mahsulot topilmadi: " + String(item.name || item.inventoryId || "") };
    if (product.type !== "product") return { error: "Bu mahsulot sotuvda emas: " + String(product.name || "") };
    var price = Number(product.sellPrice) || 0;
    if (price <= 0) return { error: "Mahsulot narxi belgilanmagan: " + String(product.name || "") };

    var unitCost = cafeProductUnitCost_(product);
    var stockPerUnit = cafeProductStockPerUnit_(product);
    consume(product.id, stockPerUnit * qty, unitCost * qty);

    lines.push({
      id: String(item.id || ("product_" + product.id)),
      kind: "product", inventoryId: String(product.id),
      name: String(product.name || ""), qty: qty,
      price: price, baseCost: unitCost,
      isBulk: !!product.isBulk,
      gramsPerServing: Number(product.gramsPerServing) || 0,
      lineTotal: Math.round(price * qty),
      lineCost: Math.round(unitCost * qty)
    });
  }

  var total = 0;
  var cost = 0;
  for (var l = 0; l < lines.length; l++) { total += lines[l].lineTotal; cost += lines[l].lineCost; }

  return {
    lines: lines,
    consumption: consumption,
    total: Math.round(total),
    cost: Math.round(cost),
    profit: Math.round(total - cost)
  };
}

/** Refuses a sale that the stock on hand cannot cover. */
function cafeStockShortfall_(state, consumption) {
  var inventory = cafeInventoryIndex_(state.inventory);
  var short = [];
  Object.keys(consumption).forEach(function (id) {
    var item = inventory[id];
    if (!item) { short.push("Omborda yo'q: " + id); return; }
    var have = Number(item.qty) || 0;
    if (have + CAFE_STOCK_EPSILON < consumption[id].qty) {
      short.push(String(item.name || id) + ": " + have + " " + String(item.unit || "") +
                 " qoldi, " + cafeRoundQty_(consumption[id].qty) + " kerak");
    }
  });
  return short;
}

/**
 * Moves stock. `direction` is -1 for a sale and +1 for a void.
 *
 * The unit cost is recomputed from the remaining total so the next sale is
 * charged what the stock actually cost, which is what the POS did in the
 * browser and what the close-day figures assume.
 */
function applyCafeStockMovement_(state, consumption, direction) {
  var inventory = cafeInventoryIndex_(state.inventory);
  Object.keys(consumption).forEach(function (id) {
    var item = inventory[id];
    if (!item) return;
    item.qty = cafeRoundQty_((Number(item.qty) || 0) + consumption[id].qty * direction);
    item.totalCost = Math.max(0, Math.round((Number(item.totalCost) || 0) + consumption[id].cost * direction));
    if (item.qty > 0) {
      item.unitCost = Math.round(item.totalCost / item.qty);
    } else {
      item.qty = 0;
      item.unitCost = 0;
    }
  });
  return state.inventory;
}

/** The stored sale with this request id, if the request has already run. */
function findCafeSaleByRequestId_(salesSheet, requestId) {
  if (!salesSheet || !requestId || salesSheet.getLastRow() < 2) return null;
  var data = salesSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var detail = safeParseJSON_(data[i][4], null);
    if (detail && String(detail.requestId || "") === String(requestId)) {
      return { rowNumber: i + 1, row: data[i], detail: detail };
    }
  }
  return null;
}

function cafeSaleResponse_(id, date, seller, resolved, inventory) {
  return {
    status: "success",
    sale: {
      id: id, date: date, seller: seller,
      total: resolved.total, profit: resolved.profit, cost: resolved.cost,
      items: resolved.lines
    },
    inventory: inventory
  };
}

/**
 * Records one sale, priced and stock-checked by the server, atomically.
 *
 * The lock matters as much as the arithmetic: reading stock, deciding it is
 * sufficient and writing it back is a read-modify-write, and two tills selling
 * the last item at the same moment would otherwise both succeed.
 */
function saveCafeSale_(doc, configSheet, payload) {
  var requestId = String(payload.requestId || payload.id || "").trim();
  if (!requestId) return jsonOutput_({ status: "error", message: "requestId talab qilinadi." });
  if (requestId.length > 128) return jsonOutput_({ status: "error", message: "requestId juda uzun." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var salesSheet = doc.getSheetByName("Cafe_Sales") || doc.insertSheet("Cafe_Sales");
    if (salesSheet.getLastRow() === 0) salesSheet.appendRow(CAFE_SALES_HEADER);

    // A retry, a double tap or a redelivered request resolves to the sale the
    // first attempt created rather than ringing it up twice.
    var existing = findCafeSaleByRequestId_(salesSheet, requestId);
    if (existing) {
      var state = cafeCatalogue_(configSheet);
      return jsonOutput_(Object.assign(
        cafeSaleResponse_(String(existing.row[5]), existing.row[0], existing.row[1], {
          total: Number(existing.row[2]) || 0,
          profit: Number(existing.row[3]) || 0,
          cost: (Number(existing.row[2]) || 0) - (Number(existing.row[3]) || 0),
          lines: existing.detail.items || []
        }, state.inventory),
        { duplicate: true }));
    }

    var current = cafeCatalogue_(configSheet);
    var resolved = resolveCafeSaleLines_(current, payload.items);
    if (resolved.error) return jsonOutput_({ status: "error", message: resolved.error });

    var short = cafeStockShortfall_(current, resolved.consumption);
    if (short.length > 0) {
      return jsonOutput_({ status: "error", message: "Omborda yetarli emas — " + short.join("; ") });
    }

    var inventory = applyCafeStockMovement_(current, resolved.consumption, -1);
    writeCafeInventory_(configSheet, inventory);

    var saleId = String(payload.id || new Date().getTime());
    var saleDate = payload.date || new Date().toISOString();
    var seller = String(payload.seller || "").slice(0, 120);

    salesSheet.appendRow([
      saleDate, seller, resolved.total, resolved.profit,
      JSON.stringify({ requestId: requestId, items: resolved.lines }),
      saleId
    ]);

    return jsonOutput_(Object.assign(
      cafeSaleResponse_(saleId, saleDate, seller, resolved, inventory),
      { duplicate: false }));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reverses a stored sale.
 *
 * The stock is restored from the sale that was recorded, not from an inventory
 * the caller supplies. A browser that had drifted -- or one replaying an old
 * screen -- could otherwise overwrite the whole stock with a stale copy under
 * the guise of voiding one receipt.
 */
function voidCafeSale_(doc, configSheet, payload) {
  var saleId = String(payload.id || "").trim();
  if (!saleId) return jsonOutput_({ status: "error", message: "Sotuv ID talab qilinadi." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var salesSheet = doc.getSheetByName("Cafe_Sales");
    var rowNumber = 0;
    var detail = null;

    if (salesSheet && salesSheet.getLastRow() >= 2) {
      var data = salesSheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][5]) === saleId) {
          rowNumber = i + 1;
          detail = safeParseJSON_(data[i][4], null);
          break;
        }
      }
    }

    if (!rowNumber) {
      // Idempotent, including when that receipt was the only one on the sheet.
      // A repeated void of something already gone is not an error, and must
      // never be an excuse to put its stock back a second time.
      var already = cafeCatalogue_(configSheet);
      return jsonOutput_({ status: "success", duplicate: true, inventory: already.inventory });
    }

    var current = cafeCatalogue_(configSheet);
    var items = detail && Array.isArray(detail.items) ? detail.items
      : (Array.isArray(detail) ? detail : []);
    var restored = resolveCafeSaleLines_(current, items);

    var inventory = current.inventory;
    if (!restored.error) {
      inventory = applyCafeStockMovement_(current, restored.consumption, 1);
      writeCafeInventory_(configSheet, inventory);
    } else {
      // The receipt names something the catalogue no longer has. The sale is
      // still voided -- the money is what matters -- but the stock cannot be
      // put back automatically, and saying so is better than guessing.
      debugLog_(doc, "cafe_void_stock_unresolved", saleId + ": " + restored.error);
    }

    salesSheet.deleteRow(rowNumber);
    appendAuditRow_(doc, "cafe_sale_voided", saleId);

    return jsonOutput_({
      status: "success", duplicate: false, inventory: inventory,
      stockRestored: !restored.error
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Closes the day.
 *
 * Revenue, profit and the sale count are totalled from the sales that were
 * actually recorded; the browser's own running totals are not consulted. A
 * counted stock level *is* user-measured -- somebody looked in the fridge --
 * so it is accepted when supplied, and the day's own arithmetic is what
 * decides the money.
 */
function closeCafeDay_(doc, configSheet, payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var state = readCafeState_(doc, configSheet);
    var dayKey = cafeDateKey_(payload.date || new Date().toISOString());

    var revenue = 0;
    var profit = 0;
    var count = 0;
    for (var i = 0; i < state.sales.length; i++) {
      if (cafeDateKey_(state.sales[i].date) !== dayKey) continue;
      revenue += Number(state.sales[i].total) || 0;
      profit += Number(state.sales[i].profit) || 0;
      count++;
    }

    // A physical count is the one thing only a person can supply.
    // A physical count is a measurement, not an edit of a stale copy, so it
    // is not version-checked -- what is on the shelf is what is on the shelf.
    if (Array.isArray(payload.countedInventory)) {
      writeCafeInventory_(configSheet, payload.countedInventory);
      state.inventory = payload.countedInventory;
    }

    var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni") || doc.insertSheet("Cafe_Kun_Yakuni");
    if (closeSheet.getLastRow() === 0) closeSheet.appendRow(CAFE_CLOSE_DAY_HEADER);
    closeSheet.appendRow([
      payload.date || new Date().toISOString(),
      String(payload.seller || "").slice(0, 120),
      Math.round(revenue),
      Math.round(profit),
      JSON.stringify(Array.isArray(payload.summary) ? payload.summary : [])
    ]);

    var report = {
      date: payload.date, seller: payload.seller,
      totalRevenue: Math.round(revenue), totalProfit: Math.round(profit),
      salesCount: count, summary: payload.summary
    };

    // The close-day record is stored. Its Telegram report is queued
    // server-side; the browser never composes a Telegram message, and queueing
    // must never undo a close-day that is already stored.
    var closeJobId = "";
    try {
      closeJobId = queueCafeCloseDayReport_(doc, report);
    } catch (queueError) {
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);

    return jsonOutput_({
      status: "success", reportJobId: closeJobId || "",
      totalRevenue: Math.round(revenue), totalProfit: Math.round(profit),
      salesCount: count, inventory: state.inventory
    });
  } finally {
    lock.releaseLock();
  }
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
    inventoryRev: cafeInventoryRev_(configSheet),
    recipes: safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), []),
    categories: safeParseJSON_(getConfig(configSheet, "Cafe_Categories"), ["Ichimliklar", "Fast-Food", "Muzqaymoq"]),
    settings: safeParseJSON_(getConfig(configSheet, "Cafe_Settings"), { dailyTarget: 0 }),
    sales: sales,
    closeReports: closeReports
  };
}
