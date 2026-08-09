// ============================================================
// Tasks — scheduler, jobs and web API
// ------------------------------------------------------------
// Reuses the existing Omad_Job_Queue for every Telegram send, so a task
// message inherits the same claim-under-lock, exponential backoff and
// deduplication as the accounting reports. The scheduler only ever *decides*
// what is due and enqueues it; the queue does the sending.
//
// Duplicate protection is layered:
//   * a reminder slot is marked sent the moment it is enqueued (under the
//     script lock), so a second scheduler pass — or one that overlaps — cannot
//     enqueue it again, and a completed occurrence never re-fires;
//   * the queue itself refuses a second identical pending job.
// ============================================================

var TASK_REMINDER_MAX_LATE_MS = 3 * 60 * 60 * 1000; // don't blast reminders missed by >3h

function enqueueTaskJob_(doc, type, relatedId, payload) {
  return enqueueJob_(doc, type, relatedId, payload || {});
}

function isTaskJobType_(type) {
  return type === "task_notify" || type === "task_reminder" || type === "task_update_message";
}

function runTaskJob_(doc, job) {
  if (job.type === "task_notify") return runTaskNotifyJob_(doc, job);
  if (job.type === "task_reminder") return runTaskReminderJob_(doc, job);
  if (job.type === "task_update_message") return runTaskUpdateMessageJob_(doc, job);
  throw new Error("Unknown task job type: " + job.type);
}

function runTaskNotifyJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return; // deleted before it went out

  // If it already reached an end state before the card was sent, send the
  // status card (no button) rather than a stale "new task" with a live button.
  if (occ.status !== TASK_STATUS_OPEN) {
    var response = sendTelegramMessage_(chatId, buildTaskStatusMessage_(occ, Date.now()), taskClearedMarkup_());
    var doneId = extractTelegramMessageId_(response);
    if (doneId && !occ.msgId) { occ.msgId = String(doneId); writeOccurrenceRow_(doc, occ); }
    return;
  }

  var sent = sendTelegramMessage_(chatId, buildTaskOccurrenceMessage_(occ), taskDoneMarkup_(occ.id));
  var msgId = extractTelegramMessageId_(sent);
  if (msgId) { occ.msgId = String(msgId); writeOccurrenceRow_(doc, occ); }
}

function runTaskReminderJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  // Completion (or cancellation/skip) between enqueue and send stops the ping.
  if (occ.status !== TASK_STATUS_OPEN) return;

  sendTelegramMessage_(chatId, buildTaskReminderMessage_(occ), taskDoneMarkup_(occ.id));
}

function runTaskUpdateMessageJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ || !occ.msgId) return;

  var isEndState = occ.status === TASK_STATUS_COMPLETED || occ.status === TASK_STATUS_CANCELLED ||
    occ.status === TASK_STATUS_SKIPPED;
  editTelegramMessage_(chatId, occ.msgId, buildTaskStatusMessage_(occ, Date.now()),
    isEndState ? taskClearedMarkup_() : taskDoneMarkup_(occ.id));
}

// ---------------------------------------------------------------- scheduler

/** Which reminder dates apply to an occurrence right now. */
function taskReminderDatesFor_(occ, todayKey) {
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  if (occ.remindDaily) return [todayKey];       // rolling daily for no-deadline tasks
  return [];
}

/**
 * The full scheduler pass: materialise due occurrences, announce new ones and
 * fire any reminders that have come due. Everything mutating runs under the
 * script lock so two passes cannot double-send.
 */
function runTaskScheduler_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (error) { return { notified: 0, reminders: 0, generated: 0 }; }

  var generated = 0;
  var notified = 0;
  var reminders = 0;
  try {
    var tasks = readTaskRows_(doc);
    for (var t = 0; t < tasks.length; t++) {
      if (tasks[t].status === TASK_DEF_ACTIVE) {
        generated += materializeTaskOccurrences_(doc, tasks[t], now).length;
      }
    }

    var occurrences = readOccurrenceRows_(doc);
    for (var i = 0; i < occurrences.length; i++) {
      var occ = occurrences[i];
      if (occ.taskType === "goal") continue;

      // Announce.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN) {
        var due = occ.taskType === "once" || (occ.dateKey && occ.dateKey <= todayKey);
        if (due) {
          enqueueTaskJob_(doc, "task_notify", occ.id, { occurrenceId: occ.id });
          occ.notifiedAt = new Date(now).toISOString();
          writeOccurrenceRow_(doc, occ);
          notified++;
        }
      }

      // Remind.
      if (occ.status === TASK_STATUS_OPEN && occ.reminderTimes.length) {
        var dates = taskReminderDatesFor_(occ, todayKey);
        var changed = false;
        for (var d = 0; d < dates.length; d++) {
          for (var r = 0; r < occ.reminderTimes.length; r++) {
            var slotKey = dates[d] + " " + occ.reminderTimes[r];
            if (occ.remindersSent[slotKey]) continue;
            var instant = taskInstantMs_(dates[d], occ.reminderTimes[r]);
            if (!isFinite(instant) || now < instant) continue;
            if (now - instant <= TASK_REMINDER_MAX_LATE_MS) {
              enqueueTaskJob_(doc, "task_reminder", occ.id, { occurrenceId: occ.id, slot: slotKey });
              reminders++;
            } else {
              debugLog_(doc, "task_reminder_skipped_stale", occ.id + " " + slotKey);
            }
            occ.remindersSent[slotKey] = new Date(now).toISOString();
            changed = true;
          }
        }
        if (changed) writeOccurrenceRow_(doc, occ);
      }
    }
  } finally {
    lock.releaseLock();
  }

  return { notified: notified, reminders: reminders, generated: generated };
}

