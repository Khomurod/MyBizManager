'use strict';

// ==========================================================
// Tasks — rendering
// ----------------------------------------------------------
// Pure view of TASKS_STATE. The backend has already resolved every status,
// due label and late duration in Asia/Tashkent, so this only lays them out.
//
// Phone-first: a card is scanned in the order title → when → who, and the one
// action that matters (Bajarildi) is a full-width button, while edit / cancel /
// skip stay as quiet text or icon controls.
// ==========================================================

function renderAllTasks() {
    const view = TASKS_STATE.view;
    const stamp = document.getElementById('nowStamp');
    if (stamp) stamp.textContent = view ? (view.nowLabel || '') : '';

    const warn = document.getElementById('tgWarn');
    if (warn) warn.classList.toggle('hidden', !(TASKS_STATE.config && TASKS_STATE.config.tasksGroupConfigured === false));

    const failed = document.getElementById('loadWarn');
    if (failed) {
        failed.textContent = TASKS_STATE.loadError
            ? "⚠️ " + TASKS_STATE.loadError + " — ko'rsatilayotgan ro'yxat eskirgan bo'lishi mumkin."
            : '';
        failed.classList.toggle('hidden', !TASKS_STATE.loadError);
    }

    if (!TASKS_STATE.view) {
        const prompt = emptyNote(TASKS_STATE.loadError
            ? "Ro'yxatni yuklab bo'lmadi. Qayta urinib ko'ring."
            : 'Yuklanmoqda...');
        TASK_TABS.forEach(t => { const p = document.getElementById('panel-' + t); if (p) p.innerHTML = prompt; });
        return;
    }

    renderTodayPanel();
    renderTasksPanel();
    renderRoutinesPanel();
    renderGoalsPanel();
    renderCompletedPanel();
}

function emptyNote(text) {
    return '<p class="empty">' + escapeTaskHtml(text) + '</p>';
}

/** The accent stripe that makes a card's state readable at a glance. */
function cardFlagClass(displayStatus) {
    if (displayStatus === 'Overdue') return ' card--flag card--overdue';
    if (displayStatus === 'WaitingProof') return ' card--flag card--waiting';
    if (displayStatus === 'Completed') return ' card--flag card--done';
    return '';
}

/** One occurrence card. `mode` picks which actions appear. */
function occCard(occ, mode) {
    const extras = [];
    if (mode === 'completed') {
        if (occ.completedByName) extras.push('✓ ' + escapeTaskHtml(occ.completedByName));
        if (occ.hasProof) extras.push('🖼 Rasm bor');
    }

    let actions = '';
    if (mode === 'open') {
        // One prominent action, one subordinate icon — not two equal halves.
        actions =
            '<div class="acts">' +
            '<button onclick="tasksCompleteOcc(\'' + occ.id + '\')" class="btn btn--primary">✅ Bajarildi</button>' +
            '<button onclick="tasksSkip(\'' + occ.id + '\')" class="btn btn--ghost btn--icon" ' +
            'aria-label="O\'tkazib yuborish" title="O\'tkazib yuborish">⏭</button>' +
            '</div>';
    } else if (mode === 'completed') {
        actions = '<div class="subacts">' +
            '<button onclick="tasksReopen(\'' + occ.id + '\')" class="lnk">↩ Qayta ochish</button>' +
            '</div>';
    } else if (mode === 'upcoming') {
        // Future work is shown, not actioned: completing something that has not
        // come round yet is almost always a misclick.
        const label = escapeTaskHtml(occ.dueLabel || occ.dateKey || '');
        actions =
            '<div class="subacts">' +
            '<button onclick="tasksSkip(\'' + occ.id + '\', \'' + label + '\')" class="lnk lnk--muted">' +
            '⏭ O\'tkazish</button>' +
            '</div>';
    }

    return '<div class="card' + cardFlagClass(occ.displayStatus) + '">' +
        '<div class="row">' +
        '<div class="row__grow">' +
        '<p class="t-title">' + escapeTaskHtml(occ.title) + '</p>' +
        '</div>' +
        '<div class="badges">' + taskPriorityBadge(occ.priority) + '</div>' +
        '</div>' +
        taskWhenLine(occ) +
        taskMetaLine(occ, extras) +
        actions +
        '</div>';
}

function section(title, items, mode, tone) {
    if (!items || !items.length) return '';
    return '<section class="sec' + (tone ? ' sec--' + tone : '') + '">' +
        '<h2 class="sec__h">' + escapeTaskHtml(title) + '<span class="sec__n">' + items.length + '</span></h2>' +
        items.map(o => occCard(o, mode)).join('') +
        '</section>';
}

/**
 * A collapsed group. Used for work that is not today's business — the future
 * and the already-finished — so Today opens on what actually needs doing.
 */
