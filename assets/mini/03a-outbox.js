'use strict';

// ==========================================================
// The outbox: Saqlash never waits for the server
// ----------------------------------------------------------
// Pressing Saqlash used to hold the form open for the whole round trip --
// phone → Apps Script → the database and back, several seconds. Now the entry
// is written to this device first, the form closes at once, and the entry
// shows in "Oxirgi amallar" marked as being saved while it is sent in the
// background.
//
// The money rules do not move to the phone. The server still validates and
// stores every entry, and the figures on screen are still the server's: they
// change when it confirms, not before. What makes sending in the background
// safe is the request id: each entry keeps the one it was given when Saqlash
// was pressed, and the server resolves a repeated id to the record the first
// attempt created. Sending it again -- after a dropped connection, a closed
// app, a retry -- can never make a second record.
//
// An entry is in one of three states:
//
//   pending  being sent, or waiting for the connection to come back. Sent
//            again on its own: on a timer, when the phone is back online,
//            and the next time the app is opened.
//   failed   the server refused it (a validation rule, a busy moment). Shown
//            in red with the server's reason, to be retried, edited or
//            discarded -- never resent by itself, and never dropped silently.
//   saved    the server has it; kept on screen only until the next fresh
//            list arrives, so the row does not blink out and back in.
//
// The outbox belongs to the Telegram account that was verified when the entry
// was made, and is only ever sent while that same account is verified: two
// accounts on one phone never send each other's entries.
// ==========================================================

/** Delays between automatic resends while there is no connection. */
const MINI_OUTBOX_RETRY_MS = [3000, 10000, 30000, 60000];

let miniOutboxBusy = false;
let miniOutboxTimer = null;
let miniOutboxFailures = 0;
let miniOutboxOffline = false;

function miniOutboxKey() {
    return state.user && state.user.id ? `mini_outbox_${state.user.id}` : '';
}

function readMiniOutbox() {
    const key = miniOutboxKey();
    if (!key) return [];
    try {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(list) ? list.filter(item => item && item.payload && item.payload.requestId) : [];
    } catch (error) {
        return [];
    }
}

/** Whether the list was stored. A full or disabled storage says no. */
function writeMiniOutbox(list) {
    const key = miniOutboxKey();
    if (!key) return false;
    try {
        if (list.length) localStorage.setItem(key, JSON.stringify(list));
        else localStorage.removeItem(key);
        return true;
    } catch (error) {
        return false;
    }
}

function updateMiniOutboxItem(id, changes) {
    return writeMiniOutbox(readMiniOutbox().map(item => (item.id === id ? Object.assign({}, item, changes) : item)));
}

function removeMiniOutboxItem(id) {
    writeMiniOutbox(readMiniOutbox().filter(item => item.id !== id));
}

/** A fresh id for one submission: `<prefix>_<millis>_<random>`. */
function newMiniRequestId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Keeps an entry on the device and starts sending it. Returns at once.
 *
 * If it cannot be kept -- no verified account to keep it for, or storage that
 * is full or switched off -- it is sent directly instead, and a refusal
 * reopens the form with what was typed. Never dropped silently.
 */
function queueMiniEntry(action, payload) {
    const list = readMiniOutbox();
    list.push({ id: payload.requestId, action, payload, status: 'pending', error: '', at: Date.now() });
    if (!writeMiniOutbox(list) || !readMiniOutbox().some(item => item.id === payload.requestId)) {
        sendMiniEntryDirectly(action, payload);
        return;
    }
    miniDirectRetryIds = null;
    renderOmadIfShown();
    drainMiniOutbox();
}

/**
 * The ids of a direct send that did not succeed. The next Saqlash reuses them
 * -- the answer may have been lost after the server stored the entry, and a
 * fresh id would then make a second record.
 */
let miniDirectRetryIds = null;

async function sendMiniEntryDirectly(action, payload) {
    miniDirectRetryIds = { requestId: payload.requestId, groupId: payload.groupId };
    try {
        await api(action, payload);
        miniDirectRetryIds = null;
        toast('Saqlandi');
        flushReports();
        refreshOmadInBackground();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
        // The same request id goes with it again, so a retry is still one record.
        openEntrySheet(payload.type, { id: '', payload });
    }
}

/** No answer, or no answer the app can read: worth sending again as it is. */
function isMiniTransientError(error) {
    const message = String((error && error.message) || '');
    return message === NETWORK_MESSAGE || message === "Server javobi tushunarsiz.";
}

