'use strict';

// ==========================================================
// ✅ Vazifalar
// ----------------------------------------------------------
// The same task engine the /tasks board and the Telegram cards use. Nothing
// here schedules a reminder, materialises an occurrence or decides whether a
// completion was on time - every action goes to runTaskAction_ and the server
// returns the rebuilt view, so the two surfaces cannot disagree.
// ==========================================================

const TASK_FILTERS = [
    { key: 'dueToday', label: 'Bugun' },
    { key: 'overdue', label: 'Muddati o’tgan' },
    { key: 'upcoming', label: 'Keyingi' },
    { key: 'waitingProof', label: 'Rasm kutilmoqda' },
    { key: 'completedToday', label: 'Bajarilgan' }
];

let taskFilter = 'dueToday';

function renderTasks() {
    const host = document.getElementById('tab-tasks');
    if (!state.tasks) { host.innerHTML = skeleton(4); return; }

    const view = state.tasks;
    // buildTaskViews_ returns the lists under `today` and the totals under
    // `counts`, and calls the due-today list `needsAttention`. Reading
    // view[key] straight off the root -- which is what this did -- found
    // nothing at all, so every tab was empty and every count read 0.
    const lists = view.today || {};
    const listFor = key => lists[key === 'dueToday' ? 'needsAttention' : key] || [];
    const counts = key => (view.counts && view.counts[key] !== undefined)
        ? view.counts[key]
        : listFor(key).length;

    host.innerHTML = `
        <div class="between" style="margin-bottom:12px">
            <h1>Vazifalar</h1>
            <button class="btn-primary btn-sm" onclick="openTaskSheet()">+ Yangi</button>
        </div>

        <div class="seg" role="tablist">
            ${TASK_FILTERS.map(f => `
                <button role="tab" aria-selected="${taskFilter === f.key}"
                        onclick="setTaskFilter('${f.key}')">${escapeHtml(f.label)} ${counts(f.key)}</button>`).join('')}
        </div>

        <div class="card list" style="margin-top:10px">${occurrenceRows(listFor(taskFilter))}</div>

        ${routineSection(view)}
        ${goalSection(view)}
    `;
}

function setTaskFilter(key) {
    taskFilter = key;
    haptic();
    renderTasks();
}

function priorityPill(priority) {
    if (priority === 'urgent') return '<span class="pill debt">Shoshilinch</span>';
    if (priority === 'high') return '<span class="pill warn">Muhim</span>';
    return '';
}

function occurrenceRows(list) {
    if (!list.length) return emptyRow("Bu ro'yxat bo'sh");
    return list.map(o => {
        const done = o.status === 'Completed';
        const clock = dueClock(o.dueLabel);
        const actions = done
            ? `<button class="btn-sm" onclick="taskAction('reopen_occurrence','${escapeHtml(o.id)}')">Qaytarish</button>`
            : `<button class="btn-sm btn-primary" onclick="taskAction('complete_occurrence','${escapeHtml(o.id)}')">Bajarildi</button>
               <button class="btn-sm" onclick="taskAction('skip_occurrence','${escapeHtml(o.id)}')">O'tkazish</button>`;
        return `
        <div class="item" style="flex-direction:column;align-items:stretch;gap:8px">
            <div class="row" style="align-items:flex-start">
                <div class="grow">
                    <p class="title">${escapeHtml(o.title)}</p>
                    <p class="tiny muted ellipsis">
                        ${o.dateKey ? shortDate(o.dateKey) : 'Sanasiz'}${clock ? ' · ' + escapeHtml(clock) : ''}${o.responsible ? ' · ' + escapeHtml(o.responsible) : ''}
                    </p>
                </div>
                ${priorityPill(o.priority)}
                ${o.displayStatus === 'Overdue' ? '<span class="pill debt">Kechikdi</span>' : ''}
                ${o.photoRequired ? '<span class="pill info">📷</span>' : ''}
            </div>
            <div class="row">${actions}
                <button class="btn-sm" onclick="openTaskSheet('${escapeHtml(o.taskId)}')" aria-label="Tahrirlash">✎</button>
            </div>
        </div>`;
    }).join('');
}

/**
 * "🔔 09:00, 18:00" — what a task will actually remind about, and when.
 *
 * Shown on the list rather than only inside the editor, because "did I set
 * that reminder?" is the question people open the app to answer.
 */
function reminderSummary(task) {
    const times = (task && task.reminderTimes) || [];
    if (!times.length) return '';
    const daily = task.type === 'once' && task.remindDaily ? ' (har kuni)' : '';
    return ` · 🔔 ${escapeHtml(times.join(', '))}${daily}`;
}

