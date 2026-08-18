'use strict';

// ==========================================================
// ✅ Vazifalar
// ----------------------------------------------------------
// The same task engine the /tasks board and the Telegram cards use. Nothing
// here schedules a reminder, materialises an occurrence or decides whether a
// completion was on time - every action goes to runTaskAction_ and the server
// returns the rebuilt view, so the two surfaces cannot disagree.
// ==========================================================

// `Bajarilgan` was labelled as though it were the history and showed only work
// finished today — while the same response already carried `recentCompleted`,
// the 50 most recent completions the /tasks board's Tarix tab uses, which no
// Mini code ever read. Both now exist and say which they are. `recentCompleted`
// also includes completed goal steps, which `completedToday` excludes, so those
// stop being invisible on a phone.
const TASK_FILTERS = [
    { key: 'dueToday', label: 'Bugun' },
    { key: 'overdue', label: 'Muddati o’tgan' },
    { key: 'upcoming', label: 'Keyingi' },
    { key: 'waitingProof', label: 'Rasm kutilmoqda' },
    { key: 'completedToday', label: 'Bugun bajarilgan' },
    { key: 'recentCompleted', label: 'Tarix' }
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
    // `recentCompleted` is the only list that hangs off the root rather than
    // `today`, because it is not about today.
    const listFor = key => (key === 'recentCompleted'
        ? (view.recentCompleted || [])
        : (lists[key === 'dueToday' ? 'needsAttention' : key] || []));
    const counts = key => (key !== 'recentCompleted' && view.counts && view.counts[key] !== undefined)
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

/**
 * The one place a row decides what it is, so no two lists can disagree.
 *
 * `displayStatus` is the server's reading — `Overdue` is derived there from the
 * clock and is never stored — and `dateKey > todayKey` is what makes an
 * occurrence future work. Reading both here is what stops a card offering an
 * action the engine is certain to refuse.
 */
function occurrenceState(o, todayKey) {
    const status = o.displayStatus || o.status;
    return {
        completed: o.status === 'Completed',
        waitingProof: o.status === 'WaitingProof',
        cancelled: o.status === 'Cancelled',
        skipped: o.status === 'Skipped',
        overdue: status === 'Overdue',
        future: !!o.dateKey && !!todayKey && o.dateKey > todayKey
    };
}

/** The badge that says what a row is, in the words /tasks already uses. */
function statusPill(o, s) {
    if (s.cancelled) return '<span class="pill muted">Bekor</span>';
    if (s.skipped) return '<span class="pill muted">O\'tkazilgan</span>';
    if (s.waitingProof) return '<span class="pill warn">Rasm kutilmoqda</span>';
    if (s.completed) return '<span class="pill ok">Bajarildi</span>';
    if (s.overdue) return '<span class="pill debt">Kechikdi</span>';
    if (s.future) return '<span class="pill info">Kelgusi</span>';
    return '';
}

/**
 * What this row may actually do.
 *
 * - Completed → undo it, nothing else.
 * - Cancelled / skipped → history. Offering "Bajarildi" on one only produced a
 *   red toast, because the engine refuses both.
 * - WaitingProof → somebody has claimed it and been asked for the photo. The
 *   button used to still be here, and pressing it a second time completed the
 *   task with no photo at all. Only the group photo finishes it now.
 * - Future → skip, deliberately confirmed, and never "Bajarildi": the engine
 *   refuses early completion, so advertising it was advertising a failure.
 * - Otherwise → complete (a photo task starts the proof claim, because the Mini
 *   App has a verified Telegram identity to ask) and skip.
 */
function occurrenceActions(o, s) {
    const id = escapeHtml(o.id);
    if (s.completed) {
        return `<button class="btn-sm" onclick="taskAction('reopen_occurrence','${id}')">Qaytarish</button>`;
    }
    if (s.cancelled || s.skipped) return '';
    const skip = `<button class="btn-sm" onclick="taskAction('skip_occurrence','${id}')">O'tkazish</button>`;
    if (s.waitingProof) return skip;
    if (s.future) return skip;
    return `<button class="btn-sm btn-primary" onclick="taskAction('complete_occurrence','${id}')">Bajarildi</button>
            ${skip}`;
}

function occurrenceRows(list) {
    if (!list.length) return emptyRow("Bu ro'yxat bo'sh");
    const todayKey = (state.tasks && state.tasks.todayKey) || '';
    return list.map(o => {
        const s = occurrenceState(o, todayKey);
        const clock = dueClock(o.dueLabel);
        const actions = occurrenceActions(o, s);
        // Who finished it and how late, which the phone never showed before.
        const credit = s.completed
            ? (o.completedByName ? ' · ✓ ' + escapeHtml(o.completedByName) : '') +
              (o.lateLabel ? ' · ' + escapeHtml(o.lateLabel) + ' kech' : ' · o\'z vaqtida')
            : '';
        return `
        <div class="item" style="flex-direction:column;align-items:stretch;gap:8px">
            <div class="row" style="align-items:flex-start">
                <div class="grow">
                    <p class="title">${escapeHtml(o.title)}</p>
                    <p class="tiny muted ellipsis">
                        ${o.dateKey ? shortDate(o.dateKey) : 'Sanasiz'}${clock ? ' · ' + escapeHtml(clock) : ''}${o.responsible ? ' · ' + escapeHtml(o.responsible) : ''}${credit}
                    </p>
                </div>
                ${priorityPill(o.priority)}
                ${statusPill(o, s)}
                ${o.hasProof ? '<span class="pill ok">🖼</span>' : (o.photoRequired ? '<span class="pill info">📷</span>' : '')}
            </div>
            ${s.waitingProof ? `<p class="tiny muted">📷 Guruhda so'ralgan xabarga rasm bilan javob berilishi kerak.</p>` : ''}
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

/**
 * What a *definition* is, in the words /tasks already uses.
 *
 * This list used to read `status === 'paused' ? "To'xtatilgan" : 'Faol'`, so a
 * cancelled or a finished routine both said **Faol** — and got offered
 * "To'xtatish", which the engine refuses outright.
 */
function defStatusPill(status) {
    if (status === 'paused') return '<span class="pill warn">To\'xtatilgan</span>';
    if (status === 'completed') return '<span class="pill ok">Yakunlangan</span>';
    if (status === 'cancelled') return '<span class="pill muted">Bekor qilingan</span>';
    return '';
}

/**
 * Pause is offered for an active routine and resume for a paused one, and
 * neither for a routine that has been cancelled: pausing one answers
 * "Bekor qilingan vazifa." and pressing it could only ever produce that.
 */
function routinePauseButton(t) {
    const id = escapeHtml(t.id);
    if (t.status === 'paused') {
        return `<button class="btn-sm" onclick="taskAction('resume_routine','','${id}')">Davom</button>`;
    }
    if (t.status === 'active') {
        return `<button class="btn-sm" onclick="taskAction('pause_routine','','${id}')">To'xtatish</button>`;
    }
    return '';
}

function routineSection(view) {
    const routines = (view.tasks || []).filter(t => t.type === 'routine');
    if (!routines.length) return '';
    return `
        <h2>Odatlar</h2>
        <div class="card list">
            ${routines.map(t => {
                const stats = t.stats || {};
                // The full board shows the completion rate next to the streak;
                // the phone showed neither unless the streak was non-zero.
                const rate = (stats.completionRate !== null && stats.completionRate !== undefined)
                    ? ` · 📊 ${stats.completionRate}%` : '';
                const cadence = [
                    escapeHtml(t.recurrenceLabel || ''),
                    t.dueTime ? escapeHtml(t.dueTime) : ''
                ].filter(Boolean).join(' • ');
                return `
                <div class="item" style="flex-direction:column;align-items:stretch;gap:8px">
                    <div class="row" style="align-items:flex-start">
                        <div class="grow">
                            <p class="title ellipsis">${escapeHtml(t.title)}</p>
                            <p class="tiny muted">🔁 ${cadence}${reminderSummary(t)}</p>
                            <p class="tiny muted">🔥 ${Number(stats.streak) || 0} kun${rate}${t.responsible ? ' · ' + escapeHtml(t.responsible) : ''}${t.photoRequired ? ' · 📷' : ''}</p>
                        </div>
                        ${priorityPill(t.priority)}
                        ${defStatusPill(t.status)}
                    </div>
                    ${t.description ? `<p class="tiny muted">${escapeHtml(t.description)}</p>` : ''}
                    <div class="row">
                        <button class="btn-sm" onclick="openTaskSheet('${escapeHtml(t.id)}')" aria-label="Tahrirlash">✎ Tahrirlash</button>
                        ${routinePauseButton(t)}
                    </div>
                </div>`;
            }).join('')}
        </div>`;
}

/**
 * A goal and its steps.
 *
 * This used to be a title, a `done/total` pill and a progress bar — no steps, no
 * per-step actions, no editing, no cancelling. A goal's steps are ordinary
 * deadline-less occurrences (`buildTaskViews_` keeps them out of Bugun on
 * purpose), so the same completion and reopen actions apply to each one, and the
 * photo rule can be inherited from the goal or overridden per step.
 */
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
                <div class="item" style="flex-direction:column;align-items:stretch;gap:8px">
                    <div class="row" style="align-items:flex-start">
                        <div class="grow">
                            <p class="title ellipsis">${escapeHtml(t.title)}</p>
                            ${t.responsible || t.photoRequired ? `<p class="tiny muted">${t.responsible ? escapeHtml(t.responsible) : ''}${t.responsible && t.photoRequired ? ' · ' : ''}${t.photoRequired ? '📷' : ''}</p>` : ''}
                        </div>
                        ${defStatusPill(t.status)}
                        <span class="pill info">${done}/${total}</span>
                    </div>
                    ${t.description ? `<p class="tiny muted">${escapeHtml(t.description)}</p>` : ''}
                    <div class="bar"><span style="width:${Math.max(2, percent)}%"></span></div>
                    ${goalStepRows(t)}
                    <div class="row">
                        <button class="btn-sm" onclick="openTaskSheet('${escapeHtml(t.id)}')" aria-label="Tahrirlash">✎ Tahrirlash</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
}

/** One row per step: what it is, and the one action it has. */
function goalStepRows(goal) {
    const steps = goal.stepOccurrences || [];
    if (!steps.length) return '';
    const todayKey = (state.tasks && state.tasks.todayKey) || '';
    return `<div class="steps">${steps.map(step => {
        const s = occurrenceState(step, todayKey);
        // Step titles are stored as "<goal> — <step>"; only the step half is news.
        const parts = String(step.title || '').split(' — ');
        const short = parts.length > 1 ? parts.slice(1).join(' — ') : step.title;
        const id = escapeHtml(step.id);
        let action = '';
        if (s.completed) {
            action = `<button class="btn-sm" onclick="taskAction('reopen_occurrence','${id}')" aria-label="Qayta ochish">↩</button>`;
        } else if (s.cancelled || s.skipped) {
            action = '';
        } else if (s.waitingProof) {
            action = '<span class="pill warn" title="Guruhda rasm kutilmoqda">📷</span>';
        } else {
            action = `<button class="btn-sm btn-primary" onclick="taskAction('complete_occurrence','${id}')" aria-label="Bajarildi">✅</button>`;
        }
        return `
            <div class="step-row">
                <span class="grow tiny${s.completed ? ' step-done' : ''}">${s.completed ? '☑' : '☐'} ${escapeHtml(short)}${step.photoRequired ? ' 📷' : ''}</span>
                ${s.cancelled || s.skipped ? statusPill(step, s) : ''}
                ${action}
            </div>`;
    }).join('')}</div>`;
}

// ------------------------------------------------------------------- actions

/** Occurrence-level actions take an occurrence; task-level ones take a task. */
const OCCURRENCE_ACTIONS = ['complete_occurrence', 'reopen_occurrence', 'skip_occurrence'];

/** What actually happened, per action, rather than "Bajarildi" for all of them. */
const TASK_ACTION_DONE_TOAST = {
    complete_occurrence: 'Bajarildi',
    reopen_occurrence: 'Qayta ochildi',
    skip_occurrence: "O'tkazib yuborildi",
    pause_routine: "To'xtatildi",
    resume_routine: 'Davom ettirildi',
    cancel_task: 'Bekor qilindi'
};

/**
 * One task mutation at a time.
 *
 * The /tasks board serialises its mutations behind `taskMutationInFlight`; this
 * screen had nothing, so a repeated tap on a slow connection issued parallel
 * `mini_task_action` calls. Each answers with a rebuilt view, so the last one to
 * land wins and can paint over the effect of the other -- and two completions of
 * the same occurrence raced for the same row. The App Brief's rule is that
 * wherever an overlay used to be the only thing preventing a second submission,
 * an explicit guard takes its place: never fewer guards, only visible ones.
 */
let taskMutationInFlight = false;

async function taskAction(action, occurrenceId, taskId, extra) {
    if (taskMutationInFlight) return;
    taskMutationInFlight = true;
    // A confirmed future-skip is a second request that inherits this guard
    // rather than releasing and re-taking it, so nothing can slip in between.
    let handedOff = false;
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
        if (body.config) state.tasksConfig = body.config;
        renderTasks();
        settleTasksInBackground();
        // A photo-required task is not finished by pressing a button: it moves
        // to "waiting" and the proof is asked for in the Tasks group, exactly
        // as it does from a group card.
        //
        // Every action used to toast "Bajarildi", so skipping a day or resuming a
        // routine both reported a completion that had not happened.
        toast(body.awaitingProof
            ? (body.message || '📷 Rasm kutilmoqda')
            : (TASK_ACTION_DONE_TOAST[action] || 'Saqlandi'));
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        // Skipping a future day is legitimate but has to be deliberate, so the
        // server refuses once and asks. Confirm and send the same action again.
        if (error.needsFutureConfirm) {
            const when = error.dateKey ? shortDate(error.dateKey) : '';
            if (await askConfirm(`${when} kuni o'tkazib yuborilsinmi?`)) {
                // Handed to the retry, which raises the guard again for itself
                // before this one's `finally` gets to lower it.
                handedOff = true;
                taskMutationInFlight = false;
                return taskAction(action, occurrenceId, taskId, { confirmFuture: true });
            }
            return;
        }
        toast(error.message, true);
    } finally {
        if (!handedOff) taskMutationInFlight = false;
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
    const type = miniTaskFormType();
    const show = (id, on) => {
        const node = document.getElementById(id);
        if (node) node.classList.toggle('hidden', !on);
    };
    show('tRoutineBlock', type === 'routine');
    show('tOnceBlock', type === 'once');
    show('tGoalBlock', type === 'goal');
    syncReminderControls();
}

/** Uzbek labels for the engine's four priorities, rather than its enum values. */
const MINI_PRIORITIES = [['low', 'Past'], ['normal', 'Oddiy'], ['high', 'Yuqori'], ['urgent', 'Shoshilinch']];

/** What the interval box is counting, which depends entirely on the cadence. */
const MINI_INTERVAL_LABELS = {
    daily: 'Har necha kunda',
    weekly: 'Har necha haftada',
    monthly: 'Har necha oyda',
    custom: 'Necha kunda'
};

/** Shows only the controls the chosen cadence actually uses. */
function onMiniFreqChange() {
    const freq = document.getElementById('tFreq');
    if (!freq) return;
    const value = freq.value;
    const show = (id, on) => {
        const node = document.getElementById(id);
        if (node) node.classList.toggle('hidden', !on);
    };
    show('tWeekdayRow', value === 'weekly');
    show('tMonthDayRow', value === 'monthly');
    const label = document.getElementById('tIntervalLabel');
    if (label) label.textContent = MINI_INTERVAL_LABELS[value] || MINI_INTERVAL_LABELS.daily;
}

// ------------------------------------------------------------- goal steps
//
// A step's id is what keeps its occurrence, its proof and who did it attached
// to it across a rename or a reorder (`mergeGoalSteps_` matches on id first).
// So the id of every step already on the goal is carried in a hidden field and
// sent straight back; a step with no id is genuinely new.

function addGoalStep(step) {
    const list = document.getElementById('tStepList');
    if (!list) return;
    const value = step || {};
    // Absent means "inherit the goal's photo rule"; present means this step
    // overrides it. The engine writes the key only when it is really an
    // override, so "Meros" has to send nothing rather than send false.
    const override = value.photoRequired === undefined ? '' : (value.photoRequired ? 'yes' : 'no');
    const row = document.createElement('div');
    row.className = 'step-edit';
    row.innerHTML =
        `<input type="hidden" class="mini-step-id" value="${escapeHtml(value.id || '')}">` +
        `<input class="mini-step-title" autocomplete="off" placeholder="Bosqich nomi" ` +
        `value="${escapeHtml(value.title || '')}">` +
        '<select class="mini-step-photo" aria-label="Rasm tasdiqi">' +
        `<option value="" ${override === '' ? 'selected' : ''}>Meros</option>` +
        `<option value="yes" ${override === 'yes' ? 'selected' : ''}>📷 Ha</option>` +
        `<option value="no" ${override === 'no' ? 'selected' : ''}>Yo'q</option>` +
        '</select>' +
        '<button type="button" class="btn-sm" aria-label="Bosqichni o\'chirish" ' +
        'onclick="removeGoalStep(this)">✕</button>';
    list.appendChild(row);
    syncGoalStepControls();
    if (!value.title) {
        const input = row.querySelector('.mini-step-title');
        if (input) input.focus();
    }
}

function removeGoalStep(button) {
    const row = button.closest('.step-edit');
    if (row) row.remove();
    syncGoalStepControls();
}

function syncGoalStepControls() {
    const list = document.getElementById('tStepList');
    const empty = document.getElementById('tStepEmpty');
    if (empty && list) empty.classList.toggle('hidden', list.children.length > 0);
}

/**
 * The steps the sheet describes, in the order shown.
 *
 * A removed step is simply absent, which is what the engine reads as "removed":
 * it keeps that step's row flagged `removedStep`, with its proof and who did it,
 * and drops it out of the goal's progress.
 */
function goalStepValues() {
    const list = document.getElementById('tStepList');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.step-edit')).map(row => {
        const title = String(row.querySelector('.mini-step-title').value || '').trim();
        const id = String(row.querySelector('.mini-step-id').value || '');
        const override = row.querySelector('.mini-step-photo').value;
        const step = { title: title };
        if (id) step.id = id;
        if (override === 'yes') step.photoRequired = true;
        if (override === 'no') step.photoRequired = false;
        return step;
    }).filter(step => step.title);
}

/** Create, or edit when a task id is supplied. */
function openTaskSheet(taskId) {
    const existing = taskId
        ? ((state.tasks && state.tasks.tasks) || []).find(t => t.id === taskId)
        : null;

    // A ✎ whose definition is not in the loaded view used to open the sheet
    // titled "Yangi vazifa" with every field empty -- and then save it as an
    // edit, because `submitTask` was still handed the id. Emptying a task by
    // pressing edit is not a thing this screen should be able to do.
    if (taskId && !existing) {
        toast("Vazifa ma'lumoti topilmadi. Ro'yxatni yangilang.", true);
        return;
    }

    const type = existing ? existing.type : 'once';
    const recurrence = (existing && existing.recurrence) || {};
    const reminderTimes = (existing && existing.reminderTimes) || [];
    const steps = (existing && existing.steps) || [];
    const groupMissing = state.tasksConfig && state.tasksConfig.tasksGroupConfigured === false;

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
            <option value="goal">Maqsad</option>
        </select>`}

        <label for="tTitle">Sarlavha</label>
        <input id="tTitle" autocomplete="off" maxlength="200"
               value="${escapeHtml(existing ? existing.title : '')}">

        <label for="tDescription">Tavsif</label>
        <textarea id="tDescription">${escapeHtml(existing ? existing.description || '' : '')}</textarea>

        <div id="tOnceBlock" class="${type === 'once' ? '' : 'hidden'}">
            <label for="tDeadline">Muddat sanasi</label>
            <input id="tDeadline" type="date" onchange="syncReminderControls()"
                   value="${escapeHtml(existing ? existing.deadlineKey || '' : '')}">
            <label for="tDeadlineTime">Muddat vaqti</label>
            <input id="tDeadlineTime" type="time"
                   value="${escapeHtml(existing ? existing.deadlineTime || '' : '')}">
            <p class="tiny muted">Ikkalasini ham bo'sh qoldirsangiz — muddatsiz vazifa.
                ${escapeHtml(TASK_TIMEZONE_NOTE)}.</p>
        </div>

        <div id="tRoutineBlock" class="${type === 'routine' ? '' : 'hidden'}">
            <label for="tFreq">Takrorlanish</label>
            <select id="tFreq" onchange="onMiniFreqChange()">
                <option value="daily">Har kuni</option>
                <option value="weekly">Har hafta</option>
                <option value="monthly">Har oy</option>
                <option value="custom">Har N kunda</option>
            </select>

            <label for="tInterval" id="tIntervalLabel">Har necha kunda</label>
            <input id="tInterval" type="number" inputmode="numeric" min="1" max="365" value="1">

            <div id="tWeekdayRow" class="hidden">
                <label>Kunlar</label>
                <div class="row" style="flex-wrap:wrap;gap:6px">
                    ${MINI_WEEKDAYS.map(([label, wd]) =>
                        `<label class="mini-weekday"><input type="checkbox" class="mini-wd" data-wd="${wd}"> ${label}</label>`).join('')}
                </div>
            </div>

            <div id="tMonthDayRow" class="hidden">
                <label for="tMonthDay">Oyning kuni</label>
                <select id="tMonthDay">
                    ${Array.from({ length: 31 }, (unused, i) =>
                        `<option value="${i + 1}">${i + 1}</option>`).join('')}
                    <option value="last">Oyning oxirgi kuni</option>
                </select>
            </div>

            <label for="tStartKey">Boshlanish sanasi</label>
            <input id="tStartKey" type="date"
                   value="${escapeHtml(existing ? existing.startKey || '' : '')}">

            <label for="tEndKey">Tugash sanasi (ixtiyoriy)</label>
            <input id="tEndKey" type="date"
                   value="${escapeHtml(existing ? existing.endKey || '' : '')}">

            <label for="tDueTime">Kunlik muddat vaqti (ixtiyoriy)</label>
            <input id="tDueTime" type="time"
                   value="${escapeHtml(existing ? existing.dueTime || '' : '')}">
            <p class="tiny muted">${escapeHtml(TASK_TIMEZONE_NOTE)}.</p>
        </div>

        <div id="tGoalBlock" class="${type === 'goal' ? '' : 'hidden'}">
            <label>Bosqichlar</label>
            <div id="tStepList" class="stack"></div>
            <p id="tStepEmpty" class="tiny muted">Bosqich qo'shilmagan.</p>
            <button type="button" class="btn-sm" id="tStepAdd" style="margin-top:6px"
                    onclick="addGoalStep()">＋ Bosqich qo'shish</button>
            <p class="tiny muted">«Meros» — maqsadning rasm qoidasi qo'llanadi.</p>
        </div>

        <label for="tPriority">Muhimlik</label>
        <select id="tPriority">
            ${MINI_PRIORITIES.map(([value, label]) =>
                `<option value="${value}" ${(existing ? existing.priority : 'normal') === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>

        <label for="tResponsible">Mas'ul</label>
        <input id="tResponsible" autocomplete="off" maxlength="200"
               value="${escapeHtml(existing ? existing.responsible || '' : '')}">

        <label class="task-toggle-row" style="margin-top:14px">
            <input type="checkbox" id="tPhotoRequired"
                   ${existing && existing.photoRequired ? 'checked' : ''}>
            <span>📷 Rasm tasdiqi talab qilinsin</span>
        </label>
        <p class="tiny muted">Bunday vazifa faqat Telegram guruhiga yuborilgan rasm bilan
            bajarilgan bo'ladi.${groupMissing ? " ⚠️ Vazifalar guruhi hozir sozlanmagan." : ''}</p>

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
        ${existing && existing.status !== 'cancelled'
            ? `<button class="btn-danger btn-full"
                onclick="cancelTask('${escapeHtml(taskId)}')">Bekor qilish</button>` : ''}
        </div>
    `);

    const taskSheet = document.querySelector('#sheetHost .sheet');
    if (taskSheet) taskSheet.classList.add('task-editor-sheet');

    // Prefilled after the sheet exists, so an edit opens on the task's *actual*
    // configuration rather than on a default that a save would then store.
    reminderTimes.forEach(time => addReminderTime(time));
    steps.forEach(step => addGoalStep(step));
    syncGoalStepControls();

    const freq = document.getElementById('tFreq');
    if (freq) freq.value = recurrence.freq || 'daily';
    const interval = document.getElementById('tInterval');
    if (interval) {
        interval.value = String((recurrence.freq === 'custom'
            ? recurrence.intervalDays
            : recurrence.interval) || 1);
    }
    const monthDay = document.getElementById('tMonthDay');
    if (monthDay && recurrence.freq === 'monthly' && recurrence.monthDay !== undefined) {
        monthDay.value = String(recurrence.monthDay);
    }
    (recurrence.weekdays || []).forEach(wd => {
        const box = document.querySelector('.mini-wd[data-wd="' + wd + '"]');
        if (box) box.checked = true;
    });

    const daily = document.getElementById('tRemindDaily');
    if (daily) daily.dataset.chosen = (existing && existing.remindDaily) ? '1' : '0';
    onMiniTypeChange();
    onMiniFreqChange();
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

        // Every field this sheet shows is sent explicitly, create or edit alike,
        // so a value the person can see is a value they can change -- including
        // clearing it. What is *not* shown is not sent, and the engine's "absent
        // means leave alone" rule keeps it. The photo rule is shown now, so it is
        // sent: it used to be neither, which made it unreachable from a phone.
        payload.photoRequired = document.getElementById('tPhotoRequired').checked;

        if (taskId) { payload.taskId = taskId; payload.id = taskId; }
        else { payload.type = type; }

        if (type === 'once') {
            payload.deadlineKey = document.getElementById('tDeadline').value || '';
            payload.deadlineTime = document.getElementById('tDeadlineTime').value || '';
        } else if (type === 'routine') {
            // The engine's shape is {freq, interval|intervalDays, weekdays,
            // monthDay}; a monthly cadence must name its day or the save is
            // refused, which is what stops a phone quietly creating a day-1 task.
            const interval = Math.max(1, Number(document.getElementById('tInterval').value) || 1);
            const recurrence = { freq: document.getElementById('tFreq').value || 'daily' };
            if (recurrence.freq === 'custom') recurrence.intervalDays = interval;
            else recurrence.interval = interval;
            if (recurrence.freq === 'weekly') {
                recurrence.weekdays = Array.from(document.querySelectorAll('.mini-wd'))
                    .filter(box => box.checked).map(box => Number(box.dataset.wd));
            }
            if (recurrence.freq === 'monthly') {
                recurrence.monthDay = document.getElementById('tMonthDay').value;
            }
            payload.recurrence = recurrence;
            payload.startKey = document.getElementById('tStartKey').value || '';
            payload.endKey = document.getElementById('tEndKey').value || '';
            payload.dueTime = document.getElementById('tDueTime').value || '';
        } else {
            // Existing steps carry their ids back, so `mergeGoalSteps_` matches
            // them by id and a rename or a reorder keeps each step's occurrence,
            // its proof and who completed it.
            const steps = goalStepValues();
            if (!steps.length) { toast('Kamida bitta bosqich kiriting', true); return; }
            payload.steps = steps;
        }

        const body = await api('mini_task_action', payload);
        if (body.view) state.tasks = body.view;
        if (body.config) state.tasksConfig = body.config;
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
        if (body.config) state.tasksConfig = body.config;
        renderTasks();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    }
}
