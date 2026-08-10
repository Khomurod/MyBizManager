'use strict';

// ==========================================================
// Tasks — app shell: bottom navigation, the create/edit sheet and bootstrap
// ----------------------------------------------------------
// The reminder times and the goal steps are edited as one row per value
// instead of a comma-separated string and a multiline textarea. The payload
// they produce is unchanged: reminderTimes stays an array of "HH:MM" strings
// and steps stays an array of titles, exactly as the backend already expects.
// ==========================================================

const TASK_TABS = ['today', 'tasks', 'routines', 'goals', 'completed'];
// Uzbek weekday labels mapped to JS weekday numbers (0 = Sunday).
const TASK_WEEKDAYS = [['Du', 1], ['Se', 2], ['Chor', 3], ['Pay', 4], ['Jum', 5], ['Shan', 6], ['Yak', 0]];

function showTaskTab(name) {
    const tab = TASK_TABS.indexOf(name) !== -1 ? name : 'today';
    TASK_TABS.forEach(t => {
        const panel = document.getElementById('panel-' + t);
        if (panel) panel.classList.toggle('active', t === tab);
    });
    document.querySelectorAll('[data-tab]').forEach(btn => {
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
    // Switching tabs on a phone should start at the top of the new list.
    window.scrollTo({ top: 0, behavior: 'auto' });
}

// -------------------------------------------------------------- repeaters

/** Shows the "nothing here yet" note only while a repeater is empty. */
function syncRepeaterEmpty(listId, emptyId) {
    const list = document.getElementById(listId);
    const note = document.getElementById(emptyId);
    if (!list || !note) return;
    note.classList.toggle('hidden', list.children.length > 0);
}

function clearRepeater(listId, emptyId) {
    const list = document.getElementById(listId);
    if (list) list.innerHTML = '';
    syncRepeaterEmpty(listId, emptyId);
}

/** Removes the row a delete button belongs to. */
function removeRepeaterRow(button) {
    const row = button.closest('.rep__row');
    if (!row) return;
    const list = row.parentElement;
    row.remove();
    if (list && list.id === 'reminderList') syncRepeaterEmpty('reminderList', 'reminderEmpty');
    if (list && list.id === 'stepList') syncRepeaterEmpty('stepList', 'stepEmpty');
}

/** Every non-empty value in a repeater, in the order shown. */
function repeaterValues(listId) {
    const list = document.getElementById(listId);
    if (!list) return [];
    return Array.from(list.querySelectorAll('input'))
        .map(input => String(input.value || '').trim())
        .filter(Boolean);
}

function repeaterRow(inputHtml, label) {
    const row = document.createElement('div');
    row.className = 'rep__row';
    row.innerHTML = inputHtml +
        '<button type="button" class="rep__del" onclick="removeRepeaterRow(this)" ' +
        'aria-label="' + label + '" title="' + label + '">✕</button>';
    return row;
}

/** A native time picker per reminder — no comma-separated typing. */
function addReminderRow(value) {
    const list = document.getElementById('reminderList');
    if (!list) return;
    const row = repeaterRow(
        '<input type="time" class="f-input" value="' + escapeTaskHtml(value || '') + '">',
        "Eslatmani o'chirish");
    list.appendChild(row);
    syncRepeaterEmpty('reminderList', 'reminderEmpty');
    if (!value) {
        const input = row.querySelector('input');
        if (input) input.focus();
    }
}

function addStepRow(value) {
    const list = document.getElementById('stepList');
    if (!list) return;
    const row = repeaterRow(
        '<input type="text" class="f-input" maxlength="200" placeholder="Bosqich nomi" value="' +
        escapeTaskHtml(value || '') + '">',
        "Bosqichni o'chirish");
    list.appendChild(row);
    syncRepeaterEmpty('stepList', 'stepEmpty');
    if (!value) {
        const input = row.querySelector('input');
        if (input) input.focus();
    }
}

// ---------------------------------------------------------------- the form

function buildWeekdayBoxes() {
    const wrap = document.getElementById('weekdayBoxes');
    if (!wrap) return;
    wrap.innerHTML = TASK_WEEKDAYS.map(([label, wd]) =>
        '<label><input type="checkbox" class="wd-box" data-wd="' + wd + '"> ' + label + '</label>').join('');
}

function buildMonthDayOptions() {
    const sel = document.getElementById('fMonthDay');
    if (!sel) return;
    let html = '';
    for (let d = 1; d <= 31; d++) html += '<option value="' + d + '">' + d + '-kun</option>';
    html += '<option value="last">Oyning oxirgi kuni</option>';
    sel.innerHTML = html;
}

function onTypeChange() {
    const type = document.getElementById('fType').value;
    document.getElementById('grpOnce').classList.toggle('hidden', type !== 'once');
    document.getElementById('grpRoutine').classList.toggle('hidden', type !== 'routine');
    document.getElementById('grpGoal').classList.toggle('hidden', type !== 'goal');
    // Rolling daily reminders only make sense for a deadline-less one-time task.
    document.getElementById('grpRemindDaily').classList.toggle('hidden', type !== 'once');
    // A goal step has no deadline to hang a single reminder on, so the server
    // repeats them daily; there is nothing to choose, only something to say.
    document.getElementById('goalRemindNote').classList.toggle('hidden', type !== 'goal');
    if (type === 'routine') onFreqChange();
    // A goal needs at least one step, so offer a row rather than an empty list.
    if (type === 'goal' && document.getElementById('stepList').children.length === 0) {
        addStepRow('');
    }
}

function onFreqChange() {
    const freq = document.getElementById('fFreq').value;
    document.getElementById('grpWeekdays').classList.toggle('hidden', freq !== 'weekly');
    document.getElementById('grpMonthDay').classList.toggle('hidden', freq !== 'monthly');
    const label = document.getElementById('intervalLabel');
    const grpInterval = document.getElementById('grpInterval');
    if (freq === 'custom') { label.textContent = 'Necha kunda'; grpInterval.classList.remove('hidden'); }
    else if (freq === 'daily') { label.textContent = 'Har necha kunda'; grpInterval.classList.remove('hidden'); }
    else if (freq === 'weekly') { label.textContent = 'Har necha haftada'; grpInterval.classList.remove('hidden'); }
    else if (freq === 'monthly') { label.textContent = 'Har necha oyda'; grpInterval.classList.remove('hidden'); }
}

function resetTaskForm() {
    ['fId', 'fTitle', 'fDesc', 'fResp', 'fDeadlineDate', 'fDeadlineTime', 'fEndDate', 'fDueTime']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('fType').value = 'once';
    document.getElementById('fType').disabled = false;
    const typeNote = document.getElementById('typeLockNote');
    if (typeNote) typeNote.classList.add('hidden');
    document.getElementById('fPriority').value = 'normal';
    document.getElementById('fFreq').value = 'daily';
    document.getElementById('fInterval').value = '1';
    document.getElementById('fPhoto').checked = false;
    document.getElementById('fRemindDaily').checked = false;
    document.querySelectorAll('.wd-box').forEach(b => { b.checked = false; });
    clearRepeater('reminderList', 'reminderEmpty');
    clearRepeater('stepList', 'stepEmpty');
    const start = document.getElementById('fStartDate');
    if (start) start.value = (TASKS_STATE.view && TASKS_STATE.view.todayKey) || new Date().toISOString().slice(0, 10);
    taskFormMsg('', false, true);
}

function openTaskForm(taskId) {
    resetTaskForm();
    const title = document.getElementById('taskModalTitle');
    if (taskId && TASKS_STATE.view) {
        const task = TASKS_STATE.view.tasks.find(t => t.id === taskId);
        if (task) prefillTaskForm(task);
        if (title) title.textContent = 'Vazifani tahrirlash';
    } else if (title) {
        title.textContent = 'Yangi vazifa';
    }
    onTypeChange();
    document.getElementById('taskModal').classList.remove('hidden');
    document.getElementById('taskModal').querySelector('.sheet__body').scrollTop = 0;
}

function prefillTaskForm(task) {
    document.getElementById('fId').value = task.id;
    document.getElementById('fType').value = task.type;
    // The backend refuses a type change outright, so the select must not offer
    // one. The hint says why, rather than leaving a disabled control unexplained.
    document.getElementById('fType').disabled = true;
    const typeNote = document.getElementById('typeLockNote');
    if (typeNote) typeNote.classList.remove('hidden');
    document.getElementById('fTitle').value = task.title || '';
    document.getElementById('fDesc').value = task.description || '';
    document.getElementById('fResp').value = task.responsible || '';
    document.getElementById('fPriority').value = task.priority || 'normal';
    document.getElementById('fPhoto').checked = !!task.photoRequired;
    document.getElementById('fRemindDaily').checked = !!task.remindDaily;

    clearRepeater('reminderList', 'reminderEmpty');
    (task.reminderTimes || []).forEach(time => addReminderRow(time));

    if (task.type === 'once') {
        document.getElementById('fDeadlineDate').value = task.deadlineKey || '';
        document.getElementById('fDeadlineTime').value = task.deadlineTime || '';
    } else if (task.type === 'routine') {
        const r = task.recurrence || {};
        document.getElementById('fFreq').value = r.freq || 'daily';
        document.getElementById('fInterval').value = r.freq === 'custom' ? (r.intervalDays || 1) : (r.interval || 1);
        document.getElementById('fStartDate').value = task.startKey || '';
        document.getElementById('fEndDate').value = task.endKey || '';
        document.getElementById('fDueTime').value = task.dueTime || '';
        buildMonthDayOptions();
        if (r.freq === 'monthly') document.getElementById('fMonthDay').value = String(r.monthDay || 1);
        onFreqChange();
        document.querySelectorAll('.wd-box').forEach(b => {
            b.checked = (r.weekdays || []).indexOf(Number(b.dataset.wd)) !== -1;
        });
    } else if (task.type === 'goal') {
        clearRepeater('stepList', 'stepEmpty');
        (task.steps || []).forEach(step => addStepRow(step.title));
    }
}

function closeTaskForm() { document.getElementById('taskModal').classList.add('hidden'); }

function taskFormMsg(text, isError, hide) {
    const box = document.getElementById('taskFormMsg');
    if (!box) return;
    if (hide || !text) { box.classList.add('hidden'); box.textContent = ''; return; }
    box.textContent = text;
    box.className = 'f-msg ' + (isError ? 'f-msg--err' : 'f-msg--ok');
}

/**
 * Normalises a clock value to "HH:MM". Native time inputs already produce it;
 * this keeps a hand-typed "9:05" working the way the old text field did.
 */
function parseReminderTimes(values) {
    const source = Array.isArray(values) ? values : String(values || '').split(',');
    return source.map(s => String(s).trim()).filter(Boolean).map(s => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s);
        if (!m) return s; // let the server reject it
        return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
    });
}

