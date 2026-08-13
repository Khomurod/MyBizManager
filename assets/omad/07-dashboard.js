'use strict';

// ==========================================================
// Dashboard
// ----------------------------------------------------------
// Projection, balances, tenant status and the debt/tenant detail modals.
// ==========================================================

function renderProjection(period) {
    const card = document.getElementById('projectionCard');
    if(!card) return;

    if(period === ALL_PERIODS) {
        card.classList.add('hidden');
        return;
    }

    // Projections are a plan, not money that moved. They never mix with actuals.
    const projection = calculateProjection(app.tenants, getTemplateExpenses(), period);

    document.getElementById('projection-income').innerText = projection.expectedIncome.toLocaleString() + " UZS";
    document.getElementById('projection-expense').innerText = projection.plannedExpense.toLocaleString() + " UZS";
    document.getElementById('projection-net').innerText = projection.net.toLocaleString() + " UZS";
    card.classList.remove('hidden');
}

function renderDashboard() {
    const period = document.getElementById('dashMonthSelect').value;
    document.getElementById('statusMonthLabel').innerText = periodLabel(period);

    const monthRate = getRateForPeriod(period);
    document.getElementById('headerMonth').innerText = periodShortLabel(period);
    document.getElementById('headerRate').innerText = `Buy ${formatUZS(monthRate.buy)} | Sell ${formatUZS(monthRate.sell)}`;

    renderProjection(period);

    // Income/expense are scoped to the period; cash, bank and total are
    // all-time - money in the safe does not reset when you change the month.
    //
    // From the server's summary when there is one, from the loaded rows when
    // there is not. Switching months stays instant either way: the summary
    // carries every period, so no round trip is needed to change the selector.
    const actuals = periodActuals(period);
    document.getElementById('dash-income').innerText = actuals.income.toLocaleString();
    document.getElementById('dash-expense').innerText = actuals.expense.toLocaleString();
    document.getElementById('dash-cash-total').innerText = actuals.cash.toLocaleString();
    document.getElementById('dash-bank').innerText = actuals.bank.toLocaleString();

    // 3. SMART TENANT STATUS & TOTAL DEBT
    const list = document.getElementById('tenantStatusList');
    list.innerHTML = "";
    let totalPeriodDebt = 0;
    const isAllTime = period === ALL_PERIODS;

    // Only show Total Debt card if a specific month is selected
    if(isAllTime) {
        document.getElementById('totalDebtCard').classList.add('hidden');
    } else {
        document.getElementById('totalDebtCard').classList.remove('hidden');
    }

    app.tenants.forEach(tenant => {
        if(!isAllTime && isTenantDisabledForPeriod(tenant, period)) return;

        // Paid and expected both use the sell rate, so a tenant who paid
        // exactly their rent shows zero rather than the spread.
        const balance = tenantBalanceFor(tenant, period);
        const paidUZS = balance.paid;
        const rentUZS = isAllTime ? 0 : balance.expected;

        let status = "";
        let diff = isAllTime ? 0 : balance.difference;
        let barColor = "bg-red-500";
        let percent = isAllTime ? 100 : Math.min((paidUZS / rentUZS) * 100, 100);

        if(isAllTime) {
            status = `<span class="text-blue-600 font-bold">${Math.round(paidUZS).toLocaleString()} UZS</span>`;
            barColor = "bg-blue-500";
        } else if(rentUZS === 0) {
             status = `<span class="text-slate-400">Narx yo'q</span>`;
             percent = 0;
             barColor = "bg-slate-300";
        } else if(diff >= -1000 && diff <= 1000) {
            status = `<span class="text-green-600 font-bold"><i class="fas fa-check-circle"></i> To'landi</span>`;
            barColor = "bg-green-500";
        } else if(diff > 1000) {
            status = `<span class="text-blue-600 font-bold">+${Math.round(diff).toLocaleString()} ortiqcha</span>`;
            barColor = "bg-blue-500";
        } else {
            status = `<span class="text-red-500 font-bold">-${Math.round(Math.abs(diff)).toLocaleString()} qarz</span>`;
            totalPeriodDebt += Math.abs(diff); // Add to total debt
        }

        if(paidUZS === 0) percent = 0;

        // The rent that actually applies this month, so the badge and the modal
        // show the same figure the debt is calculated from.
        const rentForPeriod = isAllTime ? 0 : effectiveTenantRent(tenant, period);

        const div = document.createElement('div');
        div.className = "bg-white border border-slate-100 rounded-lg p-3 active:scale-95 transition-transform cursor-pointer";
        div.onclick = () => openTenantModal(tenant.name, period, rentForPeriod, tenant.currency, monthRate);

        div.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <div class="flex items-center gap-2">
                    <span class="font-bold text-sm text-slate-700">${tenant.name}</span>
                    <span class="text-[10px] bg-slate-100 px-1 rounded text-slate-500">${isAllTime ? 'Jami' : 'Ijara'}: ${isAllTime ? '-' : rentForPeriod + ' ' + tenant.currency}</span>
                </div>
                <div class="text-[10px]">${status}</div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-2 mb-1">
                <div class="${barColor} h-2 rounded-full" style="width: ${percent}%"></div>
            </div>
            <div class="text-right text-[10px] text-slate-400">
                To'landi: ${(Math.round(paidUZS)).toLocaleString()} UZS
            </div>
        `;
        list.appendChild(div);
    });

    if(!isAllTime) {
        document.getElementById('dash-total-debt').innerText = totalPeriodDebt.toLocaleString() + " UZS";
    }

    renderRecentActivity();
}

/**
 * The last few business actions, as they arrived with the dashboard.
 *
 * A *business action*, not a row: a tenant-paid pair is one line and a payment
 * made of several amounts is one line with a total, exactly as Tarix and the
 * Mini App show them, because they all read the same server-built list. It is
 * deliberately short and read-only — editing lives in Tarix, which loads the
 * rows it is going to change.
 */
function renderRecentActivity() {
    const card = document.getElementById('recentCard');
    const list = document.getElementById('recentList');
    if (!card || !list) return;

    const entries = Array.isArray(app.recent) ? app.recent : [];
    if (!entries.length) {
        card.classList.add('hidden');
        return;
    }
    card.classList.remove('hidden');

    list.innerHTML = entries.slice(0, 6).map(entry => {
        const income = entry.type !== 'Expense';
        const pair = entry.kind === 'tenant_paid_expense';
        return `
        <div class="bg-white p-3 rounded-lg border border-slate-100 shadow-sm flex justify-between items-center gap-2">
            <div class="flex items-center gap-3 min-w-0">
                <div class="w-1 h-8 rounded-full ${pair ? 'bg-amber-400' : (income ? 'bg-green-400' : 'bg-red-400')}"></div>
                <div class="min-w-0">
                    <p class="font-bold text-slate-700 text-sm truncate">${pair ? '🏢 ' : ''}${escapeHtmlText(entry.tenant)}</p>
                    <p class="text-[10px] text-slate-400 truncate">${escapeHtmlText(entry.date)} • ${escapeHtmlText(entry.periodLabel)}${entry.lines > 1 ? ' • ' + entry.lines + ' qator' : ''}</p>
                </div>
            </div>
            <div class="text-right shrink-0">
                <p class="font-bold text-slate-700 text-sm">${Math.round(Number(entry.amountUZS) || 0).toLocaleString()} UZS</p>
                <p class="text-[10px] text-slate-400">${pair ? "kassaga 0" : (income ? 'Kirim' : 'Chiqim')}</p>
            </div>
        </div>`;
    }).join('');
}

// --- DEBT LIST MODAL ---
function openDebtListModal() {
    const period = document.getElementById('dashMonthSelect').value;

    let debtors = [];
    let totalDebt = 0;

    app.tenants.forEach(tenant => {
        if(isTenantDisabledForPeriod(tenant, period)) return;

        const balance = tenantBalanceFor(tenant, period);
        if (balance.difference < -1000) {
            debtors.push({ name: tenant.name, debt: Math.abs(balance.difference), rent: balance.expected });
            totalDebt += Math.abs(balance.difference);
        }
    });

    debtors.sort((a, b) => b.debt - a.debt);

    // Configure Modal UI
    document.getElementById('modalTitle').innerText = "Qarzdorlar";
    document.getElementById('modalSubtitle').innerText = `${periodLabel(period)} holatiga`;

    // Show Simple Total Box, Hide Complex Box
    document.getElementById('modalSummaryBox').classList.add('hidden');
    document.getElementById('modalSimpleTotalBox').classList.remove('hidden');
    document.getElementById('modalTotal').innerText = `-${totalDebt.toLocaleString()} UZS`;
    document.getElementById('modalListTitle').innerText = "Qarzdorlar Ro'yxati";

    const list = document.getElementById('modalContent');
    list.innerHTML = "";

    if (debtors.length === 0) {
        list.innerHTML = `<p class="text-center text-slate-400 text-sm py-4">Qarzdorlik mavjud emas</p>`;
    } else {
        debtors.forEach(d => {
            const row = document.createElement('div');
            row.className = "flex justify-between items-center p-3 border-b border-slate-50 last:border-0 hover:bg-slate-50 rounded-lg";
            row.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="bg-red-50 w-8 h-8 rounded-full flex items-center justify-center text-red-500 font-bold text-xs">
                        ${d.name.charAt(0)}
                    </div>
                    <div>
                        <p class="text-sm font-bold text-slate-700">${d.name}</p>
                        <p class="text-[10px] text-slate-400">Ijara: ${Math.round(d.rent).toLocaleString()} UZS</p>
                    </div>
                </div>
                <div class="text-right">
                    <span class="font-bold text-red-500">-${Math.round(d.debt).toLocaleString()}</span>
                    <p class="text-[10px] text-slate-400">Qarz</p>
                </div>
            `;
            list.appendChild(row);
        });
    }
    document.getElementById('detailModal').classList.remove('hidden');
}

