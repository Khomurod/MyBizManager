from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match in {path}, found {count}")
    p.write_text(text.replace(old, new, 1))
    print(f"applied: {label}")


# ---------------------------------------------------------------- scheduler
replace_once(
    "apps-script/19_tasks_scheduler.gs",
    '''  sendTelegramMessage_(chatId,
    buildTaskReminderMessage_(occ, remindTask ? remindTask.description : ""),
    taskDoneMarkup_(occ.id), "HTML");
}''',
    '''  var sent = sendTelegramMessage_(chatId,
    buildTaskReminderMessage_(occ, remindTask ? remindTask.description : ""),
    taskDoneMarkup_(occ.id), "HTML");

  // An occurrence with reminder times has no separate "Yangi vazifa" card.
  // Its first successful reminder is therefore the primary group card: keep
  // that message id so completion/proof/cancellation can edit it in place.
  if (!occ.msgId) {
    var reminderMsgId = extractTelegramMessageId_(sent);
    if (reminderMsgId) {
      occ.msgId = String(reminderMsgId);
      if (!occ.notifiedAt) occ.notifiedAt = new Date().toISOString();
      writeOccurrenceRow_(doc, occ);
    }
  }
}''',
    "first reminder becomes primary card"
)

replace_once(
    "apps-script/19_tasks_scheduler.gs",
    '''      // Announce.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN) {''',
    '''      // Announce only when there is no reminder schedule. Reminder times
      // are the notification schedule, not an extra notification channel.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN && !occ.reminderTimes.length) {''',
    "suppress separate notify when reminders exist"
)

old_reminder_loop = '''      // Remind.
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
'''

new_reminder_loop = '''      // Remind.
      if (occ.status === TASK_STATUS_OPEN && occ.reminderTimes.length) {
        var dates = taskReminderDatesFor_(occ, todayKey);
        // A rolling occurrence accumulates a marker a day; trim the ones no
        // date list will ever name again before adding today's.
        var changed = taskRemindsDaily_(occ) ? pruneReminderMarkers_(occ, todayKey) : false;

        // A task created after one or more of today's reminder times must not
        // immediately blast every already-missed slot. Slots that were still
        // ahead when the occurrence was created keep normal behaviour; slots
        // already behind it are silent. If *all* of today's slots were already
        // behind it, send only the latest one once so a late-created task is
        // visible instead of waiting until tomorrow (or forever for a routine).
        //
        // The `createdMs <= now` guard matters to deterministic tests and also
        // makes this explicitly a creation-time rule, never a host-clock guess.
        var createdMs = Date.parse(occ.createdAt || "") || 0;
        var creationRuleApplies = createdMs > 0 && createdMs <= now;
        var creationInfoByDate = {};
        if (creationRuleApplies) {
          for (var scanD = 0; scanD < dates.length; scanD++) {
            var scanDate = dates[scanD];
            if (scanDate !== todayKey) continue;
            var latestBeforeCreation = "";
            var hasSlotAfterCreation = false;
            for (var scanR = 0; scanR < occ.reminderTimes.length; scanR++) {
              var scanSlot = scanDate + " " + occ.reminderTimes[scanR];
              if (occ.remindersSent[scanSlot]) continue;
              var scanInstant = taskInstantMs_(scanDate, occ.reminderTimes[scanR]);
              if (!isFinite(scanInstant)) continue;
              if (scanInstant < createdMs) latestBeforeCreation = scanSlot;
              else hasSlotAfterCreation = true;
            }
            creationInfoByDate[scanDate] = {
              latestBeforeCreation: latestBeforeCreation,
              hasSlotAfterCreation: hasSlotAfterCreation
            };
          }
        }

        for (var d = 0; d < dates.length; d++) {
          for (var r = 0; r < occ.reminderTimes.length; r++) {
            var slotKey = dates[d] + " " + occ.reminderTimes[r];
            if (occ.remindersSent[slotKey]) continue;
            var instant = taskInstantMs_(dates[d], occ.reminderTimes[r]);
            if (!isFinite(instant) || now < instant) continue;

            var shouldSend = now - instant <= TASK_REMINDER_MAX_LATE_MS;
            var creationInfo = creationInfoByDate[dates[d]];
            var existedBeforeSlot = !creationInfo || instant >= createdMs;
            if (!existedBeforeSlot) {
              // This reminder time had already passed when the occurrence was
              // created. Wait for a later configured time when one existed at
              // creation; otherwise exactly the latest missed time is the
              // single catch-up message, even outside the ordinary 3h window.
              shouldSend = !creationInfo.hasSlotAfterCreation &&
                slotKey === creationInfo.latestBeforeCreation;
            }

            if (shouldSend) {
              enqueueTaskJob_(doc, "task_reminder", occ.id, { occurrenceId: occ.id, slot: slotKey });
              reminders++;
            } else if (!existedBeforeSlot) {
              debugLog_(doc, "task_reminder_skipped_before_creation", occ.id + " " + slotKey);
            } else {
              debugLog_(doc, "task_reminder_skipped_stale", occ.id + " " + slotKey);
            }
            occ.remindersSent[slotKey] = new Date(now).toISOString();
            changed = true;
          }
        }
        if (changed) writeOccurrenceRow_(doc, occ);
      }
'''
replace_once(
    "apps-script/19_tasks_scheduler.gs",
    old_reminder_loop,
    new_reminder_loop,
    "late-created reminder collapse"
)

