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
        <button class="btn-sm btn-full" style="margin-top:8px" onclick="openBulkSheet()">📋 Ommaviy kiritish</button>

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
        // The record is stored; the figures are a fresh read of it. Neither the
        // Telegram card nor that read is a reason to keep this form busy.
        refreshOmadInBackground();
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
        refreshOmadInBackground();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    } finally {
        button.disabled = false;
        button.textContent = 'Saqlash';
    }
}

// ------------------------------------------------------- refreshing the tab
//
// Two Omad reads can genuinely be in flight at once — a post-save refresh and a
// period switch a second later — and the one that *started* last is the one
// still true. Without a sequence guard the slower earlier answer paints over the
// newer one, and `writeMiniSnapshot` stores the wrong month's figures for the
// next open. The counter is what makes "last request wins" rather than "last
// response wins".
let miniOmadLoadSeq = 0;

let miniOmadRefreshInFlight = false;
let miniOmadRefreshPending = false;

async function runPendingOmadRefresh() {
    if (miniOmadRefreshInFlight) return;
    miniOmadRefreshInFlight = true;
    try {
        // Coalesce rapid saves without losing the refresh for the latest one.
        while (miniOmadRefreshPending) {
            miniOmadRefreshPending = false;
            await loadOmad();
        }
    } finally {
        miniOmadRefreshInFlight = false;
    }
}

/** The same background-refresh model the web Omad app uses after a write. */
function refreshOmadInBackground() {
    miniOmadRefreshPending = true;
    setTimeout(() => { runPendingOmadRefresh(); }, 0);
}

async function loadOmad() {
    const seq = ++miniOmadLoadSeq;
    try {
        const body = await api('mini_omad', { period: state.period });
        // A superseded answer is dropped whole: it may name another period, and
        // half-applying it would leave the figures and the label disagreeing.
        if (seq !== miniOmadLoadSeq) return;
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
        // A refused signature ends the session whenever it arrives; it is not a
        // stale figure, it is the gate closing.
        if (error.unauthorized) return failAuth(error);
        // A superseded read's failure is not news: a newer one is still running,
        // and its own outcome is the one worth telling anybody about.
        if (seq !== miniOmadLoadSeq) return;
        toast(error.message, true);
    }
}

// ==========================================================
// Ommaviy kiritish — many business actions, one submission
// ----------------------------------------------------------
// The three sheets above each record one thing. At the start of a month there
// are ten of them, and doing that on a phone was ten sheets opened, filled and
// submitted one after another.
//
// This is the same screen the web admin's Ommaviy tab is, sized for a phone and
// posting to the same server function. Every row is its own business action
// with its own group id, its own month and its own Telegram card, so nothing
// entered here is a special kind of entry — it is the ordinary kind, several at
// a time.
// ==========================================================

const MINI_BULK_KINDS = ['income', 'expense', 'tenant_paid'];

const MINI_BULK_LABELS = {
    income: '➕ Kirim',
    expense: '➖ Chiqim',
    tenant_paid: "🏢 Ijarachi to'ladi"
};

/** How many months back a row may be dated. Three covers a late settlement. */
const MINI_BULK_MONTHS_BACK = 3;

let miniBulkSaveInFlight = false;

function bulkPeriodOptions(selected) {
    const options = [];
    for (let back = 0; back <= MINI_BULK_MONTHS_BACK; back++) {
        const period = shiftPeriod(state.period || currentPeriod(), -back);
        options.push(
            `<option value="${escapeHtml(period)}"${period === selected ? ' selected' : ''}>${escapeHtml(periodLabel(period))}</option>`
        );
    }
    return options.join('');
}

function bulkTenantOptions(kind, selected) {
    const names = state.tenants.map(t => t.name);
    // An income credits a tenant's balance, and the two general buckets have no
    // balance to credit — the same rule the single entry sheet follows.
    if (kind === 'expense') names.push('Umumiy Naqd Puldan', 'Umumiy Bankdan');
    return names.map(name =>
        `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`
    ).join('');
}

function openBulkSheet() {
    openSheet('Ommaviy kiritish', `
        <div class="task-editor-body">
            <p class="tiny muted" style="margin:0 0 10px">
                Har bir qator alohida yozuv: o'z oyi, o'z guruhi va o'z hisoboti bilan.
            </p>
            <div class="grid2">
                <button class="btn-sm" id="mBulkFill" onclick="fillBulkFromDebts()">🏢 Qarzdorlar</button>
                <button class="btn-sm" id="mBulkAdd" onclick="addBulkRow()">➕ Qator</button>
            </div>
            <div id="mBulkRows" style="margin-top:10px"></div>
            <p class="muted tiny" id="mBulkEmpty" style="padding:14px 0;text-align:center">
                Hozircha qator yo'q.
            </p>
        </div>
        <div class="task-editor-actions">
            <p class="tiny muted" id="mBulkSummary" style="margin:0 0 8px;text-align:center"></p>
            <button class="btn-primary btn-full" id="mBulkSubmit" onclick="submitBulk()">Saqlash</button>
        </div>
    `, () => {
        const sheet = document.querySelector('#sheetHost .sheet');
        // The same full-height sheet the task editor uses: a fixed header and
        // footer with a scrolling body, which is what a repeater needs.
        if (sheet) sheet.classList.add('task-editor-sheet');
        renderBulkSummary();
    });
}

