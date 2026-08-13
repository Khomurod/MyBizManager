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
    // Filled in from get_omad_data (or get_migration_status against an older
    // backend); decides whether entry uses the append-only ledger operations
    // or the legacy whole-list save.
    migration: null,
    ledgerActive: false,
    // When the figures on screen came from the stored snapshot rather than
    // from the server, and why the refresh that should have replaced them did
    // not. Both are display state: they change what the banner says and
    // nothing else.
    snapshotAt: 0,
    loadError: ''
};

let cart = [];

let currentType = 'Income';

let editingTenantIndex = null; 

let expenseModalOpen = false;
