'use strict';

// ==========================================================
// Tenant management & rent schedules
// ----------------------------------------------------------
// A tenant's rent is effective-dated, not a single number. Mirrors
// apps-script/06_tenants.gs; both sides are tested against the same
// expectations.
//
//   defaultRent   what the agreement says
//   startPeriod   when the agreement begins ("" = always has)
//   endPeriod     when it ends ("" = open-ended)
//   rentChanges   [{ fromPeriod, amount }] - a new default from a period on
//   exceptions    [{ period, amount }] - one month at a different amount
//   noRentPeriods ["2026-12"] - one month with no rent at all
//   active        an inactive tenant is owed nothing, and can be reactivated
//
// Resolution order: outside start/end wins, then a no-rent month, then an
// exception, then the latest scheduled change, then the default.
// ==========================================================

function getDisabledMonths(tenant) {
    return tenant && Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : [];
}

/**
 * Legacy month-name switches. A disabled month repeats every year, which is
 * why the schedule fields replace it; it stays honoured so existing tenant
 * records keep behaving as their operator set them up.
 */
function isTenantDisabledForPeriod(tenant, period) {
    if (period === ALL_PERIODS) return false;
    const disabled = getDisabledMonths(tenant);
    if (disabled.length === 0) return false;
    if (disabled.includes(period)) return true;
    const monthIndex = periodMonth(period);
    return monthIndex > 0 && disabled.includes(MONTH_LABELS[monthIndex - 1]);
}

function normalizePeriodList(periods) {
    return [...new Set((Array.isArray(periods) ? periods : []).filter(isPeriod))].sort();
}

function normalizeRentChanges(changes) {
    const byPeriod = new Map();
    (Array.isArray(changes) ? changes : []).forEach(change => {
        const c = change || {};
        const amount = Number(c.amount);
        if (!isPeriod(c.fromPeriod) || !Number.isFinite(amount) || amount < 0) return;
        byPeriod.set(c.fromPeriod, amount);
    });
    return [...byPeriod.keys()].sort().map(fromPeriod => ({ fromPeriod, amount: byPeriod.get(fromPeriod) }));
}

function normalizeRentExceptions(exceptions) {
    const byPeriod = new Map();
    (Array.isArray(exceptions) ? exceptions : []).forEach(exception => {
        const e = exception || {};
        const amount = Number(e.amount);
        if (!isPeriod(e.period) || !Number.isFinite(amount) || amount < 0) return;
        byPeriod.set(e.period, amount);
    });
    return [...byPeriod.keys()].sort().map(period => ({ period, amount: byPeriod.get(period) }));
}

function normalizeTenantObject(rawTenant) {
    const tenant = typeof rawTenant === 'string'
        ? { name: rawTenant }
        : (rawTenant && typeof rawTenant === 'object' ? rawTenant : {});

    const defaultRent = tenant.defaultRent !== undefined
        ? (Number(tenant.defaultRent) || 0)
        : (Number(tenant.rent) || 0);

    return {
        name: normalizeTenantName(tenant.name),
        // `rent` is kept in step with `defaultRent` so older readers still work.
        rent: defaultRent,
        defaultRent,
        currency: tenant.currency === "UZS" ? "UZS" : "USD",
        active: tenant.active === undefined ? true : tenant.active !== false,
        startPeriod: isPeriod(tenant.startPeriod) ? tenant.startPeriod : "",
        endPeriod: isPeriod(tenant.endPeriod) ? tenant.endPeriod : "",
        rentChanges: normalizeRentChanges(tenant.rentChanges),
        exceptions: normalizeRentExceptions(tenant.exceptions),
        noRentPeriods: normalizePeriodList(tenant.noRentPeriods),
        disabledMonths: getDisabledMonths(tenant)
    };
}

/** True when the agreement covers this period at all. */
function isTenantInScheduleForPeriod(tenant, period) {
    const t = tenant || {};
    if (t.active === false) return false;
    if (!isPeriod(period)) return false;
    if (t.startPeriod && comparePeriods(period, t.startPeriod) < 0) return false;
    if (t.endPeriod && comparePeriods(period, t.endPeriod) > 0) return false;
    return true;
}

