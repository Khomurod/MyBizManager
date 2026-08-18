'use strict';

// ==========================================================
// Transaction entry
// ----------------------------------------------------------
// The Yangi tab: cart, submit, edit and delete.
// ==========================================================

/**
 * True while the entry form is filling in a tenant-paid-on-our-behalf expense.
 *
 * It is a third *mode*, not a third transaction type: the entry produces one
 * income and one expense, so `currentType` stays meaningless here and the
 * submit path is its own.
 */
function isTenantPaidMode() {
    return currentType === 'TenantPaid';
}

function renderEntryDropdowns() {
    let options = app.tenants.map(t => t.name);
    // The income half has to land on a tenant's balance, so the two expense
    // buckets are not offered in this mode.
    if(currentType === 'Expense') {
        options.push("Umumiy Naqd Puldan");
        options.push("Umumiy Bankdan");
    }
    document.getElementById('entryTenant').innerHTML = options.map(t => `<option>${normalizeTenantName(t)}</option>`).join('');
}

// --- COMMON UI ---
function addToCart() {
    if(entrySaveInFlight) return;
    const amount = parseMoneyInput(document.getElementById('tempAmount').value);
    if(!Number.isFinite(amount) || amount <= 0) return alert("To'g'ri summa kiriting");

    cart.push({
        amount,
        currency: document.getElementById('tempCurr').value,
        method: document.getElementById('tempMethod').value
    });
    document.getElementById('tempAmount').value = "";
    renderCart();
}

function renderCart() {
    const box = document.getElementById('cartList');
    box.classList.remove('hidden');
    if(cart.length === 0) box.classList.add('hidden');
    box.innerHTML = cart.map((item, i) => `
        <div class="flex justify-between items-center text-xs border-b border-blue-200 last:border-0 pb-1 mb-1">
            <span class="font-bold text-slate-700">${item.amount.toLocaleString()} ${item.currency} <span class="text-slate-400 font-normal">(${item.method})</span></span>
            <button onclick="removeCartLine(${i})" class="text-red-400"${entrySaveInFlight ? ' disabled' : ''}><i class="fas fa-times"></i></button>
        </div>`).join('');
}

/**
 * Removes one line, unless a save is already reading the list.
 *
 * This was an inline `cart.splice(i,1); renderCart()` on the button itself, with
 * no guard of any kind -- so a line could be spliced out from under an edit that
 * was halfway through correcting the rows it named. Every later correction then
 * addressed the wrong original, and the cancellation boundary moved down with
 * `cart.length`, cancelling a row the person meant to keep.
 */
function removeCartLine(index) {
    if(entrySaveInFlight) return;
    cart.splice(index, 1);
    renderCart();
}

/** Shows the controls this mode uses and hides the ones it does not. */
function applyEntryMode() {
    const tenantPaid = isTenantPaidMode();
    const toggle = (id, hidden) => {
        const el = document.getElementById(id);
        if(el) el.classList.toggle('hidden', hidden);
    };
    // One amount, so no cart: the pair is 1:1 by construction.
    toggle('addToCartBtn', tenantPaid);
    toggle('tenantPaidNote', !tenantPaid);
    if(tenantPaid) toggle('cartList', true);

    const comment = document.getElementById('entryComment');
    if(comment) comment.placeholder = tenantPaid ? "Chiqim maqsadi (masalan: Elektrik xizmati)..." : "Izoh...";

    const btnTp = document.getElementById('btn-tenantpaid');
    if(btnTp) {
        btnTp.className = tenantPaid
            ? "w-full mb-4 py-2 rounded-lg font-bold text-xs border border-amber-500 bg-amber-500 text-white shadow transition-all"
            : "w-full mb-4 py-2 rounded-lg font-bold text-xs border border-slate-300 bg-white text-slate-500 transition-all";
    }
}