/** Time-driven trigger entry point (see docs). Scans, then drains the queue. */
function processTaskSchedules() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  runTaskScheduler_(doc, Date.now());
  return processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
}

// ---------------------------------------------------------------- web API

function isTaskReadAction_(action) {
  return action === "get_tasks";
}

function isTaskMutationAction_(action) {
  return action === "save_task" || action === "cancel_task" ||
    action === "pause_routine" || action === "resume_routine" ||
    action === "skip_occurrence" || action === "complete_occurrence" ||
    action === "reopen_occurrence";
}

function isTaskAction_(action) {
  return isTaskReadAction_(action) || isTaskMutationAction_(action);
}

function handleTaskAction_(action, payload, doc) {
  if (isTaskReadAction_(action)) {
    return jsonOutput_({
      status: "success",
      view: buildTaskViews_(doc, Date.now()),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  var adminError = checkAdminKey_(payload);
  if (adminError) return jsonOutput_({ status: "error", message: adminError });

  var result;
  if (action === "save_task") result = saveTaskAction_(doc, payload);
  else if (action === "cancel_task") result = cancelTaskAction_(doc, payload);
  else if (action === "pause_routine") result = setRoutinePausedAction_(doc, payload, true);
  else if (action === "resume_routine") result = setRoutinePausedAction_(doc, payload, false);
  else if (action === "skip_occurrence") result = skipOccurrenceAction_(doc, payload);
  else if (action === "complete_occurrence") result = completeOccurrenceAction_(doc, payload);
  else result = reopenOccurrenceAction_(doc, payload);

  if (result.status === "success") {
    recordLastOperation_(doc, action);
    // Announce/refresh promptly, then let the trigger handle the rest.
    try { runTaskScheduler_(doc, Date.now()); } catch (error) { debugLog_(doc, "task_scheduler_inline_failed", String(error)); }
    drainJobQueueQuietly_(doc, payload);
    result.view = buildTaskViews_(doc, Date.now());
    result.config = { tasksGroupConfigured: !!getTasksGroupChatId_() };
  }
  return jsonOutput_(result);
}

/** Builds a validated task object from a web payload. Returns {task} or {error}. */
function normalizeTaskInput_(payload, existing) {
  var type = TASK_TYPES.indexOf(String(payload.type)) !== -1 ? String(payload.type) : (existing ? existing.type : "");
  if (TASK_TYPES.indexOf(type) === -1) return { error: "Vazifa turi noto'g'ri." };

  var title = String(payload.title || (existing ? existing.title : "")).trim();
  if (!title) return { error: "Sarlavha kiritilmagan." };
  if (title.length > 200) return { error: "Sarlavha juda uzun." };

  var nowIso = new Date().toISOString();
  var task = {
    id: existing ? existing.id : ("task_" + Utilities.getUuid().split("-").join("")),
    type: type,
    title: title,
    description: String(payload.description || (existing ? existing.description : "")).slice(0, 2000),
    responsible: String(payload.responsible || (existing ? existing.responsible : "")).slice(0, 200),
    priority: normalizeTaskPriority_(payload.priority !== undefined ? payload.priority : (existing ? existing.priority : "normal")),
    photoRequired: payload.photoRequired !== undefined ? !!payload.photoRequired : (existing ? existing.photoRequired : false),
    reminderTimes: normalizeTaskTimes_(payload.reminderTimes !== undefined ? payload.reminderTimes : (existing ? existing.reminderTimes : [])),
    remindDaily: payload.remindDaily !== undefined ? !!payload.remindDaily : (existing ? existing.remindDaily : false),
    dueTime: "",
    deadlineKey: "",
    deadlineTime: "",
    startKey: "",
    endKey: "",
    status: existing ? existing.status : TASK_DEF_ACTIVE,
    steps: [],
    recurrence: {},
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso,
    createdBy: existing ? existing.createdBy : String(payload.createdBy || "admin"),
    meta: existing ? existing.meta : {}
  };

  if (type === "once") {
    if (payload.deadlineKey && !isTaskDateKey_(payload.deadlineKey)) return { error: "Muddat sanasi noto'g'ri." };
    if (payload.deadlineTime && !isTaskTimeKey_(payload.deadlineTime)) return { error: "Muddat vaqti noto'g'ri." };
    task.deadlineKey = isTaskDateKey_(payload.deadlineKey) ? String(payload.deadlineKey) : "";
    task.deadlineTime = isTaskTimeKey_(payload.deadlineTime) ? String(payload.deadlineTime) : "";
  } else if (type === "routine") {
    task.recurrence = normalizeTaskRecurrence_(payload.recurrence);
    task.startKey = isTaskDateKey_(payload.startKey) ? String(payload.startKey) : (existing && existing.startKey ? existing.startKey : taskTodayKey_(Date.now()));
    if (payload.endKey && !isTaskDateKey_(payload.endKey)) return { error: "Tugash sanasi noto'g'ri." };
    task.endKey = isTaskDateKey_(payload.endKey) ? String(payload.endKey) : "";
    if (task.endKey && task.endKey < task.startKey) return { error: "Tugash sanasi boshlanish sanasidan oldin." };
    task.dueTime = isTaskTimeKey_(payload.dueTime) ? String(payload.dueTime) : "";
  } else if (type === "goal") {
    task.steps = normalizeGoalSteps_(payload.steps);
    if (task.steps.length === 0) return { error: "Maqsad uchun kamida bitta qadam kiriting." };
  }

  return { task: task };
}

function saveTaskAction_(doc, payload) {
  var existing = payload.id ? findTask_(doc, payload.id) : null;
  if (payload.id && !existing) return { status: "error", message: "Vazifa topilmadi." };

  var normalized = normalizeTaskInput_(payload, existing);
  if (normalized.error) return { status: "error", message: normalized.error };
  var task = normalized.task;

  if (existing) {
    task.rowNumber = existing.rowNumber;
    updateTaskRow_(doc, task);
    // Re-plan the future: drop not-yet-sent upcoming occurrences so an edited
    // schedule takes effect, while completed/announced history is preserved.
    if (task.type === "routine") pruneReplaceableRoutineOccurrences_(doc, task.id, taskTodayKey_(Date.now()));
    appendAuditRow_(doc, "task_updated", task.id + " " + task.type);
  } else {
    appendTaskRow_(doc, task);
    appendAuditRow_(doc, "task_created", task.id + " " + task.type);
  }

  materializeTaskOccurrences_(doc, task, Date.now());
  return { status: "success", taskId: task.id };
}

/** Removes upcoming routine occurrences that have neither been sent nor acted on. */
function pruneReplaceableRoutineOccurrences_(doc, taskId, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(taskId) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId &&
      occ.dateKey && occ.dateKey > todayKey;
  });
}

function deleteOccurrenceRowsWhere_(doc, predicate) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var rows = readOccurrenceRows_(doc);
  var toDelete = [];
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) toDelete.push(rows[i].rowNumber);
  toDelete.sort(function (a, b) { return b - a; }); // bottom-up so row numbers stay valid
  for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
  return toDelete.length;
}

