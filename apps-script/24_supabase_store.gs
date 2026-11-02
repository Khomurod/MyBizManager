// ============================================================
// Supabase storage
// ------------------------------------------------------------
// The application was written against Google Sheets, and every module talks
// to its data through the Spreadsheet API: getSheetByName, getDataRange,
// getRange(row, col).setValue, appendRow, deleteRows. This module puts the
// same surface in front of the Supabase Postgres database, so the business
// code -- the ledger rules, the café, the task engine, the queue -- runs
// unchanged against either store.
//
// WHICH STORE
// -----------
// The Script Property OMAD_STORAGE decides, once per request:
//
//   "sheets" (or unset)  the spreadsheet, exactly as before
//   "supabase"           the database at SUPABASE_URL, with SUPABASE_SECRET_KEY
//
// Supabase mode FAILS CLOSED. If it is selected and either credential is
// missing, every request errors instead of quietly writing to the
// spreadsheet. Two stores both accepting money is the one outcome that must
// never happen, because nothing would ever reconcile them.
//
// HOW A SHEET MAPS ON TO A TABLE
// ------------------------------
// Each sheet is a table with the same columns in the same order
// (SUPABASE_SHEETS below). Row 1 is the header, as in the sheet; data row N
// is the N-1th row of the table ordered by `seq`, an identity column that
// records insertion order -- which is exactly what sheet order always was.
//
// A row number is resolved to that row's `seq` when it is read, and every
// later write in the same request goes to that `seq`. So a write lands on the
// row that was read even if somebody else deleted a row above it in the
// meantime, which on the spreadsheet would have shifted it on to a neighbour.
// A write past the last row is an insert; nothing ever writes blank rows.
//
// WHAT THE DATABASE ENFORCES BY ITSELF
// ------------------------------------
// The schema (supabase/migrations) adds the rules the code only promised:
// the ledger refuses DELETE, TRUNCATE and any change to a recorded amount,
// rate, tenant or period; request ids are unique; the audit log is
// append-only. A bug in this module therefore cannot rewrite financial
// history -- the database answers with an error and the request fails.
//
// A café void does not delete the receipt any more: the row is stamped
// `voided_at` and hidden from every read, so the frozen stock consumption it
// carries is never lost.
// ============================================================

var STORAGE_PROP_MODE = "OMAD_STORAGE";
var STORAGE_PROP_SUPABASE_URL = "SUPABASE_URL";
var STORAGE_PROP_SUPABASE_KEY = "SUPABASE_SECRET_KEY";

var STORAGE_MODE_SHEETS = "sheets";
var STORAGE_MODE_SUPABASE = "supabase";

/** PostgREST's default page cap; reads page through anything larger. */
var SUPABASE_PAGE_SIZE = 1000;

/** How many rows one insert request carries. */
var SUPABASE_INSERT_CHUNK = 200;

/** ...and roughly how many characters; a backup snapshot row can be large. */
var SUPABASE_INSERT_MAX_CHARS = 4000000;

/**
 * Every sheet the application uses, as a table.
 *
 * `columns` are `[sheet header, database column, type]`, in the sheet's own
 * column order -- the order the code's header constants already define, which
 * `tests/supabase-store.test.js` asserts.
 *
 * Types say how a cell value crosses the boundary:
 *   text      string; never null
 *   textnull  string, "" stored as NULL (a nullable unique column)
 *   num       number, "" stored as NULL
 *   int       integer, "" stored as NULL
 *   bool      boolean, "TRUE"/"FALSE" accepted, "" stored as NULL
 *   json      jsonb, exchanged with the code as a JSON string
 *   ts        timestamptz, exchanged as an ISO-8601 string
 *   datekey   Asia/Tashkent YYYY-MM-DD wall-clock text
 *   timekey   Asia/Tashkent HH:mm wall-clock text
 *   period    canonical YYYY-MM (a date the sheet made of one is recovered)
 *   datetext  the legacy dd/MM/yyyy display date
 *
 * `def` is what a NOT NULL column receives when the code hands it nothing.
 */