function submitTaskForm() {
    const type = document.getElementById('fType').value;
    const title = document.getElementById('fTitle').value.trim();
    if (!title) { taskFormMsg('Sarlavha kiriting.', true); return; }

    const payload = {
        type: type,
        title: title,
        description: document.getElementById('fDesc').value.trim(),
        responsible: document.getElementById('fResp').value.trim(),
        priority: document.getElementById('fPriority').value,
        photoRequired: document.getElementById('fPhoto').checked,
        reminderTimes: parseReminderTimes(repeaterValues('reminderList'))
    };
    const id = document.getElementById('fId').value;
    if (id) payload.id = id;

    if (type === 'once') {
        payload.deadlineKey = document.getElementById('fDeadlineDate').value;
        payload.deadlineTime = document.getElementById('fDeadlineTime').value;
        payload.remindDaily = document.getElementById('fRemindDaily').checked;
    } else if (type === 'routine') {
        const freq = document.getElementById('fFreq').value;
        const interval = Number(document.getElementById('fInterval').value) || 1;
        const recurrence = { freq: freq };
        if (freq === 'custom') recurrence.intervalDays = interval;
        else recurrence.interval = interval;
        if (freq === 'weekly') {
            recurrence.weekdays = Array.from(document.querySelectorAll('.wd-box'))
                .filter(b => b.checked).map(b => Number(b.dataset.wd));
        }
        if (freq === 'monthly') recurrence.monthDay = document.getElementById('fMonthDay').value;
        payload.recurrence = recurrence;
        payload.startKey = document.getElementById('fStartDate').value;
        payload.endKey = document.getElementById('fEndDate').value;
        payload.dueTime = document.getElementById('fDueTime').value;
    } else if (type === 'goal') {
        payload.steps = repeaterValues('stepList');
        if (!payload.steps.length) { taskFormMsg('Kamida bitta bosqich kiriting.', true); return; }
    }

    tasksSave(payload).then(result => { if (result) closeTaskForm(); });
}

// ------------------------------------------------------------- admin key

function openAdminKey() {
    const input = document.getElementById('adminKeyInput');
    if (input) input.value = tasksAdminKey();
    document.getElementById('adminModal').classList.remove('hidden');
}
function closeAdminKey() { document.getElementById('adminModal').classList.add('hidden'); }
function saveAdminKey() {
    setTasksAdminKey(document.getElementById('adminKeyInput').value.trim());
    closeAdminKey();
    taskToast('Admin kaliti saqlandi');
    // The board could not be read without a key, so entering one is a reload.
    loadTasks();
}

// ---------------------------------------------------------------- bootstrap

window.onload = () => {
    buildWeekdayBoxes();
    buildMonthDayOptions();
    onTypeChange();
    loadTasks();
};