function foldSection(title, items, mode) {
    if (!items || !items.length) return '';
    return '<details class="fold">' +
        '<summary>' + escapeTaskHtml(title) + '<span class="sec__n">' + items.length + '</span></summary>' +
        '<div class="fold__body">' + items.map(o => occCard(o, mode)).join('') + '</div>' +
        '</details>';
}

function renderTodayPanel() {
    const panel = document.getElementById('panel-today');
    const view = TASKS_STATE.view;
    if (!view) { panel.innerHTML = emptyNote('...'); return; }
    const t = view.today;
    const total = t.overdue.length + t.needsAttention.length + t.waitingProof.length +
        t.upcoming.length + t.completedToday.length;
    if (total === 0) {
        panel.innerHTML = emptyNote("Bugun uchun vazifa yo'q.\n➕ tugmasi bilan qo'shing.");
        return;
    }

    const live = t.overdue.length + t.needsAttention.length + t.waitingProof.length;
    const allClear = live === 0
        ? '<p class="empty">Bugungi ishlar tugadi. 🎉</p>'
        : '';

    // Overdue first, then today's work, then pending proofs. Future and
    // finished work is folded away so it never dominates the screen.
    panel.innerHTML =
        section("🔴 Muddati o'tgan", t.overdue, 'open', 'danger') +
        section('📌 Bugun bajarilishi kerak', t.needsAttention, 'open') +
        section('⏳ Rasm kutilmoqda', t.waitingProof, 'open', 'warn') +
        allClear +
        foldSection('🗓 Kelgusi ishlar', t.upcoming, 'upcoming') +
        foldSection('✅ Bugun bajarilgan', t.completedToday, 'completed');
}

/** Definition-level actions: quiet text controls under a divider. */
function defActionsRow(task, extra) {
    return '<div class="subacts">' +
        (extra || '') +
        '<button onclick="openTaskForm(\'' + task.id + '\')" class="lnk">✏️ Tahrirlash</button>' +
        (task.status !== 'cancelled'
            ? '<button onclick="tasksCancel(\'' + task.id + '\')" class="lnk lnk--danger">🗑 Bekor qilish</button>'
            : '') +
        '</div>';
}

function renderTasksPanel() {
    const panel = document.getElementById('panel-tasks');
    const view = TASKS_STATE.view;
    if (!view) return;
    const tasks = view.tasks.filter(t => t.type === 'once');
    if (!tasks.length) { panel.innerHTML = emptyNote("Bir martalik vazifalar yo'q."); return; }

    panel.innerHTML = tasks.map(task => {
        const occ = task.occurrence;
        const canAct = occ && (occ.displayStatus === 'Open' || occ.displayStatus === 'Overdue' ||
            occ.displayStatus === 'WaitingProof');
        const act = canAct
            ? '<button onclick="tasksCompleteOcc(\'' + occ.id + '\')" class="lnk lnk--ok">✅ Bajarildi</button>'
            : '';
        return '<div class="card' + (occ ? cardFlagClass(occ.displayStatus) : '') + '">' +
            '<div class="row">' +
            '<div class="row__grow"><p class="t-title">' + escapeTaskHtml(task.title) + '</p></div>' +
            '<div class="badges">' + taskPriorityBadge(task.priority) +
            (occ ? taskStatusBadge(occ.displayStatus) : '') + '</div>' +
            '</div>' +
            (occ ? taskWhenLine(occ) : '<p class="when">🕓 Muddatsiz</p>') +
            taskMetaLine({
                responsible: task.responsible,
                photoRequired: task.photoRequired
            }) +
            (task.description ? '<p class="desc">' + escapeTaskHtml(task.description) + '</p>' : '') +
            defActionsRow(task, act) +
            '</div>';
    }).join('');
}

