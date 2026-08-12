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
    taskCounts: null,
    tab: 'omad'
};

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
        throw new Error((body && body.message) || "Amal bajarilmadi.");
    }
    return body;
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
