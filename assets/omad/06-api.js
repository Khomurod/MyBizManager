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

/** How old a stored dashboard snapshot may be before it is not shown at all. */
const OMAD_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Ends the session. Only ever called when the *server* says it has expired. */
function requireAccess() {
    signOut();
}

/**
 * One request to Apps Script, returning the parsed JSON body.
 *
 * The same transport every other screen uses (`callApi`), with one difference
 * this app relies on everywhere: a *refusal* comes back as the body rather than
 * as an exception, because most callers here already read `status` and
 * `message` off it and act on them. A transport failure, an unparsable answer
 * and a non-200 still throw, because there is no body to read.
 *
 * The session token rides on every request. A payload that supplies its own
 * admin key - the field in Sozlamalar, kept for maintenance work - keeps it,
 * so a key can still be tried without signing out.
 */
async function callBackend(payload) {
    try {
        return await callApi(GOOGLE_APP_URL, payload);
    } catch (error) {
        if (error && error.body) return error.body;
        throw error;
    }
}

/** True when the server said this session is over, rather than merely busy. */
function isAuthExpiredResponse(body) {
    return !!(body && body.status === 'error' && body.authExpired === true);
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

/**
 * Paints the dashboard from the last answer that worked, before asking for a
 * new one.
 *
 * An Apps Script round trip is seconds, and until it returned this screen was
 * blank. The snapshot is display only and is replaced wholesale the moment the
 * live answer arrives; every save still goes to the server and every figure is
 * recomputed from whatever the server last said.
 */
function hydrateFromSnapshot() {
    const snapshot = readSnapshot('omad', OMAD_SNAPSHOT_MAX_AGE_MS);
    if (!snapshot || !snapshot.value) return false;
    const stored = snapshot.value;
    if (!Array.isArray(stored.transactions)) return false;

    app.transactions = stored.transactions;
    app.rates = normalizeRatesMap(stored.rates || {});
    app.tenants = (stored.tenants || []).map(normalizeTenantObject);
    app.templateExpenses = Array.isArray(stored.templateExpenses)
        ? stored.templateExpenses.map(normalizeTemplateExpense)
        : [];
    app.migration = stored.migration || null;
    app.ledgerActive = !!(app.migration && app.migration.activeSheet === 'Omad_Transactions_V2');
    app.snapshotAt = snapshot.savedAt;
    renderAll();
    return true;
}

// --- CLOUD ---
async function syncData() {
    const hadSnapshot = hydrateFromSnapshot();
    showLoader(!hadSnapshot);
    try {
        // An authenticated POST, not the old anonymous GET: a GET puts its
        // parameters in the URL, which is where a credential must never be.
        const data = await callBackend({ action: 'get_omad_data' });
        // Only an expired or refused session sends anybody back to the login
        // page. A rate limit or a server fault leaves the screen exactly as it
        // is - with the previous figures, which are the last true ones.
        if (isAuthExpiredResponse(data)) {
            requireAccess();
            return;
        }
        if (data && data.status === 'error') {
            throw new Error(data.message || SAVE_FAILED_MESSAGE);
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

            // The migration status used to be a second request fired the
            // moment this one returned - another Apps Script round trip before
            // the dashboard could decide whether the ledger was live. It is
            // four property reads, so it rides along with the data now. The
            // separate call remains for an older backend that does not send it.
            if (remote.migration) {
                app.migration = remote.migration;
                app.ledgerActive = app.migration.activeSheet === 'Omad_Transactions_V2';
            } else {
                await loadMigrationState();
            }

            app.snapshotAt = 0;
            app.loadError = '';
            writeSnapshot('omad', {
                transactions: app.transactions,
                rates: app.rates,
                tenants: app.tenants,
                templateExpenses: app.templateExpenses,
                migration: app.migration
            });
        }
    } catch (e) {
        // Whatever was on screen stays on screen. Emptying it would replace
        // real figures with zeroes, which reads as "the money is gone".
        console.error('Omad sync failed', e);
        app.loadError = (e && e.message) || SAVE_FAILED_MESSAGE;
    }
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
