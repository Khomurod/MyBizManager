'use strict';

// ==========================================================
// Tasks — app shell: tabs, the create/edit form and bootstrap
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
    document.querySelectorAll('.task-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
}

// ---------------------------------------------------------------- the form

function buildWeekdayBoxes() {
    const wrap = document.getElementById('weekdayBoxes');
    if (!wrap) return;
    wrap.innerHTML = TASK_WEEKDAYS.map(([label, wd]) =>
        '<label class="flex items-center gap-1 px-2 py-1 border rounded-lg text-[11px] font-bold text-slate-600">' +
        '<input type="checkbox" class="wd-box" data-wd="' + wd + '"> ' + label + '</label>').join('');
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
    if (type === 'routine') onFreqChange();
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
    ['fId', 'fTitle', 'fDesc', 'fResp', 'fDeadlineDate', 'fDeadlineTime', 'fEndDate', 'fDueTime', 'fSteps', 'fReminders']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('fType').value = 'once';
    document.getElementById('fPriority').value = 'normal';
    document.getElementById('fFreq').value = 'daily';
    document.getElementById('fInterval').value = '1';
    document.getElementById('fPhoto').checked = false;
    document.getElementById('fRemindDaily').checked = false;
    document.querySelectorAll('.wd-box').forEach(b => { b.checked = false; });
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
}

function prefillTaskForm(task) {
    document.getElementById('fId').value = task.id;
    document.getElementById('fType').value = task.type;
    document.getElementById('fTitle').value = task.title || '';
    document.getElementById('fDesc').value = task.description || '';
    document.getElementById('fResp').value = task.responsible || '';
    document.getElementById('fPriority').value = task.priority || 'normal';
    document.getElementById('fPhoto').checked = !!task.photoRequired;
    document.getElementById('fReminders').value = (task.reminderTimes || []).join(', ');
    document.getElementById('fRemindDaily').checked = !!task.remindDaily;

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
        document.getElementById('fSteps').value = (task.steps || []).map(s => s.title).join('\n');
    }
}

function closeTaskForm() { document.getElementById('taskModal').classList.add('hidden'); }

function taskFormMsg(text, isError, hide) {
    const box = document.getElementById('taskFormMsg');
    if (!box) return;
    if (hide || !text) { box.classList.add('hidden'); box.textContent = ''; return; }
    box.textContent = text;
    box.className = 'text-[11px] font-bold rounded-lg p-2 mt-2 ' +
        (isError ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700');
    box.classList.remove('hidden');
}

function parseReminderTimes(raw) {
    return String(raw || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
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
        reminderTimes: parseReminderTimes(document.getElementById('fReminders').value)
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
        payload.steps = document.getElementById('fSteps').value.split('\n').map(s => s.trim()).filter(Boolean);
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
    renderAllTasks();
    taskToast('Admin kaliti saqlandi');
}

// ---------------------------------------------------------------- bootstrap

window.onload = () => {
    buildWeekdayBoxes();
    buildMonthDayOptions();
    onTypeChange();
    loadTasks();
};
