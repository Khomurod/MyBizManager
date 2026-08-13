// ============================================================
// Café catalogue: recipes, their cost, their health, and stock movements
// ------------------------------------------------------------
// Three things live here that the café did not have:
//
//   1. **A recipe's cost is derived, never typed.** The admin screen used to
//      compute `cost` per ingredient and `baseCost` for the recipe in the
//      browser and send both. Whatever the ingredient had cost when the recipe
//      was written stayed on it for ever, so a recipe saved when flour was
//      cheap kept charging the cheap price after a restock — and the same
//      recipe priced a sale at one cost and the stock movement at another.
//      Every cost is recomputed here from the inventory as it is now.
//
//   2. **A catalogue revision of its own.** Inventory already has one, bumped
//      by every sale. Reusing it for recipes would mean a busy till stopped the
//      manager saving a recipe, which is a different thing going wrong. This
//      counter moves only when the *catalogue* — recipes, categories,
//      settings — changes.
//
//   3. **Stock leaves for reasons other than a sale.** Spoilage, waste, staff
//      drinks and plain miscounts all used to be entered by editing the
//      quantity, which is untraceable and races the till. They are a movement
//      now, applied under the script lock and written to a sheet that says what
//      happened and why.
// ============================================================

/** Bumped by every catalogue write. Deliberately not the inventory counter. */
var CAFE_CATALOGUE_REV_KEY = "Cafe_Catalogue_Rev";

/** Where stock movements that are not sales are recorded. */
var CAFE_MOVEMENTS_SHEET = "Cafe_Stock_Movements";

var CAFE_MOVEMENTS_HEADER = [
  "Sana", "Yo'nalish", "Sabab", "Mahsulot_ID", "Nomi",
  "Miqdor", "Birlik", "Tannarx", "Qoldiq", "Izoh", "Kim", "Request_ID"
];

/** How many movements one screen is handed. */
var CAFE_MOVEMENTS_PAGE = 40;

/**
 * Why stock left or arrived outside a sale.
 *
 * Deliberately a short, closed list: the point is that a year later somebody
 * can tell a spillage from a staff drink from a miscount, and free text does
 * not survive that. `note` carries the detail.
 */
var CAFE_MOVEMENT_REASONS = {
  purchase: "Kirim",
  spoilage: "Buzilgan",
  waste: "Chiqindi",
  internal: "Ichki iste'mol",
  correction: "Tuzatish",
  recount: "Qayta sanoq"
};

/** Default "running out" level when neither the item nor the settings say. */
var CAFE_DEFAULT_LOW_STOCK = 3;

/** A sell price this many times the cost is almost certainly a typo. */
var CAFE_EXTREME_MARGIN_RATIO = 20;

function cafeCatalogueRev_(configSheet) {
  return Number(getConfig(configSheet, CAFE_CATALOGUE_REV_KEY)) || 0;
}

/** Bumps the catalogue revision. Called by every catalogue writer. */
function bumpCafeCatalogueRev_(configSheet) {
  var next = cafeCatalogueRev_(configSheet) + 1;
  setConfig(configSheet, CAFE_CATALOGUE_REV_KEY, String(next));
  return next;
}

/**
 * Refuses a catalogue write that was composed against an older catalogue.
 *
 * The check is *opt-in*, and deliberately so. A caller that names the revision
 * it read is asking to be protected and is held to it exactly. A caller that
 * names none is a client written before the counter existed — a cached page, a
 * script in the editor — and refusing it would break saving outright without
 * protecting anything, because such a client cannot quote a revision however
 * strict this is. The screens that can, do.
 *
 * A project whose counter has never moved accepts the first write for the same
 * reason the inventory guard does: nothing has been overwritten yet.
 */
function cafeCatalogueStale_(configSheet, expectedRev) {
  if (expectedRev === undefined || expectedRev === null || expectedRev === "") return null;
  var current = cafeCatalogueRev_(configSheet);
  if (current <= 0) return null;
  if (Number(expectedRev) === current) return null;
  return {
    status: "error", stale: true, catalogueRev: current,
    message: "Katalog boshqa joyda o'zgardi. Sahifani yangilab, qaytadan kiriting."
  };
}

