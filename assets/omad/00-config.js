'use strict';

// ==========================================================
// Configuration & access guard
// ----------------------------------------------------------
// Telegram credentials are NOT stored in the browser. The bot token, admin key
// and webhook secret live in Apps Script Script Properties; every Telegram call
// goes through the Apps Script backend as a business operation.
// ==========================================================

const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbzhKyEOGZbVdtpSd7fa6aTDZf1QsqWQeOpWRxrb7bYpzWWDQxUXZID8JNzGMfDtCA2W/exec";
const ADMIN_TOKEN = "omad_admin_active";

if (localStorage.getItem("omad_role") !== "omad_admin" ||
    localStorage.getItem("omad_token") !== ADMIN_TOKEN) {
    window.location.href = "login.html";
}
