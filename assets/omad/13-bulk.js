'use strict';

// ==========================================================
// Ommaviy kiritish — many business actions, one submission
// ----------------------------------------------------------
// The Yangi tab records ONE business action with several amounts: one tenant,
// one type, one period, one comment. That is the right shape for a rent payment
// split between cash and bank, and the wrong shape for the thing this business
// actually does at the start of every month, which is settle ten tenants at
// once. Doing that here was ten separate submissions.
//
// This screen is the other axis. Every row is its own business action, keeps
// its own group id and its own month, and gets its own Telegram card — so a
// correction a month later edits that one entry exactly as if it had been typed
// on its own. Nothing about the accounting is new: the server validates every
// row with the same validators the single-entry paths use, and a tenant-paid
// row is built by the very same function the single tenant-paid action calls.
//
// The Yangi form is untouched. This is an additional tab, not a replacement.
// ==========================================================

/** The three things a row can be. `tenant_paid` is the linked pair. */
const BULK_KINDS = ['income', 'expense', 'tenant_paid'];

const BULK_KIND_LABELS = {
    income: 'Kirim',
    expense: 'Chiqim',
    tenant_paid: "Ijarachi bizning nomimizdan to'ladi"
};

/**
 * Its own pending key, deliberately not the entry form's.
 *
 * A request id must survive a refresh so a retry after an uncertain answer
 * lands on the same rows rather than writing a second copy. Sharing
 * `omad_pending_request` with the Yangi form would mean a bulk left in flight
 * and a single entry started afterwards claiming the same id.
 */
const PENDING_BULK_REQUEST_KEY = 'omad_pending_bulk_request';
let pendingBulkRequestBase = '';

