'use strict';

// ==========================================================
// Application shell
// ----------------------------------------------------------
// Tab switching, the loader, selectors and bootstrap.
// ==========================================================

// --- RENDER ---
function renderAll() {
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

function initSelectors() {
    const now = new Date();
    const currentM = months[now.getMonth()];
    const dashSel = document.getElementById('dashMonthSelect');
    dashSel.innerHTML = `<option>Jami Davr</option>` + months.map(m => `<option ${m===currentM ? 'selected' : ''}>${m}</option>`).join('');
    document.getElementById('entryMonth').innerHTML = months.map(m => `<option ${m===currentM ? 'selected' : ''}>${m}</option>`).join('');
    document.getElementById('settingMonth').innerHTML = months.map(m => `<option ${m===currentM ? 'selected' : ''}>${m}</option>`).join('');
    document.getElementById('templateExpenseMonth').innerHTML = months.map(m => `<option ${m===currentM ? 'selected' : ''}>${m}</option>`).join('');
    populateRateInputs();
}

// Telegram report text is composed on the server (see
// buildOmadGroupReportMessage_ in script.gs), so there is exactly one
// implementation of the report format.

window.onload = () => {
    initSelectors();
    syncData();
};
