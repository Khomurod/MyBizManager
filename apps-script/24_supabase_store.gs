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
 *
 * `wholeReads`: the code reads this table whole on almost every visit, so any
 * read of it in a request is served from one whole read kept for the request.
 * `readWith`: tables read together; reading one fetches the others alongside
 * it, in parallel.
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
    wholeReads: true,
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
    wholeReads: true,
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
    wholeReads: true,
    readWith: ["Task_Occurrences"],
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
    wholeReads: true,
    readWith: ["Tasks"],
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
    wholeReads: true,
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

/**
 * While the move copies the data, OMAD_STORAGE holds "moving:<millis>:<token>"
 * and every other request is turned away: a write made to the spreadsheet
 * during the copy would exist in neither store's future. An execution killed
 * mid-move (Apps Script's time limit is six minutes) cannot leave the app shut:
 * a marker older than this is read as the spreadsheet.
 */
var STORAGE_MODE_MOVING = "moving";
/** True only inside the execution running the move (25_supabase_import.gs). */
var STORAGE_MOVE_IN_THIS_EXECUTION_ = false;
var STORAGE_MOVING_MAX_MS = 10 * 60 * 1000;

/** "sheets", "supabase" or "moving". Anything unrecognised is the spreadsheet. */
function storageMode_() {
  var mode = String(getTelegramSetting_(STORAGE_PROP_MODE) || "").trim().toLowerCase();
  if (mode === STORAGE_MODE_SUPABASE) return STORAGE_MODE_SUPABASE;
  if (mode.indexOf(STORAGE_MODE_MOVING + ":") === 0) {
    var started = Number(mode.split(":")[1]);
    if (isFinite(started) && Date.now() - started < STORAGE_MOVING_MAX_MS) return STORAGE_MODE_MOVING;
  }
  return STORAGE_MODE_SHEETS;
}

/** The store a document belongs to. */
function storageModeOfDoc_(doc) {
  return doc && doc.__supabase ? STORAGE_MODE_SUPABASE : STORAGE_MODE_SHEETS;
}

/**
 * Refuses to go on if the store changed after this request chose its own.
 *
 * A request picks its store when it starts (appDoc_). If the move or a
 * rollback switched stores while it waited for the script lock, everything it
 * writes from here would land in the store nobody reads any more -- a payment
 * reported as saved and then never seen. Nothing has been written yet when the
 * lock is taken, so the honest answer is "try again".
 */
function assertStoreUnchanged_() {
  if (!APP_DOC_MEMO_ || STORAGE_MOVE_IN_THIS_EXECUTION_) return;
  if (storageModeOfDoc_(APP_DOC_MEMO_) === storageMode_()) return;
  throw new Error("Ma'lumotlar bazasi hozirgina almashtirildi. Hech narsa saqlanmadi — iltimos, qayta urinib ko'ring.");
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
  var mode = storageMode_();
  if (mode === STORAGE_MODE_MOVING) {
    // The move itself still works from the spreadsheet; everyone else waits.
    if (!STORAGE_MOVE_IN_THIS_EXECUTION_) {
      throw new Error("Ma'lumotlar Supabase'ga ko'chirilmoqda. Bir daqiqadan keyin qayta urinib ko'ring.");
    }
    mode = STORAGE_MODE_SHEETS;
  }
  if (mode === STORAGE_MODE_SUPABASE) {
    var credentials = supabaseCredentials_();
    if (!credentials.ok) {
      // Fail closed: never fall back to the spreadsheet once the database is
      // the store, or two stores would both accept writes.
      throw new Error("OMAD_STORAGE=supabase, lekin Script Properties'da yo'q: " +
        credentials.missing.join(", "));
    }
    APP_DOC_MEMO_ = supabaseDoc_(credentials, { request: true });
  } else {
    APP_DOC_MEMO_ = SpreadsheetApp.getActiveSpreadsheet();
  }
  return APP_DOC_MEMO_;
}