function setType(type) {
    currentType = type;
    const btnIn = document.getElementById('btn-income');
    const btnEx = document.getElementById('btn-expense');
    const sub = document.getElementById('submitBtn');

    if(type === 'TenantPaid') {
        // Editing an ordinary entry and then switching mode would submit the
        // wrong shape, so the mode switch always starts clean.
        cancelEdit();
        btnIn.className = "flex-1 py-2 rounded-md font-bold text-sm text-slate-500 transition-all";
        btnEx.className = "flex-1 py-2 rounded-md font-bold text-sm text-slate-500 transition-all";
        sub.className = "w-full bg-amber-600 text-white py-3 rounded-lg font-bold text-sm shadow-lg shadow-amber-200 active:scale-95 transition-all";
        sub.innerText = "IJARACHI TO'LOVINI SAQLASH";
        renderEntryDropdowns();
        applyEntryMode();
        return;
    }

    if(type === 'Income') {
        btnIn.className = "flex-1 py-2 rounded-md font-bold text-sm bg-white text-green-600 shadow-sm transition-all";
        btnEx.className = "flex-1 py-2 rounded-md font-bold text-sm text-slate-500 transition-all";
        sub.className = "w-full bg-green-600 text-white py-3 rounded-lg font-bold text-sm shadow-lg shadow-green-200 active:scale-95 transition-all";
        if(!document.getElementById('editId').value) sub.innerText = "KIRIMNI SAQLASH";
    } else {
        btnIn.className = "flex-1 py-2 rounded-md font-bold text-sm text-slate-500 transition-all";
        btnEx.className = "flex-1 py-2 rounded-md font-bold text-sm bg-white text-red-600 shadow-sm transition-all";
        sub.className = "w-full bg-red-600 text-white py-3 rounded-lg font-bold text-sm shadow-lg shadow-red-200 active:scale-95 transition-all";
        if(!document.getElementById('editId').value) sub.innerText = "CHIQIMNI SAQLASH";
    }
    renderEntryDropdowns();
    applyEntryMode();
}

function cancelEdit() {
    // Emptying the cart mid-save would have made the cancellation loop cancel
    // every remaining row of the entry.
    if(entrySaveInFlight) return;
    cart = []; renderCart();
    editingTenantPaidGroupId = "";
    editingGroupRows = { groupId: '', rows: [] };
    document.getElementById('editId').value = "";
    document.getElementById('msgId').value = "";
    document.getElementById('entryComment').value = "";
    document.getElementById('submitBtn').innerText = currentType === 'Income' ? "KIRIMNI SAQLASH" : "CHIQIMNI SAQLASH";
    document.getElementById('cancelEditBtn').classList.add('hidden');
}

// --- SUBMIT LOGIC ---

/**
 * The tenant-paid pair being edited, or "" for a new one.
 *
 * Declared alongside the other pending-entry state because cancelEdit clears
 * it, and cancelEdit runs on every mode switch.
 */
let editingTenantPaidGroupId = "";

/**
 * The request id for the submission in progress.
 *
 * It is generated once and reused until the submission succeeds, so a retry
 * after a network error resolves to the same transactions instead of creating
 * duplicates. It is mirrored into sessionStorage so the same holds when the
 * browser is refreshed mid-save: the resubmission carries the original id and
 * the server recognises it.
 */
const PENDING_REQUEST_KEY = 'omad_pending_request';
let pendingRequestBase = "";

