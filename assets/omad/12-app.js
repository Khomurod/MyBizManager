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

window.onload = () => {
    initSelectors();
    attachMoneyFormatting();
    syncData();
};
