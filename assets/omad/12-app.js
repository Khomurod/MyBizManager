'use strict';

// ==========================================================
// Application shell
// ----------------------------------------------------------
// Tab switching, the loader, selectors and bootstrap.
// ==========================================================

// --- RENDER ---
function renderAll() {
    initSelectors();
    renderDashboard();
    renderHistory();
    renderSettings();
    renderEntryDropdowns();
    renderSyncBanner();
}

/**
 * Says when the figures are not the server's latest.
 *
 * Shown rather than hidden, because the alternative to a stale figure with a
 * warning is a blank screen or a zero, and a zero on an accounting dashboard
 * is a statement about money.
 */
function renderSyncBanner() {
    const banner = document.getElementById('syncBanner');
    if (!banner) return;

    if (app.loadError) {
        // The commonest way to end up on a snapshot is a load that just failed,
        // so this branch has to carry the "saving is off" note too - otherwise
        // it is only ever shown in the case nobody is in.
        const savingOff = app.snapshotAt ? " Saqlash vaqtincha o'chirilgan." : '';
        banner.className = 'card border-amber-300 bg-amber-50 text-amber-800 text-xs font-bold';
        banner.innerHTML = `Ma'lumot yangilanmadi: ${escapeHtmlText(app.loadError + savingOff)}
            <button onclick="syncData()" class="ml-2 underline">Qayta urinish</button>`;
        banner.classList.remove('hidden');
        return;
    }
    if (app.snapshotAt) {
        // Saying that saving is off matters as much as saying the figures are
        // old: the screen looks ordinary, and somebody would otherwise find out
        // by pressing Save.
        banner.className = 'card border-slate-200 bg-slate-50 text-slate-500 text-xs font-bold';
        banner.textContent =
            "Saqlangan ma'lumot ko'rsatilmoqda, yangilanmoqda... Saqlash vaqtincha o'chirilgan.";
        banner.classList.remove('hidden');
        return;
    }
    banner.classList.add('hidden');
}


function switchTab(t) {
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
    document.getElementById('tab-'+t).classList.add('active');
    document.getElementById('nav-'+t).classList.add('active');
    // The ledger is not downloaded with the dashboard any more; the first page
    // of it is fetched when somebody actually opens Tarix.
    if (t === 'history') ensureHistoryLoaded();
    if (t === 'settings') {
        showSettingsSection(activeSettingsSection);
        loadTelegramSettings();
    }
}

/** Which Sozlamalar section is open. Remembered across tab switches. */
let activeSettingsSection = 'rates';

const SETTINGS_SECTIONS = ['rates', 'tenants', 'expenses', 'telegram', 'system'];

function showSettingsSection(section) {
    activeSettingsSection = SETTINGS_SECTIONS.includes(section) ? section : 'rates';

    SETTINGS_SECTIONS.forEach(name => {
        const panel = document.getElementById('settings-' + name);
        if (panel) panel.classList.toggle('hidden', name !== activeSettingsSection);
    });
    document.querySelectorAll('.settings-nav-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.section === activeSettingsSection);
    });

    // The system panel is the only one that needs a server round trip.
    if (activeSettingsSection === 'system') loadSystemStatus();
    if (activeSettingsSection === 'rates') renderRatesOverview();
}

function logout() {
    signOut();
}

function showLoader(show) { document.getElementById('loader').style.display = show ? 'flex' : 'none'; }

/**
 * Rebuilds every period selector. Called on load and again after each sync,
 * because the set of periods that has data grows as transactions arrive.
 */
function initSelectors() {
    const keep = id => {
        const element = document.getElementById(id);
        return element && element.value ? element.value : "";
    };

    const dashSelected = keep('dashMonthSelect') || currentPeriod();
    const entrySelected = keep('entryMonth') || currentPeriod();
    const expenseSelected = keep('templateExpenseMonth') || currentPeriod();

    document.getElementById('dashMonthSelect').innerHTML =
        periodOptions(dashSelected, { includeAll: true });
    document.getElementById('entryMonth').innerHTML = periodOptions(entrySelected);
    document.getElementById('templateExpenseMonth').innerHTML = periodOptions(expenseSelected);

    initRateSelectors();
}

// Telegram report text is composed on the server (see
// buildOmadGroupReportMessage_ in script.gs), so there is exactly one
// implementation of the report format.

// ------------------------------------------------------- write responsiveness
// Financial writes are complete the moment the backend confirms the ledger row
// is stored. A fresh dashboard and the Telegram group card are useful follow-up
// work, but neither is a reason to keep the Save button blocked after that
// confirmation.

/** The batch action is a write too, so a stale dashboard may never submit it. */
OMAD_WRITE_ACTIONS.add('create_transaction_batch');

/**
 * Refresh the confirmed view after releasing the entry form. Telegram needs no
 * browser nudge: its durable queue is drained by the existing time trigger.
 */
let omadWriteRefreshInFlight_ = false;
let omadWriteRefreshPending_ = false;

async function runPendingOmadWriteRefresh_() {
    if (omadWriteRefreshInFlight_) return;
    omadWriteRefreshInFlight_ = true;
    try {
        // Coalesce rapid saves without losing the refresh for the latest one. If
        // another save lands while a refresh is running, one more pass follows.
        while (omadWriteRefreshPending_) {
            omadWriteRefreshPending_ = false;
            await syncData({ background: true });
        }
    } finally {
        omadWriteRefreshInFlight_ = false;
    }
}

function settleOmadWriteInBackground_() {
    omadWriteRefreshPending_ = true;
    setTimeout(() => { runPendingOmadWriteRefresh_(); }, 0);
}

