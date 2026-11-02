// ============================================================
// Moving the data from Google Sheets to Supabase
// ------------------------------------------------------------
// Operator actions, all omad_admin:
//
//   get_storage_status         which store is live, and whether Supabase answers
//   preview_supabase_import    convert every row in memory and count; writes nothing
//   apply_supabase_import      copy, verify, and only then switch OMAD_STORAGE
//   verify_supabase_import     compare the two stores again; writes nothing
//   rollback_supabase_storage  switch back to the spreadsheet
//
// Copy, verify and switch are ONE action under the script lock, because the
// spreadsheet is live until the moment of the switch: a separate cutover step
// minutes later would be comparing against a sheet that had moved on. If the
// verification fails, the switch does not happen and the spreadsheet stays
// the store.
//
// The copy never writes to the spreadsheet, so the sheet stays exactly as it
// was and remains the fallback. It also refuses to run into tables that
// already hold rows -- running it twice is never a way to duplicate a
// ledger. Emptying the database for a second attempt is a deliberate act
// (supabase/reset_before_cutover.sql), refused by the database itself once a
// cutover has happened.
//
// What counts as "the same" is what the application would read: every cell
// is pushed through the conversion the storage layer applies, and the result
// must equal what the database hands back. On top of that the ledger is read
// through `readOmadTransactions_` from both stores and the balances, the
// per-period figures and every tenant's payments are compared -- so the
// switch is decided on the money as well as on the cells.
//
// The Telegram debug log is compared but never blocks: it is diagnostics,
// and it is written outside the lock by every Telegram call, so a webhook
// arriving mid-copy is not a reason to refuse the move.
// ============================================================

/** Derived, revision-keyed and rebuilt on demand; copying it would be copying a cache. */
var SUPABASE_IMPORT_SKIP_CONFIG_KEYS = { Omad_Read_Model: true };

/** Script Property recording the last import / verification / cutover. */
var STORAGE_PROP_IMPORT_STATUS = "OMAD_STORAGE_IMPORT";

/** Written into the database at the switch; the reset script refuses to run once it exists. */
var STORAGE_CUTOVER_CONFIG_KEY = "Omad_Storage_Cutover_At";

function isStorageAction_(action) {
  return action === 'get_storage_status' ||
    action === 'preview_supabase_import' ||
    action === 'apply_supabase_import' ||
    action === 'verify_supabase_import' ||
    action === 'rollback_supabase_storage';
}

/** Diagnostics: compared and reported, never a reason to refuse the move. */
function isInformationalImportSheet_(name) {
  var text = String(name || "");
  return text === "Telegram_Debug_Log" || text.indexOf(SUPABASE_DEBUG_BACKUP_PREFIX) === 0;
}

function storageAction_(action, payload) {
  if (action === 'get_storage_status') {
    var answer = { status: "success", storage: storageStatus_(), importStatus: readStorageImportStatus_() };
    // Opt-in: it reads the whole ledger from both stores, three times each.
    if (payload && payload.benchmark === true) answer.benchmark = storageLatencyBenchmark_();
    return answer;
  }

  if (action === 'rollback_supabase_storage') return rollbackSupabaseStorage_();

  var credentialsForVerify = supabaseCredentials_();
  if (action === 'verify_supabase_import') {
    if (!credentialsForVerify.ok) {
      return { status: "error", message: "Script Properties'da yo'q: " + credentialsForVerify.missing.join(", ") };
    }
    var verification = verifySupabaseCopy_(SpreadsheetApp.getActiveSpreadsheet(), supabaseDoc_(credentialsForVerify));
    return {
      status: "success", verification: verification, importStatus: readStorageImportStatus_(),
      note: storageMode_() === STORAGE_MODE_SUPABASE
        ? "Supabase jonli: o'tishdan keyingi yozuvlar jadvalda yo'q, farqlar kutilgan."
        : ""
    };
  }

  if (storageMode_() !== STORAGE_MODE_SHEETS) {
    return { status: "error", message: "Ma'lumotlar allaqachon Supabase'da. Bu amal faqat Google Sheets rejimida ishlaydi." };
  }
  var credentials = supabaseCredentials_();
  if (!credentials.ok) {
    return { status: "error", message: "Script Properties'da yo'q: " + credentials.missing.join(", ") };
  }

  var source = SpreadsheetApp.getActiveSpreadsheet();
  var target = supabaseDoc_(credentials);

  if (action === 'preview_supabase_import') return previewSupabaseImport_(source, credentials);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return applySupabaseImport_(source, target, credentials);
  } finally {
    lock.releaseLock();
  }
}