# ---------------------------------------------------------- trigger-cycle tests
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(notifySends(gas).length, 1, 'the task was announced');
  assert.strictEqual(reminderSends(gas).length, 1, 'and its due reminder went out');''',
    '''  assert.strictEqual(notifySends(gas).length, 0, 'a reminder-led task has no separate announcement');
  assert.strictEqual(reminderSends(gas).length, 1, 'its due reminder is the first group message');''',
    "trigger sends reminder only"
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  // A notify and a reminder, both enqueued and drained by the same tick.
  assert.strictEqual(gas.processPendingTelegramJobs(), 2);''',
    '''  // The reminder itself is the only first-contact job.
  assert.strictEqual(gas.processPendingTelegramJobs(), 1);''',
    "trigger processed-job count"
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(reminderSends(gas).length, 1, 'five passes, one reminder');
  assert.strictEqual(notifySends(gas).length, 1, 'and one announcement');''',
    '''  assert.strictEqual(reminderSends(gas).length, 1, 'five passes, one reminder');
  assert.strictEqual(notifySends(gas).length, 0, 'and no duplicate announcement channel');''',
    "trigger idempotency expectation"
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(reminderSends(gas).length, 1);
  assert.strictEqual(notifySends(gas).length, 1);''',
    '''  assert.strictEqual(reminderSends(gas).length, 1);
  assert.strictEqual(notifySends(gas).length, 0);''',
    "manual trigger expectation"
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  gas.processPendingTelegramJobs();            // announces, nothing due yet
  assert.strictEqual(reminderSends(gas).length, 0);''',
    '''  gas.processPendingTelegramJobs();            // reminder is still in the future: stay silent
  assert.strictEqual(reminderSends(gas).length, 0);
  assert.strictEqual(notifySends(gas).length, 0);''',
    "future reminder stays silent"
)

# --------------------------------------------------------------- reminder tests
replace_once(
    "tests/task-reminders.test.js",
    '''const AT_0900 = Date.UTC(2026, 7, 10, 4, 0, 0);  // 09:00 Tashkent
const AT_1430 = Date.UTC(2026, 7, 10, 9, 30, 0); // 14:30 Tashkent
const AT_1500 = Date.UTC(2026, 7, 10, 10, 0, 0); // 15:00 Tashkent''',
    '''const AT_0005 = Date.UTC(2026, 7, 9, 19, 5, 0);  // 00:05 Tashkent
const AT_0900 = Date.UTC(2026, 7, 10, 4, 0, 0);  // 09:00 Tashkent
const AT_1430 = Date.UTC(2026, 7, 10, 9, 30, 0); // 14:30 Tashkent
const AT_1500 = Date.UTC(2026, 7, 10, 10, 0, 0); // 15:00 Tashkent
const AT_1805 = Date.UTC(2026, 7, 10, 13, 5, 0); // 18:05 Tashkent
const AT_2100 = Date.UTC(2026, 7, 10, 16, 0, 0); // 21:00 Tashkent''',
    "reminder test instants"
)

jobs_helper = '''function jobsOfType(gas, type) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0] && row[2] === type);
}
'''
replace_once(
    "tests/task-reminders.test.js",
    jobs_helper,
    jobs_helper + '''
function setTodayOccurrenceCreatedAt(gas, doc, createdAtMs) {
  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  if (!occ) throw new Error('today occurrence was not materialised');
  occ.createdAt = new Date(createdAtMs).toISOString();
  gas.writeOccurrenceRow_(doc, occ);
  return occ;
}
''',
    "reminder creation-time fixture helper"
)

