'use strict';

/**
 * Telegram task cards: the description is visible, and the HTML is safe.
 *
 * Invariants:
 *   * a task's description reaches the group card - as a plain line when it is
 *     short, and inside Telegram's <blockquote expandable> when it is long, so
 *     a busy group sees a scannable card and the full brief is one tap away;
 *   * cards are sent (and edited) with parse_mode HTML, and BOTH must use it -
 *     an edit that dropped it would show the markup as literal text;
 *   * because the cards are HTML, every interpolated value is escaped. A task
 *     titled "Ali & Vali <test>" would otherwise make Telegram reject the send
 *     with a 400, taking the whole card with it;
 *   * the description is budgeted on the RAW text before escaping, and the
 *     assembled message is length-checked, so nothing is ever cut mid-tag or
 *     mid-entity - which Telegram also rejects;
 *   * a finished card is about the outcome, not the brief, so it carries no
 *     description.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./gas-harness');

const VALID_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const TASKS_GROUP = '-1009998887777';
const FIXED_NOW = Date.UTC(2026, 7, 10, 4, 0, 0); // 2026-08-10 09:00 Asia/Tashkent
const TODAY = '2026-08-10';

const SHORT_DESC = "Kunlik kassa hisobotini to'ldirish.";
const LONG_DESC = 'Omborda barcha mahsulotlarni sanab chiqish kerak. ' +
  'Har bir pozitsiya uchun qoldiqni sanang, tizimdagi raqam bilan solishtiring ' +
  "va farq bo'lsa sababini yozib qoldiring. Sanash tugagach hisobotni rahbarga yuboring.";

function setup() {
  const gas = loadScript({
    properties: {
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP,
      OMAD_ADMIN_KEY: 'k'
    }
  });
  return { gas, doc: gas.__spreadsheet };
}

function makeTask(gas, doc, payload) {
  const result = gas.normalizeTaskInput_(payload, null);
  if (result.error) throw new Error(result.error);
  gas.appendTaskRow_(doc, result.task);
  gas.materializeTaskOccurrences_(doc, result.task, FIXED_NOW);
  return result.task;
}

/** Publishes the card and returns the sendMessage body that carried it. */
function publish(gas, doc, payload) {
  const task = makeTask(gas, doc, payload);
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);
  const card = sends(gas).find(m => /Yangi vazifa/.test(m.text));
  return { task, card, occ: Array.from(gas.readOccurrenceRows_(doc)).filter(o => o.taskId === task.id)[0] };
}

function sends(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/sendMessage') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

function edits(gas) {
  return gas.__fetchCalls
    .filter(c => c.url.indexOf('/editMessageText') !== -1)
    .map(c => JSON.parse(c.params.payload));
}

/**
 * Telegram rejects malformed HTML outright, so assert the shape of what we
 * built: tags balanced, no entity or tag left half-written, within the limit.
 */
function assertWellFormedHtml(gas, text) {
  const open = (text.match(/<blockquote expandable>/g) || []).length;
  const close = (text.match(/<\/blockquote>/g) || []).length;
  assert.strictEqual(open, close, 'blockquote tags are balanced');
  assert.ok(open <= 1, 'at most one description block');
  assert.ok(!/<[^>]*$/.test(text), 'the text does not end in a half-written tag');
  // Every & must begin one of the three entities escapeTelegramHtml_ produces.
  // A bare or truncated one means either unescaped input or a cut entity.
  const badAmp = /&(?!amp;|lt;|gt;)/.exec(text);
  assert.strictEqual(badAmp, null,
    'malformed entity at ' + (badAmp ? JSON.stringify(text.slice(badAmp.index, badAmp.index + 10)) : ''));
  assert.ok(text.length <= gas.TELEGRAM_MAX_TEXT_LENGTH,
    `message is ${text.length} chars, over the ${gas.TELEGRAM_MAX_TEXT_LENGTH} limit`);
  // The only markup we ever emit is the description blockquote.
  const tags = (text.match(/<[^>]+>/g) || []);
  tags.forEach(tag => assert.match(tag, /^<\/?blockquote( expandable)?>$/, 'unexpected tag ' + tag));
}

// ------------------------------------------------------------- description

test('a short description appears as a plain line on the card', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, {
    type: 'once', title: 'Cafe kirim va chiqishlari', responsible: '@diyor_020',
    deadlineKey: TODAY, description: SHORT_DESC
  });

  assert.ok(card, 'the card went out');
  assert.ok(card.text.indexOf('📝 ' + SHORT_DESC) !== -1, 'the description is on the card');
  assert.strictEqual(card.text.indexOf('<blockquote'), -1,
    'a short description is not worth collapsing');
  assertWellFormedHtml(gas, card.text);
});

