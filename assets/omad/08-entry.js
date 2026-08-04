'use strict';

// ==========================================================
// Transaction entry
// ----------------------------------------------------------
// The Yangi tab: cart, submit, edit and delete.
// ==========================================================

function renderEntryDropdowns() {
    let options = app.tenants.map(t => t.name);
    if(currentType === 'Expense') {
        options.push("Umumiy Naqd Puldan");
        options.push("Umumiy Bankdan");
    }
    document.getElementById('entryTenant').innerHTML = options.map(t => `<option>${normalizeTenantName(t)}</option>`).join('');
}

// --- COMMON UI ---
function addToCart() {
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
            <button onclick="cart.splice(${i},1); renderCart()" class="text-red-400"><i class="fas fa-times"></i></button>
        </div>`).join('');
}

function setType(type) {
    currentType = type;
    const btnIn = document.getElementById('btn-income');
    const btnEx = document.getElementById('btn-expense');
    const sub = document.getElementById('submitBtn');
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
}

function cancelEdit() {
    cart = []; renderCart();
    document.getElementById('editId').value = "";
    document.getElementById('msgId').value = "";
    document.getElementById('entryComment').value = "";
    document.getElementById('submitBtn').innerText = currentType === 'Income' ? "KIRIMNI SAQLASH" : "CHIQIMNI SAQLASH";
    document.getElementById('cancelEditBtn').classList.add('hidden');
}

// --- SUBMIT LOGIC ---

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

function clearPendingRequest() {
    pendingRequestBase = "";
    try { sessionStorage.removeItem(PENDING_REQUEST_KEY); } catch (e) {}
}

async function submitAll() {
    if(cart.length === 0) return alert("Summani kiriting");
    const btn = document.getElementById('submitBtn');
    if(btn.disabled) return;                       // a second click while saving
    btn.disabled = true; btn.innerText = "Bajarilmoqda...";

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
        console.error(error);
        alert("Saqlanmadi. Internetni tekshirib, qayta urinib ko'ring.");
    } finally {
        btn.disabled = false;
        btn.innerText = currentType === 'Income' ? "KIRIMNI SAQLASH" : "CHIQIMNI SAQLASH";
    }
}

function clearEntryForm() {
    cart = [];
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
    const existingIds = editId ? entryGroupIds(getTxBaseId(editId)) : [];

    showLoader(true);
    try {
        for(let i = 0; i < cart.length; i++) {
            const line = {
                requestId: `${requestBase}_${i}`,
                ...common,
                amount: Number(cart[i].amount) || 0,
                currency: cart[i].currency,
                method: cart[i].method
            };

            const response = i < existingIds.length
                ? await callBackend({ action: 'correct_transaction', transactionId: existingIds[i], ...line })
                : await callBackend({ action: 'create_transaction', ...line });

            if(!response || response.status !== 'success') {
                throw new Error((response && response.message) || 'save failed');
            }
        }

        // Lines removed during the edit are cancelled, never deleted.
        for(let i = cart.length; i < existingIds.length; i++) {
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

/** Ids of one entry group, in cart order. */
function entryGroupIds(baseId) {
    return app.transactions
        .filter(t => String(t.id).startsWith(baseId + "_"))
        .sort((a, b) => (Number(String(a.id).split('_')[1]) || 0) - (Number(String(b.id).split('_')[1]) || 0))
        .map(t => t.id);
}

/** Legacy path, used until the ledger migration has been cut over. */
async function submitViaWholeListSave() {
    const editId = document.getElementById('editId').value;
    const existingMsgId = document.getElementById('msgId').value;
    const editBaseId = editId ? getTxBaseId(editId) : null;
    const baseId = editBaseId || String(Date.now());

    const common = {
        tenant: normalizeTenantName(document.getElementById('entryTenant').value),
        month: document.getElementById('entryMonth').value,
        comment: document.getElementById('entryComment').value.trim(),
        date: new Date().toLocaleDateString('en-GB')
    };

    const baseTransactions = editBaseId
        ? app.transactions.filter(t => !t.id.startsWith(editBaseId + "_"))
        : [...app.transactions];

    const pendingTransactions = cart.map((item, i) => ({
        id: baseId + "_" + i,
        ...common,
        type: currentType,
        amount: Number(item.amount) || 0,
        currency: item.currency,
        method: item.method
    }));

    const keptMsgId = editId ? existingMsgId : "";
    app.transactions = [
        ...baseTransactions,
        ...pendingTransactions.map(tx => ({ ...tx, msgId: keptMsgId }))
    ];

    // Save first, then let the server report. The report is a queued,
    // retryable job on the backend - it can never duplicate the entry
    // and a Telegram outage never blocks the save.
    await saveCloud({
        operation: 'transaction_upsert',
        baseId,
        messageId: keptMsgId || ""
    });
    // Pick up the Telegram message id the server attached, so a later
    // edit updates the same group message.
    await syncData();
}

function editTx(id) {
    const baseId = getTxBaseId(id);
    const grouped = app.transactions
        .filter(t => t.id.startsWith(baseId + "_"))
        .sort((a, b) => {
            const aIndex = Number(String(a.id).split('_')[1]) || 0;
            const bIndex = Number(String(b.id).split('_')[1]) || 0;
            return aIndex - bIndex;
        });

    const tx = grouped[0];
    if(!tx) return;

    setType(tx.type);
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
    const label = app.ledgerActive ? "Bekor qilmoqchimisiz?" : "O'chirmoqchimisiz?";
    if(!confirm(label)) return;

    const baseId = getTxBaseId(id);

    if(app.ledgerActive) {
        const requestBase = `web_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        showLoader(true);
        try {
            const ids = entryGroupIds(baseId);
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
        }
        await syncData();
        return;
    }

    const grouped = app.transactions.filter(t => t.id.startsWith(baseId + "_"));
    const msgId = grouped.find(t => t.msgId)?.msgId || "";
    app.transactions = app.transactions.filter(t => !t.id.startsWith(baseId + "_"));
    await saveCloud(msgId ? { operation: 'transaction_delete', baseId, messageId: msgId } : null);
}
