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
//
// That layering is what lets the production trigger do the whole cycle in one
// tick (processPendingTelegramJobs: scan, enqueue, drain) while the manual
// processTaskSchedules entry point stays available: running both, in any order
// and any number of times, cannot produce a second reminder.
// ============================================================

var TASK_REMINDER_MAX_LATE_MS = 3 * 60 * 60 * 1000; // don't blast reminders missed by >3h
var TASK_PROOF_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;  // a claim whose prompt never went out
// How many days of "already reminded" markers a rolling-daily occurrence keeps.
// Long enough that nothing the scheduler still consults can be dropped, short
// enough that Reminders_Sent_JSON stays far inside one spreadsheet cell.
var TASK_REMINDER_HISTORY_DAYS = 14;

function enqueueTaskJob_(doc, type, relatedId, payload) {
  return enqueueJob_(doc, type, relatedId, payload || {});
}

function isTaskJobType_(type) {
  return type === "task_notify" || type === "task_reminder" ||
    type === "task_update_message" || type === "task_proof_prompt";
}

function runTaskJob_(doc, job) {
  if (job.type === "task_notify") return runTaskNotifyJob_(doc, job);
  if (job.type === "task_reminder") return runTaskReminderJob_(doc, job);
  if (job.type === "task_update_message") return runTaskUpdateMessageJob_(doc, job);
  if (job.type === "task_proof_prompt") return runTaskProofPromptJob_(doc, job);
  throw new Error("Unknown task job type: " + job.type);
}

/**
 * Asks the user who claimed a photo-proof task to reply with the photo.
 *
 * ForceReply with `selective` plus a mention targets exactly that person, so
 * the reply the group is asked for is unambiguous and the photo that comes
 * back can be matched to this prompt and no other. Sending it as a job means a
 * Telegram outage retries with the queue's backoff instead of leaving the
 * occurrence waiting for a message that was never delivered.
 */
function runTaskProofPromptJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  if (occ.status !== TASK_STATUS_WAITING) return;                                  // already resolved
  if (String(occ.proofAwaitingUserId) !== String(job.payload.userId || "")) return; // superseded

  var sent = sendTelegramMessage_(
    chatId,
    buildTaskProofPromptMessage_(occ, job.payload),
    { force_reply: true, selective: true },
    "HTML",
    { replyToMessageId: occ.msgId }
  );
  var promptId = extractTelegramMessageId_(sent);
  if (promptId) {
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = String(promptId);
    writeOccurrenceRow_(doc, occ);
  }
}

/**
 * Puts an occurrence back the way it was when the prompt asking for its photo
 * could not be delivered. Waiting for a photo nobody was ever asked for is a
 * lie the group cannot act on.
 */
function releaseStuckProofPrompt_(doc, job) {
  var occ = findOccurrence_(doc, String((job.payload || {}).occurrenceId || ""));
  if (!occ || occ.status !== TASK_STATUS_WAITING) return;
  if (occ.meta && occ.meta.proofPromptMsgId) return;   // it did go out
  occ.status = TASK_STATUS_OPEN;
  occ.proofAwaitingUserId = "";
  occ.completedByName = "";
  occ.meta = occ.meta || {};
  occ.meta.proofPromptMsgId = "";
  occ.meta.proofRequestedAt = "";
  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_proof_prompt_released", occ.id);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
}

function runTaskNotifyJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return; // deleted before it went out

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var notifyTask = findTask_(doc, occ.taskId);
  if (notifyTask && (notifyTask.status === TASK_DEF_PAUSED || notifyTask.status === TASK_DEF_CANCELLED)) return;

  // The card carries the task's brief; the lookup above already has it, so this
  // costs nothing extra. Cards are HTML so a long description can be collapsed.
  var notifyDescription = notifyTask ? notifyTask.description : "";

  // If it already reached an end state before the card was sent, send the
  // status card (no button) rather than a stale "new task" with a live button.
  if (occ.status !== TASK_STATUS_OPEN) {
    var response = sendTelegramMessage_(chatId,
      buildTaskStatusMessage_(occ, Date.now(), notifyDescription), taskClearedMarkup_(), "HTML");
    var doneId = extractTelegramMessageId_(response);
    if (doneId && !occ.msgId) { occ.msgId = String(doneId); writeOccurrenceRow_(doc, occ); }
    return;
  }

  var sent = sendTelegramMessage_(chatId,
    buildTaskOccurrenceMessage_(occ, notifyDescription), taskDoneMarkup_(occ.id), "HTML");
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

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var remindTask = findTask_(doc, occ.taskId);
  if (remindTask && (remindTask.status === TASK_DEF_PAUSED || remindTask.status === TASK_DEF_CANCELLED)) return;

  sendTelegramMessage_(chatId,
    buildTaskReminderMessage_(occ, remindTask ? remindTask.description : ""),
    taskDoneMarkup_(occ.id), "HTML");
}

function runTaskUpdateMessageJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ || !occ.msgId) return;

  // The button is live only while the task is genuinely open. While a proof is
  // pending it belongs to one person, and pressing it again is not how they
  // deliver it.
  var showButton = occ.status === TASK_STATUS_OPEN;
  // Matches the parse mode the card was first sent with; an edit that dropped
  // HTML would show the markup as literal text.
  var updateTask = findTask_(doc, occ.taskId);
  editTelegramMessage_(chatId, occ.msgId,
    buildTaskStatusMessage_(occ, Date.now(), updateTask ? updateTask.description : ""),
    showButton ? taskDoneMarkup_(occ.id) : taskClearedMarkup_(), "HTML");
}

// ---------------------------------------------------------------- scheduler

/**
 * Whether the scheduler may still speak for a task. A paused routine must not
 * announce or remind - not even for the occurrences that were already
 * materialised on to the sheet before it was paused - and an occurrence whose
 * definition has gone is not something to keep pinging a group about.
 */
function isTaskSendable_(taskStatus) {
  return taskStatus === TASK_DEF_ACTIVE;
}

/** True when any reminder slot has already been acted on for this occurrence. */
function hasAnyReminderSent_(occ) {
  var sent = occ.remindersSent || {};
  for (var key in sent) if (Object.prototype.hasOwnProperty.call(sent, key)) return true;
  return false;
}

/**
 * Whether an occurrence's reminder times roll forward day by day rather than
 * belonging to one fixed calendar day.
 *
 * Two things roll: a one-time task the admin asked to be reminded about daily
 * ("har kuni, vazifa bajarilguncha"), and anything with no date at all — a
 * goal step, or a deadline-less one-time task. A routine does not: each of its
 * days is a separate occurrence that owns its own reminders, so rolling them
 * would mean reminding about Monday's work on Tuesday.
 */
function taskRemindsDaily_(occ) {
  return !!occ.remindDaily && (occ.taskType === "once" || !occ.dateKey);
}

/**
 * Which reminder dates apply to an occurrence right now.
 *
 * A rolling occurrence is always reminded about *today* — whether its deadline
 * is still days away, is today, or went past weeks ago — and stops the moment
 * the occurrence leaves Open. On the deadline day today's key *is* the
 * occurrence's dateKey, so it resolves to the same slot either way and the
 * sent-marker still deduplicates it.
 *
 * Everything else keeps a single fixed day: the routine's day, or the one-time
 * task's deadline when daily reminders were not asked for.
 */
function taskReminderDatesFor_(occ, todayKey) {
  if (taskRemindsDaily_(occ)) return [todayKey];
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  return [];
}

/**
 * Drops sent-markers for days the scheduler will never look at again.
 *
 * A rolling occurrence writes one marker per reminder time per day for as long
 * as it stays open, and `Reminders_Sent_JSON` is a single spreadsheet cell. Only
 * days older than the retention window are dropped, and never the occurrence's
 * own dateKey, so no marker that is still consulted can be removed and no
 * reminder can be revived by pruning.
 */
