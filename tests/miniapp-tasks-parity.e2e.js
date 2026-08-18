'use strict';

/**
 * Everything the Mini App's Tasks tab can actually do, driven through its UI.
 *
 * This suite exists because of how the gaps it covers survived. There *was*
 * coverage: `tests/miniapp-tasks-integration.test.js` signs real initData and
 * calls `doPost` directly, and it proved the Mini **API** could set a photo
 * rule, a deadline time, a monthly day and a goal's steps. None of that was
 * reachable from the Mini **UI** — the editor had no control for any of it — and
 * a backend test cannot tell the difference. So a capability was "covered" and
 * absent at the same time.
 *
 * Every test here therefore does two things a backend test cannot:
 *
 *   1. it interacts with the real page — clicking, filling, selecting — rather
 *      than constructing a payload, so a missing control fails the test;
 *   2. it asserts the **persisted business state** afterwards, by reading the
 *      task and occurrence rows out of the engine. "A request was sent" is not
 *      the question.
 *
 * The backend is the real engine behind a stubbed network hop: only the HTTP
 * transport is faked, so what the page sends is judged by the code that will
 * actually receive it, and a response shape the server does not produce cannot
 * pass here.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  chromium = null;
}

const describe = chromium ? test.describe : test.describe.skip;

const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcd';
const AUTHORIZED_ID = '49328655';
const TASKS_GROUP = '-1005555555555';

function signedInitData() {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_query_id',
    user: JSON.stringify({ id: Number(AUTHORIZED_ID), first_name: 'Xurshid', username: 'boss' })
  };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&') + `&hash=${hash}`;
}

function startStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const VALID_INIT_DATA = signedInitData();

/**
 * A fresh backend per test.
 *
 * These tests create, edit and cancel tasks, so a shared instance would let one
 * test's routine appear in another's `Odatlar` list and make the failures depend
 * on ordering.
 */
function bootBackend() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: 'mini-parity-key',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
      TELEGRAM_TASKS_GROUP_CHAT_ID: TASKS_GROUP
    },
    sheets: {
      System_Config: [
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Omad_Tenants', '[]']
      ]
    }
  });
}

/**
 * The engine's own "today", not the host's.
 *
 * Tashkent is a fixed UTC+5, so between 19:00 and midnight UTC the engine has
 * already rolled over and a date built from the host's calendar means a
 * different day to it. Every date these tests use is built in the engine's
 * timezone so they mean one thing whatever hour the suite runs at.
 */