function cancelTaskAction_(doc, payload) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  task.status = TASK_DEF_CANCELLED;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
  appendAuditRow_(doc, "task_cancelled", task.id);
  return { status: "success" };
}

function setRoutinePausedAction_(doc, payload, paused) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  if (task.type !== "routine") return { status: "error", message: "Faqat takrorlanuvchi vazifani to'xtatish mumkin." };
  if (task.status === TASK_DEF_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  task.status = paused ? TASK_DEF_PAUSED : TASK_DEF_ACTIVE;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);
  appendAuditRow_(doc, paused ? "routine_paused" : "routine_resumed", task.id);
  return { status: "success" };
}

function skipOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "error", message: "Allaqachon bajarilgan." };
  occ.status = TASK_STATUS_SKIPPED;
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  appendAuditRow_(doc, "task_occurrence_skipped", occ.id);
  return { status: "success" };
}

function completeOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "success" }; // idempotent
  if (occ.status === TASK_STATUS_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  completeTaskOccurrence_(doc, occ, {
    byId: "",
    byName: String(payload.completedBy || "Admin (panel)"),
    source: "web"
  });
  return { status: "success" };
}

function reopenOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  occ.status = TASK_STATUS_OPEN;
  occ.completedById = "";
  occ.completedByName = "";
  occ.completedAt = "";
  occ.onTime = "";
  occ.lateMs = "";
  occ.proofFileId = "";
  occ.proofMsgId = "";
  occ.proofAwaitingUserId = "";
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  if (occ.taskType === "goal") {
    var task = findTask_(doc, occ.taskId);
    if (task && task.status === TASK_DEF_COMPLETED) {
      task.status = TASK_DEF_ACTIVE;
      task.updatedAt = new Date().toISOString();
      updateTaskRow_(doc, task);
    }
  }
  appendAuditRow_(doc, "task_occurrence_reopened", occ.id);
  return { status: "success" };
}
