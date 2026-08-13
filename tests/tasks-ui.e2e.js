'use strict';

/**
 * End-to-end browser test for the /tasks UI.
 *
 * Runs the real tasks.html in Chromium with the Apps Script backend replaced by
 * an in-test mock, and asserts the page renders every tab, never calls Telegram
 * directly, and posts a well-formed save_task with the admin key.
 *
 * The second half is the mobile contract: /tasks is a phone-first page, so it
 * is checked at real handset widths (320-430px) for horizontal overflow,
 * reachable navigation, tap-target sizes, cards that survive long titles, a
 * create sheet that fits next to the keyboard, and chrome (bottom nav, FAB)
 * that never sits on top of content. The backend payloads are asserted at a
 * phone width too, because the redesign must not have changed what is sent.
 *
 * NOTE: the Tailwind CDN is stubbed out below, so every layout assertion here
 * exercises the page's own CSS - which is exactly where the app-shell layout
 * lives, and why it must not depend on the CDN arriving.
 *
 * Skipped automatically when Playwright is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** The board is reached with an omad_admin session, like every other page. */
const SESSION_TOKEN = 'e2e-session-token';

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }
const describe = chromium ? test.describe : test.describe.skip;

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

function mockView() {
  return {
    todayKey: '2026-08-10',
    nowLabel: '10.08.2026 09:00',
    today: {
      overdue: [{ id: 'o1', title: 'Muddati o\'tgan ish', displayStatus: 'Overdue', priority: 'high', responsible: 'Ali', dueLabel: '10.08.2026 08:00', photoRequired: false, lateLabel: '1h 0m' }],
      needsAttention: [{ id: 'o2', title: 'Bugungi ish', displayStatus: 'Open', priority: 'normal', dueLabel: '10.08.2026 20:00', photoRequired: true }],
      waitingProof: [], upcoming: [], completedToday: []
    },
    recentCompleted: [{ id: 'oc', title: 'Bajarilgan ish', displayStatus: 'Completed', priority: 'normal', completedByName: 'Vali', onTime: true, hasProof: true }],
    tasks: [
      { id: 't1', type: 'routine', title: 'Har kunlik hisobot', status: 'active', priority: 'normal', recurrenceLabel: 'Har kuni', reminderTimes: ['09:00'], stats: { streak: 3, completionRate: 80 }, todayOccurrence: { id: 'o2', displayStatus: 'Open' } },
      { id: 't2', type: 'goal', title: 'Yangi filial', status: 'active', progress: { done: 1, total: 2, percent: 50 }, steps: [{ title: 'Joy topish' }, { title: 'Ta\'mirlash' }], stepOccurrences: [{ id: 's1', title: 'Yangi filial — Joy topish', displayStatus: 'Completed' }, { id: 's2', title: 'Yangi filial — Ta\'mirlash', displayStatus: 'Open' }] }
    ],
    counts: { overdue: 1, dueToday: 1, waitingProof: 0, upcoming: 0, completedToday: 0 }
  };
}

