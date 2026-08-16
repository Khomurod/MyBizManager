from pathlib import Path

p = Path('tests/task-trigger-cycle.test.js')
text = p.read_text()
old = '''test('completing between two ticks stops the reminder that was not sent yet', () => {
  const { gas, doc } = setup();
  const parts = gas.taskTzParts_(Date.now() + 6 * 3600000); // hours away
  makeDueTask(gas, doc, parts.timeKey);

  gas.processPendingTelegramJobs();            // reminder is still in the future: stay silent
  assert.strictEqual(reminderSends(gas).length, 0);
  assert.strictEqual(notifySends(gas).length, 0);

  const occ = gas.readOccurrenceRows_(doc)[0];
  gas.completeTaskOccurrence_(doc, occ, { byName: 'Ali', source: 'telegram' });

  gas.processPendingTelegramJobs();
  assert.strictEqual(reminderSends(gas).length, 0, 'a finished task is never reminded');
});'''
new = '''test('completing between two ticks stops the reminder that was not sent yet', () => {
  const { gas, doc } = setup();
  // Use tomorrow rather than "six hours from now": near midnight, +6h wraps
  // to an early clock time today and makes the supposedly future reminder due.
  const tomorrow = gas.taskDateKeyAddDays_(gas.taskTodayKey_(Date.now()), 1);
  const result = gas.normalizeTaskInput_({
    type: 'once', title: 'Ertangi hisobot',
    deadlineKey: tomorrow, deadlineTime: '09:00',
    reminderTimes: ['09:00'], remindDaily: false
  }, null);
  gas.appendTaskRow_(doc, result.task);

  gas.processPendingTelegramJobs();            // tomorrow's reminder is not due
  assert.strictEqual(reminderSends(gas).length, 0);
  assert.strictEqual(notifySends(gas).length, 0);

  const occ = gas.readOccurrenceRows_(doc)[0];
  assert.ok(occ, 'tomorrow occurrence was materialised');
  gas.completeTaskOccurrence_(doc, occ, { byName: 'Ali', source: 'telegram' });

  gas.processPendingTelegramJobs();
  assert.strictEqual(reminderSends(gas).length, 0, 'a finished task is never reminded');
});'''
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one trigger-cycle fixture block, found {count}')
p.write_text(text.replace(old, new, 1))
print('made future-reminder trigger-cycle test deterministic')