var SUPABASE_SHEETS = {
  System_Config: {
    table: "system_config",
    // The sheet never had a fixed header: getConfig scans every row, the
    // first included, so row 1 is a setting like any other.
    noHeader: true,
    columns: [["Type", "key", "text"], ["Data JSON", "value", "text"]]
  },
  Omad_Transactions_V2: {
    table: "omad_transactions_v2",
    columns: [
      ["ID", "id", "text"], ["Request_ID", "request_id", "text"],
      ["Created_At", "created_at", "ts"], ["Updated_At", "updated_at", "ts"],
      ["Created_By", "created_by", "text"], ["Source", "source", "text"],
      ["Period", "period", "period"], ["Tenant", "tenant", "text"], ["Type", "type", "text"],
      ["Amount", "amount", "num"], ["Currency", "currency", "text"],
      ["Rate_Buy", "rate_buy", "num", 0], ["Rate_Sell", "rate_sell", "num", 0],
      ["Rate_Used", "rate_used", "num", 0], ["Rate_Type", "rate_type", "text"],
      ["Amount_UZS", "amount_uzs", "num"], ["Method", "method", "text"],
      ["Comment", "comment", "text"], ["Status", "status", "text"],
      ["Related_ID", "related_id", "text"], ["Telegram_Msg_ID", "telegram_msg_id", "text"],
      ["Schema_Version", "schema_version", "int", 2], ["Entry_Group_ID", "entry_group_id", "text"],
      ["Entry_Kind", "entry_kind", "text"]
    ]
  },
  Omad_Transactions: {
    table: "omad_transactions",
    columns: [
      ["ID", "id", "text"], ["Tenant", "tenant", "text"], ["Month", "month", "text"],
      ["Type", "type", "text"], ["Amount", "amount", "num"], ["Currency", "currency", "text"],
      ["Method", "method", "text"], ["Date", "date", "datetext"], ["Comment", "comment", "text"],
      ["Telegram_Msg_ID", "telegram_msg_id", "text"], ["Request_ID", "request_id", "text"],
      ["Entry_Group_ID", "entry_group_id", "text"], ["Entry_Kind", "entry_kind", "text"]
    ]
  },
  Cafe_Sales: {
    table: "cafe_sales",
    // A void stamps the row instead of deleting it; voided rows are not part
    // of the sheet the code sees.
    filter: { column: "voided_at", isNull: true },
    softDelete: "voided_at",
    columns: [
      ["Sana", "sold_at", "ts"], ["Sotuvchi", "seller", "text"],
      ["Jami_Tushum", "total", "num", 0], ["Sof_Foyda", "profit", "num", 0],
      ["Chek_Tafsilotlari", "receipt", "json", "[]"], ["ID", "id", "textnull"]
    ]
  },
  Cafe_Kun_Yakuni: {
    table: "cafe_close_days",
    columns: [
      ["Sana", "closed_at", "ts"], ["Sotuvchi", "seller", "text"],
      ["Jami_Tushum", "total_revenue", "num", 0], ["Sof_Foyda", "total_profit", "num", 0],
      ["Tafsilotlar_JSON", "details", "json", "[]"]
    ]
  },
  Cafe_Stock_Movements: {
    table: "cafe_stock_movements",
    columns: [
      ["Sana", "moved_at", "ts"], ["Yo'nalish", "direction", "text"], ["Sabab", "reason", "text"],
      ["Mahsulot_ID", "inventory_id", "text"], ["Nomi", "name", "text"], ["Miqdor", "qty", "num", 0],
      ["Birlik", "unit", "text"], ["Tannarx", "cost", "num", 0], ["Qoldiq", "remaining", "num", 0],
      ["Izoh", "note", "text"], ["Kim", "actor", "text"], ["Request_ID", "request_id", "text"]
    ]
  },
  Tasks: {
    table: "tasks",
    columns: [
      ["ID", "id", "text"], ["Type", "type", "text"], ["Title", "title", "text"],
      ["Description", "description", "text"], ["Responsible", "responsible", "text"],
      ["Priority", "priority", "text"], ["Photo_Required", "photo_required", "bool", false],
      ["Recurrence_JSON", "recurrence", "json", "{}"], ["Reminder_Times_JSON", "reminder_times", "json", "[]"],
      ["Remind_Daily", "remind_daily", "bool", false], ["Due_Time", "due_time", "timekey"],
      ["Deadline_Key", "deadline_key", "datekey"], ["Deadline_Time", "deadline_time", "timekey"],
      ["Start_Key", "start_key", "datekey"], ["End_Key", "end_key", "datekey"],
      ["Status", "status", "text"], ["Steps_JSON", "steps", "json", "[]"],
      ["Created_At", "created_at", "ts"], ["Updated_At", "updated_at", "ts"],
      ["Created_By", "created_by", "text"], ["Meta_JSON", "meta", "json", "{}"]
    ]
  },
  Task_Occurrences: {
    table: "task_occurrences",
    columns: [
      ["ID", "id", "text"], ["Task_ID", "task_id", "text"], ["Task_Type", "task_type", "text"],
      ["Title", "title", "text"], ["Date_Key", "date_key", "datekey"], ["Step_Index", "step_index", "int"],
      ["Due_At", "due_at", "num"], ["Responsible", "responsible", "text"], ["Priority", "priority", "text"],
      ["Photo_Required", "photo_required", "bool", false],
      ["Reminder_Times_JSON", "reminder_times", "json", "[]"], ["Remind_Daily", "remind_daily", "bool", false],
      ["Status", "status", "text"], ["Reminders_Sent_JSON", "reminders_sent", "json", "{}"],
      ["Notified_At", "notified_at", "ts"], ["Telegram_Msg_ID", "telegram_msg_id", "text"],
      ["Completed_By_Id", "completed_by_id", "text"], ["Completed_By_Name", "completed_by_name", "text"],
      ["Completed_At", "completed_at", "ts"], ["On_Time", "on_time", "bool"], ["Late_Ms", "late_ms", "num"],
      ["Proof_File_Id", "proof_file_id", "text"], ["Proof_Msg_Id", "proof_msg_id", "text"],
      ["Proof_Awaiting_User_Id", "proof_awaiting_user_id", "text"],
      ["Created_At", "created_at", "ts"], ["Updated_At", "updated_at", "ts"],
      ["Meta_JSON", "meta", "json", "{}"]
    ]
  },
  Omad_Job_Queue: {
    table: "omad_job_queue",
    columns: [
      ["Job_ID", "job_id", "text"], ["Related_ID", "related_id", "text"], ["Type", "type", "text"],
      ["Payload_JSON", "payload_json", "text"], ["Status", "status", "text"],
      ["Attempts", "attempts", "int", 0], ["Next_Attempt_At", "next_attempt_at", "ts"],
      ["Last_Error", "last_error", "text"], ["Created_At", "created_at", "ts", "now"],
      ["Completed_At", "completed_at", "ts"]
    ]
  },
  Omad_Audit_Log: {
    table: "omad_audit_log",
    columns: [["Timestamp", "logged_at", "ts", "now"], ["Event", "event", "text"], ["Details", "details", "text"]]
  },
  Telegram_Debug_Log: {
    table: "telegram_debug_log",
    filter: { column: "source_sheet", equals: "Telegram_Debug_Log" },
    columns: [["Timestamp", "logged_at", "ts", "now"], ["Event", "event", "text"], ["Details", "details", "text"]]
  },
  Omad_Transaction_Archive: {
    table: "omad_transaction_archive",
    columns: [
      ["Timestamp", "archived_at", "ts", "now"], ["Reason", "reason", "text"],
      ["Transaction_ID", "transaction_id", "text"], ["Transaction_JSON", "transaction_json", "text"]
    ]
  },
  Omad_Backups: {
    table: "omad_backups",
    columns: [["Timestamp", "backed_up_at", "ts", "now"], ["Reason", "reason", "text"], ["Snapshot_JSON", "snapshot_json", "text"]]
  }
};

