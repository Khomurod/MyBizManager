// ============================================================
// Daily copy of the database into Google Drive
// ------------------------------------------------------------
// Supabase's free plan keeps no backup the owner can download. So once a day
// Apps Script copies the business tables into a Google spreadsheet in the
// owner's Drive:
// one tab per table, in exactly the layout of the original "Budgeting app"
// sheets -- the same tab names, columns and values the storage layer itself
// reads (appDoc_().getSheetByName(...).getDataRange().getValues()). That is
// the layout the Supabase import (25_supabase_import.gs) already reads, so a
// restore needs no new code: copy the tabs into the bound spreadsheet and run
// the import (docs/DEPLOYMENT.md).
//
// Every cell keeps its value: text is written as plain text, so "2026-08" or
// "05/08/2026" stays text instead of becoming a date the way typed text does.
//
// What starts it: pg_cron in the database at 03:00 Tashkent calls the Edge
// function (`?job=db-backup`, behind its cron secret), which asks this script
// with `run_database_backup` and that same secret -- the live manifest lacks
// the scope to create a trigger from code. The Tizim panel's button runs one
// at any time, and backupDatabaseToDrive() can be given an editor trigger.
//
// Rotation with no Drive permission beyond what the script already has (it
// creates and opens spreadsheets, never deletes a file): seven spreadsheets,
// one per weekday, and twelve, one per month (written on the 1st), each
// overwritten in turn. Their ids are kept in DB_BACKUP_FILES; one the owner
// deleted is created again.
//
// Not copied:
//   - the settings (app_properties): Apps Script keeps its own copy of every
//     one in Script Properties, and the bot token, the session secret and the
//     password hashes do not belong in a spreadsheet;
//   - Omad_Backups (snapshots of the other tables, and too large for a cell)
//     and the Telegram debug logs (diagnostics, not records);
//   - the lock and cache tables, which hold nothing lasting.
// ============================================================

var DB_BACKUP_FILES_PROP = "DB_BACKUP_FILES";
var DB_BACKUP_STATUS_PROP = "DB_BACKUP_STATUS";
var DB_BACKUP_SKIP = { Omad_Backups: true, Telegram_Debug_Log: true };
var DB_BACKUP_INFO_SHEET = "Zaxira";
var DB_BACKUP_TITLE = "MyBizManager zaxira";
var DB_BACKUP_WEEKDAYS = ["7-yakshanba", "1-dushanba", "2-seshanba", "3-chorshanba", "4-payshanba", "5-juma", "6-shanba"];
/** A day without a backup is a warning; two are an error. */
var DB_BACKUP_STALE_MS = 36 * 3600 * 1000;
var DB_BACKUP_LOST_MS = 60 * 3600 * 1000;

function isDatabaseBackupAction_(action) {
  return action === "run_database_backup";
}

/** For an editor-made time-driven trigger, or a run from the editor. */
function backupDatabaseToDrive() {
  resetRequestMemos_();
  return runDatabaseBackup_(new Date());
}

/**
 * Whether this request is the nightly run: it carries the Edge function's
 * cron secret (EDGE_CRON_SECRET, a row only app_properties holds). Compared in
 * constant time; a short or missing secret never matches.
 */
