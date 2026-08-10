// ============================================================
// Tasks — storage, occurrences and views
// ------------------------------------------------------------
// Task data lives in its own sheets and never touches the financial ledger.
//
//   Tasks              one row per definition (one-time, routine or goal)
//   Task_Occurrences   one row per completable instance, with its own
//                      completion / proof / reminder history
//
// A routine never "completes"; the scheduler materialises a fresh occurrence
// per due date, so each day has its own row, status and history.
// ============================================================

var TASKS_SHEET = "Tasks";
var TASK_OCCURRENCES_SHEET = "Task_Occurrences";

var TASKS_HEADER = [
  "ID", "Type", "Title", "Description", "Responsible", "Priority", "Photo_Required",
  "Recurrence_JSON", "Reminder_Times_JSON", "Remind_Daily", "Due_Time",
  "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key", "Status", "Steps_JSON",
  "Created_At", "Updated_At", "Created_By", "Meta_JSON"
];

var TASK_OCC_HEADER = [
  "ID", "Task_ID", "Task_Type", "Title", "Date_Key", "Step_Index", "Due_At",
  "Responsible", "Priority", "Photo_Required", "Reminder_Times_JSON", "Remind_Daily",
  "Status", "Reminders_Sent_JSON", "Notified_At", "Telegram_Msg_ID",
  "Completed_By_Id", "Completed_By_Name", "Completed_At", "On_Time", "Late_Ms",
  "Proof_File_Id", "Proof_Msg_Id", "Proof_Awaiting_User_Id",
  "Created_At", "Updated_At", "Meta_JSON"
];

// Occurrence lifecycle states. "Overdue" is a *derived* view of an Open (or
// waiting) occurrence past its deadline, never a stored value, so a completion
// can always be judged on-time vs late against the same deadline.
var TASK_STATUS_OPEN = "Open";
var TASK_STATUS_WAITING = "WaitingProof";
var TASK_STATUS_COMPLETED = "Completed";
var TASK_STATUS_CANCELLED = "Cancelled";
var TASK_STATUS_SKIPPED = "Skipped";

// Task-definition states.
var TASK_DEF_ACTIVE = "active";
var TASK_DEF_PAUSED = "paused";
var TASK_DEF_COMPLETED = "completed";
var TASK_DEF_CANCELLED = "cancelled";

var TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
var TASK_TYPES = ["once", "routine", "goal"];

var TASK_GENERATION_HORIZON_DAYS = 14; // how far ahead routines are materialised
var TASK_STATS_WINDOW = 180;           // occurrences considered for streak / rate

function parseTaskBool_(value) {
  return value === true || value === "TRUE" || value === "true" || value === 1 || value === "1";
}

function taskBoolCell_(value) {
  return value ? "TRUE" : "FALSE";
}

function normalizeTaskPriority_(value) {
  var v = String(value || "").toLowerCase();
  return TASK_PRIORITIES.indexOf(v) !== -1 ? v : "normal";
}

function normalizeTaskTimes_(times) {
  var source = Array.isArray(times) ? times : [];
  var seen = {};
  var out = [];
  for (var i = 0; i < source.length; i++) {
    // Tolerant of a value the spreadsheet already rewrote, so a reminder list
    // that was stored oddly still parses instead of vanishing.
    var t = taskTimeKeyFromCell_(source[i]);
    if (isTaskTimeKey_(t) && !seen[t]) { seen[t] = true; out.push(t); }
  }
  out.sort();
  return out;
}

// ------------------------------------------------------------------ sheets

function tasksSheet_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET) || doc.insertSheet(TASKS_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASKS_HEADER);
  return sheet;
}

function taskOccurrencesSheet_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET) || doc.insertSheet(TASK_OCCURRENCES_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASK_OCC_HEADER);
  return sheet;
}

function taskColumnIndex_(header, name) {
  return header.indexOf(name) + 1; // 1-based sheet column
}

// Columns whose value must reach the sheet as exact text. Everything here is
// a date key, a clock time or an ISO stamp: values a spreadsheet will happily
// reinterpret as a date of its own choosing if the column is not text.
var TASKS_TEXT_COLUMNS = [
  "Due_Time", "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key",
  "Created_At", "Updated_At"
];

