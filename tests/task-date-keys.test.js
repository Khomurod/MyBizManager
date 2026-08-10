'use strict';

/**
 * Task date/time keys survive the spreadsheet.
 *
 * Invariant: a Google Sheets cell rewrites a bare "2026-08-10" into a date and
 * a bare "20:00" into an 1899-12-30 time unless the column is formatted as
 * text. Every task start, end, deadline, due time and occurrence date key must
 * therefore be written into a text-formatted column, and every read must still
 * recover a cell an older write already coerced. Without both halves a routine
 * loses its bounds, the (taskId, dateKey) idempotency key collapses to "" and
 * the scheduler re-creates its whole horizon on every pass.
 *
 * Every test here loads the harness with `coerceLikeSheets: true`, which is the
 * live spreadsheet's behaviour, not a hypothetical one.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent
const TODAY = '2026-08-10';

function fresh(extra) {
  const gas = loadScript(Object.assign({ coerceLikeSheets: true }, extra || {}));
  return { gas, doc: gas.__spreadsheet };
}

function makeTask(gas, payload) {
  const result = gas.normalizeTaskInput_(payload, null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(gas.__spreadsheet, result.task);
  return result.task;
}

/** The raw stored cell, exactly as the sheet holds it. */
function rawCell(gas, sheetName, header, rowIndex, columnName) {
  const sheet = gas.__spreadsheet.sheets[sheetName];
  return sheet.data[rowIndex][gas[header].indexOf(columnName)];
}

// ------------------------------------------------------------- round trips

test('a routine\'s start, end and due time survive the spreadsheet round-trip', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Kassa', startKey: TODAY, endKey: '2026-09-30',
    recurrence: { freq: 'daily' }, dueTime: '20:00'
  });

  const stored = gas.readTaskRows_(doc).find(t => t.id === task.id);
  assert.strictEqual(stored.startKey, TODAY);
  assert.strictEqual(stored.endKey, '2026-09-30');
  assert.strictEqual(stored.dueTime, '20:00');
});

test('the stored Start_Key cell is still text', () => {
  const { gas } = fresh();
  makeTask(gas, {
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' }
  });

  const cell = rawCell(gas, 'Tasks', 'TASKS_HEADER', 1, 'Start_Key');
  assert.strictEqual(typeof cell, 'string', 'the column was formatted as text before the value landed');
  assert.strictEqual(cell, TODAY);
});

test('a one-time deadline survives the round-trip', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'once', title: 'Hujjat topshirish', deadlineKey: '2026-08-12', deadlineTime: '17:00'
  });

  const stored = gas.readTaskRows_(doc).find(t => t.id === task.id);
  assert.strictEqual(stored.deadlineKey, '2026-08-12');
  assert.strictEqual(stored.deadlineTime, '17:00');

  gas.materializeTaskOccurrences_(doc, stored, FIXED_NOW);
  const occ = gas.readOccurrenceRows_(doc)[0];
  assert.strictEqual(occ.dateKey, '2026-08-12');
  assert.strictEqual(occ.dueAt, gas.taskInstantMs_('2026-08-12', '17:00'));
});

test('an occurrence Date_Key survives and stays unique', () => {
  const { gas, doc } = fresh();
  const task = makeTask(gas, {
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' }
  });

  gas.materializeTaskOccurrences_(doc, gas.readTaskRows_(doc)[0], FIXED_NOW);
  const first = gas.readOccurrenceRows_(doc);
  assert.strictEqual(first[0].dateKey, TODAY);

  gas.materializeTaskOccurrences_(doc, gas.readTaskRows_(doc)[0], FIXED_NOW);
  const second = gas.readOccurrenceRows_(doc);
  assert.strictEqual(second.length, first.length, 'a second pass creates nothing new');

  const keys = second.map(o => o.dateKey);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate date keys');
  assert.ok(task.id);
});

