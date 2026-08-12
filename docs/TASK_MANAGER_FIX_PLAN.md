# Task Manager — remediation specification

> **Implemented in `a95961f..b015c45`.** All eight work items (WI-1…WI-8) are
> done and the eight defects in §2 no longer reproduce. This document is kept
> as the record of what was wrong and why each fix is shaped the way it is; the
> living documentation is [TASKS.md](TASKS.md), [LIVE_STATE.md](LIVE_STATE.md),
> [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) and
> [ARCHITECTURE.md](ARCHITECTURE.md). Nothing here is outstanding work.

**Status:** implemented (see above). Written as a specification.
**Baseline commit:** `8b6f135` (`origin/main` — verified identical to it).
**Target branch:** `claude/task-manager-fixes-swd8p2`.
**Audience:** the engineer/agent implementing the fixes. This document is the
contract: follow it top to bottom.

Everything below was **reproduced against the baseline** with the real backend
running under `tests/gas-harness.js`. Section 2 records the observed output for
each defect so you can confirm you are fixing a real bug and know when it is
gone. Do **not** rebuild the feature; the architecture is sound. Change only
what each work item names.

---

## 1. Ground rules (read before touching anything)

| Rule | Detail |
|---|---|
| Source of truth | `apps-script/*.gs`. **Never hand-edit `script.gs`** — it is generated. Run `npm run build` after every backend edit and commit the regenerated bundle. `npm run build:check` (and CI) fails on a stale bundle. |
| Timezone | All task scheduling/display stays **Asia/Tashkent** via the pure helpers in `16_tasks_recurrence.gs` (fixed UTC+5, epoch-ms math). Never introduce `Utilities.formatDate` or host-local date maths into the task modules. |
| Isolation | The Task module must not read or write financial data (`Omad_Transactions`, `Omad_Transactions_V2`, ledger, rates, tenants). `tests/task-isolation.test.js` guards this — keep it passing. |
| Omad V2 | *(Superseded — this rule applied while the ledger was un-migrated. The V2 cutover happened on 2026-08-12 and V2 is now live; see [APP_BRIEF.md](APP_BRIEF.md).)* |
| `/yangi` | Do not weaken its private-chat + authorized-user gating, and do not widen `isTaskTelegramUpdate_` beyond what §3.6 specifies. |
| Telegram delivery | Every send goes through the existing `Omad_Job_Queue` (`enqueueJob_` → `runJob_`). Do not add a parallel retry/timer mechanism. |
| Data compatibility | Task rows written by the current implementation must keep working. Column **order** in `TASKS_HEADER` / `TASK_OCC_HEADER` is positional on read — you may **append** columns at the end, never insert or reorder. This spec needs no new columns. |
| Language | User-facing strings are Uzbek Latin, matching the surrounding code. Code comments explain *why*, in the register already used in these files. |
| Style | ES5 only (`var`, no arrow functions, no `let`/`const`, no template literals) inside `apps-script/*.gs`. Private helpers end with `_`. Frontend `assets/**` is modern JS. |
| Deployment | **Do not deploy.** Do not touch the live Apps Script deployment or Script Properties. Manual operator steps get documented, not executed. |

### Commands

```bash
npm run build           # regenerate script.gs from apps-script/*.gs
npm run build:check     # fail if script.gs is stale
npm run lint            # static analysis (syntax + duplicate function names)
npm run scan:secrets
npm run scan:secrets:history
npm test                # unit  — baseline: 371 passing
npm run test:e2e        # browser (auto-skips if playwright is missing)
```

Playwright is **not** installed in a fresh checkout. Install it without saving
and reuse the preinstalled Chromium — do **not** run `playwright install`:

```bash
npm install --no-save playwright@1.56.1
# PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers is already exported in this image
npm run test:e2e
```

### Files in scope

```
apps-script/01_shared_utils.gs      (no change expected)
apps-script/02_validation.gs        WI-6
apps-script/03_settings.gs          WI-6
apps-script/09_telegram_service.gs  WI-4  (sendTelegramMessage_ options)
apps-script/10_retry_queue.gs       WI-4  (permanent-failure hook)
apps-script/16_tasks_recurrence.gs  WI-1
apps-script/17_tasks_store.gs       WI-1, 2, 3, 7, 8
apps-script/18_tasks_service.gs     WI-4, 7
apps-script/19_tasks_scheduler.gs   WI-2, 3, 4, 5, 7, 8
apps-script/20_api.gs               WI-5
assets/tasks/01-tasks-api.js        WI-5, 8
assets/tasks/03-tasks-render.js     WI-5, 8
assets/tasks/04-tasks-app.js        WI-3, 5, 7
tasks.html                          WI-3, 5, 7
omad_admin.html                     WI-6 (hint text only)
docs/TASKS.md, docs/LIVE_STATE.md, docs/TELEGRAM_SETUP.md, docs/ARCHITECTURE.md
tests/…                             see §5
```

---

## 2. Verified defects (evidence from the baseline)

Reproduction harness: load `script.gs` via `tests/gas-harness.js`, create tasks
through the real API, then inspect the sheets. Fixed clock
`NOW = Date.UTC(2026, 7, 10, 4, 0, 0)` = **2026-08-10 09:00 Tashkent**,
`TODAY = '2026-08-10'`.

### 2.1 Google Sheets destroys every task date key (most severe)

With the harness's `coerceLikeSheets` extended to the two shapes real Sheets
also rewrites (`YYYY-MM-DD` → date, `HH:mm` → time), a routine written by
`appendTaskRow_` reads back as:

```
Start_Key   = Date(2026-08-10)   -> readTaskRows_ gives startKey  = ""
End_Key     = Date(2026-09-30)   -> readTaskRows_ gives endKey    = ""
Due_Time    = Date(1899-12-30 20:00) -> dueTime  = ""
Deadline_Key/Deadline_Time (once task)     -> "" / ""
Task_Occurrences.Date_Key = Date(...)      -> occ.dateKey = ""
```

Consequences: routines lose their bounds and due time (never overdue); the
`byDate` idempotency key in `materializeTaskOccurrences_` collapses to `""` so
every scheduler pass re-creates the whole horizon; the Today view put **16**
items in `dueToday`; streaks/rates/`todayOccurrence` all break.
`17_tasks_store.gs` contains **no** `setNumberFormat` — the protection the
accounting fix added (`applyTransactionColumnFormats_`,
`applyLedgerColumnFormats_`) was never extended to the task sheets.

### 2.2 Pausing a routine does not stop anything already materialised

```
pause_routine -> task status: paused
next scheduler pass (NOW + 1 day) -> 2 Telegram messages sent
first message: "🆕 🔵 Yangi vazifa … 📌 Kassa … 📅 Sana: 11.08.2026"
```

`materializeTaskOccurrences_` correctly refuses to create new rows for a paused
routine, but `runTaskScheduler_`'s notify/remind loop iterates **all**
occurrence rows and never looks at the parent task's status. The 14-day horizon
is already on disk, so a paused routine keeps announcing and reminding.
`runTaskNotifyJob_` / `runTaskReminderJob_` have the same blind spot for jobs
enqueued before the pause.

### 2.3 Editing does not reconcile

*One-time task.* Created `Eski / 2026-08-12 17:00 / Ali / low / photo:false`,
edited to `Yangi / 2026-08-20 10:00 / Vali / urgent / photo:true`. The
occurrence afterwards:

```
title=Eski dateKey=2026-08-12 responsible=Ali priority=low photoRequired=false
```

`saveTaskAction_` rewrites the `Tasks` row and then calls
`materializeTaskOccurrences_`, which sees `existing.length !== 0` and does
nothing. Nothing ever reaches the occurrence.

*Goal.* Steps `[A,B,C]` → edited to `[A,B2]`:

```
occurrences: 0:Filial — A:Open | 1:Filial — B:Open | 2:Filial — C:Open
progress:    {"done":0,"total":3,"percent":0}
```

The rename is lost, the removed step's occurrence lives on, and it keeps the
goal from ever reaching 100 %.

*Type change.* `once` → `routine` on an existing task:

```
save result: success | stored type: routine
occurrence taskTypes: once,routine,routine,… (15 rows)
```

The original `once` occurrence is orphaned beside a fresh routine horizon.

