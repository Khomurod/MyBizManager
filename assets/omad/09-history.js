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
 * How many business actions the Tarix tab renders at once.
 *
 * The whole ledger used to be built into the DOM on every render, and a render
 * happens after every save — so entering a payment rebuilt a card for every
 * transaction the business had ever recorded, none of which had changed. The
 * newest entries are the ones anybody is looking at; the rest arrive on
 * request. Nothing is filtered out of the *data*, only out of the first paint.
 */
const HISTORY_PAGE_SIZE = 40;

let historyVisibleGroups = HISTORY_PAGE_SIZE;

/** Shows the next page. Called from the button renderHistory appends. */
function showMoreHistory() {
    historyVisibleGroups += HISTORY_PAGE_SIZE;
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = "";

    const groups = historyGroups();
    const shown = groups.slice(0, historyVisibleGroups);

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

    if (groups.length > shown.length) {
        const more = document.createElement('button');
        more.className = "w-full mt-2 bg-white border border-slate-200 rounded-lg py-3 text-xs font-bold text-slate-500";
        more.textContent = `Yana ko'rsatish (${groups.length - shown.length} ta qoldi)`;
        more.onclick = showMoreHistory;
        list.appendChild(more);
    }
}

function openExpenseModal() {
    expenseModalOpen = true;
    document.getElementById('expenseMonthFilter').innerHTML = periodOptions(ALL_PERIODS, { includeAll: true });
    document.getElementById('expenseModal').classList.remove('hidden');
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

    if (!expenses.length) {
        list.innerHTML = `<div class="text-center text-xs font-bold text-slate-400 py-8">Chiqimlar topilmadi</div>`;
        return;
    }

    list.innerHTML = expenses.map(t => `
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