function isCafeCatalogueAction_(action) {
  return action === 'save_recipe' || action === 'save_categories' || action === 'save_cafe_settings';
}

/**
 * One catalogue write: check the revision, store, bump — under the script lock.
 *
 * The lock is what makes the revision mean anything. Reading the counter,
 * writing the array and bumping the counter as three separate steps lets two
 * saves that quoted the *same* revision both pass the check, and the second
 * whole-array write then silently replaces the first — which is exactly the
 * accident the counter exists to stop, arriving exactly when two people are
 * saving at once.
 *
 * It is the same lock the till takes, and that is affordable here: a catalogue
 * save is a handful of `System_Config` cells and happens a few times a week,
 * where a sale happens a few times a minute. What must *not* happen is the
 * reverse — a sale waiting on a catalogue edit — and it does not, because this
 * holds the lock for the length of one write.
 */
function saveCafeCatalogue_(action, payload, configSheet) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var stale = cafeCatalogueStale_(configSheet, payload.expectedCatalogueRev);
    if (stale) return jsonOutput_(stale);

    if (action === 'save_recipe') {
      // Every cost is recomputed here from the inventory as it is now. The
      // browser sends which ingredient and how much of it; what that is worth
      // is not its to decide, exactly as it is not its to decide what a sale
      // is worth. A recipe saved when flour was cheap used to keep the cheap
      // cost for ever.
      var catalogue = cafeCatalogue_(configSheet);
      var recipes = normalizeCafeRecipes_(payload.recipes, catalogue.inventory, catalogue.recipes);
      setConfig(configSheet, "Cafe_Recipes", JSON.stringify(recipes));
      return jsonOutput_({
        status: "success",
        recipes: recipes,
        catalogueRev: bumpCafeCatalogueRev_(configSheet),
        health: buildCafeCatalogueHealth_(catalogue.inventory, recipes,
          safeParseJSON_(getConfig(configSheet, "Cafe_Settings"), { dailyTarget: 0 }))
      });
    }

    if (action === 'save_categories') {
      setConfig(configSheet, "Cafe_Categories", JSON.stringify(payload.categories));
      return jsonOutput_({ status: "success", catalogueRev: bumpCafeCatalogueRev_(configSheet) });
    }

    setConfig(configSheet, "Cafe_Settings", JSON.stringify(payload.settings));
    return jsonOutput_({ status: "success", catalogueRev: bumpCafeCatalogueRev_(configSheet) });
  } finally {
    lock.releaseLock();
  }
}

// --------------------------------------------------------------- recipes

/**
 * One recipe, with every money figure recomputed from the inventory.
 *
 * `ingredients` keeps `inventoryId` and `qty` from the caller and nothing else:
 * `cost` and `baseCost` are what this ingredient costs *now*, and `name` is
 * what the inventory calls it now, so a renamed ingredient stops reading as two
 * different things. A recipe whose ingredient has been deleted keeps the line —
 * losing it would silently make the recipe cheaper — with a zero cost and a
 * `missing` marker that the health check reports.
 */
