'use strict';

// ==========================================================
// Transaction history
// ----------------------------------------------------------
// The Tarix tab and the all-expenses modal.
// ==========================================================

/**
 * One card per *business action*, not per row.
 *
 * A tenant-paid expense is two rows that only make sense together, so showing
 * them as two entries — an income and an unrelated-looking expense — is
 * exactly the confusion this feature exists to remove. Ordinary entries are
 * unaffected: their group is one row, or several lines the reader already
 * thinks of as one payment.
 */
function historyGroups() {
    const byGroup = new Map();
    for(const t of app.transactions) {
        const key = txGroupId(t);
        if(!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(t);
    }
    return [...byGroup.values()]
        .sort((a, b) => comparePeriods(recordPeriod(a[0]), recordPeriod(b[0])) ||
                        (Number(getTxBaseId(a[0].id)) || 0) - (Number(getTxBaseId(b[0].id)) || 0))
        .reverse();
}

function tenantPaidCardMarkup(rows) {
    const income = rows.find(r => r.type === 'Income') || rows[0];
    const expense = rows.find(r => r.type === 'Expense');
    const purpose = (expense && expense.comment) || income.comment || "";
    return `
        <div class="flex items-center gap-3 min-w-0">
            <div class="w-1 h-8 rounded-full bg-amber-400"></div>
            <div class="min-w-0">
                <p class="font-bold text-slate-700 text-sm truncate">🏢 ${income.tenant}</p>
                <p class="text-[10px] text-amber-600 font-bold">Bizning nomimizdan to'ladi</p>
                <p class="text-[10px] text-slate-400 truncate">${income.date} • ${periodLabel(recordPeriod(income))}</p>
                <p class="text-[10px] text-slate-400 truncate">${purpose}</p>
            </div>
        </div>
        <div class="flex items-center gap-3 shrink-0">
            <div class="text-right">
                <p class="font-bold text-slate-700 text-sm">${income.amount.toLocaleString()} ${income.currency}</p>
                <p class="text-[10px] text-slate-400">${income.method} • kassaga 0</p>
            </div>
            <button onclick="editTx('${income.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-blue-600"><i class="fas fa-pen text-xs"></i></button>
            <button onclick="deleteTx('${income.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-red-500"><i class="fas fa-trash text-xs"></i></button>
        </div>`;
}

function ordinaryRowMarkup(t) {
    return `
        <div class="flex items-center gap-3 min-w-0">
            <div class="w-1 h-8 rounded-full ${t.type === 'Income' ? 'bg-green-400' : 'bg-red-400'}"></div>
            <div class="min-w-0"><p class="font-bold text-slate-700 text-sm truncate">${t.tenant}</p><p class="text-[10px] text-slate-400">${t.date} • ${periodLabel(recordPeriod(t))}</p></div>
        </div>
        <div class="flex items-center gap-3 shrink-0">
            <div class="text-right"><p class="font-bold text-slate-700 text-sm">${t.amount.toLocaleString()} ${t.currency}</p><p class="text-[10px] text-slate-400">${t.method}</p></div>
            <button onclick="editTx('${t.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-blue-600"><i class="fas fa-pen text-xs"></i></button>
            <button onclick="deleteTx('${t.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-red-500"><i class="fas fa-trash text-xs"></i></button>
        </div>`;
}

/**
 * How many business actions one page of Tarix holds.
 *
 * The whole ledger used to arrive with the dashboard and be built into the DOM
 * on every render — so entering a payment rebuilt a card for every transaction
 * the business had ever recorded, none of which had changed. Now the dashboard
 * downloads no history at all and this tab asks for a page when it is opened.
 * Nothing is filtered out of the *data*: the pages together are the ledger, and
 * the button says how many actions are still behind it.
 */
const HISTORY_PAGE_SIZE = 40;

/** How many groups of an already-loaded whole list are painted at once. */
let historyVisibleGroups = HISTORY_PAGE_SIZE;

/**
 * Fetches the next page of history and appends it.
 *
 * `reset` starts again from the newest action, which is what a refresh after a
 * save needs: the rows on screen were built from a ledger the save has moved.
 */
async function loadHistoryPage(reset) {
    if (app.historyMode !== 'paged') { app.historyLoaded = true; return; }
    if (app.historyLoading) return;

    app.historyLoading = true;
    if (reset) {
        app.transactions = [];
        app.historyOffset = 0;
        app.historyLoaded = false;
    }
    renderHistory();

    try {
        const body = await callBackend({
            action: 'get_omad_history',
            offset: app.historyOffset,
            limit: HISTORY_PAGE_SIZE
        });
        if (isAuthExpiredResponse(body)) return requireAccess();
        if (!isSuccessResponse(body)) throw new Error((body && body.message) || SAVE_FAILED_MESSAGE);

        const rows = Array.isArray(body.transactions) ? body.transactions : [];
        // Appended rather than replaced, and de-duplicated by id so a repeated
        // page — a double tap, a retry — cannot show an entry twice or, worse,
        // count it twice anywhere that later reads this list.
        const seen = new Set(app.transactions.map(t => String(t.id)));
        rows.forEach(row => { if (!seen.has(String(row.id))) app.transactions.push(row); });

        app.historyOffset += Number(body.groupCount) || 0;
        app.historyTotal = Number(body.groupTotal) || 0;
        app.historyHasMore = !!body.hasMore;
        app.historyLoaded = true;
        app.historyError = '';
    } catch (error) {
        // Whatever has already been loaded stays on screen; the banner offers
        // another try. Emptying the list would read as "the entries are gone".
        console.error('history page', error);
        app.historyError = (error && error.message) || SAVE_FAILED_MESSAGE;
    } finally {
        app.historyLoading = false;
        renderHistory();
        if (expenseModalOpen) renderExpenseModal();
    }
}

/** Loads the first page the first time Tarix is opened. */
function ensureHistoryLoaded() {
    if (app.historyMode !== 'paged') return;
    if (app.historyLoaded || app.historyLoading) return;
    loadHistoryPage(true);
}

/** Shows the next page: another request when paged, more of the list when not. */
function showMoreHistory() {
    if (app.historyMode === 'paged') return loadHistoryPage(false);
    historyVisibleGroups += HISTORY_PAGE_SIZE;
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = "";

    const paged = app.historyMode === 'paged';

    if (paged && !app.historyLoaded && !app.historyLoading) {
        const hint = document.createElement('button');
        hint.className = "w-full bg-white border border-slate-200 rounded-lg py-3 text-xs font-bold text-slate-500";
        hint.textContent = "Tarixni yuklash";
        hint.onclick = () => loadHistoryPage(true);
        list.appendChild(hint);
        return;
    }

    const groups = historyGroups();
    const shown = paged ? groups : groups.slice(0, historyVisibleGroups);

    shown.forEach(rows => {
        const tenantPaid = rows.length > 0 && rows.every(isTenantPaidRow);
        const cards = tenantPaid ? [tenantPaidCardMarkup(rows)] : rows.map(ordinaryRowMarkup);
        cards.forEach(markup => {
            const div = document.createElement('div');
            div.className = "bg-white p-3 rounded-lg border border-slate-100 shadow-sm flex justify-between items-center gap-2";
            div.innerHTML = markup;
            list.appendChild(div);
        });
    });

    if (app.historyError) {
        const problem = document.createElement('div');
        problem.className = "card border-amber-300 bg-amber-50 text-amber-800 text-xs font-bold";
        problem.textContent = app.historyError;
        list.appendChild(problem);
    }

    if (app.historyLoading) {
        const busy = document.createElement('p');
        busy.className = "text-center text-xs font-bold text-slate-400 py-4";
        busy.textContent = "Yuklanmoqda...";
        list.appendChild(busy);
        return;
    }

    const remaining = paged
        ? Math.max(0, app.historyTotal - app.historyOffset)
        : groups.length - shown.length;
    const hasMore = paged ? app.historyHasMore : groups.length > shown.length;

    if (hasMore || app.historyError) {
        const more = document.createElement('button');
        more.className = "w-full mt-2 bg-white border border-slate-200 rounded-lg py-3 text-xs font-bold text-slate-500";
        more.textContent = app.historyError
            ? "Qayta urinish"
            : `Yana ko'rsatish (${remaining} ta qoldi)`;
        more.onclick = () => showMoreHistory();
        list.appendChild(more);
    }
}

function openExpenseModal() {
    expenseModalOpen = true;
    document.getElementById('expenseMonthFilter').innerHTML = periodOptions(ALL_PERIODS, { includeAll: true });
    document.getElementById('expenseModal').classList.remove('hidden');
    // The list is built out of loaded rows, so it needs them.
    ensureHistoryLoaded();
    renderExpenseModal();
}

function closeExpenseModal() {
    expenseModalOpen = false;
    document.getElementById('expenseModal').classList.add('hidden');
}

function renderExpenseModal() {
    const period = document.getElementById('expenseMonthFilter').value;
    const list = document.getElementById('expenseList');
    const expenses = app.transactions
        .filter(t => t.type === 'Expense' && matchesPeriod(t, period))
        .slice()
        .reverse();

    // This modal reads the rows that are loaded, and since history is paged
    // that may not be all of them. Saying so — with the button that fixes it —
    // is the difference between a partial list and a wrong one.
    const partial = app.historyMode === 'paged' && app.historyHasMore
        ? `<button onclick="loadHistoryPage(false)"
                class="w-full mb-2 bg-white border border-slate-200 rounded-lg py-2 text-[11px] font-bold text-slate-500">
                Yana ${Math.max(0, app.historyTotal - app.historyOffset)} ta amal yuklanmagan — yuklash
           </button>`
        : '';

    if (!expenses.length) {
        list.innerHTML = partial +
            `<div class="text-center text-xs font-bold text-slate-400 py-8">Chiqimlar topilmadi</div>`;
        return;
    }

    list.innerHTML = partial + expenses.map(t => `
        <div class="bg-slate-50 border border-slate-200 rounded-xl p-3">
            <div class="flex justify-between items-start gap-2">
                <div>
                    <p class="font-bold text-sm text-slate-700">${t.tenant}</p>
                    <p class="text-[11px] text-slate-400">${t.date} • ${periodLabel(recordPeriod(t))}</p>
                </div>
                <p class="font-bold text-red-600 text-sm">${t.amount.toLocaleString()} ${t.currency}</p>
            </div>
            <p class="text-[11px] text-slate-500 mt-1">${t.comment || "Izoh yo'q"}</p>
        </div>
    `).join('');
}
