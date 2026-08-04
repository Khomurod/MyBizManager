// ============================================================
// Retry queue
// ------------------------------------------------------------
// Reporting is never on the critical path of a financial write. Jobs are queued
// after the record is committed and retried with backoff.
// ============================================================

// 5d. RETRY QUEUE (Google Sheets backed)
// ------------------------------------------
// Telegram reporting is never on the critical path of a financial write. Jobs
// are queued after the record is committed and retried with backoff.
// ==========================================
var JOB_QUEUE_SHEET = "Omad_Job_Queue";

var JOB_QUEUE_HEADER = [
  "Job_ID", "Related_ID", "Type", "Payload_JSON", "Status",
  "Attempts", "Next_Attempt_At", "Last_Error", "Created_At", "Completed_At"
];

var JOB_STATUS_PENDING = "Pending";

var JOB_STATUS_PROCESSING = "Processing";

var JOB_STATUS_COMPLETED = "Completed";

var JOB_STATUS_FAILED = "Failed";

var JOB_MAX_ATTEMPTS = 5;

var JOB_RETRY_BASE_SECONDS = 30;

// Deliberately one. A save returns as soon as the financial record is safely
// stored; at most one queued report rides along, and the time-driven trigger
// picks up everything else. Draining the whole queue inline would make the
// user wait for work they do not care about.
var JOB_QUEUE_INLINE_BATCH = 1;

var JOB_QUEUE_MANUAL_BATCH = 25;

var JOB_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function jobQueueSheet_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET) || doc.insertSheet(JOB_QUEUE_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(JOB_QUEUE_HEADER);
  return sheet;
}

function enqueueJob_(doc, type, relatedId, payload) {
  var sheet = jobQueueSheet_(doc);
  var jobId = "job_" + new Date().getTime() + "_" + sheet.getLastRow();
  sheet.appendRow([
    jobId,
    String(relatedId || ""),
    String(type),
    JSON.stringify(payload || {}),
    JOB_STATUS_PENDING,
    0,
    new Date().toISOString(),
    "",
    new Date().toISOString(),
    ""
  ]);
  return jobId;
}

function readJobRows_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheet, rows: [] };
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    rows.push({
      rowNumber: i + 1,
      jobId: String(data[i][0]),
      relatedId: String(data[i][1] || ""),
      type: String(data[i][2] || ""),
      payload: safeParseJSON_(data[i][3], {}),
      status: String(data[i][4] || ""),
      attempts: Number(data[i][5]) || 0,
      nextAttemptAt: String(data[i][6] || ""),
      lastError: String(data[i][7] || ""),
      createdAt: String(data[i][8] || ""),
      completedAt: String(data[i][9] || "")
    });
  }
  return { sheet: sheet, rows: rows };
}

function writeJobField_(sheet, rowNumber, columnIndex, value) {
  sheet.getRange(rowNumber, columnIndex).setValue(value);
}

/**
 * Claims a job by flipping it to Processing under the script lock, so two
 * concurrent workers can never run the same job twice.
 */
function claimDueJobs_(doc, maxJobs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (error) {
    return [];
  }

  var claimed = [];
  try {
    var read = readJobRows_(doc);
    if (!read.sheet) return [];
    var nowMs = new Date().getTime();

    for (var i = 0; i < read.rows.length && claimed.length < maxJobs; i++) {
      var job = read.rows[i];

      // Recover jobs abandoned by a worker that died mid-flight.
      if (job.status === JOB_STATUS_PROCESSING) {
        var startedMs = Date.parse(job.nextAttemptAt) || 0;
        if (nowMs - startedMs < JOB_PROCESSING_TIMEOUT_MS) continue;
      } else if (job.status !== JOB_STATUS_PENDING) {
        continue;
      } else if ((Date.parse(job.nextAttemptAt) || 0) > nowMs) {
        continue;
      }

      writeJobField_(read.sheet, job.rowNumber, 5, JOB_STATUS_PROCESSING);
      writeJobField_(read.sheet, job.rowNumber, 7, new Date(nowMs).toISOString());
      job.status = JOB_STATUS_PROCESSING;
      job.sheet = read.sheet;
      claimed.push(job);
    }
  } finally {
    lock.releaseLock();
  }
  return claimed;
}

function completeJob_(sheet, job) {
  writeJobField_(sheet, job.rowNumber, 5, JOB_STATUS_COMPLETED);
  writeJobField_(sheet, job.rowNumber, 6, job.attempts + 1);
  writeJobField_(sheet, job.rowNumber, 8, "");
  writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
}

function failJob_(sheet, job, error) {
  var attempts = job.attempts + 1;
  var exhausted = attempts >= JOB_MAX_ATTEMPTS;
  var delaySeconds = JOB_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1));
  writeJobField_(sheet, job.rowNumber, 5, exhausted ? JOB_STATUS_FAILED : JOB_STATUS_PENDING);
  writeJobField_(sheet, job.rowNumber, 6, attempts);
  writeJobField_(sheet, job.rowNumber, 7, new Date(new Date().getTime() + delaySeconds * 1000).toISOString());
  writeJobField_(sheet, job.rowNumber, 8, redactSecrets_(error).slice(0, 500));
  if (exhausted) writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
}

function processPendingJobs_(doc, maxJobs) {
  var jobs = claimDueJobs_(doc, maxJobs || JOB_QUEUE_INLINE_BATCH);
  var processed = 0;
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    try {
      runJob_(doc, job);
      completeJob_(job.sheet, job);
      processed++;
    } catch (error) {
      failJob_(job.sheet, job, error);
    }
  }
  return processed;
}

/**
 * Best-effort inline drain. Never throws into the caller's response path, and
 * never processes more than one job, so confirming a save stays fast.
 *
 * Pass `deferReports: true` on a request to skip it entirely and leave
 * everything to the trigger.
 */
function drainJobQueueQuietly_(doc, options) {
  if (options && options.deferReports === true) return 0;
  try {
    return processPendingJobs_(doc, JOB_QUEUE_INLINE_BATCH);
  } catch (error) {
    return 0;
  }
}

/** Entry point for a time-driven trigger (see docs/TELEGRAM_SETUP.md). */
function processPendingTelegramJobs() {
  return processPendingJobs_(SpreadsheetApp.getActiveSpreadsheet(), JOB_QUEUE_MANUAL_BATCH);
}

function buildJobQueueStatus_(doc) {
  var read = readJobRows_(doc);
  var counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  var recentFailures = [];
  for (var i = 0; i < read.rows.length; i++) {
    var job = read.rows[i];
    if (job.status === JOB_STATUS_PENDING) counts.pending++;
    else if (job.status === JOB_STATUS_PROCESSING) counts.processing++;
    else if (job.status === JOB_STATUS_COMPLETED) counts.completed++;
    else if (job.status === JOB_STATUS_FAILED) {
      counts.failed++;
      recentFailures.push({ jobId: job.jobId, type: job.type, attempts: job.attempts, lastError: job.lastError });
    }
  }
  return { counts: counts, failures: recentFailures.slice(-10) };
}

function runJob_(doc, job) {
  if (job.type === "omad_transaction_report") return runOmadTransactionReportJob_(doc, job);
  if (job.type === "omad_transaction_delete_report") return runOmadDeleteReportJob_(job);
  if (job.type === "cafe_close_day_report") return runCafeCloseDayReportJob_(job);
  throw new Error("Unknown job type: " + job.type);
}
