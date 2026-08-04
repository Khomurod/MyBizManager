'use strict';

// ==========================================================
// Formatting & shared UI helpers
// ----------------------------------------------------------
// Pure helpers: number parsing, money formatting and HTML escaping.
// ==========================================================

function parseRateNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatUZS(amount) {
    return Math.round(Number(amount) || 0).toLocaleString();
}

function escapeHTML(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizeTenantName(name) {
    return String(name || "").trim();
}

function getTxBaseId(txId = "") {
    return String(txId).split('_')[0];
}
