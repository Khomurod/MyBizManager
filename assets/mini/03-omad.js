'use strict';

// ==========================================================
// 💰 Omad
// ----------------------------------------------------------
// Money this month, what the tenants owe, what happened recently, and the
// three entries that are worth making from a phone. Everything advanced -
// rates, tenant schedules, planned expenses, migration - stays in the full web
// app, which remains the administration interface.
// ==========================================================

function renderOmad() {
    const host = document.getElementById('tab-omad');
    if (!state.omad) { host.innerHTML = skeleton(4); return; }

    const o = state.omad;
    host.innerHTML = `
        ${staleBanner()}
        ${periodSwitcher(o)}

        <div class="card hero">
            <p class="tiny muted">Umumiy balans</p>
            <p class="value">${uzs(o.total)} <span class="tiny muted">UZS</span></p>
            <div class="grid2" style="margin-top:12px">
                <div><p class="tiny muted">Kassa</p><p class="num">${uzs(o.cash)}</p></div>
                <div><p class="tiny muted">Bank</p><p class="num">${uzs(o.bank)}</p></div>
            </div>
        </div>

        <div class="grid2" style="margin-top:10px">
            <div class="card tile">
                <p class="label">Kirim</p>
                <p class="value" style="color:var(--success)">${uzs(o.income)}</p>
            </div>
            <div class="card tile">
                <p class="label">Chiqim</p>
                <p class="value" style="color:var(--danger)">${uzs(o.expense)}</p>
            </div>
        </div>

        <div class="card" style="margin-top:10px">
            <div class="between">
                <div>
                    <p class="tiny muted">Ijarachilar qarzi</p>
                    <p class="num" style="font-size:20px;color:${o.tenantDebt > 0 ? 'var(--danger)' : 'var(--success)'}">${uzs(o.tenantDebt)}</p>
                </div>
                <span class="pill ${o.tenantDebt > 0 ? 'debt' : 'ok'}">${o.tenantsSettled}/${o.tenantCount} to'ladi</span>
            </div>
        </div>

        <div class="grid3" style="margin-top:12px">
            <button class="btn-primary btn-sm" onclick="openEntrySheet('Income')">➕ Kirim</button>
            <button class="btn-sm" onclick="openEntrySheet('Expense')">➖ Chiqim</button>
            <button class="btn-sm" onclick="openTenantPaidSheet()">🏢 Ijarachi</button>
        </div>

        <h2>Ijarachilar</h2>
        <div class="card list" id="miniTenantList">${tenantRows()}</div>

        <h2>Oxirgi amallar</h2>
        <div class="card list" id="miniEntryList">${entryRows()}</div>
    `;
}

/**
 * Says, above the figures, that they are the stored ones.
 *
 * Shown rather than hidden: the alternative to a stored figure with a warning
 * is a blank screen, and a zero on an accounting screen is a statement about
 * money. It disappears the moment the live answer lands.
 */
function staleBanner() {
    if (!state.snapshotAt) return '';
    const failed = state.loadError
        ? ` ${escapeHtml(state.loadError)}`
        : ' Yangilanmoqda...';
    return `
        <div class="card" style="border-color:var(--warning);margin-bottom:10px">
            <p class="tiny" style="font-weight:700">
                Saqlangan ma'lumot (${escapeHtml(shortStamp(state.snapshotAt))}).${failed}
            </p>
            ${state.loadError ? '<button class="btn-sm" style="margin-top:8px" onclick="loadOmad()">Qayta urinish</button>' : ''}
        </div>`;
}

