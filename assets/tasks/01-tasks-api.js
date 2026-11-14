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

// `snapshotAt` is set while the board shows the last list that loaded on this
// device rather than a live one; nothing is changed from it (see below).
const TASKS_STATE = { view: null, config: null, loadError: '', snapshotAt: 0 };

/** How old a stored board may be before it is not shown at all: today's work only. */
const TASKS_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** What a press is told while the board is still the stored copy. */
const TASKS_STALE_MESSAGE = "Ro'yxat hali yangilanmadi — bir zumdan keyin qayta bosing.";

/**
 * Paints the last board that loaded, so opening it is not a blank screen for
 * the length of an Apps Script round trip. Display only, like every snapshot
 * (assets/session.js): it is replaced by the live answer as soon as that
 * arrives, and until then no button changes anything.
 */
function hydrateTasksFromSnapshot() {
    const snapshot = readSnapshot('tasks', TASKS_SNAPSHOT_MAX_AGE_MS);
    if (!snapshot || !snapshot.value || !snapshot.value.view) return false;
    TASKS_STATE.view = snapshot.value.view;
    TASKS_STATE.config = snapshot.value.config || null;
    TASKS_STATE.snapshotAt = snapshot.savedAt;
    renderAllTasks();
    return true;
}

/**
 * Puts a board the server just sent on screen. A live answer is live, whatever
 * was showing before it -- including a stored list whose own refresh failed.
 */
/** Bumped by every live board put on screen, so an older answer can tell it was overtaken. */
let tasksLiveViewGen = 0;

function applyLiveTaskView(data) {
    tasksLiveViewGen++;
    TASKS_STATE.view = data.view;
    TASKS_STATE.config = data.config;
    TASKS_STATE.snapshotAt = 0;
    storeTasksSnapshot();
}

function storeTasksSnapshot() {
    if (TASKS_STATE.view) writeSnapshot('tasks', { view: TASKS_STATE.view, config: TASKS_STATE.config });
}

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
    // The full-screen loader only when there is nothing at all to show.
    taskLoader(!hydrateTasksFromSnapshot());
    // A change confirmed while this read was on its way brought a newer board.
    const sentAtGen = tasksLiveViewGen;
    try {
        const data = await tasksApiCall({ action: 'get_tasks' });
        if (tasksAuthExpired(data)) { signOut(); return; }
        if (data && data.status === 'success') {
            TASKS_STATE.loadError = '';
            if (tasksLiveViewGen === sentAtGen) applyLiveTaskView(data);
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
    if (TASKS_STATE.snapshotAt) { taskToast(TASKS_STALE_MESSAGE, true); return null; }
    taskMutationInFlight = true;
    taskBusy(true);
    try {
        const data = await tasksApiCall(Object.assign({ deferReports: true }, payload));
        if (tasksAuthExpired(data)) { signOut(); return null; }
        if (!data || data.status !== 'success') {
            taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            return null;
        }
        if (data.view) { applyLiveTaskView(data); }
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
        // Ticks pressed while this was on its way go out now.
        if (pendingTaskCompletions.length) drainTaskCompletions();
    }
}

// ------------------------------------------------------- Bajarildi at once
//
// Ticking off a card waited for the server -- about three and a half seconds,
// measured -- before the card moved. Now the card moves the moment it is
// pressed and the completion is sent behind it. Nothing is decided on this
// screen: the server still applies every rule (a photo-proof task is refused
// here as before, and its card never offers the button), and its answer
// replaces the board. A refusal or a lost connection puts the card back where
// it was and says why.
//
// Presses are kept in order and sent one at a time, so ticking three cards in
// a row sends three completions instead of refusing two of them; the one guard
// against a second request in flight, `taskMutationInFlight`, still holds.

/** Occurrences ticked on this screen that the server has not confirmed yet, oldest first. */
const pendingTaskCompletions = [];
let taskCompletionDrain = null;

function tasksCompleteOcc(occId) {
    if (TASKS_STATE.snapshotAt) { taskToast(TASKS_STALE_MESSAGE, true); return null; }
    if (pendingTaskCompletions.indexOf(occId) !== -1) return taskCompletionDrain;
    pendingTaskCompletions.push(occId);
    renderAllTasks();
    taskToast('Bajarildi');
    return drainTaskCompletions();
}

/** Sends the ticks; one sender at a time. Settles when they are all answered. */
function drainTaskCompletions() {
    if (!taskCompletionDrain) {
        taskCompletionDrain = runTaskCompletions().finally(() => { taskCompletionDrain = null; });
    }
    return taskCompletionDrain;
}

async function runTaskCompletions() {
    let confirmed = 0;
    while (pendingTaskCompletions.length) {
        // Another change is on its way; its own ending starts this again.
        if (taskMutationInFlight) return;
        const occId = pendingTaskCompletions[0];
        taskMutationInFlight = true;
        taskBusy(true);
        try {
            const data = await tasksApiCall({ deferReports: true, action: 'complete_occurrence', occurrenceId: occId });
            if (tasksAuthExpired(data)) { pendingTaskCompletions.length = 0; signOut(); return; }
            if (!data || data.status !== 'success') {
                taskToast((data && data.message) || 'Xatolik yuz berdi', true);
            } else {
                confirmed++;
                if (data.view) applyLiveTaskView(data);
            }
        } catch (e) {
            taskToast("Server bilan bog'lanib bo'lmadi", true);
        } finally {
            pendingTaskCompletions.shift();
            taskMutationInFlight = false;
            taskBusy(false);
            renderAllTasks();
        }
    }
    if (confirmed) settleTasksInBackground();
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
function tasksReopen(occId) { return taskMutation({ action: 'reopen_occurrence', occurrenceId: occId }, 'Qayta ochildi'); }
