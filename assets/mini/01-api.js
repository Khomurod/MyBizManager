'use strict';

// ==========================================================
// Mini App API client
// ----------------------------------------------------------
// One request shape: an action, the signed initData, and whatever the action
// needs. The admin key is never sent from here -- the Mini App is not given
// one, and the backend would not accept it for a mini_ action anyway.
// ==========================================================

const state = {
    user: null,
    period: "",
    omad: null,
    tenants: [],
    entries: [],
    cafe: null,
    tasks: null,
    tab: 'omad',
    // When the figures on screen came from the stored snapshot rather than from
    // this session's verified answer. 0 means they are the server's own.
    snapshotAt: 0,
    // Why the refresh that should have replaced them did not. Display state:
    // it changes what the banner says and nothing else.
    loadError: ''
};

// ----------------------------------------------------------- the snapshot
//
// The Omad tab used to render nothing at all until the backend had verified the
// signature — correct, and a blank screen for the length of an Apps Script
// round trip every time the app was opened. It now paints the last answer that
// was verified *on this device, for this Telegram account*, and replaces it the
// moment the live one arrives.
//
// Three things keep that from weakening the one gate this app has:
//
//   1. **It is only ever written after a verified success.** Nothing reaches
//      storage that the backend did not sign off on.
//   2. **It is scoped to the Telegram account it was verified for.** The id
//      comes from the *verified* response, not from initDataUnsafe, so a
//      forged bridge cannot name someone else's key — and a different account
//      on the same device simply finds nothing.
//   3. **It is never presented as current.** While it is on screen the header
//      says so, and it is discarded after a day rather than aging quietly.
//
// It stays display-only: every write goes to the server, every figure is
// replaced wholesale by the live answer, and nothing is ever submitted from it.

const MINI_SNAPSHOT_PREFIX = 'mini_snapshot_';

/** How old a stored snapshot may be before it is not shown at all. */
const MINI_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function miniSnapshotKey(userId) {
    return `${MINI_SNAPSHOT_PREFIX}${String(userId || '')}`;
}

/**
 * Which Telegram account this device last verified as.
 *
 * Stored separately, and written only alongside a verified answer, so the
 * snapshot can be found before the next answer arrives without ever trusting
 * an unsigned id to name it.
 */
function miniLastVerifiedUser() {
    try { return localStorage.getItem(`${MINI_SNAPSHOT_PREFIX}user`) || ''; } catch (error) { return ''; }
}

/**
 * The account Telegram *says* is opening the app, unsigned.
 *
 * `initDataUnsafe` is deliberately never trusted anywhere else in this app: it
 * is the signed payload with the signature removed, so believing it would mean
 * believing whoever opened the page. It is read here for the one thing it can
 * safely do — **narrow** what is shown. Two Telegram accounts on one phone
 * share this origin's storage, so without it, opening the bot as somebody else
 * would paint the first account's figures for the second until the backend
 * answered. It can only ever hide a snapshot, never reveal one, and a bridge
 * that does not expose it hides the snapshot too.
 */
function telegramClaimedUserId() {
    try {
        const app = telegramApp();
        const user = app && app.initDataUnsafe && app.initDataUnsafe.user;
        return user && user.id !== undefined ? String(user.id) : '';
    } catch (error) {
        return '';
    }
}

function readMiniSnapshot() {
    const userId = miniLastVerifiedUser();
    if (!userId) return null;
    // Fail closed: no claim, or a different claim, and nothing is painted.
    if (telegramClaimedUserId() !== userId) return null;
    let raw = '';
    try { raw = localStorage.getItem(miniSnapshotKey(userId)) || ''; } catch (error) { return null; }
    if (!raw) return null;

    let stored;
    try { stored = JSON.parse(raw); } catch (error) { return null; }
    if (!stored || typeof stored !== 'object' || !stored.value) return null;

    const age = Date.now() - Number(stored.savedAt || 0);
    if (!Number.isFinite(age) || age < 0 || age > MINI_SNAPSHOT_MAX_AGE_MS) return null;
    return { value: stored.value, savedAt: Number(stored.savedAt || 0) };
}

