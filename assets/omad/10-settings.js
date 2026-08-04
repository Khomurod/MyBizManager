'use strict';

// ==========================================================
// Settings navigation & rendering
// ----------------------------------------------------------
// Renders the Sozlamalar sections from the current app state.
// ==========================================================

/** Every month of the selected year, so gaps are visible rather than implied. */
function renderRatesOverview() {
    const list = document.getElementById('ratesList');
    if(!list) return;

    const year = periodYear(selectedRatePeriod()) || currentYear();
    const label = document.getElementById('ratesOverviewYear');
    if(label) label.textContent = String(year);

    list.innerHTML = periodsInYear(year).map(period => {
        const entry = findRateEntry(period);
        if(!entry) {
            return `<div class="flex justify-between gap-2 py-0.5">
                        <span class="text-slate-400">${MONTH_LABELS[periodMonth(period) - 1]}</span>
                        <span class="text-slate-300">belgilanmagan</span>
                    </div>`;
        }
        return `<div class="flex justify-between gap-2 py-0.5">
                    <span class="text-slate-500">${MONTH_LABELS[periodMonth(period) - 1]}</span>
                    <span class="text-slate-700 font-bold whitespace-nowrap">
                        ${entry.buy.toLocaleString()} / ${entry.sell.toLocaleString()}
                    </span>
                </div>`;
    }).join('');

    populateRateInputs();
}

function renderSettings() {
    app.rates = normalizeRatesMap(app.rates);
    app.tenants = (Array.isArray(app.tenants) ? app.tenants : []).map(normalizeTenantObject);
    app.templateExpenses = getTemplateExpenses();
    renderRatesOverview();
    document.getElementById('settingsTenantList').innerHTML = app.tenants.map((t, i) => {
        const disabledMonths = getDisabledMonths(t);
        const monthButtons = MONTH_LABELS.map((month, monthIndex) => {
            const disabled = disabledMonths.includes(month);
            const btnClass = disabled
                ? "bg-red-50 text-red-500 border-red-200"
                : "bg-green-50 text-green-700 border-green-200";
            const icon = disabled ? "fa-toggle-off" : "fa-toggle-on";
            return `<button onclick="toggleTenantMonth(${i}, '${month}')" class="${btnClass} border rounded-md py-1 text-[10px] font-bold active:scale-95 transition-all"><i class="fas ${icon} mr-1"></i>${MONTH_SHORT_LABELS[monthIndex]}</button>`;
        }).join('');

        return `
        <div class="bg-slate-50 p-3 rounded text-xs mb-2 border">
            <div class="flex justify-between items-center gap-2 mb-2">
                <div><span class="font-bold">${escapeHTML(t.name)}</span> <span class="text-slate-500">(${t.rent} ${t.currency})</span></div>
                <div class="flex gap-3">
                    <button onclick="editTenant(${i})" class="text-blue-400"><i class="fas fa-pen"></i></button>
                    <button onclick="removeTenant(${i})" class="text-red-400"><i class="fas fa-times"></i></button>
                </div>
            </div>
            <div class="grid grid-cols-4 gap-1">
                ${monthButtons}
            </div>
        </div>
    `;
    }).join('');

    const templateList = document.getElementById('templateExpenseList');
    templateList.innerHTML = app.templateExpenses.length
        ? app.templateExpenses.map(expense => `
            <div class="flex justify-between items-center bg-slate-50 p-3 rounded-lg text-xs border">
                <div class="min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="bg-blue-50 text-blue-600 px-2 py-0.5 rounded font-bold whitespace-nowrap">${periodShortLabel(recordPeriod(expense))}</span>
                        <span class="font-bold text-slate-700 truncate">${escapeHTML(expense.name)}</span>
                    </div>
                    <p class="text-slate-500 mt-1">${Number(expense.amount || 0).toLocaleString()} ${expense.currency}</p>
                </div>
                <button onclick="removeTemplateExpense('${expense.id}')" class="text-red-400 bg-white border border-slate-100 rounded-lg w-8 h-8 active:scale-95 transition-all"><i class="fas fa-trash-alt"></i></button>
            </div>
        `).join('')
        : `<div class="text-center text-xs font-bold text-slate-400 py-4 bg-slate-50 rounded-lg border border-dashed">Shablon chiqimlar yo'q</div>`;
}