test('a long description is collapsed into an expandable blockquote', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, {
    type: 'once', title: 'Oylik inventarizatsiya', deadlineKey: TODAY, description: LONG_DESC
  });

  assert.ok(LONG_DESC.length > gas.TASK_CARD_DESC_INLINE_MAX, 'the fixture is genuinely long');
  assert.ok(card.text.indexOf('<blockquote expandable>' + LONG_DESC + '</blockquote>') !== -1,
    'the whole description is inside one expandable quote');
  assertWellFormedHtml(gas, card.text);
});

test('a task with no description gets no description block', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, { type: 'once', title: 'Muddatsiz ish', deadlineKey: TODAY });

  assert.strictEqual(card.text.indexOf('📝'), -1);
  assert.strictEqual(card.text.indexOf('<blockquote'), -1);
  assertWellFormedHtml(gas, card.text);
  // The rest of the card is unchanged.
  assert.match(card.text, /📌 Muddatsiz ish/);
  assert.match(card.text, /📷 Rasm tasdiqi/);
});

test('a whitespace-only description is treated as absent', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, {
    type: 'once', title: 'Ish', deadlineKey: TODAY, description: '   \n  '
  });
  assert.strictEqual(card.text.indexOf('📝'), -1);
  assert.strictEqual(card.text.indexOf('<blockquote'), -1);
});

test('the reminder card carries the description too', () => {
  const { gas, doc } = setup();
  makeTask(gas, doc, {
    type: 'routine', title: 'Kassa', startKey: TODAY, recurrence: { freq: 'daily' },
    reminderTimes: ['08:00'], description: LONG_DESC
  });
  gas.runTaskScheduler_(doc, FIXED_NOW); // 09:00, so 08:00 has passed
  gas.processPendingJobs_(doc, 25);

  const reminder = sends(gas).find(m => /Eslatma/.test(m.text));
  assert.ok(reminder, 'a reminder went out');
  assert.strictEqual(reminder.parse_mode, 'HTML');
  assert.ok(reminder.text.indexOf('<blockquote expandable>') !== -1);
  assertWellFormedHtml(gas, reminder.text);
});

test('a goal step card carries the goal\'s description', () => {
  const { gas, doc } = setup();
  makeTask(gas, doc, { type: 'goal', title: 'Yangi filial', steps: ['Joy topish'], description: SHORT_DESC });
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  const card = sends(gas).find(m => /Yangi vazifa/.test(m.text));
  assert.match(card.text, /📌 Yangi filial — Joy topish/);
  assert.ok(card.text.indexOf('📝 ' + SHORT_DESC) !== -1);
});

// ------------------------------------------------------------- parse mode

test('cards are sent as HTML', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, {
    type: 'once', title: 'Ish', deadlineKey: TODAY, description: LONG_DESC
  });
  assert.strictEqual(card.parse_mode, 'HTML');
});

test('an edited card is still HTML, so no markup leaks as literal text', () => {
  const { gas, doc } = setup();
  const { occ } = publish(gas, doc, {
    type: 'once', title: 'Ish', deadlineKey: TODAY, description: LONG_DESC
  });

  const live = gas.findOccurrence_(doc, occ.id);
  gas.completeTaskOccurrence_(doc, live, { byId: 7, byName: 'Ali', source: 'telegram' });
  gas.processPendingJobs_(doc, 25);

  const edited = edits(gas);
  assert.ok(edited.length >= 1, 'the card was edited in place');
  edited.forEach(e => assert.strictEqual(e.parse_mode, 'HTML'));
});

// ---------------------------------------------------------------- escaping

test('HTML-special characters in every field are escaped', () => {
  const { gas, doc } = setup();
  const { card } = publish(gas, doc, {
    type: 'once', title: 'Ali & Vali <test>', responsible: 'A & B <boss>',
    deadlineKey: TODAY, description: '5 < 10 & <b>qalin</b>'
  });

  assert.ok(card.text.indexOf('Ali &amp; Vali &lt;test&gt;') !== -1, 'the title is escaped');
  assert.ok(card.text.indexOf('A &amp; B &lt;boss&gt;') !== -1, 'the responsible name is escaped');
  assert.ok(card.text.indexOf('5 &lt; 10 &amp; &lt;b&gt;qalin&lt;/b&gt;') !== -1,
    'the description is escaped, so injected markup renders as text');
  assert.strictEqual(card.text.indexOf('<b>'), -1, 'no caller-supplied tag survives');
  assertWellFormedHtml(gas, card.text);
});