var TASK_OCC_TEXT_COLUMNS = [
  "Date_Key", "Notified_At", "Completed_At", "Created_At", "Updated_At"
];

/** Column numbers for `names`, merged into contiguous [start, count] spans. */
function taskTextColumnSpans_(header, names) {
  var cols = [];
  for (var i = 0; i < names.length; i++) {
    var index = header.indexOf(names[i]) + 1;
    if (index > 0) cols.push(index);
  }
  cols.sort(function (a, b) { return a - b; });
  var spans = [];
  for (var c = 0; c < cols.length; c++) {
    var last = spans[spans.length - 1];
    if (last && cols[c] === last[0] + last[1]) last[1]++;
    else spans.push([cols[c], 1]);
  }
  return spans;
}

/**
 * Stops the spreadsheet reinterpreting what is about to be written.
 *
 * Must run BEFORE the values land: a number format applied afterwards
 * reformats an already-coerced value, it does not recover it.
 */
function applyTaskTextFormats_(sheet, header, names, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var probe = sheet.getRange(startRow, 1, numRows, 1);
  if (typeof probe.setNumberFormat !== "function") return; // older host / test double
  var spans = taskTextColumnSpans_(header, names);
  for (var s = 0; s < spans.length; s++) {
    sheet.getRange(startRow, spans[s][0], numRows, spans[s][1]).setNumberFormat("@");
  }
}

// ------------------------------------------------------------ task records

function taskFromRow_(row) {
  var i = function (name) { return row[TASKS_HEADER.indexOf(name)]; };
  return {
    id: String(i("ID") || ""),
    type: String(i("Type") || "once"),
    title: String(i("Title") || ""),
    description: String(i("Description") || ""),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    recurrence: normalizeTaskRecurrence_(safeParseJSON_(i("Recurrence_JSON"), {})),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    dueTime: taskTimeKeyFromCell_(i("Due_Time")),
    deadlineKey: taskDateKeyFromCell_(i("Deadline_Key")),
    deadlineTime: taskTimeKeyFromCell_(i("Deadline_Time")),
    startKey: taskDateKeyFromCell_(i("Start_Key")),
    endKey: taskDateKeyFromCell_(i("End_Key")),
    status: String(i("Status") || TASK_DEF_ACTIVE),
    steps: normalizeGoalSteps_(safeParseJSON_(i("Steps_JSON"), [])),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    createdBy: String(i("Created_By") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function taskToRow_(task) {
  var map = {
    ID: task.id,
    Type: task.type,
    Title: task.title,
    Description: task.description || "",
    Responsible: task.responsible || "",
    Priority: task.priority || "normal",
    Photo_Required: taskBoolCell_(task.photoRequired),
    Recurrence_JSON: JSON.stringify(task.recurrence || {}),
    Reminder_Times_JSON: JSON.stringify(task.reminderTimes || []),
    Remind_Daily: taskBoolCell_(task.remindDaily),
    Due_Time: task.dueTime || "",
    Deadline_Key: task.deadlineKey || "",
    Deadline_Time: task.deadlineTime || "",
    Start_Key: task.startKey || "",
    End_Key: task.endKey || "",
    Status: task.status || TASK_DEF_ACTIVE,
    Steps_JSON: JSON.stringify(task.steps || []),
    Created_At: task.createdAt || "",
    Updated_At: task.updatedAt || "",
    Created_By: task.createdBy || "",
    Meta_JSON: JSON.stringify(task.meta || {})
  };
  return TASKS_HEADER.map(function (name) { return map[name]; });
}

function newGoalStepId_() {
  return "step_" + Utilities.getUuid().split("-").join("");
}

function normalizeGoalSteps_(steps) {
  var source = Array.isArray(steps) ? steps : [];
  var out = [];
  for (var i = 0; i < source.length; i++) {
    var step = typeof source[i] === "string" ? { title: source[i] } : (source[i] || {});
    var title = String(step.title || "").trim();
    if (!title) continue;
    var entry = { title: title };
    if (step.id) entry.id = String(step.id).slice(0, 64);
    // Absent means "inherit from the goal". Only an explicit value overrides,
    // which is why this key is not written unless one was supplied.
    if (step.photoRequired !== undefined && step.photoRequired !== null && step.photoRequired !== "") {
      entry.photoRequired = parseTaskBool_(step.photoRequired);
    }
    out.push(entry);
  }
  return out;
}

/** The photo rule that actually applies to a step. */
function effectiveStepPhotoRequired_(task, step) {
  if (step && step.photoRequired !== undefined) return !!step.photoRequired;
  return !!task.photoRequired;
}

/** "<goal title> — <step title>", the label a step-occurrence carries. */
function goalStepTitle_(task, step, index) {
  return task.title + " — " + ((step && step.title) || ("Qadam " + (index + 1)));
}

/**
 * Whether a goal's reminder times apply to its steps.
 *
 * A step has no due date, so there is no single moment to remind about. If the
 * admin set reminder times on the goal, the only reading that does what they
 * asked is "every day until the step is done".
 */
function goalRemindDaily_(task) {
  return !!(task.reminderTimes && task.reminderTimes.length);
}

function readTaskRows_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var task = taskFromRow_(data[i]);
    task.rowNumber = i + 1;
    rows.push(task);
  }
  return rows;
}

function findTask_(doc, taskId) {
  if (!taskId) return null;
  var rows = readTaskRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(taskId)) return rows[i];
  return null;
}

function appendTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, row, 1);
  sheet.appendRow(taskToRow_(task));
}

function updateTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  if (!task.rowNumber) return;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, task.rowNumber, 1);
  sheet.getRange(task.rowNumber, 1, 1, TASKS_HEADER.length).setValues([taskToRow_(task)]);
}

// ------------------------------------------------------ occurrence records

function occurrenceFromRow_(row) {
  var i = function (name) { return row[TASK_OCC_HEADER.indexOf(name)]; };
  var dueRaw = i("Due_At");
  return {
    id: String(i("ID") || ""),
    taskId: String(i("Task_ID") || ""),
    taskType: String(i("Task_Type") || ""),
    title: String(i("Title") || ""),
    dateKey: taskDateKeyFromCell_(i("Date_Key")),
    stepIndex: i("Step_Index") === "" || i("Step_Index") === null || i("Step_Index") === undefined
      ? "" : Number(i("Step_Index")),
    dueAt: dueRaw === "" || dueRaw === null || dueRaw === undefined ? "" : Number(dueRaw),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    status: String(i("Status") || TASK_STATUS_OPEN),
    remindersSent: safeParseJSON_(i("Reminders_Sent_JSON"), {}),
    notifiedAt: String(i("Notified_At") || ""),
    msgId: String(i("Telegram_Msg_ID") || ""),
    completedById: String(i("Completed_By_Id") || ""),
    completedByName: String(i("Completed_By_Name") || ""),
    completedAt: String(i("Completed_At") || ""),
    onTime: i("On_Time") === "" ? "" : parseTaskBool_(i("On_Time")),
    lateMs: i("Late_Ms") === "" || i("Late_Ms") === null || i("Late_Ms") === undefined ? "" : Number(i("Late_Ms")),
    proofFileId: String(i("Proof_File_Id") || ""),
    proofMsgId: String(i("Proof_Msg_Id") || ""),
    proofAwaitingUserId: String(i("Proof_Awaiting_User_Id") || ""),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function occurrenceToRow_(occ) {
  var map = {
    ID: occ.id,
    Task_ID: occ.taskId,
    Task_Type: occ.taskType,
    Title: occ.title,
    Date_Key: occ.dateKey || "",
    Step_Index: occ.stepIndex === "" || occ.stepIndex === undefined || occ.stepIndex === null ? "" : occ.stepIndex,
    Due_At: occ.dueAt === "" || occ.dueAt === undefined || occ.dueAt === null ? "" : occ.dueAt,
    Responsible: occ.responsible || "",
    Priority: occ.priority || "normal",
    Photo_Required: taskBoolCell_(occ.photoRequired),
    Reminder_Times_JSON: JSON.stringify(occ.reminderTimes || []),
    Remind_Daily: taskBoolCell_(occ.remindDaily),
    Status: occ.status || TASK_STATUS_OPEN,
    Reminders_Sent_JSON: JSON.stringify(occ.remindersSent || {}),
    Notified_At: occ.notifiedAt || "",
    Telegram_Msg_ID: occ.msgId || "",
    Completed_By_Id: occ.completedById || "",
    Completed_By_Name: occ.completedByName || "",
    Completed_At: occ.completedAt || "",
    On_Time: occ.onTime === "" || occ.onTime === undefined || occ.onTime === null ? "" : taskBoolCell_(occ.onTime),
    Late_Ms: occ.lateMs === "" || occ.lateMs === undefined || occ.lateMs === null ? "" : occ.lateMs,
    Proof_File_Id: occ.proofFileId || "",
    Proof_Msg_Id: occ.proofMsgId || "",
    Proof_Awaiting_User_Id: occ.proofAwaitingUserId || "",
    Created_At: occ.createdAt || "",
    Updated_At: occ.updatedAt || "",
    Meta_JSON: JSON.stringify(occ.meta || {})
  };
  return TASK_OCC_HEADER.map(function (name) { return map[name]; });
}

function readOccurrenceRows_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var occ = occurrenceFromRow_(data[i]);
    occ.rowNumber = i + 1;
    rows.push(occ);
  }
  return rows;
}

