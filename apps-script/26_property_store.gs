// ============================================================
// Where the settings live: Script Properties or app_properties
// ------------------------------------------------------------
// Operator actions, all omad_admin, both under the script lock:
//
//   move_properties_to_database  copy every shared Script Property into
//                                app_properties, verify, switch, then write
//                                the ready marker the Edge function checks
//   move_properties_to_script    copy them back, delete the marker, switch
//
// Why they move at all: the Supabase Edge function serves the same API as
// this script, and a setting only one runtime can see (a user, the session
// secret, the bot token, a cache revision) would let the other act on an old
// copy. Once moved, both read the same table (03_settings.gs), and Apps Script
// keeps writing a copy of every change to its own Script Properties, which is
// what it falls back to when the database cannot be read and what moving back
// starts from.
//
// The keys that say where the database is (LOCAL_PROPERTY_KEYS) never move.
// Neither do the Edge function's own switches (EDGE_*, isDatabaseOnlyProperty_):
// they are written straight into app_properties, before the move as well as
// after, and a move in either direction leaves them where they are.
//
// Order matters, in both directions:
//   - to the database: copy, verify, switch this script over, copy again
//     whatever changed in Script Properties meanwhile, and only then the
//     marker -- the Edge function serves nothing itself before the marker;
//   - back: delete the marker first, so the Edge function stops serving, then
//     copy back and switch.
// Every cache revision is bumped afterwards: a write that landed in the old
// store while copying must not leave a summary readable under a revision the
// new store still has.
// ============================================================

function isPropertyStoreAction_(action) {
  return action === 'move_properties_to_database' || action === 'move_properties_to_script';
}

