# Task Management

An isolated task-management module bolted onto the existing MyBizManager
backend. It reuses the Telegram bot, the `Omad_Job_Queue` retry infrastructure
and the Telegram settings, but keeps its data, its Telegram namespace and its
frontend entirely separate from the Omad accounting, Café and `/yangi` flows.

Live URL: **<https://omad-d.netlify.app/tasks>** (served from `tasks.html` via
the `netlify.toml` rewrite).

## What it does

| Capability | Where |
|---|---|
| One-time tasks, optional deadline (date **and** time), deadline-less supported | `once` task type |
| Routines: daily, selected weekdays, weekly (interval), monthly (day-of-month or "last"), custom N-day | `routine` task type + `16_tasks_recurrence.gs` |
| Goals with step-tasks and automatic progress | `goal` task type |
| Responsible person, priority, description, photo-proof-required flag | task/occurrence fields |
| Admin-controlled reminder schedule, multiple reminder times per day | `Reminder_Times_JSON` + scheduler |
| Statuses: Open, Waiting for Proof, Completed, Overdue, Cancelled (+ Skipped) | `Status` column; **Overdue is derived**, never stored |
| Routines create separate occurrences/history, never "permanently complete" | `Task_Occurrences`, one row per due date |
| Pause routines, skip individual occurrences, edit/cancel, edit future schedule | web API actions |
| Streak, completion rate, "completed Nh Mm late", on-time vs late | view model |

All scheduling and display use **Asia/Tashkent** (a fixed UTC+5 — Uzbekistan has
no DST). The offset is applied by `16_tasks_recurrence.gs` using epoch-ms math,
so it is independent of the host timezone and fully deterministic under test.

## Backend modules

| Module | Contents |
|---|---|
| `16_tasks_recurrence.gs` | Pure Tashkent time helpers and the recurrence engine (`routineOccursOnKey_`, `routineOccurrenceKeysInRange_`, duration formatting). No spreadsheet state. |
| `17_tasks_store.gs` | The `Tasks` and `Task_Occurrences` sheets: schema, CRUD, occurrence materialisation, the Today/Tasks/Routines/Goals/Completed view model, streaks and goal progress. |
| `18_tasks_service.gs` | The Telegram **task namespace**: the `t_done:` callback, photo-proof completion, message builders and `completeTaskOccurrence_`. |
| `19_tasks_scheduler.gs` | The scheduler (`runTaskScheduler_` / `processTaskSchedules`), the queue job runners (`task_notify`, `task_reminder`, `task_update_message`, `task_proof_prompt`), the per-type edit reconcilers and the web API handlers. |
| `20_api.gs` | Routes task Telegram updates and task web actions (small additions only). |
| `03_settings.gs` | Adds `TELEGRAM_TASKS_GROUP_CHAT_ID` alongside the existing Telegram config. |

## Storage

Dedicated sheets — task data is **never** mixed into the financial ledger.

### `Tasks` — one row per definition

`ID, Type, Title, Description, Responsible, Priority, Photo_Required,
Recurrence_JSON, Reminder_Times_JSON, Remind_Daily, Due_Time, Deadline_Key,
Deadline_Time, Start_Key, End_Key, Status, Steps_JSON, Created_At, Updated_At,
Created_By, Meta_JSON`

- `Type` ∈ `once | routine | goal`; `Status` ∈ `active | paused | completed | cancelled`.

### `Task_Occurrences` — one completable instance, with its own history

`ID, Task_ID, Task_Type, Title, Date_Key, Step_Index, Due_At, Responsible,
Priority, Photo_Required, Reminder_Times_JSON, Remind_Daily, Status,
Reminders_Sent_JSON, Notified_At, Telegram_Msg_ID, Completed_By_Id,
Completed_By_Name, Completed_At, On_Time, Late_Ms, Proof_File_Id, Proof_Msg_Id,
Proof_Awaiting_User_Id, Created_At, Updated_At, Meta_JSON`

- `Status` ∈ `Open | WaitingProof | Completed | Cancelled | Skipped`. **Overdue**
  is computed on read (`Open`/`WaitingProof` past `Due_At`); it is never stored,
  so lateness is always judged against the same deadline.
- `Due_At` is an epoch-ms instant (or empty for deadline-less items).
- `Reminders_Sent_JSON` maps a `"YYYY-MM-DD HH:mm"` slot to the time it was
  enqueued — the deduplication key that stops a reminder firing twice.
- `Steps_JSON` is `[{id, title, photoRequired?}]`. The `id` is stable across
  edits, which is what lets an occurrence keep belonging to the same step when
  the list is renamed or reordered. `photoRequired` is present **only** when a
  step explicitly overrides the goal; absent means "inherit".