function resetStorageMemos_() {
  // Kept writes are never dropped by starting over.
  flushPendingWrites_();
  STORAGE_DEFERRED_BUMPS_ = {};
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

/** The URL and UrlFetchApp options for one PostgREST call. */
function supabaseFetchSpec_(credentials, method, path, params, body, prefer) {
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
  return { url: credentials.url + "/rest/v1/" + path + supabaseQuery_(params || []), options: options };
}

/**
 * A PostgREST answer, or an error carrying the server's own message (which
 * never contains the key) so a refused write is loud.
 */
function supabaseResult_(method, path, response) {
  var code = response.getResponseCode();
  var text = response.getContentText() || "";
  if (code < 200 || code >= 300) {
    var parsed = safeParseJSON_(text, null);
    var reason = parsed && (parsed.message || parsed.hint || parsed.details)
      ? [parsed.message, parsed.details, parsed.hint].filter(function (p) { return p; }).join(" — ")
      : text;
    var error = new Error("Supabase " + method.toUpperCase() + " " + path + " rad etildi (HTTP " + code + "): " +
      redactSecrets_(reason).slice(0, 500));
    error.httpCode = code;
    return error;
  }
  return { code: code, text: text, response: response, json: text ? safeParseJSON_(text, null) : null };
}

/** One PostgREST call. Throws on anything but a 2xx. */
function supabaseRequest_(credentials, method, path, params, body, prefer) {
  var spec = supabaseFetchSpec_(credentials, method, path, params, body, prefer);
  var response;
  try {
    response = UrlFetchApp.fetch(spec.url, spec.options);
  } catch (transportError) {
    throw new Error("Supabase bilan aloqa yo'q (" + path + "): " + redactSecrets_(transportError));
  }
  var result = supabaseResult_(method, path, response);
  if (result instanceof Error) throw result;
  return result;
}

/**
 * Several independent PostgREST calls sent together: one round trip instead
 * of one per call. Each answer is a result or an Error -- the caller decides
 * which failures matter.
 *
 * calls: [{ method, path, params, body, prefer }]
 */
function supabaseRequestAll_(credentials, calls) {
  if (calls.length === 1) {
    var only = calls[0];
    try {
      return [supabaseRequest_(credentials, only.method, only.path, only.params, only.body, only.prefer)];
    } catch (error) {
      return [error];
    }
  }
  var requests = calls.map(function (call) {
    var spec = supabaseFetchSpec_(credentials, call.method, call.path, call.params, call.body, call.prefer);
    var request = { url: spec.url };
    for (var key in spec.options) {
      if (Object.prototype.hasOwnProperty.call(spec.options, key)) request[key] = spec.options[key];
    }
    return request;
  });
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (transportError) {
    throw new Error("Supabase bilan aloqa yo'q: " + redactSecrets_(transportError));
  }
  return responses.map(function (response, i) {
    return supabaseResult_(calls[i].method, calls[i].path, response);
  });
}

/** A database function the migrations define (supabase/migrations). */
function supabaseRpc_(credentials, name, args) {
  return supabaseRequest_(credentials, "post", "rpc/" + name, [], args || {});
}

/** True for "this database has no such function": the migration is not applied yet. */
function isMissingSupabaseFunction_(error) {
  return !!error && (error.httpCode === 404 || /PGRST202|Could not find the function/.test(String(error.message || error)));
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

// ------------------------------------------------- batching and the lock
//
// ONE ROUND TRIP PER BUSINESS ACTION
// ----------------------------------
// On the spreadsheet a write is a call into the same Google data centre; on
// Supabase it is an HTTPS round trip. A business action -- a payment, a
// correction, a sale -- writes several rows (the ledger, the audit log, a
// setting, a queued report), so sending each write on its own made writing
// slower than it was on Sheets.
//
// Every write the request's own document makes while the script lock is held
// (and inside withBatchedWrites_) is therefore kept, and sent as ONE call to
// the database function mbm_apply when the lock is released. That call is one
// transaction: either the whole action lands or none of it does, which the
// spreadsheet could never promise.
//
// What keeps this exactly as correct as writing immediately:
//   - a read of a table with unsent writes sends them first, so nothing ever
//     reads around its own write;
//   - everything is sent before any message leaves for Telegram, so a message
//     never describes a row that is not stored yet;
//   - everything is sent before the lock is released (and when it is taken),
//     so another execution never sees half an action;
//   - if the database refuses, nothing of the action is stored and the
//     request fails with the database's reason.

/** How many batching scopes are open: held script locks plus withBatchedWrites_. */
var STORAGE_BATCH_DEPTH_ = 0;

/** The request's Supabase document, when that is the store in use. */
function storageRequestDoc_() {
  return APP_DOC_MEMO_ && APP_DOC_MEMO_.__supabase ? APP_DOC_MEMO_ : null;
}

/**
 * Cache scopes bumped while writes were still unsent.
 *
 * Writers bump a scope's revision right after writing, which on Supabase is
 * before the batch is stored. A reader without the lock could see the new
 * revision, read the old rows and cache them under it -- a stale summary, or
 * a stale Omad_Read_Model, kept until the next write. So each such scope is
 * bumped once more after the batch is stored.
 */
var STORAGE_DEFERRED_BUMPS_ = {};
var STORAGE_REBUMPING_ = false;

function noteRevisionBumpForPendingWrites_(scope) {
  if (STORAGE_REBUMPING_) return;
  var doc = storageRequestDoc_();
  if (doc && (doc.__pendingCount() > 0 || doc.__ctx.buffering())) STORAGE_DEFERRED_BUMPS_[scope] = true;
}

function rebumpDeferredRevisions_() {
  var scopes = Object.keys(STORAGE_DEFERRED_BUMPS_);
  STORAGE_DEFERRED_BUMPS_ = {};
  if (!scopes.length) return;
  STORAGE_REBUMPING_ = true;
  try {
    for (var i = 0; i < scopes.length; i++) bumpDataRevision_(scopes[i]);
  } finally {
    STORAGE_REBUMPING_ = false;
  }
}

/** Sends every kept write now. A no-op on the spreadsheet. */
function flushPendingWrites_() {
  var doc = storageRequestDoc_();
  if (doc) doc.__flush();
}

function beginStorageBatch_() {
  STORAGE_BATCH_DEPTH_++;
}

function endStorageBatch_() {
  STORAGE_BATCH_DEPTH_ = Math.max(0, STORAGE_BATCH_DEPTH_ - 1);
  if (STORAGE_BATCH_DEPTH_ === 0) flushPendingWrites_();
}

/**
 * Runs `fn` with its writes sent together at the end, for a group of writes
 * made outside the script lock (a job's bookkeeping). If `fn` throws, what it
 * wrote before the throw is still sent -- exactly what immediate writes would
 * have left behind -- and the original error is the one that surfaces.
 */
function withBatchedWrites_(fn) {
  beginStorageBatch_();
  var finished = false;
  try {
    var result = fn();
    finished = true;
    return result;
  } finally {
    if (finished) endStorageBatch_();
    else {
      try { endStorageBatch_(); } catch (flushError) { /* the original error says more */ }
    }
  }
}

/**
 * LockService's script lock, which also delimits a batch of writes. Every
 * module takes the lock through this, never through LockService directly.
 *
 * Taking it sends anything still unsent and forgets what this request read
 * before: another execution may have written while we waited, so counts and
 * cached rows are re-read under the lock. Releasing it sends the batch first,
 * then lets the next execution in.
 */
function appScriptLock_() {
  var lock = LockService.getScriptLock();
  var held = false;
  var acquired = function () {
    if (held) return;
    try {
      assertStoreUnchanged_();
    } catch (changed) {
      lock.releaseLock();
      throw changed;
    }
    held = true;
    var doc = storageRequestDoc_();
    if (doc) doc.__lockAcquired();
    beginStorageBatch_();
  };
  return {
    waitLock: function (timeoutMs) { lock.waitLock(timeoutMs); acquired(); },
    tryLock: function (timeoutMs) {
      var ok = lock.tryLock(timeoutMs);
      if (ok) acquired();
      return ok;
    },
    hasLock: function () { return lock.hasLock(); },
    releaseLock: function () {
      if (!held) { lock.releaseLock(); return; }
      held = false;
      try {
        STORAGE_BATCH_DEPTH_ = Math.max(0, STORAGE_BATCH_DEPTH_ - 1);
        // Always sent here, even inside an outer batch: once the lock is
        // gone another execution may read these rows.
        flushPendingWrites_();
      } finally {
        lock.releaseLock();
      }
    }
  };
}

// ------------------------------------------------------------ the document

/**
 * The Supabase-backed stand-in for the active spreadsheet.
 *
 * options.request: this document serves one request (appDoc_). It then keeps
 * writes made under the lock for one mbm_apply call (above), keeps each table
 * it has read whole for the rest of the request, and answers settings and row
 * counts from one parallel fetch. A document opened for anything else -- the
 * move, the speed check, a test looking at the tables -- reads and writes
 * directly, as before.
 */
function supabaseDoc_(credentials, options) {
  var sheets = {};
  var ctx = {
    credentials: credentials,
    perRequest: !!(options && options.request),
    pending: [],        // row operations not sent yet, in order
    touched: {},        // table -> true while it has unsent operations
    counts: null,       // the mbm_counts() answer
    countsGen: 0,       // which mbm_counts() answer `counts` is
    config: null,       // every setting, key -> value
    noRpc: false,       // the database predates mbm_apply / mbm_counts
    rpcKnown: false     // whether that has been found out yet
  };

  var openSheets = function () {
    var list = [];
    for (var name in sheets) {
      if (Object.prototype.hasOwnProperty.call(sheets, name)) list.push(sheets[name]);
    }
    return list;
  };

  /**
   * Whether writes are kept for the batch right now. Only once the database
   * is known to have mbm_apply: without it a kept batch could only be sent as
   * separate calls *after* the code that wrote it had moved on -- a correction
   * whose status write failed would no longer be caught where it happened and
   * its replacement voided. So on such a database every write is immediate,
   * exactly as before batching existed.
   */
  ctx.buffering = function () {
    if (!ctx.perRequest || STORAGE_BATCH_DEPTH_ === 0) return false;
    if (!ctx.noRpc && !ctx.rpcKnown) ctx.prime();
    return !ctx.noRpc;
  };

  /** Keeps a row operation, merging it into one already kept where it can. */
  ctx.queue = function (op) {
    var pending = ctx.pending;
    var last = pending[pending.length - 1];
    var merged = false;
    if (op.op === "insert" && last && last.op === "insert" && last.table === op.table) {
      last.rows = last.rows.concat(op.rows);
      last.refs = last.refs.concat(op.refs);
      merged = true;
    } else if (op.op === "update" || op.op === "upsert_config") {
      for (var i = pending.length - 1; i >= 0 && !merged; i--) {
        var kept = pending[i];
        if (op.op === "update" && kept.op === "update" && kept.table === op.table && kept.seq === op.seq) {
          for (var column in op.values) {
            if (Object.prototype.hasOwnProperty.call(op.values, column)) kept.values[column] = op.values[column];
          }
          merged = true;
        } else if (op.op === "upsert_config" && kept.op === "upsert_config" && kept.key === op.key) {
          kept.value = op.value;
          merged = true;
        }
      }
    }
    if (!merged) pending.push(op);
    ctx.touched[op.op === "upsert_config" ? "system_config" : op.table] = true;
  };

  /** Rows of one insert grouped by column set, as one statement each wants. */
  var wireOps = function (pending) {
    var wire = [];
    var inserts = [];
    for (var p = 0; p < pending.length; p++) {
      var op = pending[p];
      if (op.op !== "insert") {
        wire.push(op.op === "update" ? { op: "update", table: op.table, seq: op.seq, values: op.values }
          : op.op === "delete" ? { op: "delete", table: op.table, seqs: op.seqs }
          : { op: "upsert_config", key: op.key, value: op.value });
        continue;
      }
      var group = null;
      var groupKeys = "";
      for (var r = 0; r < op.rows.length; r++) {
        var keys = Object.keys(op.rows[r]).sort().join(",");
        if (!group || keys !== groupKeys) {
          group = { op: "insert", table: op.table, rows: [] };
          groupKeys = keys;
          wire.push(group);
          inserts.push({ at: wire.length - 1, refs: [] });
        }
        group.rows.push(op.rows[r]);
        inserts[inserts.length - 1].refs.push(op.refs[r]);
      }
    }
    return { wire: wire, inserts: inserts };
  };

  /** The same operations as separate REST calls, for a database without mbm_apply. */
  var applyOneByOne = function (wire) {
    return wire.map(function (op) {
      if (op.op === "upsert_config") {
        supabaseRequest_(credentials, "post", "system_config", [["on_conflict", "key"]],
          [{ key: op.key, value: op.value, updated_at: new Date().toISOString() }],
          "resolution=merge-duplicates,return=minimal");
        return { ok: true };
      }
      if (op.op === "insert") {
        var inserted = supabaseRequest_(credentials, "post", op.table, [["select", "seq"]], op.rows,
          "return=representation").json || [];
        return { seqs: inserted.map(function (r) { return r.seq; }) };
      }
      if (op.op === "update") {
        var updated = supabaseRequest_(credentials, "patch", op.table, [["seq", "eq." + op.seq], ["select", "seq"]],
          op.values, "return=representation").json || [];
        if (updated.length !== 1) throw new Error(op.table + ": yangilanadigan qator topilmadi (seq " + op.seq + ").");
        return { ok: true };
      }
      var removed = supabaseRequest_(credentials, "delete", op.table,
        [["seq", "in.(" + op.seqs.join(",") + ")"], ["select", "seq"]], null, "return=representation").json || [];
      if (removed.length !== op.seqs.length) {
        throw new Error(op.table + ": " + op.seqs.length + " qatordan " + removed.length + " tasi o'chirildi.");
      }
      return { ok: true };
    });
  };

  /**
   * Operations in calls of a size the server accepts. Everything an action
   * writes fits in one; only a batch past SUPABASE_INSERT_MAX_CHARS (a bulk
   * tool's thousands of rows) is split, and then each call is its own
   * transaction: a later call failing leaves the earlier ones stored.
   */
  var applyWire = function (wire) {
    if (ctx.noRpc) return applyOneByOne(wire);
    var chunks = [];
    var current = [];
    var size = 0;
    for (var i = 0; i < wire.length; i++) {
      var length = JSON.stringify(wire[i]).length;
      if (current.length && size + length > SUPABASE_INSERT_MAX_CHARS) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(wire[i]);
      size += length;
    }
    if (current.length) chunks.push(current);

    var results = [];
    for (var c = 0; c < chunks.length; c++) {
      var answer;
      try {
        answer = supabaseRpc_(credentials, "mbm_apply", { ops: chunks[c] }).json || [];
      } catch (error) {
        if (c === 0 && isMissingSupabaseFunction_(error)) {
          // Removed since this request found it: nothing of this call is stored.
          ctx.noRpc = true;
          return applyOneByOne(wire);
        }
        throw error;
      }
      results = results.concat(answer);
    }
    return results;
  };

  /** Sends every kept operation. */
  ctx.flush = function () {
    if (!ctx.pending.length) {
      // Nothing unsent: a bump made since announced nothing still in flight.
      if (!ctx.buffering()) STORAGE_DEFERRED_BUMPS_ = {};
      return;
    }
    var plan = wireOps(ctx.pending);
    ctx.pending = [];
    ctx.touched = {};
    var results;
    try {
      results = applyWire(plan.wire);
    } catch (error) {
      // Nothing of the batch is stored. Every position and count this
      // request worked out may now be wrong, so all of it is read again.
      ctx.counts = null;
      ctx.config = null;
      openSheets().forEach(function (sheet) { sheet.__forget(true); });
      // A batch split over several calls (only past SUPABASE_INSERT_MAX_CHARS)
      // may be partly stored: invalidate regardless.
      rebumpDeferredRevisions_();
      throw error;
    }
    for (var i = 0; i < plan.inserts.length; i++) {
      var seqs = (results[plan.inserts[i].at] || {}).seqs || [];
      var refs = plan.inserts[i].refs;
      if (seqs.length !== refs.length) {
        throw new Error("Supabase: " + refs.length + " qatordan " + seqs.length + " tasi yozildi.");
      }
      for (var k = 0; k < refs.length; k++) refs[k].seq = seqs[k];
    }
    rebumpDeferredRevisions_();
  };

  /** Sends what a read of `table` would otherwise miss. */
  ctx.beforeRead = function (table) {
    if (ctx.touched[table]) ctx.flush();
  };

  /**
   * Fetches, in one round trip, whichever of the settings and the row counts
   * this request has not got yet. A request needs both almost every time, and
   * one parallel fetch costs what one of them does.
   */
  ctx.prime = function () {
    var calls = [];
    var wantCounts = !ctx.counts && !ctx.noRpc;
    var wantConfig = !ctx.config;
    // Counts are only true of what is stored.
    if (wantCounts && ctx.pending.length) ctx.flush();
    if (wantConfig) ctx.beforeRead("system_config");
    if (wantCounts) calls.push({ method: "post", path: "rpc/mbm_counts", body: {} });
    if (wantConfig) {
      calls.push({ method: "get", path: "system_config", params: [
        ["select", "seq,key,value"], ["order", "seq.asc"], ["limit", SUPABASE_PAGE_SIZE]] });
    }
    if (!calls.length) return;
    var answers = supabaseRequestAll_(credentials, calls);
    var at = 0;
    if (wantCounts) {
      var counted = answers[at++];
      if (counted instanceof Error) {
        if (!isMissingSupabaseFunction_(counted)) throw counted;
        ctx.noRpc = true;
      } else {
        ctx.counts = counted.json || {};
        ctx.countsGen++;
      }
      ctx.rpcKnown = true;
    }
    if (wantConfig) {
      var first = answers[at];
      if (first instanceof Error) throw first;
      var rows = first.json || [];
      var page = rows;
      while (page.length === SUPABASE_PAGE_SIZE) {
        page = supabaseRequest_(credentials, "get", "system_config", [
          ["select", "seq,key,value"], ["seq", "gt." + page[page.length - 1].seq],
          ["order", "seq.asc"], ["limit", SUPABASE_PAGE_SIZE]]).json || [];
        rows = rows.concat(page);
      }
      var config = {};
      for (var i = 0; i < rows.length; i++) config[rows[i].key] = rows[i].value === null ? "" : rows[i].value;
      ctx.config = config;
    }
  };

  /** Everything read so far may be stale (the lock was just taken). */
  ctx.forgetReads = function () {
    ctx.flush();
    ctx.counts = null;
    ctx.config = null;
    openSheets().forEach(function (sheet) { sheet.__forget(false); });
  };

  var doc = {
    __supabase: true,
    __ctx: ctx,
    credentials: credentials,
    __flush: function () { ctx.flush(); },
    __lockAcquired: function () { ctx.forgetReads(); },
    __pendingCount: function () { return ctx.pending.length; },
    getSheetByName: function (name) {
      var definition = supabaseSheetDefinition_(name);
      if (!definition) return null;
      if (!sheets[name]) sheets[name] = supabaseSheet_(ctx, name, definition, doc);
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
      ctx.beforeRead("telegram_debug_log");
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
 * `seqs[i]` identifies data row i (sheet row i + 2): the row's `seq`, or --
 * for a row kept to be inserted with the batch -- a reference whose `seq` is
 * filled in when the batch is sent. `count` is the number of data rows as
 * last observed, or -1. `rows` is the whole table as read in this request,
 * kept until the request inserts or deletes rows in it.
 */
function supabaseSheet_(ctx, name, definition, doc) {
  var credentials = ctx.credentials;
  var table = definition.table;
  var columns = definition.columns;
  var header = columns.map(function (c) { return c[0]; });
  var state = { seqs: [], count: -1, rows: null, rowIndex: null, countGen: -1 };
  // Sheet rows above the data: the header, or none.
  var headerRows = definition.noHeader ? 0 : 1;
  var firstDataRow = headerRows + 1;

  var columnType = {};
  columns.forEach(function (c) { columnType[c[1]] = c[2]; });

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
    return supabaseRequest_(credentials, method, table, params, body, prefer);
  };

  /** A row identity as a number, sending the batch if the row is not stored yet. */
  var seqOf = function (entry) {
    if (typeof entry === "number") return entry;
    if (entry && entry.seq === undefined) ctx.flush();
    if (!entry || entry.seq === undefined) throw new Error(name + ": qator saqlanmadi.");
    return entry.seq;
  };

  // ----- whole-table rows kept for the request

  var keepRows = function (records) {
    if (!ctx.perRequest) return;
    state.rows = records;
    state.rowIndex = null;
  };

  var dropRows = function () {
    state.rows = null;
    state.rowIndex = null;
  };

  var allPage = function (afterSeq) {
    return { method: "get", path: table, params: baseFilters().concat([
      ["select", selectList(0, columns.length - 1)], ["seq", "gt." + afterSeq],
      ["order", "seq.asc"], ["limit", SUPABASE_PAGE_SIZE]]) };
  };

  /**
   * Every data row, paged by seq so a large table is read whole. A table read
   * together with another (definition.readWith) fetches both in parallel.
   */
  var readAll = function () {
    ctx.beforeRead(table);
    if (state.rows) return state.rows;

    var calls = [allPage(0)];
    var companions = [];
    if (ctx.perRequest && definition.readWith) {
      definition.readWith.forEach(function (other) {
        var sheet = doc.getSheetByName(other);
        if (sheet && sheet.__wantsRows()) {
          companions.push(sheet);
          calls.push(allPage(0));
          calls[calls.length - 1].path = sheet.__table;
          calls[calls.length - 1].params = sheet.__allPageParams();
        }
      });
    }
    var answers = supabaseRequestAll_(credentials, calls);
    if (answers[0] instanceof Error) throw answers[0];
    for (var c = 0; c < companions.length; c++) {
      if (!(answers[c + 1] instanceof Error)) companions[c].__adopt(answers[c + 1].json || []);
    }

    var records = [];
    var page = answers[0].json || [];
    while (true) {
      for (var i = 0; i < page.length; i++) records.push(page[i]);
      if (page.length < SUPABASE_PAGE_SIZE) break;
      var next = allPage(page[page.length - 1].seq);
      page = request(next.method, next.params).json || [];
    }
    state.seqs = records.map(function (r) { return r.seq; });
    state.count = records.length;
    keepRows(records);
    return records;
  };

  /** Data rows [offset, offset + limit) in sheet order, with their seqs. */
  var readRows = function (offset, limit, fromCol, toCol) {
    ctx.beforeRead(table);
    // A table this request has read whole (or always reads whole) is served
    // from that one read.
    if (state.rows || (ctx.perRequest && definition.wholeReads)) {
      return readAll().slice(offset, offset + limit);
    }
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

  // ----- row counts

  /** This table's count in an mbm_counts() answer. */
  var countIn = function (counts) {
    var value = counts[table];
    var f = definition.filter;
    if (f && f.equals !== undefined) value = value && typeof value === "object" ? (value[f.equals] || 0) : 0;
    var number = Number(value);
    return isFinite(number) ? number : -1;
  };

  /** The row count, if known without asking the database. */
  var knownCount = function () {
    if (state.count >= 0) return state.count;
    if (ctx.counts && state.countGen !== ctx.countsGen) {
      state.countGen = ctx.countsGen;
      state.count = countIn(ctx.counts);
    }
    return state.count;
  };

  /** Writes whose rows were not counted make the shared answer wrong for this table. */
  var countUnknown = function () {
    state.count = -1;
    state.countGen = ctx.countsGen;
  };

  var dataCount = function () {
    if (knownCount() >= 0) return state.count;
    ctx.beforeRead(table);
    if (ctx.perRequest && !ctx.counts && !ctx.noRpc) {
      ctx.prime();
      if (knownCount() >= 0) return state.count;
    }
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
      var entry = state.seqs[offset + j];
      if (entry === undefined) throw new Error(name + ": " + (offset + j + firstDataRow) + "-qator topilmadi.");
      out.push(seqOf(entry));
    }
    return out;
  };

  // ----- writes

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
    for (var i = 0; i < records.length; i++) {
      // NOT NULL columns the caller left out get their default.
      for (var c = 0; c < columns.length; c++) {
        if (Object.prototype.hasOwnProperty.call(records[i], columns[c][1])) continue;
        if (columns[c][3] !== undefined) records[i][columns[c][1]] = supabaseToDb_(columns[c][2], "", columns[c][3]);
      }
      if (f && f.equals !== undefined) records[i][f.column] = f.equals;
    }
    // The server fills defaults and generated columns: the next whole read
    // goes to the database.
    dropRows();
    if (table === "system_config") ctx.config = null;

    // Positions are tracked only when the row count is already known; an
    // append that has not looked at the table costs no extra request.
    var base = knownCount();

    if (ctx.buffering()) {
      var refs = records.map(function () { return {}; });
      ctx.queue({ op: "insert", table: table, rows: records, refs: refs });
      if (base >= 0) {
        for (var r = 0; r < refs.length; r++) state.seqs[base + r] = refs[r];
        state.count = base + refs.length;
      } else countUnknown();
      return;
    }

    ctx.beforeRead(table);
    var chunks = chunked(records);
    for (var n = 0; n < chunks.length; n++) {
      var chunk = chunks[n];
      var inserted = request("post", [["select", "seq"]], chunk, "return=representation").json || [];
      if (inserted.length !== chunk.length) {
        throw new Error(name + ": " + chunk.length + " qatordan " + inserted.length + " tasi yozildi.");
      }
      if (base >= 0) {
        for (var k = 0; k < inserted.length; k++) state.seqs[base + k] = inserted[k].seq;
        base += inserted.length;
        state.count = base;
      }
    }
    if (base < 0) countUnknown();
  };

  /** A row kept from this request's whole read, updated the way the database will be. */
  var updateKeptRow = function (seq, record) {
    if (!state.rows) return;
    for (var column in record) {
      // jsonb comes back re-serialised by the server; read it from there.
      if (Object.prototype.hasOwnProperty.call(record, column) && columnType[column] === "json") {
        dropRows();
        return;
      }
    }
    if (!state.rowIndex) {
      state.rowIndex = {};
      for (var i = 0; i < state.rows.length; i++) state.rowIndex[state.rows[i].seq] = i;
    }
    var at = state.rowIndex[seq];
    if (at === undefined) { dropRows(); return; }
    var kept = {};
    for (var key in state.rows[at]) {
      if (Object.prototype.hasOwnProperty.call(state.rows[at], key)) kept[key] = state.rows[at][key];
    }
    for (var name2 in record) {
      if (Object.prototype.hasOwnProperty.call(record, name2)) kept[name2] = record[name2];
    }
    state.rows[at] = kept;
  };

  var updateRecord = function (entry, record) {
    if (table === "system_config") ctx.config = null;
    // A row kept for insertion takes the new cells before it is ever sent.
    if (typeof entry !== "number" && entry.seq === undefined && ctx.buffering()) {
      var pending = ctx.pending;
      for (var p = 0; p < pending.length; p++) {
        if (pending[p].op !== "insert") continue;
        var at = pending[p].refs.indexOf(entry);
        if (at < 0) continue;
        for (var column in record) {
          if (Object.prototype.hasOwnProperty.call(record, column)) pending[p].rows[at][column] = record[column];
        }
        return;
      }
    }
    var seq = seqOf(entry);
    if (ctx.buffering()) {
      ctx.queue({ op: "update", table: table, seq: seq, values: record });
      updateKeptRow(seq, record);
      return;
    }
    ctx.beforeRead(table);
    var updated = request("patch", [["seq", "eq." + seq], ["select", "seq"]], record, "return=representation").json || [];
    if (updated.length !== 1) throw new Error(name + ": yangilanadigan qator topilmadi (seq " + seq + ").");
    updateKeptRow(seq, record);
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
    if (table === "system_config") ctx.config = null;

    if (ctx.buffering()) {
      if (definition.softDelete) {
        var stamp = new Date().toISOString();
        for (var t = 0; t < targets.length; t++) {
          var values = {};
          values[definition.softDelete] = stamp;
          ctx.queue({ op: "update", table: table, seq: targets[t], values: values });
        }
      } else {
        ctx.queue({ op: "delete", table: table, seqs: targets });
      }
    } else {
      ctx.beforeRead(table);
      var list = "in.(" + targets.join(",") + ")";
      var changed;
      if (definition.softDelete) {
        var soft = {};
        soft[definition.softDelete] = new Date().toISOString();
        changed = request("patch", [["seq", list], ["select", "seq"]], soft, "return=representation").json || [];
      } else {
        changed = request("delete", [["seq", list], ["select", "seq"]], null, "return=representation").json || [];
      }
      if (changed.length !== targets.length) {
        throw new Error(name + ": " + targets.length + " qatordan " + changed.length + " tasi o'chirildi.");
      }
    }
    // Every position below has shifted; the next access re-reads.
    state.seqs = [];
    countUnknown();
    dropRows();
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
    __supabaseTable: table,
    __table: table,
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

    /**
     * The first data row whose database column equals `value`, found by the
     * database rather than by reading the table: { rowNumber, row } or null.
     * Only for indexed columns the sheet never had (cafe_sales.request_id).
     */
    findFirstRow: function (dbColumn, value) {
      ctx.beforeRead(table);
      var found = request("get", baseFilters().concat([
        ["select", selectList(0, columns.length - 1)], [dbColumn, "eq." + value],
        ["order", "seq.asc"], ["limit", 1]])).json || [];
      if (!found.length) return null;
      var before = request("get", baseFilters().concat([
        ["select", "seq"], ["seq", "lt." + found[0].seq], ["limit", 1]]), null, "count=exact");
      var position = supabaseCountFrom_(before);
      state.seqs[position] = found[0].seq;
      return { rowNumber: position + firstDataRow, row: toCells(found[0], 0, columns.length - 1) };
    },

    // ----- System_Config by key -------------------------------------------
    getConfigValue: function (key) {
      if (ctx.perRequest) {
        if (!ctx.config) ctx.prime();
        return Object.prototype.hasOwnProperty.call(ctx.config, key) ? ctx.config[key] : null;
      }
      var found = request("get", [["select", "value"], ["key", "eq." + key], ["limit", 1]]).json || [];
      return found.length ? (found[0].value === null ? "" : found[0].value) : null;
    },
    setConfigValue: function (key, value) {
      var stored = value === null || value === undefined ? null : String(value);
      dropRows();
      if (ctx.buffering()) {
        ctx.queue({ op: "upsert_config", key: String(key), value: stored });
      } else {
        request("post", [["on_conflict", "key"]],
          [{ key: String(key), value: stored, updated_at: new Date().toISOString() }],
          "resolution=merge-duplicates,return=minimal");
      }
      if (ctx.config) {
        // A new key is a new row this request did not count.
        if (!Object.prototype.hasOwnProperty.call(ctx.config, key)) countUnknown();
        ctx.config[key] = stored === null ? "" : stored;
      } else {
        countUnknown();
      }
    },

    // ----- for the document ------------------------------------------------
    /** Forget counts and kept rows; `positions` also forgets row identities. */
    __forget: function (positions) {
      state.count = -1;
      state.countGen = -1;
      dropRows();
      if (positions) state.seqs = [];
    },
    __wantsRows: function () { return ctx.perRequest && !state.rows && !ctx.touched[table]; },
    __allPageParams: function () { return allPage(0).params; },
    /** A whole first page read alongside another table. */
    __adopt: function (records) {
      if (records.length >= SUPABASE_PAGE_SIZE || ctx.touched[table]) return;
      state.seqs = records.map(function (r) { return r.seq; });
      state.count = records.length;
      keepRows(records);
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
  if (mode === STORAGE_MODE_MOVING) status.message = "Ko'chirish davom etmoqda";
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

// ------------------------------------------------------------- speed check

/** The ledger the application actually reads, by the store's own setting. */
function benchmarkLedgerName_(configured) {
  var name = String(configured || "").trim();
  return name === OMAD_TRANSACTIONS_SHEET || name === OMAD_TRANSACTIONS_V2_SHEET ? name : OMAD_TRANSACTIONS_SHEET;
}

/** The middle value of a list of milliseconds. */
function storageMedianMs_(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** Runs `fn` `times` times and returns the median duration in ms. */
function storageTimeMs_(times, fn) {
  var durations = [];
  for (var i = 0; i < times; i++) {
    var started = Date.now();
    fn();
    durations.push(Date.now() - started);
  }
  return storageMedianMs_(durations);
}

/**
 * How long the same reads take from each store, measured from where the
 * backend actually runs -- Google's servers -- rather than guessed.
 *
 * Read-only on both sides. One small read (a single setting) is the price of
 * one round trip; one full read of the live ledger is the price of the pass
 * the dashboard and every report make. Writes are not timed: there is nothing
 * safe to write to a live ledger for the sake of a stopwatch.
 */
function storageLatencyBenchmark_() {
  var result = { sheets: null, supabase: null, measuredAt: new Date().toISOString() };

  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetConfig = spreadsheet.getSheetByName("System_Config");
  var sheetLedger = sheetConfig
    ? spreadsheet.getSheetByName(benchmarkLedgerName_(getConfig(sheetConfig, OMAD_ACTIVE_TX_SHEET_KEY)))
    : null;
  if (sheetConfig) {
    var sheetRows = 0;
    result.sheets = {
      oneSettingMs: storageTimeMs_(3, function () { getConfig(sheetConfig, "Omad_Rates"); }),
      wholeLedgerMs: sheetLedger
        ? storageTimeMs_(3, function () { sheetRows = sheetLedger.getDataRange().getValues().length - 1; })
        : 0,
      ledgerRows: 0
    };
    result.sheets.ledgerRows = Math.max(0, sheetRows);
  }

  var credentials = supabaseCredentials_();
  if (credentials.ok) {
    try {
      var doc = supabaseDoc_(credentials);
      var config = doc.getSheetByName("System_Config");
      // Each store's own setting: the two may differ before a move.
      var ledgerName = benchmarkLedgerName_(config.getConfigValue(OMAD_ACTIVE_TX_SHEET_KEY));
      var dbRows = 0;
      result.supabase = {
        oneSettingMs: storageTimeMs_(3, function () { config.getConfigValue("Omad_Rates"); }),
        wholeLedgerMs: storageTimeMs_(3, function () {
          dbRows = supabaseDoc_(credentials).getSheetByName(ledgerName)
            .getDataRange().getValues().length - 1;
        }),
        ledgerRows: 0
      };
      result.supabase.ledgerRows = Math.max(0, dbRows);
    } catch (error) {
      result.supabase = { error: redactSecrets_(error).slice(0, 300) };
    }
  }
  return result;
}
