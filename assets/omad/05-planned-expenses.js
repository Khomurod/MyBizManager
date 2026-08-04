'use strict';

// ==========================================================
// Planned expenses
// ----------------------------------------------------------
// A planned expense is a *plan*: it says money is expected to leave in given
// periods. It is never money that moved. Only a real expense transaction is,
// so projected and actual figures are shown side by side and never summed.
//
// Mirrors apps-script/07_planned_expenses.gs.
// ==========================================================

const EXPENSE_FREQUENCIES = [
    { value: 'once',             label: 'Bir marta' },
    { value: 'monthly',          label: 'Har oy' },
    { value: 'every_2_months',   label: 'Har 2 oyda' },
    { value: 'every_3_months',   label: 'Har 3 oyda' },
    { value: 'every_6_months',   label: 'Har 6 oyda' },
    { value: 'every_12_months',  label: 'Har yili' },
    { value: 'selected_months',  label: 'Tanlangan oylar' },
    { value: 'custom_interval',  label: 'Boshqa oraliq' }
];

/** Frequency -> interval in months. 0 means "not interval-based". */
const EXPENSE_INTERVALS = {
    once: 0, monthly: 1, every_2_months: 2, every_3_months: 3,
    every_6_months: 6, every_12_months: 12, selected_months: 0, custom_interval: 0
};

const EXPENSE_END_NEVER = 'never';
const EXPENSE_END_UNTIL = 'until_period';
const EXPENSE_END_COUNT = 'after_occurrences';

function normalizeSelectedMonths(months) {
    return [...new Set((Array.isArray(months) ? months : [])
        .map(m => Math.floor(Number(m)))
        .filter(m => m >= 1 && m <= 12))].sort((a, b) => a - b);
}

function normalizeExpenseEnding(ending) {
    const value = ending && typeof ending === 'object' ? ending : {};
    if (value.type === EXPENSE_END_UNTIL && isPeriod(value.untilPeriod)) {
        return { type: EXPENSE_END_UNTIL, untilPeriod: value.untilPeriod, occurrences: 0 };
    }
    if (value.type === EXPENSE_END_COUNT) {
        const occurrences = Math.floor(Number(value.occurrences) || 0);
        if (occurrences >= 1) return { type: EXPENSE_END_COUNT, untilPeriod: "", occurrences };
    }
    return { type: EXPENSE_END_NEVER, untilPeriod: "", occurrences: 0 };
}

function normalizeTemplateExpense(rawExpense) {
    const expense = rawExpense && typeof rawExpense === 'object' ? rawExpense : {};

    // Legacy records carry `month` and nothing else; they are one-time expenses.
    const startPeriod = isPeriod(expense.startPeriod) ? expense.startPeriod
        : (isPeriod(expense.month) ? expense.month
        : (isPeriod(expense.period) ? expense.period : currentPeriod()));

    let frequency = EXPENSE_INTERVALS[expense.frequency] !== undefined ? expense.frequency : 'once';
    let intervalMonths = Math.floor(Number(expense.intervalMonths) || 0);
    if (frequency === 'custom_interval' && (intervalMonths < 1 || intervalMonths > 120)) {
        frequency = 'monthly';
        intervalMonths = 0;
    }

    return {
        id: String(expense.id || Date.now() + "_" + Math.random().toString(36).slice(2)),
        name: normalizeTenantName(expense.name),
        amount: Number(expense.amount) || 0,
        currency: expense.currency === "USD" ? "USD" : "UZS",
        startPeriod,
        // `month` mirrors the start so older readers keep working.
        month: startPeriod,
        frequency,
        intervalMonths: frequency === 'custom_interval' ? intervalMonths : 0,
        selectedMonths: normalizeSelectedMonths(expense.selectedMonths),
        ending: normalizeExpenseEnding(expense.ending),
        active: expense.active === undefined ? true : expense.active !== false,
        description: String(expense.description || "").slice(0, 500)
    };
}

function getTemplateExpenses() {
    return (Array.isArray(app.templateExpenses) ? app.templateExpenses : [])
        .filter(expense => normalizeTenantName(expense && expense.name))
        .map(normalizeTemplateExpense);
}

/** Whole months between two periods; negative when `to` precedes `from`. */
function monthsBetweenPeriods(fromPeriod, toPeriod) {
    return (periodYear(toPeriod) * 12 + periodMonth(toPeriod)) -
           (periodYear(fromPeriod) * 12 + periodMonth(fromPeriod));
}