function normalizeCafeRecipe_(raw, inventoryIndex, existing) {
  var input = raw && typeof raw === "object" ? raw : {};
  var previous = existing || {};

  var id = String(input.id || previous.id || "").trim();
  if (!id) id = "rec_" + new Date().getTime() + "_" + Math.floor(Math.random() * 100000);

  var name = String(input.name === undefined ? (previous.name || "") : input.name).trim().slice(0, 120);
  var category = String(input.category === undefined ? (previous.category || "") : input.category)
    .trim().slice(0, 80);

  var sellPrice = Math.max(0, Math.round(Number(
    input.sellPrice === undefined ? previous.sellPrice : input.sellPrice) || 0));

  // Absent means "still whatever it was"; present and false means retired.
  var active = input.active === undefined
    ? (previous.active === undefined ? true : previous.active !== false)
    : input.active !== false;

  var source = Array.isArray(input.ingredients)
    ? input.ingredients
    : (Array.isArray(previous.ingredients) ? previous.ingredients : []);

  var ingredients = [];
  var baseCost = 0;
  for (var i = 0; i < source.length; i++) {
    var line = source[i] || {};
    var inventoryId = String(line.inventoryId || "").trim();
    // A line naming nothing references nothing and cannot be costed or
    // consumed. Anything that *does* name an ingredient is kept, including a
    // zero or unreadable quantity: dropping it would quietly make the recipe
    // cheaper, and the health check exists to say so out loud instead.
    if (!inventoryId) continue;
    var qty = Number(line.qty);
    if (!isFinite(qty) || qty < 0) qty = 0;
    qty = cafeRoundQty_(qty);

    var item = inventoryIndex[inventoryId];
    var unitCost = item ? (Number(item.unitCost) || 0) : 0;
    var cost = Math.round(qty * unitCost);
    baseCost += cost;

    ingredients.push({
      inventoryId: inventoryId,
      // The inventory's own name, so a rename cannot leave a recipe describing
      // an ingredient nobody has heard of. A deleted one keeps the last name
      // the recipe carried, which is the only record of what it used to be.
      name: item ? String(item.name || "") : String(line.name || ""),
      qty: qty,
      unitCost: unitCost,
      cost: cost,
      missing: !item
    });
  }

  return {
    id: id,
    name: name,
    category: category,
    ingredients: ingredients,
    // Never read from the payload. The whole point of the server pricing a sale
    // is that the browser cannot decide what something costs us.
    baseCost: Math.round(baseCost),
    sellPrice: sellPrice,
    active: active,
    updatedAt: new Date().toISOString()
  };
}

/** Every recipe, costed against the inventory as it is now. */
function normalizeCafeRecipes_(recipes, inventory, existingRecipes) {
  var index = cafeInventoryIndex_(Array.isArray(inventory) ? inventory : []);
  var previous = cafeRecipeIndex_(Array.isArray(existingRecipes) ? existingRecipes : []);
  var list = Array.isArray(recipes) ? recipes : [];
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var raw = list[i];
    // Nothing is dropped for being *incomplete*. This runs over the whole
    // stored array on every save, so a rule like "a nameless recipe is not one"
    // would delete live rows from the Sheet as a side effect of an unrelated
    // edit. An empty entry is not a recipe at all and goes; anything carrying
    // an id or a name stays and is reported by the health check.
    if (!raw || typeof raw !== "object") continue;
    if (!String(raw.id || "").trim() && !String(raw.name || "").trim()) continue;

    var normalized = normalizeCafeRecipe_(raw, index, previous[String(raw.id || "")]);
    if (seen[normalized.id]) continue;            // an id may appear once
    seen[normalized.id] = true;
    out.push(normalized);
  }
  return out;
}

/** What the POS may sell: a recipe that is active and priced. */
function cafeSellableRecipes_(recipes) {
  var list = Array.isArray(recipes) ? recipes : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].active === false) continue;
    out.push(list[i]);
  }
  return out;
}

// ---------------------------------------------------------------- health

/** The low-stock level for one item: its own, the café's, or the default. */
function cafeLowStockThreshold_(item, settings) {
  var own = Number((item || {}).lowStockThreshold);
  if (isFinite(own) && own >= 0) return own;
  var configured = Number((settings || {}).lowStockThreshold);
  if (isFinite(configured) && configured >= 0) return configured;
  return CAFE_DEFAULT_LOW_STOCK;
}

/**
 * Everything worth warning the admin about, in one pass over the catalogue.
 *
 * Warnings, never corrections: nothing here changes a price, deletes a recipe
 * or merges a duplicate. A duplicate in particular is *reported* — historical
 * sales reference recipes by id, and deciding which of two is the real one is a
 * judgement about the business, not about the data.
 */