/** Copies of the debug log made by its secret purge live in the same table. */
var SUPABASE_DEBUG_BACKUP_PREFIX = "Telegram_Debug_Log_Backup_";

/** The definition for a sheet name, including the debug-log backup copies. */
function supabaseSheetDefinition_(name) {
  var key = String(name || "");
  if (Object.prototype.hasOwnProperty.call(SUPABASE_SHEETS, key)) return SUPABASE_SHEETS[key];
  if (key.indexOf(SUPABASE_DEBUG_BACKUP_PREFIX) === 0) {
    return {
      table: "telegram_debug_log",
      filter: { column: "source_sheet", equals: key },
      columns: SUPABASE_SHEETS.Telegram_Debug_Log.columns
    };
  }
  return null;
}

// ---------------------------------------------------------------- the switch

/** "sheets" or "supabase". Anything unrecognised is the spreadsheet. */
function storageMode_() {
  var mode = String(getTelegramSetting_(STORAGE_PROP_MODE) || "").trim().toLowerCase();
  return mode === STORAGE_MODE_SUPABASE ? STORAGE_MODE_SUPABASE : STORAGE_MODE_SHEETS;
}

/** The Supabase project URL and secret key, or an explanation of what is missing. */
function supabaseCredentials_() {
  var url = String(getTelegramSetting_(STORAGE_PROP_SUPABASE_URL) || "").trim().replace(/\/+$/, "");
  var key = String(getTelegramSetting_(STORAGE_PROP_SUPABASE_KEY) || "").trim();
  var missing = [];
  if (!/^https:\/\/[^\s\/]+$/.test(url)) missing.push(STORAGE_PROP_SUPABASE_URL);
  if (!key) missing.push(STORAGE_PROP_SUPABASE_KEY);
  return { url: url, key: key, missing: missing, ok: missing.length === 0 };
}