function renderRoutinesPanel() {
    const panel = document.getElementById('panel-routines');
    const view = TASKS_STATE.view;
    if (!view) return;
    const routines = view.tasks.filter(t => t.type === 'routine');
    if (!routines.length) { panel.innerHTML = emptyNote("Muntazam vazifalar yo'q."); return; }

    panel.innerHTML = routines.map(task => {
        const stats = task.stats || {};
        const today = task.todayOccurrence;
        const pauseBtn = task.status === 'paused'
            ? '<button onclick="tasksResume(\'' + task.id + '\')" class="lnk lnk--ok">▶️ Davom ettirish</button>'
            : (task.status === 'active'
                ? '<button onclick="tasksPause(\'' + task.id + '\')" class="lnk lnk--warn">⏸ To\'xtatish</button>'
                : '');

        let todayRow = '';
        if (today) {
            const canAct = today.displayStatus === 'Open' || today.displayStatus === 'Overdue' ||
                today.displayStatus === 'WaitingProof';
            todayRow = '<div class="today-strip">' +
                '<span>Bugun: ' + taskStatusBadge(today.displayStatus) + '</span>' +
                (canAct
                    ? '<span class="today-strip__act acts" style="margin:0;">' +
                      '<button onclick="tasksCompleteOcc(\'' + today.id + '\')" class="btn btn--primary" ' +
                      'style="min-height:42px;padding:0 14px;">✅ Bajarildi</button>' +
                      '<button onclick="tasksSkip(\'' + today.id + '\')" class="btn btn--ghost btn--icon" ' +
                      'style="min-height:42px;width:42px;" aria-label="Bugun o\'tkazish" title="Bugun o\'tkazish">⏭</button>' +
                      '</span>'
                    : '') +
                '</div>';
        }

        return '<div class="card">' +
            '<div class="row">' +
            '<div class="row__grow"><p class="t-title">' + escapeTaskHtml(task.title) + '</p></div>' +
            '<div class="badges">' + taskPriorityBadge(task.priority) + taskDefStatusBadge(task.status) + '</div>' +
            '</div>' +
            '<p class="when">🔁 ' + escapeTaskHtml(task.recurrenceLabel || '') +
            (task.dueTime ? ' • ' + escapeTaskHtml(task.dueTime) : '') + '</p>' +
            taskMetaLine(
                { responsible: task.responsible, photoRequired: task.photoRequired },
                (task.reminderTimes && task.reminderTimes.length)
                    ? ['🔔 ' + task.reminderTimes.map(escapeTaskHtml).join(', ')]
                    : []) +
            '<div class="stats">' +
            '<span class="stat">🔥 ' + (stats.streak || 0) + ' kun</span>' +
            (stats.completionRate !== null && stats.completionRate !== undefined
                ? '<span class="stat">📊 ' + stats.completionRate + '%</span>' : '') +
            '</div>' +
            todayRow +
            defActionsRow(task, pauseBtn) +
            '</div>';
    }).join('');
}

function renderGoalsPanel() {
    const panel = document.getElementById('panel-goals');
    const view = TASKS_STATE.view;
    if (!view) return;
    const goals = view.tasks.filter(t => t.type === 'goal');
    if (!goals.length) { panel.innerHTML = emptyNote("Maqsadlar yo'q."); return; }

    panel.innerHTML = goals.map(task => {
        const progress = task.progress || { done: 0, total: 0, percent: 0 };
        const steps = (task.stepOccurrences || []).map(step => {
            const done = step.displayStatus === 'Completed';
            const btn = done
                ? '<button onclick="tasksReopen(\'' + step.id + '\')" class="step__btn" ' +
                  'aria-label="Qayta ochish" title="Qayta ochish">↩</button>'
                : '<button onclick="tasksCompleteOcc(\'' + step.id + '\')" class="step__btn step__btn--ok" ' +
                  'aria-label="Bajarildi" title="Bajarildi">✅</button>';
            // The step title is stored as "<goal> — <step>"; show only the step.
            const short = step.title.split(' — ').slice(1).join(' — ') || step.title;
            return '<div class="step' + (done ? ' step--done' : '') + '">' +
                '<span class="step__txt">' + (done ? '☑ ' : '☐ ') + escapeTaskHtml(short) + '</span>' +
                btn +
                '</div>';
        }).join('');

        return '<div class="card">' +
            '<div class="row">' +
            '<div class="row__grow"><p class="t-title t-title--lg">🎯 ' + escapeTaskHtml(task.title) + '</p></div>' +
            '<div class="badges">' + taskDefStatusBadge(task.status) + '</div>' +
            '</div>' +
            taskMetaLine({ responsible: task.responsible, photoRequired: task.photoRequired }) +
            '<div class="prog__head"><span>Jarayon</span>' +
            '<span>' + progress.done + '/' + progress.total + ' • ' + progress.percent + '%</span></div>' +
            '<div class="prog"><div class="prog__fill" style="width:' + progress.percent + '%"></div></div>' +
            '<div class="steps">' + steps + '</div>' +
            defActionsRow(task) +
            '</div>';
    }).join('');
}

function renderCompletedPanel() {
    const panel = document.getElementById('panel-completed');
    const view = TASKS_STATE.view;
    if (!view) return;
    const items = view.recentCompleted || [];
    if (!items.length) { panel.innerHTML = emptyNote("Hali bajarilgan vazifa yo'q."); return; }
    panel.innerHTML = '<section class="sec">' +
        '<h2 class="sec__h">✅ Bajarilgan<span class="sec__n">' + items.length + '</span></h2>' +
        items.map(o => occCard(o, 'completed')).join('') +
        '</section>';
}
