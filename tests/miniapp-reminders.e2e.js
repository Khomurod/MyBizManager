'use strict';

/**
 * The Mini App's reminder controls, in a real browser.
 *
 * The sheet is the only place a reminder can be set from a phone, and the two
 * ways it can be wrong are both invisible to a unit test:
 *
 *   * opening an existing task on a *default* instead of on its own settings,
 *     so saving quietly rewrites what it was showing;
 *   * sending fields the sheet does not show, so editing a title turns a weekly
 *     routine daily.
 *
 * The backend here is the real engine behind a stubbed network hop, so what the
 * page sends is judged by the code that will actually receive it.
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

const backend = loadScript({
  properties: {
    OMAD_ADMIN_KEY: 'mini-reminder-key',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_AUTHORIZED_USER_ID: AUTHORIZED_ID,
    TELEGRAM_TASKS_GROUP_CHAT_ID: '-1005555555555'
  },
  sheets: {
    System_Config: [
      ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
      ['Omad_Tenants', '[]']
    ]
  }
});

const VALID_INIT_DATA = signedInitData();

function callBackend(payload) {
  return readJsonOutput(backend.doPost(postEvent(
    Object.assign({}, payload, { initData: VALID_INIT_DATA }))));
}

// A Monday/Thursday routine with two reminder times: the shape most at risk of
// being flattened by an editor that sends only what it shows.
callBackend({
  action: 'mini_task_action', taskAction: 'save_task',
  type: 'routine', title: 'Do\'konni tekshirish',
  recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 4] },
  startKey: '2026-08-03', endKey: '2026-12-31', dueTime: '18:00',
  photoRequired: true, reminderTimes: ['09:00', '18:30'], responsible: 'Aziz'
});
// A dated one-time task that is deliberately *not* daily.
callBackend({
  action: 'mini_task_action', taskAction: 'save_task',
  type: 'once', title: 'Hisobot', deadlineKey: '2026-09-15',
  reminderTimes: ['10:15'], remindDaily: false
});

describe('Mini App reminders', () => {
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

  async function openMini() {
    const sent = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

    await context.addInitScript(data => {
      window.Telegram = {
        WebApp: {
          initData: data,
          initDataUnsafe: { user: { id: 49328655, first_name: 'Xurshid' } },
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
        status: 200, contentType: 'application/json',
        body: JSON.stringify(readJsonOutput(backend.doPost(postEvent(payload))))
      });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${baseUrl}/mini.html`);
    await page.waitForSelector('#nav-tasks');
    await page.click('#nav-tasks');
    await page.waitForFunction(() => state.tasks && state.tasks.tasks.length > 0);
    return { page, context, sent, errors };
  }

  /** Opens the edit sheet for the task with this title. */
  async function openEditor(page, title) {
    await page.evaluate(name => {
      const task = state.tasks.tasks.find(t => t.title === name);
      openTaskSheet(task.id);
    }, title);
    await page.waitForSelector('#tSubmit');
  }

  test('the reminder field says which clock it means', async () => {
    const { page, context } = await openMini();
    await openEditor(page, 'Hisobot');
    const text = await page.textContent('#tReminderBlock');
    assert.match(text, /Toshkent vaqti \(UTC\+5\)/);
    await context.close();
  });

  test('editing a task opens on its own reminder settings', async () => {
    const { page, context } = await openMini();
    await openEditor(page, "Do'konni tekshirish");

    assert.strictEqual(await page.isChecked('#tRemindOn'), true, 'reminders are on');
    const times = await page.$$eval('#tReminderList input', els => els.map(e => e.value));
    assert.deepStrictEqual(times, ['09:00', '18:30'], 'both stored times, in order');

    // A routine's daily choice is not offered: each of its days owns its own
    // reminders.
    assert.strictEqual(await page.isHidden('#tRemindDailyRow'), true);

    // The cadence is editable here now, so the controls have to open on the
    // routine's *stored* schedule -- a default would be silently saved over it.
    // (This used to read "Takrorlanish: …" and send the person to the full
    // panel for an ordinary schedule change.)
    assert.strictEqual(await page.inputValue('#tFreq'), 'weekly');
    assert.strictEqual(await page.inputValue('#tInterval'), '1');
    const checkedDays = await page.$$eval('.mini-wd',
      els => els.filter(e => e.checked).map(e => Number(e.dataset.wd)));
    assert.deepStrictEqual(checkedDays.sort(), [1, 4], 'Monday and Thursday, as stored');
    assert.strictEqual(await page.inputValue('#tStartKey'), '2026-08-03');
    assert.strictEqual(await page.inputValue('#tEndKey'), '2026-12-31');
    assert.strictEqual(await page.inputValue('#tDueTime'), '18:00');
    assert.strictEqual(await page.isChecked('#tPhotoRequired'), true,
      'and the photo rule, which this sheet could not reach at all before');

    // Weekly means weekdays, not a month day.
    assert.strictEqual(await page.isHidden('#tMonthDayRow'), true);
    assert.strictEqual(await page.isHidden('#tWeekdayRow'), false);

    await context.close();
  });

  test('a dated one-time task keeps its own daily answer', async () => {
    const { page, context } = await openMini();
    await openEditor(page, 'Hisobot');

    assert.strictEqual(await page.isHidden('#tRemindDailyRow'), false, 'the choice is offered');
    assert.strictEqual(await page.isChecked('#tRemindDaily'), false, 'and it is the stored answer');
    assert.strictEqual(await page.isDisabled('#tRemindDaily'), false);

    // Clearing the deadline makes the choice meaningless, so it locks on.
    await page.fill('#tDeadline', '');
    await page.dispatchEvent('#tDeadline', 'change');
    assert.strictEqual(await page.isChecked('#tRemindDaily'), true);
    assert.strictEqual(await page.isDisabled('#tRemindDaily'), true);

    // ...and putting a deadline back hands the answer back rather than leaving
    // daily reminders switched on that nobody asked for.
    await page.fill('#tDeadline', '2026-09-15');
    await page.dispatchEvent('#tDeadline', 'change');
    assert.strictEqual(await page.isChecked('#tRemindDaily'), false);

    await context.close();
  });

  test('adding a second time sends both, and the routine stays weekly', async () => {
    const { page, context, sent } = await openMini();
    await openEditor(page, "Do'konni tekshirish");

    await page.click('#tReminderAdd');
    const inputs = await page.$$('#tReminderList input');
    await inputs[inputs.length - 1].fill('21:45');
    await page.click('#tSubmit');
    await page.waitForFunction(() => !document.getElementById('tSubmit'));

    const save = sent.filter(p => p.taskAction === 'save_task').pop();
    assert.ok(save, 'the save happened');
    assert.deepStrictEqual(save.reminderTimes, ['09:00', '18:30', '21:45']);
    // The cadence *is* resent now that the sheet shows it -- and because the
    // controls opened on the stored schedule, resending it stores the same
    // schedule back. A field the person can see is a field they can change; a
    // field they cannot see is one this payload must not carry.
    assert.deepStrictEqual(save.recurrence,
      { freq: 'weekly', interval: 1, weekdays: [1, 4] });
    assert.strictEqual(save.startKey, '2026-08-03');
    assert.strictEqual(save.endKey, '2026-12-31');
    assert.strictEqual(save.dueTime, '18:00');
    assert.strictEqual(save.photoRequired, true);
    assert.strictEqual(save.remindDaily, undefined, 'and a routine carries no daily flag');

    // The engine's own answer, not the form's: everything unmentioned survives.
    const stored = backend.readTaskRows_(backend.__spreadsheet)
      .filter(t => t.title === "Do'konni tekshirish")[0];
    assert.strictEqual(stored.recurrence.freq, 'weekly');
    assert.deepStrictEqual(Array.from(stored.recurrence.weekdays), [1, 4]);
    assert.strictEqual(stored.startKey, '2026-08-03');
    assert.strictEqual(stored.endKey, '2026-12-31');
    assert.strictEqual(stored.dueTime, '18:00');
    assert.strictEqual(stored.photoRequired, true);
    assert.deepStrictEqual(Array.from(stored.reminderTimes), ['09:00', '18:30', '21:45']);

    await context.close();
  });

  test('switching reminders off sends an empty list, which clears them', async () => {
    const { page, context, sent } = await openMini();
    await openEditor(page, 'Hisobot');

    await page.uncheck('#tRemindOn');
    await page.click('#tSubmit');
    await page.waitForFunction(() => !document.getElementById('tSubmit'));

    const save = sent.filter(p => p.taskAction === 'save_task').pop();
    assert.deepStrictEqual(save.reminderTimes, [],
      'explicitly empty -- an absent field would mean "leave alone"');

    const stored = backend.readTaskRows_(backend.__spreadsheet)
      .filter(t => t.title === 'Hisobot')[0];
    assert.deepStrictEqual(Array.from(stored.reminderTimes), []);
    assert.strictEqual(stored.deadlineKey, '2026-09-15', 'and the deadline survives');

    await context.close();
  });

  test('the list shows what a task will remind about', async () => {
    const { page, context } = await openMini();
    const text = await page.textContent('#tab-tasks');
    assert.match(text, /🔔/);
    await context.close();
  });

  test('the sheet raises no page error on open, edit or save', async () => {
    const { page, context, errors } = await openMini();
    await openEditor(page, "Do'konni tekshirish");
    await page.click('#tReminderAdd');
    await page.click('#tSubmit');
    await page.waitForFunction(() => !document.getElementById('tSubmit'));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });
});