function findOccurrence_(doc, occurrenceId) {
  if (!occurrenceId) return null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(occurrenceId)) return rows[i];
  return null;
}

function occurrencesForTask_(rows, taskId) {
  var out = [];
  for (var i = 0; i < rows.length; i++) if (rows[i].taskId === String(taskId)) out.push(rows[i]);
  return out;
}

function appendOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, row, 1);
  sheet.appendRow(occurrenceToRow_(occ));
  occ.rowNumber = row;
}

/** Appends many occurrences in one write, protecting their text columns first. */
function appendOccurrenceRows_(doc, occurrences) {
  if (!occurrences || !occurrences.length) return [];
  var sheet = taskOccurrencesSheet_(doc);
  var startRow = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, startRow, occurrences.length);
  var values = [];
  for (var i = 0; i < occurrences.length; i++) values.push(occurrenceToRow_(occurrences[i]));
  sheet.getRange(startRow, 1, values.length, TASK_OCC_HEADER.length).setValues(values);
  for (var r = 0; r < occurrences.length; r++) occurrences[r].rowNumber = startRow + r;
  return occurrences;
}

/** Rewrites a single occurrence row from an in-memory object. */
function writeOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  if (!occ.rowNumber) return;
  occ.updatedAt = new Date().toISOString();
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, occ.rowNumber, 1);
  sheet.getRange(occ.rowNumber, 1, 1, TASK_OCC_HEADER.length).setValues([occurrenceToRow_(occ)]);
}

// ------------------------------------------------ occurrence materialisation

/**
 * Ensures the occurrence rows that should exist for a task exist, and returns
 * the ones this call created. Idempotent: an occurrence is keyed by
 * (taskId, dateKey) for routines/one-time and (taskId, stepIndex) for goals,
 * so re-running never duplicates and never disturbs completed history.
 *
 * `ctx` is an optional per-pass working set: the occurrence rows already read
 * from the sheet, plus the rows this pass wants to add. Passing one turns a
 * scan-per-task into a single scan and a single append for the whole pass.
 * Called without one it behaves exactly as before.
 */
function materializeTaskOccurrences_(doc, task, nowMs, ctx) {
  if (task.status === TASK_DEF_CANCELLED) return [];
  var todayKey = taskTodayKey_(nowMs);
  var existing = occurrencesForTask_(ctx ? ctx.occurrences : readOccurrenceRows_(doc), task.id);

  var byDate = {};
  var byStep = {};
  for (var e = 0; e < existing.length; e++) {
    if (existing[e].dateKey) byDate[existing[e].dateKey] = existing[e];
    // A removed step's row is history and must not block a new step from
    // taking its index.
    if (existing[e].stepIndex !== "" && !(existing[e].meta && existing[e].meta.removedStep)) {
      byStep[existing[e].stepIndex] = existing[e];
    }
  }

  var created = [];

  if (task.type === "once") {
    // A single occurrence. dateKey/dueAt are empty when the task has no deadline.
    if (existing.length === 0) {
      created.push(buildOccurrenceForOnce_(task));
    }
  } else if (task.type === "goal") {
    for (var s = 0; s < task.steps.length; s++) {
      if (byStep[s] === undefined) created.push(buildOccurrenceForGoalStep_(task, s));
    }
  } else if (task.type === "routine" && task.status === TASK_DEF_ACTIVE) {
    var genFrom = task.startKey && task.startKey > todayKey ? task.startKey : todayKey;
    var genTo = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);
    var dueKeys = routineOccurrenceKeysInRange_(task.recurrence, task.startKey || genFrom, task.endKey, genFrom, genTo);
    for (var k = 0; k < dueKeys.length; k++) {
      if (!byDate[dueKeys[k]]) created.push(buildOccurrenceForRoutine_(task, dueKeys[k]));
    }
  }

  if (ctx) {
    for (var c = 0; c < created.length; c++) { ctx.pending.push(created[c]); ctx.occurrences.push(created[c]); }
  } else {
    for (var a = 0; a < created.length; a++) appendOccurrenceRow_(doc, created[a]);
  }
  return created;
}