function pruneReminderMarkers_(occ, todayKey) {
  var cutoff = taskDateKeyAddDays_(todayKey, -TASK_REMINDER_HISTORY_DAYS);
  if (!cutoff) return false;
  var sent = occ.remindersSent || {};
  var dropped = false;
  for (var slotKey in sent) {
    if (!Object.prototype.hasOwnProperty.call(sent, slotKey)) continue;
    var dateKey = slotKey.split(" ")[0];
    if (dateKey === occ.dateKey || dateKey >= cutoff) continue;
    delete sent[slotKey];
    dropped = true;
  }
  return dropped;
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
    var statusByTaskId = {};
    for (var t = 0; t < tasks.length; t++) statusByTaskId[tasks[t].id] = tasks[t].status;

    // One scan of the occurrence sheet for the whole pass, and one append for
    // everything it decides to create. A daily routine used to cost a full
    // scan per task, every five minutes, for ever.
    var ctx = { occurrences: readOccurrenceRows_(doc), pending: [] };
    for (var g = 0; g < tasks.length; g++) {
      if (tasks[g].status === TASK_DEF_ACTIVE) {
        generated += materializeTaskOccurrences_(doc, tasks[g], now, ctx).length;
      }
    }
    if (ctx.pending.length) appendOccurrenceRows_(doc, ctx.pending);

    // Includes what was just appended, with the row numbers assigned to those
    // very objects - so a writeOccurrenceRow_ later in this pass lands on the
    // right row.
    var occurrences = ctx.occurrences;
    for (var i = 0; i < occurrences.length; i++) {
      var occ = occurrences[i];

      // A paused (or cancelled, or orphaned) definition goes quiet immediately,
      // including for occurrences that were materialised before the pause.
      if (!isTaskSendable_(statusByTaskId[occ.taskId])) continue;

      // Backstop: a claim whose prompt never made it out, and whose job is gone
      // (queue row purged, script killed mid-flight). 30 minutes is comfortably
      // past the queue's own retry ladder, so this never races it.
      if (occ.status === TASK_STATUS_WAITING && !(occ.meta && occ.meta.proofPromptMsgId)) {
        var requestedAt = Date.parse((occ.meta && occ.meta.proofRequestedAt) || "") || 0;
        if (requestedAt && now - requestedAt > TASK_PROOF_PROMPT_TIMEOUT_MS) {
          releaseStuckProofPrompt_(doc, { payload: { occurrenceId: occ.id } });
          continue;
        }
      }

      // Announce.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN) {
        // A goal step and a deadline-less one-time task are the same thing to
        // the group: something to do now, with no date attached.
        var due = occ.taskType === "once" || occ.taskType === "goal" ||
          (occ.dateKey && occ.dateKey <= todayKey);
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
        // A rolling occurrence accumulates a marker a day; trim the ones no
        // date list will ever name again before adding today's.
        var changed = taskRemindsDaily_(occ) ? pruneReminderMarkers_(occ, todayKey) : false;
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

/**
 * Manual entry point: scan, then drain the queue.
 *
 * Kept for the operator who wants to force a cycle from the editor, and for
 * any trigger created before `processPendingTelegramJobs` absorbed the scan.
 * It is no longer required as a second production trigger, and running it
 * alongside one cannot duplicate anything.
 */
function processTaskSchedules() {
  resetRequestMemos_();
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  runTaskScheduler_(doc, Date.now());
  return processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
}

// ---------------------------------------------------------------- web API

// The panel does one read per load and one per mutation, so this is generous
// for the admin and mean to anyone guessing keys.
var TASK_READ_RATE_LIMIT = 30;

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
    // The task board is internal company information: who is responsible for
    // what, when it is due, and who has been missing deadlines. It is gated
    // like a mutation, and throttled before the key is compared so the
    // endpoint cannot be used to guess it.
    var throttled = enforceRateLimit_("tasks_read", TASK_READ_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (throttled) return jsonOutput_({ status: "error", message: throttled });
    var readError = checkAdminKey_(payload);
    if (readError) return jsonOutput_({ status: "error", message: readError });
    return jsonOutput_({
      status: "success",
      view: buildTaskViews_(doc, Date.now()),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  var adminError = checkAdminKey_(payload);
  if (adminError) return jsonOutput_({ status: "error", message: adminError });

  return runTaskAction_(action, payload, doc);
}

/**
 * A task mutation that has already been authorized.
 *
 * Split out so the Mini App can reach exactly this code behind verified
 * Telegram initData instead of the admin key. Everything below the gate — the
 * occurrence bookkeeping, the inline scheduler pass, the group cards — is the
 * same engine for both callers, which is what stops the two surfaces drifting.
 */
function runTaskAction_(action, payload, doc) {
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

/**
 * Whether the caller actually said anything about a field.
 *
 * The difference between "leave this alone" and "clear this" is the whole
 * safety of an edit. A payload that never mentions `recurrence` is a client
 * editing a title; a payload carrying `recurrence: null` is a client asking
 * for a default. Only the second may overwrite what is stored.
 */
function taskFieldSupplied_(payload, field) {
  return !!payload && Object.prototype.hasOwnProperty.call(payload, field) &&
    payload[field] !== undefined;
}

/** Builds a validated task object from a web payload. Returns {task} or {error}. */
function normalizeTaskInput_(payload, existing) {
  // The type decides which columns mean anything and what an occurrence even
  // is. There is no safe migration from one shape to another - a once-task's
  // single occurrence and a routine's dated history are not interchangeable -
  // so an existing task keeps the type it was created with.
  var type = existing ? existing.type : (TASK_TYPES.indexOf(String(payload.type)) !== -1 ? String(payload.type) : "");
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
    // Bounded the way 14_ledger.gs already bounds the same concept.
    createdBy: existing ? existing.createdBy : String(payload.createdBy || "admin").slice(0, 120),
    // A new task may carry caller metadata; the Telegram wizard uses it for the
    // durable idempotency key it has no Request_ID column for. An edit keeps
    // whatever the row already had, so the web UI — which sends neither field —
    // behaves exactly as before.
    meta: existing ? existing.meta
      : (payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta) ? payload.meta : {})
  };

  // Schedule fields fall back to what is stored whenever the caller did not
  // mention them. Without this, editing a title through any client that sends
  // only the fields it shows silently rewrote the schedule: a weekly Monday
  // routine came back daily, and a deadline came back empty, because an absent
  // field and a cleared field were treated identically.
  var keep = function (field, fallback) {
    return taskFieldSupplied_(payload, field) ? payload[field] : fallback;
  };

  if (type === "once") {
    var deadlineKey = keep("deadlineKey", existing ? existing.deadlineKey : "");
    var deadlineTime = keep("deadlineTime", existing ? existing.deadlineTime : "");
    if (deadlineKey && !isTaskDateKey_(deadlineKey)) return { error: "Muddat sanasi noto'g'ri." };
    if (deadlineTime && !isTaskTimeKey_(deadlineTime)) return { error: "Muddat vaqti noto'g'ri." };
    task.deadlineKey = isTaskDateKey_(deadlineKey) ? String(deadlineKey) : "";
    task.deadlineTime = isTaskTimeKey_(deadlineTime) ? String(deadlineTime) : "";
  } else if (type === "routine") {
    // An edit that does not mention the cadence keeps the cadence. Sending
    // `recurrence` explicitly still replaces it, so the web editor is
    // unchanged.
    task.recurrence = taskFieldSupplied_(payload, "recurrence")
      ? normalizeTaskRecurrence_(payload.recurrence)
      : (existing && existing.recurrence && existing.recurrence.freq
        ? normalizeTaskRecurrence_(existing.recurrence)
        : normalizeTaskRecurrence_(payload.recurrence));

    task.startKey = isTaskDateKey_(payload.startKey) ? String(payload.startKey) : (existing && existing.startKey ? existing.startKey : taskTodayKey_(Date.now()));

    var endKey = keep("endKey", existing ? existing.endKey : "");
    if (endKey && !isTaskDateKey_(endKey)) return { error: "Tugash sanasi noto'g'ri." };
    task.endKey = isTaskDateKey_(endKey) ? String(endKey) : "";
    if (task.endKey && task.endKey < task.startKey) return { error: "Tugash sanasi boshlanish sanasidan oldin." };

    var dueTime = keep("dueTime", existing ? existing.dueTime : "");
    task.dueTime = isTaskTimeKey_(dueTime) ? String(dueTime) : "";
  } else if (type === "goal") {
    task.steps = taskFieldSupplied_(payload, "steps")
      ? normalizeGoalSteps_(payload.steps)
      : (existing ? (existing.steps || []) : []);
    if (task.steps.length === 0) return { error: "Maqsad uchun kamida bitta qadam kiriting." };
  }

  return { task: task };
}

function saveTaskAction_(doc, payload) {
  var existing = payload.id ? findTask_(doc, payload.id) : null;
  if (payload.id && !existing) return { status: "error", message: "Vazifa topilmadi." };
  if (existing && payload.type && String(payload.type) !== existing.type) {
    return { status: "error", message: "Vazifa turini o'zgartirib bo'lmaydi. Yangi vazifa yarating." };
  }

  var normalized = normalizeTaskInput_(payload, existing);
  if (normalized.error) return { status: "error", message: normalized.error };
  var task = normalized.task;
  var nowMs = Date.now();
  var todayKey = taskTodayKey_(nowMs);
  var previousSteps = existing ? (existing.steps || []) : [];

  if (task.type === "goal") task.steps = mergeGoalSteps_(previousSteps, task.steps);

  if (existing) {
    task.rowNumber = existing.rowNumber;
    updateTaskRow_(doc, task);
    if (task.type === "routine") reconcileRoutineOccurrences_(doc, task, todayKey);
    else if (task.type === "once") reconcileOnceOccurrence_(doc, task);
    else reconcileGoalOccurrences_(doc, task, previousSteps);
    appendAuditRow_(doc, "task_updated", task.id + " " + task.type);
  } else {
    appendTaskRow_(doc, task);
    appendAuditRow_(doc, "task_created", task.id + " " + task.type);
  }

  materializeTaskOccurrences_(doc, task, nowMs);
  // Removing the last unfinished step is a completion just as much as ticking
  // it off is.
  if (task.type === "goal") maybeCompleteGoal_(doc, task.id, nowMs);
  return { status: "success", taskId: task.id };
}

/**
 * Pushes an edited one-time task on to the occurrence that is still live.
 *
 * The occurrence is what people actually see and complete; leaving it on the
 * old deadline, the old owner and the old photo rule is the difference between
 * an edit and a lie. History (completed / cancelled / skipped) is never
 * rewritten.
 */
function reconcileOnceOccurrence_(doc, task) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_COMPLETED || occ.status === TASK_STATUS_CANCELLED ||
        occ.status === TASK_STATUS_SKIPPED) continue;

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dateKey = task.deadlineKey || "";
    occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/**
 * Pairs the submitted step list with the steps that already exist, so an
 * occurrence keeps belonging to the same piece of work across an edit.
 *
 * Matching order matters:
 *   1. an id the client sent back - unambiguous;
 *   2. an unchanged title - survives inserting or deleting a step in the middle,
 *      which position alone cannot;
 *   3. the same position - which is what a plain rename looks like once the
 *      unchanged titles have been claimed;
 *   4. anything still unmatched is genuinely new and gets a fresh id.
 */
function mergeGoalSteps_(existingSteps, incomingSteps) {
  var existing = Array.isArray(existingSteps) ? existingSteps : [];
  var incoming = Array.isArray(incomingSteps) ? incomingSteps : [];
  var byId = {};
  var used = {};
  for (var e = 0; e < existing.length; e++) if (existing[e].id) byId[existing[e].id] = existing[e];

  var out = new Array(incoming.length);
  var pending = [];

  for (var i = 0; i < incoming.length; i++) {
    var id = incoming[i].id;
    if (id && byId[id] && !used[id]) { used[id] = true; out[i] = { id: id }; }
    else pending.push(i);
  }
  for (var t = 0; t < pending.length; t++) {
    var ti = pending[t];
    for (var x = 0; x < existing.length; x++) {
      if (!existing[x].id || used[existing[x].id]) continue;
      if (existing[x].title === incoming[ti].title) { used[existing[x].id] = true; out[ti] = { id: existing[x].id }; break; }
    }
  }
  for (var p = 0; p < pending.length; p++) {
    var pi = pending[p];
    if (out[pi]) continue;
    var atPosition = existing[pi];
    if (atPosition && atPosition.id && !used[atPosition.id]) { used[atPosition.id] = true; out[pi] = { id: atPosition.id }; }
  }
  for (var n = 0; n < out.length; n++) {
    if (!out[n]) out[n] = { id: newGoalStepId_() };
    out[n].title = incoming[n].title;
    if (incoming[n].photoRequired !== undefined) out[n].photoRequired = incoming[n].photoRequired;
  }
  return out;
}

/**
 * Re-points a goal's step-occurrences at the edited step list.
 *
 * Completed work is never deleted or re-scored: a step that disappears keeps
 * its row (and its proof, and who did it) and is simply taken out of the
 * goal's progress. An unfinished step that disappears is cancelled, so the
 * group card is withdrawn rather than left hanging.
 */
function reconcileGoalOccurrences_(doc, task, previousSteps) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  var idByOldIndex = {};
  for (var p = 0; p < previousSteps.length; p++) idByOldIndex[p] = previousSteps[p].id || "";
  var newIndexById = {};
  for (var n = 0; n < task.steps.length; n++) newIndexById[task.steps[n].id] = n;

  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.stepIndex === "") continue;
    occ.meta = occ.meta || {};
    var stepId = occ.meta.stepId || idByOldIndex[Number(occ.stepIndex)] || "";
    var newIndex = (stepId && newIndexById[stepId] !== undefined) ? newIndexById[stepId] : undefined;

    if (newIndex === undefined) {
      occ.meta.removedStep = true;
      if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
        occ.status = TASK_STATUS_CANCELLED;
        occ.proofAwaitingUserId = "";
      }
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    var step = task.steps[newIndex];
    occ.meta.stepId = step.id;
    delete occ.meta.removedStep;
    occ.stepIndex = newIndex;
    occ.title = goalStepTitle_(task, step, newIndex);
    if (occ.status !== TASK_STATUS_COMPLETED) {
      occ.responsible = task.responsible || "";
      occ.priority = task.priority || "normal";
      occ.photoRequired = effectiveStepPhotoRequired_(task, step);
      occ.reminderTimes = task.reminderTimes || [];
      occ.remindDaily = goalRemindDaily_(task);
    }
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId && occ.status === TASK_STATUS_OPEN) {
      enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
}