/**
 * The rent actually due in one period, in the tenant's own currency. Zero
 * means nothing is owed - which is different from "no rent configured", and
 * both are legitimate.
 */
function effectiveTenantRent(tenant, period) {
    const t = tenant || {};
    if (!isTenantInScheduleForPeriod(t, period)) return 0;
    if (isTenantDisabledForPeriod(t, period)) return 0;
    if ((t.noRentPeriods || []).includes(period)) return 0;

    const exception = (t.exceptions || []).find(e => e.period === period);
    if (exception) return Number(exception.amount) || 0;

    let amount = t.defaultRent !== undefined ? Number(t.defaultRent) || 0 : Number(t.rent) || 0;
    (t.rentChanges || []).forEach(change => {
        if (comparePeriods(change.fromPeriod, period) <= 0) amount = Number(change.amount) || 0;
    });
    return amount;
}

/** Why a period resolved the way it did - shown in the schedule editor. */
function tenantRentSource(tenant, period) {
    const t = tenant || {};
    if (t.active === false) return 'inactive';
    if (t.startPeriod && comparePeriods(period, t.startPeriod) < 0) return 'before_start';
    if (t.endPeriod && comparePeriods(period, t.endPeriod) > 0) return 'after_end';
    if (isTenantDisabledForPeriod(t, period)) return 'disabled_month';
    if ((t.noRentPeriods || []).includes(period)) return 'no_rent';
    if ((t.exceptions || []).some(e => e.period === period)) return 'exception';
    if ((t.rentChanges || []).some(c => comparePeriods(c.fromPeriod, period) <= 0)) return 'scheduled_change';
    return 'default';
}

function tenantScheduleForYear(tenant, year) {
    return periodsInYear(year).map(period => ({
        period,
        label: periodLabel(period),
        rent: effectiveTenantRent(tenant, period),
        currency: (tenant && tenant.currency) || 'USD',
        source: tenantRentSource(tenant, period)
    }));
}

const RENT_SOURCE_LABELS = {
    default: "Asosiy narx",
    scheduled_change: "Yangi narx",
    exception: "Istisno",
    no_rent: "Ijara yo'q",
    disabled_month: "O'chirilgan oy",
    before_start: "Boshlanmagan",
    after_end: "Tugagan",
    inactive: "Faol emas"
};

// ------------------------------------------------------------------- editing

function editTenant(index) {
    const t = normalizeTenantObject(app.tenants[index]);
    document.getElementById('newTenantName').value = t.name;
    document.getElementById('newTenantRent').value = formatMoneyValue(t.defaultRent);
    document.getElementById('newTenantCurr').value = t.currency;
    document.getElementById('newTenantStart').value = t.startPeriod;
    document.getElementById('newTenantEnd').value = t.endPeriod;
    document.getElementById('newTenantActive').checked = t.active;

    editingTenantIndex = index;
    const btn = document.getElementById('addTenantBtn');
    btn.innerText = "O'zgartirishni Saqlash";
    btn.classList.remove('bg-slate-800');
    btn.classList.add('bg-blue-600');
    btn.scrollIntoView({behavior: "smooth"});
}

function readTenantForm() {
    return {
        name: normalizeTenantName(document.getElementById('newTenantName').value),
        defaultRent: parseMoneyInput(document.getElementById('newTenantRent').value) || 0,
        currency: document.getElementById('newTenantCurr').value,
        startPeriod: document.getElementById('newTenantStart').value,
        endPeriod: document.getElementById('newTenantEnd').value,
        active: document.getElementById('newTenantActive').checked
    };
}

function addTenant() {
    const form = readTenantForm();
    if(!form.name) return alert("Ism kiriting");
    if(form.startPeriod && form.endPeriod && comparePeriods(form.endPeriod, form.startPeriod) < 0) {
        return alert("Tugash davri boshlanish davridan oldin bo'lishi mumkin emas.");
    }

    if(editingTenantIndex !== null) {
        const existing = normalizeTenantObject(app.tenants[editingTenantIndex]);
        app.tenants[editingTenantIndex] = normalizeTenantObject({ ...existing, ...form });
        editingTenantIndex = null;
        const btn = document.getElementById('addTenantBtn');
        btn.innerText = "+ Qo'shish";
        btn.classList.remove('bg-blue-600');
        btn.classList.add('bg-slate-800');
    } else {
        app.tenants.push(normalizeTenantObject(form));
    }

    saveCloud();
    clearTenantForm();
    renderSettings();
}