function bulkRowElements() {
    const list = document.getElementById('mBulkRows');
    return list ? Array.from(list.querySelectorAll('.bulk-row')) : [];
}

function addBulkRow(values) {
    const list = document.getElementById('mBulkRows');
    if (!list || miniBulkSaveInFlight) return;

    const seed = values || {};
    const kind = MINI_BULK_KINDS.includes(seed.kind) ? seed.kind : 'income';
    const period = seed.period || state.period || currentPeriod();

    const row = document.createElement('div');
    row.className = 'bulk-row';
    row.innerHTML =
        '<div class="bulk-row-head">' +
        `<select class="bulk-kind" aria-label="Turi" onchange="onBulkKindChange(this)">${
            MINI_BULK_KINDS.map(k => `<option value="${k}"${k === kind ? ' selected' : ''}>${escapeHtml(MINI_BULK_LABELS[k])}</option>`).join('')
        }</select>` +
        '<button type="button" class="btn-sm" aria-label="Qatorni o\'chirish" onclick="removeBulkRow(this)">✕</button>' +
        '</div>' +
        '<div class="grid2">' +
        '<select class="bulk-tenant" aria-label="Obyekt"></select>' +
        `<select class="bulk-period" aria-label="Oy">${bulkPeriodOptions(period)}</select>` +
        '</div>' +
        '<div class="bulk-row-money">' +
        `<input class="bulk-amount" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Summa" value="${escapeHtml(String(seed.amount || ''))}">` +
        `<select class="bulk-currency" aria-label="Valyuta"><option${seed.currency === 'USD' ? '' : ' selected'}>UZS</option><option${seed.currency === 'USD' ? ' selected' : ''}>USD</option></select>` +
        `<select class="bulk-method" aria-label="Usul"><option value="Naqd"${seed.method === 'Bank' ? '' : ' selected'}>Naqd</option><option value="Bank"${seed.method === 'Bank' ? ' selected' : ''}>Bank</option></select>` +
        '</div>' +
        `<input class="bulk-comment" autocomplete="off" placeholder="Izoh" value="${escapeHtml(String(seed.comment || ''))}">`;

    list.appendChild(row);
    applyBulkKind(row, kind, seed.tenant || '');

    const amount = row.querySelector('.bulk-amount');
    attachAmountFormatting(amount);
    amount.addEventListener('input', renderBulkSummary);
    amount.dispatchEvent(new Event('input'));

    renderBulkSummary();
    return row;
}

function onBulkKindChange(select) {
    const row = select.closest('.bulk-row');
    if (!row) return;
    applyBulkKind(row, select.value, row.querySelector('.bulk-tenant').value);
}

/**
 * Re-offers the objects this kind allows, keeping the chosen one when it is
 * still legal. Switching an expense out of a general bucket into an income has
 * to move the selection somewhere the server will accept.
 */
function applyBulkKind(row, kind, preferred) {
    const bucket = preferred === 'Umumiy Naqd Puldan' || preferred === 'Umumiy Bankdan';
    const wanted = preferred && !(kind !== 'expense' && bucket) ? preferred : '';
    const select = row.querySelector('.bulk-tenant');
    select.innerHTML = bulkTenantOptions(kind, wanted);
    if (wanted) select.value = wanted;

    // The pair's expense half is only readable a year from now if it says what
    // it was for, so the server requires a purpose there.
    row.querySelector('.bulk-comment').placeholder =
        kind === 'tenant_paid' ? "Nima uchun to'ladi? (majburiy)" : 'Izoh';
}

function removeBulkRow(button) {
    if (miniBulkSaveInFlight) return;
    const row = button.closest('.bulk-row');
    if (row) row.remove();
    renderBulkSummary();
}

/** One row, as it is on screen. */
function bulkRowValues(row) {
    return {
        kind: row.querySelector('.bulk-kind').value,
        tenant: row.querySelector('.bulk-tenant').value,
        period: row.querySelector('.bulk-period').value,
        amount: readAmount(row.querySelector('.bulk-amount')),
        currency: row.querySelector('.bulk-currency').value,
        method: row.querySelector('.bulk-method').value,
        comment: row.querySelector('.bulk-comment').value.trim()
    };
}