/**
 * Never make an accounting save wait for Telegram. The queue is written before
 * the response and the existing trigger sends it independently afterwards.
 */
var callBackendBeforeWritePerf_ = callBackend;
callBackend = async function(payload) {
    const body = { ...(payload || {}) };
    const action = String(body.action || '');
    if (action === 'create_transaction_batch' || action === 'create_transaction' ||
        action === 'correct_transaction' || action === 'cancel_transaction' ||
        action === 'tenant_paid_expense' || action === 'save_omad') {
        body.deferReports = true;
    }
    return callBackendBeforeWritePerf_(body);
};

/** An old Apps Script deployment can safely handle the same cart line by line. */
async function submitNewLedgerEntryLegacyFallback_(requestBase, groupId, common) {
    for(let i = 0; i < cart.length; i++) {
        const response = await callBackend({
            action: 'create_transaction',
            requestId: `${requestBase}_${i}`,
            groupId,
            ...common,
            amount: Number(cart[i].amount) || 0,
            currency: cart[i].currency,
            method: cart[i].method
        });
        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || 'save failed');
        }
    }
}

/**
 * New ledger entries are one business action, so send their cart lines as one
 * backend operation. During a deployment Cloudflare can briefly update before
 * Apps Script; only an explicit "Unknown action" falls back to the old proven
 * line-by-line API. Any real validation/write error is surfaced and never
 * retried through a different path.
 *
 * Edits keep the existing correct/cancel semantics line by line, but they also
 * stop waiting for Telegram and the post-save dashboard refresh.
 */
submitViaLedger = async function() {
    const requestBase = nextRequestBase();
    const common = currentEntryCommon();
    const editId = document.getElementById('editId').value;
    const groupId = editId ? editingGroupId(editId) : nextEntryGroupId();
    const existingIds = editId ? entryGroupRows(groupId).map(t => t.id) : [];

    showLoader(true);
    try {
        if (!editId) {
            const response = await callBackend({
                action: 'create_transaction_batch',
                requestId: requestBase,
                groupId,
                ...common,
                lines: cart.map(item => ({
                    amount: Number(item.amount) || 0,
                    currency: item.currency,
                    method: item.method
                }))
            });

            if (response && response.status === 'error' &&
                /unknown action/i.test(String(response.message || ''))) {
                await submitNewLedgerEntryLegacyFallback_(requestBase, groupId, common);
            } else if (!response || response.status !== 'success') {
                throw new Error((response && response.message) || 'save failed');
            }
        } else {
            for(let i = 0; i < cart.length; i++) {
                const line = {
                    requestId: `${requestBase}_${i}`,
                    groupId,
                    ...common,
                    amount: Number(cart[i].amount) || 0,
                    currency: cart[i].currency,
                    method: cart[i].method
                };

                const response = i < existingIds.length
                    ? await callBackend({ action: 'correct_transaction', transactionId: existingIds[i], ...line })
                    : await callBackend({ action: 'create_transaction', ...line });

                if(!response || response.status !== 'success') {
                    throw new Error((response && response.message) || 'save failed');
                }
            }

            for(let i = cart.length; i < existingIds.length; i++) {
                const response = await callBackend({
                    action: 'cancel_transaction',
                    transactionId: existingIds[i],
                    requestId: `${requestBase}_cancel_${i}`,
                    reason: 'entry edited'
                });
                if(!response || response.status !== 'success') {
                    throw new Error((response && response.message) || 'save failed');
                }
            }
        }
    } finally {
        showLoader(false);
    }

    settleOmadWriteInBackground_();
};

/** Tenant-paid is already atomic on the backend; release the UI before refresh/reporting. */
submitTenantPaid = async function() {
    const amount = parseMoneyInput(document.getElementById('tempAmount').value);
    if(!Number.isFinite(amount) || amount <= 0) return alert("To'g'ri summa kiriting");

    const purpose = document.getElementById('entryComment').value.trim();
    if(!purpose) return alert("Chiqim maqsadini kiriting (masalan: Elektrik xizmati)");

    const btn = document.getElementById('submitBtn');
    if(btn.disabled) return;
    btn.disabled = true; btn.innerText = "Bajarilmoqda...";
    showLoader(true);

    try {
        const response = await callBackend({
            action: 'tenant_paid_expense',
            requestId: nextRequestBase(),
            groupId: nextEntryGroupId(),
            replaceGroupId: editingTenantPaidGroupId,
            tenant: normalizeTenantName(document.getElementById('entryTenant').value),
            period: document.getElementById('entryMonth').value,
            amount,
            currency: document.getElementById('tempCurr').value,
            method: document.getElementById('tempMethod').value,
            comment: purpose,
            source: 'Web',
            createdBy: localStorage.getItem('omad_user') || 'web'
        });

        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || SAVE_FAILED_MESSAGE);
        }

        clearPendingRequest();
        editingTenantPaidGroupId = "";
        editingGroupRows = { groupId: '', rows: [] };
        document.getElementById('tempAmount').value = "";
        document.getElementById('entryComment').value = "";
        document.getElementById('cancelEditBtn').classList.add('hidden');
        switchTab('dash');
        settleOmadWriteInBackground_();
    } catch (error) {
        console.error(error);
        alert((error && error.message) || SAVE_FAILED_MESSAGE);
    } finally {
        showLoader(false);
        btn.disabled = false;
        btn.innerText = "IJARACHI TO'LOVINI SAQLASH";
    }
};

window.onload = () => {
    initSelectors();
    attachMoneyFormatting();
    syncData();
};