function propertyStoreAction_(action) {
  var lock = appScriptLock_();
  lock.waitLock(30000);
  try {
    return action === 'move_properties_to_database'
      ? movePropertiesToDatabase_()
      : movePropertiesToScript_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * A row of app_properties that only the database holds: the ready marker and
 * the Edge function's switches (EDGE_NATIVE_ACTIONS, EDGE_APPS_SCRIPT_URL,
 * EDGE_CRON_SECRET). The Edge function reads them before the settings have
 * moved -- it forwards to Apps Script by EDGE_APPS_SCRIPT_URL -- so a move must
 * not delete them for being absent from Script Properties.
 */
function isDatabaseOnlyProperty_(key) {
  return key === PROPERTY_STORE_READY_KEY || String(key).indexOf("EDGE_") === 0;
}

/**
 * Whether the Edge function serves `group` ("jobs", "telegram") itself: the
 * ready marker and EDGE_NATIVE_ACTIONS, read the way
 * supabase/functions/api/lib/routing.js reads them (change the two together).
 * Before the settings are in the database the function serves nothing itself.
 */
function edgeServesGroup_(group) {
  if (!sharedPropertiesInDatabase_(PropertiesService.getScriptProperties())) return false;
  if (!getTelegramSetting_(PROPERTY_STORE_READY_KEY)) return false;
  var names = String(getTelegramSetting_("EDGE_NATIVE_ACTIONS") || "").split(",");
  for (var i = 0; i < names.length; i++) {
    var name = names[i].replace(/^\s+|\s+$/g, "");
    if (name === "*" || name === group) return true;
  }
  return false;
}

/** Every Script Property that is a shared setting, as a plain map. */
function localSharedProperties_(local) {
  var all = local.getProperties() || {};
  var out = {};
  Object.keys(all).forEach(function (key) {
    if (LOCAL_PROPERTY_KEYS[key] || isDatabaseOnlyProperty_(key)) return;
    out[key] = String(all[key]);
  });
  return out;
}

/** app_properties as a map, read straight from the database. */
function databaseProperties_(credentials) {
  var rows = supabaseRequest_(credentials, "get", "app_properties",
    [["select", "key,value"], ["limit", SUPABASE_PAGE_SIZE]]).json || [];
  var out = {};
  for (var i = 0; i < rows.length; i++) out[rows[i].key] = rows[i].value === null ? "" : String(rows[i].value);
  return out;
}

/** The ops that make the database hold exactly `wanted` (its own rows aside). */
function propertySyncOps_(wanted, stored) {
  var ops = [];
  Object.keys(stored).forEach(function (key) {
    if (isDatabaseOnlyProperty_(key)) return;
    if (!Object.prototype.hasOwnProperty.call(wanted, key)) ops.push({ op: "delete_property", key: key });
  });
  Object.keys(wanted).forEach(function (key) {
    if (stored[key] !== wanted[key]) ops.push({ op: "upsert_property", key: key, value: wanted[key] });
  });
  return ops;
}

/** Keys whose value differs between two maps, for the answer (never the values). */
function propertyMismatches_(wanted, stored) {
  var keys = {};
  Object.keys(wanted).forEach(function (key) { keys[key] = true; });
  Object.keys(stored).forEach(function (key) { if (!isDatabaseOnlyProperty_(key)) keys[key] = true; });
  return Object.keys(keys).filter(function (key) { return wanted[key] !== stored[key]; }).sort();
}

function applyPropertyOps_(credentials, ops) {
  if (ops.length) supabaseRpc_(credentials, "mbm_apply", { ops: ops });
}

function propertyStoreStatus_() {
  var local = PropertiesService.getScriptProperties();
  return {
    store: sharedPropertiesInDatabase_(local) ? "database" : "script",
    configured: String(local.getProperty(PROPERTY_STORE_PROP) || "") || "script"
  };
}

function movePropertiesToDatabase_() {
  var local = PropertiesService.getScriptProperties();
  if (storageMode_() !== STORAGE_MODE_SUPABASE) {
    return { status: "error", message: "Avval ma'lumotlar Supabase'ga ko'chirilishi kerak (OMAD_STORAGE=supabase)." };
  }
  if (sharedPropertiesInDatabase_(local)) {
    return { status: "error", message: "Sozlamalar allaqachon bazada (app_properties).", properties: propertyStoreStatus_() };
  }
  var credentials = supabaseCredentials_();
  if (!credentials.ok) {
    return { status: "error", message: "Script Properties'da yo'q: " + credentials.missing.join(", ") };
  }

  var stored;
  try {
    stored = databaseProperties_(credentials);
  } catch (error) {
    return {
      status: "error",
      message: "app_properties jadvali o'qilmadi (migratsiya 20261116120000_edge_shared_state.sql qo'llanganmi?): " +
        redactSecrets_(error).slice(0, 300)
    };
  }

  // 1. Copy, and check the database now holds exactly what Script Properties do.
  var wanted = localSharedProperties_(local);
  applyPropertyOps_(credentials, propertySyncOps_(wanted, stored));
  var mismatches = propertyMismatches_(wanted, databaseProperties_(credentials));
  if (mismatches.length) {
    return {
      status: "error",
      message: "Bazadagi sozlamalar Script Properties bilan mos emas, o'tish bekor qilindi: " + mismatches.slice(0, 20).join(", ")
    };
  }

  // 2. Switch this script over. From here every setting it writes goes to the
  //    database first (and to Script Properties as a copy).
  local.setProperty(PROPERTY_STORE_PROP, PROPERTY_STORE_DATABASE);
  resetStorageMemos_();

  // 3. Whatever a lock-free execution wrote to Script Properties between the
  //    copy and the switch (a delivery stamp, a revision) is copied too.
  var later = localSharedProperties_(local);
  var caughtUp = [];
  Object.keys(later).forEach(function (key) { if (later[key] !== wanted[key]) caughtUp.push(key); });
  if (caughtUp.length) {
    applyPropertyOps_(credentials, caughtUp.map(function (key) {
      return { op: "upsert_property", key: key, value: later[key] };
    }));
  }

  // 4. Only now may the Edge function serve anything itself.
  var readyAt = new Date().toISOString();
  applyPropertyOps_(credentials, [{ op: "upsert_property", key: PROPERTY_STORE_READY_KEY, value: readyAt }]);
  resetStorageMemos_();
  bumpAllDataRevisions_();
  recordStorageImportStatus_({ propertiesMovedAt: readyAt });
  appendAuditRow_(appDoc_(), "properties_to_database", Object.keys(wanted).length + " keys");
  return {
    status: "success",
    moved: Object.keys(wanted).length,
    caughtUp: caughtUp.length,
    properties: propertyStoreStatus_()
  };
}

function movePropertiesToScript_() {
  var local = PropertiesService.getScriptProperties();
  if (!sharedPropertiesInDatabase_(local)) {
    return { status: "error", message: "Sozlamalar Script Properties'da, ko'chirish shart emas.", properties: propertyStoreStatus_() };
  }
  var credentials = supabaseCredentials_();
  if (!credentials.ok) {
    return { status: "error", message: "Script Properties'da yo'q: " + credentials.missing.join(", ") };
  }
  copyPropertiesBackToScript_(local, credentials);
  bumpAllDataRevisions_();
  recordStorageImportStatus_({ propertiesMovedBackAt: new Date().toISOString() });
  appendAuditRow_(appDoc_(), "properties_to_script", "");
  return { status: "success", properties: propertyStoreStatus_() };
}

/**
 * The move back, shared with the rollback to the spreadsheet: marker first
 * (the Edge function stops serving), then the copy, then the switch. If the
 * database cannot be read, the copy Apps Script kept is already in Script
 * Properties, so the switch still happens.
 */
function copyPropertiesBackToScript_(local, credentials) {
  var copied = false;
  try {
    applyPropertyOps_(credentials, [{ op: "delete_property", key: PROPERTY_STORE_READY_KEY }]);
    var stored = databaseProperties_(credentials);
    Object.keys(stored).forEach(function (key) { if (isDatabaseOnlyProperty_(key)) delete stored[key]; });
    var current = localSharedProperties_(local);
    Object.keys(current).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) local.deleteProperty(key);
    });
    local.setProperties(stored, false);
    copied = true;
  } catch (error) {
    copied = false;
  }
  local.deleteProperty(PROPERTY_STORE_PROP);
  resetStorageMemos_();
  return copied;
}