function newOccurrenceId_() {
  return "occ_" + Utilities.getUuid().split("-").join("");
}

function baseOccurrence_(task) {
  var nowIso = new Date().toISOString();
  return {
    id: newOccurrenceId_(),
    taskId: task.id,
    taskType: task.type,
    title: task.title,
    dateKey: "",
    stepIndex: "",
    dueAt: "",
    responsible: task.responsible || "",
    priority: task.priority || "normal",
    photoRequired: !!task.photoRequired,
    reminderTimes: task.reminderTimes || [],
    remindDaily: !!task.remindDaily,
    status: TASK_STATUS_OPEN,
    remindersSent: {},
    notifiedAt: "",
    msgId: "",
    completedById: "",
    completedByName: "",
    completedAt: "",
    onTime: "",
    lateMs: "",
    proofFileId: "",
    proofMsgId: "",
    proofAwaitingUserId: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    meta: {}
  };
}

function buildOccurrenceForOnce_(task) {
  var occ = baseOccurrence_(task);
  occ.dateKey = task.deadlineKey || "";
  occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
  return occ;
}

function buildOccurrenceForRoutine_(task, dateKey) {
  var occ = baseOccurrence_(task);
  occ.dateKey = dateKey;
  // A routine with a due time can be late; one without simply "belongs" to the day.
  occ.dueAt = task.dueTime ? taskInstantMs_(dateKey, task.dueTime) : "";
  return occ;
}

function buildOccurrenceForGoalStep_(task, stepIndex) {
  var occ = baseOccurrence_(task);
  var step = task.steps[stepIndex] || {};
  occ.stepIndex = stepIndex;
  occ.title = goalStepTitle_(task, step, stepIndex);
  occ.photoRequired = effectiveStepPhotoRequired_(task, step);
  occ.remindDaily = goalRemindDaily_(task);
  occ.dueAt = "";
  occ.meta = { stepId: step.id || "" };
  return occ;
}

// ---------------------------------------------------------------- views

/**
 * The derived, human-facing status of an occurrence at a moment in time.
 * "Overdue" only ever exists here — it is never written to the sheet.
 */
function occurrenceDisplayStatus_(occ, nowMs) {
  if (occ.status === TASK_STATUS_COMPLETED) return "Completed";
  if (occ.status === TASK_STATUS_CANCELLED) return "Cancelled";
  if (occ.status === TASK_STATUS_SKIPPED) return "Skipped";
  if (occ.status === TASK_STATUS_WAITING) return "WaitingProof";
  if (occ.dueAt !== "" && isFinite(occ.dueAt) && nowMs > occ.dueAt) return "Overdue";
  return "Open";
}