anchor = '''test('a reminder fires once per due time and never duplicates across passes', () => {'''
new_tests = '''test('a reminder-led routine stays silent at midnight and first speaks at its reminder time', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['18:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0005);
  setTodayOccurrenceCreatedAt(gas, doc, AT_0005);

  gas.runTaskScheduler_(doc, AT_0005);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0, 'no midnight task announcement');
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0, '18:00 is still ahead');

  gas.runTaskScheduler_(doc, AT_1805);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'one message at the configured time');

  gas.processPendingJobs_(doc, 25);
  assert.strictEqual(gas.__sentMessages.filter(m => /Eslatma/.test(m.text)).length, 1);
  assert.strictEqual(gas.__sentMessages.filter(m => /Yangi vazifa/.test(m.text)).length, 0);

  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  assert.ok(occ.msgId, 'the first reminder becomes the occurrence group card');
  assert.ok(occ.notifiedAt, 'the successful first group contact is recorded');
});

test('creating a task after an early reminder waits for the next configured time', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '18:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_0900);
  const occ = setTodayOccurrenceCreatedAt(gas, doc, AT_0900);

  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0,
    'the already-missed 08:00 slot is not blasted at creation');
  assert.ok(gas.findOccurrence_(doc, occ.id).remindersSent[TODAY + ' 08:00'],
    'the pre-creation slot is consumed so it cannot revive later');

  gas.runTaskScheduler_(doc, AT_1805);
  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1);
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 18:00');
});

test('creating a task after all reminder times sends only the latest one once', () => {
  const { gas, doc } = setup();
  const task = makeRoutine(gas, { reminderTimes: ['08:00', '12:00'] });
  gas.materializeTaskOccurrences_(doc, task, AT_2100);
  setTodayOccurrenceCreatedAt(gas, doc, AT_2100);

  gas.runTaskScheduler_(doc, AT_2100);
  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1, 'no burst of old reminders');
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 12:00',
    'the latest configured slot is the single catch-up');
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);

  gas.runTaskScheduler_(doc, AT_2100 + 5 * 60000);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'a second pass cannot duplicate catch-up');
});

'''
replace_once(
    "tests/task-reminders.test.js",
    anchor,
    new_tests + anchor,
    "reminder notification behavior tests"
)

# ---------------------------------------------------------- goal test wording
replace_once(
    "tests/task-goals.test.js",
    ''' * Each is announced to the Tasks group once, with a completion button and the
 * goal's photo-proof rule (a step may override it). Reminder times set on a
 * goal repeat DAILY while a step is still open, because a step has no''',
    ''' * A step with no reminders is announced to the Tasks group once; a step with
 * reminders first appears at its configured reminder time. Reminder times set
 * on a goal repeat DAILY while a step is still open, because a step has no''',
    "goal test contract wording"
)

# ---------------------------------------------------------------- documentation
replace_once(
    "docs/TASKS.md",
    '''> A goal's steps are ordinary deadline-less task-occurrences. Each is announced
> to the Tasks group once, with a completion button and the goal's photo-proof
> rule (a step may override it). Reminder times set on a goal repeat **daily**
> while a step is still open, because a step has no deadline of its own to hang
> a single reminder on — that is what makes the setting mean something instead
> of nothing. Goal steps stay in the **Maqsadlar** tab and do not appear in
> Bugun, which is reserved for dated work.''',
    '''> A goal's steps are ordinary deadline-less task-occurrences. A step with no
> reminder schedule is announced to the Tasks group once; a step with reminder
> times stays silent until its first reminder, which becomes its first group
> card. Reminder times set on a goal repeat **daily** while a step is still open,
> because a step has no deadline of its own to hang a single reminder on — that
> is what makes the setting mean something instead of nothing. Goal steps stay
> in the **Maqsadlar** tab and do not appear in Bugun, which is reserved for
> dated work.''',
    "goal reminder docs"
)

replace_once(
    "docs/TASKS.md",
    '''| Goal step | derived | every day while the step is open, whenever the goal has reminder times |

Reminders stop the instant the occurrence becomes `Completed`, `Cancelled` or''',
    '''| Goal step | derived | every day while the step is open, whenever the goal has reminder times |

**Reminder times are the notification schedule, not an extra notification.** If
an occurrence has one or more reminder times, materialising it is silent — no
midnight or immediate `Yangi vazifa` is posted. Its first due reminder is its
first Telegram card; later configured times remain additional reminders. An
occurrence with no reminder times keeps the ordinary one-time `Yangi vazifa`
announcement.

A task created after an earlier reminder time does not receive a burst of missed
messages: if a later configured time was still ahead when it was created, the
old slot is consumed quietly and the system waits for that later time. If the
task was created after all of today's configured times, exactly the latest one
is sent once as a catch-up so the task is not invisible. Existing tasks still
use the normal three-hour catch-up rule after scheduler downtime.

Reminders stop the instant the occurrence becomes `Completed`, `Cancelled` or''',
    "notification schedule docs"
)