function matchesExpenseFrequency(expense, period) {
    const offset = monthsBetweenPeriods(expense.startPeriod, period);
    if (offset < 0) return false;

    if (expense.frequency === 'once') return offset === 0;
    if (expense.frequency === 'selected_months') {
        return (expense.selectedMonths || []).includes(periodMonth(period));
    }
    if (expense.frequency === 'custom_interval') {
        return expense.intervalMonths > 0 && offset % expense.intervalMonths === 0;
    }
    return offset % (EXPENSE_INTERVALS[expense.frequency] || 1) === 0;
}

/**
 * The 1-based occurrence number for a period, or 0 when the expense does not
 * fall due then.
 */
function plannedExpenseOccurrence(expense, period) {
    const e = expense || {};
    if (e.active === false) return 0;
    if (!isPeriod(period) || !isPeriod(e.startPeriod)) return 0;
    if (!matchesExpenseFrequency(e, period)) return 0;

    const ending = e.ending || { type: EXPENSE_END_NEVER };
    if (ending.type === EXPENSE_END_UNTIL && comparePeriods(period, ending.untilPeriod) > 0) return 0;

    const offset = monthsBetweenPeriods(e.startPeriod, period);
    if (offset > 1200) return 0;

    let occurrence = 0;
    for (let step = 0; step <= offset; step++) {
        if (matchesExpenseFrequency(e, addMonthsToPeriod(e.startPeriod, step))) occurrence++;
    }

    if (ending.type === EXPENSE_END_COUNT && occurrence > ending.occurrences) return 0;
    return occurrence;
}

function plannedExpenseAppliesTo(expense, period) {
    return plannedExpenseOccurrence(expense, period) > 0;
}

function plannedExpensesForPeriod(expenses, period) {
    return (expenses || [])
        .map(expense => ({ expense, occurrence: plannedExpenseOccurrence(expense, period) }))
        .filter(entry => entry.occurrence > 0);
}

/** A human-readable summary of when an expense falls due. */
function describePlannedExpense(expense) {
    const e = expense || {};
    let frequency = (EXPENSE_FREQUENCIES.find(f => f.value === e.frequency) || {}).label;

    if (e.frequency === 'selected_months') {
        const names = (e.selectedMonths || []).map(month => MONTH_SHORT_LABELS[month - 1]);
        frequency = names.length ? names.join(', ') : "Oylar tanlanmagan";
    } else if (e.frequency === 'custom_interval') {
        frequency = `Har ${e.intervalMonths} oyda`;
    }

    const rule = e.ending || {};
    let ending = "";
    if (rule.type === EXPENSE_END_UNTIL) ending = `${periodLabel(rule.untilPeriod)} gacha`;
    else if (rule.type === EXPENSE_END_COUNT) ending = `${rule.occurrences} marta`;

    return [`${periodLabel(e.startPeriod)} dan`, frequency, ending].filter(Boolean).join(' • ');
}

// -------------------------------------------------------------------- editing

/** Which expense the form is editing, or null for a new one. */
let editingExpenseId = null;

function readExpenseForm() {
    const frequency = document.getElementById('templateExpenseFrequency').value;
    const endingType = document.getElementById('templateExpenseEndType').value;

    return {
        name: normalizeTenantName(document.getElementById('templateExpenseName').value),
        amount: parseMoneyInput(document.getElementById('templateExpenseAmount').value),
        currency: document.getElementById('templateExpenseCurr').value,
        startPeriod: document.getElementById('templateExpenseMonth').value,
        frequency,
        intervalMonths: Number(document.getElementById('templateExpenseInterval').value) || 0,
        selectedMonths: [...document.querySelectorAll('.expense-month-toggle.selected')]
            .map(button => Number(button.dataset.month)),
        ending: {
            type: endingType,
            untilPeriod: document.getElementById('templateExpenseEndPeriod').value,
            occurrences: Number(document.getElementById('templateExpenseEndCount').value) || 0
        },
        description: document.getElementById('templateExpenseDescription').value.trim(),
        active: true
    };
}

/** Only the controls the chosen frequency and ending rule actually need. */
function onExpenseFrequencyChange() {
    const frequency = document.getElementById('templateExpenseFrequency').value;
    const endingType = document.getElementById('templateExpenseEndType').value;

    document.getElementById('expenseIntervalRow').classList.toggle('hidden', frequency !== 'custom_interval');
    document.getElementById('expenseMonthsRow').classList.toggle('hidden', frequency !== 'selected_months');
    // A one-time expense has nothing to end.
    document.getElementById('expenseEndingRow').classList.toggle('hidden', frequency === 'once');
    document.getElementById('expenseEndPeriodRow').classList.toggle('hidden',
        frequency === 'once' || endingType !== EXPENSE_END_UNTIL);
    document.getElementById('expenseEndCountRow').classList.toggle('hidden',
        frequency === 'once' || endingType !== EXPENSE_END_COUNT);
}