### Dates and times survive the spreadsheet

Every date key, clock time and ISO timestamp column is formatted as text
(`"@"`) **before** its value is written — `Due_Time`, `Deadline_Key`,
`Deadline_Time`, `Start_Key`, `End_Key`, `Date_Key`, `Notified_At`,
`Completed_At`, `Created_At`, `Updated_At`. Without it Google Sheets rewrites a
bare `2026-08-10` into a date and a bare `20:00` into an 1899-12-30 time, and
they all read back as `""`. This is the same protection
`applyTransactionColumnFormats_` gives the accounting sheets.

Reads are tolerant of a cell that was already coerced by an older write
(`taskDateKeyFromCell_` / `taskTimeKeyFromCell_`), so existing rows keep working
and heal themselves the next time they are written.

`TELEGRAM_TASKS_GROUP_CHAT_ID` lives in Script Properties (set from
**Omad → Sozlamalar → Telegram → Vazifalar Guruhi ID**). It must be the
**numeric** chat id — an `@username` is refused on save, and a legacy one
already in Script Properties reads as "not configured" rather than
half-working, because incoming callbacks and photos only ever carry `chat.id`.
Empty disables the task Telegram integration cleanly.

## Telegram — isolation from `/yangi`

A task update is claimed **before** the accounting handler:

```
doPost → Telegram webhook (verified by ?wh= secret) →
  isTaskTelegramUpdate_(payload) ? handleTaskTelegramUpdate_ : handleOmadTelegramUpdate_
```

`isTaskTelegramUpdate_` is deliberately narrow — it claims only:

- callbacks whose data starts with `t_` (the task namespace; distinct from the
  accounting `bot_type:`/`bot_ten:`/`bot_curr:` callbacks), and
- photo / reply messages inside the configured Tasks group.

Everything else falls through to the unchanged `/yangi` flow, which only ever
runs in a private chat with the single authorized user. Even when the Tasks
group and the reporting group are the **same** chat, a task completion writes no
financial record and `/yangi` is unaffected (`tests/task-isolation.test.js`).

### Card format

Task cards are sent — and edited — with `parse_mode: "HTML"`. A card shows the
title, responsible person, deadline and photo rule, followed by the task's
**description**:

- shorter than `TASK_CARD_DESC_INLINE_MAX` (150 characters) → a plain `📝` line;
- longer → `<blockquote expandable>`, so Telegram collapses it. The group sees a
  scannable card and the full brief is one tap away.

The completed / cancelled / skipped card carries **no** description: a finished
card is about the outcome, not the brief. Reminders do carry it. A goal step
shows its parent goal's description.

Because the cards are HTML, **every interpolated value is escaped**
(`escapeTelegramHtml_`). A task titled `Ali & Vali <test>` would otherwise make
Telegram reject the send with a 400 and lose the card entirely. Two rules follow
from that and are enforced in `18_tasks_service.gs`:

- the description budget is applied to the **raw** text *before* escaping —
  escaping multiplies length (`&` → `&amp;`), and clipping escaped HTML can cut
  an entity or a tag in half, which Telegram also rejects;
- the assembled message is length-checked against `TELEGRAM_MAX_TEXT_LENGTH`,
  retrying with smaller description budgets, and the description is dropped
  outright rather than truncated unsafely. There is deliberately no `slice()` on
  a finished card string.

`tests/task-card-format.test.js` pins all of this, including that an edit uses
the same parse mode the card was sent with — an edit that dropped it would
display the markup as literal text.

### Completion flow

`✅ Ish bajarildi` (callback `t_done:<occurrenceId>`), gated to the configured
Tasks group:

- **No photo required** → completed immediately.
- **Photo required** → the press is a **claim**:
  1. the occurrence goes to *Waiting for Proof*, recording who claimed it, and
     the completion button is removed from the card — the task now belongs to
     one person, and pressing again is not how they deliver the photo;
  2. a `task_proof_prompt` job sends a **ForceReply** prompt (`selective`, with
     a `tg://user?id=` mention) as a reply to the card, and stores its message
     id in `Meta_JSON.proofPromptMsgId`;
  3. only a photo that **replies to that prompt** (or to the card) **and** comes
     from the claimant completes it. Anything else gets a hint and completes
     nothing — there is no "probably their most recent pending task" fallback,
     which is how an unrelated photo used to complete the wrong job;
  4. a second person pressing the button is told who holds it, and cannot take
     it over or overwrite who is recorded as doing it.

