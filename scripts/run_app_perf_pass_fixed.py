#!/usr/bin/env python3
from pathlib import Path
import os
import re
import sys

root = Path(__file__).resolve().parents[1]
script = root / 'scripts' / 'apply_app_perf_pass.py'
text = script.read_text()

# ---------------------------------------------------------------------------
# Harden TextFinder use for the test harness. Production Sheets supports the
# fluent API; the harness intentionally exposes only a stub, so use the narrow
# one-column fallback there rather than a full-sheet read.
# ---------------------------------------------------------------------------
old_task = '''    var finder = idRange.createTextFinder(String(wanted)).matchEntireCell(true);\n    if (typeof finder.matchCase === "function") finder.matchCase(true);\n    var matches = finder.findAll();'''
new_task = '''    var finder = idRange.createTextFinder(String(wanted));\n    if (finder && typeof finder.matchEntireCell === "function" &&\n        typeof finder.findAll === "function") {\n      finder = finder.matchEntireCell(true);\n      if (typeof finder.matchCase === "function") finder.matchCase(true);\n      var matches = finder.findAll();'''
if text.count(old_task) != 1:
    raise RuntimeError('expected one task TextFinder snippet, found %d' % text.count(old_task))
text = text.replace(old_task, new_task)

old_task_close = '''      if (String(row[0] || "") === String(wanted)) return { rowNumber: rowNumber, row: row };\n    }\n    return null;\n  }\n\n  var ids = idRange.getValues();'''
new_task_close = '''      if (String(row[0] || "") === String(wanted)) return { rowNumber: rowNumber, row: row };\n    }\n      return null;\n    }\n  }\n\n  var ids = idRange.getValues();'''
if text.count(old_task_close) != 1:
    raise RuntimeError('expected one task TextFinder closing snippet, found %d' % text.count(old_task_close))
text = text.replace(old_task_close, new_task_close)

old_ledger = '''    var finder = idRange.createTextFinder(wanted).matchEntireCell(true);\n    if (typeof finder.matchCase === "function") finder.matchCase(true);\n    var matches = finder.findAll();'''
new_ledger = '''    var finder = idRange.createTextFinder(wanted);\n    if (finder && typeof finder.matchEntireCell === "function" &&\n        typeof finder.findAll === "function") {\n      finder = finder.matchEntireCell(true);\n      if (typeof finder.matchCase === "function") finder.matchCase(true);\n      var matches = finder.findAll();'''
if text.count(old_ledger) != 1:
    raise RuntimeError('expected one ledger TextFinder snippet, found %d' % text.count(old_ledger))
text = text.replace(old_ledger, new_ledger)

old_ledger_close = '''      if (String(row[0] || "") === wanted) return ledgerRowToTransaction_(row, rowNumber);\n    }\n    return null;\n  }\n\n  var ids = idRange.getValues();'''
new_ledger_close = '''      if (String(row[0] || "") === wanted) return ledgerRowToTransaction_(row, rowNumber);\n    }\n      return null;\n    }\n  }\n\n  var ids = idRange.getValues();'''
if text.count(old_ledger_close) != 1:
    raise RuntimeError('expected one ledger TextFinder closing snippet, found %d' % text.count(old_ledger_close))
text = text.replace(old_ledger_close, new_ledger_close)

old_move = '''    var finder = range.createTextFinder(wanted).matchEntireCell(true);\n    if (typeof finder.matchCase === "function") finder.matchCase(true);\n    var matches = finder.findAll();'''
new_move = '''    var finder = range.createTextFinder(wanted);\n    if (finder && typeof finder.matchEntireCell === "function" &&\n        typeof finder.findAll === "function") {\n      finder = finder.matchEntireCell(true);\n      if (typeof finder.matchCase === "function") finder.matchCase(true);\n      var matches = finder.findAll();'''
if text.count(old_move) != 1:
    raise RuntimeError('expected one cafe TextFinder snippet, found %d' % text.count(old_move))
text = text.replace(old_move, new_move)

old_move_close = '''      if (String(row[requestColumn - 1] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n    return null;\n  }\n\n  var ids = range.getValues();'''
new_move_close = '''      if (String(row[requestColumn - 1] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n      return null;\n    }\n  }\n\n  var ids = range.getValues();'''
if text.count(old_move_close) != 1:
    raise RuntimeError('expected one cafe TextFinder closing snippet, found %d' % text.count(old_move_close))
text = text.replace(old_move_close, new_move_close)

# ---------------------------------------------------------------------------
# Point 1 routing fix.
#
# The first draft made `deferTaskSettle` itself alter runTaskAction_. That was
# too broad: direct/internal callers and existing API tests still expect the
# old full response, and an unauthenticated request must be refused before any
# task lookup. Fast mode is now enabled only after a real gate has authenticated
# the request. A private object-reference marker cannot be forged by JSON.
# Mini App identity sanitation is preserved by delegating through the original
# miniTaskAction_ before runTaskAction_ sees the marker.
# ---------------------------------------------------------------------------
new_19b = r'''write('apps-script/19b_tasks_write_performance.gs', r'''// ============================================================
// Task response performance
// ------------------------------------------------------------
// A task mutation is durable once its task/occurrence rows and required queue
// rows are stored. Rebuilding the whole board and running the full scheduler in
// the same HTTP request made the phone wait for work that can safely follow.
// Opt-in authenticated clients now ask for a fast response, then fire
// `settle_tasks` without awaiting it. The normal time trigger remains the
// durable fallback if that follow-up request never arrives.
// ============================================================