function nextRequestBase() {
    if(!pendingRequestBase) {
        try {
            pendingRequestBase = sessionStorage.getItem(PENDING_REQUEST_KEY) || "";
        } catch (e) { pendingRequestBase = ""; }
    }
    if(!pendingRequestBase) {
        pendingRequestBase = `web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    try { sessionStorage.setItem(PENDING_REQUEST_KEY, pendingRequestBase); } catch (e) {}
    return pendingRequestBase;
}

/**
 * The id group a legacy entry is being written under.
 *
 * The whole-list save keys rows by `<baseId>_<line>`, so reusing the id on a
 * retry rewrites the same rows instead of adding a second copy. It is kept
 * apart from the ledger request id because it must contain no underscore -
 * getTxBaseId splits on one.
 */
const PENDING_ENTRY_KEY = 'omad_pending_entry_base';
let pendingEntryBase = "";

function nextEntryBaseId() {
    if(!pendingEntryBase) {
        try { pendingEntryBase = sessionStorage.getItem(PENDING_ENTRY_KEY) || ""; } catch (e) { pendingEntryBase = ""; }
    }
    if(!pendingEntryBase) pendingEntryBase = String(Date.now());
    try { sessionStorage.setItem(PENDING_ENTRY_KEY, pendingEntryBase); } catch (e) {}
    return pendingEntryBase;
}

/**
 * The immutable group id every row of this entry is written under.
 *
 * One business action, one group id — the several cart lines of a single
 * payment, and later the two halves of a tenant-paid expense, all carry it. It
 * is generated once and kept in sessionStorage for the same reason the request
 * id is: a retry after a network error has to land in the *same* group rather
 * than mint a second one. An edit reuses the group the entry already has, so
 * correcting an entry never re-groups it.
 */
const PENDING_GROUP_KEY = 'omad_pending_group';
let pendingGroupId = "";

function nextEntryGroupId() {
    if(!pendingGroupId) {
        try { pendingGroupId = sessionStorage.getItem(PENDING_GROUP_KEY) || ""; } catch (e) { pendingGroupId = ""; }
    }
    if(!pendingGroupId) {
        pendingGroupId = `grp_web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    try { sessionStorage.setItem(PENDING_GROUP_KEY, pendingGroupId); } catch (e) {}
    return pendingGroupId;
}

function clearPendingRequest() {
    pendingRequestBase = "";
    pendingEntryBase = "";
    pendingGroupId = "";
    try { sessionStorage.removeItem(PENDING_ENTRY_KEY); } catch (e) {}
    try { sessionStorage.removeItem(PENDING_REQUEST_KEY); } catch (e) {}
    try { sessionStorage.removeItem(PENDING_GROUP_KEY); } catch (e) {}
}

/** The group a transaction belongs to, falling back to the legacy derivation. */
function txGroupId(tx) {
    const stored = String((tx && tx.groupId) || "").trim();
    if(stored) return stored;
    return tx && tx.id ? `grp_legacy_${getTxBaseId(tx.id)}` : "";
}

/** True when a row is one half of a tenant-paid expense. */
function isTenantPaidRow(t) {
    return String((t && t.entryKind) || "") === 'tenant_paid_expense';
}

/**
 * The rows of the entry currently loaded into the form.
 *
 * Captured when the edit is opened, not looked up when it is submitted. Since
 * history is fetched a page at a time, `app.transactions` is a *page* and a
 * refresh empties it — and an edit that could not find its own rows would stop
 * correcting them and start creating new ones instead, which is the entry
 * recorded twice. The form holds what it is editing.
 */
let editingGroupRows = { groupId: '', rows: [] };

/** True while a group cancellation is in flight. See `deleteTx`. */
let cancellingEntry = false;

/**
 * True while a save is in flight, and the reason the cart cannot move under it.
 *
 * Editing a multi-line entry is several sequential backend calls -- one
 * correction per line, then one cancellation per removed line -- and each one is
 * a full round trip. The Save button has always been disabled for that whole
 * time, but nothing else was: `＋` still added a line, every line's `✕` still
 * spliced the array, and `Bekor qilish` still emptied it. Whatever happened to
 * the cart landed in the middle of a sequence that was reading it.
 *
 * The submitted lines are frozen (see `submitViaLedger`), so the corrections
 * themselves can no longer be redirected. This guard is the other half: once a
 * business action is being saved, the controls that describe it stop accepting
 * changes, so what is on the screen keeps matching what is being written. It is
 * the same explicit guard `cancellingEntry`, `taskMutationInFlight` and the
 * POS's `selling` already are -- the overlay that used to shield this form
 * incidentally is deliberately gone.
 */
let entrySaveInFlight = false;

/** Locks or releases every control that can change what is being saved. */
function setEntryControlsLocked(locked) {
    entrySaveInFlight = locked;
    ['addToCartBtn', 'cancelEditBtn', 'tempAmount', 'tempCurr', 'tempMethod',
     'entryTenant', 'entryMonth', 'entryComment'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.disabled = locked;
    });
    // The per-line remove buttons are generated, so the render is what knows
    // whether they are live.
    renderCart();
}

