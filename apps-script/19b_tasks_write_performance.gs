// ============================================================
// Task write performance
// ------------------------------------------------------------
// A task mutation is two different pieces of work wearing one response:
//
//   the durable part   — write the row, reconcile the occurrences it owns,
//                        answer the board. This stays in the foreground; it is
//                        what the person pressing the button is waiting for.
//   the settling part  — scan every schedule and push the Telegram group cards.
//                        Nobody is waiting for that, and the five-minute
//                        `processPendingTelegramJobs` trigger already guarantees
//                        it happens whether or not anyone asks.
//
// This module makes the durable part proportional to the one record being
// changed, and gives the settling part its own request so it stops sitting
// inside the response. Nothing about recurrence, reminder rules, attribution or
// the group cards changes — only when the scan runs, and the trigger remains the
// reliability fallback exactly as before.
// ============================================================

/**
 * Locates one row by an exact id in column A, and reads only that row.
 *
 * `readTaskRows_` / `readOccurrenceRows_` exist to answer questions about the
 * whole sheet, and finding one record is not one of them: completing a single
 * occurrence read every column of every occurrence ever created, and an edit
 * paid it twice. Sheet order still decides, because the readers answered with
 * the first matching row.
 *
 * Production Sheets can find the cell without transferring even the one column;
 * the test harness deliberately has no TextFinder, so the bounded one-column
 * fallback keeps the behaviour identical everywhere. Ids are case-sensitive
 * strings, so TextFinder is held to that rule.
 */
function taskRowNumberById_(sheet, wantedId) {
  if (!sheet || !wantedId || sheet.getLastRow() < 2) return 0;

  var idRange = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1);
  var rowNumber = 0;

  if (typeof idRange.createTextFinder === "function") {
    var finder = idRange.createTextFinder(wantedId).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
    for (var m = 0; m < matches.length; m++) {
      var candidate = matches[m].getRow();
      if (!rowNumber || candidate < rowNumber) rowNumber = candidate;
    }
    return rowNumber;
  }

  var ids = idRange.getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "") !== wantedId) continue;
    return i + 2;
  }
  return 0;
}

var findTaskBeforeWritePerf_ = findTask_;
findTask_ = function (doc, taskId) {
  var wanted = String(taskId === null || taskId === undefined ? "" : taskId);
  if (!wanted) return null;

  var sheet = doc.getSheetByName(TASKS_SHEET);
  var rowNumber = taskRowNumberById_(sheet, wanted);
  if (!rowNumber) return null;

  var task = taskFromRow_(sheet.getRange(rowNumber, 1, 1, TASKS_HEADER.length).getValues()[0]);
  task.rowNumber = rowNumber;
  return task;
};

var findOccurrenceBeforeWritePerf_ = findOccurrence_;
findOccurrence_ = function (doc, occurrenceId) {
  var wanted = String(occurrenceId === null || occurrenceId === undefined ? "" : occurrenceId);
  if (!wanted) return null;

  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  var rowNumber = taskRowNumberById_(sheet, wanted);
  if (!rowNumber) return null;

  var occ = occurrenceFromRow_(sheet.getRange(rowNumber, 1, 1, TASK_OCC_HEADER.length).getValues()[0]);
  occ.rowNumber = rowNumber;
  return occ;
};

// ------------------------------------------------------------------ settling

/** The action a client calls, without waiting, to settle what it just changed. */
var TASK_SETTLE_ACTION = "settle_tasks";

/**
 * One trigger tick, on demand.
 *
 * Exactly what `processPendingTelegramJobs` does for the task side: scan the
 * schedules so anything now due is enqueued, then drain the queue so the group
 * cards go out. It is called from a request nobody is waiting on, so it drains
 * the full manual batch rather than the single inline job a response could
 * afford — a cancelled routine with ten announced days used to leave nine cards
 * to the next tick.
 *
 * Neither half may throw into the caller: losing this costs a delay, never a
 * card, because the trigger runs the same cycle every five minutes. If a
 * concurrent settle already holds the script lock, the scan gives up quietly and
 * the trigger picks it up.
 */
function settleTaskSchedules_(doc) {
  var scan = { notified: 0, reminders: 0, generated: 0 };
  try {
    scan = runTaskScheduler_(doc, Date.now());
  } catch (error) {
    debugLog_(doc, "task_scheduler_settle_failed", String(error));
  }

  var sent = 0;
  try {
    sent = processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
  } catch (error) {
    debugLog_(doc, "task_settle_drain_failed", String(error));
  }

  return {
    notified: scan.notified || 0,
    reminders: scan.reminders || 0,
    generated: scan.generated || 0,
    sent: sent
  };
}

/**
 * `settle_tasks` joins the task namespace rather than the top-level router, so
 * it keeps the board's own gate: omad_admin, checked on the server, like every
 * other task action.
 */
var isTaskActionBeforeWritePerf_ = isTaskAction_;
isTaskAction_ = function (action) {
  return action === TASK_SETTLE_ACTION || isTaskActionBeforeWritePerf_(action);
};

var handleTaskActionBeforeWritePerf_ = handleTaskAction_;
handleTaskAction_ = function (action, payload, doc) {
  if (action !== TASK_SETTLE_ACTION) {
    return handleTaskActionBeforeWritePerf_(action, payload, doc);
  }

  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  var settled = settleTaskSchedules_(doc);
  settled.status = "success";
  return jsonOutput_(settled);
};