test('a completed card is escaped and carries no description', () => {
  const { gas, doc } = setup();
  const { occ } = publish(gas, doc, {
    type: 'once', title: 'Ali & Vali <test>', deadlineKey: TODAY, description: LONG_DESC
  });

  const live = gas.findOccurrence_(doc, occ.id);
  const done = gas.completeTaskOccurrence_(doc, live, {
    byId: 7, byName: 'Bek & <script>', source: 'telegram'
  });

  const text = gas.buildTaskStatusMessage_(done, FIXED_NOW, LONG_DESC);
  assert.match(text, /✅ Bajarildi/);
  assert.ok(text.indexOf('Ali &amp; Vali &lt;test&gt;') !== -1);
  assert.ok(text.indexOf('Bek &amp; &lt;script&gt;') !== -1);
  assert.strictEqual(text.indexOf('<blockquote'), -1,
    'a finished card is about the outcome, not the brief');
  assertWellFormedHtml(gas, text);
});

test('the waiting-for-proof card is escaped', () => {
  const { gas } = setup();
  const text = gas.buildTaskStatusMessage_({
    status: gas.TASK_STATUS_WAITING, title: 'A & B', completedByName: '<b>Ali</b>',
    dueAt: '', dateKey: TODAY, photoRequired: true, priority: 'normal'
  }, FIXED_NOW);

  assert.ok(text.indexOf('A &amp; B') !== -1);
  assert.ok(text.indexOf('&lt;b&gt;Ali&lt;/b&gt;') !== -1);
  assertWellFormedHtml(gas, text);
});

// -------------------------------------------------------------- truncation

test('an oversized description is shrunk to fit, never cut mid-entity', () => {
  const { gas, doc } = setup();
  // Written straight to the sheet to get past the 2000-char input cap. "x&"
  // repeated is deliberate: escaped it becomes the 6-character "x&amp;", which
  // does NOT divide evenly into any of the description budgets, so a naive
  // clip of the escaped string lands mid-entity. A fixture of pure "&" would
  // hide that bug, because "&amp;" is 5 characters and every budget is a
  // multiple of 5.
  const header = gas.TASKS_HEADER;
  const row = header.map(() => '');
  row[header.indexOf('ID')] = 'task_huge';
  row[header.indexOf('Type')] = 'once';
  row[header.indexOf('Title')] = 'Katta tavsif';
  row[header.indexOf('Description')] = 'x&'.repeat(3000);
  row[header.indexOf('Status')] = 'active';
  doc.insertSheet('Tasks');
  doc.sheets.Tasks.data.push(header.slice(), row);

  const task = gas.readTaskRows_(doc)[0];
  gas.materializeTaskOccurrences_(doc, task, FIXED_NOW);
  gas.runTaskScheduler_(doc, FIXED_NOW);
  gas.processPendingJobs_(doc, 25);

  const card = sends(gas).find(m => /Yangi vazifa/.test(m.text));
  assert.ok(card, 'the card still went out');
  assertWellFormedHtml(gas, card.text);
  // Whatever survived is whole entities only (assertWellFormedHtml checks the
  // whole message; this pins the quote body itself).
  const inner = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(card.text);
  assert.ok(inner, 'the description was shrunk into a quote, not dropped');
  assert.ok(/^(x&amp;)+…?$/.test(inner[1]),
    'the quote holds only complete entities, ending: ' + JSON.stringify(inner[1].slice(-12)));
});

test('clipTaskText_ prefers a word boundary but still clips one long word', () => {
  const { gas } = setup();
  assert.strictEqual(gas.clipTaskText_('bir ikki uch', 100), 'bir ikki uch', 'short text is untouched');

  const wordy = gas.clipTaskText_('bir ikki uchinchi', 12);
  assert.ok(wordy.endsWith('…'));
  assert.ok(wordy.indexOf('uchinchi') === -1, 'a half word is dropped, not shown');
  assert.strictEqual(wordy, 'bir ikki…');

  const single = gas.clipTaskText_('x'.repeat(50), 10);
  assert.strictEqual(single, 'x'.repeat(10) + '…', 'no boundary to fall back to, so hard clip');

  assert.strictEqual(gas.clipTaskText_('   ', 10), '');
  assert.strictEqual(gas.clipTaskText_(null, 10), '');
});

test('the description block switches form exactly at the inline threshold', () => {
  const { gas } = setup();
  const atLimit = 'a'.repeat(gas.TASK_CARD_DESC_INLINE_MAX);
  const overLimit = 'a'.repeat(gas.TASK_CARD_DESC_INLINE_MAX + 1);

  assert.strictEqual(gas.taskCardDescriptionBlock_(atLimit), '📝 ' + atLimit);
  assert.strictEqual(gas.taskCardDescriptionBlock_(overLimit),
    '<blockquote expandable>' + overLimit + '</blockquote>');
  assert.strictEqual(gas.taskCardDescriptionBlock_(''), '');
});