function decorateOccurrence_(occ, nowMs) {
  var display = occurrenceDisplayStatus_(occ, nowMs);
  var view = {
    id: occ.id,
    taskId: occ.taskId,
    taskType: occ.taskType,
    title: occ.title,
    dateKey: occ.dateKey,
    stepIndex: occ.stepIndex,
    responsible: occ.responsible,
    priority: occ.priority,
    photoRequired: occ.photoRequired,
    reminderTimes: occ.reminderTimes,
    status: occ.status,
    displayStatus: display,
    isOverdue: display === "Overdue",
    dueAt: occ.dueAt,
    dueLabel: occ.dueAt !== "" && isFinite(occ.dueAt) ? formatTaskInstant_(occ.dueAt)
      : (occ.dateKey ? formatTaskDateKey_(occ.dateKey) : ""),
    completedAt: occ.completedAt,
    completedByName: occ.completedByName,
    onTime: occ.onTime,
    lateMs: occ.lateMs,
    lateLabel: occ.lateMs !== "" && Number(occ.lateMs) > 0 ? formatTaskDuration_(occ.lateMs) : "",
    msgId: occ.msgId,
    hasProof: !!occ.proofFileId
  };
  return view;
}

/** Streak and completion rate for one routine, over its materialised history. */
function routineStats_(occurrences, nowMs) {
  var todayKey = taskTodayKey_(nowMs);
  var past = [];
  for (var i = 0; i < occurrences.length; i++) {
    var o = occurrences[i];
    if (!o.dateKey || o.dateKey > todayKey) continue;
    // Today is not a miss until it is actually late. An open day that still has
    // hours left on the clock is neither a success nor a failure, so it neither
    // extends the streak nor ends it.
    if (o.dateKey === todayKey &&
        (o.status === TASK_STATUS_OPEN || o.status === TASK_STATUS_WAITING) &&
        occurrenceDisplayStatus_(o, nowMs) !== "Overdue") continue;
    past.push(o);
  }
  past.sort(function (a, b) { return a.dateKey < b.dateKey ? 1 : (a.dateKey > b.dateKey ? -1 : 0); });

  var completed = 0;
  var counted = 0;
  var streak = 0;
  var streakBroken = false;
  for (var j = 0; j < past.length; j++) {
    var status = past[j].status;
    if (status === TASK_STATUS_SKIPPED) continue; // neutral: neither helps nor breaks
    if (status === TASK_STATUS_COMPLETED) {
      completed++; counted++;
      if (!streakBroken) streak++;
    } else {
      counted++;
      streakBroken = true; // an open/overdue past day ends the streak
    }
  }
  return {
    streak: streak,
    completed: completed,
    counted: counted,
    completionRate: counted > 0 ? Math.round((completed / counted) * 100) : null
  };
}