function rememberEditingGroup(groupId, rows) {
    editingGroupRows = { groupId: String(groupId || ''), rows: (rows || []).slice() };
}

/** Every known row of one business action, in cart order. */
function entryGroupRows(groupId) {
    const key = String(groupId || '');
    const source = (editingGroupRows.groupId === key && editingGroupRows.rows.length)
        ? editingGroupRows.rows
        : app.transactions.filter(t => txGroupId(t) === key);
    return source
        .slice()
        .sort((a, b) => (Number(String(a.id).split('_')[1]) || 0) - (Number(String(b.id).split('_')[1]) || 0));
}

async function submitAll() {
    if(isTenantPaidMode()) return submitTenantPaid();
    if(cart.length === 0) return alert("Summani kiriting");
    const btn = document.getElementById('submitBtn');
    if(btn.disabled || entrySaveInFlight) return;  // a second click while saving
    btn.disabled = true; btn.innerText = "Bajarilmoqda...";
    // From here until the answer, the business action being saved is immutable.
    setEntryControlsLocked(true);

    try {
        if(app.ledgerActive) {
            await submitViaLedger();
        } else {
            await submitViaWholeListSave();
        }
        clearPendingRequest();
        clearEntryForm();
        switchTab('dash');
    } catch (error) {
        // The form, the cart and the request id are all left alone, so the
        // same entry can simply be sent again without becoming a duplicate.
        console.error(error);
        alert((error && error.message) || SAVE_FAILED_MESSAGE);
    } finally {
        setEntryControlsLocked(false);
        btn.disabled = false;
        btn.innerText = currentType === 'Income' ? "KIRIMNI SAQLASH" : "CHIQIMNI SAQLASH";
    }
}

function clearEntryForm() {
    cart = [];
    // The edit is over, so the rows it was holding go with it. Keeping them
    // would leave the next save aimed at records a correction has already
    // replaced.
    editingGroupRows = { groupId: '', rows: [] };
    document.getElementById('entryComment').value = "";
    document.getElementById('editId').value = "";
    document.getElementById('msgId').value = "";
    document.getElementById('cancelEditBtn').classList.add('hidden');
    renderCart();
}

function currentEntryCommon() {
    return {
        tenant: normalizeTenantName(document.getElementById('entryTenant').value),
        period: document.getElementById('entryMonth').value,
        comment: document.getElementById('entryComment').value.trim(),
        type: currentType,
        source: 'Web',
        createdBy: localStorage.getItem('omad_user') || 'web'
    };
}

/**
 * Append-only path. Each cart line is its own transaction. Editing corrects
 * the lines that already exist, creates any new ones and cancels the ones that
 * were removed - the originals are never rewritten.
 */