function readStorageImportStatus_() {
  return safeParseJSON_(getTelegramSetting_(STORAGE_PROP_IMPORT_STATUS), {}) || {};
}

function recordStorageImportStatus_(changes) {
  var status = readStorageImportStatus_();
  Object.keys(changes).forEach(function (key) { status[key] = changes[key]; });
  setTelegramSetting_(STORAGE_PROP_IMPORT_STATUS, JSON.stringify(status));
}

// ------------------------------------------------------------- the sources

/** Every sheet that has a table, the debug-log backup copies included. */
function supabaseImportSources_(sourceDoc) {
  var sources = [];
  var sheets = sourceDoc.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    var definition = supabaseSheetDefinition_(name);
    if (definition) sources.push({ name: name, definition: definition, sheet: sheets[i] });
  }
  return sources;
}

/**
 * A sheet's data rows exactly as the application reads them: below the
 * header, padded to the table's width, and without the blank rows every
 * reader in the code skips.
 */
function supabaseSourceRows_(source) {
  var sheet = source.sheet;
  var width = source.definition.columns.length;
  if (!sheet || sheet.getLastRow() < 1) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  // System_Config has no fixed header: getConfig has always scanned every row,
  // the first included. The live sheet's first row is the label pair
  // "Type" / "Data JSON", which is not a setting.
  var start = 1;
  if (source.name === "System_Config") start = data.length && String(data[0][0]) === "Type" ? 1 : 0;
  for (var i = start; i < data.length; i++) {
    var first = data[i][0];
    if (first === "" || first === null || first === undefined) continue;
    if (source.name === "System_Config" && SUPABASE_IMPORT_SKIP_CONFIG_KEYS[String(first)]) continue;
    var row = [];
    for (var c = 0; c < width; c++) row.push(data[i][c] === undefined ? "" : data[i][c]);
    rows.push({ sheetRow: i + 1, cells: row });
  }
  return rows;
}

/** What the application will read back for a cell once it has been stored. */
function supabaseRoundTrip_(column, value) {
  return supabaseFromDb_(column[2], supabaseToDb_(column[2], value, column[3]));
}

// ------------------------------------------------------------------- preview

/**
 * Every row converted, every bad cell found, nothing written. Returns
 * `{ error }` naming the first sheet, row and column that cannot be stored,
 * or `{ prepared }` ready to copy.
 */
function prepareSupabaseImport_(source) {
  var sources = supabaseImportSources_(source);
  var prepared = [];
  for (var s = 0; s < sources.length; s++) {
    var rows = supabaseSourceRows_(sources[s]);
    var columns = sources[s].definition.columns;
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < columns.length; c++) {
        try {
          supabaseToDb_(columns[c][2], rows[r].cells[c], columns[c][3]);
        } catch (error) {
          return {
            error: sources[s].name + ", " + rows[r].sheetRow + "-qator, " + columns[c][0] + ": " +
              redactSecrets_(error).slice(0, 200)
          };
        }
      }
    }
    prepared.push({ source: sources[s], rows: rows });
  }
  return { prepared: prepared };
}

function previewSupabaseImport_(source, credentials) {
  var counts = supabaseTableCounts_(credentials);
  var occupied = Object.keys(counts).filter(function (table) { return counts[table] > 0; });
  var checked = prepareSupabaseImport_(source);
  var rows = {};
  (checked.prepared || []).forEach(function (entry) { rows[entry.source.name] = entry.rows.length; });
  return {
    status: "success",
    preview: {
      ready: !checked.error && occupied.length === 0,
      problem: checked.error || (occupied.length ? "Supabase jadvallari bo'sh emas: " + occupied.join(", ") : ""),
      rows: rows,
      tableCounts: counts
    },
    storage: storageStatus_(),
    importStatus: readStorageImportStatus_()
  };
}

// ------------------------------------------------------------------- apply

