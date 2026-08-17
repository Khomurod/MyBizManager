'use strict';

// ==========================================================
// Tasks — API client & state
// ----------------------------------------------------------
// Reuses GOOGLE_APP_URL and the omad_admin session guard from
// assets/omad/00-config.js (the single source of truth for the backend URL),
// and the session helpers from assets/session.js. Every call - read as well as
// mutation - carries the session token, and the server checks that it is an
// omad_admin one.
// ==========================================================

const TASKS_STATE = { view: null, config: null, loadError: '' };

async function tasksApiCall(payload) {
    const body = Object.assign({}, payload);
    if (!body.adminKey) {
        const token = sessionToken();
        if (token) body.sessionToken = token;
    }
    const res = await fetch(GOOGLE_APP_URL.trim(), { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Server javobi tushunarsiz (JSON emas).');
    }
}

/**
 * The board used to ask for OMAD_ADMIN_KEY and keep it in sessionStorage, so
 * the person running the business typed the maintenance key into a phone to
 * look at a task list. The omad_admin session already proves who they are, and
 * that is what the server now checks.
 */
function tasksAuthExpired(data) {
    return !!(data && data.status === 'error' && data.authExpired === true);
}

async function loadTasks() {
    taskLoader(true);
    try {
        const data = await tasksApiCall({ action: 'get_tasks' });
        if (tasksAuthExpired(data)) { signOut(); return; }
        if (data && data.status === 'success') {
            TASKS_STATE.view = data.view;
            TASKS_STATE.config = data.config;
            TASKS_STATE.loadError = '';
        } else {
            // A throttle or a server fault leaves the board exactly as it was.
            // Emptying it would read as "nothing to do" rather than "not shown".
            TASKS_STATE.loadError = (data && data.message) || "Ma'lumotni yuklab bo'lmadi";
            taskToast(TASKS_STATE.loadError, true);
        }
    } catch (e) {
        TASKS_STATE.loadError = "Ma'lumotni yuklab bo'lmadi";
        taskToast(TASKS_STATE.loadError, true);
    } finally {
        taskLoader(false);
    }
    renderAllTasks();
}

// ------------------------------------------------------- write responsiveness
//
// A task mutation is finished, as far as the person pressing the button is
// concerned, the moment the backend confirms the row is stored and the
// occurrences it owns are reconciled. Scanning every schedule and pushing the
// Telegram group cards is useful follow-up work that used to happen inside that
// same response, so ticking off one card paid for a full scheduler pass, a
// Telegram round trip and a lock wait before the board came back.
//
// `deferReports: true` tells the backend to leave both to the settle request
// below. Losing that request costs a delay and nothing else: the jobs are
// queued and the five-minute `processPendingTelegramJobs` trigger runs the same
// cycle regardless. An older backend ignores the flag and behaves exactly as it
// did before, so a mid-deployment client is never worse off than it was.

/** One mutation at a time. Without the overlay, this is the only such guard. */
let taskMutationInFlight = false;

let taskSettleInFlight = false;
let taskSettlePending = false;

async function runPendingTaskSettle() {
    if (taskSettleInFlight) return;
    taskSettleInFlight = true;
    try {
        // Coalesce a burst of actions without losing the settle for the last one.
        while (taskSettlePending) {
            taskSettlePending = false;
            try {
                await tasksApiCall({ action: 'settle_tasks' });
            } catch (e) {
                // Nothing to tell anybody: the trigger is the durable sender.
            }
        }
    } finally {
        taskSettleInFlight = false;
    }
}

function settleTasksInBackground() {
    taskSettlePending = true;
    setTimeout(() => { runPendingTaskSettle(); }, 0);
}

/**
 * A mutation rides the session, like every other request the app makes.
 *
 * An expired session is the one answer that ends the session; everything else
 * is a message beside the board, with the board still showing what it showed.
 */
async function taskMutation(payload, okMessage) {
    // The full-screen loader used to be what stopped a second click. Replacing
    // it with a local indicator means the guard has to be said out loud rather
    // than implied by an overlay covering the board.
    if (taskMutationInFlight) return null;
    taskMutationInFlight = true;
    taskBusy(true);
    try {
        const data = await tasksApiCall(Object.assign({ deferReports: true }, payload));
        if (tasksAuthExpired(data)) { signOut(); return null; }
        if (!data || data.status !== 'success') {
            taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            return null;
        }
        if (data.view) { TASKS_STATE.view = data.view; TASKS_STATE.config = data.config; }
        taskToast(okMessage || 'Bajarildi');
        renderAllTasks();
        settleTasksInBackground();
        return data;
    } catch (e) {
        taskToast("Server bilan bog'lanib bo'lmadi", true);
        return null;
    } finally {
        taskMutationInFlight = false;
        taskBusy(false);
    }
}

function tasksSave(payload) { return taskMutation(Object.assign({ action: 'save_task' }, payload), 'Saqlandi'); }
function tasksCancel(id) { if (confirm('Vazifa bekor qilinsinmi?')) return taskMutation({ action: 'cancel_task', id: id }, 'Bekor qilindi'); }
function tasksPause(id) { return taskMutation({ action: 'pause_routine', id: id }, "To'xtatildi"); }
function tasksResume(id) { return taskMutation({ action: 'resume_routine', id: id }, 'Davom ettirildi'); }
/**
 * Skipping a day that has not come round yet is legitimate but has to be
 * deliberate, so a future date is confirmed here before the server is asked.
 */
function tasksSkip(occId, futureDateLabel) {
    const payload = { action: 'skip_occurrence', occurrenceId: occId };
    if (futureDateLabel) {
        if (!confirm('Kelgusi kunni (' + futureDateLabel + ') o\'tkazib yuborilsinmi?')) return null;
        payload.confirmFuture = true;
    }
    return taskMutation(payload, "O'tkazib yuborildi");
}
function tasksCompleteOcc(occId) { return taskMutation({ action: 'complete_occurrence', occurrenceId: occId }, 'Bajarildi'); }
function tasksReopen(occId) { return taskMutation({ action: 'reopen_occurrence', occurrenceId: occId }, 'Qayta ochildi'); }