async function submitViaLedger() {
    const requestBase = nextRequestBase();
    const common = currentEntryCommon();
    const editId = document.getElementById('editId').value;
    // An edit stays inside the group it is editing; a new entry opens one.
    const groupId = editId ? editingGroupId(editId) : nextEntryGroupId();
    const existingIds = editId ? entryGroupRows(groupId).map(t => t.id) : [];
    // Frozen before the first round trip. See the live override in 12-app.js.
    const lines = submittedCartLines();

    showLoader(true);
    try {
        for(let i = 0; i < lines.length; i++) {
            const line = { requestId: `${requestBase}_${i}`, groupId, ...common, ...lines[i] };

            const response = i < existingIds.length
                ? await callBackend({ action: 'correct_transaction', transactionId: existingIds[i], ...line })
                : await callBackend({ action: 'create_transaction', ...line });

            if(!response || response.status !== 'success') {
                throw new Error((response && response.message) || 'save failed');
            }
        }

        // Lines removed during the edit are cancelled, never deleted.
        for(let i = lines.length; i < existingIds.length; i++) {
            await callBackend({
                action: 'cancel_transaction',
                transactionId: existingIds[i],
                requestId: `${requestBase}_cancel_${i}`,
                reason: 'entry edited'
            });
        }
    } finally {
        showLoader(false);
    }

    await syncData();
}

/**
 * The lines being submitted, copied out of the cart once.
 *
 * The edit path is several sequential round trips, and it used to re-read the
 * live `cart` on every iteration -- `i < cart.length` re-evaluated, `cart[i]`
 * dereferenced after the previous `await` resumed. `existingIds` was already
 * snapshotted, so the *targets* were frozen while the *source* moved, and that
 * asymmetry is where the corruption lived: a line spliced out shifted every
 * later correction on to the wrong original and pulled the cancellation
 * boundary down with it, cancelling a row nobody asked to remove. A line added
 * mid-save appended a `create_transaction` the person never confirmed.
 *
 * The new-entry path never had the bug, because it materialises `cart.map(...)`
 * into one payload before its single await. This gives the edit path the same
 * property: once Save starts, the submitted action is what it was when Save was
 * pressed.
 */
function submittedCartLines() {
    return cart.map(item => ({
        amount: Number(item.amount) || 0,
        currency: item.currency,
        method: item.method
    }));
}

/**
 * One tenant-paid expense: one request, two linked rows, one report.
 *
 * The group id and the request id are both minted once and kept in
 * sessionStorage, so a double click, a network retry or a refresh mid-save all
 * resolve to the pair the first attempt created rather than to a second pair.
 * The server writes both rows in a single spreadsheet operation, so there is
 * no half-created state to recover from either.
 */
