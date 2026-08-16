from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}")
    p.write_text(text.replace(old, new, 1))


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

  // Reminder-configured occurrences deliberately do not get a separate
  // "Yangi vazifa" card. The first reminder is therefore the occurrence's
  // primary group card and must be remembered so completion can edit it in
  // place exactly like the old task_notify card.
  if (!occ.msgId) {
    var reminderMsgId = extractTelegramMessageId_(sent);
    if (reminderMsgId) {
      occ.msgId = String(reminderMsgId);
      if (!occ.notifiedAt) occ.notifiedAt = new Date().toISOString();
      writeOccurrenceRow_(doc, occ);
    }
  }
}'''
)

replace_once(
    "apps-script/19_tasks_scheduler.gs",
    '''function taskReminderDatesFor_(occ, todayKey) {
  if (taskRemindsDaily_(occ)) return [todayKey];
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  return [];
}
''',
    '''function taskReminderDatesFor_(occ, todayKey) {
  if (taskRemindsDaily_(occ)) return [todayKey];
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  return [];
}

/**
 * A reminder-led occurrence has not actually reached Telegram yet.
 *
 * Reminders_Sent_JSON is intentionally not part of this test: a past slot can
 * be marked handled while we wait for a later reminder the same day, and that
 * must not make the occurrence look as though somebody has already seen it.
 */
function taskNeedsFirstReminderContact_(occ) {
  return !occ.msgId && !occ.notifiedAt;
}
'''
)

replace_once(
    "apps-script/19_tasks_scheduler.gs",
    '''      // Announce.
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
''',
    '''      // Announce only when there is no reminder schedule. If reminder
      // times exist, they ARE the notification schedule: materialisation stays
      // silent and the first due reminder becomes the occurrence's group card.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN && !occ.reminderTimes.length) {
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
'''
)

replace_once(
    "apps-script/19_tasks_scheduler.gs",
    '''      // Remind.
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
''',
    '''      // Remind.
      if (occ.status === TASK_STATUS_OPEN && occ.reminderTimes.length) {
        var dates = taskReminderDatesFor_(occ, todayKey);
        // A rolling occurrence accumulates a marker a day; trim the ones no
        // date list will ever name again before adding today's.
        var changed = taskRemindsDaily_(occ) ? pruneReminderMarkers_(occ, todayKey) : false;

        // Before Telegram has seen this occurrence, several already-passed
        // reminder times must never turn into a burst. If another reminder is
        // still ahead today, consume the old slots and wait for it. If today's
        // last reminder has already passed, send exactly that latest slot once
        // even outside the ordinary 3-hour catch-up window; otherwise a task
        // created late (or a delayed first scheduler pass) could stay invisible.
        var firstReminderContact = taskNeedsFirstReminderContact_(occ);
        var futureReminderToday = false;
        var latestDueToday = "";
        if (firstReminderContact) {
          for (var scanD = 0; scanD < dates.length; scanD++) {
            if (dates[scanD] !== todayKey) continue;
            for (var scanR = 0; scanR < occ.reminderTimes.length; scanR++) {
              var scanSlot = dates[scanD] + " " + occ.reminderTimes[scanR];
              if (occ.remindersSent[scanSlot]) continue;
              var scanInstant = taskInstantMs_(dates[scanD], occ.reminderTimes[scanR]);
              if (!isFinite(scanInstant)) continue;
              if (now < scanInstant) futureReminderToday = true;
              else latestDueToday = scanSlot;
            }
          }
        }

        for (var d = 0; d < dates.length; d++) {
          for (var r = 0; r < occ.reminderTimes.length; r++) {
            var slotKey = dates[d] + " " + occ.reminderTimes[r];
            if (occ.remindersSent[slotKey]) continue;
            var instant = taskInstantMs_(dates[d], occ.reminderTimes[r]);
            if (!isFinite(instant) || now < instant) continue;

            var shouldSend = now - instant <= TASK_REMINDER_MAX_LATE_MS;
            if (firstReminderContact && dates[d] === todayKey) {
              shouldSend = !futureReminderToday && slotKey === latestDueToday;
            }

            if (shouldSend) {
              enqueueTaskJob_(doc, "task_reminder", occ.id, { occurrenceId: occ.id, slot: slotKey });
              reminders++;
            } else if (!(firstReminderContact && dates[d] === todayKey && futureReminderToday)) {
              debugLog_(doc, "task_reminder_skipped_stale", occ.id + " " + slotKey);
            }
            occ.remindersSent[slotKey] = new Date(now).toISOString();
            changed = true;
          }
        }
        if (changed) writeOccurrenceRow_(doc, occ);
      }
