'use strict';

// ==========================================================
// Exchange rates
// ----------------------------------------------------------
// Rate normalisation and USD -> UZS conversion, plus the rate editor.
// ==========================================================

function normalizeRateEntry(rawRate, fallbackRate = DEFAULT_RATE) {
    const fallback = parseRateNumber(fallbackRate) || DEFAULT_RATE;

    if(typeof rawRate === 'number') {
        const legacy = parseRateNumber(rawRate) || fallback;
        return { buy: legacy, sell: legacy };
    }

    if(rawRate && typeof rawRate === 'object') {
        const buyParsed = parseRateNumber(rawRate.buy);
        const sellParsed = parseRateNumber(rawRate.sell);
        const legacyParsed = parseRateNumber(rawRate.rate);

        const base = legacyParsed || fallback;
        const buy = buyParsed || sellParsed || base;
        const sell = sellParsed || buyParsed || base;
        return { buy, sell };
    }

    return { buy: fallback, sell: fallback };
}

function normalizeRatesMap(ratesMap) {
    const normalized = {};
    if(!ratesMap || typeof ratesMap !== 'object') return normalized;

    Object.entries(ratesMap).forEach(([key, rateValue]) => {
        normalized[key] = normalizeRateEntry(rateValue, DEFAULT_RATE);
    });
    return normalized;
}

/**
 * Looks a rate up by canonical period, falling back to the legacy month-name
 * key for the same month so the app keeps working before the migration runs.
 * Returns null when the period has no rate at all.
 */
function findRateEntry(period) {
    const rates = app.rates || {};
    if(Object.prototype.hasOwnProperty.call(rates, period)) {
        return normalizeRateEntry(rates[period], DEFAULT_RATE);
    }
    if(isPeriod(period)) {
        const legacyKey = MONTH_LABELS[periodMonth(period) - 1];
        if(Object.prototype.hasOwnProperty.call(rates, legacyKey)) {
            return normalizeRateEntry(rates[legacyKey], DEFAULT_RATE);
        }
    }
    return null;
}

function getRateForPeriod(period) {
    return findRateEntry(period) || { buy: DEFAULT_RATE, sell: DEFAULT_RATE };
}

function hasRateForPeriod(period) {
    return findRateEntry(period) !== null;
}

function getPeriodRateByType(period, rateType = 'sell') {
    const rates = getRateForPeriod(period);
    return rateType === 'buy' ? rates.buy : rates.sell;
}

function toUZS(amount, currency, period, rateType = 'sell') {
    const numericAmount = Number(amount) || 0;
    return currency === 'USD' ? (numericAmount * getPeriodRateByType(period, rateType)) : numericAmount;
}

// --- RATE EDITOR ---

/** The period the rate editor is currently pointed at. */
function selectedRatePeriod() {
    const year = document.getElementById('settingRateYear');
    const month = document.getElementById('settingMonth');
    if(!year || !month) return currentPeriod();
    return buildPeriod(year.value, month.value) || currentPeriod();
}

function initRateSelectors() {
    const yearSelect = document.getElementById('settingRateYear');
    const monthSelect = document.getElementById('settingMonth');
    if(!yearSelect || !monthSelect) return;

    const active = isPeriod(selectedRatePeriod()) ? selectedRatePeriod() : currentPeriod();

    yearSelect.innerHTML = availableYears()
        .map(year => `<option value="${year}"${year === periodYear(active) ? ' selected' : ''}>${year}</option>`)
        .join('');
    monthSelect.innerHTML = MONTH_LABELS
        .map((label, index) => `<option value="${index + 1}"${index + 1 === periodMonth(active) ? ' selected' : ''}>${label}</option>`)
        .join('');

    populateRateInputs();
}

/** Year or month changed: refresh both the inputs and the yearly overview. */
function onRateSelectorChange() {
    populateRateInputs();
    renderRatesOverview();
}

function populateRateInputs() {
    const buyInput = document.getElementById('settingRateBuyInput');
    const sellInput = document.getElementById('settingRateSellInput');
    if(!buyInput || !sellInput) return;

    const period = selectedRatePeriod();
    const rates = getRateForPeriod(period);
    buyInput.value = formatMoneyValue(rates.buy);
    sellInput.value = formatMoneyValue(rates.sell);

    const hint = document.getElementById('settingRateHint');
    if(hint) {
        hint.textContent = hasRateForPeriod(period)
            ? `${periodLabel(period)} kursi saqlangan.`
            : `${periodLabel(period)} uchun kurs hali belgilanmagan (standart ${DEFAULT_RATE.toLocaleString()}).`;
    }
}

function saveRate() {
    const period = selectedRatePeriod();
    const buyInput = parseRateNumber(parseMoneyInput(document.getElementById('settingRateBuyInput').value));
    const sellInput = parseRateNumber(parseMoneyInput(document.getElementById('settingRateSellInput').value));
    const current = getRateForPeriod(period);

    const nextBuy = buyInput || current.buy;
    const nextSell = sellInput || current.sell;
    if(!nextBuy || !nextSell) return;

    // Changing a rate is a real accounting decision: it moves the reported UZS
    // value of every USD transaction in that period.
    if(hasRateForPeriod(period)) {
        const confirmed = confirm(
            `${periodLabel(period)} kursini o'zgartirasizmi?\n` +
            `Buy ${current.buy.toLocaleString()} -> ${nextBuy.toLocaleString()}\n` +
            `Sell ${current.sell.toLocaleString()} -> ${nextSell.toLocaleString()}`);
        if(!confirmed) return;
    }

    app.rates[period] = { buy: nextBuy, sell: nextSell };
    saveCloudInBackground();
    renderSettings();
}