function isDatabaseBackupCron_(payload) {
  var given = String((payload && payload.cronSecret) || "");
  if (given.length < 16) return false;
  var expected = edgeCronSecret_();
  if (expected.length < 16 || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * EDGE_CRON_SECRET. Once the settings are in the database it is read like any
 * other; before that move it is read from app_properties directly, so the
 * nightly copy runs as soon as the data is on Supabase, whether or not the
 * settings have followed.
 */
function edgeCronSecret_() {
  if (sharedPropertiesInDatabase_(PropertiesService.getScriptProperties())) {
    return String(getTelegramSetting_("EDGE_CRON_SECRET") || "");
  }
  if (storageMode_() !== STORAGE_MODE_SUPABASE) return "";
  var credentials = supabaseCredentials_();
  if (!credentials.ok) return "";
  try {
    return String(databaseProperties_(credentials).EDGE_CRON_SECRET || "");
  } catch (error) {
    return "";
  }
}

/** The slots `now` writes: its weekday, and its month on the 1st (Tashkent dates). */
function databaseBackupSlots_(now) {
  var parts = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd").split("-");
  var weekday = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
  var slots = ["kun " + DB_BACKUP_WEEKDAYS[weekday]];
  if (parts[2] === "01") slots.push("oy " + parts[1]);
  return slots;
}

/** Copies the tables into each slot's spreadsheet and records how it went. */
function runDatabaseBackup_(now) {
  var status = { at: now.toISOString(), slots: [], tables: 0, rows: 0, failed: [] };
  if (storageMode_() !== STORAGE_MODE_SUPABASE) {
    return { status: "skipped", message: "Ma'lumotlar hali Google Sheets'da: zaxira shart emas." };
  }
  try {
    var snapshot = databaseBackupSnapshot_();
    var files = safeParseJSON_(getTelegramSetting_(DB_BACKUP_FILES_PROP) || "{}", {}) || {};
    var slots = databaseBackupSlots_(now);
    for (var i = 0; i < slots.length; i++) {
      var written = writeDatabaseBackup_(slots[i], files[slots[i]], snapshot, now);
      files[slots[i]] = written.id;
      status.slots.push(slots[i]);
      status.failed = status.failed.concat(written.failed);
    }
    setTelegramSetting_(DB_BACKUP_FILES_PROP, JSON.stringify(files));
    status.tables = snapshot.length;
    for (var t = 0; t < snapshot.length; t++) status.rows += snapshot[t].rows;
  } catch (error) {
    status.error = redactSecrets_(error).slice(0, 300);
  }
  setTelegramSetting_(DB_BACKUP_STATUS_PROP, JSON.stringify(status));
  if (status.error) return { status: "error", message: "Zaxira yozilmadi: " + status.error, backup: status };
  if (status.failed.length) {
    return { status: "error", message: "Zaxira qisman yozildi, yozilmagan: " + status.failed.join(", "), backup: status };
  }
  return { status: "success", backup: status };
}

/** Every table to copy, read once: [{ name, values, rows }]. */
function databaseBackupSnapshot_() {
  var doc = appDoc_();
  var out = [];
  Object.keys(SUPABASE_SHEETS).forEach(function (name) {
    if (DB_BACKUP_SKIP[name]) return;
    var values = doc.getSheetByName(name).getDataRange().getValues();
    var header = SUPABASE_SHEETS[name].noHeader ? 0 : 1;
    out.push({ name: name, values: values, rows: Math.max(values.length - header, 0) });
  });
  return out;
}

function openOrCreateBackup_(slot, id) {
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (error) {
      // Deleted or no longer ours: made again below.
    }
  }
  return SpreadsheetApp.create(DB_BACKUP_TITLE + " — " + slot);
}

/** Overwrites one slot's spreadsheet with the snapshot. */
function writeDatabaseBackup_(slot, id, snapshot, now) {
  var file = openOrCreateBackup_(slot, id);
  var keep = {};
  var failed = [];

  var info = [["MyBizManager — ma'lumotlar bazasi zaxirasi", ""], ["Yozilgan", now.toISOString()], ["Jadval", "Qatorlar"]];
  for (var i = 0; i < snapshot.length; i++) info.push([snapshot[i].name, snapshot[i].rows]);
  writeBackupSheet_(file, DB_BACKUP_INFO_SHEET, info);
  keep[DB_BACKUP_INFO_SHEET] = true;

  for (var t = 0; t < snapshot.length; t++) {
    keep[snapshot[t].name] = true;
    try {
      writeBackupSheet_(file, snapshot[t].name, snapshot[t].values);
    } catch (error) {
      failed.push(snapshot[t].name);
    }
  }

  // The new spreadsheet's own first tab, and a table no longer copied.
  var sheets = file.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    if (!keep[sheets[s].getName()]) file.deleteSheet(sheets[s]);
  }
  return { id: file.getId(), failed: failed };
}

/** One tab, cleared and written in a single call, every text cell as plain text. */
function writeBackupSheet_(file, name, values) {
  var sheet = file.getSheetByName(name) || file.insertSheet(name);
  sheet.clearContents();
  if (!values.length) return;
  var width = 1;
  for (var r = 0; r < values.length; r++) width = Math.max(width, values[r].length);
  var cells = [];
  var formats = [];
  for (var i = 0; i < values.length; i++) {
    var row = [];
    var rowFormats = [];
    for (var j = 0; j < width; j++) {
      var value = j < values[i].length ? values[i][j] : "";
      if (value === null || value === undefined) value = "";
      row.push(value);
      rowFormats.push(typeof value === "string" ? "@" : value instanceof Date ? "yyyy-mm-dd hh:mm:ss" : "0.###############");
    }
    cells.push(row);
    formats.push(rowFormats);
  }
  if (sheet.getMaxRows() < cells.length) sheet.insertRowsAfter(sheet.getMaxRows(), cells.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  var range = sheet.getRange(1, 1, cells.length, width);
  range.setNumberFormats(formats);
  range.setValues(cells);
}

/** For the health check: when the last copy was written, and whether it all was. */
function databaseBackupCheck_() {
  if (storageMode_() !== STORAGE_MODE_SUPABASE) {
    return check_("backup", "Kunlik zaxira", HEALTH_OK, "Google Sheets'da — shart emas");
  }
  var status = safeParseJSON_(getTelegramSetting_(DB_BACKUP_STATUS_PROP) || "", null);
  if (!status || !status.at) {
    return check_("backup", "Kunlik zaxira", HEALTH_WARN, "Hali yozilmagan — 'Zaxira' tugmasini bosing");
  }
  if (status.error || (status.failed && status.failed.length)) {
    return check_("backup", "Kunlik zaxira", HEALTH_ERROR, "Oxirgisi yozilmadi");
  }
  var age = Date.now() - new Date(status.at).getTime();
  if (!(age < DB_BACKUP_LOST_MS)) return check_("backup", "Kunlik zaxira", HEALTH_ERROR, "Ikki kundan beri yozilmagan");
  if (!(age < DB_BACKUP_STALE_MS)) return check_("backup", "Kunlik zaxira", HEALTH_WARN, "Bir kundan beri yozilmagan");
  return check_("backup", "Kunlik zaxira", HEALTH_OK, status.tables + " jadval, " + status.rows + " qator");
}
