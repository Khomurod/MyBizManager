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
            return `<div class="ui-stat-row">
                        <span class="text-slate-500">${MONTH_LABELS[periodMonth(period) - 1]}</span>
                        <span class="text-slate-400">belgilanmagan</span>
                    </div>`;
        }
        return `<div class="ui-stat-row">
                    <span class="text-slate-600">${MONTH_LABELS[periodMonth(period) - 1]}</span>
                    <span class="ui-figure whitespace-nowrap text-slate-900">
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
            <div class="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                ${MONTH_LABELS.map((month, monthIndex) => {
                    const disabled = disabledMonths.includes(month);
                    return `<button onclick="toggleTenantMonth(${i}, '${month}')" aria-pressed="${!disabled}"
                        class="${disabled ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'} h-9 rounded-lg border text-xs font-semibold transition-colors">
                        ${MONTH_SHORT_LABELS[monthIndex]}</button>`;
                }).join('')}
            </div>` : '';

        return `
        <div class="rounded-xl border border-slate-200 bg-white p-3 text-sm ${t.active ? '' : 'bg-slate-50'}" data-tenant="${escapeHTML(t.name)}">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <p class="flex flex-wrap items-center gap-2 font-semibold text-slate-900"><span class="truncate">${escapeHTML(t.name)}</span>
                        ${t.active ? '<span class="ui-badge ui-badge-success">Faol</span>' : '<span class="ui-badge ui-badge-neutral">faol emas</span>'}
                    </p>
                    <p class="mt-0.5 text-xs text-slate-500">${window}</p>
                    <p class="tenant-current-rent mt-1 text-sm text-slate-700">
                        ${periodShortLabel(period)}:
                        <b class="tabular">${rentNow > 0 ? `${rentNow.toLocaleString()} ${t.currency}` : "ijara yo'q"}</b>
                        <span class="text-xs text-slate-500">(${RENT_SOURCE_LABELS[source] || source})</span>
                    </p>
                </div>
                <div class="flex shrink-0 gap-1">
                    <button onclick="openTenantSchedule(${i})" title="Jadval" aria-label="Ijara jadvali" class="ui-icon-btn size-9">${uiIcon('calendar-days', 'ui-icon-sm')}</button>
                    <button onclick="editTenant(${i})" title="Tahrirlash" aria-label="Tahrirlash" class="ui-icon-btn size-9 hover:text-blue-600">${uiIcon('pencil', 'ui-icon-sm')}</button>
                    ${t.active
                        ? `<button onclick="removeTenant(${i})" title="Faolsizlantirish" aria-label="Faolsizlantirish" class="ui-icon-btn size-9 hover:border-red-200 hover:bg-red-50 hover:text-red-600">${uiIcon('ban', 'ui-icon-sm')}</button>`
                        : `<button onclick="reactivateTenant(${i})" title="Qayta faollashtirish" aria-label="Qayta faollashtirish" class="ui-icon-btn size-9 hover:text-emerald-600">${uiIcon('rotate-ccw', 'ui-icon-sm')}</button>`}
                </div>
            </div>
            ${legacyMonths}
        </div>`;
    }).join('') : `<div class="ui-empty">${uiIcon('building-2')}Ijarachi qo'shilmagan.</div>`;

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
            <div class="rounded-xl border border-slate-200 bg-white p-3 text-sm" data-expense="${expense.id}">
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <p class="truncate font-semibold text-slate-900">${escapeHTML(expense.name)}</p>
                        <p class="expense-schedule text-xs text-slate-500">${escapeHTML(describePlannedExpense(expense))}</p>
                        <p class="ui-figure mt-1 text-slate-900">${expense.amount.toLocaleString()} ${expense.currency}</p>
                        ${occurrence
                            ? `<span class="ui-badge ui-badge-brand mt-1.5">${periodShortLabel(period)}: ${occurrence}-marta</span>`
                            : `<span class="ui-badge ui-badge-neutral mt-1.5">${periodShortLabel(period)}: kutilmaydi</span>`}
                        ${expense.description ? `<p class="mt-1 text-xs text-slate-500">${escapeHTML(expense.description)}</p>` : ''}
                    </div>
                    <div class="flex shrink-0 gap-1">
                        <button onclick="editTemplateExpense('${expense.id}')" class="ui-icon-btn size-9 hover:text-blue-600" aria-label="Tahrirlash" title="Tahrirlash">${uiIcon('pencil', 'ui-icon-sm')}</button>
                        <button onclick="removeTemplateExpense('${expense.id}')" class="ui-icon-btn size-9 hover:border-red-200 hover:bg-red-50 hover:text-red-600" aria-label="O'chirish" title="O'chirish">${uiIcon('trash-2', 'ui-icon-sm')}</button>
                    </div>
                </div>
            </div>`;
        }).join('')
        : `<div class="ui-empty rounded-xl border border-dashed border-slate-200">${uiIcon('receipt')}Rejali chiqimlar yo'q</div>`;
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
                class="expense-month-toggle h-9 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 transition-colors">${label}</button>`
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
