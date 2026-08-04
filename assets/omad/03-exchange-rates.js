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

    Object.entries(ratesMap).forEach(([month, rateValue]) => {
        normalized[month] = normalizeRateEntry(rateValue, DEFAULT_RATE);
    });
    return normalized;
}

function getRateForMonth(month) {
    return normalizeRateEntry(app.rates[month], DEFAULT_RATE);
}

function getMonthRateByType(month, rateType = 'sell') {
    const rates = getRateForMonth(month);
    return rateType === 'buy' ? rates.buy : rates.sell;
}

function toUZS(amount, currency, month, rateType = 'sell') {
    const numericAmount = Number(amount) || 0;
    return currency === 'USD' ? (numericAmount * getMonthRateByType(month, rateType)) : numericAmount;
}

// --- SETTINGS LOGIC ---
function populateRateInputs() {
    const month = document.getElementById('settingMonth').value;
    const monthRates = getRateForMonth(month);
    document.getElementById('settingRateBuyInput').value = monthRates.buy;
    document.getElementById('settingRateSellInput').value = monthRates.sell;
}

function saveRate() {
    const m = document.getElementById('settingMonth').value;
    const buyInput = parseRateNumber(document.getElementById('settingRateBuyInput').value);
    const sellInput = parseRateNumber(document.getElementById('settingRateSellInput').value);
    const current = getRateForMonth(m);

    const nextBuy = buyInput || current.buy;
    const nextSell = sellInput || current.sell;

    if(nextBuy && nextSell) {
        app.rates[m] = { buy: nextBuy, sell: nextSell };
        saveCloud();
        renderSettings();
    }
}
