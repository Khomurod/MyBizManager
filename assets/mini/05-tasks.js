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
                        <p class="tiny muted">${t.status === 'paused' ? "To'xtatilgan" : 'Faol'}${(t.stats && t.stats.streak) ? ' · ' + t.stats.streak + ' kun' : ''}${(t.recurrenceLabel ? ' · ' + escapeHtml(t.recurrenceLabel) : '')}</p>
                    </div>
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
        id: taskId || ''
    }, extra || {});

    try {
        const body = await api('mini_task_action', payload);
        if (body.view) state.tasks = body.view;
        renderTasks();
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

/** Create, or edit when a task id is supplied. */
function openTaskSheet(taskId) {
    const existing = taskId
        ? ((state.tasks && state.tasks.tasks) || []).find(t => t.id === taskId)
        : null;

    openSheet(existing ? 'Vazifani tahrirlash' : 'Yangi vazifa', `
        ${existing ? '' : `
        <label for="tType">Turi</label>
        <select id="tType">
            <option value="once">Bir martalik</option>
            <option value="routine">Takrorlanuvchi</option>
        </select>`}

        <label for="tTitle">Sarlavha</label>
        <input id="tTitle" autocomplete="off" value="${escapeHtml(existing ? existing.title : '')}">

        <label for="tDescription">Tavsif</label>
        <textarea id="tDescription">${escapeHtml(existing ? existing.description || '' : '')}</textarea>

        <div class="grid2">
            <div>
                <label for="tDeadline">Muddat</label>
                <input id="tDeadline" type="date" value="${escapeHtml(existing ? existing.deadlineKey || '' : '')}">
            </div>
            <div>
                <label for="tPriority">Muhimlik</label>
                <select id="tPriority">
                    ${['low', 'normal', 'high', 'urgent'].map(p =>
                        `<option value="${p}" ${existing && existing.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select>
            </div>
        </div>

        <label for="tResponsible">Mas'ul</label>
        <input id="tResponsible" autocomplete="off" value="${escapeHtml(existing ? existing.responsible || '' : '')}">

        <button class="btn-primary btn-full" style="margin-top:14px" id="tSubmit"
                onclick="submitTask('${escapeHtml(taskId || '')}')">Saqlash</button>
        ${existing ? `<button class="btn-danger btn-full" style="margin-top:8px"
                onclick="cancelTask('${escapeHtml(taskId)}')">Bekor qilish</button>` : ''}
    `);
}

async function submitTask(taskId) {
    const button = document.getElementById('tSubmit');
    const title = document.getElementById('tTitle').value.trim();
    if (!title) return toast('Sarlavha kiriting', true);

    const typeField = document.getElementById('tType');
    button.disabled = true;
    button.textContent = 'Saqlanmoqda...';
    try {
        const payload = {
            taskAction: 'save_task',
            title,
            description: document.getElementById('tDescription').value.trim(),
            priority: document.getElementById('tPriority').value,
            responsible: document.getElementById('tResponsible').value.trim()
        };

        if (taskId) {
            // An edit sends only the fields this sheet actually shows. The
            // server keeps everything it is not told about, so a weekly
            // routine edited here stays weekly -- it used to come back daily.
            payload.taskId = taskId;
            payload.id = taskId;
            const deadline = document.getElementById('tDeadline').value || '';
            const editing = ((state.tasks && state.tasks.tasks) || []).find(t => t.id === taskId);
            if (!editing || editing.type === 'once') payload.deadlineKey = deadline;
        } else {
            payload.type = typeField ? typeField.value : 'once';
            payload.deadlineKey = document.getElementById('tDeadline').value || '';
            // A new routine needs a cadence. The engine's shape is
            // {freq, interval}; `{type:'daily'}` matched nothing and fell
            // through to the default.
            if (payload.type === 'routine') payload.recurrence = { freq: 'daily', interval: 1 };
        }

        const body = await api('mini_task_action', payload);
        if (body.view) state.tasks = body.view;
        closeSheet();
        renderTasks();
        toast('Saqlandi');
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
        const body = await api('mini_task_action', { taskAction: 'cancel_task', taskId, id: taskId });
        if (body.view) state.tasks = body.view;
        closeSheet();
        renderTasks();
        toast('Bekor qilindi');
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
