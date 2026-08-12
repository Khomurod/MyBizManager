'use strict';

// ==========================================================
// ☕ Kafe
// ----------------------------------------------------------
// Monitoring, deliberately. Selling, voiding and closing the day happen at the
// counter on the POS, where the stock is; putting a till on a phone would be a
// second way to move inventory and a second place for it to go wrong.
// ==========================================================

function renderCafe() {
    const host = document.getElementById('tab-cafe');
    if (!state.cafe) { host.innerHTML = skeleton(4); return; }

    const c = state.cafe;
    host.innerHTML = `
        <div class="between" style="margin-bottom:12px">
            <h1>Kafe</h1>
            <button class="btn-sm" onclick="loadCafe()" aria-label="Yangilash">↻</button>
        </div>

        <div class="card hero">
            <p class="tiny muted">Bugungi tushum</p>
            <p class="value">${uzs(c.today.revenue)} <span class="tiny muted">UZS</span></p>
            <div class="grid2" style="margin-top:12px">
                <div><p class="tiny muted">Foyda</p><p class="num" style="color:var(--success)">${uzs(c.today.profit)}</p></div>
                <div><p class="tiny muted">Cheklar</p><p class="num">${c.today.sales}</p></div>
            </div>
            ${targetBar(c.target)}
        </div>

        <div class="grid2" style="margin-top:10px">
            <div class="card tile">
                <p class="label">Oylik tushum</p>
                <p class="value">${uzs(c.month.revenue)}</p>
            </div>
            <div class="card tile">
                <p class="label">Oylik foyda</p>
                <p class="value" style="color:var(--success)">${uzs(c.month.profit)}</p>
            </div>
        </div>

        <div class="card" style="margin-top:10px">
            <div class="between">
                <div>
                    <p class="tiny muted">Ombor qiymati</p>
                    <p class="num" style="font-size:20px">${uzs(c.inventory.value)}</p>
                </div>
                <span class="pill info">${c.inventory.items} pozitsiya</span>
            </div>
            ${lowStock(c.inventory.lowStock)}
        </div>

        <h2>Oxirgi cheklar</h2>
        <div class="card list">${saleRows(c.recentSales)}</div>

        <h2>Kun yakunlari</h2>
        <div class="card list">${closingRows(c.recentClosings)}</div>
    `;
}

function targetBar(target) {
    if (!target || !target.daily) return '';
    return `
        <p class="tiny muted" style="margin-top:14px">
            Kunlik reja ${uzs(target.daily)} · <b>${target.progress}%</b>
        </p>
        <div class="bar"><span style="width:${Math.max(2, target.progress)}%"></span></div>`;
}

function lowStock(items) {
    if (!items || !items.length) return '';
    return `
        <p class="tiny muted" style="margin-top:12px">Tugayotgan mahsulotlar</p>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
            ${items.map(i => `<span class="pill warn">${escapeHtml(i.name)} · ${i.qty}${escapeHtml(i.unit || '')}</span>`).join('')}
        </div>`;
}

function saleRows(sales) {
    if (!sales || !sales.length) return emptyRow("Chek yo'q");
    return sales.map(s => `
        <div class="item">
            <div class="grow">
                <p class="title">${uzs(s.total)} <span class="tiny muted">UZS</span></p>
                <p class="tiny muted ellipsis">${shortDate(s.date)} · ${escapeHtml(s.seller)} · ${s.items} pozitsiya</p>
            </div>
            <p class="num tiny" style="color:var(--success)">+${uzs(s.profit)}</p>
        </div>`).join('');
}

function closingRows(closings) {
    if (!closings || !closings.length) return emptyRow("Kun yakuni yo'q");
    return closings.map(c => `
        <div class="item">
            <div class="grow">
                <p class="title">${shortDate(c.date)}</p>
                <p class="tiny muted ellipsis">${escapeHtml(c.seller)}</p>
            </div>
            <div style="text-align:right">
                <p class="num">${uzs(c.revenue)}</p>
                <p class="tiny" style="color:var(--success)">+${uzs(c.profit)}</p>
            </div>
        </div>`).join('');
}

async function loadCafe() {
    try {
        const body = await api('mini_cafe');
        state.cafe = body.cafe;
        renderCafe();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        toast(error.message, true);
    }
}