*Routine.* `pruneReplaceableRoutineOccurrences_` only removes occurrences with
`dateKey > todayKey`, so today's row keeps the old title/responsible/priority/
due time, and announced future rows that no longer match the new schedule are
never withdrawn.

### 2.4 The photo-proof flow can be hijacked and can get stuck

```
Ali presses   -> proofAwaitingUserId = 111
Bek presses   -> proofAwaitingUserId = 222, completedByName = "Bek"   (takeover)
card markup while waiting:
  {"inline_keyboard":[[{"text":"✅ Ish bajarildi","callback_data":"t_done:occ_…"}]]}
```

Two pending proofs for one user, then one unrelated photo with no reply:

```
Ish A  WaitingProof  (no proof)
Ish B  Completed     proofFileId=zz      <- the wrong task was satisfied
```

Root causes in `18_tasks_service.gs`: `handleTaskCallback_` does not treat
`TASK_STATUS_WAITING` as a claim; `runTaskUpdateMessageJob_` only clears the
keyboard for `Completed/Cancelled/Skipped`; `handleTaskGroupMessage_` falls back
to "the user's most recently updated pending proof" when the photo is not a
reply; the proof prompt is sent inline inside a `try/catch` that swallows the
failure after the row has already been flipped to `WaitingProof`.

### 2.5 Task reads are anonymous

```
POST {action:"get_tasks"}            -> success | tasks: "Maxfiy ichki vazifa"
GET  ?action=get_tasks               -> success | tasks: "Maxfiy ichki vazifa"
```

`handleTaskAction_` answers read actions **before** `checkAdminKey_`, and
`doGet` has its own unguarded `get_tasks` branch. Internal titles, responsible
people, deadlines and completion history are public to anyone with the
deployment URL.

### 2.6 The Tasks group id accepts `@username`, which can never match

```
save tasksGroupChatId="@mygroup" -> success | stored: @mygroup
isTaskTelegramUpdate_({message:{chat:{id:-1009998887777},photo:[…]}}) -> false
```

`validateTelegramChatId_` allows `@username`; incoming updates only ever carry
the numeric `chat.id`, so every callback and photo is silently dropped while the
settings page shows a healthy configuration.

### 2.7 Goals are half-wired

```
goal photoRequired=true, steps ["A","B"] -> step occurrences photoRequired: false,false
scheduler pass -> 0 Telegram messages for goal steps
```

`normalizeGoalSteps_` always writes `photoRequired: <bool>`, so the
`step.photoRequired !== undefined` inheritance branch in
`buildOccurrenceForGoalStep_` is dead code. `runTaskScheduler_` starts its loop
with `if (occ.taskType === "goal") continue;`, so goal steps are never announced
and reminder times configured on a goal do nothing at all.

### 2.8 Smaller correctness issues

```
3 completed days + today Open (due 20:00, now 09:00)
  -> {"streak":0,"completed":3,"counted":4,"completionRate":75}

complete_occurrence on 2026-08-11 (tomorrow) -> success, status Completed

steady-state scheduler pass, 5 routines
  -> 6 full getDataRange() scans of Task_Occurrences (1 per task + 1 for the loop)
```

---

## 3. Work items

Each item is independent enough to be one commit. Suggested order: **WI-1 →
WI-8** (WI-1 first because everything else is built on date keys that survive).

---

### WI-1 — Protect task date/time keys from Sheets coercion

**Files:** `apps-script/16_tasks_recurrence.gs`, `apps-script/17_tasks_store.gs`,
`tests/gas-harness.js`, new `tests/task-date-keys.test.js`.

Mirror the accounting fix exactly: **format the column as text before the value
lands**, and **tolerate an already-coerced cell on read** so existing rows heal
themselves.

#### 1a. Read tolerance — add to `16_tasks_recurrence.gs`

Place after `isTaskTimeKey_`. Pure functions, no spreadsheet access.

```js
/**
 * A YYYY-MM-DD key from whatever the sheet handed back.
 *
 * Exact text wins. A cell the spreadsheet already turned into a real date is
 * recovered from its local year/month/day - the same convention
 * parseTransactionDate_ uses for the accounting columns - so rows written
 * before these columns were text-formatted still read correctly instead of
 * silently becoming "". Anything else is not a date key and returns "".
 */
function taskDateKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return "";
    return value.getFullYear() + "-" + taskPad2_(value.getMonth() + 1) + "-" + taskPad2_(value.getDate());
  }
  var text = String(value).trim();
  if (isTaskDateKey_(text)) return text;
  // A full timestamp in a date column is an instant, not a calendar date;
  // read it in the same local frame a Date cell would have been read in.
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) {
      return instant.getFullYear() + "-" + taskPad2_(instant.getMonth() + 1) + "-" + taskPad2_(instant.getDate());
    }
  }
  return "";
}

/**
 * An HH:mm key from whatever the sheet handed back. Sheets stores a bare
 * "20:00" as 1899-12-30T20:00, so a time cell arrives as a Date whose clock
 * fields are the only part that means anything.
 */
function taskTimeKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getHours === "function") {
    if (isNaN(value.getTime())) return "";
    return taskPad2_(value.getHours()) + ":" + taskPad2_(value.getMinutes());
  }
  var text = String(value).trim();
  if (isTaskTimeKey_(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) return taskPad2_(instant.getHours()) + ":" + taskPad2_(instant.getMinutes());
  }
  var hm = /^(\d{1,2}):([0-5]\d)/.exec(text);
  if (hm && Number(hm[1]) <= 23) return taskPad2_(hm[1]) + ":" + hm[2];
  return "";
}
```

#### 1b. Use them on read — `17_tasks_store.gs`

In `taskFromRow_` replace the four guarded reads:

```js
    dueTime: taskTimeKeyFromCell_(i("Due_Time")),
    deadlineKey: taskDateKeyFromCell_(i("Deadline_Key")),
    deadlineTime: taskTimeKeyFromCell_(i("Deadline_Time")),
    startKey: taskDateKeyFromCell_(i("Start_Key")),
    endKey: taskDateKeyFromCell_(i("End_Key")),
```

In `occurrenceFromRow_`:

```js
    dateKey: taskDateKeyFromCell_(i("Date_Key")),
```

Also make `normalizeTaskTimes_` coercion-tolerant so a reminder list that was
stored oddly still parses — change its per-entry normalisation from
`String(source[i] || "").trim()` to `taskTimeKeyFromCell_(source[i])` and keep
the `isTaskTimeKey_` guard on the result.

#### 1c. Write protection — `17_tasks_store.gs`

Add near the sheet accessors:

```js
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
```

Apply it in **every** write path:

```js
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

function appendOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, row, 1);
  sheet.appendRow(occurrenceToRow_(occ));
  occ.rowNumber = row;
}

function writeOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  if (!occ.rowNumber) return;
  occ.updatedAt = new Date().toISOString();
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, occ.rowNumber, 1);
  sheet.getRange(occ.rowNumber, 1, 1, TASK_OCC_HEADER.length).setValues([occurrenceToRow_(occ)]);
}
```

Add the batch writer used by WI-8 (it must apply formats the same way):

```js
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
```

> `appendOccurrenceRow_` now sets `occ.rowNumber`; that is a strict improvement
> (previously a freshly appended object had none) and nothing depends on it
> being absent.

#### 1d. Harness — `tests/gas-harness.js`

Extend `coerceLikeSheets` with the two shapes the task sheets actually contain.
Insert **before** the existing `yearMonth` branch, and extend the doc comment to
say why:

```js
  // A bare ISO date is a date to Sheets in every locale, and a bare HH:mm is a
  // time - which is exactly how the task sheets lost their keys.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));

  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (hm) return new Date(1899, 11, 30, Number(hm[1]), Number(hm[2]));
```

Only `tests/sheet-date-locale.test.js` currently opts into coercion, and none of
its values match these anchored patterns (`'2026-08-05T10:00:00.000Z'` contains
`T`), so it must keep passing unchanged. Verify that explicitly.

#### 1e. Tests — new `tests/task-date-keys.test.js`

All tests load with `coerceLikeSheets: true`.