/** Row counts per table, unfiltered: an import needs every one to be empty. */
function supabaseTableCounts_(credentials) {
  var counts = {};
  var tables = {};
  Object.keys(SUPABASE_SHEETS).forEach(function (name) { tables[SUPABASE_SHEETS[name].table] = true; });
  Object.keys(tables).forEach(function (table) {
    var result = supabaseRequest_(credentials, "get", table, [["select", "seq"], ["limit", 1]], null, "count=exact");
    counts[table] = supabaseCountFrom_(result);
  });
  return counts;
}

function applySupabaseImport_(source, target, credentials) {
  var counts = supabaseTableCounts_(credentials);
  var occupied = Object.keys(counts).filter(function (table) { return counts[table] > 0; });
  if (occupied.length) {
    return {
      status: "error",
      message: "Supabase jadvallari bo'sh emas: " + occupied.join(", ") +
        ". Ikkinchi marta ko'chirish ma'lumotni ikkilantiradi.",
      counts: counts
    };
  }

  // Everything is converted -- and every bad cell found -- before anything is
  // written, so a refused import leaves the database as empty as it found it.
  var checked = prepareSupabaseImport_(source);
  if (checked.error) return { status: "error", message: checked.error };

  var copied = copyPreparedIntoSupabase_(checked.prepared, target);

  var verification = verifySupabaseCopy_(source, target);
  var now = new Date().toISOString();
  recordStorageImportStatus_({ importedAt: now, copied: copied, verifiedAt: now, verified: verification.ok });
  // Recorded in the database: the spreadsheet is only ever read by the move.
  appendAuditRow_(target, "supabase_import_applied", JSON.stringify({ copied: copied, verified: verification.ok }));

  if (!verification.ok) {
    return {
      status: "error",
      message: "Ko'chirildi, lekin tekshiruv o'tmadi — Google Sheets ishlashda davom etadi. " +
        "Supabase'ni tozalab, qaytadan urinib ko'ring.",
      copied: copied, verification: verification, importStatus: readStorageImportStatus_()
    };
  }

  // The switch. From the next request on, every read and write is the database's.
  target.getSheetByName("System_Config").setConfigValue(STORAGE_CUTOVER_CONFIG_KEY, now);
  setTelegramSetting_(STORAGE_PROP_MODE, STORAGE_MODE_SUPABASE);
  resetStorageMemos_();
  bumpAllDataRevisions_();
  recordStorageImportStatus_({ cutoverAt: now });
  // The audit trail now lives in the database, so that is where this goes.
  appendAuditRow_(target, "supabase_storage_cutover", JSON.stringify({ copied: copied, rows: verification.money.rows }));

  return {
    status: "success", copied: copied, verification: verification,
    storage: storageStatus_(), importStatus: readStorageImportStatus_()
  };
}

/** Writes prepared rows into the (empty) tables, in sheet order. Returns counts. */
function copyPreparedIntoSupabase_(prepared, target) {
  var copied = {};
  for (var p = 0; p < prepared.length; p++) {
    var entry = prepared[p];
    var values = entry.rows.map(function (row) { return row.cells; });
    if (values.length) {
      // The tables are empty, so the first data row is past the end: an insert.
      var firstRow = entry.source.definition.noHeader ? 1 : 2;
      target.getSheetByName(entry.source.name)
        .getRange(firstRow, 1, values.length, entry.source.definition.columns.length)
        .setValues(values);
    }
    copied[entry.source.name] = values.length;
  }
  return copied;
}

// ------------------------------------------------------------------ verify

/** Every cell, both stores, plus the money read through the application. */
function verifySupabaseCopy_(source, target) {
  var sheets = [];
  var problems = 0;
  var sources = supabaseImportSources_(source);

  for (var s = 0; s < sources.length; s++) {
    var name = sources[s].name;
    var columns = sources[s].definition.columns;
    var expected = supabaseSourceRows_(sources[s]);
    var stored = target.getSheetByName(name).getDataRange().getValues();
    var actual = sources[s].definition.noHeader ? stored : stored.slice(1);
    var differences = [];

    if (expected.length !== actual.length) {
      differences.push({ kind: "count", expected: expected.length, actual: actual.length });
    }
    var n = Math.min(expected.length, actual.length);
    for (var r = 0; r < n && differences.length < 5; r++) {
      for (var c = 0; c < columns.length; c++) {
        var want = supabaseRoundTrip_(columns[c], expected[r].cells[c]);
        var have = actual[r][c];
        if (JSON.stringify(want) === JSON.stringify(have)) continue;
        // jsonb normalises key order, so JSON is compared by meaning.
        if (columns[c][2] === "json" &&
            supabaseCanonicalJson_(want) === supabaseCanonicalJson_(have)) continue;
        differences.push({ kind: "cell", row: expected[r].sheetRow, column: columns[c][0] });
        break;
      }
    }

    var informational = isInformationalImportSheet_(name);
    if (!informational) problems += differences.length;
    sheets.push({
      sheet: name, rows: expected.length, stored: actual.length,
      differences: differences, informational: informational
    });
  }

  var money = compareOmadMoney_(source, target);
  if (!money.ok) problems++;

  return { ok: problems === 0, sheets: sheets, money: money, checkedAt: new Date().toISOString() };
}

