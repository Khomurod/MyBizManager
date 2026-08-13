'use strict';

// ==========================================================
// Session, transport and snapshots — shared by every web page
// ----------------------------------------------------------
// One file, loaded first by omad_admin.html, tasks.html, cafe_admin.html and
// cafe_pos.html, so the four screens cannot drift on the three things that
// have to behave identically everywhere:
//
//   1. **What being signed in means.** A signed session token issued by the
//      backend, with the role inside it. The token is opaque to this code: it
//      is sent, never inspected for permission. The server enforces the role,
//      so editing localStorage changes which page opens and nothing else.
//   2. **What a failed request means.** A network fault, a rate limit, an
//      unreadable answer and an expired session are four different things and
//      exactly one of them — an expired session — is a reason to sign out. The
//      café incident was the other three being treated as the fourth: a
//      throttled read logged the cashier out and replaced the stock list with
//      an empty one.
//   3. **What a screen shows before its data arrives.** The last answer that
//      worked, kept per user, so reopening a screen paints immediately and the
//      network request becomes a refresh rather than a wait.
// ==========================================================

const SESSION_STORAGE = 'omad_session';
const SESSION_ROLE_STORAGE = 'omad_role';
const SESSION_USER_STORAGE = 'omad_user';
const SESSION_EXPIRY_STORAGE = 'omad_session_expires';

/** Why a request failed. A caller branches on this rather than on wording. */
const API_ERROR_NETWORK = 'network';
const API_ERROR_PARSE = 'parse';
const API_ERROR_THROTTLED = 'throttled';
const API_ERROR_AUTH = 'auth';
const API_ERROR_SERVER = 'server';

const NETWORK_ERROR_MESSAGE = "Aloqa yo'q. Internetni tekshirib, qayta urinib ko'ring.";
const PARSE_ERROR_MESSAGE = "Server javobi tushunarsiz. Qayta urinib ko'ring.";

function storageGet(key) {
    try { return localStorage.getItem(key) || ''; } catch (error) { return ''; }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* private mode */ }
}

function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (error) { /* private mode */ }
}

function sessionToken() { return storageGet(SESSION_STORAGE); }
function sessionRole() { return storageGet(SESSION_ROLE_STORAGE); }
function sessionUser() { return storageGet(SESSION_USER_STORAGE); }

/** Replaces the stored session, e.g. after a password change reissues one. */
function storeSession(token, expiresAt) {
    if (!token) return;
    storageSet(SESSION_STORAGE, token);
    if (expiresAt) storageSet(SESSION_EXPIRY_STORAGE, String(expiresAt));
}

/**
 * True when the stored token has certainly expired.
 *
 * A local clock is not authority — the server decides — but it saves a round
 * trip and a pointless error screen when the answer is already known.
 */
function sessionExpired() {
    const expiry = Number(storageGet(SESSION_EXPIRY_STORAGE));
    return Number.isFinite(expiry) && expiry > 0 && Date.now() >= expiry;
}

function clearSession() {
    [SESSION_STORAGE, SESSION_ROLE_STORAGE, SESSION_USER_STORAGE, SESSION_EXPIRY_STORAGE,
     'omad_token', 'omad_access_key'].forEach(storageRemove);
    try { sessionStorage.removeItem('tasks_admin_key'); } catch (error) {}
}

/** Ends the session and returns to the login page. */
function signOut() {
    clearSession();
    window.location.href = 'login.html';
}

/**
 * The page guard.
 *
 * A café seller who edits `omad_role` still gets nothing: this only decides
 * which page is willing to render, and every request behind it is refused by
 * the server on the role inside the signed token.
 */
function requireSessionRole(role) {
    if (!sessionToken() || sessionRole() !== role || sessionExpired()) {
        signOut();
        return false;
    }
    return true;
}

/**
 * An Error that says which of the four kinds of failure this was.
 *
 * `body` is the refusal the server sent, when there was one. Some refusals
 * carry information the caller has to act on — a stale-inventory answer
 * carries the current revision — so throwing must not throw it away.
 */