function clearTenantForm() {
    document.getElementById('newTenantName').value = "";
    document.getElementById('newTenantRent').value = "";
    document.getElementById('newTenantStart').value = "";
    document.getElementById('newTenantEnd').value = "";
    document.getElementById('newTenantActive').checked = true;
}

/**
 * Tenants are never deleted, because their payment history has to keep
 * resolving. Deactivating is what "removing" means; the agreement can also be
 * given an end period instead.
 */
function removeTenant(index) {
    const tenant = normalizeTenantObject(app.tenants[index]);
    if(!confirm(`${tenant.name} faolsizlantirilsinmi? Yozuvlar saqlanib qoladi.`)) return;
    app.tenants[index] = { ...tenant, active: false };
    saveCloud();
    renderSettings();
}

function reactivateTenant(index) {
    app.tenants[index] = { ...normalizeTenantObject(app.tenants[index]), active: true };
    saveCloud();
    renderSettings();
}

function toggleTenantMonth(index, month) {
    const tenant = normalizeTenantObject(app.tenants[index]);
    const disabledMonths = getDisabledMonths(tenant);
    const nextDisabledMonths = disabledMonths.includes(month)
        ? disabledMonths.filter(m => m !== month)
        : [...disabledMonths, month];

    app.tenants[index] = { ...tenant, disabledMonths: nextDisabledMonths };
    saveCloud();
    renderSettings();
}

// ---------------------------------------------------------- schedule editing

/** Which tenant the schedule editor is pointed at. */
let scheduleTenantIndex = null;

function openTenantSchedule(index) {
    scheduleTenantIndex = index;
    document.getElementById('tenantScheduleCard').classList.remove('hidden');
    renderTenantSchedule();
    document.getElementById('tenantScheduleCard').scrollIntoView({ behavior: 'smooth' });
}

function closeTenantSchedule() {
    scheduleTenantIndex = null;
    document.getElementById('tenantScheduleCard').classList.add('hidden');
}

function scheduleTenant() {
    if(scheduleTenantIndex === null) return null;
    return normalizeTenantObject(app.tenants[scheduleTenantIndex]);
}

function scheduleYearOptions() {
    const years = [];
    for(let year = currentYear() - 1; year <= currentYear() + 3; year++) years.push(year);
    return years;
}

function renderTenantSchedule() {
    const tenant = scheduleTenant();
    const list = document.getElementById('tenantScheduleList');
    if(!tenant || !list) return;

    const yearSelect = document.getElementById('scheduleYear');
    if(yearSelect && yearSelect.options.length === 0) {
        yearSelect.innerHTML = scheduleYearOptions()
            .map(year => `<option value="${year}"${year === currentYear() ? ' selected' : ''}>${year}</option>`)
            .join('');
    }
    const year = Number(yearSelect ? yearSelect.value : currentYear()) || currentYear();

    document.getElementById('scheduleTenantName').textContent = tenant.name;

    // A rent change is usually scheduled for a year that has no data yet, so
    // this selector spans the schedule editor's own year range rather than
    // only the years the ledger happens to know about.
    const fromSelect = document.getElementById('rentChangeFrom');
    if(fromSelect) {
        const previous = fromSelect.value;
        fromSelect.innerHTML = scheduleYearOptions()
            .flatMap(periodsInYear)
            .map(period => `<option value="${period}">${periodLabel(period)}</option>`)
            .join('');
        fromSelect.value = previous || buildPeriod(year, 1);
    }

    list.innerHTML = tenantScheduleForYear(tenant, year).map(row => {
        const owed = row.rent > 0;
        return `
        <div class="flex items-center justify-between gap-2 py-2 border-b border-slate-50 last:border-0" data-period="${row.period}">
            <div class="min-w-0">
                <p class="text-xs font-bold text-slate-700">${MONTH_LABELS[periodMonth(row.period) - 1]}</p>
                <p class="text-[10px] text-slate-400">${RENT_SOURCE_LABELS[row.source] || row.source}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <span class="schedule-rent text-xs font-bold ${owed ? 'text-slate-700' : 'text-slate-300'} whitespace-nowrap">
                    ${owed ? `${row.rent.toLocaleString()} ${row.currency}` : "yo'q"}
                </span>
                <button onclick="setTenantException('${row.period}')" title="Istisno"
                    class="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 text-[10px] font-bold active:scale-95">✎</button>
                <button onclick="toggleNoRentPeriod('${row.period}')" title="Ijara yo'q"
                    class="w-7 h-7 rounded-lg ${row.source === 'no_rent' ? 'bg-red-500 text-white' : 'bg-slate-100 text-slate-500'} text-[10px] font-bold active:scale-95">0</button>
            </div>
        </div>`;
    }).join('');

    renderRentChangeList(tenant);
}