var APP_DOC_MEMO_ = null;

/**
 * The document every request reads and writes: the spreadsheet, or the
 * Supabase-backed equivalent. Memoised for one request so the row caches are
 * shared by everything that request does.
 */
function appDoc_() {
  if (APP_DOC_MEMO_) return APP_DOC_MEMO_;
  if (storageMode_() === STORAGE_MODE_SUPABASE) {
    var credentials = supabaseCredentials_();
    if (!credentials.ok) {
      // Fail closed: never fall back to the spreadsheet once the database is
      // the store, or two stores would both accept writes.
      throw new Error("OMAD_STORAGE=supabase, lekin Script Properties'da yo'q: " +
        credentials.missing.join(", "));
    }
    APP_DOC_MEMO_ = supabaseDoc_(credentials);
  } else {
    APP_DOC_MEMO_ = SpreadsheetApp.getActiveSpreadsheet();
  }
  return APP_DOC_MEMO_;
}

function resetStorageMemos_() {
  APP_DOC_MEMO_ = null;
}

// ------------------------------------------------------------- HTTP client

/** Query-string value, URL encoded. */
function supabaseQuery_(params) {
  var parts = [];
  for (var i = 0; i < params.length; i++) {
    parts.push(params[i][0] + "=" + encodeURIComponent(String(params[i][1])));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

/** A response header, whatever case the server used. */
function supabaseHeader_(response, name) {
  var headers = {};
  try { headers = response.getHeaders() || {}; } catch (error) { headers = {}; }
  var wanted = name.toLowerCase();
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) return headers[key];
  }
  return "";
}

/**
 * One PostgREST call. Throws on anything but a 2xx, with the server's own
 * message (which never contains the key) so a refused write is loud.
 */
function supabaseRequest_(credentials, method, table, params, body, prefer) {
  var headers = { apikey: credentials.key, Accept: "application/json" };
  // A legacy service_role key is a JWT and goes in Authorization as well; a
  // new-style secret key (sb_secret_...) is accepted in `apikey` alone.
  if (/^eyJ/.test(credentials.key)) headers.Authorization = "Bearer " + credentials.key;
  if (prefer) headers.Prefer = prefer;

  var options = { method: method, headers: headers, muteHttpExceptions: true };
  if (body !== undefined && body !== null) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }

  var url = credentials.url + "/rest/v1/" + table + supabaseQuery_(params || []);
  var response;
  try {
    response = UrlFetchApp.fetch(url, options);
  } catch (transportError) {
    throw new Error("Supabase bilan aloqa yo'q (" + table + "): " + redactSecrets_(transportError));
  }

  var code = response.getResponseCode();
  var text = response.getContentText() || "";
  if (code < 200 || code >= 300) {
    var parsed = safeParseJSON_(text, null);
    var reason = parsed && (parsed.message || parsed.hint || parsed.details)
      ? [parsed.message, parsed.details, parsed.hint].filter(function (p) { return p; }).join(" — ")
      : text;
    throw new Error("Supabase " + method.toUpperCase() + " " + table + " rad etildi (HTTP " + code + "): " +
      redactSecrets_(reason).slice(0, 500));
  }
  return { code: code, text: text, response: response, json: text ? safeParseJSON_(text, null) : null };
}

