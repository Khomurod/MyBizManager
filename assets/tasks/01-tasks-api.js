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

/**
 * A mutation rides the session, like every other request the app makes.
 *
 * An expired session is the one answer that ends the session; everything else
 * is a message beside the board, with the board still showing what it showed.
 */
async function taskMutation(payload, okMessage) {
    taskLoader(true);
    try {
        const data = await tasksApiCall(payload);
        if (tasksAuthExpired(data)) { signOut(); return null; }
        if (!data || data.status !== 'success') {
            taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            return null;
        }
        if (data.view) { TASKS_STATE.view = data.view; TASKS_STATE.config = data.config; }
        taskToast(okMessage || 'Bajarildi');
        renderAllTasks();
        return data;
    } catch (e) {
        taskToast("Server bilan bog'lanib bo'lmadi", true);
        return null;
    } finally {
        taskLoader(false);
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