| Test | Assertion |
|---|---|
| `a routine's start, end and due time survive the spreadsheet round-trip` | after `appendTaskRow_` + `readTaskRows_`, `startKey === '2026-08-10'`, `endKey === '2026-09-30'`, `dueTime === '20:00'` |
| `the stored Start_Key cell is still text` | raw cell `typeof === 'string'` and equals `'2026-08-10'` |
| `a one-time deadline survives the round-trip` | `deadlineKey === '2026-08-12'`, `deadlineTime === '17:00'`, occurrence `dueAt === taskInstantMs_('2026-08-12','17:00')` |
| `an occurrence Date_Key survives and stays unique` | `occ.dateKey === TODAY`; two `materializeTaskOccurrences_` passes produce **no** duplicate rows |
| `a routine materialises exactly its horizon under coercion` | `readOccurrenceRows_` length equals the non-coercing baseline (15 for a daily routine at `TASK_GENERATION_HORIZON_DAYS = 14`) |
| `the Today view is not flooded when the sheet coerces` | `buildTaskViews_(doc, NOW).counts.dueToday === 1` |
| `a Date_Key that was already coerced by an older write still reads` | seed `Task_Occurrences` with a literal `new Date(2026, 7, 10)` in the `Date_Key` column → `occurrenceFromRow_`/`readOccurrenceRows_` gives `'2026-08-10'` |
| `a Start_Key that was already coerced still drives recurrence` | seed a `Tasks` row with `new Date(2026, 7, 10)` in `Start_Key` → `readTaskRows_()[0].startKey === '2026-08-10'` and materialisation produces the right dates |
| `a rewritten row heals its own cells` | read a coerced row, `writeOccurrenceRow_` it back, raw cell is now the exact string |

**Acceptance:** with coercion on, the full task feature behaves identically to
coercion off. A good extra check while developing: run the whole task suite once
with a forced `coerceLikeSheets: true` and confirm no behavioural difference.

---

### WI-2 — Pause a routine completely

**Files:** `apps-script/19_tasks_scheduler.gs`, new `tests/task-pause.test.js`.

Three layers. All three are required: the guard is what makes the promise true
even for data that already exists, the prune is what makes the UI honest, and
the job check is what stops work already in flight.

#### 2a. Scheduler guard

In `runTaskScheduler_`, build a status map from the tasks you already read, and
consult it before announcing or reminding:

```js
    var tasks = readTaskRows_(doc);
    var statusByTaskId = {};
    for (var t = 0; t < tasks.length; t++) statusByTaskId[tasks[t].id] = tasks[t].status;
```

```js
      // A paused (or cancelled, or orphaned) definition goes quiet immediately,
      // including for occurrences that were materialised before the pause.
      if (!isTaskSendable_(statusByTaskId[occ.taskId])) continue;
```

placed right after the `occ.taskType === "goal"` handling and before the
announce block. Add to `19_tasks_scheduler.gs`:

```js
/**
 * Whether the scheduler may still speak for a task. A paused routine must not
 * announce or remind - not even for the occurrences that were already
 * materialised on to the sheet before it was paused - and an occurrence whose
 * definition has gone is not something to keep pinging a group about.
 */
function isTaskSendable_(taskStatus) {
  return taskStatus === TASK_DEF_ACTIVE;
}
```

> Note: this also silences `cancelled`/`completed` parents. `cancel_task`
> already cancels open occurrences, and a `completed` goal has no open steps, so
> no live behaviour changes — but the guard makes it structural.

#### 2b. Job-time re-check

`runTaskNotifyJob_` and `runTaskReminderJob_` gain, right after the occurrence
lookup:

```js
  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var task = findTask_(doc, occ.taskId);
  if (task && (task.status === TASK_DEF_PAUSED || task.status === TASK_DEF_CANCELLED)) return;
```

Return, do not throw: a paused task is a completed instruction, not a failure to
retry.

#### 2c. Pause action prunes the unseen future

`setRoutinePausedAction_` becomes:

```js
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
```

`pruneReplaceableRoutineOccurrences_` keeps its current predicate for this call
(`dateKey > todayKey`, `Open`, no `notifiedAt`, no `msgId`) — today's card, if
already posted, remains completable. Add `!hasAnyReminderSent_(occ)` to the
predicate (see WI-3d) so a day that already pinged the group is treated as
announced.

Resume needs no special work: `handleTaskAction_` runs the scheduler inline
after a successful mutation, and `materializeTaskOccurrences_` is idempotent on
`(taskId, dateKey)`, so the horizon is rebuilt without duplicating anything that
survived.

#### 2d. Tests — new `tests/task-pause.test.js`

| Test | Setup → assertion |
|---|---|
| `a paused routine sends nothing even when its future days already exist` | materialise a daily routine with reminders, set the `Tasks` row status to `paused` **directly** (simulating rows materialised before the pause), run `runTaskScheduler_(doc, NOW + 86400000)` and `processPendingJobs_`: `__sentMessages` unchanged, zero `task_notify`/`task_reminder` rows added |
| `pausing through the API stops the group going forward` | as §2.2's repro, but via `pause_routine`: zero messages on the next day's pass |
| `pausing removes only the unseen future` | after pause, occurrences with `dateKey > today` and no `notifiedAt` are gone; a completed row, a skipped row and today's announced row all survive with their status intact |
| `a notify job queued before the pause does not send` | enqueue `task_notify`, then pause, then `processPendingJobs_` → nothing sent, job completes cleanly (not `Failed`) |
| `a reminder job queued before the pause does not send` | same shape with `task_reminder` |
| `reminder slots are not burned while paused` | pause, advance past a reminder time, run the scheduler, resume the next day → the *paused* day's slot is untouched and today's reminder still fires normally |
| `resuming regenerates without duplicating` | pause → resume → `runTaskScheduler_`: exactly one occurrence per due date, completed/skipped history intact |
| `paused routines disappear from the upcoming view` | `buildTaskViews_().today.upcoming` contains none of the paused routine's rows |

---

### WI-3 — Editing and reconciliation

**Files:** `apps-script/17_tasks_store.gs`, `apps-script/19_tasks_scheduler.gs`,
`assets/tasks/04-tasks-app.js`, `tasks.html`, new `tests/task-editing.test.js`.

#### 3a. Task type is immutable

Two layers.

In `normalizeTaskInput_`, the type of an existing task is not up for
negotiation:

```js
  // The type decides which columns mean anything and what an occurrence even
  // is. There is no safe migration from one shape to another - a once-task's
  // single occurrence and a routine's dated history are not interchangeable -
  // so an existing task keeps the type it was created with.
  var type = existing ? existing.type : (TASK_TYPES.indexOf(String(payload.type)) !== -1 ? String(payload.type) : "");
  if (TASK_TYPES.indexOf(type) === -1) return { error: "Vazifa turi noto'g'ri." };
```

In `saveTaskAction_`, reject the attempt loudly rather than silently ignoring it:

```js
  if (existing && payload.type && String(payload.type) !== existing.type) {
    return { status: "error", message: "Vazifa turini o'zgartirib bo'lmaydi. Yangi vazifa yarating." };
  }
```

UI (`04-tasks-app.js`): in `prefillTaskForm`, set
`document.getElementById('fType').disabled = true;` and in `resetTaskForm` set
it back to `false`. In `submitTaskForm`, when `fId` has a value, read the type
from the loaded task rather than the (disabled) select — simplest is to keep
sending `type` since it now equals the stored type; assert this in the e2e test.
Add a hint under the select shown only when editing:
`Tur yaratilgandan keyin o'zgartirilmaydi.`

#### 3b. One-time reconciliation

New in `19_tasks_scheduler.gs`:

```js
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
```

Notes: a `WaitingProof` occurrence keeps its status and its awaiting user — an
edit is not a reason to drop someone's pending proof. Reminder slots are keyed
`"<date> <time>"`, so moving the deadline naturally produces fresh slots; slots
for the old date stay recorded and harmless.

#### 3c. Goal reconciliation with stable step ids

Steps gain a stable `id`. `Steps_JSON` becomes `[{id, title, photoRequired?}]`;
`photoRequired` is present **only** when explicitly set (see WI-7).

`17_tasks_store.gs`:

```js
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
```

`buildOccurrenceForGoalStep_` uses both helpers:

```js
function buildOccurrenceForGoalStep_(task, stepIndex) {
  var occ = baseOccurrence_(task);
  var step = task.steps[stepIndex] || {};
  occ.stepIndex = stepIndex;
  occ.title = goalStepTitle_(task, step, stepIndex);
  occ.photoRequired = effectiveStepPhotoRequired_(task, step);
  occ.remindDaily = goalRemindDaily_(task);   // see WI-7
  occ.dueAt = "";
  occ.meta = { stepId: step.id || "" };
  return occ;
}
```

Identity matching, in `19_tasks_scheduler.gs`. This works whether or not the
client sends ids, and gets all four required cases right:

```js
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
```

Reconciliation:

```js
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
```

**Critical companion change** in `materializeTaskOccurrences_` — a removed
step's row must not block a new step from taking its index:

```js
    if (existing[e].stepIndex !== "" && !(existing[e].meta && existing[e].meta.removedStep)) {
      byStep[existing[e].stepIndex] = existing[e];
    }
```

And in `buildTaskViews_`, `stepOccurrences` filters removed rows out:

```js
        .filter(function (o) { return o.stepIndex !== "" && !(o.meta && o.meta.removedStep); })
```

`goalProgress_` must ignore removed and non-counting rows:

```js
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
```

> `occurrenceFromRow_` already parses `Meta_JSON`, and `occurrenceToRow_` already
> serialises `occ.meta`, so `meta.stepId` / `meta.removedStep` need no schema
> change.

#### 3d. Routine reconciliation

Replace `pruneReplaceableRoutineOccurrences_`'s role on edit with:

```js
/** True when any reminder slot has already been acted on for this occurrence. */
function hasAnyReminderSent_(occ) {
  var sent = occ.remindersSent || {};
  for (var key in sent) if (Object.prototype.hasOwnProperty.call(sent, key)) return true;
  return false;
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
```

Keep `pruneReplaceableRoutineOccurrences_` — WI-2c still uses it — but add the
`!hasAnyReminderSent_(occ)` clause to its predicate.

#### 3e. `saveTaskAction_`

```js
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
```

#### 3f. Tests — new `tests/task-editing.test.js`

| Test | Assertion |
|---|---|
| `editing a one-time task moves its live occurrence` | title, `dateKey`, `dueAt`, responsible, priority, `photoRequired`, `reminderTimes` all match the edit |
| `editing a one-time task refreshes the posted card` | a `task_update_message` job exists for the occurrence when `msgId` is set |
| `a completed one-time task is not rewritten by an edit` | complete first, then edit → `completedAt`, `completedByName`, `title` unchanged |
| `renaming a goal step keeps its occurrence and its history` | `[A,B,C]` → `[A,B2,C]` with B completed: the same occurrence id survives, title becomes `… — B2`, `status === Completed`, `completedByName` intact |
| `adding a goal step creates exactly one new occurrence` | `[A,B]` → `[A,B,C]`: 3 rows, one new id |
| `inserting a step in the middle does not steal another step's occurrence` | `[A,B,C]` → `[A,NEW,B,C]`: B's and C's occurrence ids are unchanged, indexes are 2 and 3 |
| `deleting an unfinished goal step cancels it and frees its slot` | `[A,B,C]` → `[A,C]`: B's row is `Cancelled` + `meta.removedStep`, progress is `0/2`, and materialising again does **not** resurrect B |
| `deleting a completed goal step keeps the record but drops it from progress` | completed B removed → row still `Completed` with its proof, `progress.total === 2` |
| `removing the last unfinished step completes the goal` | task status becomes `completed` |
| `the goal progress bar is right after a mixed edit` | rename + add + delete in one save → `done/total/percent` match the surviving current steps |
| `a routine edit re-plans the unseen future` | change `freq` daily → weekly(Mon): future un-announced rows are replaced by Mondays only |
| `a routine edit refreshes today's announced occurrence` | title/responsible/priority/dueAt updated in place, row id unchanged, `notifiedAt` preserved |
| `a routine edit withdraws announced days the new schedule dropped` | shorten `endKey`: an announced future day becomes `Cancelled` with a `task_update_message` job |
| `a routine edit preserves completed and skipped history` | past `Completed`/`Skipped` rows byte-identical afterwards |
| `the task type cannot be changed` | `once` → `routine` returns `status:'error'`, the stored type is still `once`, and no new occurrences exist |

---

### WI-4 — Harden the Telegram photo-proof flow

**Files:** `apps-script/09_telegram_service.gs`, `apps-script/10_retry_queue.gs`,
`apps-script/18_tasks_service.gs`, `apps-script/19_tasks_scheduler.gs`, new
`tests/task-proof.test.js`, updates to `tests/task-telegram.test.js`.

#### 4a. `sendTelegramMessage_` gains reply mechanics

```js
function sendTelegramMessage_(chatId, text, replyMarkup, parseMode, options) {
  var body = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  if (options && options.replyToMessageId) {
    body.reply_to_message_id = Number(options.replyToMessageId) || options.replyToMessageId;
    // The card can have been deleted; a prompt that cannot attach itself is
    // still better than no prompt at all.
    body.allow_sending_without_reply = true;
  }
  return telegramFetch_("sendMessage", body);
}
```

Purely additive — every existing caller keeps working.

#### 4b. The proof prompt becomes a queued job

`19_tasks_scheduler.gs`:

```js
function isTaskJobType_(type) {
  return type === "task_notify" || type === "task_reminder" ||
    type === "task_update_message" || type === "task_proof_prompt";
}
```
```js
  if (job.type === "task_proof_prompt") return runTaskProofPromptJob_(doc, job);
```
```js
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
```

`18_tasks_service.gs`:

```js
function buildTaskProofPromptMessage_(occ, options) {
  var name = escapeTelegramHtml_((options && options.userName) || occ.completedByName || "");
  var id = options && options.userId ? String(options.userId) : "";
  var mention = id ? '<a href="tg://user?id=' + id + '">' + name + '</a>' : name;
  return "📷 " + mention + ", \"" + escapeTelegramHtml_(occ.title) +
    "\" ni tasdiqlash uchun shu xabarga javob (reply) qilib rasm yuboring.";
}
```

Titles are capped at 200 characters, so no truncation is needed; do **not**
`slice()` an HTML string mid-entity.

#### 4c. Claiming, and refusing a takeover

`handleTaskCallback_`, after the completed/cancelled/skipped guards:

```js
  var from = callback.from || {};

  if (occ.status === TASK_STATUS_WAITING) {
    // The proof is somebody's to deliver. A second presser must not be able to
    // take the task from them, or to overwrite who is recorded as doing it.
    if (String(occ.proofAwaitingUserId) === String(from.id)) {
      enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
        occurrenceId: occ.id, userId: String(from.id), userName: taskDisplayName_(from)
      });
      answerCallbackQuery_(callback.id, "📷 Rasm kutilmoqda — so'ralgan xabarga javob qiling.");
    } else {
      answerCallbackQuery_(callback.id,
        (occ.completedByName || "Boshqa foydalanuvchi") + " tasdiqlamoqda.");
    }
    return;
  }

  if (occ.photoRequired) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = String(from.id || "");
    occ.completedByName = taskDisplayName_(from);   // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: String(from.id || ""), userName: taskDisplayName_(from)
    });
    answerCallbackQuery_(callback.id, "📷 Iltimos, so'ralgan xabarga rasm bilan javob bering.");
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    return;
  }
```

`enqueueJob_` already de-duplicates identical pending `(type, relatedId,
payload)` triples, so repeated presses by the claimant cannot stack prompts.

#### 4d. The button disappears while a proof is pending

`runTaskUpdateMessageJob_`:

```js
  // The button is live only while the task is genuinely open. While a proof is
  // pending it belongs to one person, and pressing it again is not how they
  // deliver it.
  var showButton = occ.status === TASK_STATUS_OPEN;
  editTelegramMessage_(chatId, occ.msgId, buildTaskStatusMessage_(occ, Date.now()),
    showButton ? taskDoneMarkup_(occ.id) : taskClearedMarkup_());
```

#### 4e. A photo satisfies only the prompt it answers

Replace `handleTaskGroupMessage_` entirely:

```js
/**
 * A photo in the Tasks group.
 *
 * Proof is only proof of the thing that was asked for: the photo has to be a
 * reply to that occurrence's prompt (or to its card), and it has to come from
 * the person who claimed it. Guessing "probably their most recent pending
 * task" is how an unrelated photo silently completed the wrong job.
 */
function handleTaskGroupMessage_(message, doc) {
  if (!message.photo || !message.photo.length) return;
  var from = message.from || {};
  var replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : "";

  var pendingForUser = 0;
  var target = null;
  var claimedByOther = null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status !== TASK_STATUS_WAITING) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) pendingForUser++;
    if (!replyTo) continue;
    var meta = occ.meta || {};
    var answersThis = String(meta.proofPromptMsgId || "") === replyTo || String(occ.msgId || "") === replyTo;
    if (!answersThis) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) target = occ;
    else claimedByOther = occ;
  }

  if (!target) {
    if (claimedByOther) {
      trySendTaskGroupMessage_(doc, "⚠️ Bu vazifani " +
        (claimedByOther.completedByName || "boshqa foydalanuvchi") + " tasdiqlamoqda.");
    } else if (pendingForUser > 0) {
      trySendTaskGroupMessage_(doc,
        "⚠️ Rasmni qabul qilish uchun so'ralgan xabarga javob (reply) qilib yuboring.");
    }
    return;   // an unrelated photo is just a photo
  }

  var largest = message.photo[message.photo.length - 1] || {};
  completeTaskOccurrence_(doc, target, {
    byId: from.id,
    byName: taskDisplayName_(from),
    source: "telegram",
    proofFileId: largest.file_id || "",
    proofMsgId: message.message_id
  });
  trySendTaskGroupMessage_(doc, "✅ Rasm qabul qilindi — \"" + target.title + "\" bajarildi.");
}

/** Group chatter is never worth failing a webhook over. */
function trySendTaskGroupMessage_(doc, text) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) return;
  try {
    sendTelegramMessage_(chatId, text);
  } catch (error) {
    debugLog_(doc, "task_group_notice_failed", String(error));
  }
}
```

`completeTaskOccurrence_` already records `completedById`, `completedByName`,
`completedAt`, `onTime`/`lateMs`, `proofFileId`, `proofMsgId` and clears
`proofAwaitingUserId`. Additionally clear the prompt pointer there so a stale
`meta.proofPromptMsgId` cannot match a later photo:

```js
  occ.meta = occ.meta || {};
  occ.meta.source = opts.source || "telegram";
  occ.meta.proofPromptMsgId = "";
```

#### 4f. Never stuck in Waiting-for-Proof

Two mechanisms — the first is immediate, the second is the backstop for a queue
row that disappears.

**Permanent-failure hook** in `10_retry_queue.gs`:

```js
function failJob_(sheet, job, error, doc) {
  var attempts = job.attempts + 1;
  var exhausted = attempts >= JOB_MAX_ATTEMPTS;
  …unchanged…
  if (exhausted) {
    writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
    // Some jobs leave state behind that only makes sense while they are still
    // going to be retried.
    if (doc) {
      try { onJobPermanentlyFailed_(doc, job); } catch (hookError) {}
    }
  }
}

/** Last-chance cleanup when a job will never be attempted again. */
function onJobPermanentlyFailed_(doc, job) {
  if (job.type === "task_proof_prompt") releaseStuckProofPrompt_(doc, job);
}
```

`processPendingJobs_` passes the doc: `failJob_(job.sheet, job, error, doc);`
(`failJob_` and `completeJob_` have no callers outside `10_retry_queue.gs`, so
this is safe.)

**Release** in `19_tasks_scheduler.gs`:

```js
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
```

**Scheduler sweep**, inside `runTaskScheduler_`'s occurrence loop (before the
announce block):

```js
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
```

with `var TASK_PROOF_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;` next to
`TASK_REMINDER_MAX_LATE_MS`.

#### 4g. Tests

Update `tests/task-telegram.test.js`:

- `a proof-required task waits for a photo, then completes with the file id` —
  the photo must now be sent **as a reply** to the prompt message. Read the
  prompt's message id from the occurrence's `meta.proofPromptMsgId` (drain the
  queue first) and set `reply_to_message: { message_id: <that id> }`. Keep every
  other assertion.
- `a photo from someone with nothing awaiting proof is ignored` — still passes
  unchanged (no pending proof ⇒ no hint, no completion).

New `tests/task-proof.test.js`:

| Test | Assertion |
|---|---|
| `pressing done on a photo task queues a ForceReply prompt` | a `task_proof_prompt` job exists; after draining, the `sendMessage` body has `reply_markup.force_reply === true`, `reply_markup.selective === true`, `parse_mode === 'HTML'`, `reply_to_message_id === card msgId`, and the text mentions `tg://user?id=<presser>` |
| `a second user cannot take over a pending proof` | `proofAwaitingUserId` and `completedByName` stay the first user's; the second gets a callback answer naming the claimant |
| `the completion button is removed while a proof is pending` | the last `editMessageText` payload has `reply_markup.inline_keyboard` empty |
| `the claimant pressing again re-prompts without duplicating state` | still one `WaitingProof` row, `proofAwaitingUserId` unchanged, no second pending job (dedup) |
| `a photo replying to another task's prompt does not complete this one` | two pending proofs for one user; the reply to A's prompt completes **A only**, B stays `WaitingProof` |
| `an unrelated photo with no reply completes nothing` | both stay `WaitingProof`; exactly one hint message is sent |
| `a photo replying to a prompt claimed by someone else is refused` | occurrence unchanged; a message naming the claimant is sent |
| `two users each holding their own proof both complete correctly` | each occurrence records its own `completedById`, `proofFileId`, `proofMsgId` |
| `the proof records who, which file and when` | `completedById`, `completedByName`, `proofFileId` (largest photo), `proofMsgId`, `completedAt`, `onTime`/`lateMs` |
| `a failing prompt send is retried, not swallowed` | `fetch` stub returns HTTP 500 for `sendMessage`: the job goes back to `Pending` with `attempts === 1`, the occurrence is still `WaitingProof` |
| `a permanently failed prompt releases the task` | drive the job to `JOB_MAX_ATTEMPTS`: status back to `Open`, `proofAwaitingUserId` empty, a `task_update_message` job queued |
| `the scheduler releases a claim whose prompt never went out` | seed `WaitingProof` with `meta.proofRequestedAt` 31 minutes ago and no `proofPromptMsgId` → `Open` after a pass |
| `a photo in the reporting group does not touch tasks` | Tasks group ≠ reporting group: a photo in the reporting group is not claimed by `isTaskTelegramUpdate_` |

Failure injection pattern for the harness:

```js
const gas = loadScript({
  properties: { … },
  fetch: (url, params) => ({
    getResponseCode: () => (url.indexOf('/sendMessage') !== -1 ? 500 : 200),
    getContentText: () => JSON.stringify({ ok: url.indexOf('/sendMessage') === -1, result: { message_id: 555 } })
  })
});
```

---

### WI-5 — Secure task reads

**Files:** `apps-script/19_tasks_scheduler.gs`, `apps-script/20_api.gs`,
`assets/tasks/01-tasks-api.js`, `assets/tasks/03-tasks-render.js`,
`assets/tasks/04-tasks-app.js`, new `tests/task-access.test.js`,
`tests/task-api.test.js`, `tests/tasks-ui.e2e.js`.

Decision: **reuse `OMAD_ADMIN_KEY` via the existing `checkAdminKey_`.** No new
secret is minted, the key never travels in a URL (POST only), and it is
rate-limited before it is compared — the same shape `telegramAdminAction_`
already uses. The /tasks page already holds the key in `sessionStorage` for
mutations, so the only UX change is that it is now needed on first load.

#### 5a. Backend

`handleTaskAction_`:

```js
// The panel does one read per load and one per mutation, so this is generous
// for the admin and mean to anyone guessing keys.
var TASK_READ_RATE_LIMIT = 30;
```
```js
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
  …unchanged…
}
```

`20_api.gs` `doGet` — replace the `get_tasks` branch and place it **above** the
`if (!configSheet) return jsonOutput_({ status: "empty" });` line so the message
is the same whether or not the sheet exists:

```js
  if (action === 'get_tasks') {
    // A GET puts its parameters in the URL, which is exactly where an admin key
    // must never be. Task reads are POST-only.
    return jsonOutput_({
      status: "error",
      message: "Vazifalar ma'lumoti faqat POST va admin kaliti bilan olinadi."
    });
  }
```

