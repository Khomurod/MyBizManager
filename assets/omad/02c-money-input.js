'use strict';

// ==========================================================
// Monetary input formatting
// ----------------------------------------------------------
// Typing 12500000 should read as 12 500 000 while you type, and store as
// 12500000. Grouping is done with a plain space, which is how amounts are
// written locally.
//
// The fields stay `type="text"` with `inputmode="decimal"`: a number input
// would reject the spaces, and `inputmode` is what actually brings up the
// numeric keyboard on a phone.
// ==========================================================

const MONEY_GROUP_SEPARATOR = ' ';
const MONEY_DECIMAL_SEPARATOR = '.';

/**
 * Turns anything a user can type or paste into a canonical number string.
 *
 * A comma is ambiguous: it groups thousands in "12,500,000" and separates
 * decimals in "1234,56". The rule used here is the one that reads correctly in
 * both conventions: **the last separator is the decimal point only when it is
 * followed by one or two digits** (or nothing at all, which is a decimal being
 * typed). Every other separator groups.
 *
 *   "USD 1,250.50" -> "1250.50"
 *   "1234,56"      -> "1234.56"
 *   "12,500,000"   -> "12500000"
 *   "1 500."       -> "1500."
 */
function cleanMoneyString(value) {
    const text = String(value === null || value === undefined ? '' : value);

    let lastSeparator = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '.' || text[i] === ',') lastSeparator = i;
    }

    let decimalAt = -1;
    if (lastSeparator !== -1) {
        const tail = text.slice(lastSeparator + 1).replace(/\D/g, '');
        if (tail.length <= 2) decimalAt = lastSeparator;
    }

    let whole = '';
    let decimals = null;
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (i === decimalAt) { decimals = ''; continue; }
        if (character < '0' || character > '9') continue;
        if (decimals === null) whole += character; else decimals += character;
    }

    if (decimals === null) return whole;
    return whole + MONEY_DECIMAL_SEPARATOR + decimals;
}

/** "12500000" -> "12 500 000". Decimals are left ungrouped. */
function formatMoneyString(value) {
    const cleaned = cleanMoneyString(value);
    if (!cleaned) return '';

    const [whole, decimals] = cleaned.split(MONEY_DECIMAL_SEPARATOR);
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, MONEY_GROUP_SEPARATOR);

    if (decimals === undefined) return grouped;
    return `${grouped}${MONEY_DECIMAL_SEPARATOR}${decimals}`;
}

/** The numeric value of a formatted field. NaN when there is no number. */
function parseMoneyInput(value) {
    const cleaned = cleanMoneyString(value);
    if (!cleaned || cleaned === MONEY_DECIMAL_SEPARATOR) return NaN;
    return Number(cleaned);
}

/** A number as a formatted string, for prefilling a field. */
function formatMoneyValue(value) {
    // An absent value leaves the field empty; a real zero shows as "0".
    if (value === null || value === undefined || value === '') return '';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return formatMoneyString(String(numeric));
}

/** Digits (and the decimal point) before a cursor position. */
function countSignificantBefore(text, position) {
    let count = 0;
    for (let i = 0; i < position && i < text.length; i++) {
        const character = text[i];
        if ((character >= '0' && character <= '9') || character === '.' || character === ',') count++;
    }
    return count;
}

/** The cursor offset that sits after `count` digits of the formatted text. */
function positionAfterSignificant(text, count) {
    if (count <= 0) return 0;
    let seen = 0;
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if ((character >= '0' && character <= '9') || character === '.') seen++;
        if (seen >= count) return i + 1;
    }
    return text.length;
}

/**
 * Reformats a field in place, keeping the caret where the user left it
 * relative to the digits rather than to the raw offset - otherwise inserting a
 * separator would push the caret one character to the left on every third
 * digit.
 */
function reformatMoneyField(input) {
    if (!input) return;

    const before = input.value;
    const selectionStart = input.selectionStart === null ? before.length : input.selectionStart;
    const significant = countSignificantBefore(before, selectionStart);

    const formatted = formatMoneyString(before);
    if (formatted === before) return;

    input.value = formatted;
    if (typeof input.setSelectionRange === 'function') {
        const position = positionAfterSignificant(formatted, significant);
        try {
            input.setSelectionRange(position, position);
        } catch (error) {
            // Some field types refuse selection APIs; the value is still right.
        }
    }
}

/**
 * Every field that holds an amount. Kept as one list so a new money field is
 * formatted by adding its id here rather than by remembering to wire it up.
 */
const MONEY_FIELD_IDS = [
    'tempAmount',
    'settingRateBuyInput',
    'settingRateSellInput',
    'newTenantRent',
    'templateExpenseAmount',
    'rentChangeAmount'
];

function attachMoneyFormatting() {
    MONEY_FIELD_IDS.forEach(id => {
        const input = document.getElementById(id);
        if (!input || input.dataset.moneyFormatted === 'true') return;

        input.dataset.moneyFormatted = 'true';
        input.addEventListener('input', () => reformatMoneyField(input));
        // Paste fires before the value settles, so reformat on the next tick.
        input.addEventListener('paste', () => setTimeout(() => reformatMoneyField(input), 0));
        input.addEventListener('blur', () => reformatMoneyField(input));
    });
}