/** Loads an existing pair back into the form, as a pair. */
function editTenantPaid(groupId, rows) {
    const income = rows.find(r => r.type === 'Income') || rows[0];
    const expense = rows.find(r => r.type === 'Expense');

    setType('TenantPaid');
    editingTenantPaidGroupId = groupId;
    rememberEditingGroup(groupId, rows);

    document.getElementById('entryTenant').value = income.tenant;
    document.getElementById('entryMonth').value = recordPeriod(income);
    document.getElementById('tempCurr').value = income.currency;
    document.getElementById('tempMethod').value = income.method;
    document.getElementById('tempAmount').value = Number(income.amount || 0).toLocaleString('ru-RU');
    // The purpose is stored on the expense half; the income half carries the
    // same text behind a prefix, so the expense is the cleaner source.
    document.getElementById('entryComment').value = String((expense && expense.comment) || income.comment || "")
        .replace(/\s*\(to'lovchi:[^)]*\)\s*$/, "");

    document.getElementById('submitBtn').innerText = "O'ZGARTIRISHNI SAQLASH";
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    switchTab('entry');
}

async function submitTenantPaid() {
    const amount = parseMoneyInput(document.getElementById('tempAmount').value);
    if(!Number.isFinite(amount) || amount <= 0) return alert("To'g'ri summa kiriting");

    const purpose = document.getElementById('entryComment').value.trim();
    if(!purpose) return alert("Chiqim maqsadini kiriting (masalan: Elektrik xizmati)");

    const btn = document.getElementById('submitBtn');
    if(btn.disabled) return;
    btn.disabled = true; btn.innerText = "Bajarilmoqda...";
    showLoader(true);

    try {
        const response = await callBackend({
            action: 'tenant_paid_expense',
            requestId: nextRequestBase(),
            groupId: nextEntryGroupId(),
            replaceGroupId: editingTenantPaidGroupId,
            tenant: normalizeTenantName(document.getElementById('entryTenant').value),
            period: document.getElementById('entryMonth').value,
            amount,
            currency: document.getElementById('tempCurr').value,
            method: document.getElementById('tempMethod').value,
            comment: purpose,
            source: 'Web',
            createdBy: localStorage.getItem('omad_user') || 'web'
        });

        if(!response || response.status !== 'success') {
            throw new Error((response && response.message) || SAVE_FAILED_MESSAGE);
        }

        clearPendingRequest();
        editingTenantPaidGroupId = "";
        editingGroupRows = { groupId: '', rows: [] };
        document.getElementById('tempAmount').value = "";
        document.getElementById('entryComment').value = "";
        document.getElementById('cancelEditBtn').classList.add('hidden');
        await syncData();
        switchTab('dash');
    } catch (error) {
        // The form and both ids are left alone, so the same entry can simply be
        // sent again without becoming a second pair.
        console.error(error);
        alert((error && error.message) || SAVE_FAILED_MESSAGE);
    } finally {
        showLoader(false);
        btn.disabled = false;
        btn.innerText = "IJARACHI TO'LOVINI SAQLASH";
    }
}

/**
 * The group id of the entry currently being edited.
 *
 * The remembered rows answer first, for the same reason `entryGroupRows` reads
 * them: `app.transactions` is a page of history and a refresh empties it. The
 * fallback derivation — `grp_legacy_<baseId>` — is right only for rows written
 * before the column existed, so reaching it for a modern entry names a group
 * nothing belongs to, and the correction that should have followed becomes a
 * second entry instead.
 */
function editingGroupId(editId) {
    const remembered = editingGroupRows.rows.some(t => String(t.id) === String(editId));
    if (remembered) return editingGroupRows.groupId;
    const tx = app.transactions.find(t => String(t.id) === String(editId));
    return tx ? txGroupId(tx) : `grp_legacy_${getTxBaseId(editId)}`;
}

/** Legacy path, used until the ledger migration has been cut over. */
async function submitViaWholeListSave() {
    const editId = document.getElementById('editId').value;
    const existingMsgId = document.getElementById('msgId').value;
    const editBaseId = editId ? getTxBaseId(editId) : null;
    // Stable across retries, so resubmitting after a failure rewrites the same
    // rows rather than creating a second entry.
    const baseId = editBaseId || nextEntryBaseId();
    const groupId = editId ? editingGroupId(editId) : nextEntryGroupId();

    const common = {
        tenant: normalizeTenantName(document.getElementById('entryTenant').value),
        month: document.getElementById('entryMonth').value,
        comment: document.getElementById('entryComment').value.trim(),
        date: new Date().toLocaleDateString('en-GB')
    };

    // Rows are replaced by group, not by id prefix, so an entry whose rows were
    // written under different ids is still edited as one thing.
    const baseTransactions = editId
        ? app.transactions.filter(t => txGroupId(t) !== groupId)
        : [...app.transactions];

    const pendingTransactions = cart.map((item, i) => ({
        id: baseId + "_" + i,
        groupId,
        ...common,
        type: currentType,
        amount: Number(item.amount) || 0,
        currency: item.currency,
        method: item.method
    }));

    const keptMsgId = editId ? existingMsgId : "";
    // The list is updated optimistically so the save carries the new rows; if
    // the server refuses, the previous list is put back rather than leaving
    // rows on screen that were never stored.
    const previousTransactions = app.transactions;
    app.transactions = [
        ...baseTransactions,
        ...pendingTransactions.map(tx => ({ ...tx, msgId: keptMsgId }))
    ];

    // Save first, then let the server report. The report is a queued,
    // retryable job on the backend - it can never duplicate the entry
    // and a Telegram outage never blocks the save.
    try {
        await saveCloud({
            operation: 'transaction_upsert',
            groupId,
            baseId,
            messageId: keptMsgId || ""
        });
    } catch (error) {
        app.transactions = previousTransactions;
        throw error;
    }
    // Pick up the Telegram message id the server attached, so a later
    // edit updates the same group message.
    await syncData();
}

function editTx(id) {
    const groupId = editingGroupId(id);
    const grouped = entryGroupRows(groupId);

    const tx = grouped[0];
    if(!tx) return;

    // A tenant-paid pair is edited as a pair, in its own mode. Loading it into
    // the ordinary form would let one half be changed on its own, which is
    // never a coherent edit.
    if(grouped.every(isTenantPaidRow)) return editTenantPaid(groupId, grouped);

    setType(tx.type);
    // After setType, never before: switching *into* tenant-paid mode calls
    // cancelEdit, which is what clears this.
    rememberEditingGroup(groupId, grouped);
    document.getElementById('entryTenant').value = tx.tenant;
    document.getElementById('entryMonth').value = recordPeriod(tx);
    document.getElementById('entryComment').value = tx.comment || "";
    document.getElementById('editId').value = tx.id;
    document.getElementById('msgId').value = tx.msgId || ""; 
    cart = grouped.map(item => ({
        amount: Number(item.amount) || 0,
        currency: item.currency,
        method: item.method
    }));
    renderCart();
    document.getElementById('submitBtn').innerText = "O'ZGARTIRISHNI SAQLASH";
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    switchTab('entry');
}

/**
 * Cancels an entry. Financial records are never deleted - once the ledger is
 * live the rows stay put with status Cancelled and remain in the audit trail.
 */
async function deleteTx(id) {
    // Through the same resolver an edit uses, so cancelling from a page of
    // history that has since been refreshed still names the real group.
    const groupId = editingGroupId(id);

    // Both halves of a tenant-paid expense go together. Removing one would
    // leave a tenant credited for a bill nobody paid, or an expense with no
    // funding, so the confirmation says what is actually about to happen.
    const pair = entryGroupRows(groupId).every(isTenantPaidRow) && entryGroupRows(groupId).length > 1;
    const label = pair
        ? (app.ledgerActive
            ? "Ijarachi to'lovi va unga bog'liq chiqim birga bekor qilinadi. Davom etamizmi?"
            : "Ijarachi to'lovi va unga bog'liq chiqim birga o'chiriladi. Davom etamizmi?")
        : (app.ledgerActive ? "Bekor qilmoqchimisiz?" : "O'chirmoqchimisiz?");
    if(!confirm(label)) return;

    const baseId = getTxBaseId(id);

    if(app.ledgerActive) {
        // One cancellation at a time. The loader is what used to stop a second
        // click landing on rows the first is already cancelling, and it is kept
        // here because a cancellation genuinely is something to wait for — but
        // the guard is said out loud rather than left to an overlay.
        if(cancellingEntry) return;
        cancellingEntry = true;
        const requestBase = `web_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        showLoader(true);
        try {
            const ids = entryGroupRows(groupId).map(t => t.id);
            for(let i = 0; i < ids.length; i++) {
                await callBackend({
                    action: 'cancel_transaction',
                    transactionId: ids[i],
                    requestId: `${requestBase}_${i}`,
                    reason: 'cancelled from history'
                });
            }
        } finally {
            showLoader(false);
            cancellingEntry = false;
        }
        // Background, like every other confirmed write. A foreground `syncData`
        // re-hydrates the stored snapshot first, which marks this live screen
        // stale and makes `callBackend` refuse the next write until the refresh
        // returns — the same trap the entry path already avoids.
        settleOmadWriteInBackground_();
        return;
    }

    const grouped = entryGroupRows(groupId);
    const msgId = grouped.find(t => t.msgId)?.msgId || "";
    app.transactions = app.transactions.filter(t => txGroupId(t) !== groupId);
    await saveCloud(msgId ? { operation: 'transaction_delete', groupId, baseId, messageId: msgId } : null);
}