/** The total behind a `Prefer: count=exact` answer ("0-9/42" or "*\/0"). */
function supabaseCountFrom_(result) {
  var range = String(supabaseHeader_(result.response, "Content-Range") || "");
  var total = Number(range.split("/")[1]);
  if (!isFinite(total)) throw new Error("Supabase hisob javobi tushunarsiz: " + range);
  return total;
}

// -------------------------------------------------------- value conversion

/** A cell value as the database column wants it. */
function supabaseToDb_(type, value, def) {
  var empty = value === null || value === undefined || value === "";
  var out;

  if (type === "num" || type === "int") {
    if (empty) out = null;
    else {
      var number = Number(value);
      if (!isFinite(number)) throw new Error("Raqam emas: " + String(value).slice(0, 60));
      out = type === "int" ? Math.round(number) : number;
    }
  } else if (type === "bool") {
    out = empty ? null : (value === true || value === 1 || value === "1" ||
      String(value).toUpperCase() === "TRUE");
  } else if (type === "json") {
    if (empty) out = null;
    else if (typeof value === "string") {
      try { out = JSON.parse(value); } catch (error) { out = value; }
    } else out = value;
  } else if (type === "ts") {
    if (empty) out = null;
    else {
      var instant = value instanceof Date ? value : new Date(String(value));
      if (isNaN(instant.getTime())) throw new Error("Sana noto'g'ri: " + String(value).slice(0, 60));
      out = instant.toISOString();
    }
  } else if (type === "datekey") {
    out = empty ? "" : taskDateKeyFromCell_(value);
    if (!empty && !out) throw new Error("Sana kaliti noto'g'ri: " + String(value).slice(0, 60));
  } else if (type === "timekey") {
    out = empty ? "" : taskTimeKeyFromCell_(value);
    if (!empty && !out) throw new Error("Vaqt noto'g'ri: " + String(value).slice(0, 60));
  } else if (type === "period") {
    out = empty ? "" : normalizeMonthValue_(value);
  } else if (type === "datetext") {
    if (value instanceof Date) {
      out = isNaN(value.getTime()) ? "" : Utilities.formatDate(value, Session.getScriptTimeZone(), "dd/MM/yyyy");
    } else out = empty ? "" : String(value);
  } else if (type === "textnull") {
    out = empty ? null : String(value);
  } else {
    out = empty ? "" : (value instanceof Date ? value.toISOString() : String(value));
  }

  if (out === null && def !== undefined) {
    if (def === "now") return new Date().toISOString();
    return type === "json" ? JSON.parse(def) : def;
  }
  return out;
}

/** A database value as the cell the code has always read. */
function supabaseFromDb_(type, value) {
  if (value === null || value === undefined) return "";
  if (type === "num" || type === "int") return Number(value);
  if (type === "bool") return value === true;
  if (type === "json") return typeof value === "string" ? value : JSON.stringify(value);
  if (type === "ts") {
    var instant = new Date(String(value));
    return isNaN(instant.getTime()) ? String(value) : instant.toISOString();
  }
  return String(value);
}

// ------------------------------------------------------------ the document

/** The Supabase-backed stand-in for the active spreadsheet. */
function supabaseDoc_(credentials) {
  var sheets = {};
  var doc = {
    __supabase: true,
    credentials: credentials,
    getSheetByName: function (name) {
      var definition = supabaseSheetDefinition_(name);
      if (!definition) return null;
      if (!sheets[name]) sheets[name] = supabaseSheet_(credentials, name, definition);
      return sheets[name];
    },
    insertSheet: function (name) {
      var sheet = doc.getSheetByName(name);
      if (!sheet) throw new Error("Supabase rejimida yangi varaq yaratilmaydi: " + name);
      return sheet;
    },
    getSheets: function () {
      var list = [];
      Object.keys(SUPABASE_SHEETS).forEach(function (name) { list.push(doc.getSheetByName(name)); });
      // The purge's backup copies are rows of the debug-log table, named by
      // the sheet they came from.
      var names = supabaseDebugBackupNames_(credentials);
      for (var i = 0; i < names.length; i++) list.push(doc.getSheetByName(names[i]));
      return list;
    }
  };
  return doc;
}