function nextBulkRequestBase() {
    if (!pendingBulkRequestBase) {
        try {
            pendingBulkRequestBase = sessionStorage.getItem(PENDING_BULK_REQUEST_KEY) || '';
        } catch (e) { pendingBulkRequestBase = ''; }
    }
    if (!pendingBulkRequestBase) {
        // Short: the server derives `<base>__b<count>_<index>_<half>` from this
        // and caps the whole thing at 128 characters.
        pendingBulkRequestBase = `wb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    try { sessionStorage.setItem(PENDING_BULK_REQUEST_KEY, pendingBulkRequestBase); } catch (e) {}
    return pendingBulkRequestBase;
}

function clearBulkRequest() {
    pendingBulkRequestBase = '';
    try { sessionStorage.removeItem(PENDING_BULK_REQUEST_KEY); } catch (e) {}
}

// ------------------------------------------------------------- the grid

let bulkSaveInFlight = false;
let bulkRowSeq = 0;

function bulkRowsContainer() {
    return document.getElementById('bulkRows');
}

function bulkRowElements() {
    const list = bulkRowsContainer();
    return list ? Array.from(list.querySelectorAll('.bulk-row')) : [];
}

/** The month new rows open with. */
function bulkDefaultPeriod() {
    const select = document.getElementById('bulkMonth');
    return (select && select.value) || currentPeriod();
}

/**
 * Which objects a row of this kind may name.
 *
 * Exactly what the Yangi form offers, for the same reason: an income credits a
 * tenant's balance, and the two general buckets have no balance to credit. The
 * server refuses anything else anyway — this is the screen not offering a
 * choice that would be refused.
 */
function bulkTenantOptions(kind, selected) {
    const names = app.tenants.map(t => t.name);
    if (kind === 'expense') {
        names.push('Umumiy Naqd Puldan');
        names.push('Umumiy Bankdan');
    }
    return names.map(name => {
        const value = normalizeTenantName(name);
        return `<option value="${escapeHTML(value)}"${value === selected ? ' selected' : ''}>${escapeHTML(value)}</option>`;
    }).join('');
}

function bulkKindOptions(selected) {
    return BULK_KINDS.map(kind =>
        `<option value="${kind}"${kind === selected ? ' selected' : ''}>${escapeHTML(BULK_KIND_LABELS[kind])}</option>`
    ).join('');
}

/**
 * Adds one row, optionally pre-filled.
 *
 * @param {object} [values] `{kind, tenant, period, amount, currency, method, comment}`
 */
function addBulkRow(values) {
    const list = bulkRowsContainer();
    if (!list || bulkSaveInFlight) return;

    const seed = values || {};
    const kind = BULK_KINDS.includes(seed.kind) ? seed.kind : 'income';
    const period = seed.period || bulkDefaultPeriod();
    const tenant = seed.tenant ? normalizeTenantName(seed.tenant) : '';
    const id = `bulkRow${++bulkRowSeq}`;

    const row = document.createElement('div');
    row.className = 'bulk-row card';
    row.id = id;
    row.style.padding = '12px';
    row.innerHTML =
        '<div class="flex items-center gap-2 mb-2">' +
        `<select class="bulk-kind flex-1 min-w-0 p-2 border border-slate-200 rounded bg-white font-bold text-xs" onchange="onBulkKindChange(this)">${bulkKindOptions(kind)}</select>` +
        '<button type="button" onclick="removeBulkRow(this)" aria-label="Qatorni o\'chirish" ' +
        'class="text-red-400 text-sm font-bold px-2">✕</button>' +
        '</div>' +
        '<div class="grid grid-cols-2 gap-2 mb-2">' +
        '<select class="bulk-tenant w-full min-w-0 p-2 bg-slate-50 border border-slate-200 rounded font-bold text-xs outline-none"></select>' +
        `<select class="bulk-period w-full min-w-0 p-2 bg-slate-50 border border-slate-200 rounded font-bold text-xs outline-none">${periodOptions(period)}</select>` +
        '</div>' +
        '<div class="flex gap-2 mb-2">' +
        `<input type="text" inputmode="decimal" class="bulk-amount flex-1 min-w-0 p-2 border border-slate-200 rounded text-sm font-bold outline-none" placeholder="0" value="${escapeHTML(String(seed.amount || ''))}">` +
        `<select class="bulk-currency w-20 p-2 border border-slate-200 rounded bg-white font-bold text-xs"><option${seed.currency === 'USD' ? '' : ' selected'}>UZS</option><option${seed.currency === 'USD' ? ' selected' : ''}>USD</option></select>` +
        `<select class="bulk-method w-24 p-2 border border-slate-200 rounded bg-white font-medium text-xs text-slate-600"><option value="Naqd"${seed.method === 'Bank' ? '' : ' selected'}>Naqd</option><option value="Bank"${seed.method === 'Bank' ? ' selected' : ''}>Bank</option></select>` +
        '</div>' +
        `<input type="text" class="bulk-comment w-full p-2 border border-slate-200 rounded text-xs outline-none" placeholder="Izoh" value="${escapeHTML(String(seed.comment || ''))}">`;

    list.appendChild(row);

    // The tenant list depends on the kind, so it is filled after the row exists
    // rather than duplicated into the markup above.
    applyBulkKind(row, kind, tenant);

    const amount = row.querySelector('.bulk-amount');
    // attachMoneyFormatting only wires the six static ids on this page, so a
    // created field is formatted here.
    amount.addEventListener('input', () => { reformatMoneyField(amount); renderBulkSummary(); });
    reformatMoneyField(amount);
    row.querySelector('.bulk-currency').addEventListener('change', renderBulkSummary);

    renderBulkSummary();
    return row;
}

function onBulkKindChange(select) {
    const row = select.closest('.bulk-row');
    if (!row) return;
    const tenantSelect = row.querySelector('.bulk-tenant');
    applyBulkKind(row, select.value, tenantSelect ? tenantSelect.value : '');
    renderBulkSummary();
}

/**
 * Re-offers the objects this kind allows, keeping the chosen one when it is
 * still on the list. Switching an expense out of a general bucket into an
 * income has to move the selection somewhere legal rather than leave a value
 * the server will refuse.
 */
function applyBulkKind(row, kind, preferred) {
    const tenantSelect = row.querySelector('.bulk-tenant');
    const wanted = preferred && !(kind !== 'expense' && isExpenseBucketName(preferred)) ? preferred : '';
    tenantSelect.innerHTML = bulkTenantOptions(kind, wanted);
    if (wanted) tenantSelect.value = wanted;

    const comment = row.querySelector('.bulk-comment');
    // The pair's expense half is only readable a year from now if it says what
    // it was for, so the server requires a purpose there.
    comment.placeholder = kind === 'tenant_paid' ? 'Nima uchun to\'ladi? (majburiy)' : 'Izoh';
}

function isExpenseBucketName(name) {
    const text = String(name || '').trim();
    return text === 'Umumiy Naqd Puldan' || text === 'Umumiy Bankdan';
}

function removeBulkRow(button) {
    if (bulkSaveInFlight) return;
    const row = button.closest('.bulk-row');
    if (row) row.remove();
    renderBulkSummary();
}

/** Empties the grid. Used by the Tozalash button, which a save must not be. */
function clearBulkGrid() {
    // The same guard every other control has: a grid that can be emptied while
    // a save is in flight is a grid that no longer describes what was sent.
    if (bulkSaveInFlight) return;
    resetBulkGrid();
}

/**
 * Empties the grid unconditionally.
 *
 * Separate from `clearBulkGrid` because a *successful save* has to clear it,
 * and at that moment the save is still in flight — the lock is not released
 * until the `finally`. Routing the post-save reset through the guarded version
 * silently did nothing, which left the saved rows on screen where the next
 * submission would have sent them a second time.
 */
function resetBulkGrid() {
    const list = bulkRowsContainer();
    if (list) list.innerHTML = '';
    setBulkError('');
    renderBulkSummary();
}

// ------------------------------------------------------------- reading back

/** One row, as the person left it. */
function bulkRowValues(row) {
    return {
        kind: row.querySelector('.bulk-kind').value,
        tenant: normalizeTenantName(row.querySelector('.bulk-tenant').value),
        period: row.querySelector('.bulk-period').value,
        amount: parseMoneyInput(row.querySelector('.bulk-amount').value),
        currency: row.querySelector('.bulk-currency').value,
        method: row.querySelector('.bulk-method').value,
        comment: row.querySelector('.bulk-comment').value.trim()
    };
}

/** The whole grid, in the order shown. */
function bulkGridValues() {
    return bulkRowElements().map(bulkRowValues);
}

/** One row as the server's entry shape. */
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

// ------------------------------------------------------------- the summary

function renderBulkSummary() {
    const rows = bulkGridValues();
    const empty = document.getElementById('bulkEmpty');
    if (empty) empty.classList.toggle('hidden', rows.length > 0);

    let income = 0;
    let expense = 0;
    rows.forEach(row => {
        const uzs = toUZS(row.amount, row.currency, row.period, RATE_TYPE_PROJECTION);
        // A tenant-paid pair is an income and an expense of the same size, and
        // it moves no cash. Counting it on both sides is what it actually is.
        if (row.kind === 'expense' || row.kind === 'tenant_paid') expense += uzs;
        if (row.kind === 'income' || row.kind === 'tenant_paid') income += uzs;
    });

    document.getElementById('bulkRowCount').innerText = String(rows.length);
    document.getElementById('bulkIncomeTotal').innerText = formatUZS(income);
    document.getElementById('bulkExpenseTotal').innerText = formatUZS(expense);

    const submit = document.getElementById('bulkSubmitBtn');
    if (submit && !bulkSaveInFlight) submit.disabled = rows.length === 0;
}

function setBulkError(message) {
    const box = document.getElementById('bulkError');
    if (!box) return;
    box.innerText = message || '';
    box.classList.toggle('hidden', !message);
}

// ------------------------------------------------------------- prefilling

/**
 * A row for every tenant who still owes something this month.
 *
 * Computes nothing new: `tenantBalanceFor` answers from the schedule and the
 * summary the browser already holds after one `get_omad_data`.
 *
 * The amount is exact in both cases and converted in neither. A tenant who has
 * paid nothing gets their rent in their own currency, straight off the
 * schedule. A tenant who has paid something gets the UZS remainder, because
 * what was paid is only known in UZS — turning that back into USD would invent
 * a figure out of a rounding.
 */
function fillFromRoster() {
    if (bulkSaveInFlight) return;
    const period = bulkDefaultPeriod();
    const existing = new Set(bulkGridValues()
        .filter(row => row.kind === 'income' && row.period === period)
        .map(row => row.tenant));

    let added = 0;
    app.tenants.forEach(tenant => {
        if (tenant.active === false) return;
        if (!isTenantInScheduleForPeriod(tenant, period)) return;
        if (isTenantDisabledForPeriod(tenant, period)) return;

        const balance = tenantBalanceFor(tenant, period);
        const owed = balance.expected - balance.paid;
        if (owed <= 0) return;

        const name = normalizeTenantName(tenant.name);
        if (existing.has(name)) return;

        const untouched = balance.paid === 0;
        addBulkRow({
            kind: 'income', tenant: name, period: period,
            amount: untouched ? effectiveTenantRent(tenant, period) : owed,
            currency: untouched ? (tenant.currency || 'UZS') : 'UZS',
            method: 'Naqd',
            comment: `${periodLabel(period)} ijara`
        });
        added++;
    });

    setBulkError(added === 0 ? "Bu oy uchun qarzdor ijarachi topilmadi." : '');
}

/**
 * The same entries as last month, ready to be edited.
 *
 * Seeded from `app.recent`, which the read model already returns as business
 * actions rather than as rows — so a tenant-paid pair arrives as one thing and
 * comes back as one row here, not as two.
 */
function fillFromLastMonth() {
    if (bulkSaveInFlight) return;
    const period = bulkDefaultPeriod();
    const previous = addMonthsToPeriod(period, -1);

    const source = (app.recent || []).filter(entry => entry.period === previous);
    if (source.length === 0) {
        setBulkError(`${periodLabel(previous)} uchun yozuv topilmadi.`);
        return;
    }

    source.forEach(entry => {
        const tenantPaid = entry.kind === 'tenant_paid_expense';
        // A recent entry is a business action, not a row: a multi-line entry
        // reports its lead line's amount and the group's UZS total. Seeding the
        // total in UZS is the only figure that describes the whole entry.
        const multiLine = !tenantPaid && Number(entry.lines) > 1;
        addBulkRow({
            kind: tenantPaid ? 'tenant_paid' : (entry.type === 'Expense' ? 'expense' : 'income'),
            tenant: entry.tenant,
            // The new month, not the one it is copied from: this is "the same
            // again", not "the same entry a second time".
            period: period,
            amount: multiLine ? entry.amountUZS : entry.amount,
            currency: multiLine ? 'UZS' : entry.currency,
            // The recent list does not carry the payment method — it is not
            // part of what the entry *was*, only of how it arrived — so this
            // opens on the default and the person changes it if it differs.
            method: 'Naqd',
            comment: tenantPaidPurposeOf(entry.comment)
        });
    });
    setBulkError('');
}

/**
 * The purpose out of a stored tenant-paid comment.
 *
 * The income half is stored as "Ijarachi bizning nomimizdan to'ladi: <purpose>"
 * — the server adds that wording. Copying it back verbatim into a new
 * tenant-paid row would have the server prefix it a second time.
 */
const TENANT_PAID_COMMENT_PREFIX = "Ijarachi bizning nomimizdan to'ladi: ";

function tenantPaidPurposeOf(comment) {
    const text = String(comment || '');
    return text.indexOf(TENANT_PAID_COMMENT_PREFIX) === 0
        ? text.slice(TENANT_PAID_COMMENT_PREFIX.length)
        : text;
}

function onBulkMonthChange() {
    // Only the default for new rows changes. Rows already on screen keep the
    // month they were given, which is the whole point of a per-row month.
    renderBulkSummary();
}

// ------------------------------------------------------------- submitting

/**
 * Locks every control while a submission is in flight.
 *
 * The lesson from the entry form's `submittedCartLines`: a grid that can be
 * edited during a save means the request that went out and the rows on screen
 * describe different things, and the person is then told their money was
 * recorded when a different amount was.
 */
function setBulkSaveLock(locked) {
    bulkSaveInFlight = locked;
    ['bulkAddRow', 'bulkFillRoster', 'bulkFillRepeat', 'bulkClearBtn', 'bulkMonth', 'bulkSubmitBtn']
        .forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = locked;
        });
    bulkRowElements().forEach(row => {
        row.querySelectorAll('input, select, button').forEach(control => { control.disabled = locked; });
    });

    const submit = document.getElementById('bulkSubmitBtn');
    if (submit) submit.innerText = locked ? 'SAQLANMOQDA...' : 'HAMMASINI SAQLASH';
}

/** The first thing wrong with the grid, in the person's words, or ''. */
function bulkGridError(rows) {
    if (rows.length === 0) return 'Kamida bitta qator kiriting.';
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const at = `${i + 1}-qator: `;
        if (!row.tenant) return at + 'obyekt tanlanmagan.';
        if (!(row.amount > 0)) return at + "summa musbat raqam bo'lishi kerak.";
        if (row.kind === 'tenant_paid' && !row.comment) return at + 'chiqim maqsadini kiriting.';
    }
    return '';
}

async function submitBulk() {
    if (bulkSaveInFlight) return;

    // Frozen before the first await, and the grid is locked behind it. What is
    // submitted is what was on screen when the button was pressed.
    const rows = bulkGridValues();
    const problem = bulkGridError(rows);
    if (problem) {
        setBulkError(problem);
        return;
    }

    const requestId = nextBulkRequestBase();
    const entries = rows.map(bulkEntryPayload);

    setBulkError('');
    setBulkSaveLock(true);
    showLoader(true);
    let saved = null;
    try {
        const response = await callBackend({
            action: 'create_transaction_bulk',
            requestId: requestId,
            source: 'Web',
            createdBy: localStorage.getItem('omad_user') || 'web',
            entries: entries
        });

        if (!isSuccessResponse(response)) {
            // The grid and the request id both stay, so pressing again is a
            // retry of this submission rather than a second one.
            const where = response && response.entryIndex !== undefined
                ? `${Number(response.entryIndex) + 1}-qator: ` : '';
            setBulkError(where + ((response && response.message) || 'Saqlanmadi.'));
            return;
        }

        // Only now: the submission is stored, so its id must never be reused.
        clearBulkRequest();
        resetBulkGrid();
        saved = { count: entries.length, duplicate: !!response.duplicate };
    } catch (error) {
        setBulkError((error && error.message) || 'Tarmoq xatosi. Qaytadan urinib ko\'ring.');
    } finally {
        showLoader(false);
        setBulkSaveLock(false);
        renderBulkSummary();
    }

    if (!saved) return;
    alert(saved.duplicate
        ? 'Bu yozuvlar allaqachon saqlangan.'
        : `${saved.count} ta yozuv saqlandi.`);
    // Out of band and coalesced, like every other accounting write: the money is
    // stored, and the figures are a fresh read of it. Deliberately outside the
    // try above, so a failed *refresh* can never be reported as a failed save.
    settleOmadWriteInBackground_();
}

// ------------------------------------------------------------- wiring

/** The bulk action is a write, so a stale dashboard may never submit it. */
OMAD_WRITE_ACTIONS.add('create_transaction_bulk');

// Telegram waits, exactly as it does for every other accounting write: the
// cards are queued before the response and the five-minute trigger sends them.
var callBackendBeforeBulk_ = callBackend;
callBackend = async function (payload) {
    const body = { ...(payload || {}) };
    if (String(body.action || '') === 'create_transaction_bulk') body.deferReports = true;
    return callBackendBeforeBulk_(body);
};

/** Fills the month selector the first time the tab is opened. */
function initBulkTab() {
    const select = document.getElementById('bulkMonth');
    if (!select) return;
    const keep = select.value || currentPeriod();
    select.innerHTML = periodOptions(keep);
    renderBulkSummary();
}

var switchTabBeforeBulk_ = switchTab;
switchTab = function (name) {
    switchTabBeforeBulk_(name);
    if (name === 'bulk') initBulkTab();
};