/** JSON text with every object's keys sorted, for comparing jsonb by meaning. */
function supabaseCanonicalJson_(text) {
  var value = safeParseJSON_(text, text);
  var sortKeys = function (v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * The figures the business acts on, computed by the application from each
 * store: all-time cash/bank/total, and per period the income, the expense and
 * what every tenant paid.
 */
function compareOmadMoney_(source, target) {
  var summarise = function (doc) {
    var transactions = readOmadTransactions_(doc);
    var allTime = calculateActuals_(transactions, "");
    var periods = {};
    for (var i = 0; i < transactions.length; i++) {
      var p = transactionPeriod_(transactions[i]);
      if (p && !periods[p]) periods[p] = true;
    }
    var byPeriod = {};
    Object.keys(periods).sort().forEach(function (period) {
      var actuals = calculateActuals_(transactions, period);
      byPeriod[period] = {
        income: actuals.income, expense: actuals.expense,
        paid: tenantPaidTotals_(transactions, period)
      };
    });
    return {
      rows: transactions.length,
      balances: { cash: allTime.cash, bank: allTime.bank, total: allTime.total },
      periods: byPeriod
    };
  };

  var expected = summarise(source);
  var actual = summarise(target);
  var mismatches = [];
  if (expected.rows !== actual.rows) mismatches.push("rows");
  ["cash", "bank", "total"].forEach(function (key) {
    if (expected.balances[key] !== actual.balances[key]) mismatches.push("balances." + key);
  });
  var periods = {};
  Object.keys(expected.periods).forEach(function (p) { periods[p] = true; });
  Object.keys(actual.periods).forEach(function (p) { periods[p] = true; });
  Object.keys(periods).sort().forEach(function (p) {
    if (supabaseCanonicalJson_(JSON.stringify(expected.periods[p] || null)) !==
        supabaseCanonicalJson_(JSON.stringify(actual.periods[p] || null))) mismatches.push(p);
  });

  return {
    ok: mismatches.length === 0,
    rows: actual.rows,
    balances: actual.balances,
    periods: Object.keys(actual.periods).length,
    mismatches: mismatches.slice(0, 20)
  };
}

// --------------------------------------------------------- switching store

/**
 * Back to the spreadsheet. Nothing is copied back: anything written while the
 * database was the store exists only there, which the answer says out loud.
 */
function rollbackSupabaseStorage_() {
  var wasSupabase = storageMode_() === STORAGE_MODE_SUPABASE;
  setTelegramSetting_(STORAGE_PROP_MODE, STORAGE_MODE_SHEETS);
  resetStorageMemos_();
  bumpAllDataRevisions_();
  recordStorageImportStatus_({ rolledBackAt: new Date().toISOString() });
  appendAuditRow_(SpreadsheetApp.getActiveSpreadsheet(), "supabase_storage_rollback", wasSupabase ? "from supabase" : "noop");
  return {
    status: "success",
    storage: storageStatus_(),
    importStatus: readStorageImportStatus_(),
    warning: wasSupabase
      ? "Google Sheets'ga qaytildi. Supabase rejimida kiritilgan yozuvlar faqat Supabase'da qoldi."
      : ""
  };
}

/** Every cached summary was built from the other store. */
function bumpAllDataRevisions_() {
  bumpDataRevision_(CACHE_SCOPE_OMAD);
  bumpDataRevision_(CACHE_SCOPE_CAFE);
  bumpDataRevision_(CACHE_SCOPE_TASKS);
}
