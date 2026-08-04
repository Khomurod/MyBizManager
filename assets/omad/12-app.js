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
    if (t === 'settings') loadTelegramSettings();
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