/**
 * The payment rows behind one tenant's figure.
 *
 * The dashboard no longer holds the ledger, so the rows for the tenant somebody
 * has just tapped are fetched for that tenant and that period alone — a few
 * rows instead of all of them. When the whole list *is* loaded (before cutover,
 * or once Tarix has been opened) it is filtered in place and nothing is
 * requested.
 */
async function tenantPaymentRows(tenantName, period) {
    const tenantKey = normalizeTenantName(tenantName);
    const isAllTime = period === ALL_PERIODS;
    const localMatches = countableTransactions().filter(t =>
        normalizeTenantName(t.tenant) === tenantKey &&
        (isAllTime || recordPeriod(t) === period) &&
        t.type === 'Income');

    if (app.historyMode !== 'paged') return localMatches;

    try {
        const body = await callBackend({
            action: 'list_transactions',
            tenant: tenantName,
            period: isAllTime ? '' : period,
            type: 'Income'
        });
        if (!isSuccessResponse(body)) return localMatches;
        return (body.transactions || []).filter(isCountableTransaction);
    } catch (error) {
        // A failed read never empties a screen: what is already in hand is
        // shown, and the figures above the list come from the summary anyway.
        console.error('tenant payments', error);
        return localMatches;
    }
}

// --- TENANT DETAIL MODAL ---
async function openTenantModal(tenantName, period, rentAmount, rentCurr, monthRate) {
    const isAllTime = period === ALL_PERIODS;
    const tenantKey = normalizeTenantName(tenantName);
    const selectedMonthRates = normalizeRateEntry(monthRate, DEFAULT_RATE);

    // The stored tenant, so the modal resolves the same schedule the dashboard
    // did. A synthetic {name, rent} carries no exceptions or rent changes, so
    // it could disagree with the card it was opened from.
    const storedTenant = (app.tenants || []).find(t => normalizeTenantName(t.name) === tenantKey);
    const balance = tenantBalanceFor(
        storedTenant || { name: tenantName, rent: rentAmount, currency: rentCurr }, period);
    const totalPaidUZS = tenantPaidFor(tenantName, isAllTime ? ALL_PERIODS : period);
    const expectedRentUZS = isAllTime ? 0 : balance.expected;

    // Configure Modal UI
    document.getElementById('modalTitle').innerText = tenantName;
    document.getElementById('modalSubtitle').innerText = `${periodLabel(period)} hisoboti`;

    // Show Complex Box, Hide Simple Box
    document.getElementById('modalSummaryBox').classList.remove('hidden');
    document.getElementById('modalSimpleTotalBox').classList.add('hidden');
    document.getElementById('modalListTitle').innerText = "To'lovlar Tarixi";

    if(isAllTime) {
        document.getElementById('modalRent').innerText = "Hisoblanmaydi (Jami Davr)";
        document.getElementById('modalDiff').innerText = "-";
    } else {
        let rateInfo = "";
        if(rentCurr === 'USD') {
            rateInfo = `<div class="text-[10px] text-slate-400 font-normal">Buy: 1 USD - ${selectedMonthRates.buy.toLocaleString()} UZS</div><div class="text-[10px] text-slate-400 font-normal">Sell: 1 USD - ${selectedMonthRates.sell.toLocaleString()} UZS</div>`;
        }
        document.getElementById('modalRent').innerHTML = `<div class="font-bold text-slate-700">${rentAmount} ${rentCurr}</div>${rateInfo}<div class="text-xs font-normal text-slate-500">~${Math.round(expectedRentUZS).toLocaleString()} UZS</div>`;

        const diff = totalPaidUZS - expectedRentUZS;
        const diffEl = document.getElementById('modalDiff');
        if(diff < -1000) {
            diffEl.innerText = `${Math.round(diff).toLocaleString()} UZS (QARZ)`;
            diffEl.className = "font-bold text-red-500";
        } else if (diff > 1000) {
            diffEl.innerText = `+${Math.round(diff).toLocaleString()} UZS (ORTIQCHA)`;
            diffEl.className = "font-bold text-blue-500";
        } else {
            diffEl.innerText = "0 UZS (TO'LANDI)";
            diffEl.className = "font-bold text-green-500";
        }
    }

    document.getElementById('modalPaid').innerText = `${Math.round(totalPaidUZS).toLocaleString()} UZS`;

    const list = document.getElementById('modalContent');
    list.innerHTML = `<p class="text-center text-slate-400 text-sm py-4">Yuklanmoqda...</p>`;
    document.getElementById('detailModal').classList.remove('hidden');

    const txs = await tenantPaymentRows(tenantName, period);
    list.innerHTML = "";

    if(txs.length === 0) {
        list.innerHTML = `<p class="text-center text-slate-400 text-sm py-4">To'lovlar mavjud emas</p>`;
    } else {
        txs.forEach(t => {
            let detailText = "";
            if (t.currency === 'USD') {
                // The rate stored on the transaction, not today's rate.
                const inUZS = transactionUZS(t);
                const usedRate = Number(t.rateUsed) || getPeriodRateByType(recordPeriod(t), RATE_TYPE_ACTUAL);
                detailText = `<div class="text-[10px] text-slate-400 text-right mt-0.5">Kurs: 1 USD - ${usedRate.toLocaleString()} UZS<br>= ${Math.round(inUZS).toLocaleString()} UZS</div>`;
            }

            const row = document.createElement('div');
            row.className = "flex justify-between items-center p-2 border-b border-slate-50 last:border-0";
            row.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="bg-blue-50 w-8 h-8 rounded-full flex items-center justify-center text-blue-500"><i class="fas ${t.method === 'Naqd' ? 'fa-wallet' : 'fa-university'}"></i></div>
                    <div>
                        <p class="text-xs text-slate-400 font-bold">${t.date}</p>
                        <p class="text-xs text-slate-500">${t.method}</p>
                    </div>
                </div>
                <div class="text-right">
                    <span class="font-bold text-slate-700">${t.amount.toLocaleString()} ${t.currency}</span>
                    ${detailText}
                </div>
            `;
            list.appendChild(row);
        });
    }
}

function closeModal() {
    document.getElementById('detailModal').classList.add('hidden');
}
