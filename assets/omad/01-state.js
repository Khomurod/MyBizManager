'use strict';

// ==========================================================
// Shared state
// ----------------------------------------------------------
// One mutable app object plus the entry-form scratch state. Every module
// reads and writes these; nothing else is global.
// ==========================================================

// Month names live in 01b-periods.js (MONTH_LABELS); periods are the unit of
// time everywhere else.
const DEFAULT_RATE = 12500;

// --- DATA STORE ---
let app = {
    // Keyed by canonical period. Legacy month-name keys are still read.
    rates: {},
    tenants: [], 
    transactions: [],
    templateExpenses: []
};

let cart = [];

let currentType = 'Income';

let editingTenantIndex = null; 

let expenseModalOpen = false;