test('a routine materialises exactly its horizon under coercion', () => {
  const { gas, doc } = fresh();
  makeTask(gas, { type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' } });
  gas.materializeTaskOccurrences_(doc, gas.readTaskRows_(doc)[0], FIXED_NOW);

  // Today plus TASK_GENERATION_HORIZON_DAYS ahead, inclusive.
  assert.strictEqual(gas.readOccurrenceRows_(doc).length, gas.TASK_GENERATION_HORIZON_DAYS + 1);
  assert.strictEqual(gas.readOccurrenceRows_(doc).length, 15);
});

test('the Today view is not flooded when the sheet coerces', () => {
  const { gas, doc } = fresh();
  makeTask(gas, {
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' }, dueTime: '20:00'
  });
  gas.materializeTaskOccurrences_(doc, gas.readTaskRows_(doc)[0], FIXED_NOW);

  assert.strictEqual(gas.buildTaskViews_(doc, FIXED_NOW).counts.dueToday, 1);
});

// ------------------------------------------------ healing rows written before

test('a Date_Key that was already coerced by an older write still reads', () => {
  const { gas, doc } = fresh();
  // Seed the sheet the way a pre-fix write left it: a real Date in Date_Key.
  const header = gas.TASK_OCC_HEADER;
  const row = header.map(() => '');
  row[header.indexOf('ID')] = 'occ_legacy';
  row[header.indexOf('Task_ID')] = 'task_legacy';
  row[header.indexOf('Task_Type')] = 'routine';
  row[header.indexOf('Title')] = 'Eski qator';
  row[header.indexOf('Date_Key')] = new Date(2026, 7, 10);
  row[header.indexOf('Status')] = 'Open';
  doc.insertSheet('Task_Occurrences');
  doc.sheets['Task_Occurrences'].data.push(header.slice(), row);

  const rows = gas.readOccurrenceRows_(doc);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].dateKey, TODAY);
  assert.strictEqual(gas.occurrenceFromRow_(row).dateKey, TODAY);
});

test('a Start_Key that was already coerced still drives recurrence', () => {
  const { gas, doc } = fresh();
  const header = gas.TASKS_HEADER;
  const row = header.map(() => '');
  row[header.indexOf('ID')] = 'task_legacy';
  row[header.indexOf('Type')] = 'routine';
  row[header.indexOf('Title')] = 'Eski muntazam';
  row[header.indexOf('Recurrence_JSON')] = JSON.stringify({ freq: 'daily', interval: 1 });
  row[header.indexOf('Start_Key')] = new Date(2026, 7, 10);
  row[header.indexOf('Status')] = 'active';
  doc.insertSheet('Tasks');
  doc.sheets['Tasks'].data.push(header.slice(), row);

  const task = gas.readTaskRows_(doc)[0];
  assert.strictEqual(task.startKey, TODAY);

  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  const keys = gas.readOccurrenceRows_(doc).map(o => o.dateKey).sort();
  assert.strictEqual(keys[0], TODAY);
  assert.strictEqual(keys[keys.length - 1], '2026-08-24');
  assert.strictEqual(keys.length, 15);
});

test('a rewritten row heals its own cells', () => {
  const { gas, doc } = fresh();
  const header = gas.TASK_OCC_HEADER;
  const row = header.map(() => '');
  row[header.indexOf('ID')] = 'occ_legacy';
  row[header.indexOf('Task_ID')] = 'task_legacy';
  row[header.indexOf('Task_Type')] = 'routine';
  row[header.indexOf('Title')] = 'Eski qator';
  row[header.indexOf('Date_Key')] = new Date(2026, 7, 10);
  row[header.indexOf('Status')] = 'Open';
  doc.insertSheet('Task_Occurrences');
  doc.sheets['Task_Occurrences'].data.push(header.slice(), row);

  const occ = gas.readOccurrenceRows_(doc)[0];
  assert.notStrictEqual(typeof rawCell(gas, 'Task_Occurrences', 'TASK_OCC_HEADER', 1, 'Date_Key'), 'string');

  gas.writeOccurrenceRow_(doc, occ);

  const healed = rawCell(gas, 'Task_Occurrences', 'TASK_OCC_HEADER', 1, 'Date_Key');
  assert.strictEqual(typeof healed, 'string');
  assert.strictEqual(healed, TODAY);
});

// ---------------------------------------------------------- no drift at all

test('coercion on behaves identically to coercion off', () => {
  function run(coerce) {
    const gas = loadScript({ coerceLikeSheets: coerce });
    const doc = gas.__spreadsheet;
    const task = makeTask(gas, {
      type: 'routine', title: 'Kassa', startKey: TODAY, endKey: '2026-08-20',
      recurrence: { freq: 'weekly', weekdays: [1] }, dueTime: '20:00'
    });
    gas.materializeTaskOccurrences_(doc, gas.readTaskRows_(doc)[0], FIXED_NOW);
    const view = gas.buildTaskViews_(doc, FIXED_NOW);
    return {
      keys: gas.readOccurrenceRows_(doc).map(o => o.dateKey),
      counts: view.counts,
      type: task.type
    };
  }
  // Serialised, because the two runs are built in separate VM realms and so
  // never share an Object prototype.
  assert.strictEqual(JSON.stringify(run(true)), JSON.stringify(run(false)));
});
