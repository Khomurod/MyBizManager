'use strict';

// ==========================================================
// Tasks — formatting & tiny UI helpers
// ==========================================================

function taskLoader(show) {
    const el = document.getElementById('loader');
    if (el) el.style.display = show ? 'flex' : 'none';
}

let taskToastTimer = null;
function taskToast(text, isError) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-full text-white text-xs font-bold shadow-lg ' +
        (isError ? 'bg-red-500' : 'bg-slate-800');
    el.classList.remove('hidden');
    if (taskToastTimer) clearTimeout(taskToastTimer);
    taskToastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function escapeTaskHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const TASK_PRIORITY_LABELS = { low: 'Past', normal: 'Oddiy', high: 'Yuqori', urgent: 'Shoshilinch' };
const TASK_PRIORITY_CLASSES = {
    low: 'bg-slate-100 text-slate-500',
    normal: 'bg-blue-50 text-blue-600',
    high: 'bg-orange-50 text-orange-600',
    urgent: 'bg-red-50 text-red-600'
};

const TASK_STATUS_LABELS = {
    Open: 'Ochiq', WaitingProof: 'Rasm kutilmoqda', Completed: 'Bajarildi',
    Overdue: "Muddati o'tgan", Cancelled: 'Bekor qilingan', Skipped: "O'tkazilgan"
};
const TASK_STATUS_CLASSES = {
    Open: 'bg-blue-50 text-blue-600', WaitingProof: 'bg-amber-50 text-amber-700',
    Completed: 'bg-green-50 text-green-700', Overdue: 'bg-red-50 text-red-600',
    Cancelled: 'bg-slate-100 text-slate-500', Skipped: 'bg-slate-100 text-slate-500'
};

function taskPriorityBadge(priority) {
    const p = priority || 'normal';
    return '<span class="badge ' + (TASK_PRIORITY_CLASSES[p] || TASK_PRIORITY_CLASSES.normal) + '">' +
        (TASK_PRIORITY_LABELS[p] || p) + '</span>';
}

function taskStatusBadge(display) {
    return '<span class="badge ' + (TASK_STATUS_CLASSES[display] || 'bg-slate-100 text-slate-500') + '">' +
        (TASK_STATUS_LABELS[display] || display) + '</span>';
}

function taskDefStatusBadge(status) {
    const map = {
        active: ['Faol', 'bg-green-50 text-green-700'],
        paused: ["To'xtatilgan", 'bg-amber-50 text-amber-700'],
        completed: ['Yakunlangan', 'bg-blue-50 text-blue-600'],
        cancelled: ['Bekor', 'bg-slate-100 text-slate-500']
    };
    const entry = map[status] || ['—', 'bg-slate-100 text-slate-500'];
    return '<span class="badge ' + entry[1] + '">' + entry[0] + '</span>';
}
