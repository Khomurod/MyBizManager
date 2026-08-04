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

/**
 * One card per tenant, showing the agreement window, whether it is live, and
 * the rent that actually applies this month.
 */
function renderTenantList() {
    const box = document.getElementById('settingsTenantList');
    if(!box) return;

    const period = currentPeriod();

    box.innerHTML = app.tenants.length ? app.tenants.map((t, i) => {
        const rentNow = effectiveTenantRent(t, period);
        const source = tenantRentSource(t, period);
        const window = [
            t.startPeriod ? periodShortLabel(t.startPeriod) : "boshidan",
            t.endPeriod ? periodShortLabel(t.endPeriod) : "muddatsiz"
        ].join(" — ");

        const disabledMonths = getDisabledMonths(t);
        const legacyMonths = disabledMonths.length ? `
            <div class="grid grid-cols-4 gap-1 mt-2">
                ${MONTH_LABELS.map((month, monthIndex) => {
                    const disabled = disabledMonths.includes(month);
                    return `<button onclick="toggleTenantMonth(${i}, '${month}')"
                        class="${disabled ? 'bg-red-50 text-red-500 border-red-200' : 'bg-green-50 text-green-700 border-green-200'} border rounded-md py-1 text-[10px] font-bold active:scale-95 transition-all">
                        ${MONTH_SHORT_LABELS[monthIndex]}</button>`;
                }).join('')}
            </div>` : '';

        return `
        <div class="bg-slate-50 p-3 rounded-lg text-xs border ${t.active ? '' : 'opacity-60'}" data-tenant="${escapeHTML(t.name)}">
            <div class="flex justify-between items-start gap-2">
                <div class="min-w-0">
                    <p class="font-bold text-slate-700 truncate">${escapeHTML(t.name)}
                        ${t.active ? '' : '<span class="text-[10px] font-normal text-slate-400">(faol emas)</span>'}
                    </p>
                    <p class="text-[10px] text-slate-400">${window}</p>
                    <p class="tenant-current-rent text-[11px] text-slate-600 mt-1">
                        ${periodShortLabel(period)}:
                        <b>${rentNow > 0 ? `${rentNow.toLocaleString()} ${t.currency}` : "ijara yo'q"}</b>
                        <span class="text-slate-400">(${RENT_SOURCE_LABELS[source] || source})</span>
                    </p>
                </div>
                <div class="flex gap-3 shrink-0">
                    <button onclick="openTenantSchedule(${i})" title="Jadval" class="text-slate-500"><i class="fas fa-calendar-alt"></i></button>
                    <button onclick="editTenant(${i})" title="Tahrirlash" class="text-blue-400"><i class="fas fa-pen"></i></button>
                    ${t.active
                        ? `<button onclick="removeTenant(${i})" title="Faolsizlantirish" class="text-red-400"><i class="fas fa-times"></i></button>`
                        : `<button onclick="reactivateTenant(${i})" title="Qayta faollashtirish" class="text-green-500"><i class="fas fa-undo"></i></button>`}
                </div>
            </div>
            ${legacyMonths}
        </div>`;
    }).join('') : `<p class="text-xs text-slate-400">Ijarachi qo'shilmagan.</p>`;

    populateTenantPeriodSelectors();
}

/** Start/end selectors allow "not set", which means open-ended. */
function populateTenantPeriodSelectors() {
    const options = `<option value="">Belgilanmagan</option>` + periodOptions("");
    ['newTenantStart', 'newTenantEnd'].forEach(id => {
        const select = document.getElementById(id);
        if(!select) return;
        const previous = select.value;
        select.innerHTML = options;
        select.value = previous;
    });
}

function renderSettings() {
    app.rates = normalizeRatesMap(app.rates);
    app.tenants = (Array.isArray(app.tenants) ? app.tenants : []).map(normalizeTenantObject);
    app.templateExpenses = getTemplateExpenses();
    renderRatesOverview();
    renderTenantList();

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