#### 5b. Frontend

`01-tasks-api.js`:

```js
async function loadTasks() {
    const key = tasksAdminKey();
    if (!key) {
        // The board is admin-only now; there is nothing to show without a key.
        TASKS_STATE.view = null;
        TASKS_STATE.needsKey = true;
        renderAllTasks();
        openAdminKey();
        return;
    }
    taskLoader(true);
    try {
        const data = await tasksApiCall({ action: 'get_tasks', adminKey: key });
        if (data && data.status === 'success') {
            TASKS_STATE.view = data.view;
            TASKS_STATE.config = data.config;
            TASKS_STATE.needsKey = false;
        } else {
            const message = (data && data.message) || "Ma'lumotni yuklab bo'lmadi";
            if (/admin kalit/i.test(message)) {
                setTasksAdminKey('');
                TASKS_STATE.needsKey = true;
                openAdminKey();
            }
            taskToast(message, true);
        }
    } catch (e) {
        taskToast("Ma'lumotni yuklab bo'lmadi", true);
    } finally {
        taskLoader(false);
    }
    renderAllTasks();
}
```

`04-tasks-app.js` — `saveAdminKey()` reloads instead of just re-rendering:

```js
function saveAdminKey() {
    setTasksAdminKey(document.getElementById('adminKeyInput').value.trim());
    closeAdminKey();
    taskToast('Admin kaliti saqlandi');
    loadTasks();
}
```

`03-tasks-render.js` — `renderAllTasks()` renders a key prompt instead of a
misleading empty board:

```js
    if (TASKS_STATE.needsKey && !TASKS_STATE.view) {
        const prompt = emptyNote('Vazifalarni ko\'rish uchun admin kalitini kiriting. 🔑');
        TASK_TABS.forEach(t => { const p = document.getElementById('panel-' + t); if (p) p.innerHTML = prompt; });
        return;
    }
```

placed after the header/`adminKeyBtn` updates and before the per-panel renders.
(`TASK_TABS` lives in `04-tasks-app.js`, loaded after this file but before the
function ever runs — it is referenced at call time, so this is fine. If you
prefer not to rely on load order, inline the five ids.)

#### 5c. Tests

Rewrite in `tests/task-api.test.js`: `get_tasks returns a view without requiring
an admin key` → `get_tasks refuses an anonymous read` (this inversion is
intentional; do not "fix" the code to make the old test pass).

New `tests/task-access.test.js`:

| Test | Assertion |
|---|---|
| `an anonymous POST get_tasks is refused` | `status === 'error'`, and the serialised body contains **no** task title (assert on the raw JSON string) |
| `a wrong admin key is refused` | `status === 'error'` |
| `the correct admin key returns the view` | `status === 'success'`, the task is present |
| `get_tasks over GET never returns data` | `doGet({parameter:{action:'get_tasks'}})` → `status === 'error'`, raw body contains no title |
| `get_tasks with no OMAD_ADMIN_KEY configured is refused` | error mentioning the missing Script Property; no data |
| `repeated anonymous reads are rate limited` | after `TASK_READ_RATE_LIMIT` attempts in one window the message is the throttle message |
| `every task mutation is still admin gated` | loop over `save_task`, `cancel_task`, `pause_routine`, `resume_routine`, `skip_occurrence`, `complete_occurrence`, `reopen_occurrence` without a key → all `error`, and the sheets are unchanged |
| `a task read does not leak into other actions` | `get_omad` / `get_cafe` still work without a key (no accidental tightening of accounting reads) |

`tests/tasks-ui.e2e.js`: add `the page asks for the admin key before showing
anything` — open a context **without** seeding `sessionStorage`, assert the
admin modal is visible, the panels show the prompt text, and no `get_tasks`
request was recorded. Also assert the normal path now posts
`{action:'get_tasks', adminKey: ADMIN_KEY}`.

---

### WI-6 — One canonical, numeric Tasks group id

**Files:** `apps-script/02_validation.gs`, `apps-script/03_settings.gs`,
`omad_admin.html`, `tests/task-api.test.js`, docs.

`@username` is only tightened for the **Tasks** group. `validateTelegramChatId_`
keeps accepting it for the reporting group, which is a send-only destination and
is already configured live.

`02_validation.gs`:

```js
/**
 * The Tasks group id must be the numeric chat id.
 *
 * Unlike the reporting group - which is only ever a send target - the Tasks
 * group is also compared against `chat.id` on every incoming callback and
 * photo, and Telegram only ever sends the number. An @username would send
 * fine and then silently match nothing.
 */
function validateTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "Vazifalar guruhi ID kiritilmagan.";
  if (!/^-?\d{1,20}$/.test(value)) {
    return "Vazifalar guruhi ID raqam bo'lishi kerak (masalan -1001234567890). @username qo'llab-quvvatlanmaydi.";
  }
  return "";
}

/** Like validateTasksGroupChatId_ but empty is allowed (clears it). */
function validateOptionalTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  return value ? validateTasksGroupChatId_(value) : "";
}
```

`03_settings.gs`:

```js
/**
 * The group task cards, reminders and completions are posted to, in the one
 * form everything can agree on: the numeric chat id. A legacy or hand-edited
 * non-numeric value reads as "not configured" rather than half-working - the
 * settings page still shows what is stored so it can be corrected.
 */
function getTasksGroupChatId_() {
  var value = String(getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID) || "").trim();
  return /^-?\d{1,20}$/.test(value) ? value : "";
}
```

`saveTelegramSettings_` uses `validateOptionalTasksGroupChatId_` in place of
`validateOptionalTelegramChatId_` for `tasksGroupChatId` only.
`buildTelegramSettingsView_` keeps returning the **raw** stored value (so a bad
one is visible and fixable) and gains
`tasksGroupChatIdUsable: !!getTasksGroupChatId_()`.

`validateOptionalTelegramChatId_` stays — it is still used for the reporting
group. Confirm with a grep that no other caller depended on the old behaviour
for the tasks field.

`omad_admin.html`: change the hint under `tgTasksGroupChatId` to
`Faqat raqamli ID (masalan -1001234567890). @username ishlamaydi.` and keep the
panel link.

Everything downstream already funnels through `getTasksGroupChatId_()`
(`isTaskTelegramUpdate_`, `handleTaskCallback_`, all four job runners,
`maybeCompleteGoal_`, `trySendTaskGroupMessage_`). Verify with
`grep -rn "TELEGRAM_PROP_TASKS_GROUP_CHAT_ID\|getTasksGroupChatId_" apps-script`
that nothing reads the property directly except the accessor and the settings
view.

Tests (in `tests/task-api.test.js`):

| Test | Assertion |
|---|---|
| `a numeric Tasks group id saves` | unchanged from today |
| `an @username Tasks group id is rejected` | `status === 'error'`, property untouched, message mentions `@username` |
| `the reporting group still accepts an @username` | `save_telegram_settings` with `groupChatId: '@omadgroup'` succeeds |
| `a legacy @username already in Script Properties reads as unconfigured` | seed `TELEGRAM_TASKS_GROUP_CHAT_ID: '@old'` → `getTasksGroupChatId_() === ''`, `config.tasksGroupConfigured === false`, and `isTaskTelegramUpdate_` claims nothing |
| `saving, sending and callbacks agree on one id` | save `-1009998887777`, create a task, drain: `sendMessage.chat_id === '-1009998887777'`; a callback from that numeric chat is accepted; one from another chat is refused |

---

### WI-7 — Complete the Goal behaviour

**Files:** `apps-script/17_tasks_store.gs`, `apps-script/19_tasks_scheduler.gs`,
`tasks.html`, `assets/tasks/04-tasks-app.js`, new `tests/task-goals.test.js`,
docs.

**The rule, decided and to be documented in `TASKS.md`:**

> A goal's steps are ordinary deadline-less task-occurrences. Each is announced
> to the Tasks group once, with a completion button and the goal's photo-proof
> rule (a step may override it). Reminder times set on a goal repeat **daily**
> while a step is still open, because a step has no deadline of its own to hang
> a single reminder on — that is what makes the setting mean something instead
> of nothing. Goal steps stay in the **Maqsadlar** tab and do not appear in
> Bugun, which is reserved for dated work.

