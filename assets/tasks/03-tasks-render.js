'use strict';

// ==========================================================
// Tasks — rendering
// ----------------------------------------------------------
// Pure view of TASKS_STATE. The backend has already resolved every status,
// due label and late duration in Asia/Tashkent, so this only lays them out.
// ==========================================================

function renderAllTasks() {
    const view = TASKS_STATE.view;
    const stamp = document.getElementById('nowStamp');
    if (stamp && view) stamp.textContent = view.nowLabel || '';

    const warn = document.getElementById('tgWarn');
    if (warn) warn.classList.toggle('hidden', !(TASKS_STATE.config && TASKS_STATE.config.tasksGroupConfigured === false));

    const keyBtn = document.getElementById('adminKeyBtn');
    if (keyBtn) keyBtn.className = 'text-[10px] font-bold px-2 py-1 rounded border ' +
        (tasksAdminKey() ? 'bg-green-50 text-green-600 border-green-200' : 'text-slate-500');

    if (TASKS_STATE.needsKey && !TASKS_STATE.view) {
        // An empty board would read as "nothing to do" rather than "not shown".
        const prompt = emptyNote('Vazifalarni ko\'rish uchun admin kalitini kiriting. 🔑');
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
    return '<p class="text-center text-slate-400 text-xs py-8">' + escapeTaskHtml(text) + '</p>';
}

/** One occurrence row. `mode` picks which action buttons appear. */
function occCard(occ, mode) {
    const meta = [];
    if (occ.responsible) meta.push('👤 ' + escapeTaskHtml(occ.responsible));
    if (occ.dueLabel) meta.push('📅 ' + escapeTaskHtml(occ.dueLabel));
    if (occ.photoRequired) meta.push('📷');
    if (occ.lateLabel) meta.push('<span class="text-red-500">⚠️ ' + escapeTaskHtml(occ.lateLabel) + ' kech</span>');
    if (mode === 'completed') {
        if (occ.completedByName) meta.push('✓ ' + escapeTaskHtml(occ.completedByName));
        if (occ.onTime === true && !occ.lateLabel) meta.push('<span class="text-green-600">⏱ vaqtida</span>');
        if (occ.hasProof) meta.push('🖼');
    }

    let actions = '';
    if (mode === 'open') {
        actions =
            '<div class="flex gap-2 mt-2">' +
            '<button onclick="tasksCompleteOcc(\'' + occ.id + '\')" class="flex-1 py-1.5 bg-green-600 text-white rounded-lg text-[11px] font-bold active:scale-95">✅ Bajarildi</button>' +
            '<button onclick="tasksSkip(\'' + occ.id + '\')" class="flex-1 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-[11px] font-bold active:scale-95">⏭ O\'tkazish</button>' +
            '</div>';
    } else if (mode === 'completed') {
        actions = '<div class="flex mt-2"><button onclick="tasksReopen(\'' + occ.id + '\')" class="text-[11px] font-bold text-blue-500">↩ Qayta ochish</button></div>';
    }

    return '<div class="card !p-3 !mb-2">' +
        '<div class="flex items-start justify-between gap-2">' +
        '<p class="font-bold text-sm text-slate-800">' + escapeTaskHtml(occ.title) + '</p>' +
        '<div class="flex gap-1 shrink-0">' + taskPriorityBadge(occ.priority) + taskStatusBadge(occ.displayStatus) + '</div>' +
        '</div>' +
        (meta.length ? '<p class="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-2">' + meta.join('<span class="text-slate-300">•</span>') + '</p>' : '') +
        actions +
        '</div>';
}

function section(title, items, mode, accent) {
    if (!items || !items.length) return '';
    return '<div class="mb-4">' +
        '<h3 class="text-[11px] font-bold uppercase tracking-wider mb-2 ' + (accent || 'text-slate-400') + '">' +
        escapeTaskHtml(title) + ' (' + items.length + ')</h3>' +
        items.map(o => occCard(o, mode)).join('') + '</div>';
}

function renderTodayPanel() {
    const panel = document.getElementById('panel-today');
    const view = TASKS_STATE.view;
    if (!view) { panel.innerHTML = emptyNote('...'); return; }
    const t = view.today;
    const total = t.overdue.length + t.needsAttention.length + t.waitingProof.length + t.upcoming.length + t.completedToday.length;
    if (total === 0) { panel.innerHTML = emptyNote("Bugun uchun vazifa yo'q. ➕ tugmasi bilan qo'shing."); return; }

    panel.innerHTML =
        section('🔴 Diqqat — muddati o\'tgan', t.overdue, 'open', 'text-red-500') +
        section('📌 Bugun bajarilishi kerak', t.needsAttention, 'open', 'text-slate-500') +
        section('⏳ Rasm kutilmoqda', t.waitingProof, 'open', 'text-amber-600') +
        section('🗓 Kelgusi', t.upcoming, 'open', 'text-slate-400') +
        section('✅ Bugun bajarilgan', t.completedToday, 'completed', 'text-green-600');
}

function defActionsRow(task, extra) {
    return '<div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-slate-100">' +
        (extra || '') +
        '<button onclick="openTaskForm(\'' + task.id + '\')" class="text-[11px] font-bold text-blue-500">✏️ Tahrirlash</button>' +
        (task.status !== 'cancelled' ? '<button onclick="tasksCancel(\'' + task.id + '\')" class="text-[11px] font-bold text-red-500">🗑 Bekor qilish</button>' : '') +
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
        const canAct = occ && (occ.displayStatus === 'Open' || occ.displayStatus === 'Overdue' || occ.displayStatus === 'WaitingProof');
        const act = canAct
            ? '<button onclick="tasksCompleteOcc(\'' + occ.id + '\')" class="text-[11px] font-bold text-green-600">✅ Bajarildi</button>'
            : '';
        return '<div class="card !p-3">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<p class="font-bold text-sm">' + escapeTaskHtml(task.title) + '</p>' +
            '<div class="flex gap-1 shrink-0">' + taskPriorityBadge(task.priority) + (occ ? taskStatusBadge(occ.displayStatus) : '') + '</div>' +
            '</div>' +
            (task.description ? '<p class="text-[11px] text-slate-500 mt-1">' + escapeTaskHtml(task.description) + '</p>' : '') +
            '<p class="text-[11px] text-slate-500 mt-1">' +
            (task.responsible ? '👤 ' + escapeTaskHtml(task.responsible) + ' ' : '') +
            (occ && occ.dueLabel ? '📅 ' + escapeTaskHtml(occ.dueLabel) : '📅 muddatsiz') +
            (task.photoRequired ? ' 📷' : '') + '</p>' +
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
            ? '<button onclick="tasksResume(\'' + task.id + '\')" class="text-[11px] font-bold text-green-600">▶️ Davom ettirish</button>'
            : (task.status === 'active' ? '<button onclick="tasksPause(\'' + task.id + '\')" class="text-[11px] font-bold text-amber-600">⏸ To\'xtatish</button>' : '');
        let todayRow = '';
        if (today) {
            const canAct = today.displayStatus === 'Open' || today.displayStatus === 'Overdue' || today.displayStatus === 'WaitingProof';
            todayRow = '<div class="bg-slate-50 rounded-lg p-2 mt-2 flex items-center justify-between">' +
                '<span class="text-[11px] font-bold text-slate-600">Bugun: ' + taskStatusBadge(today.displayStatus) + '</span>' +
                (canAct ? '<span class="flex gap-2">' +
                    '<button onclick="tasksCompleteOcc(\'' + today.id + '\')" class="text-[11px] font-bold text-green-600">✅</button>' +
                    '<button onclick="tasksSkip(\'' + today.id + '\')" class="text-[11px] font-bold text-slate-500">⏭ Bugun o\'tkazish</button>' +
                    '</span>' : '') +
                '</div>';
        }
        return '<div class="card !p-3">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<p class="font-bold text-sm">' + escapeTaskHtml(task.title) + '</p>' +
            '<div class="flex gap-1 shrink-0">' + taskPriorityBadge(task.priority) + taskDefStatusBadge(task.status) + '</div>' +
            '</div>' +
            '<p class="text-[11px] text-slate-500 mt-1">🔁 ' + escapeTaskHtml(task.recurrenceLabel || '') +
            (task.responsible ? ' • 👤 ' + escapeTaskHtml(task.responsible) : '') +
            (task.photoRequired ? ' • 📷' : '') + '</p>' +
            (task.reminderTimes && task.reminderTimes.length ? '<p class="text-[11px] text-slate-400 mt-0.5">🔔 ' + task.reminderTimes.map(escapeTaskHtml).join(', ') + '</p>' : '') +
            '<div class="flex gap-3 mt-2 text-[11px]">' +
            '<span class="font-bold text-orange-600">🔥 ' + (stats.streak || 0) + ' kun</span>' +
            (stats.completionRate !== null && stats.completionRate !== undefined ? '<span class="font-bold text-blue-600">📊 ' + stats.completionRate + '%</span>' : '') +
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
                ? '<button onclick="tasksReopen(\'' + step.id + '\')" class="text-[11px] text-slate-400">↩</button>'
                : '<button onclick="tasksCompleteOcc(\'' + step.id + '\')" class="text-[11px] font-bold text-green-600">✅</button>';
            return '<div class="flex items-center justify-between py-1 border-b border-slate-50">' +
                '<span class="text-[12px] ' + (done ? 'line-through text-slate-400' : 'text-slate-700') + '">' +
                (done ? '☑ ' : '☐ ') + escapeTaskHtml(step.title.split(' — ').slice(1).join(' — ') || step.title) + '</span>' + btn +
                '</div>';
        }).join('');
        return '<div class="card !p-3">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<p class="font-bold text-sm">🎯 ' + escapeTaskHtml(task.title) + '</p>' +
            '<div class="flex gap-1 shrink-0">' + taskDefStatusBadge(task.status) + '</div>' +
            '</div>' +
            '<div class="mt-2"><div class="flex justify-between text-[11px] font-bold text-slate-500 mb-1">' +
            '<span>Jarayon</span><span>' + progress.done + '/' + progress.total + ' (' + progress.percent + '%)</span></div>' +
            '<div class="w-full bg-slate-100 rounded-full h-2"><div class="bg-blue-600 h-2 rounded-full" style="width:' + progress.percent + '%"></div></div></div>' +
            '<div class="mt-2">' + steps + '</div>' +
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
    panel.innerHTML = items.map(o => occCard(o, 'completed')).join('');
}
