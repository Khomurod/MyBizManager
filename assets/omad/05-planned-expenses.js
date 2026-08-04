'use strict';

// ==========================================================
// Planned (template) expenses
// ----------------------------------------------------------
// Recurring expense templates that feed the projection.
// ==========================================================

function normalizeTemplateExpense(rawExpense) {
    const expense = rawExpense && typeof rawExpense === 'object' ? rawExpense : {};
    return {
        id: String(expense.id || Date.now() + "_" + Math.random().toString(36).slice(2)),
        month: months.includes(expense.month) ? expense.month : months[new Date().getMonth()],
        name: normalizeTenantName(expense.name),
        amount: Number(expense.amount) || 0,
        currency: expense.currency === "USD" ? "USD" : "UZS"
    };
}

function getTemplateExpenses() {
    return (Array.isArray(app.templateExpenses) ? app.templateExpenses : []).map(normalizeTemplateExpense);
}

function addTemplateExpense() {
    const month = document.getElementById('templateExpenseMonth').value;
    const name = normalizeTenantName(document.getElementById('templateExpenseName').value);
    const amount = parseFloat(document.getElementById('templateExpenseAmount').value);
    const currency = document.getElementById('templateExpenseCurr').value;

    if(!months.includes(month)) return alert("Oy tanlang");
    if(!name) return alert("Chiqim nomini kiriting");
    if(!Number.isFinite(amount) || amount <= 0) return alert("To'g'ri summa kiriting");

    app.templateExpenses = getTemplateExpenses();
    app.templateExpenses.push({
        id: Date.now() + "_" + app.templateExpenses.length,
        month,
        name,
        amount,
        currency
    });

    document.getElementById('templateExpenseName').value = "";
    document.getElementById('templateExpenseAmount').value = "";
    saveCloud();
}

function removeTemplateExpense(id) {
    app.templateExpenses = getTemplateExpenses().filter(expense => expense.id !== String(id));
    saveCloud();
}
