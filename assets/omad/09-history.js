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
        <div class="flex min-w-0 flex-1 basis-48 items-start gap-3">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">${uiIcon('building-2')}</div>
            <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-slate-900">${income.tenant}</p>
                <span class="ui-badge ui-badge-warning mt-0.5 max-w-full whitespace-normal">Bizning nomimizdan to'ladi</span>
                <p class="history-meta mt-1 truncate text-xs text-slate-500">${income.date} · ${periodLabel(recordPeriod(income))}</p>
                <p class="truncate text-xs text-slate-500">${purpose}</p>
            </div>
        </div>
        <div class="shrink-0 text-right">
            <p class="ui-figure text-sm text-slate-900">${income.amount.toLocaleString()} ${income.currency}</p>
            <p class="text-xs text-slate-500">${income.method} · kassaga 0</p>
        </div>
        ${historyActionsMarkup(income.id)}`;
}

/** Edit and cancel for one business action: labelled, and big enough to tap. */
function historyActionsMarkup(id) {
    return `
            <div class="flex w-full shrink-0 justify-end gap-1 border-t border-slate-100 pt-2 sm:w-auto sm:border-0 sm:pt-0">
                <button onclick="editTx('${id}')" class="ui-icon-btn size-9 text-slate-500 hover:text-blue-600" aria-label="Tahrirlash" title="Tahrirlash">${uiIcon('pencil', 'ui-icon-sm')}</button>
                <button onclick="deleteTx('${id}')" class="ui-icon-btn size-9 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600" aria-label="Bekor qilish" title="Bekor qilish">${uiIcon('trash-2', 'ui-icon-sm')}</button>
            </div>`;
}

function ordinaryRowMarkup(t) {
    // ui-icons: arrow-down arrow-up
    const income = t.type === 'Income';
    return `
        <div class="flex min-w-0 flex-1 basis-40 items-center gap-3">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-xl ${income ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}">${uiIcon(income ? 'arrow-down' : 'arrow-up')}</div>
            <div class="min-w-0"><p class="truncate text-sm font-semibold text-slate-900">${t.tenant}</p><p class="history-meta truncate text-xs text-slate-500">${t.date} · ${periodLabel(recordPeriod(t))}</p></div>
        </div>
        <div class="shrink-0 text-right"><p class="ui-figure text-sm ${income ? 'text-emerald-700' : 'text-slate-900'}">${t.amount.toLocaleString()} ${t.currency}</p><p class="text-xs text-slate-500">${income ? 'Kirim' : 'Chiqim'} · ${t.method}</p></div>
        ${historyActionsMarkup(t.id)}`;
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
        hint.className = "ui-btn ui-btn-secondary ui-btn-block";
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
            div.className = "ui-card flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3";
            div.innerHTML = markup;
            list.appendChild(div);
        });
    });

    if (app.historyError) {
        const problem = document.createElement('div');
        problem.className = "card ui-alert ui-alert-warning";
        problem.textContent = app.historyError;
        list.appendChild(problem);
    }

    if (app.historyLoading) {
        const busy = document.createElement('p');
        busy.className = "ui-empty";
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
        more.className = "ui-btn ui-btn-secondary ui-btn-block mt-2";
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
                class="ui-btn ui-btn-secondary ui-btn-block mb-2 whitespace-normal">
                Yana ${Math.max(0, app.historyTotal - app.historyOffset)} ta amal yuklanmagan — yuklash
           </button>`
        : '';

    if (!expenses.length) {
        list.innerHTML = partial +
            `<div class="ui-empty">${uiIcon('inbox')}Chiqimlar topilmadi</div>`;
        return;
    }

    list.innerHTML = partial + expenses.map(t => `
        <div class="rounded-xl border border-slate-200 bg-white p-3">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-900">${t.tenant}</p>
                    <p class="text-xs text-slate-500">${t.date} · ${periodLabel(recordPeriod(t))}</p>
                </div>
                <p class="ui-figure shrink-0 text-sm text-red-600">${t.amount.toLocaleString()} ${t.currency}</p>
            </div>
            <p class="mt-1 text-sm text-slate-600">${t.comment || "Izoh yo'q"}</p>
        </div>
    `).join('');
}
