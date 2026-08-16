from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('mini.html', '''    input, select, textarea {
      font: inherit; font-size: 16px; width: 100%; min-height: 46px; padding: 10px 12px;
      border-radius: 12px; border: 1px solid var(--line);
      background: var(--bg); color: var(--text);
    }
    textarea { min-height: 76px; resize: vertical; }
    label { display: block; font-size: 12px; font-weight: 700; color: var(--muted); margin: 10px 0 4px; }
''', '''    input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea {
      font: inherit; font-size: 16px; width: 100%; min-height: 46px; padding: 10px 12px;
      border-radius: 12px; border: 1px solid var(--line);
      background: var(--bg); color: var(--text);
    }
    input[type="checkbox"], input[type="radio"] {
      width: 20px; min-width: 20px; height: 20px; min-height: 20px;
      flex: 0 0 20px; padding: 0; margin: 0; accent-color: var(--accent);
    }
    input[type="date"], input[type="time"] {
      display: block; min-width: 0; max-width: 100%;
    }
    input[type="date"]::-webkit-date-and-time-value,
    input[type="time"]::-webkit-date-and-time-value {
      text-align: left; min-height: 1.4em;
    }
    textarea { min-height: 76px; resize: vertical; }
    label { display: block; font-size: 12px; font-weight: 700; color: var(--muted); margin: 10px 0 4px; }

    .task-toggle-row {
      display: flex; align-items: center; gap: 10px; min-height: 44px;
      color: var(--text); font-size: 14px; font-weight: 600;
    }
    .task-toggle-row span { min-width: 0; }
    .mini-weekday {
      display: inline-flex; align-items: center; gap: 6px; min-height: 40px;
      margin: 0; padding: 8px 10px; border: 1px solid var(--line);
      border-radius: 10px; color: var(--text); font-size: 13px; font-weight: 600;
    }
''')

replace_once('mini.html', '''    .sheet .grabber {
      width: 40px; height: 4px; border-radius: 999px; background: var(--line);
      margin: 0 auto 12px;
    }
''', '''    .sheet .grabber {
      width: 40px; height: 4px; border-radius: 999px; background: var(--line);
      margin: 0 auto 12px;
    }

    /* The task editor is a long phone form. Keep its header/actions fixed
       inside the Telegram viewport and let only the fields scroll. */
    .task-editor-sheet {
      height: min(92dvh, calc(var(--tg-viewport-height, 100dvh) - 8px));
      max-height: min(92dvh, calc(var(--tg-viewport-height, 100dvh) - 8px));
      overflow: hidden; display: flex; flex-direction: column;
      padding-bottom: 0;
    }
    .task-editor-sheet > .grabber,
    .task-editor-sheet > .between { flex: 0 0 auto; }
    .task-editor-body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
      overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
      scroll-padding-bottom: 16px; padding: 0 1px 12px;
    }
    .task-editor-actions {
      flex: 0 0 auto; margin: 0 -16px;
      padding: 10px 16px calc(12px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--line); background: var(--bg);
    }
    .task-editor-actions .btn-full + .btn-full { margin-top: 8px; }
''')

replace_once('assets/mini/05-tasks.js', '''    openSheet(existing ? 'Vazifani tahrirlash' : 'Yangi vazifa', `
        ${existing
''', '''    openSheet(existing ? 'Vazifani tahrirlash' : 'Yangi vazifa', `
        <div class="task-editor-body">
        ${existing
''')

replace_once('assets/mini/05-tasks.js', '''                        `<label class="tiny"><input type="checkbox" class="mini-wd" data-wd="${wd}"> ${label}</label>`).join('')}
''', '''                        `<label class="mini-weekday"><input type="checkbox" class="mini-wd" data-wd="${wd}"> ${label}</label>`).join('')}
''')

replace_once('assets/mini/05-tasks.js', '''        <label class="row" style="gap:8px;margin-top:14px">
''', '''        <label class="task-toggle-row" style="margin-top:14px">
''')

replace_once('assets/mini/05-tasks.js', '''            <label id="tRemindDailyRow" class="row hidden" style="gap:8px;margin-top:10px">
''', '''            <label id="tRemindDailyRow" class="task-toggle-row hidden" style="margin-top:10px">
''')

replace_once('assets/mini/05-tasks.js', '''        </div>

        <button class="btn-primary btn-full" style="margin-top:14px" id="tSubmit"
''', '''        </div>
        </div>

        <div class="task-editor-actions">
        <button class="btn-primary btn-full" id="tSubmit"
''')

replace_once('assets/mini/05-tasks.js', '''        ${existing ? `<button class="btn-danger btn-full" style="margin-top:8px"
                onclick="cancelTask('${escapeHtml(taskId)}')">Bekor qilish</button>` : ''}
    `);
''', '''        ${existing ? `<button class="btn-danger btn-full"
                onclick="cancelTask('${escapeHtml(taskId)}')">Bekor qilish</button>` : ''}
        </div>
    `);
''')

replace_once('assets/mini/05-tasks.js', '''    // Prefilled after the sheet exists, so an edit opens on the task's *actual*
''', '''    const taskSheet = document.querySelector('#sheetHost .sheet');
    if (taskSheet) taskSheet.classList.add('task-editor-sheet');

    // Prefilled after the sheet exists, so an edit opens on the task's *actual*
''')

