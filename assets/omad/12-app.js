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
}

function switchTab(t) {
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
    document.getElementById('tab-'+t).classList.add('active');
    document.getElementById('nav-'+t).classList.add('active');
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
    localStorage.removeItem("omad_role");
    localStorage.removeItem("omad_token");
    localStorage.removeItem("omad_user");
    window.location.href = "login.html";
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
    syncData();
};