/** Every distinct backup-sheet name stored in the debug-log table. */
function supabaseDebugBackupNames_(credentials) {
  var seen = {};
  var names = [];
  var last = 0;
  while (true) {
    var page = supabaseRequest_(credentials, "get", "telegram_debug_log", [
      ["select", "seq,source_sheet"], ["source_sheet", "neq.Telegram_Debug_Log"],
      ["seq", "gt." + last], ["order", "seq.asc"], ["limit", SUPABASE_PAGE_SIZE]
    ]).json || [];
    for (var i = 0; i < page.length; i++) {
      last = page[i].seq;
      var name = String(page[i].source_sheet || "");
      if (name && !seen[name]) { seen[name] = true; names.push(name); }
    }
    if (page.length < SUPABASE_PAGE_SIZE) break;
  }
  return names.sort();
}

// --------------------------------------------------------------- the sheet

/**
 * One table, behaving like the sheet it replaced.
 *
 * `seqs[i]` is the `seq` of data row i (sheet row i + 2), filled in as rows
 * are read. `count` is the number of data rows as last observed, or -1.
 */
function supabaseSheet_(credentials, name, definition) {
  var columns = definition.columns;
  var header = columns.map(function (c) { return c[0]; });
  var state = { seqs: [], count: -1 };
  // Sheet rows above the data: the header, or none.
  var headerRows = definition.noHeader ? 0 : 1;
  var firstDataRow = headerRows + 1;

  var baseFilters = function () {
    var f = definition.filter;
    if (!f) return [];
    if (f.isNull) return [[f.column, "is.null"]];
    return [[f.column, "eq." + f.equals]];
  };

  var selectList = function (fromCol, toCol) {
    var names = ["seq"];
    for (var c = fromCol; c <= toCol; c++) names.push(columns[c][1]);
    return names.join(",");
  };

  var toCells = function (record, fromCol, toCol) {
    var row = [];
    for (var c = fromCol; c <= toCol; c++) row.push(supabaseFromDb_(columns[c][2], record[columns[c][1]]));
    return row;
  };

  var request = function (method, params, body, prefer) {
    return supabaseRequest_(credentials, method, definition.table, params, body, prefer);
  };

  /** Data rows [offset, offset + limit) in sheet order, with their seqs. */
  var readRows = function (offset, limit, fromCol, toCol) {
    var records = [];
    var done = 0;
    while (done < limit) {
      var take = Math.min(SUPABASE_PAGE_SIZE, limit - done);
      var page = request("get", baseFilters().concat([
        ["select", selectList(fromCol, toCol)], ["order", "seq.asc"],
        ["offset", offset + done], ["limit", take]
      ])).json || [];
      for (var i = 0; i < page.length; i++) {
        state.seqs[offset + done + i] = page[i].seq;
        records.push(page[i]);
      }
      done += page.length;
      if (page.length < take) break;
    }
    return records;
  };

  /** Every data row, paged by seq so a large table is read whole. */
  var readAll = function () {
    var records = [];
    var last = 0;
    while (true) {
      var page = request("get", baseFilters().concat([
        ["select", selectList(0, columns.length - 1)], ["seq", "gt." + last],
        ["order", "seq.asc"], ["limit", SUPABASE_PAGE_SIZE]
      ])).json || [];
      for (var i = 0; i < page.length; i++) records.push(page[i]);
      if (page.length < SUPABASE_PAGE_SIZE) break;
      last = page[page.length - 1].seq;
    }
    state.seqs = records.map(function (r) { return r.seq; });
    state.count = records.length;
    return records;
  };

  var dataCount = function () {
    if (state.count >= 0) return state.count;
    var result = request("get", baseFilters().concat([["select", "seq"], ["limit", 1]]), null, "count=exact");
    state.count = supabaseCountFrom_(result);
    return state.count;
  };

  /** The seq of every data row in [offset, offset + n), resolving gaps. */
  var seqsFor = function (offset, n) {
    var missing = false;
    for (var i = 0; i < n; i++) if (state.seqs[offset + i] === undefined) missing = true;
    if (missing) readRows(offset, n, 0, 0);
    var out = [];
    for (var j = 0; j < n; j++) {
      var seq = state.seqs[offset + j];
      if (seq === undefined) throw new Error(name + ": " + (offset + j + 2) + "-qator topilmadi.");
      out.push(seq);
    }
    return out;
  };

  /** A full or partial row of cells as a database record. */
  var toRecord = function (cells, fromCol) {
    var record = {};
    for (var j = 0; j < cells.length; j++) {
      var column = columns[fromCol + j];
      if (!column) continue;
      record[column[1]] = supabaseToDb_(column[2], cells[j], column[3]);
    }
    return record;
  };

  /** Rows grouped so no request carries too many rows or too many bytes. */
  var chunked = function (records) {
    var chunks = [];
    var current = [];
    var size = 0;
    for (var i = 0; i < records.length; i++) {
      var length = JSON.stringify(records[i]).length;
      if (current.length && (current.length >= SUPABASE_INSERT_CHUNK || size + length > SUPABASE_INSERT_MAX_CHARS)) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(records[i]);
      size += length;
    }
    if (current.length) chunks.push(current);
    return chunks;
  };

  var insertRecords = function (records) {
    var f = definition.filter;
    var chunks = chunked(records);
    for (var n = 0; n < chunks.length; n++) {
      var chunk = chunks[n];
      for (var i = 0; i < chunk.length; i++) {
        // NOT NULL columns the caller left out get their default.
        for (var c = 0; c < columns.length; c++) {
          if (Object.prototype.hasOwnProperty.call(chunk[i], columns[c][1])) continue;
          if (columns[c][3] !== undefined) chunk[i][columns[c][1]] = supabaseToDb_(columns[c][2], "", columns[c][3]);
        }
        if (f && f.equals !== undefined) chunk[i][f.column] = f.equals;
      }
      // Positions are tracked only when the row count is already known; an
      // append that has not looked at the table costs one request, not two.
      var base = state.count;
      var inserted = request("post", [["select", "seq"]], chunk, "return=representation").json || [];
      if (inserted.length !== chunk.length) {
        throw new Error(name + ": " + chunk.length + " qatordan " + inserted.length + " tasi yozildi.");
      }
      if (base >= 0) {
        for (var k = 0; k < inserted.length; k++) state.seqs[base + k] = inserted[k].seq;
        state.count = base + inserted.length;
      }
    }
  };

  var updateRecord = function (seq, record) {
    var updated = request("patch", [["seq", "eq." + seq], ["select", "seq"]], record, "return=representation").json || [];
    if (updated.length !== 1) throw new Error(name + ": yangilanadigan qator topilmadi (seq " + seq + ").");
  };

  /** Writes a block of cells starting at sheet row `row`, column `col`. */
  var writeBlock = function (row, col, values) {
    var fromCol = col - 1;
    var inserts = [];
    for (var i = 0; i < values.length; i++) {
      var sheetRow = row + i;
      if (sheetRow < firstDataRow) continue;            // the header is the schema's
      var position = sheetRow - firstDataRow;
      var record = toRecord(values[i], fromCol);
      // A row this request has read is written by its identity, wherever it
      // sits now; if it has gone, the update finds nothing and says so.
      var known = state.seqs[position];
      if (known !== undefined) updateRecord(known, record);
      else if (position < dataCount()) updateRecord(seqsFor(position, 1)[0], record);
      else inserts.push(record);
    }
    if (inserts.length) insertRecords(inserts);
  };

  var removeRows = function (row, howMany) {
    // Row 1 is the header -- the schema's, never deleted. Clearing a sheet
    // from row 1 clears its data rows.
    if (row < firstDataRow) { howMany -= firstDataRow - row; row = firstDataRow; }
    var position = row - firstDataRow;
    if (howMany < 1) return;
    var targets = seqsFor(position, howMany);
    var list = "in.(" + targets.join(",") + ")";
    var changed;
    if (definition.softDelete) {
      var stamp = {};
      stamp[definition.softDelete] = new Date().toISOString();
      changed = request("patch", [["seq", list], ["select", "seq"]], stamp, "return=representation").json || [];
    } else {
      changed = request("delete", [["seq", list], ["select", "seq"]], null, "return=representation").json || [];
    }
    if (changed.length !== targets.length) {
      throw new Error(name + ": " + targets.length + " qatordan " + changed.length + " tasi o'chirildi.");
    }
    // Every position below has shifted; the next access re-reads.
    state.seqs = [];
    state.count = -1;
  };

  var range = function (row, col, numRows, numCols) {
    var rowCount = numRows === undefined ? 1 : numRows;
    var colCount = numCols === undefined ? 1 : numCols;
    var fromCol = col - 1;
    var toCol = Math.min(columns.length, fromCol + colCount) - 1;

    var blankRow = function () {
      var r = [];
      for (var c = 0; c < colCount; c++) r.push("");
      return r;
    };

    return {
      getValues: function () {
        var out = [];
        var firstData = row;
        if (row === 1 && headerRows === 1) {
          var h = blankRow();
          for (var c = 0; c < colCount; c++) if (header[fromCol + c] !== undefined) h[c] = header[fromCol + c];
          out.push(h);
          firstData = 2;
        }
        var wanted = row + rowCount - firstData;
        if (wanted > 0 && fromCol <= toCol) {
          var records = readRows(firstData - firstDataRow, wanted, fromCol, toCol);
          for (var i = 0; i < wanted; i++) {
            var cells = blankRow();
            if (records[i]) {
              var values = toCells(records[i], fromCol, toCol);
              for (var v = 0; v < values.length; v++) cells[v] = values[v];
            }
            out.push(cells);
          }
        } else {
          for (var b = 0; b < wanted; b++) out.push(blankRow());
        }
        return out;
      },
      setValues: function (values) { writeBlock(row, col, values); },
      setValue: function (value) { writeBlock(row, col, [[value]]); },
      // Postgres columns are typed; there is nothing for a number format to protect.
      setNumberFormat: function () { return this; },
      clearContent: function () {
        if (fromCol === 0 && toCol >= columns.length - 1) {
          removeRows(row, rowCount);
          return;
        }
        var blanks = [];
        for (var i = 0; i < rowCount; i++) blanks.push(blankRow());
        writeBlock(row, col, blanks);
      }
    };
  };

  var sheet = {
    __supabaseTable: definition.table,
    getName: function () { return name; },
    getLastRow: function () { return dataCount() + headerRows; },
    getDataRange: function () {
      return {
        getValues: function () {
          var records = readAll();
          var out = headerRows ? [header.slice()] : [];
          for (var i = 0; i < records.length; i++) out.push(toCells(records[i], 0, columns.length - 1));
          return out;
        }
      };
    },
    getRange: range,
    appendRow: function (cells) {
      // Code written for a sheet re-stamps the header after clearing one. The
      // header is the table's own schema, so that append is not a row.
      if (cells && cells.length === header.length &&
          cells.every(function (cell, i) { return cell === header[i]; })) return;
      insertRecords([toRecord(cells, 0)]);
    },
    deleteRow: function (row) { removeRows(row, 1); },
    deleteRows: function (row, howMany) { removeRows(row, howMany); },

    // ----- System_Config by key, without reading the whole table -----------
    getConfigValue: function (key) {
      var found = request("get", [["select", "value"], ["key", "eq." + key], ["limit", 1]]).json || [];
      return found.length ? (found[0].value === null ? "" : found[0].value) : null;
    },
    setConfigValue: function (key, value) {
      request("post", [["on_conflict", "key"]],
        [{ key: String(key), value: value === null || value === undefined ? null : String(value),
           updated_at: new Date().toISOString() }],
        "resolution=merge-duplicates,return=minimal");
    }
  };

  // Read-only snapshot of the rows, for tests that inspect a sheet's `data`.
  Object.defineProperty(sheet, "data", {
    get: function () { return sheet.getDataRange().getValues(); }
  });

  return sheet;
}

// ---------------------------------------------------------------- health

/** Which store answers, and whether it answers at all. Never a secret. */
function storageStatus_() {
  var mode = storageMode_();
  var credentials = supabaseCredentials_();
  var status = {
    mode: mode,
    supabaseConfigured: credentials.ok,
    supabaseHost: credentials.ok ? credentials.url.replace(/^https:\/\//, "") : "",
    reachable: null,
    message: ""
  };
  if (!credentials.ok) {
    status.message = mode === STORAGE_MODE_SUPABASE
      ? "Yo'q: " + credentials.missing.join(", ")
      : "Supabase sozlanmagan";
    return status;
  }
  try {
    supabaseRequest_(credentials, "get", "system_config", [["select", "key"], ["limit", 1]]);
    status.reachable = true;
  } catch (error) {
    status.reachable = false;
    status.message = redactSecrets_(error).slice(0, 300);
  }
  return status;
}
