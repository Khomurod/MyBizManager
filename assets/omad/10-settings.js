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

/** Planned expenses with their schedule spelled out, newest start first. */
function renderPlannedExpenseList() {
    const box = document.getElementById('templateExpenseList');
    if(!box) return;

    const period = currentPeriod();

    box.innerHTML = app.templateExpenses.length
        ? app.templateExpenses.map(expense => {
            const occurrence = plannedExpenseOccurrence(expense, period);
            return `
            <div class="bg-slate-50 p-3 rounded-lg text-xs border" data-expense="${expense.id}">
                <div class="flex justify-between items-start gap-2">
                    <div class="min-w-0">
                        <p class="font-bold text-slate-700 truncate">${escapeHTML(expense.name)}</p>
                        <p class="expense-schedule text-[10px] text-slate-400">${escapeHTML(describePlannedExpense(expense))}</p>
                        <p class="text-slate-600 mt-1">${expense.amount.toLocaleString()} ${expense.currency}</p>
                        ${occurrence
                            ? `<p class="text-[10px] text-blue-600 font-bold mt-1">${periodShortLabel(period)}: ${occurrence}-marta</p>`
                            : `<p class="text-[10px] text-slate-300 mt-1">${periodShortLabel(period)}: kutilmaydi</p>`}
                        ${expense.description ? `<p class="text-[10px] text-slate-400 mt-1">${escapeHTML(expense.description)}</p>` : ''}
                    </div>
                    <div class="flex gap-3 shrink-0">
                        <button onclick="editTemplateExpense('${expense.id}')" class="text-blue-400"><i class="fas fa-pen"></i></button>
                        <button onclick="removeTemplateExpense('${expense.id}')" class="text-red-400"><i class="fas fa-trash-alt"></i></button>
                    </div>
                </div>
            </div>`;
        }).join('')
        : `<div class="text-center text-xs font-bold text-slate-400 py-4 bg-slate-50 rounded-lg border border-dashed">Rejali chiqimlar yo'q</div>`;
}

/** Frequency options and the month toggles, built once. */
function initPlannedExpenseControls() {
    const frequency = document.getElementById('templateExpenseFrequency');
    if(frequency && frequency.options.length === 0) {
        frequency.innerHTML = EXPENSE_FREQUENCIES
            .map(f => `<option value="${f.value}">${f.label}</option>`).join('');
    }

    const toggles = document.getElementById('expenseMonthToggles');
    if(toggles && toggles.children.length === 0) {
        toggles.innerHTML = MONTH_SHORT_LABELS.map((label, index) =>
            `<button type="button" data-month="${index + 1}" onclick="toggleExpenseMonth(this)"
                class="expense-month-toggle border border-slate-200 rounded-md py-1 text-[10px] font-bold bg-white text-slate-600 active:scale-95 transition-all">${label}</button>`
        ).join('');
    }

    const endPeriod = document.getElementById('templateExpenseEndPeriod');
    if(endPeriod) {
        const previous = endPeriod.value;
        endPeriod.innerHTML = periodOptions("");
        endPeriod.value = previous;
    }
}

function renderSettings() {
    app.rates = normalizeRatesMap(app.rates);
    app.tenants = (Array.isArray(app.tenants) ? app.tenants : []).map(normalizeTenantObject);
    app.templateExpenses = getTemplateExpenses();
    renderRatesOverview();
    renderTenantList();

    initPlannedExpenseControls();
    renderPlannedExpenseList();

}
