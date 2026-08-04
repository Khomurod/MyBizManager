'use strict';

// ==========================================================
// Transaction history
// ----------------------------------------------------------
// The Tarix tab and the all-expenses modal.
// ==========================================================

function renderHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = "";
    [...app.transactions].reverse().forEach(t => {
        const div = document.createElement('div');
        div.className = "bg-white p-3 rounded-lg border border-slate-100 shadow-sm flex justify-between items-center";
        div.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-1 h-8 rounded-full ${t.type === 'Income' ? 'bg-green-400' : 'bg-red-400'}"></div>
                <div><p class="font-bold text-slate-700 text-sm">${t.tenant}</p><p class="text-[10px] text-slate-400">${t.date} • ${t.month}</p></div>
            </div>
            <div class="flex items-center gap-3">
                <div class="text-right"><p class="font-bold text-slate-700 text-sm">${t.amount.toLocaleString()} ${t.currency}</p><p class="text-[10px] text-slate-400">${t.method}</p></div>
                <button onclick="editTx('${t.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-blue-600"><i class="fas fa-pen text-xs"></i></button>
                <button onclick="deleteTx('${t.id}')" class="bg-slate-50 p-2 rounded text-slate-400 hover:text-red-500"><i class="fas fa-trash text-xs"></i></button>
            </div>`;
        list.appendChild(div);
    });
}

function openExpenseModal() {
    expenseModalOpen = true;
    document.getElementById('expenseMonthFilter').innerHTML = `<option value="Jami Davr">Jami Davr</option>` + months.map(m => `<option value="${m}">${m}</option>`).join('');
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
        .filter(t => t.type === 'Expense' && (period === 'Jami Davr' || t.month === period))
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
                    <p class="text-[11px] text-slate-400">${t.date} • ${t.month}</p>
                </div>
                <p class="font-bold text-red-600 text-sm">${t.amount.toLocaleString()} ${t.currency}</p>
            </div>
            <p class="text-[11px] text-slate-500 mt-1">${t.comment || "Izoh yo'q"}</p>
        </div>
    `).join('');
}
