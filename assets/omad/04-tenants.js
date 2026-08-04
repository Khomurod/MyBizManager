'use strict';

// ==========================================================
// Tenant management
// ----------------------------------------------------------
// Tenant records and their per-month enable/disable switches.
// ==========================================================

function getDisabledMonths(tenant) {
    return tenant && Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : [];
}

function isTenantDisabledForMonth(tenant, month) {
    return month !== "Jami Davr" && getDisabledMonths(tenant).includes(month);
}

function normalizeTenantObject(rawTenant) {
    if(typeof rawTenant === 'string') {
        return { name: normalizeTenantName(rawTenant), rent: 0, currency: "USD", disabledMonths: [] };
    }
    const tenant = rawTenant && typeof rawTenant === 'object' ? rawTenant : {};
    return {
        ...tenant,
        name: normalizeTenantName(tenant.name),
        rent: Number(tenant.rent) || 0,
        currency: tenant.currency === "UZS" ? "UZS" : "USD",
        disabledMonths: getDisabledMonths(tenant)
    };
}

function editTenant(index) {
    const t = normalizeTenantObject(app.tenants[index]);
    document.getElementById('newTenantName').value = t.name;
    document.getElementById('newTenantRent').value = t.rent;
    document.getElementById('newTenantCurr').value = t.currency;
    editingTenantIndex = index;
    const btn = document.getElementById('addTenantBtn');
    btn.innerText = "O'zgartirishni Saqlash";
    btn.classList.remove('bg-slate-800');
    btn.classList.add('bg-blue-600');
    btn.scrollIntoView({behavior: "smooth"});
}

function addTenant() {
    const name = normalizeTenantName(document.getElementById('newTenantName').value);
    const rent = parseFloat(document.getElementById('newTenantRent').value);
    const curr = document.getElementById('newTenantCurr').value;

    if(!name) return alert("Ism kiriting");

    if(editingTenantIndex !== null) {
        const existingTenant = normalizeTenantObject(app.tenants[editingTenantIndex]);
        app.tenants[editingTenantIndex] = { ...existingTenant, name: name, rent: rent || 0, currency: curr };
        editingTenantIndex = null;
        const btn = document.getElementById('addTenantBtn');
        btn.innerText = "+ Qo'shish";
        btn.classList.remove('bg-blue-600');
        btn.classList.add('bg-slate-800');
    } else {
        app.tenants.push({ name: name, rent: rent || 0, currency: curr, disabledMonths: [] });
    }

    saveCloud();
    document.getElementById('newTenantName').value = "";
    document.getElementById('newTenantRent').value = "";
    renderSettings();
}

function removeTenant(index) {
    if(confirm("O'chirmoqchimisiz?")) { app.tenants.splice(index, 1); saveCloud(); renderSettings(); }
}

function toggleTenantMonth(index, month) {
    const tenant = normalizeTenantObject(app.tenants[index]);
    const disabledMonths = getDisabledMonths(tenant);
    const nextDisabledMonths = disabledMonths.includes(month)
        ? disabledMonths.filter(m => m !== month)
        : [...disabledMonths, month];

    app.tenants[index] = { ...tenant, disabledMonths: nextDisabledMonths };
    saveCloud();
}