marker = "  test('every tappable control is at least 36px in both directions', async () => {\n"
addition = r'''  test('task create and edit sheets stay mobile-friendly at 320px', async () => {
    const { page, context } = await openMini('auth_date=1&hash=x', defaultHandlers);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForFunction(() => document.getElementById('miniTenantList'));
    await page.locator('#nav-tasks').click();
    await page.waitForFunction(() => document.getElementById('tab-tasks').innerText.includes('Bugungi ish'));

    await page.locator('#tab-tasks button:has-text("+ Yangi")').click();
    await page.waitForSelector('.task-editor-sheet #tSubmit');
    await page.selectOption('#tType', 'routine');
    await page.selectOption('#tFreq', 'weekly');
    await page.check('#tRemindOn');
    await page.click('#tReminderAdd');
    await page.fill('#tReminderList input[type="time"]', '09:00');

    const createLayout = await page.evaluate(() => {
      const sheet = document.querySelector('.task-editor-sheet');
      const body = sheet.querySelector('.task-editor-body');
      const actions = sheet.querySelector('.task-editor-actions');
      const sheetBox = sheet.getBoundingClientRect();
      const actionBox = actions.getBoundingClientRect();
      const checks = [...sheet.querySelectorAll('input[type="checkbox"]')]
        .filter(el => el.offsetParent !== null)
        .map(el => {
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height };
        });
      const time = sheet.querySelector('input[type="time"]').getBoundingClientRect();
      const remove = sheet.querySelector('#tReminderList button').getBoundingClientRect();
      return {
        sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        checks,
        timeRight: time.right,
        removeRight: remove.right,
        bodyRight: body.getBoundingClientRect().right,
        actionsTop: actionBox.top,
        actionsBottom: actionBox.bottom,
        sheetTop: sheetBox.top,
        sheetBottom: sheetBox.bottom
      };
    });

    assert.ok(createLayout.sheetOverflow <= 1, `create sheet overflows by ${createLayout.sheetOverflow}px`);
    assert.ok(createLayout.bodyOverflow <= 1, `create body overflows by ${createLayout.bodyOverflow}px`);
    assert.ok(createLayout.checks.length >= 8, 'toggle plus seven weekday checkboxes are visible');
    assert.deepEqual(createLayout.checks.filter(r => r.width < 18 || r.width > 24 || r.height < 18 || r.height > 24), []);
    assert.ok(createLayout.timeRight <= createLayout.bodyRight + 1, 'time picker stays inside the form');
    assert.ok(createLayout.removeRight <= createLayout.bodyRight + 1, 'remove button stays inside the form');
    assert.ok(createLayout.actionsTop >= createLayout.sheetTop - 1);
    assert.ok(createLayout.actionsBottom <= createLayout.sheetBottom + 1, 'save actions stay inside the sheet');

    // A shrinking viewport is the browser-level proxy for Telegram/iOS
    // making room for the keyboard. The action row must remain reachable.
    await page.focus('#tTitle');
    await page.setViewportSize({ width: 320, height: 360 });
    const compact = await page.evaluate(() => {
      const sheet = document.querySelector('.task-editor-sheet').getBoundingClientRect();
      const actions = document.querySelector('.task-editor-actions').getBoundingClientRect();
      return { sheetBottom: sheet.bottom, actionBottom: actions.bottom, viewport: innerHeight };
    });
    assert.ok(compact.sheetBottom <= compact.viewport + 1, 'sheet follows the dynamic viewport');
    assert.ok(compact.actionBottom <= compact.viewport + 1, 'save remains above the reduced viewport');

    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => closeSheet());
    await page.evaluate(() => {
      const task = state.tasks.tasks.find(t => t.title === 'Har kungi tekshiruv');
      openTaskSheet(task.id);
    });
    await page.waitForSelector('.task-editor-sheet #tSubmit');

    const editLayout = await page.evaluate(() => {
      const sheet = document.querySelector('.task-editor-sheet');
      const body = sheet.querySelector('.task-editor-body');
      const actions = sheet.querySelector('.task-editor-actions').getBoundingClientRect();
      const box = sheet.getBoundingClientRect();
      const toggle = sheet.querySelector('#tRemindOn').getBoundingClientRect();
      return {
        sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        toggleWidth: toggle.width,
        toggleHeight: toggle.height,
        actionsBottom: actions.bottom,
        sheetBottom: box.bottom
      };
    });
    assert.ok(editLayout.sheetOverflow <= 1, `edit sheet overflows by ${editLayout.sheetOverflow}px`);
    assert.ok(editLayout.bodyOverflow <= 1, `edit body overflows by ${editLayout.bodyOverflow}px`);
    assert.ok(editLayout.toggleWidth >= 18 && editLayout.toggleWidth <= 24);
    assert.ok(editLayout.toggleHeight >= 18 && editLayout.toggleHeight <= 24);
    assert.ok(editLayout.actionsBottom <= editLayout.sheetBottom + 1);

    await context.close();
  });

'''
p = Path('tests/miniapp-ui.e2e.js')
text = p.read_text()
if text.count(marker) != 1:
    raise SystemExit('tests/miniapp-ui.e2e.js: insertion marker missing or duplicated')
p.write_text(text.replace(marker, addition + marker, 1))
