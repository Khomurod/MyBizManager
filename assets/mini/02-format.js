'use strict';

// ==========================================================
// Formatting and shared UI pieces
// ----------------------------------------------------------
// Numbers are grouped with a narrow space, the way the rest of the app shows
// them, and every figure the backend sends is already rounded -- nothing is
// recalculated on the phone.
// ==========================================================

function uzs(value) {
    const number = Math.round(Number(value) || 0);
    return number.toLocaleString('ru-RU').replace(/ /g, ' ');
}

/** Signed money, with the sign carrying the colour rather than a label. */
function signedUzs(value) {
    const number = Math.round(Number(value) || 0);
    return (number > 0 ? '+' : number < 0 ? '−' : '') + uzs(Math.abs(number));
}

function moneyClass(value) {
    const number = Number(value) || 0;
    if (number > 0) return 'style="color:var(--success)"';
    if (number < 0) return 'style="color:var(--danger)"';
    return '';
}

function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "2026-08" -> "Avgust 2026". The backend sends the label; this is a fallback. */
const MONTH_NAMES = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
                     'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

function periodLabel(period) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!match) return String(period || "");
    return `${MONTH_NAMES[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

function currentPeriod() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftPeriod(period, months) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!match) return currentPeriod();
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + months, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** "2026-08-12" -> "12 Avg". Compact enough for a list row. */
function shortDate(value) {
    const text = String(value || "");
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) return `${Number(iso[3])} ${MONTH_NAMES[Number(iso[2]) - 1].slice(0, 3)}`;
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
    if (dmy) return `${Number(dmy[1])} ${MONTH_NAMES[Number(dmy[2]) - 1].slice(0, 3)}`;
    return text.slice(0, 10);
}

/**
 * The clock time out of a server-formatted due label.
 *
 * An occurrence carries `dueLabel`: "dd.MM.yyyy HH:mm" when the work is due at
 * a moment, "dd.MM.yyyy" when it belongs to a day, and empty when it has no
 * deadline at all. That label is the same field the /tasks board reads, so
 * there is one description of when something is due and both screens show the
 * same answer.
 *
 * This row prints its own compact date, so only the time half is taken. It
 * used to read `o.dueTime`, which no occurrence carries — only a routine's
 * definition does — so a deadline time never appeared on a phone at all.
 */
function dueClock(dueLabel) {
    const match = /(\d{2}:\d{2})$/.exec(String(dueLabel || ""));
    return match ? match[1] : "";
}

// ------------------------------------------------------------------ toasts

let toastTimer = null;

function toast(message, bad) {
    const host = document.getElementById('toastHost');
    host.innerHTML = `<div class="toast ${bad ? 'bad' : ''}" role="status">${escapeHtml(message)}</div>`;
    haptic(bad ? 'error' : 'success');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { host.innerHTML = ''; }, bad ? 4200 : 2400);
}

// ------------------------------------------------------------ bottom sheets

/**
 * Opens a bottom sheet.
 *
 * Telegram's own back button closes it, so the gesture people already use
 * inside Telegram does the expected thing rather than closing the whole app.
 */
function openSheet(title, bodyHtml, onMount) {
    const host = document.getElementById('sheetHost');
    host.innerHTML = `
        <div class="sheet-backdrop" onclick="if(event.target===this) closeSheet()">
          <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
            <div class="grabber"></div>
            <div class="between" style="margin-bottom:6px">
              <h1>${escapeHtml(title)}</h1>
              <button class="btn-sm" onclick="closeSheet()" aria-label="Yopish">✕</button>
            </div>
            ${bodyHtml}
          </div>
        </div>`;

    const app = telegramApp();
    if (app && app.BackButton) {
        try { app.BackButton.show(); app.onEvent('backButtonClicked', closeSheet); } catch (error) {}
    }
    if (typeof onMount === 'function') onMount();
}

function closeSheet() {
    document.getElementById('sheetHost').innerHTML = '';
    const app = telegramApp();
    if (app && app.BackButton) {
        try { app.BackButton.hide(); app.offEvent('backButtonClicked', closeSheet); } catch (error) {}
    }
}

/** Amount fields group as you type, the way they do in the web app. */
function attachAmountFormatting(input) {
    if (!input) return;
    input.addEventListener('input', () => {
        const digits = input.value.replace(/[^\d]/g, '');
        input.value = digits ? Number(digits).toLocaleString('ru-RU').replace(/ /g, ' ') : '';
    });
}

function readAmount(input) {
    return Number(String(input && input.value || '').replace(/[^\d]/g, '')) || 0;
}

function skeleton(count) {
    return `<div class="stack">${'<div class="skeleton"></div>'.repeat(count)}</div>`;
}

function emptyRow(text) {
    return `<p class="muted tiny" style="padding:14px 0;text-align:center">${escapeHtml(text)}</p>`;
}
