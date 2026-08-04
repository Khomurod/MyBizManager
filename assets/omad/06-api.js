'use strict';

// ==========================================================
// API client
// ----------------------------------------------------------
// The single place that talks to Apps Script. Telegram reports are requested
// as business operations - the browser never composes a Telegram message.
// ==========================================================

// --- TELEGRAM LOGIC (server-proxied, no token in the browser) ---
async function callBackend(payload) {
    const res = await fetch(GOOGLE_APP_URL.trim(), {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
        return await res.json();
    } catch (e) {
        // Apps Script occasionally returns a non-JSON redirect body.
        return { status: "unknown" };
    }
}

// --- CLOUD ---
async function syncData() {
    showLoader(true);
    try {
        const res = await fetch(`${GOOGLE_APP_URL.trim()}?action=get_omad`);
        if (res.ok) {
            const data = await res.json();
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
    } catch (e) { console.log("Offline or Error"); }
    renderAll();
    showLoader(false);
}

/**
 * Saves the Omad state. `telegramReport` names a *business operation*
 * ("this entry group was created/updated", "this one was deleted");
 * the server composes and queues the actual Telegram message. The
 * browser can no longer ask the backend to send arbitrary text.
 */
async function saveCloud(telegramReport = null) {
    showLoader(true);
    let ok = false;
    try {
        app.tenants = (Array.isArray(app.tenants) ? app.tenants : []).map(normalizeTenantObject);
        app.templateExpenses = getTemplateExpenses();
        const body = { action: 'save_omad', ...app };
        if (telegramReport) body.telegramReport = telegramReport;
        const res = await fetch(GOOGLE_APP_URL.trim(), {
            method: 'POST',
            body: JSON.stringify(body)
        });
        ok = res.ok;
    } catch(e) { alert("Saqlanmadi (Internet yo'q)"); }
    showLoader(false);
    renderAll();
    return ok;
}

async function migrateToGoogleSheets() {
    const confirmed = confirm("Haqiqatan ham barcha ma'lumotlarni ko'chirmoqchimisiz?");
    if (!confirmed) return;

    const loaderMsg = document.getElementById('loaderMsg');
    const defaultLoaderText = loaderMsg.innerText;

    showLoader(true);
    loaderMsg.innerText = "Baza ko'chirilmoqda...";

    try {
        const payload = {
            action: "migrate_omad",
            transactions: app.transactions,
            tenants: app.tenants,
            rates: app.rates,
            templateExpenses: getTemplateExpenses()
        };

        const response = await fetch(GOOGLE_APP_URL.trim(), {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error("Migration request failed");

        const contentType = response.headers.get('content-type') || "";
        if (contentType.includes('application/json')) {
            await response.json();
        } else {
            await response.text();
        }
        alert("Muvaffaqiyatli yakunlandi!");
    } catch (e) {
        console.error("Google Sheets migration error:", e);
        alert("Xatolik yuz berdi. Internetni tekshiring.");
    } finally {
        showLoader(false);
        loaderMsg.innerText = defaultLoaderText;
    }
}