function apiError(kind, message, body) {
    const error = new Error(message);
    error.kind = kind;
    error.isAuthFailure = kind === API_ERROR_AUTH;
    error.body = body || null;
    return error;
}

/**
 * One POST to the backend, with the session attached.
 *
 * Throws an `apiError` for everything that is not a success, so a caller can
 * branch on `kind` instead of on the wording of a message. Only
 * `API_ERROR_AUTH` means "sign out". Apps Script answers
 * HTTP 200 for its own failures, so the body is the only place the outcome is
 * actually known.
 */
async function callApi(url, payload) {
    const body = Object.assign({}, payload || {});
    if (!body.adminKey) delete body.adminKey;
    if (!body.adminKey && !body.sessionToken) {
        const token = sessionToken();
        if (token) body.sessionToken = token;
    }

    let response;
    try {
        response = await fetch(String(url).trim(), { method: 'POST', body: JSON.stringify(body) });
    } catch (transportError) {
        throw apiError(API_ERROR_NETWORK, NETWORK_ERROR_MESSAGE);
    }
    if (!response.ok) throw apiError(API_ERROR_NETWORK, `Server javob bermadi (HTTP ${response.status}).`);

    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (parseError) {
        throw apiError(API_ERROR_PARSE, PARSE_ERROR_MESSAGE);
    }

    if (parsed && parsed.status === 'error') {
        // `authExpired` is the server saying, in so many words, "sign in
        // again". Nothing else is: a throttle, a refused save and a validation
        // message are all ordinary answers that leave the session alone.
        if (parsed.authExpired === true) {
            throw apiError(API_ERROR_AUTH, parsed.message || 'Sessiya tugadi.', parsed);
        }
        if (parsed.code === 'throttled') {
            throw apiError(API_ERROR_THROTTLED, parsed.message ||
                "Juda ko'p so'rov yuborildi. Biroz kutib qayta urinib ko'ring.", parsed);
        }
        throw apiError(API_ERROR_SERVER, parsed.message || 'Amal bajarilmadi.', parsed);
    }
    return parsed;
}

// -------------------------------------------------------------- snapshots
//
// The last answer a screen successfully loaded, so reopening it paints at once
// instead of showing a spinner for the length of an Apps Script round trip.
//
// A snapshot is *display only* and always replaced by the live answer as soon
// as one arrives. Nothing is ever written back to the server from one, and no
// price, stock level, balance or task state is decided from one: the server
// prices every sale, checks every stock movement and owns every figure. Two
// guards keep it honest — it is scoped to the signed-in user, and it is
// ignored once it is older than `maxAgeMs`.

const SNAPSHOT_PREFIX = 'omad_snapshot_';

/** How large a snapshot may be before it is not worth storing. */
const SNAPSHOT_MAX_LENGTH = 2000000;

function snapshotKey(name) {
    return `${SNAPSHOT_PREFIX}${name}_${sessionUser()}`;
}

/** The stored snapshot for `name`, or null when there is none worth using. */
function readSnapshot(name, maxAgeMs) {
    const raw = storageGet(snapshotKey(name));
    if (!raw) return null;
    let stored;
    try { stored = JSON.parse(raw); } catch (error) { return null; }
    if (!stored || typeof stored !== 'object') return null;
    const age = Date.now() - Number(stored.savedAt || 0);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return { value: stored.value, savedAt: Number(stored.savedAt || 0) };
}

function writeSnapshot(name, value) {
    try {
        const body = JSON.stringify({ savedAt: Date.now(), value });
        if (body.length > SNAPSHOT_MAX_LENGTH) return;
        localStorage.setItem(snapshotKey(name), body);
    } catch (error) {
        // A full or unavailable localStorage costs a spinner, never data.
    }
}

function clearSnapshot(name) {
    storageRemove(snapshotKey(name));
}

/**
 * HTML-escapes one value.
 *
 * Here rather than on each page because the thing most often interpolated into
 * a banner is a *server message*, and three pages each writing their own
 * version of this is three chances to get it wrong.
 */
function escapeHtmlText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
