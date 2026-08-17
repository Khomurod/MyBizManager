#!/usr/bin/env python3
from pathlib import Path
import subprocess
import textwrap
import re

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    print('+', ' '.join(args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def read(path):
    return (ROOT / path).read_text()


def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one exact match, found {count}')
    write(path, text.replace(old, new, 1))


def regex_replace_once(path, pattern, replacement, flags=re.S):
    text = read(path)
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{path}: expected one regex match, found {count}: {pattern[:80]}')
    write(path, new_text)


def rebuild_and_test(label):
    print(f'\n=== {label}: build + unit tests ===', flush=True)
    run('npm', 'run', 'build')
    run('node', '--test', 'tests/app-wide-performance.test.js')
    run('npm', 'test')
    run('npm', 'run', 'build:check')


def commit(message):
    run('git', 'add', '-A')
    run('git', 'commit', '-m', message)


def append_test(block):
    path = 'tests/app-wide-performance.test.js'
    text = read(path) if (ROOT / path).exists() else "'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('fs');\nconst path = require('path');\nconst { loadScript, readJsonOutput, postEvent } = require('./gas-harness');\n\nconst ROOT = path.join(__dirname, '..');\n\n"
    write(path, text.rstrip() + '\n\n' + textwrap.dedent(block).strip() + '\n')


# ---------------------------------------------------------------------------
# 1. Tasks: return after the durable mutation, settle scheduler/view in a
#    separate background request, and stop scanning whole sheets to find one ID.
# ---------------------------------------------------------------------------
write('apps-script/17a_tasks_write_performance.gs', r'''// ============================================================
// Task write performance
// ------------------------------------------------------------
// Hot task mutations usually need one task or one occurrence by exact ID. The
// original helpers parsed the entire sheet for those lookups. Keep the same
// row objects and row numbers while reading only column A plus the matching row.
// ============================================================

function taskExactRowById_(sheet, wanted, width) {
  if (!sheet || !wanted || sheet.getLastRow() < 2) return null;
  var lastRow = sheet.getLastRow();
  var idRange = sheet.getRange(2, 1, lastRow - 1, 1);

  if (typeof idRange.createTextFinder === "function") {
    var finder = idRange.createTextFinder(String(wanted)).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
    for (var m = 0; m < matches.length; m++) {
      var rowNumber = matches[m].getRow();
      var row = sheet.getRange(rowNumber, 1, 1, width).getValues()[0];
      if (String(row[0] || "") === String(wanted)) return { rowNumber: rowNumber, row: row };
    }
    return null;
  }

  var ids = idRange.getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "") !== String(wanted)) continue;
    var rowNo = i + 2;
    return { rowNumber: rowNo, row: sheet.getRange(rowNo, 1, 1, width).getValues()[0] };
  }
  return null;
}

var findTaskBeforeWritePerf_ = findTask_;
findTask_ = function (doc, taskId) {
  var wanted = String(taskId || "");
  if (!wanted) return null;
  var match = taskExactRowById_(doc.getSheetByName(TASKS_SHEET), wanted, TASKS_HEADER.length);
  if (!match) return null;
  var task = taskFromRow_(match.row);
  task.rowNumber = match.rowNumber;
  return task;
};

var findOccurrenceBeforeWritePerf_ = findOccurrence_;
findOccurrence_ = function (doc, occurrenceId) {
  var wanted = String(occurrenceId || "");
  if (!wanted) return null;
  var match = taskExactRowById_(doc.getSheetByName(TASK_OCCURRENCES_SHEET), wanted, TASK_OCC_HEADER.length);
  if (!match) return null;
  var occ = occurrenceFromRow_(match.row);
  occ.rowNumber = match.rowNumber;
  return occ;
};
''')

write('apps-script/19b_tasks_write_performance.gs', r'''// ============================================================
// Task response performance
// ------------------------------------------------------------
// A task mutation is durable once its task/occurrence rows and required queue
// rows are stored. Rebuilding the whole board and running the full scheduler in
// the same HTTP request made the phone wait for work that can safely follow.
// Opt-in clients now ask for a fast response, then fire `settle_tasks` without
// awaiting it. The normal time trigger remains the durable fallback if that
// follow-up request never arrives.
// ============================================================

var isTaskMutationActionBeforeWritePerf_ = isTaskMutationAction_;
isTaskMutationAction_ = function (action) {
  return action === "settle_tasks" || isTaskMutationActionBeforeWritePerf_(action);
};

var isTaskActionBeforeWritePerf_ = isTaskAction_;
isTaskAction_ = function (action) {
  return action === "settle_tasks" || isTaskActionBeforeWritePerf_(action);
};

function settleTaskMutationWork_(doc, payload) {
  var scheduler = { notified: 0, reminders: 0, generated: 0 };
  try {
    scheduler = runTaskScheduler_(doc, Date.now());
  } catch (error) {
    debugLog_(doc, "task_scheduler_background_failed", String(error));
  }
  drainJobQueueQuietly_(doc, payload || {});
  return { status: "success", scheduler: scheduler };
}

var handleTaskActionBeforeWritePerf_ = handleTaskAction_;
handleTaskAction_ = function (action, payload, doc) {
  if (action !== "settle_tasks") return handleTaskActionBeforeWritePerf_(action, payload, doc);
  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);
  return jsonOutput_(settleTaskMutationWork_(doc, payload));
};

function runDeferredTaskMutation_(action, payload, doc) {
  var result;
  if (action === "save_task") result = saveTaskAction_(doc, payload);
  else if (action === "cancel_task") result = cancelTaskAction_(doc, payload);
  else if (action === "pause_routine") result = setRoutinePausedAction_(doc, payload, true);
  else if (action === "resume_routine") result = setRoutinePausedAction_(doc, payload, false);
  else if (action === "skip_occurrence") result = skipOccurrenceAction_(doc, payload);
  else if (action === "complete_occurrence") result = completeOccurrenceAction_(doc, payload);
  else result = reopenOccurrenceAction_(doc, payload);

  if (result.status === "success") recordLastOperation_(doc, action);
  return jsonOutput_(result);
}

var runTaskActionBeforeWritePerf_ = runTaskAction_;
runTaskAction_ = function (action, payload, doc) {
  if (action === "settle_tasks") return jsonOutput_(settleTaskMutationWork_(doc, payload));
  if (payload && payload.deferTaskSettle === true) {
    return runDeferredTaskMutation_(action, payload, doc);
  }
  return runTaskActionBeforeWritePerf_(action, payload, doc);
};
''')

replace_once('assets/tasks/01-tasks-api.js',
"const TASKS_STATE = { view: null, config: null, loadError: '' };",
"const TASKS_STATE = {\n    view: null, config: null, loadError: '',\n    backgroundRefreshInFlight: false, backgroundRefreshPending: false,\n    mutationInFlight: false\n};")

old_load_tasks = r'''async function loadTasks() {
    taskLoader(true);
    try {
        const data = await tasksApiCall({ action: 'get_tasks' });
        if (tasksAuthExpired(data)) { signOut(); return; }
        if (data && data.status === 'success') {
            TASKS_STATE.view = data.view;
            TASKS_STATE.config = data.config;
            TASKS_STATE.loadError = '';
        } else {
            // A throttle or a server fault leaves the board exactly as it was.
            // Emptying it would read as "nothing to do" rather than "not shown".
            TASKS_STATE.loadError = (data && data.message) || "Ma'lumotni yuklab bo'lmadi";
            taskToast(TASKS_STATE.loadError, true);
        }
    } catch (e) {
        TASKS_STATE.loadError = "Ma'lumotni yuklab bo'lmadi";
        taskToast(TASKS_STATE.loadError, true);
    } finally {
        taskLoader(false);
    }
    renderAllTasks();
}
'''
new_load_tasks = r'''async function loadTasks(options = {}) {
    const background = !!(options && options.background);
    if (!background) taskLoader(true);
    try {
        const data = await tasksApiCall({ action: 'get_tasks' });
        if (tasksAuthExpired(data)) { signOut(); return; }
        if (data && data.status === 'success') {
            TASKS_STATE.view = data.view;
            TASKS_STATE.config = data.config;
            TASKS_STATE.loadError = '';
        } else {
            // A throttle or a server fault leaves the board exactly as it was.
            // Emptying it would read as "nothing to do" rather than "not shown".
            TASKS_STATE.loadError = (data && data.message) || "Ma'lumotni yuklab bo'lmadi";
            if (!background) taskToast(TASKS_STATE.loadError, true);
        }
    } catch (e) {
        TASKS_STATE.loadError = "Ma'lumotni yuklab bo'lmadi";
        if (!background) taskToast(TASKS_STATE.loadError, true);
    } finally {
        if (!background) taskLoader(false);
    }
    renderAllTasks();
}

async function runTaskBackgroundSettle_() {
    if (TASKS_STATE.backgroundRefreshInFlight) return;
    TASKS_STATE.backgroundRefreshInFlight = true;
    try {
        while (TASKS_STATE.backgroundRefreshPending) {
            TASKS_STATE.backgroundRefreshPending = false;
            try { await tasksApiCall({ action: 'settle_tasks' }); } catch (e) {}
            await loadTasks({ background: true });
        }
    } finally {
        TASKS_STATE.backgroundRefreshInFlight = false;
    }
}

function settleTasksInBackground_() {
    TASKS_STATE.backgroundRefreshPending = true;
    setTimeout(() => { runTaskBackgroundSettle_(); }, 0);
}
'''
replace_once('assets/tasks/01-tasks-api.js', old_load_tasks, new_load_tasks)

old_mutation = r'''async function taskMutation(payload, okMessage) {
    taskLoader(true);
    try {
        const data = await tasksApiCall(payload);
        if (tasksAuthExpired(data)) { signOut(); return null; }
        if (!data || data.status !== 'success') {
            taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            return null;
        }
        if (data.view) { TASKS_STATE.view = data.view; TASKS_STATE.config = data.config; }
        taskToast(okMessage || 'Bajarildi');
        renderAllTasks();
        return data;
    } catch (e) {
        taskToast("Server bilan bog'lanib bo'lmadi", true);
        return null;
    } finally {
        taskLoader(false);
    }
}
'''
new_mutation = r'''async function taskMutation(payload, okMessage) {
    taskLoader(true);
    try {
        const request = Object.assign({}, payload, { deferTaskSettle: true });
        const data = await tasksApiCall(request);
        if (tasksAuthExpired(data)) { signOut(); return null; }
        if (!data || data.status !== 'success') {
            taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            return null;
        }
        if (data.view) { TASKS_STATE.view = data.view; TASKS_STATE.config = data.config; }
        taskToast(okMessage || 'Bajarildi');
        renderAllTasks();
        settleTasksInBackground_();
        return data;
    } catch (e) {
        taskToast("Server bilan bog'lanib bo'lmadi", true);
        return null;
    } finally {
        taskLoader(false);
    }
}
'''
replace_once('assets/tasks/01-tasks-api.js', old_mutation, new_mutation)

# Mini App tasks: same durable mutation, same background settle/read.
replace_once('assets/mini/05-tasks.js',
"const OCCURRENCE_ACTIONS = ['complete_occurrence', 'reopen_occurrence', 'skip_occurrence'];\n",
"const OCCURRENCE_ACTIONS = ['complete_occurrence', 'reopen_occurrence', 'skip_occurrence'];\n\nlet miniTaskSettleInFlight_ = false;\nlet miniTaskSettlePending_ = false;\n\nasync function runMiniTaskSettle_() {\n    if (miniTaskSettleInFlight_) return;\n    miniTaskSettleInFlight_ = true;\n    try {\n        while (miniTaskSettlePending_) {\n            miniTaskSettlePending_ = false;\n            try { await api('mini_task_action', { taskAction: 'settle_tasks' }); } catch (error) {}\n            await loadTasks();\n        }\n    } finally {\n        miniTaskSettleInFlight_ = false;\n    }\n}\n\nfunction settleMiniTasksInBackground_() {\n    miniTaskSettlePending_ = true;\n    setTimeout(() => { runMiniTaskSettle_(); }, 0);\n}\n")

replace_once('assets/mini/05-tasks.js',
"        id: taskId || ''\n    }, extra || {});",
"        id: taskId || '',\n        deferTaskSettle: true\n    }, extra || {});")
replace_once('assets/mini/05-tasks.js',
"        renderTasks();\n        // A photo-required task is not finished by pressing a button: it moves",
"        renderTasks();\n        settleMiniTasksInBackground_();\n        // A photo-required task is not finished by pressing a button: it moves")
replace_once('assets/mini/05-tasks.js',
"            reminderTimes: times\n        };",
"            reminderTimes: times,\n            deferTaskSettle: true\n        };")
replace_once('assets/mini/05-tasks.js',
"        renderTasks();\n        toast('Saqlandi');",
"        renderTasks();\n        settleMiniTasksInBackground_();\n        toast('Saqlandi');")
replace_once('assets/mini/05-tasks.js',
"        const body = await api('mini_task_action', { taskAction: 'cancel_task', taskId, id: taskId });",
"        const body = await api('mini_task_action', { taskAction: 'cancel_task', taskId, id: taskId, deferTaskSettle: true });")
replace_once('assets/mini/05-tasks.js',
"        renderTasks();\n        toast('Bekor qilindi');",
"        renderTasks();\n        settleMiniTasksInBackground_();\n        toast('Bekor qilindi');")

append_test(r'''
const TASKS_HEADER = [
  'ID','Type','Title','Description','Responsible','Priority','Photo_Required','Recurrence_JSON',
  'Reminder_Times_JSON','Remind_Daily','Due_Time','Deadline_Key','Deadline_Time','Start_Key','End_Key',
  'Status','Steps_JSON','Created_At','Updated_At','Created_By','Meta_JSON'
];
const TASK_OCC_HEADER = [
  'ID','Task_ID','Task_Type','Title','Date_Key','Step_Index','Due_At','Responsible','Priority','Photo_Required',
  'Reminder_Times_JSON','Remind_Daily','Status','Reminders_Sent_JSON','Notified_At','Telegram_Msg_ID',
  'Completed_By_Id','Completed_By_Name','Completed_At','On_Time','Late_Ms','Proof_File_Id','Proof_Msg_Id',
  'Proof_Awaiting_User_Id','Created_At','Updated_At','Meta_JSON'
];

function bootTasks() {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: 'perf-admin' },
    sheets: {
      System_Config: [],
      Tasks: [TASKS_HEADER, [
        'task_exact','once','Exact task','','Ali','normal','FALSE','{}','[]','FALSE','','','','','',
        'active','[]','2026-08-17T00:00:00.000Z','2026-08-17T00:00:00.000Z','tester','{}'
      ]],
      Task_Occurrences: [TASK_OCC_HEADER, [
        'occ_exact','task_exact','once','Exact task','2026-08-17','',Date.now(),'Ali','normal','FALSE','[]','FALSE',
        'Open','{}','','','','','','','','','','','2026-08-17T00:00:00.000Z','2026-08-17T00:00:00.000Z','{}'
      ]]
    }
  });
}

test('task and occurrence hot lookups do not scan their whole sheets', () => {
  const gas = bootTasks();
  const tasks = gas.__spreadsheet.getSheetByName('Tasks');
  const occs = gas.__spreadsheet.getSheetByName('Task_Occurrences');
  let fullReads = 0;
  const taskData = tasks.getDataRange;
  const occData = occs.getDataRange;
  tasks.getDataRange = function () { fullReads++; return taskData.call(tasks); };
  occs.getDataRange = function () { fullReads++; return occData.call(occs); };

  assert.strictEqual(gas.findTask_(gas.__spreadsheet, 'task_exact').title, 'Exact task');
  assert.strictEqual(gas.findOccurrence_(gas.__spreadsheet, 'occ_exact').taskId, 'task_exact');
  assert.strictEqual(fullReads, 0);
});

test('deferred task mutations skip the inline scheduler and board rebuild', () => {
  const gas = bootTasks();
  let schedulerCalls = 0;
  gas.runTaskScheduler_ = function () { schedulerCalls++; return {}; };
  const result = readJsonOutput(gas.runTaskAction_('save_task', {
    type: 'once', title: 'Fast save', responsible: 'Ali', reminderTimes: [],
    deferTaskSettle: true
  }, gas.__spreadsheet));
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.view, undefined);
  assert.strictEqual(schedulerCalls, 0);
  assert.strictEqual(gas.isTaskAction_('settle_tasks'), true);
  assert.strictEqual(gas.isTaskMutationAction_('settle_tasks'), true);
});

test('task web and Mini App clients settle and refresh after the durable response', () => {
  const web = fs.readFileSync(path.join(ROOT, 'assets/tasks/01-tasks-api.js'), 'utf8');
  const mini = fs.readFileSync(path.join(ROOT, 'assets/mini/05-tasks.js'), 'utf8');
  assert.match(web, /deferTaskSettle: true/);
  assert.match(web, /action: 'settle_tasks'/);
  assert.match(web, /loadTasks\(\{ background: true \}\)/);
  assert.match(mini, /taskAction: 'settle_tasks'/);
  assert.match(mini, /deferTaskSettle: true/);
});
''')

rebuild_and_test('Point 1 - task writes')
commit('perf: make task writes return sooner')

# ---------------------------------------------------------------------------
# 2. Transaction edits: exact transaction lookup + one edit HTTP request, with
#    the proven single-row path retained only as an explicit old-backend fallback.
# ---------------------------------------------------------------------------
write('apps-script/14b_ledger_edit_performance.gs', r'''// ============================================================
// Ledger edit performance
// ------------------------------------------------------------
// Correct/cancel/get need one exact transaction. Reading every column of every
// historical row made an edit progressively slower as the ledger grew.
// ============================================================

var findLedgerRowBeforeEditPerf_ = findLedgerRow_;
findLedgerRow_ = function (doc, transactionId) {
  var wanted = String(transactionId || "");
  if (!wanted) return null;
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var lastRow = sheet.getLastRow();
  var idRange = sheet.getRange(2, 1, lastRow - 1, 1);
  if (typeof idRange.createTextFinder === "function") {
    var finder = idRange.createTextFinder(wanted).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
    for (var m = 0; m < matches.length; m++) {
      var rowNumber = matches[m].getRow();
      var row = sheet.getRange(rowNumber, 1, 1, LEDGER_HEADER.length).getValues()[0];
      if (String(row[0] || "") === wanted) return ledgerRowToTransaction_(row, rowNumber);
    }
    return null;
  }

  var ids = idRange.getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "") !== wanted) continue;
    var rowNo = i + 2;
    return ledgerRowToTransaction_(
      sheet.getRange(rowNo, 1, 1, LEDGER_HEADER.length).getValues()[0], rowNo);
  }
  return null;
};
''')

write('apps-script/20b_ledger_edit_performance_api.gs', r'''// ============================================================
// Ledger group-edit API
// ------------------------------------------------------------
// The browser used to make one Apps Script request per corrected/added/removed
// cart line. Keep exactly the same append-only operations and per-line request
// IDs, but execute them inside one HTTP request. A retry safely resumes because
// create/correct/cancel already carry their existing idempotency semantics.
// ============================================================

var isLedgerActionBeforeEditPerf_ = isLedgerAction_;
isLedgerAction_ = function (action) {
  return action === 'edit_transaction_group' || isLedgerActionBeforeEditPerf_(action);
};

function queueLedgerEditResult_(doc, action, result, reportJobIds) {
  try {
    var jobId = queueLedgerReport_(doc, action, result) || "";
    if (jobId) reportJobIds.push(jobId);
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
}

function editTransactionGroup_(doc, payload) {
  var lines = Array.isArray(payload.lines) ? payload.lines : [];
  var existingIds = Array.isArray(payload.existingIds) ? payload.existingIds : [];
  if (lines.length > 50 || existingIds.length > 50) {
    return { status: "error", message: "Bir yozuvda juda ko'p qator bor." };
  }
  var requestBase = String(payload.requestId || "").trim();
  if (!requestBase || requestBase.length > 120) {
    return { status: "error", message: "requestId talab qilinadi." };
  }

  var reportJobIds = [];
  var results = [];
  for (var i = 0; i < lines.length; i++) {
    var item = lines[i] || {};
    var input = {
      requestId: requestBase + "_" + i,
      groupId: payload.groupId,
      period: payload.period,
      tenant: payload.tenant,
      type: payload.type,
      amount: item.amount,
      currency: item.currency,
      method: item.method,
      comment: payload.comment,
      source: payload.source,
      createdBy: payload.createdBy,
      rateType: item.rateType || payload.rateType
    };

    var action = i < existingIds.length ? 'correct_transaction' : 'create_transaction';
    if (action === 'correct_transaction') input.transactionId = String(existingIds[i] || "");
    var result = action === 'correct_transaction'
      ? correctTransaction_(doc, input)
      : createTransaction_(doc, input);
    if (!result || result.status !== "success") {
      return {
        status: "error", lineIndex: i, partial: results.length > 0,
        message: (result && result.message) || "Tahrirlash saqlanmadi."
      };
    }
    results.push({ action: action, result: result });
    queueLedgerEditResult_(doc, action, result, reportJobIds);
  }

  for (var c = lines.length; c < existingIds.length; c++) {
    var cancel = cancelTransaction_(doc, {
      transactionId: String(existingIds[c] || ""),
      requestId: requestBase + "_cancel_" + c,
      reason: 'entry edited'
    });
    if (!cancel || cancel.status !== "success") {
      return {
        status: "error", lineIndex: c, partial: results.length > 0,
        message: (cancel && cancel.message) || "Tahrirlash saqlanmadi."
      };
    }
    results.push({ action: 'cancel_transaction', result: cancel });
    queueLedgerEditResult_(doc, 'cancel_transaction', cancel, reportJobIds);
  }

  return { status: "success", results: results, reportJobIds: reportJobIds };
}

var ledgerActionBeforeEditPerf_ = ledgerAction_;
ledgerAction_ = function (action, payload, doc) {
  if (action !== 'edit_transaction_group') return ledgerActionBeforeEditPerf_(action, payload, doc);
  if (!isLedgerActive_(doc)) {
    return jsonOutput_({
      status: "error",
      message: "Yangi tranzaksiya tizimi hali yoqilmagan. Avval ma'lumotlarni ko'chiring."
    });
  }
  var result = editTransactionGroup_(doc, payload);
  if (result.status === "success") {
    recordLastOperation_(doc, action);
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
};
''')

replace_once('assets/omad/12-app.js',
"OMAD_WRITE_ACTIONS.add('create_transaction_batch');",
"OMAD_WRITE_ACTIONS.add('create_transaction_batch');\nOMAD_WRITE_ACTIONS.add('edit_transaction_group');")
replace_once('assets/omad/12-app.js',
"    if (action === 'create_transaction_batch' || action === 'create_transaction' ||\n        action === 'correct_transaction' || action === 'cancel_transaction' ||",
"    if (action === 'create_transaction_batch' || action === 'edit_transaction_group' ||\n        action === 'create_transaction' || action === 'correct_transaction' || action === 'cancel_transaction' ||")

insert_anchor = r'''async function submitNewLedgerEntryLegacyFallback_(requestBase, groupId, common) {
    assertLegacyFallbackSubmissionUnchanged_(requestBase, groupId, common);
    for(let i = 0; i < cart.length; i++) {
        const response = await callBackend({
            action: 'create_transaction',
            requestId: `${requestBase}__n${cart.length}_${i}`,
            groupId,
            ...common,
            amount: Number(cart[i].amount) || 0,
            currency: cart[i].currency,
            method: cart[i].method
        });
        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || 'save failed');
        }
    }
}
'''
insert_replacement = insert_anchor + r'''

/** Old Apps Script deployments keep the original proven edit sequence. */
async function submitLedgerEditLegacyFallback_(requestBase, groupId, common, existingIds) {
    for(let i = 0; i < cart.length; i++) {
        const line = {
            requestId: `${requestBase}_${i}`,
            groupId,
            ...common,
            amount: Number(cart[i].amount) || 0,
            currency: cart[i].currency,
            method: cart[i].method
        };
        const response = i < existingIds.length
            ? await callBackend({ action: 'correct_transaction', transactionId: existingIds[i], ...line })
            : await callBackend({ action: 'create_transaction', ...line });
        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || 'save failed');
        }
    }

    for(let i = cart.length; i < existingIds.length; i++) {
        const response = await callBackend({
            action: 'cancel_transaction', transactionId: existingIds[i],
            requestId: `${requestBase}_cancel_${i}`, reason: 'entry edited'
        });
        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || 'save failed');
        }
    }
}
'''
replace_once('assets/omad/12-app.js', insert_anchor, insert_replacement)

old_edit_branch = r'''        } else {
            for(let i = 0; i < cart.length; i++) {
                const line = {
                    requestId: `${requestBase}_${i}`,
                    groupId,
                    ...common,
                    amount: Number(cart[i].amount) || 0,
                    currency: cart[i].currency,
                    method: cart[i].method
                };

                const response = i < existingIds.length
                    ? await callBackend({ action: 'correct_transaction', transactionId: existingIds[i], ...line })
                    : await callBackend({ action: 'create_transaction', ...line });

                if(!response || response.status !== 'success') {
                    throw new Error((response && response.message) || 'save failed');
                }
            }

            for(let i = cart.length; i < existingIds.length; i++) {
                const response = await callBackend({
                    action: 'cancel_transaction',
                    transactionId: existingIds[i],
                    requestId: `${requestBase}_cancel_${i}`,
                    reason: 'entry edited'
                });
                if(!response || response.status !== 'success') {
                    throw new Error((response && response.message) || 'save failed');
                }
            }
        }
'''
new_edit_branch = r'''        } else {
            const response = await callBackend({
                action: 'edit_transaction_group',
                requestId: requestBase,
                groupId,
                ...common,
                existingIds,
                lines: cart.map(item => ({
                    amount: Number(item.amount) || 0,
                    currency: item.currency,
                    method: item.method
                }))
            });
            if (response && response.status === 'error' &&
                /unknown action/i.test(String(response.message || ''))) {
                await submitLedgerEditLegacyFallback_(requestBase, groupId, common, existingIds);
            } else if (!response || response.status !== 'success') {
                throw new Error((response && response.message) || 'save failed');
            }
        }
'''
replace_once('assets/omad/12-app.js', old_edit_branch, new_edit_branch)

# Browser test expectations follow the new one-request edit path and cover rollout fallback.
replace_once('tests/omad-ledger.e2e.js',
" * entries are submitted as one batch while edits/deletes keep their existing\n * correct/create/cancel semantics. Every write carries stable request ids.",
" * entries are submitted as one batch; entry edits use one group-edit request\n * while preserving the same correct/create/cancel semantics on the server.\n * Every write carries stable request ids and old backends have a safe fallback.")

old_test1 = r'''    const corrections = requests.filter(r => r.action === 'correct_transaction');
    assert.strictEqual(corrections.length, 1);
    assert.strictEqual(corrections[0].transactionId, '1700000000000_0');
    assert.strictEqual(corrections[0].amount, 1250000);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
'''
new_test1 = r'''    const edits = requests.filter(r => r.action === 'edit_transaction_group');
    assert.strictEqual(edits.length, 1);
    assert.deepStrictEqual(edits[0].existingIds, ['1700000000000_0']);
    assert.strictEqual(edits[0].lines[0].amount, 1250000);
    assert.strictEqual(edits[0].deferReports, true);
    assert.deepStrictEqual(requests.filter(r => r.action === 'correct_transaction'), []);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
'''
replace_once('tests/omad-ledger.e2e.js', old_test1, new_test1)

old_test2 = r'''    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 1);
    const cancels = requests.filter(r => r.action === 'cancel_transaction');
    assert.strictEqual(cancels.length, 1);
    assert.strictEqual(cancels[0].transactionId, '1700000000000_1');
'''
new_test2 = r'''    const edits = requests.filter(r => r.action === 'edit_transaction_group');
    assert.strictEqual(edits.length, 1);
    assert.deepStrictEqual(edits[0].existingIds, ['1700000000000_0', '1700000000000_1']);
    assert.strictEqual(edits[0].lines.length, 1);
    assert.deepStrictEqual(requests.filter(r => r.action === 'cancel_transaction'), []);
'''
replace_once('tests/omad-ledger.e2e.js', old_test2, new_test2)

old_test3 = r'''    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 1);
    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1);
'''
new_test3 = r'''    const edits = requests.filter(r => r.action === 'edit_transaction_group');
    assert.strictEqual(edits.length, 1);
    assert.deepStrictEqual(edits[0].existingIds, ['1700000000000_0']);
    assert.strictEqual(edits[0].lines.length, 2);
    assert.deepStrictEqual(requests.filter(r => r.action === 'correct_transaction'), []);
    assert.deepStrictEqual(requests.filter(r => r.action === 'create_transaction'), []);
'''
replace_once('tests/omad-ledger.e2e.js', old_test3, new_test3)

fallback_test = r'''

  test('an older backend falls back to the proven line-by-line edit path', async () => {
    const { page, context, requests } = await openAdmin({
      transactions: [tx('1700000000000_0', { amount: 100000 })],
      respond: payload => payload.action === 'edit_transaction_group'
        ? { status: 'error', message: 'Unknown action: edit_transaction_group' }
        : null
    });

    await page.evaluate(async () => {
      editTx('1700000000000_0');
      cart = [
        { amount: 120000, currency: 'UZS', method: 'Naqd' },
        { amount: 50000, currency: 'UZS', method: 'Bank' }
      ];
      renderCart();
      await submitAll();
    });

    assert.strictEqual(requests.filter(r => r.action === 'edit_transaction_group').length, 1);
    assert.strictEqual(requests.filter(r => r.action === 'correct_transaction').length, 1);
    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1);
    await context.close();
  });
'''
replace_once('tests/omad-ledger.e2e.js',
"\n  // ---------------------------------------------------------------- cancel\n",
fallback_test + "\n  // ---------------------------------------------------------------- cancel\n")

append_test(r'''
const LEDGER_HEADER = [
  'ID','Request_ID','Created_At','Updated_At','Created_By','Source','Period','Tenant','Type','Amount','Currency',
  'Rate_Buy','Rate_Sell','Rate_Used','Rate_Type','Amount_UZS','Method','Comment','Status','Related_ID',
  'Telegram_Msg_ID','Schema_Version','Entry_Group_ID','Entry_Kind'
];

function ledgerRow(id, requestId, amount) {
  return [id, requestId, '2026-08-17T00:00:00.000Z', '', 'tester', 'Web', '2026-08', 'Tehnopark',
    'Income', amount, 'UZS', 12100, 12500, 1, 'none', amount, 'Naqd', '', 'Active', '', '', 2, 'grp_edit', 'ordinary'];
}

function bootLedger() {
  return loadScript({
    properties: { OMAD_ADMIN_KEY: 'perf-admin' },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12100, sell: 12500 } })],
        ['Omad_Active_Transactions_Sheet', 'Omad_Transactions_V2']
      ],
      Omad_Transactions_V2: [LEDGER_HEADER, ledgerRow('1000_0','orig_0',100000), ledgerRow('1001_0','orig_1',200000)]
    }
  });
}

test('transaction edit lookup reads only the ID column plus the matching row', () => {
  const gas = bootLedger();
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  let fullReads = 0;
  const original = ledger.getDataRange;
  ledger.getDataRange = function () { fullReads++; return original.call(ledger); };
  const found = gas.findLedgerRow_(gas.__spreadsheet, '1001_0');
  assert.strictEqual(found.amount, 200000);
  assert.strictEqual(fullReads, 0);
});

test('one group-edit request corrects kept lines and cancels removed lines', () => {
  const gas = bootLedger();
  const ledger = gas.__spreadsheet.getSheetByName('Omad_Transactions_V2');
  let fullReads = 0;
  const original = ledger.getDataRange;
  ledger.getDataRange = function () { fullReads++; return original.call(ledger); };
  const result = readJsonOutput(gas.doPost(postEvent({
    adminKey: 'perf-admin', action: 'edit_transaction_group', deferReports: true,
    requestId: 'edit_req', groupId: 'grp_edit', period: '2026-08', tenant: 'Tehnopark', type: 'Income',
    source: 'Web', createdBy: 'tester', existingIds: ['1000_0','1001_0'],
    lines: [{ amount: 125000, currency: 'UZS', method: 'Naqd' }]
  })));
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(ledger.data[1][18], 'Corrected');
  assert.strictEqual(ledger.data[2][18], 'Cancelled');
  assert.strictEqual(ledger.data.length, 4, 'one replacement row was appended');
  assert.strictEqual(ledger.data[3][9], 125000);
  assert.strictEqual(fullReads, 0, 'edit hot path does not scan the whole ledger');

  const retry = readJsonOutput(gas.doPost(postEvent({
    adminKey: 'perf-admin', action: 'edit_transaction_group', deferReports: true,
    requestId: 'edit_req', groupId: 'grp_edit', period: '2026-08', tenant: 'Tehnopark', type: 'Income',
    source: 'Web', createdBy: 'tester', existingIds: ['1000_0','1001_0'],
    lines: [{ amount: 125000, currency: 'UZS', method: 'Naqd' }]
  })));
  assert.strictEqual(retry.status, 'success');
  assert.strictEqual(ledger.data.length, 4, 'retry appends nothing');
});

test('Omad frontend uses one edit request and keeps an old-backend fallback', () => {
  const source = fs.readFileSync(path.join(ROOT, 'assets/omad/12-app.js'), 'utf8');
  assert.match(source, /action: 'edit_transaction_group'/);
  assert.match(source, /submitLedgerEditLegacyFallback_/);
  assert.match(source, /unknown action/i);
});
''')

rebuild_and_test('Point 2 - transaction edits')
commit('perf: batch transaction edits into one request')

# ---------------------------------------------------------------------------
# 3. Café purchase/stock movement: narrow idempotency lookup, tail-only history,
#    and a non-blocking post-write refresh.
# ---------------------------------------------------------------------------
write('apps-script/12c_cafe_read_performance.gs', r'''// ============================================================
// Café stock-movement read performance
// ------------------------------------------------------------
// Purchases/waste need an exact Request_ID lookup, and the admin only displays
// the newest movement page. Neither operation needs the full movement sheet.
// ============================================================

var findCafeMovementByRequestIdBeforeReadPerf_ = findCafeMovementByRequestId_;
findCafeMovementByRequestId_ = function (sheet, requestId) {
  var wanted = String(requestId || "");
  if (!sheet || !wanted || sheet.getLastRow() < 2) return null;
  var lastRow = sheet.getLastRow();
  var requestColumn = CAFE_MOVEMENTS_HEADER.length;
  var range = sheet.getRange(2, requestColumn, lastRow - 1, 1);

  if (typeof range.createTextFinder === "function") {
    var finder = range.createTextFinder(wanted).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
    for (var m = 0; m < matches.length; m++) {
      var rowNumber = matches[m].getRow();
      var row = sheet.getRange(rowNumber, 1, 1, CAFE_MOVEMENTS_HEADER.length).getValues()[0];
      if (String(row[requestColumn - 1] || "") === wanted) return { rowNumber: rowNumber, row: row };
    }
    return null;
  }

  var ids = range.getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "") !== wanted) continue;
    var rowNo = i + 2;
    return { rowNumber: rowNo, row: sheet.getRange(rowNo, 1, 1, CAFE_MOVEMENTS_HEADER.length).getValues()[0] };
  }
  return null;
};

var readCafeStockMovementsBeforeReadPerf_ = readCafeStockMovements_;
readCafeStockMovements_ = function (doc, limit) {
  var sheet = doc.getSheetByName(CAFE_MOVEMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], total: 0 };

  var total = sheet.getLastRow() - 1;
  var want = Math.min(200, Math.max(1, Number(limit) || CAFE_MOVEMENTS_PAGE));
  var count = Math.min(total, want);
  var startRow = sheet.getLastRow() - count + 1;
  var data = sheet.getRange(startRow, 1, count, CAFE_MOVEMENTS_HEADER.length).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    rows.push({
      date: data[i][0], direction: String(data[i][1] || ""), reason: String(data[i][2] || ""),
      reasonLabel: CAFE_MOVEMENT_REASONS[String(data[i][2] || "")] || String(data[i][2] || ""),
      inventoryId: String(data[i][3] || ""), name: String(data[i][4] || ""),
      qty: Number(data[i][5]) || 0, unit: String(data[i][6] || ""),
      cost: Number(data[i][7]) || 0, remaining: Number(data[i][8]) || 0,
      note: String(data[i][9] || ""), by: String(data[i][10] || "")
    });
  }
  rows.reverse();
  return { rows: rows, total: total };
};
''')

replace_once('cafe_admin.html',
"      // The movement list and the low-stock card both come from the server.\n      await syncData();\n    }\n\n    /** What is at or under its low-stock level, emptiest first. */",
"      // The authoritative inventory is already on screen. Refresh movement\n      // history and health after releasing this action instead of keeping the\n      // purchase/waste button waiting on a second Apps Script round trip.\n      settleCafeAdminWriteInBackground_();\n    }\n\n    let cafeWriteRefreshInFlight_ = false;\n    let cafeWriteRefreshPending_ = false;\n\n    async function runCafeAdminWriteRefresh_() {\n      if (cafeWriteRefreshInFlight_) return;\n      cafeWriteRefreshInFlight_ = true;\n      try {\n        while (cafeWriteRefreshPending_) {\n          cafeWriteRefreshPending_ = false;\n          while (state.refreshing) await new Promise(resolve => setTimeout(resolve, 40));\n          await syncData();\n        }\n      } finally {\n        cafeWriteRefreshInFlight_ = false;\n      }\n    }\n\n    function settleCafeAdminWriteInBackground_() {\n      cafeWriteRefreshPending_ = true;\n      setTimeout(() => { runCafeAdminWriteRefresh_(); }, 0);\n    }\n\n    /** What is at or under its low-stock level, emptiest first. */")

append_test(r'''
const CAFE_MOVEMENTS_HEADER = [
  'Sana',"Yo'nalish",'Sabab','Mahsulot_ID','Nomi','Miqdor','Birlik','Tannarx','Qoldiq','Izoh','Kim','Request_ID'
];

test('cafe movement retry lookup and recent history avoid a full-sheet read', () => {
  const movementRows = [CAFE_MOVEMENTS_HEADER];
  for (let i = 0; i < 100; i++) {
    movementRows.push([
      `2026-08-17T00:${String(i % 60).padStart(2,'0')}:00.000Z`, 'in', 'purchase', 'item', 'Cola',
      1, 'dona', 1000, i + 1, '', 'admin', `move_${i}`
    ]);
  }
  const gas = loadScript({ sheets: { System_Config: [], Cafe_Stock_Movements: movementRows } });
  const sheet = gas.__spreadsheet.getSheetByName('Cafe_Stock_Movements');
  let fullReads = 0;
  const original = sheet.getDataRange;
  sheet.getDataRange = function () { fullReads++; return original.call(sheet); };

  const found = gas.findCafeMovementByRequestId_(sheet, 'move_77');
  assert.strictEqual(found.row[11], 'move_77');
  const page = gas.readCafeStockMovements_(gas.__spreadsheet, 40);
  assert.strictEqual(page.total, 100);
  assert.strictEqual(page.rows.length, 40);
  assert.strictEqual(page.rows[0].remaining, 100);
  assert.strictEqual(fullReads, 0);
});

test('cafe admin releases stock movement after the authoritative write', () => {
  const source = fs.readFileSync(path.join(ROOT, 'cafe_admin.html'), 'utf8');
  const block = source.match(/async function submitStockMovement[\s\S]*?function renderLowStock/)[0];
  assert.match(block, /settleCafeAdminWriteInBackground_\(\)/);
  assert.doesNotMatch(block, /await syncData\(\)/);
});
''')

rebuild_and_test('Point 3 - cafe stock/purchases')
commit('perf: speed cafe stock and purchase recording')

# ---------------------------------------------------------------------------
# 4. Mini App accounting: do not keep a successful save awaiting the fresh view.
# ---------------------------------------------------------------------------
replace_once('assets/mini/03-omad.js',
"function tenantOptions(includeBuckets) {",
"let miniOmadRefreshInFlight_ = false;\nlet miniOmadRefreshPending_ = false;\n\nasync function runMiniOmadWriteRefresh_() {\n    if (miniOmadRefreshInFlight_) return;\n    miniOmadRefreshInFlight_ = true;\n    try {\n        while (miniOmadRefreshPending_) {\n            miniOmadRefreshPending_ = false;\n            await loadOmad();\n        }\n    } finally {\n        miniOmadRefreshInFlight_ = false;\n    }\n}\n\nfunction settleMiniOmadWrite_() {\n    miniOmadRefreshPending_ = true;\n    setTimeout(() => { runMiniOmadWriteRefresh_(); }, 0);\n}\n\nfunction tenantOptions(includeBuckets) {")
# There are exactly two awaited refreshes in the two save functions in this file.
text = read('assets/mini/03-omad.js')
needle = "        flushReports();\n        await loadOmad();"
if text.count(needle) != 2:
    raise RuntimeError(f'assets/mini/03-omad.js: expected 2 post-save awaited refreshes, found {text.count(needle)}')
write('assets/mini/03-omad.js', text.replace(needle, "        flushReports();\n        settleMiniOmadWrite_();"))

append_test(r'''
test('Mini App accounting refreshes after returning from a successful save', () => {
  const source = fs.readFileSync(path.join(ROOT, 'assets/mini/03-omad.js'), 'utf8');
  assert.match(source, /function settleMiniOmadWrite_/);
  const submitEntry = source.match(/async function submitEntry[\s\S]*?function openTenantPaidSheet/)[0];
  const submitPair = source.match(/async function submitTenantPaid[\s\S]*?async function loadOmad/)[0];
  assert.match(submitEntry, /settleMiniOmadWrite_\(\)/);
  assert.match(submitPair, /settleMiniOmadWrite_\(\)/);
  assert.doesNotMatch(submitEntry, /await loadOmad\(\)/);
  assert.doesNotMatch(submitPair, /await loadOmad\(\)/);
});
''')

rebuild_and_test('Point 4 - Mini App accounting')
commit('perf: refresh Mini App accounting in background')

# ---------------------------------------------------------------------------
# 5. Café POS: one sale request at a time, with a local button state.
# ---------------------------------------------------------------------------
replace_once('cafe_pos.html',
"    <button onclick=\"sell()\" class=\"w-full rounded-2xl bg-blue-600 text-white py-4 text-base font-bold active:scale-95\">Sotish</button>",
"    <button onclick=\"sell()\" id=\"sellBtn\" class=\"w-full rounded-2xl bg-blue-600 text-white py-4 text-base font-bold active:scale-95 disabled:opacity-60\">Sotish</button>")
replace_once('cafe_pos.html',
"      refreshing: false\n    };",
"      refreshing: false,\n      selling: false\n    };")
replace_once('cafe_pos.html',
"    async function sell() {\n      if (!state.cart.length) return alert(\"Savat bo'sh\");\n\n      // Only what was ordered.",
"    async function sell() {\n      if (!state.cart.length) return alert(\"Savat bo'sh\");\n      if (state.selling) return;\n      const sellButton = document.getElementById(\"sellBtn\");\n      state.selling = true;\n      if (sellButton) { sellButton.disabled = true; sellButton.textContent = \"Sotilmoqda...\"; }\n\n      // Only what was ordered.")
replace_once('cafe_pos.html',
"      } catch (e) {\n        // The request id is kept so a retry resolves to the same sale, and the\n        // reason is shown: \"not enough stock\" is not a network problem.\n        alert(e && e.message ? e.message : \"Sotishda xatolik. Internetni tekshiring.\");\n      }\n    }",
"      } catch (e) {\n        // The request id is kept so a retry resolves to the same sale, and the\n        // reason is shown: \"not enough stock\" is not a network problem.\n        alert(e && e.message ? e.message : \"Sotishda xatolik. Internetni tekshiring.\");\n      } finally {\n        state.selling = false;\n        if (sellButton) { sellButton.disabled = false; sellButton.textContent = \"Sotish\"; }\n      }\n    }")

append_test(r'''
test('Cafe POS prevents overlapping sale submissions and restores the button', () => {
  const source = fs.readFileSync(path.join(ROOT, 'cafe_pos.html'), 'utf8');
  assert.match(source, /id="sellBtn"/);
  const sell = source.match(/async function sell\(\)[\s\S]*?async function voidSale/)[0];
  assert.match(sell, /if \(state\.selling\) return/);
  assert.match(sell, /sellButton\.disabled = true/);
  assert.match(sell, /finally/);
  assert.match(sell, /sellButton\.disabled = false/);
});
''')

rebuild_and_test('Point 5 - cafe POS')
commit('perf: guard cafe POS sale submissions')

# ---------------------------------------------------------------------------
# 6. Scoped saving indicators: keep navigation alive while locking only the
#    mutable form that owns the request.
# ---------------------------------------------------------------------------
replace_once('assets/tasks/01-tasks-api.js',
"async function taskMutation(payload, okMessage) {\n    taskLoader(true);\n    try {",
"function setTaskMutationBusy_(busy) {\n    TASKS_STATE.mutationInFlight = !!busy;\n    const modal = document.getElementById('taskModal');\n    if (!modal || modal.classList.contains('hidden')) return;\n    modal.querySelectorAll('input, select, textarea, button').forEach(control => {\n        if (busy) {\n            control.dataset.taskBusyDisabled = control.disabled ? '1' : '0';\n            control.disabled = true;\n        } else if (control.dataset.taskBusyDisabled !== undefined) {\n            control.disabled = control.dataset.taskBusyDisabled === '1';\n            delete control.dataset.taskBusyDisabled;\n        }\n    });\n    const save = document.getElementById('taskSaveBtn');\n    if (save) save.textContent = busy ? 'Saqlanmoqda...' : '💾 Saqlash';\n}\n\nasync function taskMutation(payload, okMessage) {\n    if (TASKS_STATE.mutationInFlight) return null;\n    setTaskMutationBusy_(true);\n    try {")
replace_once('assets/tasks/01-tasks-api.js',
"    } finally {\n        taskLoader(false);\n    }\n}\n\nfunction tasksSave",
"    } finally {\n        setTaskMutationBusy_(false);\n    }\n}\n\nfunction tasksSave")

# Omad entry form: disable only the entry controls, not the full application.
replace_once('assets/omad/12-app.js',
"// An old backend treats request ids as opaque strings.",
"function setOmadEntryBusy_(busy) {\n    const panel = document.getElementById('tab-entry');\n    if (!panel) return;\n    panel.setAttribute('aria-busy', busy ? 'true' : 'false');\n    panel.querySelectorAll('input, select, textarea, button').forEach(control => {\n        if (busy) {\n            control.dataset.omadBusyDisabled = control.disabled ? '1' : '0';\n            control.disabled = true;\n        } else if (control.dataset.omadBusyDisabled !== undefined) {\n            control.disabled = control.dataset.omadBusyDisabled === '1';\n            delete control.dataset.omadBusyDisabled;\n        }\n    });\n}\n\n// An old backend treats request ids as opaque strings.")
replace_once('assets/omad/12-app.js',
"    showLoader(true);\n    try {\n        if (!editId) {",
"    setOmadEntryBusy_(true);\n    try {\n        if (!editId) {")
replace_once('assets/omad/12-app.js',
"    } finally {\n        showLoader(false);\n    }\n\n    settleOmadWriteInBackground_();",
"    } finally {\n        setOmadEntryBusy_(false);\n    }\n\n    settleOmadWriteInBackground_();")
replace_once('assets/omad/12-app.js',
"    btn.disabled = true; btn.innerText = \"Bajarilmoqda...\";\n    showLoader(true);",
"    btn.disabled = true; btn.innerText = \"Bajarilmoqda...\";\n    setOmadEntryBusy_(true);")
replace_once('assets/omad/12-app.js',
"    } finally {\n        showLoader(false);\n        btn.disabled = false;",
"    } finally {\n        setOmadEntryBusy_(false);\n        btn.disabled = false;")

append_test(r'''
test('saving indicators lock only the owning task/Omad form', () => {
  const tasks = fs.readFileSync(path.join(ROOT, 'assets/tasks/01-tasks-api.js'), 'utf8');
  const omad = fs.readFileSync(path.join(ROOT, 'assets/omad/12-app.js'), 'utf8');
  const taskMutation = tasks.match(/async function taskMutation[\s\S]*?function tasksSave/)[0];
  assert.match(tasks, /function setTaskMutationBusy_/);
  assert.doesNotMatch(taskMutation, /taskLoader\(/);
  assert.match(taskMutation, /mutationInFlight/);

  const ledgerSubmit = omad.match(/submitViaLedger = async function[\s\S]*?submitTenantPaid = async function/)[0];
  const tenantPaid = omad.match(/submitTenantPaid = async function[\s\S]*?window\.onload/)[0];
  assert.match(omad, /function setOmadEntryBusy_/);
  assert.doesNotMatch(ledgerSubmit, /showLoader\(/);
  assert.doesNotMatch(tenantPaid, /showLoader\(/);
  assert.match(ledgerSubmit, /setOmadEntryBusy_\(true\)/);
  assert.match(tenantPaid, /setOmadEntryBusy_\(true\)/);
});
''')

rebuild_and_test('Point 6 - scoped saving indicators')
commit('perf: keep app navigation responsive while saving')

# ---------------------------------------------------------------------------
# Documentation sync after all behavior is known.
# ---------------------------------------------------------------------------
brief = read('docs/APP_BRIEF.md')
brief = brief.replace(
"| `12b_cafe_write_performance.gs` | Faster durable café sale retry lookup without changing stock or idempotency rules |\n",
"| `12b_cafe_write_performance.gs` | Faster durable café sale retry lookup without changing stock or idempotency rules |\n"
"| `12c_cafe_read_performance.gs` | Narrow stock-movement retry lookup and tail-only recent movement reads |\n")
brief = brief.replace(
"| `14a_ledger_write_performance.gs` | Fast ledger request lookup / ID allocation and atomic multi-line entry creation |\n",
"| `14a_ledger_write_performance.gs` | Fast ledger request lookup / ID allocation and atomic multi-line entry creation |\n"
"| `14b_ledger_edit_performance.gs` | Exact transaction-ID lookup for corrections, cancellations and reads |\n")
brief = brief.replace(
"| `17_tasks_store.gs` | `Tasks` / `Task_Occurrences` sheets, occurrences, view model |\n",
"| `17_tasks_store.gs` | `Tasks` / `Task_Occurrences` sheets, occurrences, view model |\n"
"| `17a_tasks_write_performance.gs` | Exact task/occurrence ID lookup for hot task mutations |\n")
brief = brief.replace(
"| `19a_tasks_wizard.gs` | The `📋 Vazifa` branch of `/yangi` |\n",
"| `19a_tasks_wizard.gs` | The `📋 Vazifa` branch of `/yangi` |\n"
"| `19b_tasks_write_performance.gs` | Fast task mutation response plus background scheduler/view settling |\n")
brief = brief.replace(
"| `20a_write_performance_api.gs` | Batch-ledger API extension with rollout-safe fallback semantics |\n",
"| `20a_write_performance_api.gs` | Batch-ledger API extension with rollout-safe fallback semantics |\n"
"| `20b_ledger_edit_performance_api.gs` | One-request group edits using the existing append-only correction/cancel rules |\n")
brief = brief.replace(
"  one batch action and one ledger write; the single-row API remains the safe\n  rollout fallback and the edit/correction path.",
"  one batch action and one ledger write. Group edits use one HTTP action that\n  performs the same append-only corrections/additions/cancellations server-side;\n  the single-row API remains the rollout-safe fallback for older deployments.")
brief = brief.replace(
"- Board tabs: Bugun | Vazifalar | Muntazam | Maqsadlar | Bajarilgan.\n",
"- Board tabs: Bugun | Vazifalar | Muntazam | Maqsadlar | Bajarilgan.\n"
"- Web/Mini App task mutations may return as soon as their rows are durable; the\n  full scheduler/Telegram settle and board refresh follow in a non-blocking request,\n  with the existing time trigger as the fallback if the client disappears.\n")
write('docs/APP_BRIEF.md', brief)

rebuild_and_test('Documentation sync')
commit('docs: sync app brief with responsiveness pass')

# Full browser suite after the six independent points are green under unit tests.
print('\n=== Full browser regression ===', flush=True)
run('npm', 'run', 'test:e2e')
run('npm', 'run', 'lint')
run('npm', 'run', 'scan:secrets')
run('npm', 'run', 'build:check')

# Self-clean: this patch mechanism is temporary and must not remain in main.
workflow = ROOT / '.github/workflows/perf-app-wide-patch.yml'
if workflow.exists(): workflow.unlink()
self_path = ROOT / 'scripts/apply_app_perf_pass.py'
if self_path.exists(): self_path.unlink()
run('git', 'add', '-A')
run('git', 'commit', '-m', 'chore: remove temporary performance patch tooling')

# One push publishes all individually tested commits to the feature branch.
branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip()
run('git', 'push', 'origin', f'HEAD:{branch}')
print('\nPerformance pass applied, tested point-by-point, and pushed.', flush=True)