function routineSection(view) {
    const routines = (view.tasks || []).filter(t => t.type === 'routine');
    if (!routines.length) return '';
    return `
        <h2>Odatlar</h2>
        <div class="card list">
            ${routines.map(t => `
                <div class="item">
                    <div class="grow">
                        <p class="title ellipsis">${escapeHtml(t.title)}</p>
                        <p class="tiny muted">${t.status === 'paused' ? "To'xtatilgan" : 'Faol'}${(t.stats && t.stats.streak) ? ' · ' + t.stats.streak + ' kun' : ''}${(t.recurrenceLabel ? ' · ' + escapeHtml(t.recurrenceLabel) : '')}${reminderSummary(t)}</p>
                    </div>
                    <button class="btn-sm" onclick="openTaskSheet('${escapeHtml(t.id)}')" aria-label="Tahrirlash">✎</button>
                    <button class="btn-sm" onclick="taskAction('${t.status === 'paused' ? 'resume_routine' : 'pause_routine'}','','${escapeHtml(t.id)}')">
                        ${t.status === 'paused' ? 'Davom' : "To'xtatish"}
                    </button>
                </div>`).join('')}
        </div>`;
}

function goalSection(view) {
    const goals = (view.tasks || []).filter(t => t.type === 'goal');
    if (!goals.length) return '';
    return `
        <h2>Maqsadlar</h2>
        <div class="card list">
            ${goals.map(t => {
                const progress = t.progress || {};
                const total = Number(progress.total) || 0;
                const done = Number(progress.done) || 0;
                const percent = Number(progress.percent) || 0;
                return `
                <div class="item" style="flex-direction:column;align-items:stretch">
                    <div class="between">
                        <p class="title ellipsis">${escapeHtml(t.title)}</p>
                        <span class="pill info">${done}/${total}</span>
                    </div>
                    <div class="bar"><span style="width:${Math.max(2, percent)}%"></span></div>
                </div>`;
            }).join('')}
        </div>`;
}

// ------------------------------------------------------------------- actions

/** Occurrence-level actions take an occurrence; task-level ones take a task. */
const OCCURRENCE_ACTIONS = ['complete_occurrence', 'reopen_occurrence', 'skip_occurrence'];

async function taskAction(action, occurrenceId, taskId, extra) {
    haptic();
    // The engine names a task `id` and an occurrence `occurrenceId`. Sending
    // `taskId` for a task action meant pause, resume and cancel all came back
    // "Vazifa topilmadi"; the backend now maps it, and this sends both so an
    // older backend behaves too.
    const payload = Object.assign({
        taskAction: action,
        occurrenceId: OCCURRENCE_ACTIONS.indexOf(action) === -1 ? '' : (occurrenceId || ''),
        taskId: taskId || '',
        id: taskId || '',
        // The durable write and the occurrence bookkeeping are what this call
        // waits for. Scanning the schedules and pushing the group cards is
        // settled by `settleTasksInBackground` below, and by the five-minute
        // trigger if that request is lost. An older backend ignores the flag.
        deferReports: true
    }, extra || {});

    try {
        const body = await api('mini_task_action', payload);
        if (body.view) state.tasks = body.view;
        renderTasks();
        settleTasksInBackground();
        // A photo-required task is not finished by pressing a button: it moves
        // to "waiting" and the proof is asked for in the Tasks group, exactly
        // as it does from a group card.
        toast(body.awaitingProof ? (body.message || '📷 Rasm kutilmoqda') : 'Bajarildi');
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        // Skipping a future day is legitimate but has to be deliberate, so the
        // server refuses once and asks. Confirm and send the same action again.
        if (error.needsFutureConfirm) {
            const when = error.dateKey ? shortDate(error.dateKey) : '';
            if (await askConfirm(`${when} kuni o'tkazib yuborilsinmi?`)) {
                return taskAction(action, occurrenceId, taskId, { confirmFuture: true });
            }
            return;
        }
        toast(error.message, true);
    }
}

// ------------------------------------------------------------------ reminders
//
// Reminder times are stored, scheduled and displayed in **Asia/Tashkent**,
// which Uzbekistan has kept at a fixed UTC+5 since 1992. The engine does that
// arithmetic with epoch-millisecond maths (`16_tasks_recurrence.gs`) and never
// consults a host clock — so "09:00" means nine in the morning in Tashkent
// whatever timezone the phone is set to. The note under the field says so,
// because a `<input type="time">` looks local and nothing else would tell
// anybody otherwise.

