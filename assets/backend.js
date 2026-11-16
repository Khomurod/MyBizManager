'use strict';

// ==========================================================
// Which server answers — shared by every page
// ----------------------------------------------------------
// The backend is one program that runs in two places:
//
//   - the Supabase Edge function `api`, next to the database (us-east-1);
//   - the Apps Script web app, where it has always run (GOOGLE_APP_URL).
//
// Every request goes to the Edge function first. The function answers itself
// only what it has been allowed to (app_properties: the ready marker and
// EDGE_NATIVE_ACTIONS) and forwards everything else to Apps Script unchanged,
// so sending requests here changes the path, never the answer.
//
// When the Edge function cannot be reached, or the platform answers instead of
// it (an error status without the X-MBM-Runtime header this backend sets, or
// 'unconfigured': nothing was done), the request goes straight to Apps Script,
// and so does every request from this device for the next five minutes.
//
// A request is only ever sent twice when sending it twice cannot do anything
// twice: a read, or a write carrying a requestId (the server stores each
// requestId once). Any other write that fails on its way fails exactly as it
// would have against Apps Script, and is not repeated; and such a write is
// sent to the Edge function only after the function has answered on this tab
// in the last ten minutes, so the first write after an outage goes straight to
// Apps Script.
//
// Pages served from this machine (the browser tests, a local preview) talk to
// Apps Script, which the tests intercept: a test run can never reach the live
// Edge function. localStorage 'mbm_backend' = 'edge' or 'apps-script'
// overrides the choice on one device.
// ==========================================================

const EDGE_API_URL = 'https://ksdqoftlxrkpyylbbyoi.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1';

const BACKEND_CHOICE_STORAGE = 'mbm_backend';
/** localStorage: until when (epoch ms) this device sends everything straight to Apps Script. */
const EDGE_DOWN_STORAGE = 'mbm_edge_down_until';
/** sessionStorage: when the Edge function last answered on this tab. */
const EDGE_SEEN_STORAGE = 'mbm_edge_seen_at';
const EDGE_DOWN_MS = 5 * 60 * 1000;
const EDGE_TRUST_MS = 10 * 60 * 1000;

/** Actions that change nothing, or nothing that matters when repeated (a login issues another token). */
const BACKEND_READ_PREFIX = /^(get_|list_)/;
const BACKEND_REPEATABLE_ACTIONS = ['login', 'verify_access', 'mini_home', 'mini_omad', 'mini_cafe', 'mini_tasks'];

function backendStorage(name) {
    try {
        return window[name] || null;
    } catch (error) {
        return null;
    }
}

function backendGet(name, key) {
    try {
        const store = backendStorage(name);
        return store ? store.getItem(key) : null;
    } catch (error) {
        return null;
    }
}

function backendSet(name, key, value) {
    try {
        const store = backendStorage(name);
        if (!store) return;
        if (value === null) store.removeItem(key);
        else store.setItem(key, value);
    } catch (error) {}
}

/** 'edge' or 'apps-script' for this device. */
function backendChoice() {
    const chosen = backendGet('localStorage', BACKEND_CHOICE_STORAGE);
    if (chosen === 'edge' || chosen === 'apps-script') return chosen;
    const host = String(window.location.hostname || '').toLowerCase();
    if (window.location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' ||
        host === '[::1]' || host === '::1' || host.endsWith('.localhost')) {
        return 'apps-script';
    }
    return 'edge';
}

function edgeIsDown() {
    return Number(backendGet('localStorage', EDGE_DOWN_STORAGE) || 0) > Date.now();
}

function markEdgeDown() {
    backendSet('localStorage', EDGE_DOWN_STORAGE, String(Date.now() + EDGE_DOWN_MS));
    backendSet('sessionStorage', EDGE_SEEN_STORAGE, null);
}

function markEdgeSeen() {
    backendSet('sessionStorage', EDGE_SEEN_STORAGE, String(Date.now()));
}

function edgeSeenRecently() {
    const at = Number(backendGet('sessionStorage', EDGE_SEEN_STORAGE) || 0);
    return at > 0 && Date.now() - at < EDGE_TRUST_MS;
}

/** Whether sending this body twice can do nothing twice. */
function backendSafeToRepeat(bodyText) {
    let payload;
    try {
        payload = JSON.parse(bodyText);
    } catch (error) {
        return false;
    }
    if (!payload || typeof payload !== 'object') return false;
    if (payload.requestId) return true;
    const action = typeof payload.action === 'string' ? payload.action : '';
    return BACKEND_READ_PREFIX.test(action) || BACKEND_REPEATABLE_ACTIONS.indexOf(action) !== -1;
}

/**
 * Whether this is the backend's own answer, from either runtime. Any 2xx is;
 * an error status is only when this backend set it (the platform's own error
 * pages carry no X-MBM-Runtime header) and did not say nothing was done.
 */
function backendAnswered(response) {
    if (response.ok) return true;
    const runtime = response.headers.get('X-MBM-Runtime');
    return !!runtime && runtime !== 'unconfigured';
}

/**
 * POSTs `bodyText` to the backend and resolves with the Response, or rejects
 * as fetch would: callers treat the answer exactly as before.
 *
 * `appsScriptUrl` is the page's GOOGLE_APP_URL, used directly when the Edge
 * function is not the one to ask.
 */
async function backendPost(appsScriptUrl, bodyText) {
    const direct = () => fetch(String(appsScriptUrl).trim(), { method: 'POST', body: bodyText });
    if (backendChoice() !== 'edge' || edgeIsDown()) return direct();

    const repeatable = backendSafeToRepeat(bodyText);
    if (!repeatable && !edgeSeenRecently()) return direct();

    let response;
    try {
        response = await fetch(EDGE_API_URL, { method: 'POST', body: bodyText });
    } catch (transportError) {
        if (!repeatable) {
            // Not repeated: it may have arrived. The person's retry, and every
            // other write until a read reaches the Edge function, goes to
            // Apps Script.
            backendSet('sessionStorage', EDGE_SEEN_STORAGE, null);
            throw transportError;
        }
        // If Apps Script answers, the Edge function was the problem; if it does
        // not either, this device is offline and there is nothing to remember.
        const fallback = await direct();
        markEdgeDown();
        return fallback;
    }

    if (backendAnswered(response)) {
        markEdgeSeen();
        return response;
    }
    markEdgeDown();
    if (repeatable || response.headers.get('X-MBM-Runtime') === 'unconfigured') return direct();
    return response;
}