/** "13.08 21:40" from an epoch ms, in the phone's own clock. */
function shortStamp(ms) {
    const when = new Date(Number(ms) || 0);
    if (isNaN(when.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(when.getDate())}.${pad(when.getMonth() + 1)} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

function periodSwitcher(o) {
    return `
        <div class="between" style="margin-bottom:12px">
            <button class="btn-sm" onclick="stepPeriod(-1)" aria-label="Oldingi oy">‹</button>
            <h1>${escapeHtml(o.periodLabel || periodLabel(o.period))}</h1>
            <button class="btn-sm" onclick="stepPeriod(1)" aria-label="Keyingi oy">›</button>
        </div>`;
}

async function stepPeriod(months) {
    state.period = shiftPeriod(state.period || currentPeriod(), months);
    haptic();
    await loadOmad();
}

function tenantRows() {
    if (!state.tenants.length) return emptyRow("Ijarachilar yo'q");
    return state.tenants.map(t => `
        <div class="item">
            <div class="grow">
                <p class="title ellipsis">${escapeHtml(t.name)}</p>
                <p class="tiny muted">Kutilgan ${uzs(t.expected)} · To'landi ${uzs(t.paid)}</p>
            </div>
            <span class="pill ${t.debt > 0 ? 'debt' : (t.surplus > 0 ? 'info' : 'ok')}">
                ${t.debt > 0 ? uzs(t.debt) : (t.surplus > 0 ? '+' + uzs(t.surplus) : "To'landi")}
            </span>
        </div>`).join('');
}

function entryRows() {
    if (!state.entries.length) return emptyRow("Bu oyda amal yo'q");
    return state.entries.map(e => {
        const tenantPaid = e.kind === 'tenant_paid_expense';
        const sign = tenantPaid ? 0 : (e.type === 'Income' ? 1 : -1);
        const badge = tenantPaid
            ? `<span class="pill warn">Ijarachi to'ladi</span>`
            : '';
        return `
        <div class="item">
            <div class="grow">
                <p class="title ellipsis">${tenantPaid ? '🏢 ' : ''}${escapeHtml(e.tenant)}</p>
                <p class="tiny muted ellipsis">${shortDate(e.date)}${e.lines > 1 && !tenantPaid ? ` · ${e.lines} qator` : ''}${e.comment ? ' · ' + escapeHtml(e.comment) : ''}</p>
                ${badge}
            </div>
            <p class="num" ${moneyClass(sign * e.amountUZS)}>${tenantPaid ? uzs(e.amountUZS) : signedUzs(sign * e.amountUZS)}</p>
        </div>`;
    }).join('');
}

// ---------------------------------------------------------------- entry forms

function tenantOptions(includeBuckets) {
    const names = state.tenants.map(t => t.name);
    const extra = includeBuckets ? ['Umumiy Naqd Puldan', 'Umumiy Bankdan'] : [];
    return names.concat(extra).map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

function amountFields() {
    return `
        <label for="mAmount">Summa</label>
        <input id="mAmount" inputmode="numeric" autocomplete="off" placeholder="0">
        <div class="grid2">
            <div>
                <label for="mCurrency">Valyuta</label>
                <select id="mCurrency"><option>UZS</option><option>USD</option></select>
            </div>
            <div>
                <label for="mMethod">Usul</label>
                <select id="mMethod"><option value="Naqd">Naqd</option><option value="Bank">Bank</option></select>
            </div>
        </div>`;
}

function openEntrySheet(type) {
    const income = type === 'Income';
    openSheet(income ? 'Yangi kirim' : 'Yangi chiqim', `
        <label for="mTenant">${income ? 'Ijarachi' : 'Manba'}</label>
        <select id="mTenant">${tenantOptions(!income)}</select>
        ${amountFields()}
        <label for="mComment">Izoh</label>
        <textarea id="mComment" placeholder="Ixtiyoriy"></textarea>
        <button class="btn-primary btn-full" style="margin-top:14px" id="mSubmit"
                onclick="submitEntry('${type}')">Saqlash</button>
    `, () => attachAmountFormatting(document.getElementById('mAmount')));
}

async function submitEntry(type) {
    const button = document.getElementById('mSubmit');
    const amount = readAmount(document.getElementById('mAmount'));
    if (amount <= 0) return toast("To'g'ri summa kiriting", true);

    button.disabled = true;
    button.textContent = 'Saqlanmoqda...';
    try {
        await api('mini_save_transaction', {
            type,
            tenant: document.getElementById('mTenant').value,
            period: state.period,
            amount,
            currency: document.getElementById('mCurrency').value,
            method: document.getElementById('mMethod').value,
            comment: document.getElementById('mComment').value.trim(),
            requestId: pendingId('entry', 'mini'),
            groupId: pendingId('entryGroup', 'grp_mini')
        });
        clearPendingId('entry');
        clearPendingId('entryGroup');
        closeSheet();
        toast('Saqlandi');
        flushReports();
        await loadOmad();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        // The ids are kept, so pressing save again resolves to the same record
        // rather than writing a second one.
        toast(error.message, true);
    } finally {
        button.disabled = false;
        button.textContent = 'Saqlash';
    }
}

function openTenantPaidSheet() {
    openSheet("Ijarachi bizning nomimizdan to'ladi", `
        <p class="tiny muted" style="margin:0 0 6px">
            Ijarachiga to'lov sifatida hisoblanadi <b>va</b> shu summada chiqim yoziladi.
            Kassaga ta'sir qilmaydi.
        </p>
        <label for="mTenant">Ijarachi</label>
        <select id="mTenant">${tenantOptions(false)}</select>
        ${amountFields()}
        <label for="mComment">Chiqim maqsadi</label>
        <textarea id="mComment" placeholder="Masalan: Elektrik xizmati"></textarea>
        <button class="btn-primary btn-full" style="margin-top:14px" id="mSubmit"
                onclick="submitTenantPaid()">Saqlash</button>
    `, () => attachAmountFormatting(document.getElementById('mAmount')));
}

async function submitTenantPaid() {
    const button = document.getElementById('mSubmit');
    const amount = readAmount(document.getElementById('mAmount'));
    const purpose = document.getElementById('mComment').value.trim();
    if (amount <= 0) return toast("To'g'ri summa kiriting", true);
    if (!purpose) return toast('Chiqim maqsadini kiriting', true);

    button.disabled = true;
    button.textContent = 'Saqlanmoqda...';
    try {
        await api('mini_tenant_paid', {
            tenant: document.getElementById('mTenant').value,
            period: state.period,
            amount,
            currency: document.getElementById('mCurrency').value,
            method: document.getElementById('mMethod').value,
            comment: purpose,
            requestId: pendingId('pair', 'mini'),
            groupId: pendingId('pairGroup', 'grp_mini')
        });
        clearPendingId('pair');
        clearPendingId('pairGroup');
        closeSheet();
        toast('Saqlandi');
        flushReports();
        await loadOmad();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    } finally {
        button.disabled = false;
        button.textContent = 'Saqlash';
    }
}

async function loadOmad() {
    try {
        const body = await api('mini_omad', { period: state.period });
        state.omad = body.omad;
        state.period = body.omad.period;
        state.tenants = body.tenants || [];
        state.entries = body.transactions || [];
        state.snapshotAt = 0;
        state.loadError = '';
        // Only the period the app opens on is worth storing: the snapshot
        // exists to make the *first* paint instant, and keeping a copy per
        // month someone browsed through would fill storage with figures nobody
        // is coming back to.
        if (state.user && body.omad.period === currentPeriod()) {
            writeMiniSnapshot(state.user.id, {
                user: state.user, omad: state.omad,
                tenants: state.tenants, entries: state.entries
            });
        }
        renderOmad();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    }
}