/**
 * Re-plans a routine after an edit.
 *
 * Anything from today forward that nobody has seen is replaced outright, so a
 * changed cadence, owner or due time takes effect. Anything already announced
 * is history in progress: its fields are refreshed in place, and it is only
 * withdrawn when the new schedule no longer contains its day.
 */
function reconcileRoutineOccurrences_(doc, task, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(task.id) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
      occ.dateKey && occ.dateKey >= todayKey;
  });

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (!occ.dateKey || occ.dateKey < todayKey) continue;   // the past is history
    if (occ.status !== TASK_STATUS_OPEN) continue;          // waiting/done/skipped stay put

    if (!routineOccursOnKey_(task.recurrence, task.startKey, task.endKey, occ.dateKey)) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dueAt = task.dueTime ? taskInstantMs_(occ.dateKey, task.dueTime) : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/** Removes upcoming routine occurrences that have neither been sent nor acted on. */
function pruneReplaceableRoutineOccurrences_(doc, taskId, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(taskId) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
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

  if (paused) {
    // Pre-generated days nobody has seen are not history; leaving them on the
    // sheet would keep a paused routine visible in "Kelgusi" and would revive
    // it the moment the guard is bypassed. Announced days, completed days and
    // skipped days are history and stay exactly as they are.
    pruneReplaceableRoutineOccurrences_(doc, task.id, taskTodayKey_(Date.now()));
  }

  appendAuditRow_(doc, paused ? "routine_paused" : "routine_resumed", task.id);
  return { status: "success" };
}