const TASK_TIMEZONE_NOTE = "Barcha vaqtlar Toshkent vaqti (UTC+5)";

/** Uzbek weekday labels mapped to the engine's numbers (0 = Sunday). */
const MINI_WEEKDAYS = [['Du', 1], ['Se', 2], ['Chor', 3], ['Pay', 4], ['Jum', 5], ['Shan', 6], ['Yak', 0]];

/** One reminder row: a native time picker and a way to remove it. */
function addReminderTime(value) {
    const list = document.getElementById('tReminderList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.gap = '8px';
    row.innerHTML =
        `<input type="time" style="flex:1;min-width:0" value="${escapeHtml(value || '')}">` +
        '<button type="button" class="btn-sm" aria-label="Eslatmani o\'chirish" ' +
        'onclick="removeReminderTime(this)">✕</button>';
    list.appendChild(row);
    syncReminderControls();
    if (!value) {
        const input = row.querySelector('input');
        if (input) input.focus();
    }
}

function removeReminderTime(button) {
    const row = button.closest('.row');
    if (row) row.remove();
    syncReminderControls();
}

/** Every time entered, in the order shown. */
function reminderTimeValues() {
    const list = document.getElementById('tReminderList');
    if (!list) return [];
    return Array.from(list.querySelectorAll('input'))
        .map(input => String(input.value || '').trim())
        .filter(Boolean);
}

/**
 * Keeps the reminder block honest about what the backend will actually do.
 *
 * Three rules, all of them the engine's rather than this screen's:
 *
 *   * Reminders off means no times at all, so the list is hidden rather than
 *     left showing values that will be discarded.
 *   * "Har kuni" is a real choice only for a one-time task *with* a deadline:
 *     daily until it is done, or only on the deadline day. Without a deadline
 *     there is no deadline day to fall back on, so leaving it clear would mean
 *     the times fire never — the box is ticked and locked, and the note says why.
 *   * A routine's reminders belong to the day each occurrence was scheduled
 *     for, so there is nothing to choose; a goal's steps have no date at all
 *     and the server repeats theirs daily.
 */
function syncReminderControls() {
    const on = document.getElementById('tRemindOn');
    const block = document.getElementById('tReminderBlock');
    const empty = document.getElementById('tReminderEmpty');
    if (!on || !block) return;

    block.classList.toggle('hidden', !on.checked);
    const list = document.getElementById('tReminderList');
    if (empty && list) empty.classList.toggle('hidden', list.children.length > 0);

    const daily = document.getElementById('tRemindDaily');
    const dailyRow = document.getElementById('tRemindDailyRow');
    if (!daily || !dailyRow) return;

    const type = miniTaskFormType();
    const isOnce = type === 'once';
    dailyRow.classList.toggle('hidden', !isOnce);

    const deadline = document.getElementById('tDeadline');
    const locked = isOnce && !(deadline && deadline.value);
    if (locked) {
        // The admin's own answer is parked while the box is locked and handed
        // back when a deadline is typed, so ticking it automatically here can
        // never leave daily reminders switched on that nobody asked for.
        if (!daily.disabled) daily.dataset.chosen = daily.checked ? '1' : '0';
        daily.checked = true;
    } else if (daily.disabled) {
        daily.checked = daily.dataset.chosen === '1';
    }
    daily.disabled = locked;

    const note = document.getElementById('tRemindNote');
    if (note) {
        note.textContent = locked
            ? "Muddat yo'q — eslatma har kuni, vazifa bajarilguncha."
            : (isOnce
                ? "Belgilansa — har kuni, bajarilguncha. Aks holda faqat muddat kunida."
                : (type === 'routine'
                    ? "Eslatma har bir rejalashtirilgan kunda shu vaqtlarda yuboriladi."
                    : "Maqsad bosqichlari uchun eslatma har kuni takrorlanadi."));
    }
}

/** The type the form is editing: fixed on an edit, chosen on a create. */
function miniTaskFormType() {
    const field = document.getElementById('tType');
    if (field) return field.value;
    const stored = document.getElementById('tExistingType');
    return stored ? stored.value : 'once';
}

function onMiniTypeChange() {
    const routine = document.getElementById('tRoutineBlock');
    const once = document.getElementById('tOnceBlock');
    const type = miniTaskFormType();
    if (routine) routine.classList.toggle('hidden', type !== 'routine');
    if (once) once.classList.toggle('hidden', type !== 'once');
    syncReminderControls();
}

function onMiniFreqChange() {
    const freq = document.getElementById('tFreq');
    const weekdays = document.getElementById('tWeekdayRow');
    if (freq && weekdays) weekdays.classList.toggle('hidden', freq.value !== 'weekly');
}

/** Create, or edit when a task id is supplied. */
function openTaskSheet(taskId) {
    const existing = taskId
        ? ((state.tasks && state.tasks.tasks) || []).find(t => t.id === taskId)
        : null;

    const type = existing ? existing.type : 'once';
    const recurrence = (existing && existing.recurrence) || {};
    const reminderTimes = (existing && existing.reminderTimes) || [];

    openSheet(existing ? 'Vazifani tahrirlash' : 'Yangi vazifa', `
        <div class="task-editor-body">
        ${existing
            ? `<input type="hidden" id="tExistingType" value="${escapeHtml(type)}">
               <p class="tiny muted">Turi: ${escapeHtml(miniTypeLabel(type))} — o'zgartirib bo'lmaydi.</p>`
            : `
        <label for="tType">Turi</label>
        <select id="tType" onchange="onMiniTypeChange()">
            <option value="once">Bir martalik</option>
            <option value="routine">Takrorlanuvchi</option>
        </select>`}

        <label for="tTitle">Sarlavha</label>
        <input id="tTitle" autocomplete="off" value="${escapeHtml(existing ? existing.title : '')}">

        <label for="tDescription">Tavsif</label>
        <textarea id="tDescription">${escapeHtml(existing ? existing.description || '' : '')}</textarea>

        <div id="tOnceBlock" class="${type === 'once' ? '' : 'hidden'}">
            <label for="tDeadline">Muddat</label>
            <input id="tDeadline" type="date" onchange="syncReminderControls()"
                   value="${escapeHtml(existing ? existing.deadlineKey || '' : '')}">
        </div>

        <div id="tRoutineBlock" class="${type === 'routine' ? '' : 'hidden'}">
            ${existing
                ? `<p class="tiny muted">Takrorlanish: ${escapeHtml(existing.recurrenceLabel || 'har kuni')}.
                     O'zgartirish uchun to'liq boshqaruv panelidan foydalaning.</p>`
                : `
            <label for="tFreq">Takrorlanish</label>
            <select id="tFreq" onchange="onMiniFreqChange()">
                <option value="daily">Har kuni</option>
                <option value="weekly">Har hafta</option>
                <option value="monthly">Har oy</option>
            </select>
            <div id="tWeekdayRow" class="hidden">
                <label>Kunlar</label>
                <div class="row" style="flex-wrap:wrap;gap:6px">
                    ${MINI_WEEKDAYS.map(([label, wd]) =>
                        `<label class="mini-weekday"><input type="checkbox" class="mini-wd" data-wd="${wd}"> ${label}</label>`).join('')}
                </div>
            </div>`}
        </div>

        <label for="tPriority">Muhimlik</label>
        <select id="tPriority">
            ${['low', 'normal', 'high', 'urgent'].map(p =>
                `<option value="${p}" ${existing && existing.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>

        <label for="tResponsible">Mas'ul</label>
        <input id="tResponsible" autocomplete="off" value="${escapeHtml(existing ? existing.responsible || '' : '')}">

        <label class="task-toggle-row" style="margin-top:14px">
            <input type="checkbox" id="tRemindOn" onchange="syncReminderControls()"
                   ${reminderTimes.length ? 'checked' : ''}>
            <span>🔔 Eslatma yuborilsin</span>
        </label>

        <div id="tReminderBlock" class="${reminderTimes.length ? '' : 'hidden'}">
            <p class="tiny muted">${escapeHtml(TASK_TIMEZONE_NOTE)}</p>
            <div id="tReminderList" class="stack" style="margin-top:6px"></div>
            <p id="tReminderEmpty" class="tiny muted">Vaqt qo'shilmagan.</p>
            <button type="button" class="btn-sm" id="tReminderAdd" style="margin-top:6px"
                    onclick="addReminderTime()">＋ Vaqt qo'shish</button>

            <label id="tRemindDailyRow" class="task-toggle-row hidden" style="margin-top:10px">
                <input type="checkbox" id="tRemindDaily" onchange="syncReminderControls()"
                       ${existing && existing.remindDaily ? 'checked' : ''}>
                <span>Har kuni takrorlansin</span>
            </label>
            <p id="tRemindNote" class="tiny muted"></p>
        </div>
        </div>

        <div class="task-editor-actions">
        <button class="btn-primary btn-full" id="tSubmit"
                onclick="submitTask('${escapeHtml(taskId || '')}')">Saqlash</button>
        ${existing ? `<button class="btn-danger btn-full"
                onclick="cancelTask('${escapeHtml(taskId)}')">Bekor qilish</button>` : ''}
        </div>
    `);

    const taskSheet = document.querySelector('#sheetHost .sheet');
    if (taskSheet) taskSheet.classList.add('task-editor-sheet');

    // Prefilled after the sheet exists, so an edit opens on the task's *actual*
    // configuration rather than on a default that a save would then store.
    reminderTimes.forEach(time => addReminderTime(time));
    if (existing && type === 'routine') {
        const freq = document.getElementById('tFreq');
        if (freq) freq.value = recurrence.freq || 'daily';
    }
    const daily = document.getElementById('tRemindDaily');
    if (daily) daily.dataset.chosen = (existing && existing.remindDaily) ? '1' : '0';
    onMiniTypeChange();
}

function miniTypeLabel(type) {
    if (type === 'routine') return 'Takrorlanuvchi';
    if (type === 'goal') return 'Maqsad';
    return 'Bir martalik';
}

/** "9:05" typed by hand becomes "09:05"; a native picker already produces it. */
function normalizeReminderTimes(values) {
    return (values || []).map(value => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
        if (!match) return String(value).trim();   // let the server reject it
        return (match[1].length === 1 ? '0' + match[1] : match[1]) + ':' + match[2];
    });
}

async function submitTask(taskId) {
    const button = document.getElementById('tSubmit');
    const title = document.getElementById('tTitle').value.trim();
    if (!title) return toast('Sarlavha kiriting', true);

    const type = miniTaskFormType();
    const remindOn = document.getElementById('tRemindOn').checked;
    const times = remindOn ? normalizeReminderTimes(reminderTimeValues()) : [];
    if (remindOn && !times.length) return toast("Kamida bitta eslatma vaqtini kiriting", true);

    button.disabled = true;
    button.textContent = 'Saqlanmoqda...';
    try {
        const payload = {
            taskAction: 'save_task',
            deferReports: true,
            title,
            description: document.getElementById('tDescription').value.trim(),
            priority: document.getElementById('tPriority').value,
            responsible: document.getElementById('tResponsible').value.trim(),
            // Sent explicitly, and sent empty when reminders are switched off:
            // an absent field means "leave alone" to the engine, so omitting it
            // would make reminders impossible to turn back off from here.
            reminderTimes: times
        };
        // Only a one-time task gets to choose. A routine's reminders belong to
        // each scheduled day, and sending `remindDaily` for one would roll them
        // forward on to days it was never scheduled for.
        if (type === 'once') payload.remindDaily = document.getElementById('tRemindDaily').checked;

        if (taskId) {
            // An edit sends only the fields this sheet actually shows, and the
            // server keeps everything it is not told about -- so the cadence, the
            // start date, the photo rule and the end date all survive an edit
            // made here. A weekly routine used to come back daily.
            payload.taskId = taskId;
            payload.id = taskId;
            if (type === 'once') payload.deadlineKey = document.getElementById('tDeadline').value || '';
        } else {
            payload.type = type;
            if (type === 'once') {
                payload.deadlineKey = document.getElementById('tDeadline').value || '';
            } else {
                // A new routine needs a cadence. The engine's shape is
                // {freq, interval}; `{type:'daily'}` matched nothing and fell
                // through to the default.
                const freq = document.getElementById('tFreq');
                const recurrence = { freq: (freq && freq.value) || 'daily', interval: 1 };
                if (recurrence.freq === 'weekly') {
                    recurrence.weekdays = Array.from(document.querySelectorAll('.mini-wd'))
                        .filter(box => box.checked).map(box => Number(box.dataset.wd));
                }
                payload.recurrence = recurrence;
            }
        }

        const body = await api('mini_task_action', payload);
        if (body.view) state.tasks = body.view;
        closeSheet();
        renderTasks();
        toast('Saqlandi');
        settleTasksInBackground();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    } finally {
        button.disabled = false;
        button.textContent = 'Saqlash';
    }
}

async function cancelTask(taskId) {
    if (!await askConfirm('Vazifa bekor qilinsinmi?')) return;
    try {
        const body = await api('mini_task_action', {
            taskAction: 'cancel_task', taskId, id: taskId, deferReports: true
        });
        if (body.view) state.tasks = body.view;
        closeSheet();
        renderTasks();
        toast('Bekor qilindi');
        settleTasksInBackground();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    }
}

async function loadTasks() {
    try {
        const body = await api('mini_tasks');
        state.tasks = body.view;
        renderTasks();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    }
}