/** Goal progress: fraction of its step-occurrences that are completed. */
function goalProgress_(occurrences) {
  var total = 0;
  var done = 0;
  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    if (occ.stepIndex === "") continue;
    if (occ.meta && occ.meta.removedStep) continue;      // history, not current scope
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;
    total++;
    if (occ.status === TASK_STATUS_COMPLETED) done++;
  }
  return { done: done, total: total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * Everything the /tasks UI renders, computed for a moment in Tashkent time.
 * The Today view is split into what needs attention now, what is overdue,
 * what is coming up and what was completed today.
 */
function buildTaskViews_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);
  var tasks = readTaskRows_(doc);
  var occurrences = readOccurrenceRows_(doc);

  var taskById = {};
  for (var t = 0; t < tasks.length; t++) taskById[tasks[t].id] = tasks[t];

  var overdue = [];
  var dueToday = [];
  var waitingProof = [];
  var upcoming = [];
  var completedToday = [];

  var horizonKey = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);

  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    // Goal steps stay in the Maqsadlar tab, by progress. Bugun is reserved for
    // dated work, and a step has no date - this is the documented rule, not an
    // oversight. They are still announced to the group by the scheduler.
    if (occ.taskType === "goal") continue;
    var view = decorateOccurrence_(occ, now);

    if (occ.status === TASK_STATUS_COMPLETED) {
      var cp = occ.completedAt ? taskTzParts_(Date.parse(occ.completedAt)).dateKey : "";
      if (cp === todayKey) completedToday.push(view);
      continue;
    }
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;

    if (view.displayStatus === "Overdue") { overdue.push(view); continue; }
    if (occ.status === TASK_STATUS_WAITING) { waitingProof.push(view); continue; }

    // Open and not overdue.
    var key = occ.dateKey || todayKey;
    if (key <= todayKey) dueToday.push(view);
    else if (key <= horizonKey) upcoming.push(view);
    else upcoming.push(view);
  }

  var byPriorityThenDue = function (a, b) {
    var pr = TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority);
    if (pr !== 0) return pr;
    var ad = a.dueAt === "" ? Infinity : a.dueAt;
    var bd = b.dueAt === "" ? Infinity : b.dueAt;
    return ad - bd;
  };
  overdue.sort(function (a, b) { return (a.dueAt || 0) - (b.dueAt || 0); });
  dueToday.sort(byPriorityThenDue);
  upcoming.sort(function (a, b) {
    return String(a.dateKey || "").localeCompare(String(b.dateKey || "")) || byPriorityThenDue(a, b);
  });
  completedToday.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });

  var taskSummaries = tasks.map(function (task) {
    var taskOccs = occurrencesForTask_(occurrences, task.id);
    var summary = {
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      responsible: task.responsible,
      priority: task.priority,
      photoRequired: task.photoRequired,
      status: task.status,
      reminderTimes: task.reminderTimes,
      remindDaily: task.remindDaily,
      dueTime: task.dueTime,
      deadlineKey: task.deadlineKey,
      deadlineTime: task.deadlineTime,
      startKey: task.startKey,
      endKey: task.endKey,
      recurrence: task.recurrence,
      recurrenceLabel: describeRecurrence_(task),
      steps: task.steps,
      createdAt: task.createdAt
    };
    if (task.type === "routine") {
      summary.stats = routineStats_(taskOccs, now);
      var todayOcc = null;
      for (var o = 0; o < taskOccs.length; o++) if (taskOccs[o].dateKey === todayKey) todayOcc = taskOccs[o];
      summary.todayOccurrence = todayOcc ? decorateOccurrence_(todayOcc, now) : null;
    }
    if (task.type === "goal") {
      summary.progress = goalProgress_(taskOccs);
      summary.stepOccurrences = taskOccs
        .filter(function (o) { return o.stepIndex !== "" && !(o.meta && o.meta.removedStep); })
        .sort(function (a, b) { return Number(a.stepIndex) - Number(b.stepIndex); })
        .map(function (o) { return decorateOccurrence_(o, now); });
    }
    if (task.type === "once") {
      var once = taskOccs[0];
      if (once) summary.occurrence = decorateOccurrence_(once, now);
    }
    return summary;
  });

  // A recent-completed feed for the Completed tab: newest first, capped.
  var recentCompleted = [];
  for (var rc = 0; rc < occurrences.length; rc++) {
    if (occurrences[rc].status === TASK_STATUS_COMPLETED) recentCompleted.push(occurrences[rc]);
  }
  recentCompleted.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });
  recentCompleted = recentCompleted.slice(0, 50).map(function (o) { return decorateOccurrence_(o, now); });

  return {
    todayKey: todayKey,
    nowLabel: formatTaskInstant_(now),
    today: {
      overdue: overdue,
      needsAttention: dueToday,
      waitingProof: waitingProof,
      upcoming: upcoming,
      completedToday: completedToday
    },
    recentCompleted: recentCompleted,
    tasks: taskSummaries,
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      waitingProof: waitingProof.length,
      upcoming: upcoming.length,
      completedToday: completedToday.length
    }
  };
}

/** A short human description of a routine's cadence, in Uzbek. */
function describeRecurrence_(task) {
  if (task.type !== "routine") return "";
  var r = task.recurrence || {};
  var weekdayNames = ["Yak", "Du", "Se", "Chor", "Pay", "Jum", "Shan"];
  if (r.freq === "daily") return r.interval > 1 ? ("Har " + r.interval + " kunda") : "Har kuni";
  if (r.freq === "weekly") {
    var days = (r.weekdays && r.weekdays.length ? r.weekdays : [taskWeekdayOfKey_(task.startKey)])
      .map(function (d) { return weekdayNames[d] || d; }).join(", ");
    return (r.interval > 1 ? ("Har " + r.interval + " haftada: ") : "Har hafta: ") + days;
  }
  if (r.freq === "monthly") {
    var day = r.monthDay === "last" ? "oxirgi kuni" : (r.monthDay + "-kuni");
    return (r.interval > 1 ? ("Har " + r.interval + " oyda ") : "Har oy ") + day;
  }
  if (r.freq === "custom") return "Har " + r.intervalDays + " kunda";
  return "";
}