function renderRentChangeList(tenant) {
    const box = document.getElementById('rentChangeList');
    if(!box) return;

    box.innerHTML = (tenant.rentChanges || []).length
        ? tenant.rentChanges.map(change => `
            <div class="flex items-center justify-between gap-2 text-[11px] py-1">
                <span class="text-slate-500">${periodLabel(change.fromPeriod)} dan</span>
                <span class="flex items-center gap-2 shrink-0">
                    <b class="text-slate-700">${change.amount.toLocaleString()} ${tenant.currency}</b>
                    <button onclick="removeTenantRentChange('${change.fromPeriod}')" class="text-red-400">✕</button>
                </span>
            </div>`).join('')
        : `<p class="text-[11px] text-slate-400">Rejalashtirilgan o'zgarish yo'q.</p>`;
}

function updateScheduleTenant(changes) {
    if(scheduleTenantIndex === null) return;
    app.tenants[scheduleTenantIndex] = normalizeTenantObject({ ...scheduleTenant(), ...changes });
    saveCloud();
    renderTenantSchedule();
    renderSettings();
}

function setTenantException(period) {
    const tenant = scheduleTenant();
    if(!tenant) return;

    const current = (tenant.exceptions || []).find(e => e.period === period);
    const entered = prompt(
        `${periodLabel(period)} uchun ijara summasi (${tenant.currency}).\nIstisnoni bekor qilish uchun bo'sh qoldiring.`,
        current ? String(current.amount) : String(effectiveTenantRent(tenant, period)));
    if(entered === null) return;

    const exceptions = (tenant.exceptions || []).filter(e => e.period !== period);
    if(String(entered).trim() !== "") {
        const amount = parseMoneyInput(entered);
        if(!Number.isFinite(amount) || amount < 0) return alert("To'g'ri summa kiriting.");
        exceptions.push({ period, amount });
    }
    updateScheduleTenant({ exceptions });
}

function toggleNoRentPeriod(period) {
    const tenant = scheduleTenant();
    if(!tenant) return;

    const noRentPeriods = (tenant.noRentPeriods || []).includes(period)
        ? tenant.noRentPeriods.filter(p => p !== period)
        : [...(tenant.noRentPeriods || []), period];
    updateScheduleTenant({ noRentPeriods });
}

/** A new default rent that applies from a period onwards. */
function addTenantRentChange() {
    const tenant = scheduleTenant();
    if(!tenant) return;

    const fromPeriod = document.getElementById('rentChangeFrom').value;
    const amount = parseMoneyInput(document.getElementById('rentChangeAmount').value);
    if(!isPeriod(fromPeriod)) return alert("Davrni tanlang.");
    if(!Number.isFinite(amount) || amount < 0) return alert("To'g'ri summa kiriting.");

    const rentChanges = [...(tenant.rentChanges || []).filter(c => c.fromPeriod !== fromPeriod),
                         { fromPeriod, amount }];
    document.getElementById('rentChangeAmount').value = "";
    updateScheduleTenant({ rentChanges });
}

function removeTenantRentChange(fromPeriod) {
    const tenant = scheduleTenant();
    if(!tenant) return;
    updateScheduleTenant({ rentChanges: (tenant.rentChanges || []).filter(c => c.fromPeriod !== fromPeriod) });
}