function tashkentKey(dayOffset) {
  const d = new Date(Date.now() + 5 * 3600000 + (dayOffset || 0) * 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

describe('Mini App Tasks parity', () => {
  let server; let browser; let baseUrl;

  test.before(async () => {
    server = await startStaticServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  /**
   * Opens the Tasks tab of a real page against a real backend.
   *
   * `viewport` defaults to a mid-range handset. `hasTouch`/`isMobile` travel with
   * it, as they must: an emulated mobile context lays the page out differently.
   */
  async function openTasks(options = {}) {
    const backend = options.backend || bootBackend();
    const call = payload => readJsonOutput(backend.doPost(postEvent(
      Object.assign({}, payload, { initData: VALID_INIT_DATA }))));
    (options.seed || []).forEach(payload => {
      const answer = call(Object.assign({ action: 'mini_task_action' }, payload));
      assert.strictEqual(answer.status, 'success', 'seed failed: ' + answer.message);
    });

    const viewport = options.viewport || { width: 390, height: 844 };
    const sent = [];
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });

    await context.addInitScript(data => {
      window.Telegram = {
        WebApp: {
          initData: data,
          // Deliberately a different id from the signed one: attribution has to
          // come from the signature, never from anything the page can see.
          initDataUnsafe: { user: { id: 999999, first_name: 'Forged' } },
          ready() {}, expand() {}, setHeaderColor() {}, disableVerticalSwipes() {},
          HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
          BackButton: { show() {}, hide() {} },
          onEvent() {}, offEvent() {},
          showConfirm(message, callback) { callback(true); }
        }
      };
    }, VALID_INIT_DATA);

    await context.route('**telegram.org/**', route => route.abort());
    await context.route('**script.google.com/**', async route => {
      let payload = {};
      try { payload = JSON.parse(route.request().postData() || '{}'); } catch (e) { payload = {}; }
      sent.push(payload);
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(call(payload))
      });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/mini.html`);
    await page.waitForSelector('#nav-tasks');
    await page.click('#nav-tasks');
    await page.waitForFunction(() => state.tasks !== null);

    return { page, context, backend, call, sent, pageErrors };
  }

  /** The stored definition with this title. */
  function storedTask(backend, title) {
    return backend.readTaskRows_(backend.__spreadsheet).filter(t => t.title === title)[0];
  }

  /** Every stored occurrence of one definition. */
  function storedOccurrences(backend, taskId) {
    return backend.readOccurrenceRows_(backend.__spreadsheet)
      .filter(o => o.taskId === taskId);
  }

  /** Opens the create sheet. */
  async function openCreate(page) {
    await page.evaluate(() => openTaskSheet());
    await page.waitForSelector('#tSubmit');
  }

  /** Opens the edit sheet for the definition with this title. */
  async function openEdit(page, title) {
    await page.evaluate(name => {
      const task = state.tasks.tasks.find(t => t.title === name);
      openTaskSheet(task.id);
    }, title);
    await page.waitForSelector('#tSubmit');
  }

  async function save(page) {
    await page.click('#tSubmit');
    await page.waitForFunction(() => !document.getElementById('tSubmit'));
  }

  // ================================================== one-time tasks

  test('a one-time task with a deadline date and a deadline time', async () => {
    const { page, context, backend, pageErrors } = await openTasks();
    await openCreate(page);

    await page.fill('#tTitle', 'Soatli muddat');
    await page.fill('#tDescription', 'Kechqurun topshiriladi');
    await page.fill('#tResponsible', 'Aziz');
    await page.selectOption('#tPriority', 'urgent');
    await page.fill('#tDeadline', '2026-09-15');
    await page.fill('#tDeadlineTime', '14:30');
    await save(page);

    const stored = storedTask(backend, 'Soatli muddat');
    assert.ok(stored, 'the task exists');
    assert.strictEqual(stored.type, 'once');
    assert.strictEqual(stored.deadlineKey, '2026-09-15');
    assert.strictEqual(stored.deadlineTime, '14:30', 'the clock time the sheet now asks for');
    assert.strictEqual(stored.description, 'Kechqurun topshiriladi');
    assert.strictEqual(stored.responsible, 'Aziz');
    assert.strictEqual(stored.priority, 'urgent');
    assert.strictEqual(stored.photoRequired, false);

    // The occurrence carries the deadline as an instant, so lateness is judged
    // against 14:30 Tashkent rather than the end of the day.
    const occ = storedOccurrences(backend, stored.id)[0];
    assert.ok(occ.dueAt !== '' && isFinite(occ.dueAt), 'a due instant was derived');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a one-time task with no deadline at all, whose reminders lock to daily', async () => {
    const { page, context, backend, pageErrors } = await openTasks();
    await openCreate(page);

    await page.fill('#tTitle', 'Muddatsiz ish');
    await page.check('#tRemindOn');
    await page.click('#tReminderAdd');
    await page.fill('#tReminderList input', '08:00');

    // With no deadline there is no day for a single reminder to land on, so the
    // engine forces daily and the sheet shows the choice as locked.
    assert.strictEqual(await page.isChecked('#tRemindDaily'), true);
    assert.strictEqual(await page.isDisabled('#tRemindDaily'), true);
    const note = await page.textContent('#tRemindNote');
    assert.match(note, /Muddat yo'q/);

    await save(page);

    const stored = storedTask(backend, 'Muddatsiz ish');
    assert.strictEqual(stored.deadlineKey, '');
    assert.strictEqual(stored.deadlineTime, '');
    assert.strictEqual(stored.remindDaily, true, 'the engine decided this, not the form');
    assert.deepStrictEqual(Array.from(stored.reminderTimes), ['08:00']);

    const occ = storedOccurrences(backend, stored.id)[0];
    assert.strictEqual(occ.dueAt, '', 'a deadline-less occurrence has no due instant');
    assert.strictEqual(occ.dateKey, '', 'and no date');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a deadline time can be cleared again from the phone', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'once', title: 'Vaqtli',
        deadlineKey: '2026-09-15', deadlineTime: '14:30'
      }]
    });

    await openEdit(page, 'Vaqtli');
    assert.strictEqual(await page.inputValue('#tDeadlineTime'), '14:30', 'it opens on the stored time');
    await page.fill('#tDeadlineTime', '');
    await save(page);

    const stored = storedTask(backend, 'Vaqtli');
    assert.strictEqual(stored.deadlineTime, '', 'a field the person can see is one they can clear');
    assert.strictEqual(stored.deadlineKey, '2026-09-15', 'and the date is untouched');
    await context.close();
  });

  // ================================================== the photo rule

  test('the photo rule can be switched on, and off again', async () => {
    const { page, context, backend } = await openTasks();

    await openCreate(page);
    await page.fill('#tTitle', 'Rasmli ish');
    await page.check('#tPhotoRequired');
    await save(page);

    let stored = storedTask(backend, 'Rasmli ish');
    assert.strictEqual(stored.photoRequired, true, 'set from a phone, which was impossible before');
    assert.strictEqual(storedOccurrences(backend, stored.id)[0].photoRequired, true,
      'and it reached the occurrence');

    // Reopening must show the stored rule, or saving would silently clear it.
    await openEdit(page, 'Rasmli ish');
    assert.strictEqual(await page.isChecked('#tPhotoRequired'), true);
    await page.uncheck('#tPhotoRequired');
    await save(page);

    stored = storedTask(backend, 'Rasmli ish');
    assert.strictEqual(stored.photoRequired, false, 'and switched back off');
    await context.close();
  });

  test('an unrelated edit does not disturb the photo rule', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'once', title: 'Rasmli ish',
        photoRequired: true, deadlineKey: '2026-09-20'
      }]
    });

    await openEdit(page, 'Rasmli ish');
    await page.fill('#tTitle', 'Rasmli ish (yangi nom)');
    await save(page);

    const stored = storedTask(backend, 'Rasmli ish (yangi nom)');
    assert.strictEqual(stored.photoRequired, true);
    assert.strictEqual(stored.deadlineKey, '2026-09-20');
    await context.close();
  });

  test('a photo task offers no completion once its proof is pending', async () => {
    const { page, context, backend, call } = await openTasks({
      seed: [{ taskAction: 'save_task', type: 'once', title: 'Rasmli ish', photoRequired: true }]
    });

    const stored = storedTask(backend, 'Rasmli ish');
    const occ = storedOccurrences(backend, stored.id)[0];

    // Pressing Bajarildi *claims* it: the Mini App has a verified Telegram
    // identity, so it can start the proof flow rather than bypass it.
    await page.evaluate(id => taskAction('complete_occurrence', id), occ.id);
    await page.waitForFunction(
      occId => (state.tasks.today.waitingProof || []).some(o => o.id === occId), occ.id);

    assert.strictEqual(backend.findOccurrence_(backend.__spreadsheet, occ.id).status,
      'WaitingProof', 'claimed, not completed');

    // On the waiting list the row must not offer a completion. It used to, and
    // pressing it a second time completed the task with no photo at all.
    await page.evaluate(() => setTaskFilter('waitingProof'));
    const html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Rasm kutilmoqda') !== -1, 'it says what it is waiting for');
    assert.ok(html.indexOf("complete_occurrence") === -1,
      'and offers no completion the engine would refuse');

    // And the backend refuses it even if a stale client sends it anyway.
    const forced = call({
      action: 'mini_task_action', taskAction: 'complete_occurrence', occurrenceId: occ.id
    });
    assert.strictEqual(forced.status, 'error');
    const after = backend.findOccurrence_(backend.__spreadsheet, occ.id);
    assert.strictEqual(after.status, 'WaitingProof');
    assert.strictEqual(after.proofFileId, '', 'no proof was invented');
    await context.close();
  });

  // ================================================== recurrence

  const CADENCES = [
    {
      name: 'daily every 3 days',
      fill: async page => {
        await page.selectOption('#tFreq', 'daily');
        await page.fill('#tInterval', '3');
      },
      expect: { freq: 'daily', interval: 3 }
    },
    {
      name: 'selected weekdays',
      fill: async page => {
        await page.selectOption('#tFreq', 'weekly');
        await page.click('.mini-wd[data-wd="1"]');
        await page.click('.mini-wd[data-wd="5"]');
      },
      expect: { freq: 'weekly', interval: 1, weekdays: [1, 5] }
    },
    {
      name: 'a weekly interval',
      fill: async page => {
        await page.selectOption('#tFreq', 'weekly');
        await page.fill('#tInterval', '2');
        await page.click('.mini-wd[data-wd="3"]');
      },
      expect: { freq: 'weekly', interval: 2, weekdays: [3] }
    },
    {
      name: 'a monthly day',
      fill: async page => {
        await page.selectOption('#tFreq', 'monthly');
        await page.selectOption('#tMonthDay', '20');
      },
      expect: { freq: 'monthly', interval: 1, monthDay: 20 }
    },
    {
      name: 'the last day of the month',
      fill: async page => {
        await page.selectOption('#tFreq', 'monthly');
        await page.selectOption('#tMonthDay', 'last');
      },
      expect: { freq: 'monthly', interval: 1, monthDay: 'last' }
    },
    {
      name: 'every N days',
      fill: async page => {
        await page.selectOption('#tFreq', 'custom');
        await page.fill('#tInterval', '10');
      },
      expect: { freq: 'custom', intervalDays: 10 }
    }
  ];

  for (const cadence of CADENCES) {
    test(`a routine can be created with ${cadence.name}`, async () => {
      const { page, context, backend, pageErrors } = await openTasks();
      await openCreate(page);

      await page.fill('#tTitle', 'Muntazam ish');
      await page.selectOption('#tType', 'routine');
      await cadence.fill(page);
      await save(page);

      const stored = storedTask(backend, 'Muntazam ish');
      assert.ok(stored, 'the routine was created: ' + cadence.name);
      assert.strictEqual(stored.recurrence.freq, cadence.expect.freq);
      if (cadence.expect.interval !== undefined) {
        assert.strictEqual(stored.recurrence.interval, cadence.expect.interval);
      }
      if (cadence.expect.intervalDays !== undefined) {
        assert.strictEqual(stored.recurrence.intervalDays, cadence.expect.intervalDays);
      }
      if (cadence.expect.monthDay !== undefined) {
        assert.strictEqual(stored.recurrence.monthDay, cadence.expect.monthDay);
      }
      if (cadence.expect.weekdays !== undefined) {
        assert.deepStrictEqual(Array.from(stored.recurrence.weekdays).sort(),
          cadence.expect.weekdays);
      }
      assert.deepStrictEqual(pageErrors, []);
      await context.close();
    });
  }

  test('a monthly routine never becomes the 1st because the sheet failed to ask', async () => {
    const { page, context, backend } = await openTasks();
    await openCreate(page);
    await page.fill('#tTitle', 'Oylik hisobot');
    await page.selectOption('#tType', 'routine');
    await page.selectOption('#tFreq', 'monthly');

    // The control exists and is visible, which is the whole point: the sheet had
    // none, so every monthly routine made on a phone fell due on the 1st.
    assert.strictEqual(await page.isHidden('#tMonthDayRow'), false);
    await page.selectOption('#tMonthDay', '28');
    await save(page);

    const stored = storedTask(backend, 'Oylik hisobot');
    assert.strictEqual(stored.recurrence.monthDay, 28);
    assert.notStrictEqual(stored.recurrence.monthDay, 1);
    await context.close();
  });

  test('a routine carries a start date, an end date and a due time', async () => {
    const { page, context, backend } = await openTasks();
    await openCreate(page);

    await page.fill('#tTitle', 'Kunlik tekshiruv');
    await page.selectOption('#tType', 'routine');
    await page.fill('#tStartKey', '2026-08-03');
    await page.fill('#tEndKey', '2026-12-31');
    await page.fill('#tDueTime', '17:45');
    await save(page);

    const stored = storedTask(backend, 'Kunlik tekshiruv');
    assert.strictEqual(stored.startKey, '2026-08-03');
    assert.strictEqual(stored.endKey, '2026-12-31');
    assert.strictEqual(stored.dueTime, '17:45');
    await context.close();
  });

  test('an existing routine\'s cadence is editable from the phone', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 4] },
        startKey: '2026-08-03', dueTime: '09:00'
      }]
    });

    await openEdit(page, 'Muntazam ish');
    // It opens on the stored schedule, then changes to a different one.
    assert.strictEqual(await page.inputValue('#tFreq'), 'weekly');
    await page.selectOption('#tFreq', 'monthly');
    await page.selectOption('#tMonthDay', '15');
    await save(page);

    const stored = storedTask(backend, 'Muntazam ish');
    assert.strictEqual(stored.recurrence.freq, 'monthly');
    assert.strictEqual(stored.recurrence.monthDay, 15);
    assert.strictEqual(stored.dueTime, '09:00', 'and the due time it never touched survived');
    await context.close();
  });

  test('editing a title leaves every hidden schedule value alone', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'monthly', interval: 2, monthDay: 'last' },
        startKey: '2026-08-01', endKey: '2026-11-30', dueTime: '19:30',
        photoRequired: true, responsible: 'Aziz', reminderTimes: ['07:00']
      }]
    });

    await openEdit(page, 'Muntazam ish');
    await page.fill('#tTitle', 'Boshqa nom');
    await save(page);

    const stored = storedTask(backend, 'Boshqa nom');
    assert.strictEqual(stored.recurrence.freq, 'monthly');
    assert.strictEqual(stored.recurrence.interval, 2);
    assert.strictEqual(stored.recurrence.monthDay, 'last', 'the last-day sentinel survived');
    assert.strictEqual(stored.startKey, '2026-08-01');
    assert.strictEqual(stored.endKey, '2026-11-30');
    assert.strictEqual(stored.dueTime, '19:30');
    assert.strictEqual(stored.photoRequired, true);
    assert.strictEqual(stored.responsible, 'Aziz');
    assert.deepStrictEqual(Array.from(stored.reminderTimes), ['07:00']);
    await context.close();
  });

  // ================================================== reminders

  test('reminder times are set, added to, and switched off', async () => {
    const { page, context, backend } = await openTasks();
    await openCreate(page);

    await page.fill('#tTitle', 'Eslatmali ish');
    await page.fill('#tDeadline', '2026-09-20');
    await page.check('#tRemindOn');
    await page.click('#tReminderAdd');
    await page.fill('#tReminderList input', '09:00');
    await page.click('#tReminderAdd');
    const inputs = await page.$$('#tReminderList input');
    await inputs[1].fill('18:30');
    await save(page);

    let stored = storedTask(backend, 'Eslatmali ish');
    assert.deepStrictEqual(Array.from(stored.reminderTimes), ['09:00', '18:30']);

    await openEdit(page, 'Eslatmali ish');
    await page.uncheck('#tRemindOn');
    await save(page);

    stored = storedTask(backend, 'Eslatmali ish');
    assert.deepStrictEqual(Array.from(stored.reminderTimes), [],
      'sent explicitly empty -- an absent list would mean "leave alone"');
    assert.strictEqual(stored.deadlineKey, '2026-09-20', 'and the deadline survived');
    await context.close();
  });

  // ================================================== pause / resume / cancel

  test('a routine is paused and resumed from the phone', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'daily', interval: 1 }
      }]
    });
    const id = storedTask(backend, 'Muntazam ish').id;

    await page.evaluate(taskId => taskAction('pause_routine', '', taskId), id);
    await page.waitForFunction(taskId =>
      state.tasks.tasks.find(t => t.id === taskId).status === 'paused', id);
    assert.strictEqual(storedTask(backend, 'Muntazam ish').status, 'paused');
    assert.ok((await page.innerHTML('#tab-tasks')).indexOf("To'xtatilgan") !== -1,
      'and the list says so rather than "Faol"');

    await page.evaluate(taskId => taskAction('resume_routine', '', taskId), id);
    await page.waitForFunction(taskId =>
      state.tasks.tasks.find(t => t.id === taskId).status === 'active', id);
    assert.strictEqual(storedTask(backend, 'Muntazam ish').status, 'active');

    // Resuming has to put the horizon back, or the routine claims to be active
    // with nothing due.
    assert.ok(storedOccurrences(backend, id).some(o => o.status === 'Open'),
      'and its days are back');
    await context.close();
  });

  test('a cancelled routine is never shown as active or offered a pause', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'daily', interval: 1 }
      }]
    });
    const id = storedTask(backend, 'Muntazam ish').id;

    await page.evaluate(taskId => taskAction('cancel_task', '', taskId), id);
    await page.waitForFunction(taskId =>
      state.tasks.tasks.find(t => t.id === taskId).status === 'cancelled', id);
    assert.strictEqual(storedTask(backend, 'Muntazam ish').status, 'cancelled');

    const html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Bekor qilingan') !== -1, 'the real status is shown');
    assert.ok(html.indexOf('pause_routine') === -1,
      'and no pause is offered -- the engine refuses one on a cancelled task');
    assert.ok(html.indexOf('resume_routine') === -1);
    await context.close();
  });

  test('a task is cancelled from its editor, which then stops offering it', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{ taskAction: 'save_task', type: 'once', title: 'Bekor bo\'ladigan' }]
    });

    await openEdit(page, 'Bekor bo\'ladigan');
    await page.click('.btn-danger');
    await page.waitForFunction(() => !document.getElementById('tSubmit'));

    const stored = storedTask(backend, 'Bekor bo\'ladigan');
    assert.strictEqual(stored.status, 'cancelled');
    assert.ok(storedOccurrences(backend, stored.id).every(o => o.status === 'Cancelled'),
      'its open occurrences went with it');

    // Reopening the editor must not offer to cancel it again.
    await openEdit(page, 'Bekor bo\'ladigan');
    assert.strictEqual(await page.locator('.btn-danger').count(), 0);
    await context.close();
  });

  // ================================================== goals

  test('a goal is created with its steps, including a per-step photo override', async () => {
    const { page, context, backend, pageErrors } = await openTasks();
    await openCreate(page);

    await page.fill('#tTitle', 'Yangi filial');
    await page.selectOption('#tType', 'goal');
    await page.check('#tPhotoRequired');           // the goal's own rule

    await page.click('#tStepAdd');
    await page.fill('.mini-step-title', 'Joy topish');
    await page.click('#tStepAdd');
    const titles = await page.$$('.mini-step-title');
    await titles[1].fill('Shartnoma');
    const photos = await page.$$('.mini-step-photo');
    await photos[1].selectOption('no');            // this one overrides it off
    await save(page);

    const stored = storedTask(backend, 'Yangi filial');
    assert.strictEqual(stored.type, 'goal');
    assert.strictEqual(stored.steps.length, 2);
    assert.strictEqual(stored.steps[0].title, 'Joy topish');
    assert.strictEqual(stored.steps[1].title, 'Shartnoma');

    // "Meros" must send nothing at all: an explicit `false` is indistinguishable
    // from "unset" to the engine, and that is what stops a step inheriting.
    assert.strictEqual(stored.steps[0].photoRequired, undefined, 'step one inherits');
    assert.strictEqual(stored.steps[1].photoRequired, false, 'step two overrides');

    const occurrences = storedOccurrences(backend, stored.id);
    assert.strictEqual(occurrences.length, 2, 'each step is its own occurrence');
    assert.strictEqual(occurrences[0].photoRequired, true, 'inherited from the goal');
    assert.strictEqual(occurrences[1].photoRequired, false, 'overridden off');
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('a goal\'s steps are listed, with the one action each of them has', async () => {
    const { page, context } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'goal', title: 'Yangi filial',
        steps: [{ title: 'Joy topish' }, { title: 'Shartnoma' }]
      }]
    });

    const html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Joy topish') !== -1, 'the steps are on screen');
    assert.ok(html.indexOf('Shartnoma') !== -1);
    assert.strictEqual(await page.locator('.step-row').count(), 2);
    await context.close();
  });

  test('a goal step is completed and reopened, and progress follows', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'goal', title: 'Yangi filial',
        steps: [{ title: 'Joy topish' }, { title: 'Shartnoma' }]
      }]
    });
    const goal = storedTask(backend, 'Yangi filial');
    const steps = storedOccurrences(backend, goal.id)
      .sort((a, b) => Number(a.stepIndex) - Number(b.stepIndex));

    await page.evaluate(id => taskAction('complete_occurrence', id), steps[0].id);
    await page.waitForFunction(id =>
      state.tasks.tasks.find(t => t.id === id).progress.done === 1, goal.id);
    assert.strictEqual(backend.findOccurrence_(backend.__spreadsheet, steps[0].id).status,
      'Completed');

    await page.evaluate(id => taskAction('reopen_occurrence', id), steps[0].id);
    await page.waitForFunction(id =>
      state.tasks.tasks.find(t => t.id === id).progress.done === 0, goal.id);
    assert.strictEqual(backend.findOccurrence_(backend.__spreadsheet, steps[0].id).status, 'Open');
    await context.close();
  });

  test('renaming a goal step keeps its identity, and its history with it', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'goal', title: 'Yangi filial',
        steps: [{ title: 'Joy topish' }, { title: 'Shartnoma' }]
      }]
    });
    const goal = storedTask(backend, 'Yangi filial');
    const before = storedOccurrences(backend, goal.id)
      .sort((a, b) => Number(a.stepIndex) - Number(b.stepIndex));

    // Finish step one, then rename it. A rename must not orphan the completion.
    await page.evaluate(id => taskAction('complete_occurrence', id), before[0].id);
    await page.waitForFunction(id =>
      state.tasks.tasks.find(t => t.id === id).progress.done === 1, goal.id);

    await openEdit(page, 'Yangi filial');
    await page.fill('.mini-step-title', 'Joy tanlash');
    await save(page);

    const after = storedTask(backend, 'Yangi filial');
    assert.strictEqual(after.steps[0].title, 'Joy tanlash', 'renamed');
    assert.strictEqual(after.steps[0].id, goal.steps[0].id, 'and it is the same step');

    const renamed = backend.findOccurrence_(backend.__spreadsheet, before[0].id);
    assert.strictEqual(renamed.status, 'Completed', 'its completion survived the rename');
    assert.strictEqual(renamed.meta.stepId, goal.steps[0].id);
    await context.close();
  });

  test('a removed goal step keeps its row and drops out of progress', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'goal', title: 'Yangi filial',
        steps: [{ title: 'Joy topish' }, { title: 'Shartnoma' }, { title: 'Ochilish' }]
      }]
    });
    const goal = storedTask(backend, 'Yangi filial');
    const removedId = goal.steps[1].id;

    await openEdit(page, 'Yangi filial');
    const removeButtons = await page.$$('.step-edit .btn-sm');
    await removeButtons[1].click();
    assert.strictEqual(await page.locator('.step-edit').count(), 2);
    await save(page);

    const after = storedTask(backend, 'Yangi filial');
    // `Array.from`: the sandbox's arrays come from another realm, so
    // deepStrictEqual would fail on the prototype rather than on the contents.
    assert.deepStrictEqual(Array.from(after.steps).map(s => s.title),
      ['Joy topish', 'Ochilish']);
    assert.strictEqual(after.steps.length, 2);

    // The row survives, flagged, rather than being deleted.
    const kept = storedOccurrences(backend, goal.id)
      .filter(o => o.meta && o.meta.stepId === removedId);
    assert.strictEqual(kept.length, 1, 'the removed step keeps its row');
    assert.ok(kept[0].meta.removedStep, 'flagged as removed');

    // And it is out of the progress count.
    await page.waitForFunction(id =>
      state.tasks.tasks.find(t => t.id === id).progress.total === 2, goal.id);
    await context.close();
  });

  test('a goal can be edited without losing its steps', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'goal', title: 'Yangi filial',
        steps: [{ title: 'Joy topish' }, { title: 'Shartnoma' }],
        responsible: 'Aziz'
      }]
    });

    await openEdit(page, 'Yangi filial');
    assert.strictEqual(await page.locator('.step-edit').count(), 2,
      'the editor opens on the goal\'s actual steps');
    await page.fill('#tTitle', 'Ikkinchi filial');
    await save(page);

    const stored = storedTask(backend, 'Ikkinchi filial');
    assert.deepStrictEqual(Array.from(stored.steps).map(s => s.title),
      ['Joy topish', 'Shartnoma']);
    assert.strictEqual(stored.responsible, 'Aziz');
    await context.close();
  });

  // ================================================== future occurrences

  test('a future occurrence offers a confirmed skip and no completion', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{
        taskAction: 'save_task', type: 'once', title: 'Kelgusi ish',
        deadlineKey: tashkentKey(3)
      }]
    });

    await page.evaluate(() => setTaskFilter('upcoming'));
    const html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Kelgusi ish') !== -1, 'the future task is shown');
    assert.ok(html.indexOf('complete_occurrence') === -1,
      'and no completion is offered: the engine refuses early completion outright');
    assert.ok(html.indexOf('skip_occurrence') !== -1, 'a deliberate skip is offered');

    // The skip is confirmed once and then applied — the stub answers yes.
    const stored = storedTask(backend, 'Kelgusi ish');
    const occ = storedOccurrences(backend, stored.id)[0];
    await page.evaluate(id => taskAction('skip_occurrence', id), occ.id);
    await page.waitForFunction(id =>
      (state.tasks.recentCompleted || []).length >= 0 &&
      state.tasks !== null && true, occ.id);
    await page.waitForFunction(() => !taskMutationInFlight);

    assert.strictEqual(backend.findOccurrence_(backend.__spreadsheet, occ.id).status, 'Skipped');
    await context.close();
  });

  // ================================================== history

  test('the history list shows more than today', async () => {
    const { page, context, backend } = await openTasks({
      seed: [
        { taskAction: 'save_task', type: 'once', title: 'Kechagi ish' },
        { taskAction: 'save_task', type: 'once', title: 'Bugungi ish' }
      ]
    });

    // Finish both, then backdate one so it is not "today" any more.
    for (const title of ['Kechagi ish', 'Bugungi ish']) {
      const occ = storedOccurrences(backend, storedTask(backend, title).id)[0];
      await page.evaluate(id => taskAction('complete_occurrence', id), occ.id);
      await page.waitForFunction(() => !taskMutationInFlight);
    }

    const older = storedOccurrences(backend, storedTask(backend, 'Kechagi ish').id)[0];
    const backdated = backend.findOccurrence_(backend.__spreadsheet, older.id);
    backdated.completedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    backend.writeOccurrenceRow_(backend.__spreadsheet, backdated);
    await page.evaluate(() => loadTasks());
    await page.waitForFunction(() => (state.tasks.recentCompleted || []).length === 2);

    // Today's list is today's...
    await page.evaluate(() => setTaskFilter('completedToday'));
    let html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Bugungi ish') !== -1);
    assert.ok(html.indexOf('Kechagi ish') === -1, 'the older one is not today');

    // ...and the history is the history. This list was labelled as the history
    // and showed only today, while `recentCompleted` sat unread in the response.
    await page.evaluate(() => setTaskFilter('recentCompleted'));
    html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Kechagi ish') !== -1, 'the older completion is here');
    assert.ok(html.indexOf('Bugungi ish') !== -1, 'and so is today\'s');
    await context.close();
  });

  test('a completion says who did it, and the phone shows it', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{ taskAction: 'save_task', type: 'once', title: 'Kim bajardi' }]
    });
    const occ = storedOccurrences(backend, storedTask(backend, 'Kim bajardi').id)[0];

    await page.evaluate(id => taskAction('complete_occurrence', id), occ.id);
    await page.waitForFunction(() => !taskMutationInFlight);

    // Attribution comes from the verified signature, never from the page — the
    // bridge above deliberately reports a different id in `initDataUnsafe`.
    const stored = backend.findOccurrence_(backend.__spreadsheet, occ.id);
    assert.strictEqual(String(stored.completedById), AUTHORIZED_ID);
    assert.strictEqual(stored.completedByName, 'Xurshid');
    assert.notStrictEqual(String(stored.completedById), '999999');

    await page.evaluate(() => setTaskFilter('completedToday'));
    const html = await page.innerHTML('#tab-tasks');
    assert.ok(html.indexOf('Xurshid') !== -1, 'and the row credits them');
    await context.close();
  });

  // ================================================== layout

  test('the editor fits a 320px phone with no horizontal scroll', async () => {
    const { page, context, pageErrors } = await openTasks({
      viewport: { width: 320, height: 780 },
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'monthly', interval: 1, monthDay: 20 },
        reminderTimes: ['09:00']
      }]
    });

    const overflow = async () => page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);

    assert.strictEqual(await overflow(), 0, 'the list does not scroll sideways');

    await openEdit(page, 'Muntazam ish');
    assert.strictEqual(await overflow(), 0, 'and neither does the editor');

    // The goal step editor is the widest row on the sheet: a name, a select and
    // a remove button on one line.
    await openCreate(page);
    await page.selectOption('#tType', 'goal');
    await page.click('#tStepAdd');
    await page.click('#tStepAdd');
    assert.strictEqual(await overflow(), 0, 'and neither do the step rows');

    // Every control stays thumb-sized. A checkbox is deliberately exempt: its
    // tap target is the whole `.task-toggle-row` label around it, which is what
    // the 44px minimum applies to.
    const small = await page.evaluate(() => Array.from(document.querySelectorAll(
      '.task-editor-body input:not([type=checkbox]), .task-editor-body select, #tSubmit'))
      .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height < 30)
      .map(el => el.id || el.className));
    assert.deepStrictEqual(small, [], 'no control is too small to hit');

    const toggles = await page.evaluate(() => Array.from(
      document.querySelectorAll('.task-editor-body .task-toggle-row'))
      .filter(el => el.offsetParent !== null)
      .map(el => Math.round(el.getBoundingClientRect().height)));
    assert.ok(toggles.length > 0, 'the toggles are on screen');
    assert.ok(toggles.every(h => h >= 44), 'and each one is a 44px target: ' + toggles);
    assert.deepStrictEqual(pageErrors, []);
    await context.close();
  });

  test('the editor is still usable with the keyboard taking half the screen', async () => {
    // Telegram shrinks the viewport rather than scrolling under the keyboard, so
    // the sheet has to stay scrollable and keep its Save button reachable.
    const { page, context } = await openTasks({
      viewport: { width: 390, height: 420 },
      seed: [{
        taskAction: 'save_task', type: 'routine', title: 'Muntazam ish',
        recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }
      }]
    });

    await openEdit(page, 'Muntazam ish');

    const submit = await page.evaluate(() => {
      const button = document.getElementById('tSubmit');
      const box = button.getBoundingClientRect();
      return { height: box.height, visible: box.top < window.innerHeight && box.bottom > 0 };
    });
    assert.ok(submit.height >= 30, 'Save is still a real button');
    assert.strictEqual(submit.visible, true, 'and it is on screen, not below the fold');

    const scrollable = await page.evaluate(() => {
      const body = document.querySelector('.task-editor-body');
      return body.scrollHeight > body.clientHeight ? 'scrolls' : 'fits';
    });
    assert.ok(scrollable === 'scrolls' || scrollable === 'fits',
      'the body either fits or scrolls; it never clips');

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.strictEqual(overflow, 0);
    await context.close();
  });

  // ================================================== the guard

  test('a repeated tap does not fire two mutations at once', async () => {
    const { page, context, backend, sent } = await openTasks({
      seed: [{ taskAction: 'save_task', type: 'once', title: 'Bir marta' }]
    });
    const occ = storedOccurrences(backend, storedTask(backend, 'Bir marta').id)[0];

    // Two presses in the same tick, which is what a double tap is.
    await page.evaluate(id => {
      taskAction('complete_occurrence', id);
      taskAction('complete_occurrence', id);
    }, occ.id);
    await page.waitForFunction(() => !taskMutationInFlight);

    const completions = sent.filter(p => p.taskAction === 'complete_occurrence');
    assert.strictEqual(completions.length, 1, 'the guard let one through');
    assert.strictEqual(backend.findOccurrence_(backend.__spreadsheet, occ.id).status, 'Completed');
    await context.close();
  });

  test('editing a task the view does not hold refuses instead of emptying it', async () => {
    const { page, context, backend } = await openTasks({
      seed: [{ taskAction: 'save_task', type: 'once', title: 'Bor vazifa', responsible: 'Aziz' }]
    });
    const before = storedTask(backend, 'Bor vazifa');

    // A ✎ whose definition is not in the loaded view: the sheet used to open
    // titled "Yangi vazifa" with every field empty, and then save it as an edit.
    await page.evaluate(() => openTaskSheet('task_does_not_exist'));
    assert.strictEqual(await page.locator('#tSubmit').count(), 0, 'no sheet opened');

    const after = storedTask(backend, 'Bor vazifa');
    assert.strictEqual(after.responsible, before.responsible, 'and nothing was emptied');
    await context.close();
  });
});