var TASK_FAST_TRUST_MARKER_ = {};

function trustedTaskFastPayload_(payload) {
  var source = payload || {};
  var trusted = {};
  Object.keys(source).forEach(function (key) { trusted[key] = source[key]; });
  // JSON cannot recreate this object identity. Only a server-side gate that
  // already authenticated the request can attach the marker.
  trusted.__taskFastTrust = TASK_FAST_TRUST_MARKER_;
  return trusted;
}

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

function runTaskMutationFast_(action, payload, doc) {
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

// The legacy/internal function keeps exactly its old semantics unless a server
// gate attached the unforgeable in-memory marker above.
var runTaskActionBeforeWritePerf_ = runTaskAction_;
runTaskAction_ = function (action, payload, doc) {
  if (payload && payload.__taskFastTrust === TASK_FAST_TRUST_MARKER_) {
    return runTaskMutationFast_(action, payload, doc);
  }
  return runTaskActionBeforeWritePerf_(action, payload, doc);
};

// Web board: authenticate first, then opt into the fast mutation. Ordinary
// callers still receive the historical full view/config response.
var handleTaskActionBeforeWritePerf_ = handleTaskAction_;
handleTaskAction_ = function (action, payload, doc) {
  if (action === "settle_tasks") {
    var settleAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
    if (!settleAuth.ok) return authRefusal_(settleAuth);
    return jsonOutput_(settleTaskMutationWork_(doc, payload));
  }
  if (payload && payload.deferTaskSettle === true && isTaskMutationAction_(action)) {
    var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
    if (!auth.ok) return authRefusal_(auth);
    return runTaskAction_(action, trustedTaskFastPayload_(payload), doc);
  }
  return handleTaskActionBeforeWritePerf_(action, payload, doc);
};

// Mini App: handleMiniAppAction_ has already verified signed initData before it
// reaches here. For mutations we still delegate through the original
// miniTaskAction_, which strips caller-supplied identity fields and writes the
// verified Telegram identity back before invoking runTaskAction_.
var miniTaskActionBeforeWritePerf_ = miniTaskAction_;
miniTaskAction_ = function (doc, payload, auth) {
  var taskAction = String((payload && payload.taskAction) || "");
  if (taskAction === "settle_tasks") {
    return jsonOutput_(settleTaskMutationWork_(doc, payload));
  }
  if (payload && payload.deferTaskSettle === true && isTaskMutationAction_(taskAction)) {
    return miniTaskActionBeforeWritePerf_(doc, trustedTaskFastPayload_(payload), auth);
  }
  return miniTaskActionBeforeWritePerf_(doc, payload, auth);
};
''')'''

pattern_19b = r"write\('apps-script/19b_tasks_write_performance\.gs', r'''[\s\S]*?'''\)\n\nreplace_once\('assets/tasks/01-tasks-api\.js',"
replacement_19b = new_19b + "\n\nreplace_once('assets/tasks/01-tasks-api.js',"
text, count = re.subn(pattern_19b, lambda m: replacement_19b, text, count=1)
if count != 1:
    raise RuntimeError('could not replace the Point 1 routing block')

old_test = r'''test('deferred task mutations skip the inline scheduler and board rebuild', () => {
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
});'''
new_test = r'''test('authenticated deferred task mutations skip scheduler/view without changing legacy semantics', () => {
  const gas = bootTasks();
  let schedulerCalls = 0;
  gas.runTaskScheduler_ = function () { schedulerCalls++; return {}; };

  const fast = readJsonOutput(gas.handleTaskAction_('save_task', {
    adminKey: 'perf-admin', type: 'once', title: 'Fast save', responsible: 'Ali', reminderTimes: [],
    deferTaskSettle: true
  }, gas.__spreadsheet));
  assert.strictEqual(fast.status, 'success');
  assert.strictEqual(fast.view, undefined);
  assert.strictEqual(schedulerCalls, 0);

  const legacy = readJsonOutput(gas.runTaskAction_('save_task', {
    type: 'once', title: 'Legacy semantics', responsible: 'Ali', reminderTimes: [],
    deferTaskSettle: true
  }, gas.__spreadsheet));
  assert.strictEqual(legacy.status, 'success');
  assert.ok(legacy.view, 'direct/internal runTaskAction keeps its historical view response');
  assert.strictEqual(schedulerCalls, 1);

  const refused = readJsonOutput(gas.handleTaskAction_('cancel_task', {
    id: 'missing', deferTaskSettle: true
  }, gas.__spreadsheet));
  assert.strictEqual(refused.status, 'error');
  assert.notStrictEqual(refused.message, 'Vazifa topilmadi.');

  assert.strictEqual(gas.isTaskAction_('settle_tasks'), true);
  assert.strictEqual(gas.isTaskMutationAction_('settle_tasks'), false);
});'''
if text.count(old_test) != 1:
    raise RuntimeError('could not find the original deferred-task custom test')
text = text.replace(old_test, new_test)

script.write_text(text)
# Keep the feature branch clean: the main driver deletes itself and this runner
# after the full green regression pass.
Path(__file__).unlink()
os.execv(sys.executable, [sys.executable, str(script)])
