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
    const amt = document.getElementById('tempAmount').value;
    if(!amt) return;
    cart.push({ amount: parseFloat(amt), currency: document.getElementById('tempCurr').value, method: document.getElementById('tempMethod').value });
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
async function submitAll() {
    if(cart.length === 0) return alert("Summani kiriting");
    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.innerText = "Bajarilmoqda...";

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

    cart = [];
    document.getElementById('entryComment').value = "";
    document.getElementById('editId').value = "";
    document.getElementById('msgId').value = "";
    document.getElementById('cancelEditBtn').classList.add('hidden');
    renderCart();
    btn.disabled = false; btn.innerText = currentType === 'Income' ? "KIRIMNI SAQLASH" : "CHIQIMNI SAQLASH";
    switchTab('dash');
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
    document.getElementById('entryMonth').value = tx.month;
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

async function deleteTx(id) {
    if(confirm("O'chirmoqchimisiz?")) { 
        const baseId = getTxBaseId(id);
        const grouped = app.transactions.filter(t => t.id.startsWith(baseId + "_"));
        const msgId = grouped.find(t => t.msgId)?.msgId || "";
        app.transactions = app.transactions.filter(t => !t.id.startsWith(baseId + "_"));
        await saveCloud(msgId ? { operation: 'transaction_delete', baseId, messageId: msgId } : null);
    }
}