describe('Tasks UI (browser)', () => {
  let server, browser, baseUrl;

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
   * @param {object} options
   * @param {boolean} options.withKey  seed sessionStorage with the admin key
   *        (default true). Without a session the board is not readable at all.
   * @param {object} options.view      override the mock view.
   * @param {object} options.viewport  {width, height} to emulate a handset.
   */
  async function open(options = {}) {
    const withKey = options.withKey !== false;
    const backendRequests = [];
    const telegramRequests = [];
    const context = await browser.newContext(
      options.viewport ? { viewport: options.viewport, hasTouch: true, isMobile: true } : {});
    await context.addInitScript((args) => {
      localStorage.setItem('omad_role', 'omad_admin');
      if (args.withKey) {
        localStorage.setItem('omad_session', args.key);
        localStorage.setItem('omad_session_expires', String(Date.now() + 86400000));
      }
    }, { key: SESSION_TOKEN, withKey });

    // Stub the render-blocking CDNs so the page loads without any network.
    await context.route('**cdn.tailwindcss.com**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await context.route('**cdnjs.cloudflare.com**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    await context.route('**://api.telegram.org/**', route => {
      telegramRequests.push(route.request().url());
      route.fulfill({ status: 200, body: '{"ok":true}' });
    });
    await context.route('**script.google.com/**', async route => {
      const req = route.request();
      let payload = {};
      if (req.method() === 'POST') { try { payload = JSON.parse(req.postData() || '{}'); } catch (e) { payload = {}; } }
      backendRequests.push(payload);
      let body = { status: 'success', view: options.view || mockView(), config: { tasksGroupConfigured: true } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push(String(err)));
    await page.goto(`${baseUrl}/tasks.html`);
    if (withKey) {
      await page.waitForFunction(() => typeof window.renderAllTasks === 'function');
      await page.waitForFunction(() => document.querySelector('#panel-today .card') !== null);
    }
    // Without a session the page redirects before its scripts finish, so
    // waiting for them here would be waiting for a page that is leaving.
    return { page, context, backendRequests, telegramRequests, consoleErrors };
  }

  test('the Today tab renders overdue and due-today items', async () => {
    const { page, context, backendRequests, telegramRequests, consoleErrors } = await open();
    const today = await page.textContent('#panel-today');
    assert.match(today, /Muddati o'tgan ish/);
    assert.match(today, /Bugungi ish/);

    const reads = backendRequests.filter(r => r.action === 'get_tasks');
    assert.ok(reads.length >= 1, 'the board was read');
    assert.strictEqual(reads[0].adminKey, undefined, 'no maintenance key is typed any more');
    assert.strictEqual(reads[0].sessionToken, SESSION_TOKEN, 'the read carries the session');

    assert.deepStrictEqual(telegramRequests, [], 'the browser never calls Telegram directly');
    assert.deepStrictEqual(consoleErrors, []);
    await context.close();
  });

  test('without a session the board sends the browser to the login page', async () => {
    const { page, context, backendRequests } = await open({ withKey: false });

    await page.waitForURL(/login\.html/, { timeout: 15000 });
    assert.deepStrictEqual(backendRequests.filter(r => r.action === 'get_tasks'), [],
      'nothing was requested without a session');
    await context.close();
  });

  test('the Routines and Goals tabs render their data', async () => {
    const { page, context } = await open();
    await page.click('[data-tab="routines"]');
    const routines = await page.textContent('#panel-routines');
    assert.match(routines, /Har kunlik hisobot/);
    assert.match(routines, /3 kun/); // streak

    await page.click('[data-tab="goals"]');
    const goals = await page.textContent('#panel-goals');
    assert.match(goals, /Yangi filial/);
    assert.match(goals, /50%/); // progress
    await context.close();
  });

  test('creating a task posts a well-formed save_task on the session', async () => {
    const { page, context, backendRequests } = await open();
    await page.click('button:has-text("+")');
    await page.waitForSelector('#taskModal:not(.hidden)');
    await page.fill('#fTitle', 'Yangi test vazifa');
    await page.selectOption('#fType', 'once');
    await page.click('#taskSaveBtn');

    await page.waitForFunction(() =>
      window.__lastSaves === undefined ? true : true);
    // Give the request a beat to be recorded.
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.ok(saves.length >= 1, 'a save_task was posted');
    assert.strictEqual(saves[0].title, 'Yangi test vazifa');
    assert.strictEqual(saves[0].type, 'once');
    assert.strictEqual(saves[0].sessionToken, SESSION_TOKEN);
    await context.close();
  });

  test('editing a task locks the type select', async () => {
    const { page, context, backendRequests } = await open();
    await page.click('[data-tab="routines"]');
    await page.click('button:has-text("Tahrirlash")');
    await page.waitForSelector('#taskModal:not(.hidden)');

    assert.strictEqual(await page.isDisabled('#fType'), true, 'the type cannot be changed');
    assert.strictEqual(await page.isVisible('#typeLockNote'), true);

    await page.click('#taskSaveBtn');
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.ok(saves.length >= 1);
    assert.strictEqual(saves[0].id, 't1');
    assert.strictEqual(saves[0].type, 'routine', 'the submitted type still matches the stored one');
    await context.close();
  });

  // ------------------------------------------------------------ mobile shell

  /** Real handset widths, narrowest first. 320 is the floor we support. */
  const PHONES = [320, 360, 375, 390, 430];

  /** A view designed to break a fragile layout: no spaces to wrap on. */
  function longTextView() {
    const view = mockView();
    const monster = 'Filialdagi kassa hisobotini tekshirish va tasdiqlash uchun juda uzun nomlanган vazifa';
    view.today.overdue = [{
      id: 'lo1', taskId: 't1', title: monster + ' ' + 'X'.repeat(60),
      displayStatus: 'Overdue', priority: 'urgent',
      responsible: 'Abdurahmonov Abdulhamidjon Abdulaziz' + 'o'.repeat(40),
      dueLabel: '10.08.2026 08:00', photoRequired: true, lateLabel: '3h 20m'
    }];
    view.today.needsAttention = [{
      id: 'lo2', taskId: 't1', title: 'A'.repeat(120), displayStatus: 'Open',
      priority: 'normal', responsible: 'B'.repeat(80), dueLabel: '10.08.2026 20:00',
      photoRequired: false
    }];
    return view;
  }

  /**
   * The page must never scroll sideways.
   *
   * Measured against documentElement.clientWidth, NOT window.innerWidth: in an
   * emulated mobile context Chromium widens the layout viewport to fit
   * overflowing content, so innerWidth grows with the overflow and comparing
   * against it would always pass. clientWidth stays at the device width.
   */
  async function horizontalOverflow(page) {
    return page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
      // The furthest right edge of anything laid out on the page.
      widest: Array.from(document.querySelectorAll('body *')).reduce((max, el) => {
        const box = el.getBoundingClientRect();
        return box.width ? Math.max(max, box.right) : max;
      }, 0)
    }));
  }

  for (const width of PHONES) {
    test(`the shell fits a ${width}px phone without horizontal overflow`, async () => {
      const { page, context, consoleErrors } = await open({
        viewport: { width, height: 780 }, view: longTextView()
      });

      const overflow = await horizontalOverflow(page);
      assert.strictEqual(overflow.viewport, width, 'the layout viewport is the device width');
      assert.ok(overflow.docScroll <= width + 1,
        `document scrolls sideways at ${width}px: ${overflow.docScroll} > ${width}`);
      assert.ok(overflow.bodyScroll <= width + 1,
        `body scrolls sideways at ${width}px: ${overflow.bodyScroll} > ${width}`);
      assert.ok(overflow.widest <= width + 1,
        `an element extends past the viewport at ${width}px: ${overflow.widest}`);

      // Long unbroken titles and names wrap inside the card.
      const card = await page.locator('#panel-today .card').first().boundingBox();
      assert.ok(card.width <= width, `a card is wider than the screen at ${width}px`);
      assert.ok(card.height > 80, 'the long title wrapped rather than being clipped to one line');

      assert.deepStrictEqual(consoleErrors, []);
      await context.close();
    });

    test(`bottom navigation is usable and clear of content at ${width}px`, async () => {
      const { page, context } = await open({ viewport: { width, height: 780 } });

      const nav = await page.locator('nav.nav').boundingBox();
      assert.ok(nav, 'the bottom navigation is present');
      assert.ok(nav.x >= 0 && nav.width <= width + 1, 'the nav sits inside the viewport');
      assert.ok(Math.abs((nav.y + nav.height) - 780) <= 1, 'the nav is pinned to the bottom');

      // All five destinations, each a comfortable tap target.
      const buttons = page.locator('nav.nav [data-tab]');
      assert.strictEqual(await buttons.count(), 5);
      for (let i = 0; i < 5; i++) {
        const box = await buttons.nth(i).boundingBox();
        assert.ok(box.height >= 44, `nav item ${i} is only ${box.height}px tall at ${width}px`);
        assert.ok(box.width >= 40, `nav item ${i} is only ${box.width}px wide at ${width}px`);
        assert.ok(box.x >= -0.5 && box.x + box.width <= width + 0.5,
          `nav item ${i} spills outside the screen at ${width}px`);
      }

      // The FAB floats above the nav, not on top of it.
      const fab = await page.locator('.fab').boundingBox();
      assert.ok(fab.y + fab.height <= nav.y + 1,
        `the FAB overlaps the bottom navigation at ${width}px`);
      assert.ok(fab.x + fab.width <= width, 'the FAB stays on screen');

      // Content scrolled to the bottom still clears the nav.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const lastBottom = await page.evaluate(() => {
        const cards = document.querySelectorAll('#panel-today .card, #panel-today .fold');
        const last = cards[cards.length - 1];
        return last ? last.getBoundingClientRect().bottom : 0;
      });
      const navTop = (await page.locator('nav.nav').boundingBox()).y;
      assert.ok(lastBottom <= navTop + 1,
        `the last card is hidden behind the nav at ${width}px (${lastBottom} > ${navTop})`);

      await context.close();
    });

    test(`tap targets and text are phone-sized at ${width}px`, async () => {
      const { page, context } = await open({ viewport: { width, height: 780 } });

      // The primary action on a card.
      const primary = page.locator('#panel-today .btn--primary').first();
      const box = await primary.boundingBox();
      assert.ok(box.height >= 44, `"Bajarildi" is only ${box.height}px tall at ${width}px`);
      assert.ok(box.width >= 100, 'the primary action is the dominant control');

      // Its secondary sibling is still tappable, just not dominant.
      const skip = await page.locator('#panel-today .btn--icon').first().boundingBox();
      assert.ok(skip.height >= 44 && skip.width >= 44,
        `the skip control is ${skip.width}x${skip.height} at ${width}px`);
      assert.ok(skip.width < box.width, 'skip is visually subordinate to Bajarildi');

      // Header controls are real buttons, not 10px text.
      for (const sel of ['.hdr__tools button', '.hdr__tools a']) {
        const tool = await page.locator(sel).boundingBox();
        assert.ok(tool.height >= 40 && tool.width >= 40,
          `${sel} is ${tool.width}x${tool.height} at ${width}px`);
      }

      // Card text is readable: prose at 13px+, short badge labels at 11px+.
      const fonts = await page.evaluate(() => {
        const min = sel => {
          let m = 99;
          document.querySelectorAll(sel).forEach(n => {
            m = Math.min(m, parseFloat(getComputedStyle(n).fontSize));
          });
          return m === 99 ? null : m;
        };
        return {
          title: min('#panel-today .t-title'),
          prose: Math.min(min('#panel-today .when'), min('#panel-today .meta span')),
          badge: min('#panel-today .badge'),
          action: min('#panel-today .btn')
        };
      });
      assert.ok(fonts.title >= 15, `titles are ${fonts.title}px at ${width}px`);
      assert.ok(fonts.prose >= 13, `card prose drops to ${fonts.prose}px at ${width}px`);
      // A normal-priority card carries no badge at all, which is the point.
      assert.ok(fonts.badge === null || fonts.badge >= 11,
        `badges drop to ${fonts.badge}px at ${width}px`);
      assert.ok(fonts.action >= 14, `action labels drop to ${fonts.action}px at ${width}px`);

      await context.close();
    });

    test(`the create sheet fits a ${width}px phone`, async () => {
      const { page, context } = await open({ viewport: { width, height: 780 } });
      await page.click('.fab');
      await page.waitForSelector('#taskModal:not(.hidden)');

      const sheet = await page.locator('#taskModal .sheet').boundingBox();
      assert.ok(sheet.x >= -0.5 && sheet.x + sheet.width <= width + 0.5,
        `the sheet spills sideways at ${width}px`);
      assert.ok(sheet.y + sheet.height <= 781, 'the sheet fits within the viewport height');

      // One column on a phone: the paired fields stack instead of squeezing.
      const columns = await page.evaluate(() =>
        getComputedStyle(document.querySelector('#taskModal .f-grid')).gridTemplateColumns.split(' ').length);
      assert.strictEqual(columns, 1, `paired inputs are side by side at ${width}px`);

      // Save is reachable without hunting for it, and full width.
      const save = await page.locator('#taskSaveBtn').boundingBox();
      assert.ok(save.height >= 44, 'Save is a comfortable target');
      assert.ok(save.y + save.height <= 781, 'Save is on screen without scrolling the sheet');
      assert.ok(save.width >= sheet.width - 40, 'Save spans the sheet');

      // Inputs are 16px, so focusing one does not make iOS zoom the page.
      const inputFont = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById('fTitle')).fontSize));
      assert.ok(inputFont >= 16, `inputs are ${inputFont}px, which triggers iOS auto-zoom`);

      const overflow = await horizontalOverflow(page);
      assert.ok(overflow.docScroll <= width + 1, 'the open sheet causes no sideways scroll');
      assert.ok(overflow.widest <= width + 1, 'no field extends past the viewport');

      await context.close();
    });
  }

  test('the sheet stays usable when the keyboard shrinks the viewport', async () => {
    // A 390px phone with the keyboard up leaves roughly this much height.
    const { page, context } = await open({ viewport: { width: 390, height: 420 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');

    const sheet = await page.locator('#taskModal .sheet').boundingBox();
    assert.ok(sheet.y + sheet.height <= 421, 'the sheet is bounded by the visible area');

    // Save stays pinned in the footer rather than scrolling away with the body.
    const save = await page.locator('#taskSaveBtn').boundingBox();
    assert.ok(save.y + save.height <= 421, 'Save is still on screen with the keyboard up');

    await page.locator('#taskModal .sheet__body').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const afterScroll = await page.locator('#taskSaveBtn').boundingBox();
    assert.ok(Math.abs(afterScroll.y - save.y) <= 1, 'Save does not move when the form scrolls');

    // The form body is what scrolls, and it has somewhere to scroll to.
    const scrollable = await page.locator('#taskModal .sheet__body')
      .evaluate(el => el.scrollHeight > el.clientHeight);
    assert.strictEqual(scrollable, true, 'the field list scrolls inside the sheet');

    await context.close();
  });

  test('every tab is reachable from the bottom navigation on a phone', async () => {
    const { page, context } = await open({ viewport: { width: 360, height: 780 } });

    for (const [tab, expected] of [['tasks', /Bir martalik|Bugungi ish/], ['routines', /Har kunlik hisobot/],
      ['goals', /Yangi filial/], ['completed', /Bajarilgan ish/], ['today', /Bugungi ish/]]) {
      await page.click(`nav.nav [data-tab="${tab}"]`);
      await page.waitForFunction(
        id => document.getElementById(id).classList.contains('active'), 'panel-' + tab);
      assert.match(await page.textContent('#panel-' + tab), expected, `${tab} panel rendered`);
      const active = await page.locator(`nav.nav [data-tab="${tab}"].active`).count();
      assert.strictEqual(active, 1, `${tab} is marked active in the nav`);
    }

    await context.close();
  });

  // ------------------------------------------------- payloads are unchanged

  test('a phone-width save sends exactly the same payload as before', async () => {
    const { page, context, backendRequests } = await open({ viewport: { width: 320, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');

    await page.fill('#fTitle', 'Yangi test vazifa');
    await page.fill('#fDesc', 'Izoh');
    await page.fill('#fResp', 'Ali');
    await page.selectOption('#fPriority', 'high');
    await page.check('#fPhoto');
    await page.selectOption('#fType', 'once');
    await page.fill('#fDeadlineDate', '2026-08-20');
    await page.fill('#fDeadlineTime', '17:30');

    // Reminders come from individual rows now, not a comma-separated string.
    await page.click('#reminderList ~ .rep__add');
    await page.locator('#reminderList input').nth(0).fill('09:00');
    await page.click('#reminderList ~ .rep__add');
    await page.locator('#reminderList input').nth(1).fill('14:00');

    await page.click('#taskSaveBtn');
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.strictEqual(saves.length, 1);
    const sent = saves[0];
    assert.strictEqual(sent.type, 'once');
    assert.strictEqual(sent.title, 'Yangi test vazifa');
    assert.strictEqual(sent.description, 'Izoh');
    assert.strictEqual(sent.responsible, 'Ali');
    assert.strictEqual(sent.priority, 'high');
    assert.strictEqual(sent.photoRequired, true);
    assert.strictEqual(sent.deadlineKey, '2026-08-20');
    assert.strictEqual(sent.deadlineTime, '17:30');
    assert.strictEqual(sent.remindDaily, false);
    assert.deepStrictEqual(sent.reminderTimes, ['09:00', '14:00'],
      'the repeater produces the same HH:MM array the text field used to');
    assert.strictEqual(sent.sessionToken, SESSION_TOKEN);
    assert.strictEqual(sent.id, undefined, 'a new task carries no id');

    await context.close();
  });

  // ------------------------------------------------- the daily-reminder rule

  test('the daily option says it repeats until the task is done', async () => {
    const { page, context } = await open({ viewport: { width: 375, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');
    await page.selectOption('#fType', 'once');
    await page.fill('#fDeadlineDate', '2026-08-20');

    // The old label ("Muddatsiz bo'lsa ham...") read as if daily reminders were
    // a deadline-less-only feature, which is exactly the bug this replaces.
    const label = (await page.textContent('#grpRemindDaily')).trim();
    assert.match(label, /Har kuni, vazifa bajarilguncha eslatilsin/);
    assert.ok(!/Muddatsiz bo'lsa ham/.test(label), 'the misleading wording is gone');

    // With a deadline the choice is real, so the alternative is spelled out.
    assert.ok(!(await page.locator('#remindDailyNote').isHidden()),
      'the deadline-only alternative is explained');
    assert.ok(await page.locator('#fRemindDaily').isEnabled(), 'and it is the user\'s to make');

    await context.close();
  });

  test('a deadline-less one-time task locks daily on, because nothing else would fire', async () => {
    const { page, context, backendRequests } = await open({ viewport: { width: 375, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');
    await page.fill('#fTitle', 'Muddatsiz ish');
    await page.selectOption('#fType', 'once');

    const box = page.locator('#fRemindDaily');
    assert.strictEqual(await box.isChecked(), true, 'checked with no deadline');
    assert.strictEqual(await box.isDisabled(), true, 'and not unsettable');
    assert.ok(!(await page.locator('#remindDailyLockNote').isHidden()), 'the reason is shown');

    // Typing a deadline hands the choice back.
    await page.fill('#fDeadlineDate', '2026-08-20');
    assert.strictEqual(await box.isDisabled(), false, 'a deadline restores the choice');
    assert.ok(await page.locator('#remindDailyLockNote').isHidden());
    await page.uncheck('#fRemindDaily');

    // Clearing it again locks it back on rather than silently sending nothing.
    await page.fill('#fDeadlineDate', '');
    assert.strictEqual(await box.isChecked(), true);

    await page.click('#reminderList ~ .rep__add');
    await page.locator('#reminderList input').nth(0).fill('09:00');
    await page.click('#taskSaveBtn');
    await page.waitForTimeout(300);

    const sent = backendRequests.filter(r => r.action === 'save_task')[0];
    assert.strictEqual(sent.remindDaily, true, 'the locked value is what is saved');
    assert.strictEqual(sent.deadlineKey, '');
    await context.close();
  });

  test('routines and goals are not offered the daily choice', async () => {
    const { page, context } = await open({ viewport: { width: 375, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');

    for (const type of ['routine', 'goal']) {
      await page.selectOption('#fType', type);
      assert.ok(await page.locator('#grpRemindDaily').isHidden(), type + ' hides the checkbox');
      assert.ok(await page.locator('#remindDailyNote').isHidden(), type + ' hides the hint');
      assert.ok(await page.locator('#remindDailyLockNote').isHidden(), type + ' hides the lock note');
    }
    // The goal keeps its own explanation, which is a statement not a choice.
    assert.ok(!(await page.locator('#goalRemindNote').isHidden()));

    await context.close();
  });

  test('goal steps are sent as the same array of titles', async () => {
    const { page, context, backendRequests } = await open({ viewport: { width: 375, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');

    await page.fill('#fTitle', 'Yangi filial');
    await page.selectOption('#fType', 'goal');

    // Switching to a goal offers one step row; add two more.
    await page.locator('#stepList input').nth(0).fill('Joy topish');
    await page.click('#grpGoal .rep__add');
    await page.locator('#stepList input').nth(1).fill('Ta\'mirlash');
    await page.click('#grpGoal .rep__add');
    await page.locator('#stepList input').nth(2).fill('Ishga tushirish');

    // An empty row must not become an empty step.
    await page.click('#grpGoal .rep__add');

    await page.click('#taskSaveBtn');
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].type, 'goal');
    assert.deepStrictEqual(saves[0].steps, ['Joy topish', 'Ta\'mirlash', 'Ishga tushirish']);

    await context.close();
  });

  test('a goal with no step is refused before any request is sent', async () => {
    const { page, context, backendRequests } = await open({ viewport: { width: 360, height: 780 } });
    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');
    await page.fill('#fTitle', 'Bo\'sh maqsad');
    await page.selectOption('#fType', 'goal');
    await page.click('#taskSaveBtn');
    await page.waitForTimeout(200);

    assert.deepStrictEqual(backendRequests.filter(r => r.action === 'save_task'), []);
    assert.match(await page.textContent('#taskFormMsg'), /bosqich/i);
    await context.close();
  });

  test('editing a routine prefills the reminder rows and resends them', async () => {
    const { page, context, backendRequests } = await open({ viewport: { width: 390, height: 780 } });
    await page.click('nav.nav [data-tab="routines"]');
    await page.click('button:has-text("Tahrirlash")');
    await page.waitForSelector('#taskModal:not(.hidden)');

    // The mock routine has one reminder at 09:00; it must arrive as a row.
    const values = await page.locator('#reminderList input').evaluateAll(
      els => els.map(e => e.value));
    assert.deepStrictEqual(values, ['09:00'], 'the stored reminder is shown as a row');

    await page.click('#taskSaveBtn');
    await page.waitForTimeout(300);

    const saves = backendRequests.filter(r => r.action === 'save_task');
    assert.strictEqual(saves[0].id, 't1');
    assert.strictEqual(saves[0].type, 'routine');
    assert.deepStrictEqual(saves[0].reminderTimes, ['09:00'],
      'an untouched reminder list round-trips unchanged');
    await context.close();
  });

  // ------------------------------------------------------------- desktop

  test('desktop keeps a readable measure and two-column pairs', async () => {
    const { page, context } = await open({ viewport: { width: 1280, height: 900 } });

    const panels = await page.locator('.panels').boundingBox();
    assert.ok(panels.width <= 780, 'content is not stretched across the whole desktop width');
    assert.ok(panels.x > 100, 'content is centred');

    await page.click('.fab');
    await page.waitForSelector('#taskModal:not(.hidden)');
    const columns = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#taskModal .f-grid')).gridTemplateColumns.split(' ').length);
    assert.strictEqual(columns, 2, 'paired inputs sit side by side on desktop');

    // The sheet becomes a centred dialog rather than staying bottom-anchored.
    const sheet = await page.locator('#taskModal .sheet').boundingBox();
    assert.ok(sheet.y > 20, 'the sheet is centred on desktop');
    assert.ok(sheet.width <= 560, 'the sheet keeps a dialog width');

    await context.close();
  });

  test('user zoom is not disabled', async () => {
    const { page, context } = await open();
    const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
    assert.ok(!/user-scalable\s*=\s*no/i.test(viewport), 'pinch-zoom must stay available');
    assert.ok(!/maximum-scale/i.test(viewport), 'maximum-scale blocks zoom on iOS');
    await context.close();
  });

  test('the upcoming section offers no completion button', async () => {
    const view = mockView();
    view.today.upcoming = [{
      id: 'up1', taskId: 't1', title: 'Kelgusi ish', displayStatus: 'Open',
      priority: 'normal', dueLabel: '15.08.2026', dateKey: '2026-08-15', photoRequired: false
    }];
    const { page, context } = await open({ view });

    const html = await page.innerHTML('#panel-today');
    assert.ok(html.includes('Kelgusi ish'), 'the upcoming item is shown');
    assert.ok(!html.includes("tasksCompleteOcc('up1')"), 'future work is not completable from the list');
    assert.ok(html.includes("tasksSkip('up1'"), 'it can still be skipped, with its date passed through');
    await context.close();
  });
});
