'use strict';

// ==========================================================
// Shared state
// ----------------------------------------------------------
// One mutable app object plus the entry-form scratch state. Every module
// reads and writes these; nothing else is global.
// ==========================================================

const months = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];

const monthShortLabels = ["Yan", "Fev", "Mar", "Apr", "May", "Iyn", "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"];

const DEFAULT_RATE = 12500;

// --- DATA STORE ---
let app = {
    rates: { "Fevral": { buy: 12500, sell: 12500 } },
    tenants: [], 
    transactions: [],
    templateExpenses: []
};

let cart = [];

let currentType = 'Income';

let editingTenantIndex = null; 

let expenseModalOpen = false;
