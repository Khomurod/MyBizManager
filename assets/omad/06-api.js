'use strict';

// ==========================================================
// API client
// ----------------------------------------------------------
// The single place that talks to Apps Script. Telegram reports are requested
// as business operations - the browser never composes a Telegram message.
// ==========================================================

// --- TELEGRAM LOGIC (server-proxied, no token in the browser) ---

/** What the user is told when the server could not be understood at all. */
const SAVE_FAILED_MESSAGE = "Saqlanmadi. Internetni tekshirib, qayta urinib ko'ring.";

/**
 * The access key this browser was let in with.
 *
 * Reads and writes both need it now: the ledger, the tenant list and the whole
 * café state are the business's private data, and until this change anyone who
 * knew the /exec URL could read all of it. It is verified once at login and
 * kept in localStorage, so the workflow is unchanged after the first sign-in.
 */
const ACCESS_KEY_STORAGE = 'omad_access_key';

function accessKey() {
    try { return localStorage.getItem(ACCESS_KEY_STORAGE) || ""; } catch (e) { return ""; }
}

/** Sends the browser back to the login page when the key is gone or wrong. */
function requireAccess() {
    try { localStorage.removeItem(ACCESS_KEY_STORAGE); } catch (e) {}
    window.location.href = 'login.html';
}

/**
 * One request to Apps Script, returning the parsed JSON body.
 *
 * Apps Script answers HTTP 200 for almost everything, including its own
 * errors, so the status line says nothing about whether the work happened.
 * A body that cannot be parsed is a failure too - it means a login page or a
 * redirect came back instead of an answer.
 *
 * The access key rides on every request. A payload that supplies its own -
 * the admin-key field in Sozlamalar - keeps it, so typing a different key
 * there still works exactly as before.
 */
async function callBackend(payload) {
    const body = Object.assign({}, payload || {});
    // A payload that names its own key keeps it - that is the Sozlamalar field,
    // which exists so a different key can be tried without signing out. An
    // empty one is not a choice, so the signed-in key is used instead.
    if (!body.adminKey) body.adminKey = accessKey();
    if (!body.adminKey) delete body.adminKey;

    const res = await fetch(GOOGLE_APP_URL.trim(), {
        method: 'POST',
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Server javobi tushunarsiz (JSON emas).');
    }
}

/**
 * True only when the server said, in so many words, that it succeeded.
 * Anything else - an error body, a missing status, an unparsable answer - is
 * a failure, because the alternative is telling someone their money was
 * recorded when it was not.
 */
function isSuccessResponse(body) {
    return !!(body && body.status === 'success');
}

// --- CLOUD ---
async function syncData() {
    showLoader(true);
    try {
        // An authenticated POST, not the old anonymous GET: a GET puts its
        // parameters in the URL, which is where a key must never be.
        const data = await callBackend({ action: 'get_omad_data' });
        if (data && data.status === 'error') {
            requireAccess();
            return;
        }
        if (data) {
            const remote = data.data || data.payload || data;

            if(remote.transactions) app.transactions = remote.transactions;

            if(typeof remote.rate === 'number') {
                // A very old single-rate payload. It has no period of its own,
                // so it applies to the current one.
                app.rates[currentPeriod()] = normalizeRateEntry(remote.rate);
            } else if (remote.rates) {
                app.rates = normalizeRatesMap(remote.rates);
            }

            app.rates = normalizeRatesMap(app.rates);

            if(remote.tenants && remote.tenants.length > 0) {
                app.tenants = remote.tenants.map(normalizeTenantObject);
            } else {
                 app.tenants = [ 
                    {name: "Tehnopark", rent: 0, currency: "USD", disabledMonths: []},
                    {name: "Bunyodbek", rent: 0, currency: "USD", disabledMonths: []}
                ].map(normalizeTenantObject);
            }

            app.templateExpenses = Array.isArray(remote.templateExpenses)
                ? remote.templateExpenses.map(normalizeTemplateExpense)
                : [];
        }
        await loadMigrationState();
    } catch (e) { console.log("Offline or Error"); }
    renderAll();
    showLoader(false);
}

/**
 * Whether the append-only ledger is live. Until cutover the app keeps using
 * the whole-list save, so a half-finished migration cannot break entry.
 */
async function loadMigrationState() {
    try {
        const data = await callBackend({ action: 'get_migration_status' });
        app.migration = (data && data.migration) || null;
        app.ledgerActive = !!(app.migration && app.migration.activeSheet === 'Omad_Transactions_V2');
    } catch (e) {
        app.migration = null;
        app.ledgerActive = false;
    }
}

/**
 * Saves the Omad state. `telegramReport` names a *business operation*
 * ("this entry group was created/updated", "this one was deleted");
 * the server composes and queues the actual Telegram message. The
 * browser can no longer ask the backend to send arbitrary text.
 */
async function saveCloud(telegramReport = null) {
    showLoader(true);
    try {
        app.tenants = (Array.isArray(app.tenants) ? app.tenants : []).map(normalizeTenantObject);
        app.templateExpenses = getTemplateExpenses();
        // Only the persisted collections - not the client-side migration flags.
        const body = {
            action: 'save_omad',
            transactions: app.transactions,
            tenants: app.tenants,
            rates: app.rates,
            templateExpenses: app.templateExpenses
        };
        if (telegramReport) body.telegramReport = telegramReport;

        // Throws on a transport failure, a non-200, or an unparsable body.
        const result = await callBackend(body);
        if (!isSuccessResponse(result)) {
            // Apps Script reports its own failures inside a 200 response, so
            // this is the only place the outcome is actually known.
            throw new Error((result && result.message) || SAVE_FAILED_MESSAGE);
        }
        return result;
    } finally {
        showLoader(false);
        renderAll();
    }
}

/**
 * A save whose result nobody is waiting on - settings screens, where the edit
 * is already on screen. It still has to say so when the server refused, which
 * is why it cannot simply be ignored.
 */
function saveCloudInBackground(telegramReport = null) {
    return saveCloud(telegramReport).catch(error => {
        console.error(error);
        alert(error && error.message ? error.message : SAVE_FAILED_MESSAGE);
    });
}
