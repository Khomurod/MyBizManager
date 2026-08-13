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
    // The *loaded page(s)* of history, not the ledger. Empty on load: the
    // dashboard is answered from `summary`, and Tarix fetches pages of business
    // actions when it is opened. Before the ledger cutover the server still
    // sends the whole list here, because the legacy save submits it back.
    transactions: [],
    templateExpenses: [],
    // The server's materialised figures: all-time balances plus income,
    // expense and per-tenant paid totals for every period that has data. Null
    // when the answer did not carry one, in which case every figure is derived
    // from `transactions` exactly as it used to be.
    summary: null,
    // The newest few business actions, for the dashboard's activity list.
    recent: [],
    // 'paged' when history is fetched on demand, 'full' when the whole list
    // arrived with the dashboard.
    historyMode: 'full',
    historyLoaded: false,
    historyLoading: false,
    historyOffset: 0,
    historyTotal: 0,
    historyHasMore: false,
    historyError: '',
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