/** Sends every pending entry, one at a time, in the order they were made. */
async function drainMiniOutbox() {
    if (miniOutboxBusy || !miniOutboxKey()) return;
    miniOutboxBusy = true;
    clearTimeout(miniOutboxTimer);
    let saved = 0;
    let offline = false;
    // Each entry is sent at most once per pass, even if storage stops taking
    // the status that says it has gone.
    const sent = new Set();
    try {
        for (;;) {
            const next = readMiniOutbox().find(item => item.status === 'pending' && !sent.has(item.id));
            if (!next) break;
            sent.add(next.id);
            try {
                await api(next.action, next.payload);
                updateMiniOutboxItem(next.id, { status: 'saved', error: '' });
                saved++;
            } catch (error) {
                if (error.unauthorized) {
                    // Kept as it is: it goes out once the gate opens again.
                    failAuth(error);
                    return;
                }
                if (isMiniTransientError(error)) {
                    offline = true;
                    break;
                }
                updateMiniOutboxItem(next.id, { status: 'failed', error: String(error.message || 'Saqlanmadi') });
                toast(error.message || 'Saqlanmadi', true);
            }
        }
    } finally {
        miniOutboxBusy = false;
    }

    miniOutboxOffline = offline;
    if (offline) {
        const delay = MINI_OUTBOX_RETRY_MS[Math.min(miniOutboxFailures, MINI_OUTBOX_RETRY_MS.length - 1)];
        miniOutboxFailures++;
        miniOutboxTimer = setTimeout(drainMiniOutbox, delay);
    } else {
        miniOutboxFailures = 0;
    }

    if (saved) {
        toast(saved === 1 ? 'Saqlandi' : `${saved} ta yozuv saqlandi`);
        flushReports(saved);
        // The figures are a fresh read of what the server now holds.
        refreshOmadInBackground();
    }
    renderOmadIfShown();
}

/** Called with every fresh list from the server: what it confirmed is in it now. */
function forgetSavedMiniEntries() {
    const list = readMiniOutbox();
    const kept = list.filter(item => item.status !== 'saved');
    if (kept.length !== list.length) writeMiniOutbox(kept);
}

function retryMiniEntry(id) {
    updateMiniOutboxItem(id, { status: 'pending', error: '' });
    miniOutboxFailures = 0;
    renderOmadIfShown();
    drainMiniOutbox();
}

/** A refused entry was stored nowhere, so discarding it loses nothing the server has. */
function discardMiniEntry(id) {
    removeMiniOutboxItem(id);
    renderOmadIfShown();
}

function editMiniEntry(id) {
    const item = readMiniOutbox().find(entry => entry.id === id);
    if (!item) return;
    openEntrySheet(item.payload.type, item);
}

function renderOmadIfShown() {
    if (state.omad && document.getElementById('miniEntryList')) {
        document.getElementById('miniEntryList').innerHTML = entryRows();
    }
}

/** The outbox rows for the month on screen, newest first. */
function miniOutboxRows() {
    return readMiniOutbox()
        .filter(item => item.payload.period === state.period)
        .reverse()
        .map(item => {
            const p = item.payload;
            const sign = p.type === 'Income' ? 1 : -1;
            const amount = p.currency === 'USD'
                ? `${sign > 0 ? '+' : '−'}${escapeHtml(String(p.amount))} USD`
                : signedUzs(sign * Number(p.amount));
            let status;
            if (item.status === 'failed') {
                status = `
                    <p class="tiny" style="color:var(--danger)">${escapeHtml(item.error)}</p>
                    <div class="grid3" style="margin-top:6px">
                        <button class="btn-sm" onclick="retryMiniEntry('${escapeHtml(item.id)}')">Qayta</button>
                        <button class="btn-sm" onclick="editMiniEntry('${escapeHtml(item.id)}')">Tahrirlash</button>
                        <button class="btn-sm" onclick="discardMiniEntry('${escapeHtml(item.id)}')">O'chirish</button>
                    </div>`;
            } else if (item.status === 'saved') {
                status = `<span class="pill ok">Saqlandi</span>`;
            } else {
                status = `<span class="pill info">${miniOutboxOffline ? "Aloqa kutilmoqda..." : 'Saqlanmoqda...'}</span>`;
            }
            return `
            <div class="item" data-outbox="${escapeHtml(item.status)}">
                <div class="grow">
                    <p class="title ellipsis">${escapeHtml(p.tenant)}</p>
                    ${p.comment ? `<p class="tiny muted ellipsis">${escapeHtml(p.comment)}</p>` : ''}
                    ${status}
                </div>
                <p class="num" ${moneyClass(sign)}>${amount}</p>
            </div>`;
        }).join('');
}

// Sent again as soon as there is a reason to think it would now get through.
window.addEventListener('online', () => { miniOutboxFailures = 0; drainMiniOutbox(); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') drainMiniOutbox();
});
