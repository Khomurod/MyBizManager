'use strict';

// ==========================================================
// Tasks — API client & state
// ----------------------------------------------------------
// Reuses GOOGLE_APP_URL and the admin access guard from assets/omad/00-config.js
// (the single source of truth for the backend URL). Every call - read as well
// as mutation - carries the admin key, which is entered once and kept only in
// sessionStorage.
// ==========================================================

const TASKS_STATE = { view: null, config: null, needsKey: false };
const TASKS_ADMIN_KEY_STORE = 'tasks_admin_key';

async function tasksApiCall(payload) {
    const res = await fetch(GOOGLE_APP_URL.trim(), { method: 'POST', body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Server javobi tushunarsiz (JSON emas).');
    }
}

function tasksAdminKey() {
    try { return sessionStorage.getItem(TASKS_ADMIN_KEY_STORE) || ''; } catch (e) { return ''; }
}

function setTasksAdminKey(value) {
    try {
        if (value) sessionStorage.setItem(TASKS_ADMIN_KEY_STORE, value);
        else sessionStorage.removeItem(TASKS_ADMIN_KEY_STORE);
    } catch (e) { /* private mode */ }
}

async function loadTasks() {
    const key = tasksAdminKey();
    if (!key) {
        // The board is admin-only now; there is nothing to show without a key.
        TASKS_STATE.view = null;
        TASKS_STATE.needsKey = true;
        renderAllTasks();
        openAdminKey();
        return;
    }
    taskLoader(true);
    try {
        const data = await tasksApiCall({ action: 'get_tasks', adminKey: key });
        if (data && data.status === 'success') {
            TASKS_STATE.view = data.view;
            TASKS_STATE.config = data.config;
            TASKS_STATE.needsKey = false;
        } else {
            const message = (data && data.message) || "Ma'lumotni yuklab bo'lmadi";
            if (/admin kalit/i.test(message)) {
                setTasksAdminKey('');
                TASKS_STATE.needsKey = true;
                openAdminKey();
            }
            taskToast(message, true);
        }
    } catch (e) {
        taskToast("Ma'lumotni yuklab bo'lmadi", true);
    } finally {
        taskLoader(false);
    }
    renderAllTasks();
}

/**
 * A mutation always carries the admin key. A "wrong key" answer clears the
 * stored key and reprompts, so a mistyped key is corrected without a reload.
 */
async function taskMutation(payload, okMessage) {
    const key = tasksAdminKey();
    if (!key) {
        taskToast('Avval admin kalitini kiriting', true);
        openAdminKey();
        return null;
    }
    taskLoader(true);
    try {
        const data = await tasksApiCall(Object.assign({}, payload, { adminKey: key }));
        if (!data || data.status !== 'success') {
            const message = (data && data.message) || 'Xatolik yuz berdi';
            if (/admin kalit/i.test(message)) { setTasksAdminKey(''); openAdminKey(); }
            taskToast(message, true);
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
function tasksSkip(occId) { return taskMutation({ action: 'skip_occurrence', occurrenceId: occId }, "O'tkazib yuborildi"); }
function tasksCompleteOcc(occId) { return taskMutation({ action: 'complete_occurrence', occurrenceId: occId }, 'Bajarildi'); }
function tasksReopen(occId) { return taskMutation({ action: 'reopen_occurrence', occurrenceId: occId }, 'Qayta ochildi'); }