`17_tasks_store.gs`:

```js
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
```

`buildOccurrenceForGoalStep_` sets `occ.remindDaily = goalRemindDaily_(task)`
(already in WI-3c).

`19_tasks_scheduler.gs` — in `runTaskScheduler_` delete
`if (occ.taskType === "goal") continue;` and widen the announce condition:

```js
      // A goal step and a deadline-less one-time task are the same thing to
      // the group: something to do now, with no date attached.
      var due = occ.taskType === "once" || occ.taskType === "goal" ||
        (occ.dateKey && occ.dateKey <= todayKey);
```

Reminders then work unchanged: `taskReminderDatesFor_` returns `[todayKey]` for
a dateless occurrence whose `remindDaily` is true.

`buildTaskViews_` keeps `if (occ.taskType === "goal") continue;` for the Today
sections — that is the documented rule, not an oversight. Add a comment saying
so.

Progress and completion after edits/reopens are covered by WI-3c
(`goalProgress_` exclusions, `maybeCompleteGoal_` after save).
`reopenOccurrenceAction_` already flips a `completed` goal back to `active`;
confirm it also leaves `meta.removedStep` alone.

UI (`tasks.html` + `04-tasks-app.js`): the reminder block currently hides
`grpRemindDaily` unless the type is `once`. For a goal, show a static note
instead of the checkbox:

```html
<p id="goalRemindNote" class="hidden text-[10px] text-slate-400 mt-1">
  Maqsad qadamlari uchun eslatmalar qadam bajarilgunicha har kuni takrorlanadi.
</p>
```

toggled in `onTypeChange()` with
`document.getElementById('goalRemindNote').classList.toggle('hidden', type !== 'goal');`

Tests — new `tests/task-goals.test.js`:

| Test | Assertion |
|---|---|
| `a goal-level photo requirement reaches every step` | `photoRequired: true`, steps as plain strings → all step occurrences `photoRequired === true` |
| `a step may opt out of the goal's photo requirement` | `steps: [{title:'A', photoRequired:false},{title:'B'}]` → `[false, true]` |
| `a step may opt in when the goal does not require one` | goal `photoRequired:false`, step `true` → that step only |
| `goal steps are announced to the group exactly once` | one `task_notify` per step; a second pass adds none; the card carries a `t_done` button |
| `goal reminders repeat daily while a step is open` | reminder `08:00`: one reminder today, none twice today, one more the next day |
| `completing a step stops its reminders` | complete step A → the next day produces reminders only for B |
| `a paused parent is not possible for goals but a cancelled one is silent` | `cancel_task` on a goal → no further notifies |
| `progress ignores cancelled and removed steps` | see WI-3f overlaps; assert `done/total` |
| `reopening a step reopens the goal` | goal `completed` → reopen one step → goal `active`, `progress.percent < 100` |
| `a goal step photo proof completes through the group` | full press → prompt → reply-with-photo path on a step occurrence |

---

### WI-8 — Smaller correctness issues

**Files:** `apps-script/17_tasks_store.gs`, `apps-script/19_tasks_scheduler.gs`,
`assets/tasks/01-tasks-api.js`, `assets/tasks/03-tasks-render.js`, new
`tests/task-scheduler.test.js`, `tests/task-occurrences.test.js`.

#### 8a. Today does not break a streak before it is late

`routineStats_`:

```js
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
```

A routine with no `dueTime` has no `dueAt`, so today is neutral until it is
completed — which is the correct reading of "no time was set".

#### 8b. Future occurrences are not completable by accident

`19_tasks_scheduler.gs`:

```js
/** An occurrence dated after today - work that has not come round yet. */
function isFutureOccurrence_(occ, todayKey) {
  return !!occ.dateKey && occ.dateKey > todayKey;
}
```

`completeOccurrenceAction_`, after the cancelled check:

```js
  if (isFutureOccurrence_(occ, taskTodayKey_(Date.now()))) {
    return { status: "error",
      message: "Kelgusi kun uchun vazifani oldindan bajarilgan deb belgilab bo'lmaydi." };
  }
```

`skipOccurrenceAction_`, after the completed check — skipping ahead is
legitimate ("nobody is in on Friday"), it just has to be deliberate:

```js
  var todayKey = taskTodayKey_(Date.now());
  if (isFutureOccurrence_(occ, todayKey) && payload.confirmFuture !== true) {
    return { status: "error", needsFutureConfirm: true, dateKey: occ.dateKey,
      message: "Kelgusi kunni (" + formatTaskDateKey_(occ.dateKey) + ") o'tkazib yuborishni tasdiqlang." };
  }
```

Frontend:

- `01-tasks-api.js`:
  `function tasksSkip(occId, futureDateLabel) { … }` — when `futureDateLabel` is
  given, `confirm('… ' + futureDateLabel + ' …')` first and send
  `confirmFuture: true`.
- `03-tasks-render.js`: `occCard(occ, mode)` gains a `'upcoming'` mode used by
  the Today panel's `Kelgusi` section. It shows the date prominently, **no**
  ✅ button, and a skip button that passes `occ.dueLabel || occ.dateKey`:

```js
    } else if (mode === 'upcoming') {
        // Future work is shown, not actioned: completing something that has not
        // come round yet is almost always a misclick.
        actions =
            '<div class="flex gap-2 mt-2 items-center">' +
            '<span class="text-[10px] font-bold text-slate-400">' + escapeTaskHtml(occ.dueLabel || occ.dateKey || '') + '</span>' +
            '<button onclick="tasksSkip(\'' + occ.id + '\', \'' + escapeTaskHtml(occ.dueLabel || occ.dateKey || '') + '\')" ' +
            'class="ml-auto py-1.5 px-3 bg-slate-100 text-slate-600 rounded-lg text-[11px] font-bold active:scale-95">⏭ O\'tkazish</button>' +
            '</div>';
    }
```

and `renderTodayPanel` uses
`section('🗓 Kelgusi', t.upcoming, 'upcoming', 'text-slate-400')`.

#### 8c. One read per scheduler pass, one batched write

`materializeTaskOccurrences_` gains an optional context. Called **without** one
it behaves exactly as today, so every existing caller and test is unaffected.

```js
/**
 * …existing doc comment…
 *
 * `ctx` is an optional per-pass working set: the occurrence rows already read
 * from the sheet, plus the rows this pass wants to add. Passing one turns a
 * scan-per-task into a single scan and a single append for the whole pass.
 */
function materializeTaskOccurrences_(doc, task, nowMs, ctx) {
  if (task.status === TASK_DEF_CANCELLED) return [];
  var todayKey = taskTodayKey_(nowMs);
  var existing = occurrencesForTask_(ctx ? ctx.occurrences : readOccurrenceRows_(doc), task.id);
  …unchanged body…
  if (ctx) {
    for (var c = 0; c < created.length; c++) { ctx.pending.push(created[c]); ctx.occurrences.push(created[c]); }
  } else {
    for (var a = 0; a < created.length; a++) appendOccurrenceRow_(doc, created[a]);
  }
  return created;
}
```

`runTaskScheduler_`:

```js
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

    var occurrences = ctx.occurrences;   // includes what was just appended, with row numbers
```

Everything after that is unchanged except the guards added by WI-2a and WI-4f.
Per-occurrence `writeOccurrenceRow_` calls stay as they are — they are sparse
and correctness depends on them landing immediately.

**Invariant to preserve:** `appendOccurrenceRows_` assigns `rowNumber` to each
object it writes, and those same objects are the ones in `ctx.occurrences`, so a
`writeOccurrenceRow_` later in the same pass updates the right row. Assert this
in a test.

#### 8d. Tests

`tests/task-occurrences.test.js` — add:

| Test | Assertion |
|---|---|
| `an open day that is not yet late does not break the streak` | 3 completed days + today Open due 20:00 at 09:00 → `streak === 3`, `counted === 3` |
| `an overdue today does break the streak` | same with `dueTime: '08:00'` → `streak === 0` |
| `a routine with no due time leaves today neutral` | `dueTime` absent → `streak === 3` |

New `tests/task-scheduler.test.js`:

| Test | Assertion |
|---|---|
| `one scheduler pass reads the occurrence sheet once` | instrument `getDataRange` on `Task_Occurrences`; with 5 routines a steady-state pass does **≤ 2** full reads (baseline is 6, growing with task count) |
| `new occurrences are appended in one write` | instrument `getRange(...).setValues`; a cold pass performs a single multi-row append |
| `a row appended in this pass can still be updated in the same pass` | after a cold pass, the notify flags (`notifiedAt`) are persisted on the correct rows — re-read from the sheet and compare ids |
| `completing a future occurrence is refused` | `complete_occurrence` on tomorrow → `error`, still `Open` |
| `skipping a future occurrence needs confirmation` | without `confirmFuture` → `error` + `needsFutureConfirm`; with it → `success` and `Skipped` |
| `today's occurrence can still be completed and skipped` | unchanged behaviour |

`tests/tasks-ui.e2e.js` — add `the upcoming section offers no completion
button`: mock view with an item in `today.upcoming`, assert the rendered section
contains the skip control and no `tasksCompleteOcc(` for that id.

---

## 4. Documentation updates (required)

**`docs/TASKS.md`**
- Web API table: `get_tasks` **Admin key: yes**, POST only; note the GET route
  returns an error by design.
- New "Pause" paragraph: what stops (new occurrences, notifications, reminders,
  in-flight jobs) and what survives (completed/skipped/announced history).
- New "Editing" section: type is immutable; per-type reconciliation rules;
  goal step identity and what happens to a removed step.
- Rewrite the "Completion flow" photo paragraph for the claim → ForceReply
  prompt → reply-only matching → release-on-failure model. Document
  `task_proof_prompt` in the job-type list.
- New "Goals" section stating the reminder rule verbatim from WI-7.
- Storage section: note that date/time/timestamp columns are text-formatted
  before write and that reads recover an already-coerced cell.
- `TELEGRAM_TASKS_GROUP_CHAT_ID` must be **numeric**.
- Testing section: list the new test files.

**`docs/LIVE_STATE.md`** — in "Tasks (not yet deployed…)":
- step 2 now says the Vazifalar Guruhi ID must be the numeric chat id;
- add: the /tasks page requires `OMAD_ADMIN_KEY` to read, not only to write;
- add a Dates note that the task sheets now protect their own columns, the same
  way the accounting sheets do.

**`docs/TELEGRAM_SETUP.md`** — short subsection: how to obtain a numeric group
chat id (add the bot, post a message, read `chat.id` from `getUpdates`, or use a
userinfo bot), and that `@username` is not accepted for the Tasks group.

**`docs/ARCHITECTURE.md`** — add `task_proof_prompt` wherever job types are
listed; no module boundaries change.

**This file** — when the work is done, either delete it in the final commit or
add a short "Implemented in <commit range>" header. Do not leave a stale plan
claiming work is outstanding.

---

## 5. Test inventory

New:

```
tests/task-date-keys.test.js    WI-1
tests/task-pause.test.js        WI-2
tests/task-editing.test.js      WI-3
tests/task-proof.test.js        WI-4
tests/task-access.test.js       WI-5
tests/task-goals.test.js        WI-7
tests/task-scheduler.test.js    WI-8
```

Modified:

```
tests/gas-harness.js            WI-1  (coerce YYYY-MM-DD and HH:mm)
tests/task-api.test.js          WI-5  (read auth inverted), WI-6 (numeric group id)
tests/task-telegram.test.js     WI-4  (proof photo must be a reply)
tests/task-occurrences.test.js  WI-8  (streak neutrality)
tests/tasks-ui.e2e.js           WI-5, WI-3, WI-8
```

Conventions to follow (copy the existing task tests):

- fixed clock `const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0);` with
  `const TODAY = '2026-08-10';` — never `Date.now()` for anything asserted;
- build tasks through `normalizeTaskInput_` + `appendTaskRow_`, or through
  `doPost` when the API path is what is under test;
- the fixture token is `'123456789:AAFakeTokenForTestsOnly_0123456789abcd'` —
  it is allowlisted by exact value in `tests/static-analysis.test.js`; do not
  invent another token-shaped string anywhere;
- inspect queued jobs by reading the `Omad_Job_Queue` sheet, as
  `tests/task-reminders.test.js` does;
- every new test file needs a header comment saying what invariant it defends.

---

## 6. Validation

Run all of these, in order, and paste the real output into the final report.
Do not report a pass you have not seen.

```bash
npm run build                 # then confirm `git status` shows script.gs updated
npm run build:check
npm run lint
npm run scan:secrets
npm run scan:secrets:history
npm test                      # expect 371 + new tests, 0 failures
npm install --no-save playwright@1.56.1
npm run test:e2e              # must actually run, not skip
```

Targeted regression sweep — these must still pass untouched, and you should be
able to say why each is unaffected:

| Area | Guard |
|---|---|
| Omad accounting | `calculations.test.js`, `periods.test.js`, `planned-expenses.test.js`, `tenant-schedules.test.js`, `sheet-date-locale.test.js`, `omad-*.e2e.js`, `calc-parity.e2e.js` |
| Café | `cafe-regression.e2e.js` |
| `/yangi` privacy | `telegram-authorization.test.js`, `telegram-proxy-security.test.js`, `task-isolation.test.js` |
| Reporting / retry queue | `job-queue.test.js`, `telegram-duplicate-prevention.test.js`, `telegram-delete-idempotency.test.js`, `telegram-log-redaction.test.js` |
| Migration / ledger (must stay inert) | `migration.test.js`, `migration-frozen-verification.test.js`, `ledger.test.js` |

Two changes deliberately alter existing expectations. Both must be updated in
the tests, never worked around in the code:

1. `tests/task-api.test.js` — `get_tasks` is no longer anonymous.
2. `tests/task-telegram.test.js` — a proof photo must reply to the prompt.

---

## 7. Risks and open notes

| Risk | Mitigation |
|---|---|
| A goal created by the **current** code stores `photoRequired: false` explicitly on every step, which is indistinguishable from "unset". Those steps will not inherit a goal-level requirement until the goal is saved again. | Tasks are not deployed yet (`LIVE_STATE.md`), so no such data exists in production. Note it in `TASKS.md`; do not add a guessing migration. |
| Goal steps are now announced to the group. A goal with many steps posts many cards at once. | Intended and documented. The queue drains one job per inline call and up to 25 per trigger run, so it is paced. |
| The `tasks_read` rate limit is global (Apps Script cannot see client IPs), so a flood could briefly throttle the admin too. | 30/minute is far above real usage and the window is 60s. Matches the existing `tg_admin` pattern. |
| Cancelling an announced future routine day on edit is visible in the group. | That is the point — silently leaving a withdrawn day live is worse. The card is edited to "🚫 Bekor qilindi". |
| Extending the harness's coercion could surprise an unrelated test later. | Only opt-in (`coerceLikeSheets: true`) tests see it; today that is one file. |
| `failJob_` gains a parameter. | It has no callers outside `10_retry_queue.gs` (verified by grep); the parameter is optional. |

**Manual operator steps after this work ships** (documentation only — do not
perform them):

1. Deploy the regenerated `script.gs` to the `…DtCA2W` deployment via
   *Manage deployments → New version*. Never *New deployment*.
2. Set **Vazifalar Guruhi ID** to the group's **numeric** chat id.
3. Add the time-driven trigger for `processTaskSchedules` (every 5 minutes),
   separate from `processPendingTelegramJobs`.
4. `OMAD_ADMIN_KEY` must be set in Script Properties — the /tasks page now needs
   it to read, not just to write.

---

## 8. Definition of done

- [ ] Every work item WI-1…WI-8 implemented as specified, or a deviation
      explicitly justified in the final report.
- [ ] Each of the eight defects in §2 no longer reproduces (re-run the evidence).
- [ ] All new and modified tests present and passing.
- [ ] `npm run build` run; `script.gs` committed and `build:check` green.
- [ ] Lint, both secret scans, full unit suite and the browser suite all green,
      with real output quoted.
- [ ] Docs in §4 updated.
- [ ] Work committed to `claude/task-manager-fixes-swd8p2` and pushed; a PR
      opened if one is not already open.
- [ ] Nothing deployed; no Script Properties touched; V2 ledger still
      `not_started`.
- [ ] Final report covering: each issue and its fix, architecture decisions,
      new regression tests, full CI results, remaining risks and the manual
      deployment steps above.