function writeMiniSnapshot(userId, value) {
    if (!userId) return;
    try {
        localStorage.setItem(`${MINI_SNAPSHOT_PREFIX}user`, String(userId));
        localStorage.setItem(miniSnapshotKey(userId),
            JSON.stringify({ savedAt: Date.now(), value }));
    } catch (error) {
        // A full or unavailable localStorage costs a spinner, never data.
    }
}

/** Forgets everything stored for this device. Used when the gate refuses. */
function clearMiniSnapshot() {
    const userId = miniLastVerifiedUser();
    try {
        if (userId) localStorage.removeItem(miniSnapshotKey(userId));
        localStorage.removeItem(`${MINI_SNAPSHOT_PREFIX}user`);
    } catch (error) {}
}

const NETWORK_MESSAGE = "Aloqa yo'q. Internetni tekshirib, qayta urinib ko'ring.";

/**
 * One call to the backend.
 *
 * Throws with a readable message on anything that is not an authorized
 * success, so every caller can simply try/catch. `authorized: false` is
 * surfaced separately, because it means the whole app has to go back to the
 * gate rather than showing an error next to a button.
 */
async function api(action, payload = {}) {
    const initData = telegramInitData();
    if (!initData) {
        const error = new Error(OPEN_IN_TELEGRAM_MESSAGE);
        error.unauthorized = true;
        throw error;
    }

    let response;
    try {
        response = await fetch(GOOGLE_APP_URL, {
            method: 'POST',
            body: JSON.stringify(Object.assign({ action, initData }, payload))
        });
    } catch (transportError) {
        throw new Error(NETWORK_MESSAGE);
    }
    if (!response.ok) throw new Error(NETWORK_MESSAGE);

    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch (parseError) {
        // Apps Script answers 200 with an HTML error page for its own faults.
        throw new Error("Server javobi tushunarsiz.");
    }

    if (body && body.authorized === false) {
        const error = new Error(body.message || OPEN_IN_TELEGRAM_MESSAGE);
        error.unauthorized = true;
        error.reason = body.reason || "";
        throw error;
    }
    if (!body || body.status !== 'success') {
        const error = new Error((body && body.message) || "Amal bajarilmadi.");
        // Some refusals are questions rather than failures -- skipping a future
        // day asks for confirmation and expects the same call again. The flags
        // travel with the error so the caller can answer instead of only
        // showing the text.
        if (body && body.needsFutureConfirm) {
            error.needsFutureConfirm = true;
            error.dateKey = body.dateKey || "";
        }
        throw error;
    }
    return body;
}

/**
 * Asks the backend to send the Telegram cards it has queued, without waiting.
 *
 * A write returns as soon as the record is stored; sending the group card is a
 * separate Telegram round trip that the person holding the phone has no reason
 * to wait through. This is called after a successful write and deliberately not
 * awaited, so the card appears within seconds rather than at the next
 * five-minute trigger tick.
 *
 * Nothing depends on it arriving. If the request is dropped -- the app closed,
 * the connection lost -- the job is still queued and the trigger sends it, so
 * the failure is a delay and never a missing report. That is why it swallows
 * its errors: there is nothing for the user to do about one.
 */
function flushReports() {
    try {
        api('mini_flush_reports').catch(() => {});
    } catch (error) {
        // Not even a signed-out client should turn a saved entry into an error.
    }
}

/**
 * A stable id for one submission, kept until it succeeds.
 *
 * The same reason the web app keeps one: a retry after a dropped connection
 * has to resolve to the record the first attempt created rather than write a
 * second one. sessionStorage survives the Mini App being reloaded by Telegram.
 */
function pendingId(key, prefix) {
    const storageKey = `mini_pending_${key}`;
    let value = "";
    try { value = sessionStorage.getItem(storageKey) || ""; } catch (error) { value = ""; }
    if (!value) {
        value = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        try { sessionStorage.setItem(storageKey, value); } catch (error) {}
    }
    return value;
}

function clearPendingId(key) {
    try { sessionStorage.removeItem(`mini_pending_${key}`); } catch (error) {}
}