function bulkGridValues() {
    return bulkRowElements().map(bulkRowValues);
}

function bulkEntryPayload(values) {
    if (values.kind === 'tenant_paid') {
        return {
            kind: 'tenant_paid', tenant: values.tenant, period: values.period,
            amount: values.amount, currency: values.currency,
            method: values.method, comment: values.comment
        };
    }
    return {
        kind: 'ordinary',
        type: values.kind === 'expense' ? 'Expense' : 'Income',
        tenant: values.tenant, period: values.period, amount: values.amount,
        currency: values.currency, method: values.method, comment: values.comment
    };
}

function renderBulkSummary() {
    const rows = bulkGridValues();
    const empty = document.getElementById('mBulkEmpty');
    if (empty) empty.classList.toggle('hidden', rows.length > 0);

    const summary = document.getElementById('mBulkSummary');
    if (summary) {
        // Only UZS rows are totalled: converting a USD row would need this
        // month's rate, and the phone does not hold the rate table. The server
        // freezes the real one per entry.
        const uzs = rows.filter(r => r.currency === 'UZS')
            .reduce((sum, r) => sum + (r.kind === 'expense' ? -r.amount : r.amount), 0);
        summary.textContent = rows.length
            ? `${rows.length} ta qator · ${uzs >= 0 ? '+' : ''}${uzs.toLocaleString('ru-RU').replace(/ /g, ' ')} so'm`
            : '';
    }

    const submit = document.getElementById('mBulkSubmit');
    if (submit && !miniBulkSaveInFlight) submit.disabled = rows.length === 0;
}

/**
 * A row for every tenant who still owes something this month.
 *
 * Free: `state.tenants` already carries `{name, expected, paid, debt, surplus}`
 * from `buildMiniTenantStatus_`, so there is no arithmetic to do on the phone.
 * The debt is a UZS figure — the only one the Mini App is sent — so the rows
 * open in UZS whatever currency the rent is agreed in.
 */
function fillBulkFromDebts() {
    if (miniBulkSaveInFlight) return;
    const period = state.period || currentPeriod();
    const already = new Set(bulkGridValues()
        .filter(row => row.kind === 'income' && row.period === period)
        .map(row => row.tenant));

    let added = 0;
    state.tenants.forEach(tenant => {
        if (!(tenant.debt > 0) || already.has(tenant.name)) return;
        addBulkRow({
            kind: 'income', tenant: tenant.name, period: period,
            amount: tenant.debt, currency: 'UZS', method: 'Naqd',
            comment: `${periodLabel(period)} ijara`
        });
        added++;
    });

    if (!added) toast('Qarzdor ijarachi topilmadi', true);
}

function setBulkSaveLock(locked) {
    miniBulkSaveInFlight = locked;
    ['mBulkFill', 'mBulkAdd', 'mBulkSubmit'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = locked;
    });
    bulkRowElements().forEach(row => {
        row.querySelectorAll('input, select, button').forEach(control => { control.disabled = locked; });
    });

    const submit = document.getElementById('mBulkSubmit');
    if (submit) submit.textContent = locked ? 'Saqlanmoqda...' : 'Saqlash';
}

/** The first thing wrong with the grid, in the person's words, or ''. */
function bulkGridError(rows) {
    if (!rows.length) return 'Kamida bitta qator kiriting.';
    for (let i = 0; i < rows.length; i++) {
        const at = `${i + 1}-qator: `;
        if (!rows[i].tenant) return at + 'obyekt tanlanmagan.';
        if (!(rows[i].amount > 0)) return at + "to'g'ri summa kiriting.";
        if (rows[i].kind === 'tenant_paid' && !rows[i].comment) return at + 'chiqim maqsadini kiriting.';
    }
    return '';
}

async function submitBulk() {
    if (miniBulkSaveInFlight) return;

    // Frozen before the first await, and every control locked behind it: a grid
    // that can be edited during a save means the request that went out and the
    // rows on screen describe different money.
    const rows = bulkGridValues();
    const problem = bulkGridError(rows);
    if (problem) return toast(problem, true);

    const entries = rows.map(bulkEntryPayload);
    setBulkSaveLock(true);
    try {
        await api('mini_bulk_entry', {
            requestId: pendingId('bulk', 'mb'),
            entries: entries
        });
        // Only now: the submission is stored, so its id must never be reused.
        clearPendingId('bulk');
        closeSheet();
        toast(`${entries.length} ta yozuv saqlandi`);
        // One card per business action, so the flush is told how many to send.
        flushReports(entries.length);
        refreshOmadInBackground();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        // The grid and the request id both stay, so pressing again is a retry
        // of this submission rather than a second one.
        toast(error.message, true);
    } finally {
        setBulkSaveLock(false);
        renderBulkSummary();
    }
}
