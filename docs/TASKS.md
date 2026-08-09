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
| `19_tasks_scheduler.gs` | The scheduler (`runTaskScheduler_` / `processTaskSchedules`), the queue job runners (`task_notify`, `task_reminder`, `task_update_message`) and the web API handlers. |
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

`TELEGRAM_TASKS_GROUP_CHAT_ID` lives in Script Properties (set from
**Omad → Sozlamalar → Telegram → Vazifalar Guruhi ID**). Empty disables the
task Telegram integration cleanly.

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

### Completion flow

`✅ Ish bajarildi` (callback `t_done:<occurrenceId>`), gated to the configured
Tasks group:

- **No photo required** → completed immediately.
- **Photo required** → the occurrence goes to *Waiting for Proof*, the presser
  is asked to reply with a photo, and it completes only when a photo arrives
  from that user (matched by reply, else by the user's pending prompt). The
  photo's `file_id` and message id are recorded.

Every completion records **who** (Telegram id + name), **when**, whether it was
**on time or late** (and the late duration), and — for goals — recomputes the
parent goal's progress. Remaining reminders stop automatically: the scheduler
and the reminder job both act only on still-`Open` occurrences. The group card
is **edited in place** to show the result rather than a duplicate being posted.

## Scheduling & the retry queue

Every Telegram send is a job on the existing `Omad_Job_Queue`, inheriting its
claim-under-lock, exponential backoff and dedup. Job types: `task_notify`,
`task_reminder`, `task_update_message` (dispatched from `runJob_`).

`runTaskScheduler_(doc, now)` runs under the script lock and:

1. materialises due occurrences for active tasks (today + a 14-day horizon;
   idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`),
2. enqueues **one** `task_notify` per new occurrence (once-tasks immediately;
   routines on their due day), marking `Notified_At` so it never repeats,
3. enqueues `task_reminder` jobs for reminder times that have come due,
   marking the slot sent **at enqueue time** so a second pass — or one that
   overlaps — cannot enqueue it again. Reminders missed by more than 3 hours
   are suppressed (marked handled, logged) rather than blasted after downtime.

The web mutation path also calls the scheduler inline and drains one job, so a
new task appears in the group promptly; the trigger handles the rest.

## Web API

| Action | Admin key | Effect |
|---|---|---|
| `get_tasks` (POST or GET) | no | The full Tashkent-time view model |
| `save_task` | **yes** | Create or edit; editing a routine re-plans only its not-yet-sent future occurrences |
| `cancel_task` | **yes** | Cancels the task and its open occurrences |
| `pause_routine` / `resume_routine` | **yes** | Stop / restart occurrence generation |
| `skip_occurrence` | **yes** | Skip Today (a single occurrence) |
| `complete_occurrence` / `reopen_occurrence` | **yes** | Web completion / undo, incl. goal steps |

Reads are open (like `get_omad`); mutations require `OMAD_ADMIN_KEY`, entered
once on the /tasks page and kept only in `sessionStorage`.

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
   id in **Sozlamalar → Telegram → Vazifalar Guruhi ID** and Save. (It can be
   the same group as the reporting group or a different one.)
3. **Add a time-driven trigger** — Apps Script → Triggers → Add Trigger →
   function **`processTaskSchedules`**, *Time-driven*, *Minutes timer*, every
   5 minutes (or every minute for tighter reminder timing). This is separate
   from the existing `processPendingTelegramJobs` trigger.

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
tests/tasks-ui.e2e.js            the /tasks page in Chromium (auto-skips w/o Playwright)
```

Run with `npm test` (unit) and `npm run test:e2e` (browser), as with the rest
of the app. `npm run build` regenerates `script.gs` after any `apps-script/`
edit.