function toggleExpenseMonth(button) {
    button.classList.toggle('selected');
    button.classList.toggle('bg-blue-600');
    button.classList.toggle('text-white');
}

function addTemplateExpense() {
    const form = readExpenseForm();

    if(!isPeriod(form.startPeriod)) return alert("Boshlanish davrini tanlang");
    if(!form.name) return alert("Chiqim nomini kiriting");
    if(!Number.isFinite(form.amount) || form.amount <= 0) return alert("To'g'ri summa kiriting");
    if(form.frequency === 'selected_months' && form.selectedMonths.length === 0) {
        return alert("Kamida bitta oyni tanlang");
    }
    if(form.frequency === 'custom_interval' && (form.intervalMonths < 1 || form.intervalMonths > 120)) {
        return alert("Oraliq 1 dan 120 oygacha bo'lishi kerak");
    }
    if(form.ending.type === EXPENSE_END_UNTIL && !isPeriod(form.ending.untilPeriod)) {
        return alert("Tugash davrini tanlang");
    }
    if(form.ending.type === EXPENSE_END_UNTIL &&
       comparePeriods(form.ending.untilPeriod, form.startPeriod) < 0) {
        return alert("Tugash davri boshlanishdan oldin bo'lishi mumkin emas");
    }
    if(form.ending.type === EXPENSE_END_COUNT && form.ending.occurrences < 1) {
        return alert("Necha marta takrorlanishini kiriting");
    }

    const expenses = getTemplateExpenses();
    if(editingExpenseId) {
        const index = expenses.findIndex(e => e.id === editingExpenseId);
        if(index !== -1) expenses[index] = normalizeTemplateExpense({ ...form, id: editingExpenseId });
        editingExpenseId = null;
    } else {
        expenses.push(normalizeTemplateExpense(form));
    }
    app.templateExpenses = expenses;

    clearExpenseForm();
    saveCloud();
    renderSettings();
}

function editTemplateExpense(id) {
    const expense = getTemplateExpenses().find(e => e.id === String(id));
    if(!expense) return;

    editingExpenseId = expense.id;
    document.getElementById('templateExpenseName').value = expense.name;
    document.getElementById('templateExpenseAmount').value = formatMoneyValue(expense.amount);
    document.getElementById('templateExpenseCurr').value = expense.currency;
    document.getElementById('templateExpenseMonth').value = expense.startPeriod;
    document.getElementById('templateExpenseFrequency').value = expense.frequency;
    document.getElementById('templateExpenseInterval').value = expense.intervalMonths || "";
    document.getElementById('templateExpenseEndType').value = expense.ending.type;
    document.getElementById('templateExpenseEndPeriod').value = expense.ending.untilPeriod;
    document.getElementById('templateExpenseEndCount').value = expense.ending.occurrences || "";
    document.getElementById('templateExpenseDescription').value = expense.description;

    document.querySelectorAll('.expense-month-toggle').forEach(button => {
        const selected = expense.selectedMonths.includes(Number(button.dataset.month));
        button.classList.toggle('selected', selected);
        button.classList.toggle('bg-blue-600', selected);
        button.classList.toggle('text-white', selected);
    });

    onExpenseFrequencyChange();
    document.getElementById('addExpenseBtn').innerText = "O'zgartirishni Saqlash";
    document.getElementById('templateExpenseName').scrollIntoView({ behavior: 'smooth' });
}

function clearExpenseForm() {
    editingExpenseId = null;
    ['templateExpenseName', 'templateExpenseAmount', 'templateExpenseInterval',
     'templateExpenseEndCount', 'templateExpenseDescription'].forEach(id => {
        const element = document.getElementById(id);
        if(element) element.value = "";
    });
    document.getElementById('templateExpenseFrequency').value = 'once';
    document.getElementById('templateExpenseEndType').value = EXPENSE_END_NEVER;
    document.querySelectorAll('.expense-month-toggle').forEach(button => {
        button.classList.remove('selected', 'bg-blue-600', 'text-white');
    });
    onExpenseFrequencyChange();
    document.getElementById('addExpenseBtn').innerText = "+ Qo'shish";
}

function removeTemplateExpense(id) {
    if(!confirm("O'chirmoqchimisiz?")) return;
    app.templateExpenses = getTemplateExpenses().filter(expense => expense.id !== String(id));
    saveCloud();
    renderSettings();
}
