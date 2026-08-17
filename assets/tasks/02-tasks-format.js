'use strict';

// ==========================================================
// Tasks — formatting & tiny UI helpers
// ==========================================================

function taskLoader(show) {
    const el = document.getElementById('loader');
    if (el) el.style.display = show ? 'flex' : 'none';
}

/**
 * A local, non-blocking busy state for one action.
 *
 * `taskLoader` covers the whole board, which is the right answer while the first
 * load has nothing to show yet and the wrong one for ticking off a single card:
 * it freezes the list somebody is reading and hides what they just pressed.
 * Ordinary mutations show this instead — the board stays readable, and
 * `taskMutationInFlight` rather than an overlay is what stops a second click.
 */
function taskBusy(show) {
    const el = document.getElementById('busy');
    if (!el) return;
    if (show) el.classList.remove('hidden');
    else el.classList.add('hidden');
}

let taskToastTimer = null;
function taskToast(text, isError) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    // Positioned above the bottom nav and the FAB by .toast in tasks.html.
    el.className = 'toast' + (isError ? ' toast--error' : '');
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

/**
 * Priority is shown only when it is not the default. "Oddiy" on every card is
 * noise that steals width from the title without telling anyone anything.
 */
function taskPriorityBadge(priority) {
    const p = priority || 'normal';
    if (p === 'normal') return '';
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

/**
 * The one status line that carries the card: when the work is due, and what
 * state it is in. Placed directly under the title so scanning a list is
 * title → time → everything else.
 */
function taskWhenLine(occ) {
    const label = occ.dueLabel || '';
    if (occ.displayStatus === 'Completed') {
        return '<p class="when when--done">✅ Bajarildi' +
            (occ.lateLabel ? ' • ' + escapeTaskHtml(occ.lateLabel) + ' kech'
                : (occ.onTime === true ? ' • o\'z vaqtida' : '')) + '</p>';
    }
    if (occ.displayStatus === 'Overdue') {
        return '<p class="when when--late">⏰ ' + escapeTaskHtml(label || 'Muddati o\'tgan') +
            (occ.lateLabel ? ' • ' + escapeTaskHtml(occ.lateLabel) + ' kech' : '') + '</p>';
    }
    if (occ.displayStatus === 'WaitingProof') {
        return '<p class="when when--wait">📷 Rasm kutilmoqda' +
            (label ? ' • ' + escapeTaskHtml(label) : '') + '</p>';
    }
    if (!label) return '<p class="when">🕓 Muddatsiz</p>';
    return '<p class="when">🕓 ' + escapeTaskHtml(label) + '</p>';
}

/** Secondary metadata: who owns it, and whether a photo is needed. */
function taskMetaLine(occ, extras) {
    const parts = [];
    if (occ.responsible) parts.push('👤 ' + escapeTaskHtml(occ.responsible));
    if (occ.photoRequired) parts.push('📷 Rasm');
    (extras || []).forEach(part => parts.push(part));
    if (!parts.length) return '';
    return '<p class="meta">' + parts.map(p => '<span>' + p + '</span>').join('') + '</p>';
}