The prompt is a queued job rather than an inline send, so a Telegram outage
retries it with the queue's backoff. If it can **never** be delivered the claim
is released back to `Open` — immediately by the queue's permanent-failure hook
(`onJobPermanentlyFailed_` → `releaseStuckProofPrompt_`), or by a scheduler
sweep 30 minutes on if the queue row itself is gone. An occurrence never sits
waiting for a photo nobody was asked for.

Every completion records **who** (Telegram id + name), **when**, whether it was
**on time or late** (and the late duration), and — for goals — recomputes the
parent goal's progress. Remaining reminders stop automatically: the scheduler
and the reminder job both act only on still-`Open` occurrences. The group card
is **edited in place** to show the result rather than a duplicate being posted.

## Pause

Pausing a routine stops **everything**, including work already materialised:

- no new occurrences are generated;
- the scheduler will not announce or remind for the days already on the sheet —
  it checks the parent task's status, not just the occurrence's;
- a `task_notify` or `task_reminder` job enqueued moments before the pause
  returns without sending (and completes cleanly — a pause is an instruction
  carried out, not a failure to retry);
- pre-generated future days nobody has seen are removed from the sheet, so the
  routine stops appearing under **Kelgusi**.

What survives untouched: completed days, skipped days, and any day that was
already announced or has already sent a reminder. Those are history.

Resume needs no special handling — materialisation is idempotent on
`(taskId, dateKey)`, so the horizon rebuilds around whatever survived.

## Editing

**The type is immutable.** It decides which columns mean anything and what an
occurrence even is; a once-task's single occurrence and a routine's dated
history are not interchangeable. `save_task` refuses a type change with
*"Vazifa turini o'zgartirib bo'lmaydi. Yangi vazifa yarating."*, and the form
disables the select when editing.

Otherwise an edit is reconciled on to the occurrences, per type:

| Type | On edit |
|---|---|
| `once` | The live occurrence is moved: title, deadline, owner, priority, photo rule, reminders. A `Completed` / `Cancelled` / `Skipped` one is history and is left exactly as it was. A `WaitingProof` one keeps its status and its claimant — an edit is not a reason to drop somebody's pending proof. |
| `goal` | Steps are matched to the existing ones by id, then by unchanged title, then by position; anything left over is genuinely new. A rename keeps its occurrence and its proof; an insert does not steal the next step's row. |
| `routine` | Everything from today forward that nobody has seen is replaced outright, so a changed cadence, owner or due time takes effect. An announced day is refreshed in place and is only **cancelled** when the new schedule no longer contains it (its card is edited to "🚫 Bekor qilindi" rather than left hanging). The past is never rewritten. |

A **removed goal step** keeps its row — with its proof and who did it — flagged
`Meta_JSON.removedStep`. If it was unfinished it is cancelled so the group card
is withdrawn. Either way it drops out of the goal's progress, and its slot is
free for a new step. Removing the last unfinished step completes the goal, just
as ticking it off would.

## Goals

> A goal's steps are ordinary deadline-less task-occurrences. Each is announced
> to the Tasks group once, with a completion button and the goal's photo-proof
> rule (a step may override it). Reminder times set on a goal repeat **daily**
> while a step is still open, because a step has no deadline of its own to hang
> a single reminder on — that is what makes the setting mean something instead
> of nothing. Goal steps stay in the **Maqsadlar** tab and do not appear in
> Bugun, which is reserved for dated work.

Progress counts the current steps only: cancelled, skipped and removed steps
are excluded.

> **Note for any goal created before this change:** the old code wrote
> `photoRequired: false` explicitly on every step, which is indistinguishable
> from "unset". Such steps will not inherit a goal-level photo requirement until
> the goal is saved again. Tasks are not deployed yet, so no such data exists in
> production, and no guessing migration is applied.

## Scheduling & the retry queue

Every Telegram send is a job on the existing `Omad_Job_Queue`, inheriting its
claim-under-lock, exponential backoff and dedup. Job types: `task_notify`,
`task_reminder`, `task_update_message`, `task_proof_prompt` (dispatched from
`runJob_`).

`runTaskScheduler_(doc, now)` runs under the script lock and:

1. materialises due occurrences for active tasks (today + a 14-day horizon;
   idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`),
2. enqueues **one** `task_notify` per new occurrence (once-tasks and goal steps
   immediately; routines on their due day), marking `Notified_At` so it never
   repeats,
3. enqueues `task_reminder` jobs for reminder times that have come due,
   marking the slot sent **at enqueue time** so a second pass — or one that
   overlaps — cannot enqueue it again. Reminders missed by more than 3 hours
   are suppressed (marked handled, logged) rather than blasted after downtime.

Nothing is announced or reminded for a task whose definition is not `active`,
which is what makes a pause immediate even for days already on the sheet.

One pass reads `Task_Occurrences` **once** and appends everything it creates in
a single write, rather than a full scan per task.

The web mutation path also calls the scheduler inline and drains one job, so a
new task appears in the group promptly; the trigger handles the rest.

## Web API

| Action | Admin key | Effect |
|---|---|---|
| `get_tasks` (**POST only**) | **yes** | The full Tashkent-time view model |
| `save_task` | **yes** | Create or edit; the edit is reconciled on to the occurrences (see [Editing](#editing)). The type cannot be changed |
| `cancel_task` | **yes** | Cancels the task and its open occurrences |
| `pause_routine` / `resume_routine` | **yes** | Stop / restart the routine entirely (see [Pause](#pause)) |
| `skip_occurrence` | **yes** | Skip a single occurrence. A future-dated one needs `confirmFuture: true`; without it the answer is `needsFutureConfirm` |
| `complete_occurrence` / `reopen_occurrence` | **yes** | Web completion / undo, incl. goal steps. A future-dated occurrence cannot be completed |

**Every** action requires `OMAD_ADMIN_KEY` — reads included. The task board is
internal company information: who is responsible for what, when it is due and
whose deadlines have been slipping. The key is entered once on the /tasks page
and kept only in `sessionStorage`, and reads are rate-limited
(`TASK_READ_RATE_LIMIT`, 30/minute) **before** the key is compared, so the
endpoint cannot be used to guess it.

`get_tasks` over **GET returns an error by design**: a GET carries its
parameters in the URL, which is the one place an admin key must never travel.
The accounting reads (`get_omad`, `get_cafe`) are deliberately unchanged.

## Frontend

`tasks.html` + `assets/tasks/0{1..4}-*.js`, reusing `assets/omad/00-config.js`
for the backend URL and the admin access guard (so there is still one source of
truth for the URL). Tabs: **Bugun | Vazifalar | Muntazam | Maqsadlar |
Bajarilgan**. The Today view separates overdue, due-now, waiting-for-proof,
upcoming and completed-today.

## Manual steps to deploy (operator)

1. **Ship the backend** — paste the regenerated `script.gs` into the live Apps
   Script deployment (see [LIVE_STATE.md](LIVE_STATE.md) — use *Manage
   deployments → the …DtCA2W deployment → New version*, never *New deployment*).
2. **Configure the Tasks group** — add the bot to the tasks group, then set its
   **numeric** chat id in **Sozlamalar → Telegram → Vazifalar Guruhi ID** and
   Save. `@username` is not accepted here (see
   [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md#vazifalar-guruhi-uchun-raqamli-id)).
   It can be the same group as the reporting group or a different one.
3. **Add a time-driven trigger** — Apps Script → Triggers → Add Trigger →
   function **`processTaskSchedules`**, *Time-driven*, *Minutes timer*, every
   5 minutes (or every minute for tighter reminder timing). This is separate
   from the existing `processPendingTelegramJobs` trigger.
4. **`OMAD_ADMIN_KEY` must be set** in Script Properties — the /tasks page now
   needs it to read the board, not only to change it.

No new spreadsheet setup is needed; the `Tasks` and `Task_Occurrences` sheets
are created on first use.

## Testing

```
tests/task-recurrence.test.js    recurrence engine + Tashkent time math
tests/task-occurrences.test.js   materialisation, views, streak/rate, goals
tests/task-telegram.test.js      done callback, photo proof, in-place update
tests/task-reminders.test.js     reminder dedup, catch-up, stop-on-complete
tests/task-isolation.test.js     /yangi + ledger untouched by tasks
tests/task-api.test.js           web API gating + Tasks-group settings
tests/task-date-keys.test.js     date/time keys survive the spreadsheet
tests/task-pause.test.js         a paused routine is completely silent
tests/task-editing.test.js       edits reconcile on to the occurrences
tests/task-proof.test.js         claim → ForceReply prompt → reply-only matching
tests/task-access.test.js        reads are admin-gated, POST-only, throttled
tests/task-goals.test.js         step announcing, inherited photo rule, daily reminders
tests/task-scheduler.test.js     one read + one batched write; future-work guards
tests/task-card-format.test.js   card HTML: description, collapsing, escaping
tests/tasks-ui.e2e.js            the /tasks page in Chromium (auto-skips w/o Playwright)
```

Run with `npm test` (unit) and `npm run test:e2e` (browser), as with the rest
of the app. `npm run build` regenerates `script.gs` after any `apps-script/`
edit.