'''
)

# ---------------------------------------------------------- trigger-cycle tests
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(notifySends(gas).length, 1, 'the task was announced');
  assert.strictEqual(reminderSends(gas).length, 1, 'and its due reminder went out');''',
    '''  assert.strictEqual(notifySends(gas).length, 0, 'a reminder-led task has no separate announcement');
  assert.strictEqual(reminderSends(gas).length, 1, 'its due reminder is the first group message');'''
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  // A notify and a reminder, both enqueued and drained by the same tick.
  assert.strictEqual(gas.processPendingTelegramJobs(), 2);''',
    '''  // The reminder itself is the only first-contact job.
  assert.strictEqual(gas.processPendingTelegramJobs(), 1);'''
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(reminderSends(gas).length, 1, 'five passes, one reminder');
  assert.strictEqual(notifySends(gas).length, 1, 'and one announcement');''',
    '''  assert.strictEqual(reminderSends(gas).length, 1, 'five passes, one reminder');
  assert.strictEqual(notifySends(gas).length, 0, 'and no duplicate announcement channel');'''
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  assert.strictEqual(reminderSends(gas).length, 1);
  assert.strictEqual(notifySends(gas).length, 1);''',
    '''  assert.strictEqual(reminderSends(gas).length, 1);
  assert.strictEqual(notifySends(gas).length, 0);'''
)
replace_once(
    "tests/task-trigger-cycle.test.js",
    '''  gas.processPendingTelegramJobs();            // announces, nothing due yet
  assert.strictEqual(reminderSends(gas).length, 0);''',
    '''  gas.processPendingTelegramJobs();            // reminder is still in the future: stay silent
  assert.strictEqual(reminderSends(gas).length, 0);
  assert.strictEqual(notifySends(gas).length, 0);'''
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
const AT_2100 = Date.UTC(2026, 7, 10, 16, 0, 0); // 21:00 Tashkent'''
)

insert_after = '''function jobsOfType(gas, type) {
  const sheet = gas.__spreadsheet.getSheetByName('Omad_Job_Queue');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).filter(row => row[0] && row[2] === type);
}
'''
new_tests = r'''

test('a reminder-led routine stays silent at midnight and first speaks at its reminder time', () => {
  const { gas, doc } = setup();
  makeRoutine(gas, { reminderTimes: ['18:00'] });

  gas.runTaskScheduler_(doc, AT_0005);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0, 'no midnight task announcement');
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0, '18:00 is still ahead');

  gas.runTaskScheduler_(doc, AT_1805);
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'one message at the configured time');

  gas.processPendingJobs_(doc, 25);
  const sent = gas.__sentMessages.filter(m => /Eslatma/.test(m.text));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(gas.__sentMessages.filter(m => /Yangi vazifa/.test(m.text)).length, 0);

  const occ = gas.readOccurrenceRows_(doc).find(o => o.dateKey === TODAY);
  assert.ok(occ.msgId, 'the first reminder becomes the occurrence group card');
  assert.ok(occ.notifiedAt, 'the successful first group contact is recorded');
});

test('before first contact, an earlier reminder is skipped when a later one is still ahead', () => {
  const { gas, doc } = setup();
  makeRoutine(gas, { reminderTimes: ['08:00', '18:00'] });

  gas.runTaskScheduler_(doc, AT_0900);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 0,
    'do not send a late 08:00 ping when 18:00 can be the clean first contact');

  gas.runTaskScheduler_(doc, AT_1805);
  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1);
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 18:00');
});

test('if all first-contact reminder times are already past, only the latest is sent once', () => {
  const { gas, doc } = setup();
  makeRoutine(gas, { reminderTimes: ['08:00', '12:00'] });

  // First scheduler pass is at 21:00. Both slots are stale by the ordinary
  // 3-hour rule, but silence would mean the occurrence never reached Telegram.
  gas.runTaskScheduler_(doc, AT_2100);

  const reminders = jobsOfType(gas, 'task_reminder');
  assert.strictEqual(reminders.length, 1, 'collapse missed first-contact slots to one message');
  assert.strictEqual(JSON.parse(reminders[0][3]).slot, TODAY + ' 12:00', 'use the latest configured slot');
  assert.strictEqual(jobsOfType(gas, 'task_notify').length, 0);

  gas.runTaskScheduler_(doc, AT_2100 + 5 * 60000);
  assert.strictEqual(jobsOfType(gas, 'task_reminder').length, 1, 'a second pass cannot duplicate catch-up');
});
'''
replace_once(
    "tests/task-reminders.test.js",
    insert_after,
    insert_after + new_tests
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
> dated work.'''
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

Before that first Telegram contact, missed times are collapsed rather than
blasted: if another reminder is still ahead today, old slots are consumed and
the system waits for the later one; if all of today's times have already passed,
exactly the latest one is sent once so a newly created or delayed task does not
stay invisible.

Reminders stop the instant the occurrence becomes `Completed`, `Cancelled` or'''
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
   Telegram message id so completion can edit that card in place. Ordinary
   reminders missed by more than 3 hours are suppressed; before first contact,
   missed slots collapse to the latest due slot so the occurrence is not silent.'''
)

replace_once(
    "docs/TASKS.md",
    '''The web mutation path also calls the scheduler inline and drains one job, so a
new task appears in the group promptly; the trigger handles the rest.''',
    '''The web mutation path also calls the scheduler inline and drains one job. A task
with no reminders can therefore appear in the group promptly; a task with
reminder times deliberately waits for that schedule. The trigger handles the
rest.'''
)

# App Brief: add the business rule beside the existing reminder rules.
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
  `Yangi vazifa`; its first due reminder is its first group card. If another
  reminder is still ahead that day, missed earlier slots are consumed quietly;
  if all first-contact times are already past, exactly the latest is sent once
  instead of blasting several old reminders or leaving the task invisible.
  Occurrences with no reminder times keep the ordinary `Yangi vazifa` card.
- **An edit that does not mention a field leaves it alone**, which is what lets'''
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
  until a reminder is due; the first reminder becomes the editable group card.
  Later reminders missed by more than 3 hours are suppressed. Before first
  contact, missed same-day slots collapse to one latest-slot catch-up so a task
  is never replaced by a burst of old messages or by silence.'''
)

print("Task reminder notification fix applied successfully")