replace_once(
    "docs/TASKS.md",
    '''2. enqueues **one** `task_notify` per new occurrence (once-tasks and goal steps
   immediately; routines on their due day), marking `Notified_At` so it never
   repeats,
3. enqueues `task_reminder` jobs for reminder times that have come due,
   marking the slot sent **at enqueue time** so a second pass — or one that
   overlaps — cannot enqueue it again. Reminders missed by more than 3 hours
   are suppressed (marked handled, logged) rather than blasted after downtime.''',
    '''2. enqueues **one** `task_notify` only for an occurrence with **no reminder
   times** (once-tasks and goal steps immediately; routines on their due day),
   marking `Notified_At` so it never repeats. Reminder-configured occurrences
   stay silent here,
3. enqueues `task_reminder` jobs for reminder times that have come due,
   marking the slot sent **at enqueue time** so a second pass — or one that
   overlaps — cannot enqueue it again. The first successful reminder stores the
   Telegram message id and becomes the occurrence's primary editable card.
   Existing tasks still suppress reminders missed by more than 3 hours after
   downtime; only slots that were already past when a task was newly created
   use the one-message late-creation rule above.''',
    "scheduler docs"
)

replace_once(
    "docs/TASKS.md",
    '''The web mutation path also calls the scheduler inline and drains one job, so a
new task appears in the group promptly; the trigger handles the rest.''',
    '''The web mutation path also calls the scheduler inline and drains one job. A task
with no reminders can therefore appear in the group promptly; a task with
reminder times deliberately waits for that schedule (subject only to the
late-creation catch-up rule above). The trigger handles the rest.''',
    "web mutation docs"
)

replace_once(
    "docs/APP_BRIEF.md",
    '''- **`reminderTimes` is a list of Asia/Tashkent `HH:mm` strings**, deduplicated
  and sorted on save. Several times a day is one card each: the sent-marker is
  `"<dateKey> <HH:mm>"`, so a scheduler pass that runs twice inside one slot
  cannot send twice. Nothing about the phone's or the browser's timezone enters
  it — both editors say so on the field.
- **An edit that does not mention a field leaves it alone**, which is what lets''',
    '''- **`reminderTimes` is a list of Asia/Tashkent `HH:mm` strings**, deduplicated
  and sorted on save. Several times a day is one card each: the sent-marker is
  `"<dateKey> <HH:mm>"`, so a scheduler pass that runs twice inside one slot
  cannot send twice. Nothing about the phone's or the browser's timezone enters
  it — both editors say so on the field.
- **Reminder times are the notification schedule, not an extra ping.** An
  occurrence with reminder times does not also send an immediate/midnight
  `Yangi vazifa`; its first due reminder is its first group card. If the task is
  created after an earlier reminder but another configured time was still ahead,
  the missed slot is consumed quietly and the later time is used. If it is
  created after all of today's reminder times, exactly the latest one is sent
  once as catch-up. Existing tasks keep the normal three-hour stale-reminder
  suppression after scheduler downtime. Occurrences with no reminder times keep
  the ordinary `Yangi vazifa` card.
- **An edit that does not mention a field leaves it alone**, which is what lets''',
    "app brief reminder rule"
)

replace_once(
    "docs/APP_BRIEF.md",
    '''- The task scheduler materialises occurrences for today + a 14-day horizon,
  idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`, marks each reminder
  slot **at enqueue time**, and suppresses reminders missed by more than 3 hours
  rather than blasting them after downtime.''',
    '''- The task scheduler materialises occurrences for today + a 14-day horizon,
  idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`, and marks each
  reminder slot **at enqueue time**. Reminder-configured occurrences stay silent
  until a reminder is due; the first successful reminder becomes the editable
  group card. Existing tasks suppress reminders missed by more than 3 hours
  after downtime. A newly created task never blasts slots that were already in
  the past at creation: it waits for the next configured time, or sends only the
  latest once when every time for today was already past.''',
    "app brief background rule"
)

print("Task reminder notification fix applied successfully")