function buildCafeCatalogueHealth_(inventory, recipes, settings) {
  var items = Array.isArray(inventory) ? inventory : [];
  var list = Array.isArray(recipes) ? recipes : [];
  var index = cafeInventoryIndex_(items);

  var missingIngredients = [];
  var incomplete = [];
  var belowCost = [];
  var extremePrice = [];
  var noPrice = [];
  var byName = {};

  for (var i = 0; i < list.length; i++) {
    var recipe = list[i] || {};
    var name = String(recipe.name || "");
    var key = name.toLowerCase().replace(/\s+/g, " ").trim();
    if (key) {
      if (!byName[key]) byName[key] = [];
      byName[key].push({ id: String(recipe.id || ""), name: name, active: recipe.active !== false });
    }

    var ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    var missing = [];
    for (var g = 0; g < ingredients.length; g++) {
      var inventoryId = String((ingredients[g] || {}).inventoryId || "");
      if (inventoryId && !index[inventoryId]) {
        missing.push(String(ingredients[g].name || inventoryId));
      }
    }
    if (missing.length) {
      missingIngredients.push({
        id: String(recipe.id || ""), name: name, ingredients: missing,
        active: recipe.active !== false
      });
    }

    if (!name) {
      incomplete.push({ id: String(recipe.id || ""), name: String(recipe.id || ""), reason: "nomi yo'q" });
    } else if (!ingredients.length) {
      incomplete.push({ id: String(recipe.id || ""), name: name, reason: "ingredientlar yo'q" });
    } else if (!String(recipe.category || "").trim()) {
      incomplete.push({ id: String(recipe.id || ""), name: name, reason: "kategoriya tanlanmagan" });
    }
    for (var z = 0; z < ingredients.length; z++) {
      if ((Number(ingredients[z].qty) || 0) > 0) continue;
      incomplete.push({
        id: String(recipe.id || ""), name: name,
        reason: "miqdorsiz ingredient: " + String(ingredients[z].name || ingredients[z].inventoryId || "")
      });
    }

    var sell = Number(recipe.sellPrice) || 0;
    var cost = Number(recipe.baseCost) || 0;
    if (sell <= 0) {
      noPrice.push({ id: String(recipe.id || ""), name: name });
    } else if (cost > 0 && sell < cost) {
      belowCost.push({ id: String(recipe.id || ""), name: name, sellPrice: sell, cost: cost });
    } else if (cost > 0 && sell > cost * CAFE_EXTREME_MARGIN_RATIO) {
      extremePrice.push({ id: String(recipe.id || ""), name: name, sellPrice: sell, cost: cost });
    }
  }

  // A product sold straight from the shelf has the same two mistakes available.
  for (var p = 0; p < items.length; p++) {
    var product = items[p] || {};
    if (product.type !== "product") continue;
    var productSell = Number(product.sellPrice) || 0;
    var productCost = cafeProductUnitCost_(product);
    if (productSell <= 0) {
      noPrice.push({ id: String(product.id || ""), name: String(product.name || ""), product: true });
    } else if (productCost > 0 && productSell < productCost) {
      belowCost.push({
        id: String(product.id || ""), name: String(product.name || ""),
        sellPrice: productSell, cost: productCost, product: true
      });
    } else if (productCost > 0 && productSell > productCost * CAFE_EXTREME_MARGIN_RATIO) {
      extremePrice.push({
        id: String(product.id || ""), name: String(product.name || ""),
        sellPrice: productSell, cost: productCost, product: true
      });
    }
  }

  var duplicates = [];
  Object.keys(byName).forEach(function (key) {
    if (byName[key].length > 1) duplicates.push({ name: byName[key][0].name, recipes: byName[key] });
  });

  return {
    missingIngredients: missingIngredients,
    duplicates: duplicates,
    incomplete: incomplete,
    belowCost: belowCost,
    extremePrice: extremePrice,
    noPrice: noPrice,
    lowStock: buildCafeLowStock_(items, settings),
    // One number the screen can put on a badge without re-deriving the rule.
    warnings: missingIngredients.length + duplicates.length + incomplete.length +
      belowCost.length + extremePrice.length + noPrice.length
  };
}

/** Everything at or under its low-stock level, emptiest first. */
function buildCafeLowStock_(inventory, settings) {
  var items = Array.isArray(inventory) ? inventory : [];
  var low = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var threshold = cafeLowStockThreshold_(item, settings);
    if (threshold <= 0) continue;                 // 0 means "do not warn me"
    var qty = Number(item.qty) || 0;
    if (qty > threshold) continue;
    low.push({
      id: String(item.id || ""), name: String(item.name || ""), qty: cafeRoundQty_(qty),
      unit: String(item.unit || ""), threshold: threshold, type: String(item.type || ""),
      out: qty <= 0
    });
  }
  low.sort(function (a, b) { return a.qty - b.qty; });
  return low;
}

// ------------------------------------------------------- stock movements