/** An occurrence dated after today - work that has not come round yet. */
function isFutureOccurrence_(occ, todayKey) {
  return !!occ.dateKey && occ.dateKey > todayKey;
}

function skipOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "error", message: "Allaqachon bajarilgan." };
  // Skipping ahead is legitimate ("nobody is in on Friday"), it just has to be
  // deliberate rather than a misclick on a card in the Kelgusi list.
  var todayKey = taskTodayKey_(Date.now());
  if (isFutureOccurrence_(occ, todayKey) && payload.confirmFuture !== true) {
    return { status: "error", needsFutureConfirm: true, dateKey: occ.dateKey,
      message: "Kelgusi kunni (" + formatTaskDateKey_(occ.dateKey) + ") o'tkazib yuborishni tasdiqlang." };
  }
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
  if (isFutureOccurrence_(occ, taskTodayKey_(Date.now()))) {
    return { status: "error",
      message: "Kelgusi kun uchun vazifani oldindan bajarilgan deb belgilab bo'lmaydi." };
  }

  // A caller with a verified identity is recorded as themselves. The admin
  // panel has no identity beyond the key, so it keeps its old label.
  var byId = String(payload.completedById || "");
  var byName = String(payload.completedBy || payload.completedByName || "").trim() ||
    (byId ? byId : "Admin (panel)");
  var source = String(payload.completedSource || "web");

  // A task that asks for a photo does not become done because a button was
  // pressed - that is the rule the group cards already enforce. Any client
  // that can name a person can start the proof flow instead of bypassing it;
  // one that cannot has no one to ask, so it completes as before.
  if (occ.photoRequired && occ.status !== TASK_STATUS_WAITING && byId) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = byId;
    occ.completedByName = byName;                  // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: byId, userName: byName
    });
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    appendAuditRow_(doc, "task_proof_requested", occ.id + " by:" + byName);
    return {
      status: "success", awaitingProof: true,
      message: "📷 Rasm kutilmoqda — guruhda so'ralgan xabarga javob bering."
    };
  }

  completeTaskOccurrence_(doc, occ, { byId: byId, byName: byName, source: source });
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
