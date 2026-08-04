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
    templateExpenses: [],
    // Filled in from get_migration_status; decides whether entry uses the
    // append-only ledger operations or the legacy whole-list save.
    migration: null,
    ledgerActive: false
};

let cart = [];

let currentType = 'Income';

let editingTenantIndex = null; 

let expenseModalOpen = false;