function cafeMovementsSheet_(doc) {
  var sheet = doc.getSheetByName(CAFE_MOVEMENTS_SHEET) || doc.insertSheet(CAFE_MOVEMENTS_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(CAFE_MOVEMENTS_HEADER);
  return sheet;
}

/** The movement this request id already produced, or null. */
function findCafeMovementByRequestId_(sheet, requestId) {
  if (!sheet || !requestId || sheet.getLastRow() < 2) return null;
  var data = sheet.getDataRange().getValues();
  var column = CAFE_MOVEMENTS_HEADER.length - 1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][column]) === String(requestId)) return { rowNumber: i + 1, row: data[i] };
  }
  return null;
}

/**
 * Moves stock for a reason that is not a sale, and records why.
 *
 * Under the script lock, like every other stock movement, because it is a
 * read-modify-write against a quantity the till is also changing. Idempotent on
 * `requestId`: a retry after a dropped connection resolves to the movement the
 * first attempt made rather than taking the stock twice.
 *
 * A withdrawal larger than what is on hand is refused rather than clamped —
 * with one exception. `correction` is the admin saying the *count* is wrong, so
 * it sets the level outright; every other reason describes a physical event
 * that cannot have removed more than there was.
 */
function adjustCafeStock_(doc, configSheet, payload, actor) {
  var requestId = String((payload && payload.requestId) || "").trim();
  if (!requestId || requestId.length > 128) {
    return jsonOutput_({ status: "error", message: "requestId talab qilinadi." });
  }

  var inventoryId = String((payload && payload.inventoryId) || "").trim();
  if (!inventoryId) return jsonOutput_({ status: "error", message: "Mahsulot tanlanmagan." });

  var reason = String((payload && payload.reason) || "").trim();
  if (!CAFE_MOVEMENT_REASONS[reason]) {
    return jsonOutput_({ status: "error", message: "Sabab tanlanmagan." });
  }

  var direction = String((payload && payload.direction) || "").trim();
  if (direction !== "in" && direction !== "out") {
    return jsonOutput_({ status: "error", message: "Yo'nalish noto'g'ri." });
  }

  var qty = Number(payload && payload.qty);
  if (!isFinite(qty) || qty <= 0) {
    return jsonOutput_({ status: "error", message: "Miqdor musbat bo'lishi kerak." });
  }
  if (qty > 1e9) return jsonOutput_({ status: "error", message: "Miqdor juda katta." });
  qty = cafeRoundQty_(qty);

  var note = String((payload && payload.note) || "").trim().slice(0, 300);
  // A reason code says what kind of thing happened; the note says which thing.
  // Requiring one for anything that is not a plain purchase is what makes the
  // history readable a year later.
  if (reason !== "purchase" && !note) {
    return jsonOutput_({ status: "error", message: "Qisqacha sabab yozing." });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = cafeMovementsSheet_(doc);
    var already = findCafeMovementByRequestId_(sheet, requestId);
    if (already) {
      var current = cafeCatalogue_(configSheet);
      return jsonOutput_({
        status: "success", duplicate: true,
        inventory: current.inventory, inventoryRev: cafeInventoryRev_(configSheet)
      });
    }

    var state = cafeCatalogue_(configSheet);
    var index = cafeInventoryIndex_(state.inventory);
    var item = index[inventoryId];
    if (!item) return jsonOutput_({ status: "error", message: "Mahsulot topilmadi." });

    var have = Number(item.qty) || 0;
    var unitCost = Number(item.unitCost) || 0;

    if (direction === "out" && reason !== "correction" && have + CAFE_STOCK_EPSILON < qty) {
      return jsonOutput_({
        status: "error",
        message: "Omborda yetarli emas — " + String(item.name || "") + ": " +
          cafeRoundQty_(have) + " " + String(item.unit || "")
      });
    }

    // How much money the movement takes with it. An intake may name the price
    // of the batch it arrived in; anything else is valued at what the stock on
    // the shelf cost us, which is what the next sale would have been charged.
    var costDelta;
    if (direction === "in" && Number(payload.cost) > 0) {
      costDelta = Math.round(Number(payload.cost));
    } else {
      costDelta = Math.round(qty * unitCost);
    }

    var nextQty = direction === "in"
      ? cafeRoundQty_(have + qty)
      : cafeRoundQty_(Math.max(0, have - qty));
    var nextTotal = direction === "in"
      ? Math.round((Number(item.totalCost) || 0) + costDelta)
      : Math.max(0, Math.round((Number(item.totalCost) || 0) - costDelta));

    item.qty = nextQty;
    item.totalCost = nextTotal;
    // Recomputed from what is left, exactly as a sale does, so the next sale is
    // charged what the remaining stock actually cost.
    item.unitCost = nextQty > 0 ? Math.round(nextTotal / nextQty) : 0;
    if (nextQty <= 0) { item.qty = 0; item.totalCost = 0; item.unitCost = 0; }

    var inventoryRev = writeCafeInventory_(configSheet, state.inventory);

    sheet.appendRow([
      new Date().toISOString(), direction, reason, inventoryId, String(item.name || ""),
      qty, String(item.unit || ""), costDelta, item.qty, note,
      String(actor || "").slice(0, 120), requestId
    ]);
    bumpDataRevision_(CACHE_SCOPE_CAFE);
    appendAuditRow_(doc, "cafe_stock_" + direction,
      inventoryId + " " + reason + " " + qty + (note ? " — " + note : ""));

    return jsonOutput_({
      status: "success", duplicate: false,
      inventory: state.inventory, inventoryRev: inventoryRev,
      movement: {
        direction: direction, reason: reason, qty: qty,
        inventoryId: inventoryId, remaining: item.qty
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** The most recent movements, newest first, and how many there are. */
function readCafeStockMovements_(doc, limit) {
  var sheet = doc.getSheetByName(CAFE_MOVEMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], total: 0 };

  var want = Math.min(200, Math.max(1, Number(limit) || CAFE_MOVEMENTS_PAGE));
  var data = sheet.getDataRange().getValues();
  var start = Math.max(1, data.length - want);
  var rows = [];
  for (var i = start; i < data.length; i++) {
    rows.push({
      date: data[i][0], direction: String(data[i][1] || ""), reason: String(data[i][2] || ""),
      reasonLabel: CAFE_MOVEMENT_REASONS[String(data[i][2] || "")] || String(data[i][2] || ""),
      inventoryId: String(data[i][3] || ""), name: String(data[i][4] || ""),
      qty: Number(data[i][5]) || 0, unit: String(data[i][6] || ""),
      cost: Number(data[i][7]) || 0, remaining: Number(data[i][8]) || 0,
      note: String(data[i][9] || ""), by: String(data[i][10] || "")
    });
  }
  rows.reverse();
  return { rows: rows, total: data.length - 1 };
}

/**
 * Records a movement that some other code path has already applied.
 *
 * Close-day writes a counted level straight to the inventory — a physical count
 * is a measurement, not an edit — and that used to leave no trace of a
 * quantity changing. The count itself is still authoritative; this only says it
 * happened.
 */
function recordCafeRecount_(doc, before, after, actor) {
  try {
    var previous = cafeInventoryIndex_(Array.isArray(before) ? before : []);
    var counted = Array.isArray(after) ? after : [];
    var sheet = null;
    var stamp = new Date().toISOString();

    for (var i = 0; i < counted.length; i++) {
      var item = counted[i] || {};
      var id = String(item.id || "");
      if (!id || !previous[id]) continue;
      var was = Number(previous[id].qty) || 0;
      var now = Number(item.qty) || 0;
      if (Math.abs(now - was) <= CAFE_STOCK_EPSILON) continue;

      if (!sheet) sheet = cafeMovementsSheet_(doc);
      sheet.appendRow([
        stamp, now > was ? "in" : "out", "recount", id, String(item.name || ""),
        cafeRoundQty_(Math.abs(now - was)), String(item.unit || ""),
        Math.round(Math.abs(now - was) * (Number(item.unitCost) || 0)), cafeRoundQty_(now),
        "Kun yakuni sanog'i", String(actor || "").slice(0, 120),
        "recount_" + stamp + "_" + id
      ]);
    }
  } catch (error) {
    // A close-day that is already stored must never fail because its audit
    // trail could not be written.
    debugLog_(doc, "cafe_recount_log_failed", String(error));
  }
}
